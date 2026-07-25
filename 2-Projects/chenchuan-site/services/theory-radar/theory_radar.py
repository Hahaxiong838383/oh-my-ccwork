#!/usr/bin/env python3
"""Daily theory radar: RSS/OpenAlex ingest, Grok analysis, gated site publish."""

from __future__ import annotations

import argparse
import contextlib
import email.utils
import fcntl
import hashlib
import json
import os
import random
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


BJ_TZ = timezone(timedelta(hours=8))
ARXIV_RSS_BASE = "https://rss.arxiv.org/rss"
ARXIV_QUERY_URL = "https://export.arxiv.org/api/query"
OPENALEX_BASE = "https://api.openalex.org"
OPENALEX_ARXIV_SOURCE = "S4306400194"
RSS_CATEGORIES = ("cs.CL", "cs.AI", "cs.LG", "cs.NE", "q-bio.NC", "stat.ML")
EXPERTS = {
    "李飞飞": "A5100450462",
    "杨立昆": "A5001226970",
    "辛顿": "A5108093963",
    "本吉奥": "A5086198262",
    "哈萨比斯": "A5005349213",
    "Ilya Sutskever": "A5006446297",
}
ARXIV_ID_RE = re.compile(r"(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})(?:v\d+)?(?:\.pdf)?", re.I)
SPACE_RE = re.compile(r"\s+")

# Terms are intentionally explainable. The model analyzes papers; it does not select them.
KEYWORD_WEIGHTS = {
    "language model": 8,
    "large language model": 10,
    "llm": 8,
    "cognitive": 9,
    "cognition": 9,
    "neuroscience": 10,
    "neural representation": 8,
    "brain": 8,
    "memory": 6,
    "attention": 5,
    "reasoning": 7,
    "consciousness": 10,
    "world model": 8,
    "interpretability": 7,
    "mechanistic": 7,
    "chain-of-thought": 7,
    "chain of thought": 7,
    "agent": 4,
    "alignment": 4,
    "reinforcement learning": 4,
    "representation learning": 4,
    "generalization": 3,
    "benchmark": 2,
}


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat()


def normalize_text(value: str | None) -> str:
    return SPACE_RE.sub(" ", value or "").strip()


def atomic_write(path: Path, data: bytes, mode: int = 0o640) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with tmp.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def write_json(path: Path, value: Any, mode: int = 0o640) -> None:
    atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8") + b"\n", mode)


def load_json(path: Path, default: Any) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def safe_error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {str(exc)[:240]}"


@dataclass
class Config:
    state_dir: Path = field(default_factory=lambda: Path(os.environ.get("THEORY_RADAR_STATE_DIR", "/var/lib/theory-radar")))
    publish: bool = field(default_factory=lambda: env_bool("PUBLISH", False))
    webhook_url: str = field(default_factory=lambda: os.environ.get("RADAR_WEBHOOK_URL", "http://127.0.0.1:3000/api/radar-webhook"))
    webhook_token: str = field(default_factory=lambda: os.environ.get("RADAR_WEBHOOK_TOKEN", ""))
    analysis_base_url: str = field(default_factory=lambda: os.environ.get("ANALYSIS_PRIMARY_BASE_URL", "https://api.x.ai/v1").rstrip("/"))
    analysis_key: str = field(default_factory=lambda: os.environ.get("ANALYSIS_PRIMARY_API_KEY", os.environ.get("XAI_API_KEY", "")))
    analysis_model: str = field(default_factory=lambda: os.environ.get("ANALYSIS_PRIMARY_MODEL", "grok-4.5"))
    reasoning_effort: str = field(default_factory=lambda: os.environ.get("ANALYSIS_REASONING_EFFORT", "high"))
    openalex_key: str = field(default_factory=lambda: os.environ.get("OPENALEX_API_KEY", ""))
    contact_email: str = field(default_factory=lambda: os.environ.get("THEORY_RADAR_CONTACT_EMAIL", "admin@chenchuan.cc"))
    min_papers: int = field(default_factory=lambda: int(os.environ.get("MIN_PAPERS", "4")))
    max_papers: int = field(default_factory=lambda: int(os.environ.get("MAX_PAPERS", "8")))
    request_timeout: int = field(default_factory=lambda: int(os.environ.get("HTTP_TIMEOUT_SECONDS", "45")))
    analysis_timeout: int = field(default_factory=lambda: int(os.environ.get("ANALYSIS_TIMEOUT_SECONDS", "240")))
    query_cooldown_hours: int = field(default_factory=lambda: int(os.environ.get("ARXIV_QUERY_COOLDOWN_HOURS", "6")))

    @property
    def user_agent(self) -> str:
        return f"chenchuan-theory-radar/2.0 ({self.contact_email})"


class HttpClient:
    def __init__(self, config: Config):
        self.config = config
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        body: bytes | None = None,
        timeout: int | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        merged = {"User-Agent": self.config.user_agent, "Accept": "application/json, application/rss+xml, application/xml;q=0.9"}
        if headers:
            merged.update(headers)
        req = urllib.request.Request(url, data=body, headers=merged, method=method)
        try:
            with self.opener.open(req, timeout=timeout or self.config.request_timeout) as resp:
                return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
        except urllib.error.HTTPError as exc:
            payload = exc.read(4096)
            raise HttpStatusError(exc.code, payload.decode("utf-8", "replace"), dict(exc.headers.items())) from exc


class HttpStatusError(RuntimeError):
    def __init__(self, status: int, response_body: str = "", headers: dict[str, str] | None = None):
        super().__init__(f"HTTP {status}: {response_body[:180]}")
        self.status = status
        self.response_body = response_body
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}


def paper_score(paper: dict[str, Any]) -> int:
    text = f"{paper.get('title', '')} {paper.get('abstract', '')}".lower()
    score = sum(weight for term, weight in KEYWORD_WEIGHTS.items() if term in text)
    categories = set(paper.get("categories") or [])
    if "q-bio.NC" in categories:
        score += 10
    if "cs.CL" in categories:
        score += 5
    if paper.get("tracked_expert"):
        score += 7
    return score


def extract_arxiv_id(value: str | None) -> str:
    match = ARXIV_ID_RE.search(value or "")
    return match.group(1) if match else ""


def parse_rss(xml_data: bytes, category: str) -> list[dict[str, Any]]:
    root = ET.fromstring(xml_data)
    papers: list[dict[str, Any]] = []
    for item in root.findall("./channel/item"):
        link = normalize_text(item.findtext("link"))
        arxiv_id = extract_arxiv_id(link) or extract_arxiv_id(item.findtext("guid"))
        if not arxiv_id:
            continue
        description = normalize_text(item.findtext("description"))
        abstract = re.sub(r"^arXiv:.*?Abstract:\s*", "", description, flags=re.I)
        title = normalize_text(item.findtext("title"))
        categories = [normalize_text(node.text) for node in item.findall("category") if normalize_text(node.text)]
        if category not in categories:
            categories.insert(0, category)
        published = ""
        raw_date = normalize_text(item.findtext("pubDate"))
        if raw_date:
            with contextlib.suppress(ValueError, TypeError):
                published = email.utils.parsedate_to_datetime(raw_date).date().isoformat()
        creator = normalize_text(item.findtext("{http://purl.org/dc/elements/1.1/}creator"))
        announce_type = normalize_text(item.findtext("{http://arxiv.org/schemas/atom}announce_type")).lower()
        papers.append(
            {
                "title": title,
                "authors": [creator] if creator else [],
                "abstract": abstract[:4000],
                "arxiv_id": arxiv_id,
                "url": f"https://arxiv.org/abs/{arxiv_id}",
                "published": published,
                "categories": categories[:4],
                "source": f"arxiv-rss:{category}",
                "announce_type": announce_type,
            }
        )
    return papers


class RssSource:
    def __init__(self, config: Config, http: HttpClient):
        self.config = config
        self.http = http

    def fetch(self, run_date: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        cache_dir = self.config.state_dir / "cache" / "rss"
        raw_dir = self.config.state_dir / "raw" / run_date / "rss"
        papers: list[dict[str, Any]] = []
        category_state: dict[str, Any] = {}
        for index, category in enumerate(RSS_CATEGORIES):
            if index:
                time.sleep(1)
            cache_xml = cache_dir / f"{category}.xml"
            cache_meta = cache_dir / f"{category}.json"
            meta = load_json(cache_meta, {})
            headers: dict[str, str] = {"Accept": "application/rss+xml"}
            if meta.get("etag"):
                headers["If-None-Match"] = str(meta["etag"])
            if meta.get("last_modified"):
                headers["If-Modified-Since"] = str(meta["last_modified"])
            used_cache = False
            try:
                status, response_headers, payload = self.http.request(f"{ARXIV_RSS_BASE}/{urllib.parse.quote(category)}", headers=headers)
                if status == 200:
                    parsed = parse_rss(payload, category)
                    if not parsed:
                        raise ValueError("RSS parsed zero papers")
                    atomic_write(cache_xml, payload)
                    meta = {
                        "etag": response_headers.get("etag", ""),
                        "last_modified": response_headers.get("last-modified", ""),
                        "fetched_at": iso_now(),
                    }
                    write_json(cache_meta, meta)
                else:
                    raise HttpStatusError(status)
            except HttpStatusError as exc:
                if exc.status == 304 and cache_xml.exists():
                    payload = cache_xml.read_bytes()
                    parsed = parse_rss(payload, category)
                    used_cache = True
                elif cache_xml.exists():
                    payload = cache_xml.read_bytes()
                    parsed = parse_rss(payload, category)
                    used_cache = True
                    category_state[category] = {"ok": False, "cached": True, "error": safe_error(exc), "count": len(parsed)}
                else:
                    category_state[category] = {"ok": False, "cached": False, "error": safe_error(exc), "count": 0}
                    continue
            except Exception as exc:
                if cache_xml.exists():
                    payload = cache_xml.read_bytes()
                    parsed = parse_rss(payload, category)
                    used_cache = True
                    category_state[category] = {"ok": False, "cached": True, "error": safe_error(exc), "count": len(parsed)}
                else:
                    category_state[category] = {"ok": False, "cached": False, "error": safe_error(exc), "count": 0}
                    continue
            archive = raw_dir / f"{category}-{utc_now().strftime('%H%M%S')}-{hashlib.sha256(payload).hexdigest()[:10]}.xml"
            if not archive.exists():
                atomic_write(archive, payload)
            papers.extend(parsed)
            category_state.setdefault(category, {"ok": True, "cached": used_cache, "count": len(parsed)})
        return papers, {
            "ok": sum(1 for value in category_state.values() if value.get("ok")) >= 3,
            "verified_categories": sum(1 for value in category_state.values() if value.get("ok")),
            "count": len(papers),
            "categories": category_state,
            "fetched_at": iso_now(),
        }


def inverted_abstract(index: dict[str, list[int]] | None) -> str:
    if not index:
        return ""
    positioned: list[tuple[int, str]] = []
    for word, positions in index.items():
        positioned.extend((position, word) for position in positions)
    return " ".join(word for _, word in sorted(positioned))


class OpenAlexSource:
    def __init__(self, config: Config, http: HttpClient):
        self.config = config
        self.http = http

    def fetch(self, run_date: str, lookback_days: int = 180) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        start = (date.fromisoformat(run_date) - timedelta(days=lookback_days)).isoformat()
        raw_dir = self.config.state_dir / "raw" / run_date / "openalex"
        papers: list[dict[str, Any]] = []
        expert_state: dict[str, Any] = {}
        for index, (expert, author_id) in enumerate(EXPERTS.items()):
            if index:
                time.sleep(1)
            params = {
                "filter": f"author.id:{author_id},primary_location.source.id:{OPENALEX_ARXIV_SOURCE},from_publication_date:{start}",
                "sort": "publication_date:desc",
                "per-page": "25",
                "select": "id,title,publication_date,primary_location,authorships,abstract_inverted_index",
                "mailto": self.config.contact_email,
            }
            if self.config.openalex_key:
                params["api_key"] = self.config.openalex_key
            url = f"{OPENALEX_BASE}/works?{urllib.parse.urlencode(params)}"
            try:
                _, _, payload = self.http.request(url)
                obj = json.loads(payload)
                atomic_write(raw_dir / f"{author_id}-{utc_now().strftime('%H%M%S')}.json", payload)
                found = 0
                for work in obj.get("results", []):
                    location = work.get("primary_location") or {}
                    landing = location.get("landing_page_url") or ""
                    arxiv_id = extract_arxiv_id(landing)
                    abstract = inverted_abstract(work.get("abstract_inverted_index"))
                    # OpenAlex occasionally gives a new repository date to a very old arXiv ID.
                    # Keep expert tracking inside the configured lookback instead of resurfacing it.
                    id_month = arxiv_id[:4] if arxiv_id else ""
                    oldest_month = (date.fromisoformat(run_date) - timedelta(days=lookback_days + 31)).strftime("%y%m")
                    if not arxiv_id or not abstract or id_month < oldest_month:
                        continue
                    authors = [
                        normalize_text((entry.get("author") or {}).get("display_name"))
                        for entry in (work.get("authorships") or [])[:5]
                    ]
                    papers.append(
                        {
                            "title": normalize_text(work.get("title")),
                            "authors": [name for name in authors if name],
                            "abstract": abstract[:4000],
                            "arxiv_id": arxiv_id,
                            "url": f"https://arxiv.org/abs/{arxiv_id}",
                            "published": work.get("publication_date") or "",
                            "categories": [],
                            "tracked_expert": expert,
                            "source": "openalex:expert",
                        }
                    )
                    found += 1
                expert_state[expert] = {"ok": True, "count": found}
            except Exception as exc:
                expert_state[expert] = {"ok": False, "count": 0, "error": safe_error(exc)}
        return papers, {
            "ok": any(value.get("ok") for value in expert_state.values()),
            "count": len(papers),
            "experts": expert_state,
            "fetched_at": iso_now(),
        }


class QueryCircuit:
    def __init__(self, config: Config, http: HttpClient):
        self.config = config
        self.http = http
        self.path = config.state_dir / "query-circuit.json"

    def probe(self) -> dict[str, Any]:
        state = load_json(self.path, {})
        now = utc_now()
        opened_until = state.get("opened_until")
        if opened_until:
            with contextlib.suppress(ValueError):
                if datetime.fromisoformat(opened_until) > now:
                    return {**state, "skipped": True}
        if os.environ.get("ARXIV_QUERY_FORCE_STATUS") == "429":
            return self._open("forced HTTP 429")
        params = urllib.parse.urlencode({"search_query": "cat:cs.CL", "start": 0, "max_results": 1})
        try:
            status, _, _ = self.http.request(f"{ARXIV_QUERY_URL}?{params}", headers={"Accept": "application/atom+xml"})
            healthy = {"status": "closed", "last_probe_at": iso_now(), "last_http_status": status, "consecutive_failures": 0}
            write_json(self.path, healthy)
            return healthy
        except HttpStatusError as exc:
            if exc.status == 429:
                return self._open("HTTP 429")
            return self._open(f"HTTP {exc.status}")
        except Exception as exc:
            return self._open(safe_error(exc))

    def _open(self, reason: str) -> dict[str, Any]:
        old = load_json(self.path, {})
        state = {
            "status": "open",
            "reason": reason,
            "last_probe_at": iso_now(),
            "last_http_status": 429 if "429" in reason else None,
            "consecutive_failures": int(old.get("consecutive_failures", 0)) + 1,
            "opened_until": (utc_now() + timedelta(hours=self.config.query_cooldown_hours)).isoformat(),
        }
        write_json(self.path, state)
        return state


def dedupe_papers(papers: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for paper in papers:
        arxiv_id = str(paper.get("arxiv_id", "")).split("v")[0]
        if not arxiv_id:
            continue
        paper["arxiv_id"] = arxiv_id
        existing = by_id.get(arxiv_id)
        if existing is None or len(paper.get("abstract", "")) > len(existing.get("abstract", "")):
            by_id[arxiv_id] = paper
        elif paper.get("tracked_expert"):
            existing["tracked_expert"] = paper["tracked_expert"]
    return list(by_id.values())


def select_papers(papers: Iterable[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    ranked = []
    for paper in dedupe_papers(papers):
        if str(paper.get("announce_type", "")).startswith("replace"):
            continue
        paper["selection_score"] = paper_score(paper)
        if paper["selection_score"] > 0:
            ranked.append(paper)
    ranked.sort(key=lambda item: (item["selection_score"], item.get("published", "")), reverse=True)
    return ranked[:limit]


def analysis_schema(count: int) -> dict[str, Any]:
    paper = {
        "type": "object",
        "properties": {
            "arxivId": {"type": "string"},
            "titleCn": {"type": "string"},
            "score": {"type": "integer", "minimum": 0, "maximum": 100},
            "finding": {"type": "string"},
            "llmLink": {"type": "string"},
            "insight": {"type": "string"},
        },
        "required": ["arxivId", "titleCn", "score", "finding", "llmLink", "insight"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "papers": {"type": "array", "items": paper, "minItems": count, "maxItems": count},
        },
        "required": ["summary", "papers"],
        "additionalProperties": False,
    }


def build_analysis_prompt(papers: list[dict[str, Any]]) -> str:
    blocks = []
    for index, paper in enumerate(papers, 1):
        categories = ",".join(paper.get("categories") or [])
        expert = f" | 专家追踪:{paper['tracked_expert']}" if paper.get("tracked_expert") else ""
        blocks.append(
            f"[{index}] arxivId={paper['arxiv_id']} | 分类:{categories}{expert}\n"
            f"标题:{paper['title']}\n摘要:{paper['abstract'][:1800]}"
        )
    return (
        "你是 AI 前沿理论雷达分析师。仅依据给定标题和摘要进行中文分析，禁止联网、禁止补写摘要中没有的数据或实验结论。\n"
        "每篇输出：中文精简标题、认知重合度、核心发现、与 LLM 机制或 AI 设计的连接、研究启示。\n"
        "arxivId 必须原样回填；papers 数量和顺序必须与输入完全一致。summary 不超过 100 个汉字，其他分析字段每项不超过 350 个汉字。\n\n"
        + "\n\n".join(blocks)
    )


class Analyzer:
    def __init__(self, config: Config, http: HttpClient):
        self.config = config
        self.http = http

    def analyze(self, papers: list[dict[str, Any]]) -> dict[str, Any]:
        if not self.config.analysis_key:
            raise RuntimeError("ANALYSIS_PRIMARY_API_KEY is missing")
        schema = analysis_schema(len(papers))
        body = {
            "model": self.config.analysis_model,
            "messages": [{"role": "user", "content": build_analysis_prompt(papers)}],
            "max_tokens": 12000,
            "reasoning_effort": self.config.reasoning_effort,
            "stream": False,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "theory_radar_report", "strict": True, "schema": schema},
            },
        }
        last_error: BaseException | None = None
        for attempt in range(1, 4):
            try:
                _, _, payload = self.http.request(
                    f"{self.config.analysis_base_url}/chat/completions",
                    method="POST",
                    headers={"Authorization": f"Bearer {self.config.analysis_key}", "Content-Type": "application/json"},
                    body=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                    timeout=self.config.analysis_timeout,
                )
                response = json.loads(payload)
                content = response["choices"][0]["message"]["content"]
                return json.loads(content)
            except Exception as exc:
                last_error = exc
                if attempt < 3:
                    time.sleep((2**attempt) + random.random())
        raise RuntimeError(f"Grok analysis failed after 3 attempts: {safe_error(last_error or RuntimeError('unknown'))}")


def build_report(run_date: str, selected: list[dict[str, Any]], analysis: dict[str, Any]) -> dict[str, Any]:
    raw_analyses = analysis.get("papers")
    if not isinstance(raw_analyses, list) or len(raw_analyses) != len(selected):
        raise ValueError("analysis paper count mismatch")
    expected = [paper["arxiv_id"] for paper in selected]
    received = [str(item.get("arxivId", "")).split("v")[0] for item in raw_analyses]
    if len(received) != len(set(received)) or set(received) != set(expected):
        raise ValueError("analysis arXiv IDs mismatch")
    analysis_by_id = {str(item["arxivId"]).split("v")[0]: item for item in raw_analyses}
    output = []
    for index, source in enumerate(selected, 1):
        item = analysis_by_id[source["arxiv_id"]]
        fields = [normalize_text(item.get(name)) for name in ("titleCn", "finding", "llmLink", "insight")]
        if any(not value for value in fields):
            raise ValueError(f"analysis fields missing for {source['arxiv_id']}")
        score = item.get("score")
        if not isinstance(score, int) or isinstance(score, bool) or not 0 <= score <= 100:
            raise ValueError(f"invalid score for {source['arxiv_id']}")
        output.append(
            {
                "index": index,
                "title": fields[0][:300],
                "arxivId": source["arxiv_id"],
                "url": f"https://arxiv.org/abs/{source['arxiv_id']}",
                "published": source.get("published") or "",
                "category": (source.get("categories") or [""])[0],
                "score": score,
                "finding": fields[1][:1200],
                "llmLink": fields[2][:1200],
                "insight": fields[3][:1200],
            }
        )
    return {
        "date": run_date,
        "summary": normalize_text(analysis.get("summary"))[:600],
        "papers": output,
        "generatedAt": datetime.now(BJ_TZ).isoformat(),
    }


def validate_report(report: dict[str, Any], run_date: str, min_papers: int) -> None:
    if report.get("date") != run_date:
        raise ValueError("report date mismatch")
    papers = report.get("papers")
    if not isinstance(papers, list) or len(papers) < min_papers:
        raise ValueError(f"report has fewer than {min_papers} papers")
    ids = [paper.get("arxivId") for paper in papers]
    if len(ids) != len(set(ids)) or any(not value for value in ids):
        raise ValueError("report contains duplicate or empty arXiv IDs")
    for paper in papers:
        if paper.get("url") != f"https://arxiv.org/abs/{paper['arxivId']}":
            raise ValueError("report URL does not match arXiv ID")
        if not all(normalize_text(paper.get(field)) for field in ("title", "finding", "llmLink", "insight")):
            raise ValueError("report contains empty analysis fields")


def publish_report(config: Config, http: HttpClient, report: dict[str, Any]) -> dict[str, Any]:
    if not config.webhook_token:
        raise RuntimeError("RADAR_WEBHOOK_TOKEN is missing")
    status, _, payload = http.request(
        config.webhook_url,
        method="POST",
        headers={"Authorization": f"Bearer {config.webhook_token}", "Content-Type": "application/json"},
        body=json.dumps(report, ensure_ascii=False).encode("utf-8"),
        timeout=60,
    )
    result = json.loads(payload)
    if status != 200 or not result.get("ok"):
        raise RuntimeError(f"webhook rejected report with HTTP {status}")
    return result


def update_state(config: Config, **values: Any) -> dict[str, Any]:
    path = config.state_dir / "state.json"
    state = load_json(path, {})
    state.update(values)
    state["updated_at"] = iso_now()
    write_json(path, state)
    return state


@contextlib.contextmanager
def job_lock(config: Config):
    config.state_dir.mkdir(parents=True, exist_ok=True)
    with (config.state_dir / "job.lock").open("a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("another theory-radar job is already running") from exc
        yield


def fetch_candidates(config: Config, http: HttpClient, run_date: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rss_papers, rss_state = RssSource(config, http).fetch(run_date)
    oa_papers, oa_state = OpenAlexSource(config, http).fetch(run_date)
    selected = select_papers([*rss_papers, *oa_papers], config.max_papers)
    source_state = {
        "date": run_date,
        "rss": rss_state,
        "openalex": oa_state,
        "arxiv_query_circuit": load_json(config.state_dir / "query-circuit.json", {"status": "unknown"}),
        "unique_candidates": len(dedupe_papers([*rss_papers, *oa_papers])),
        "selected": len(selected),
        "fresh": bool(rss_state.get("ok")),
        "updated_at": iso_now(),
    }
    write_json(config.state_dir / "source_state.json", source_state)
    write_json(config.state_dir / "candidates" / f"{run_date}.json", {"date": run_date, "papers": selected, "source_state": source_state})
    if not source_state["fresh"]:
        raise RuntimeError("fewer than three arXiv RSS categories were freshly verified")
    if len(selected) < config.min_papers:
        raise RuntimeError(f"only {len(selected)} relevant papers, need {config.min_papers}")
    return selected, source_state


def run_job(config: Config, run_date: str, retry_analysis: bool = False, reconcile: bool = False) -> dict[str, Any]:
    http = HttpClient(config)
    with job_lock(config):
        update_state(config, status="running", stage="fetch", run_date=run_date, publish=config.publish, last_error=None)
        try:
            if retry_analysis:
                candidate_doc = load_json(config.state_dir / "candidates" / f"{run_date}.json", {})
                selected = candidate_doc.get("papers") or []
                source_state = candidate_doc.get("source_state") or {}
                if len(selected) < config.min_papers:
                    raise RuntimeError("no valid saved candidate snapshot for retry")
            else:
                selected, source_state = fetch_candidates(config, http, run_date)
            if reconcile:
                source_state["arxiv_query_circuit"] = QueryCircuit(config, http).probe()
                write_json(config.state_dir / "source_state.json", source_state)
            update_state(config, status="running", stage="analysis", selected_count=len(selected), source_state=source_state)
            analysis = Analyzer(config, http).analyze(selected)
            report = build_report(run_date, selected, analysis)
            validate_report(report, run_date, config.min_papers)
            report_path = config.state_dir / "reports" / f"report-{run_date}.json"
            write_json(report_path, report)
            publish_result: dict[str, Any] | None = None
            if config.publish:
                update_state(config, status="running", stage="publish")
                publish_result = publish_report(config, http, report)
                shutil.copy2(report_path, config.state_dir / "last-good.json")
            state = update_state(
                config,
                status="ok",
                stage="complete",
                provider=f"grok/{config.analysis_model}",
                report_path=str(report_path),
                paper_count=len(report["papers"]),
                published=config.publish,
                publish_result=publish_result,
                completed_at=iso_now(),
                last_error=None,
            )
            return state
        except Exception as exc:
            update_state(config, status="error", stage="failed", completed_at=iso_now(), last_error=safe_error(exc))
            raise


def health(config: Config) -> int:
    state = load_json(config.state_dir / "state.json", {})
    source = load_json(config.state_dir / "source_state.json", {})
    output = {"state": state, "source": source}
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if state.get("status") == "ok" else 1


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("run", "retry-analysis", "reconcile", "query-probe", "health"), nargs="?", default="run")
    parser.add_argument("--date", default=datetime.now(BJ_TZ).date().isoformat())
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    config = Config()
    try:
        date.fromisoformat(args.date)
    except ValueError:
        print("invalid --date; expected YYYY-MM-DD", file=sys.stderr)
        return 2
    if args.command == "health":
        return health(config)
    if args.command == "query-probe":
        print(json.dumps(QueryCircuit(config, HttpClient(config)).probe(), ensure_ascii=False, indent=2))
        return 0
    try:
        state = run_job(config, args.date, retry_analysis=args.command == "retry-analysis", reconcile=args.command == "reconcile")
        print(json.dumps(state, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(f"theory-radar failed: {safe_error(exc)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
