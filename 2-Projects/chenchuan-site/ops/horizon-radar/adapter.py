"""Convert Horizon MCP artifacts into the personal-site digest contract."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

CATEGORY_ALIASES = {
    "ai-models": "ai-models",
    "machine-learning": "ai-models",
    "llm": "ai-models",
    "models": "ai-models",
    "ai-tools": "ai-products",
    "ai-products": "ai-products",
    "product": "ai-products",
    "research": "paper",
    "paper": "paper",
    "papers": "paper",
    "ai-news": "industry",
    "industry": "industry",
    "business": "industry",
    "software-engineering": "tip",
    "engineering": "tip",
    "tools": "tip",
}

AI_RELEVANCE_TERMS = (
    "artificial intelligence",
    "generative ai",
    "machine learning",
    "deep learning",
    "large language model",
    "foundation model",
    "neural network",
    "chatgpt",
    "openai",
    "anthropic",
    "claude",
    "gemini",
    "grok",
    "hugging face",
    "huggingface",
    "transformer",
    "diffusion model",
    "multimodal",
    "agentic",
    "ai agent",
    "inference",
    "mlx",
    "llm",
    "人工智能",
    "大模型",
    "机器学习",
    "深度学习",
    "多模态",
    "智能体",
    "神经网络",
    "模型推理",
)


def _text(value: Any, limit: int) -> str:
    return str(value).strip()[:limit] if value is not None else ""


def _category(metadata: dict[str, Any]) -> str | None:
    raw = _text(metadata.get("category"), 80).lower()
    return CATEGORY_ALIASES.get(raw)


def _source(item: dict[str, Any], metadata: dict[str, Any]) -> str:
    for key in ("feed_name", "publisher", "repo", "channel", "subreddit"):
        value = _text(metadata.get(key), 120)
        if value:
            return value
    return _text(item.get("author"), 120) or _text(item.get("source_type"), 40) or "AI source"


def _references(metadata: dict[str, Any]) -> list[dict[str, str]]:
    raw = metadata.get("sources")
    if not isinstance(raw, list):
        return []
    output: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        url = _text(entry.get("url"), 2048)
        if not url.startswith(("http://", "https://")) or url in seen:
            continue
        seen.add(url)
        output.append({"title": _text(entry.get("title"), 160), "url": url})
        if len(output) == 4:
            break
    return output


def _split_zh_summary(value: str) -> tuple[str, str, str]:
    sentences = [part.strip() for part in re.split(r"(?<=[。！？!?])\s*", value) if part.strip()]
    if len(sentences) < 2:
        return value, "", ""
    return sentences[0], sentences[1], " ".join(sentences[2:])


def is_ai_relevant(item: dict[str, Any]) -> bool:
    metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    tags = item.get("ai_tags") if isinstance(item.get("ai_tags"), list) else []
    fields = [
        item.get("title"),
        item.get("ai_summary"),
        metadata.get("title_zh"),
        metadata.get("detailed_summary_zh"),
        metadata.get("summary_zh"),
        *tags,
    ]
    haystack = " ".join(_text(value, 1600) for value in fields).lower()
    if re.search(r"(?<![a-z0-9])ai(?![a-z0-9])", haystack):
        return True
    return any(term in haystack for term in AI_RELEVANCE_TERMS)


def normalize_item(item: dict[str, Any], index: int) -> dict[str, Any] | None:
    metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    url = _text(item.get("url"), 2048)
    if not url.startswith(("http://", "https://")):
        return None

    title = _text(metadata.get("title_zh"), 300) or _text(item.get("title"), 300)
    detailed_summary = (
        _text(metadata.get("detailed_summary_zh"), 1200)
        or _text(metadata.get("summary_zh"), 1200)
        or _text(item.get("ai_summary"), 1200)
    )
    if not title or not detailed_summary:
        return None

    summary, derived_why, derived_details = _split_zh_summary(detailed_summary)

    score_raw = item.get("ai_score")
    score = float(score_raw) if isinstance(score_raw, (int, float)) else 0.0
    tags = item.get("ai_tags") if isinstance(item.get("ai_tags"), list) else []

    return {
        "id": _text(item.get("id"), 180) or f"horizon-{index + 1}",
        "title": title,
        "titleEn": _text(item.get("title"), 300),
        "url": url,
        "source": _source(item, metadata),
        "sourceType": _text(item.get("source_type"), 40),
        "publishedAt": _text(item.get("published_at"), 40) or None,
        "score": max(0.0, min(10.0, score)),
        "summary": summary,
        "whyItMatters": _text(metadata.get("why_it_matters_zh"), 1200) or derived_why or None,
        "keyDetails": _text(metadata.get("key_details_zh"), 1200) or derived_details or None,
        "background": _text(metadata.get("background_zh"), 1600) or None,
        "communityDiscussion": _text(metadata.get("community_discussion_zh"), 1600) or None,
        "tags": [_text(tag, 40) for tag in tags[:8] if _text(tag, 40)],
        "category": _category(metadata),
        "references": _references(metadata),
    }


def build_report(
    pipeline: dict[str, Any],
    items: list[dict[str, Any]],
    *,
    report_date: str,
    generated_at: datetime,
    publish: bool,
    horizon_commit: str,
    max_items: int = 12,
    exclude_urls: set[str] | None = None,
) -> dict[str, Any]:
    normalized: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    excluded_urls = exclude_urls or set()
    realtime_duplicate_count = 0
    relevance_filtered_count = 0
    for index, item in enumerate(items):
        if not is_ai_relevant(item):
            relevance_filtered_count += 1
            continue
        parsed = normalize_item(item, index)
        if not parsed or parsed["url"] in seen_urls:
            continue
        seen_urls.add(parsed["url"])
        if parsed["url"] in excluded_urls:
            realtime_duplicate_count += 1
            continue
        normalized.append(parsed)
        if len(normalized) >= max_items:
            break

    fetch = pipeline.get("fetch") if isinstance(pipeline.get("fetch"), dict) else {}
    source_counts = fetch.get("source_counts") if isinstance(fetch.get("source_counts"), dict) else {}
    total_fetched = fetch.get("raw_before_merge", fetch.get("fetched", len(items)))
    if not isinstance(total_fetched, int):
        total_fetched = len(items)

    duplicate_note = (
        f"，并剔除 {realtime_duplicate_count} 条已在实时流出现的重复内容"
        if realtime_duplicate_count
        else ""
    )
    relevance_note = (
        f"，过滤 {relevance_filtered_count} 条非 AI 高相关内容"
        if relevance_filtered_count
        else ""
    )
    return {
        "type": "horizon",
        "publish": publish,
        "date": report_date,
        "generatedAt": generated_at.isoformat(),
        "summary": f"本期从 {total_fetched} 条跨源内容中筛选出 {len(normalized)} 条高价值进展{duplicate_note}{relevance_note}，补充实时流的广度与理论雷达的深度。",
        "totalFetched": total_fetched,
        "sourceCount": len(source_counts),
        "realtimeDuplicateCount": realtime_duplicate_count,
        "relevanceFilteredCount": relevance_filtered_count,
        "runId": _text(pipeline.get("run_id"), 160),
        "horizonCommit": horizon_commit,
        "items": normalized,
    }
