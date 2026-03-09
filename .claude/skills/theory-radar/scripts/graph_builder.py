#!/usr/bin/env python3
"""
Theory Radar knowledge graph builder.

Builds an incremental paper graph with three relation types:
- concept_overlap (embedding cosine similarity)
- citation (explicit reference)
- coauthor (shared author)
"""

from __future__ import annotations

import json
import math
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

import networkx as nx

DEFAULT_GRAPH_PATH = Path("tasks/theory-radar/graph.json")
DEFAULT_SIMILARITY_THRESHOLD = 0.75
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"


class TheoryGraphBuilder:
    """Incremental graph builder for theory-radar papers."""

    def __init__(
        self,
        graph_path: str | Path = DEFAULT_GRAPH_PATH,
        similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        embedding_provider: Optional[Callable[[str], Optional[List[float]]]] = None,
    ) -> None:
        self.graph_path = Path(graph_path)
        self.similarity_threshold = similarity_threshold
        self.embedding_model = embedding_model
        self.graph = nx.Graph()
        self._embedding_provider = embedding_provider
        self._openai_client = None

    def add_paper(self, paper: Dict[str, Any]) -> Dict[str, Any]:
        """
        Add or update one paper node and auto-link to existing nodes.

        Expected paper fields:
        - arxiv_id (required)
        - title, abstract, authors, categories, published, url
        - references / citations (optional arxiv_id list)
        - embedding (optional vector for deterministic tests or precomputed value)
        - ingested_on (optional YYYY-MM-DD, defaults to today)
        """
        normalized = self._normalize_paper(paper)
        paper_id = normalized["arxiv_id"]
        existing_nodes = [node for node in self.graph.nodes if node != paper_id]

        self.graph.add_node(paper_id, **normalized)
        new_embedding = self._get_or_build_embedding(paper_id)

        edges_added = 0
        for other_id in existing_nodes:
            edge_existed = self.graph.has_edge(paper_id, other_id)
            other_data = self.graph.nodes[other_id]

            self._maybe_link_by_citation(paper_id, normalized, other_id, other_data)
            self._maybe_link_by_coauthor(paper_id, normalized, other_id, other_data)

            other_embedding = self._get_or_build_embedding(other_id)
            self._maybe_link_by_similarity(
                paper_id, new_embedding, other_id, other_embedding
            )

            if not edge_existed and self.graph.has_edge(paper_id, other_id):
                edges_added += 1

        return {"paper_id": paper_id, "edges_added": edges_added}

    def get_hot_clusters(self, top_n: int = 5) -> List[Dict[str, Any]]:
        """
        Return today's emerging topic clusters.

        Format:
        [{"topic": str, "papers": [arxiv_id...], "growth_rate": float}, ...]
        """
        if top_n <= 0 or self.graph.number_of_nodes() == 0:
            return []

        today = self._today()
        clusters: List[Dict[str, Any]] = []

        for component in nx.connected_components(self.graph):
            comp_nodes = list(component)
            new_nodes = [
                node
                for node in comp_nodes
                if self.graph.nodes[node].get("ingested_on") == today
            ]
            if not new_nodes:
                continue

            old_count = len(comp_nodes) - len(new_nodes)
            growth_rate = float(len(new_nodes)) if old_count == 0 else len(new_nodes) / old_count

            clusters.append(
                {
                    "topic": self._infer_topic(comp_nodes),
                    "papers": sorted(new_nodes),
                    "growth_rate": round(growth_rate, 4),
                }
            )

        clusters.sort(
            key=lambda item: (len(item["papers"]), item["growth_rate"]),
            reverse=True,
        )
        return clusters[:top_n]

    def get_key_authors(self, top_n: int = 3) -> List[Dict[str, Any]]:
        """
        Return authors connected to the most newly added papers.

        Output format:
        [{"author": str, "papers": int, "connections": int}, ...]
        """
        if top_n <= 0 or self.graph.number_of_nodes() == 0:
            return []

        today = self._today()
        author_stats: Dict[str, Dict[str, Any]] = {}

        for node_id, attrs in self.graph.nodes(data=True):
            if attrs.get("ingested_on") != today:
                continue

            degree = int(self.graph.degree(node_id))
            for author in attrs.get("authors", []):
                item = author_stats.setdefault(
                    author,
                    {"author": author, "papers": 0, "connections": 0},
                )
                item["papers"] += 1
                item["connections"] += degree

        ranked = sorted(
            author_stats.values(),
            key=lambda item: (item["papers"], item["connections"], item["author"]),
            reverse=True,
        )
        return ranked[:top_n]

    def save(self) -> Path:
        """Persist graph as JSON."""
        self.graph_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "saved_at": self._now_iso(),
            "graph": nx.node_link_data(self.graph),
        }
        self.graph_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return self.graph_path

    def load(self) -> "TheoryGraphBuilder":
        """Load graph from JSON if file exists."""
        if not self.graph_path.exists():
            self.graph = nx.Graph()
            return self

        payload = json.loads(self.graph_path.read_text(encoding="utf-8"))
        graph_blob = payload.get("graph", payload)
        self.graph = nx.node_link_graph(graph_blob)
        self._normalize_loaded_values()
        return self

    def _normalize_paper(self, paper: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(paper, dict):
            raise TypeError("paper must be a dict")

        arxiv_id = str(paper.get("arxiv_id") or paper.get("id") or "").strip()
        if not arxiv_id:
            raise ValueError("paper.arxiv_id is required")

        authors = self._normalize_str_list(paper.get("authors", []))
        references = self._normalize_str_list(
            paper.get("references", paper.get("citations", []))
        )
        categories = self._normalize_str_list(paper.get("categories", []))
        embedding = self._normalize_embedding(paper.get("embedding"))
        ingested_on = self._normalize_date(paper.get("ingested_on"))

        return {
            "arxiv_id": arxiv_id,
            "title": str(paper.get("title", "")).strip(),
            "abstract": str(paper.get("abstract", "")).strip(),
            "authors": authors,
            "references": references,
            "categories": categories,
            "published": str(paper.get("published", "")).strip(),
            "url": str(paper.get("url", "")).strip(),
            "embedding": embedding,
            "ingested_on": ingested_on,
            "updated_at": self._now_iso(),
        }

    def _maybe_link_by_similarity(
        self,
        source_id: str,
        source_embedding: Optional[List[float]],
        target_id: str,
        target_embedding: Optional[List[float]],
    ) -> None:
        if not source_embedding or not target_embedding:
            return

        similarity = self._cosine_similarity(source_embedding, target_embedding)
        if similarity is None or similarity <= self.similarity_threshold:
            return

        self._upsert_edge(
            source_id,
            target_id,
            relation_type="concept_overlap",
            weight=similarity,
            similarity=similarity,
        )

    def _maybe_link_by_citation(
        self,
        source_id: str,
        source_data: Dict[str, Any],
        target_id: str,
        target_data: Dict[str, Any],
    ) -> None:
        source_refs = set(source_data.get("references", []))
        target_refs = set(target_data.get("references", []))
        cites = target_id in source_refs or source_id in target_refs
        if not cites:
            return

        self._upsert_edge(
            source_id,
            target_id,
            relation_type="citation",
            weight=1.0,
        )

    def _maybe_link_by_coauthor(
        self,
        source_id: str,
        source_data: Dict[str, Any],
        target_id: str,
        target_data: Dict[str, Any],
    ) -> None:
        source_authors = set(source_data.get("authors", []))
        target_authors = set(target_data.get("authors", []))
        shared_authors = sorted(source_authors & target_authors)
        if not shared_authors:
            return

        normalizer = max(len(source_authors), len(target_authors), 1)
        strength = len(shared_authors) / normalizer
        self._upsert_edge(
            source_id,
            target_id,
            relation_type="coauthor",
            weight=strength,
            shared_authors=shared_authors,
        )

    def _upsert_edge(
        self,
        source_id: str,
        target_id: str,
        relation_type: str,
        weight: Optional[float] = None,
        similarity: Optional[float] = None,
        shared_authors: Optional[List[str]] = None,
    ) -> None:
        edge_data: Dict[str, Any]
        if self.graph.has_edge(source_id, target_id):
            edge_data = dict(self.graph.edges[source_id, target_id])
        else:
            edge_data = {}

        relation_types = set(edge_data.get("relation_types", []))
        relation_types.add(relation_type)

        edge_data["relation_types"] = sorted(relation_types)
        if weight is not None:
            edge_data["weight"] = max(float(weight), float(edge_data.get("weight", 0.0)))
        if similarity is not None:
            edge_data["similarity"] = float(similarity)
        if shared_authors:
            previous = set(edge_data.get("shared_authors", []))
            edge_data["shared_authors"] = sorted(previous | set(shared_authors))
        edge_data["updated_at"] = self._now_iso()

        self.graph.add_edge(source_id, target_id, **edge_data)

    def _get_or_build_embedding(self, node_id: str) -> Optional[List[float]]:
        data = self.graph.nodes[node_id]
        embedding = self._normalize_embedding(data.get("embedding"))
        if embedding:
            data["embedding"] = embedding
            return embedding

        abstract = str(data.get("abstract", "")).strip()
        if not abstract:
            return None

        provider = self._embedding_provider or self._openai_embedding
        embedding = provider(abstract) if provider else None
        embedding = self._normalize_embedding(embedding)
        if embedding:
            data["embedding"] = embedding
        return embedding

    def _openai_embedding(self, text: str) -> Optional[List[float]]:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            return None

        try:
            from openai import OpenAI
        except ImportError:
            return None

        if self._openai_client is None:
            self._openai_client = OpenAI(api_key=api_key)

        response = self._openai_client.embeddings.create(
            model=self.embedding_model,
            input=text,
        )
        if not response.data:
            return None
        return [float(v) for v in response.data[0].embedding]

    def _normalize_loaded_values(self) -> None:
        for _, attrs in self.graph.nodes(data=True):
            attrs["authors"] = self._normalize_str_list(attrs.get("authors", []))
            attrs["references"] = self._normalize_str_list(attrs.get("references", []))
            attrs["categories"] = self._normalize_str_list(attrs.get("categories", []))
            attrs["embedding"] = self._normalize_embedding(attrs.get("embedding"))
            attrs["ingested_on"] = self._normalize_date(attrs.get("ingested_on"))

        for _, _, attrs in self.graph.edges(data=True):
            attrs["relation_types"] = self._normalize_str_list(attrs.get("relation_types", []))
            attrs["shared_authors"] = self._normalize_str_list(attrs.get("shared_authors", []))

    def _infer_topic(self, node_ids: Iterable[str]) -> str:
        text = " ".join(
            (
                str(self.graph.nodes[node_id].get("title", "")) + " "
                + str(self.graph.nodes[node_id].get("abstract", ""))
            )
            for node_id in node_ids
        ).lower()
        tokens = re.findall(r"[a-z][a-z0-9\-]{2,}", text)
        stop_words = {
            "the",
            "and",
            "for",
            "with",
            "from",
            "that",
            "this",
            "into",
            "using",
            "towards",
            "their",
            "through",
            "paper",
            "model",
            "models",
            "based",
            "study",
            "analysis",
            "learning",
        }

        counts: Dict[str, int] = {}
        for token in tokens:
            if token in stop_words:
                continue
            counts[token] = counts.get(token, 0) + 1

        if not counts:
            return "untitled-topic"

        top_tokens = sorted(counts.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)[:3]
        return " / ".join(token for token, _ in top_tokens)

    @staticmethod
    def _cosine_similarity(vec_a: Sequence[float], vec_b: Sequence[float]) -> Optional[float]:
        if len(vec_a) != len(vec_b) or not vec_a:
            return None

        dot = sum(a * b for a, b in zip(vec_a, vec_b))
        norm_a = math.sqrt(sum(a * a for a in vec_a))
        norm_b = math.sqrt(sum(b * b for b in vec_b))
        if norm_a == 0 or norm_b == 0:
            return None
        return dot / (norm_a * norm_b)

    @staticmethod
    def _normalize_str_list(values: Any) -> List[str]:
        if not values:
            return []
        result = []
        for item in values:
            value = str(item).strip()
            if value:
                result.append(value)
        return result

    @staticmethod
    def _normalize_embedding(embedding: Any) -> Optional[List[float]]:
        if embedding is None:
            return None
        if not isinstance(embedding, (list, tuple)):
            return None
        if not embedding:
            return None
        try:
            return [float(v) for v in embedding]
        except (TypeError, ValueError):
            return None

    def _normalize_date(self, value: Any) -> str:
        if isinstance(value, str):
            cleaned = value.strip()
            if cleaned:
                try:
                    datetime.strptime(cleaned, "%Y-%m-%d")
                    return cleaned
                except ValueError:
                    pass
        return self._today()

    @staticmethod
    def _today() -> str:
        return datetime.now().date().isoformat()

    @staticmethod
    def _now_iso() -> str:
        return datetime.now().isoformat(timespec="seconds")

