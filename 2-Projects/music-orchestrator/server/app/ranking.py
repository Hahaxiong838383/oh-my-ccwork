"""多源并发搜索 + 打分排序"""

import asyncio
import difflib
import logging
from typing import Protocol

from app.sources.base import SearchResult

logger = logging.getLogger(__name__)


class Source(Protocol):
    name: str

    async def search(self, query: str, limit: int) -> list[SearchResult]:
        ...


def _title_artist_score(query: str, title: str, artist: str) -> float:
    """标题+歌手模糊匹配分数 (0~1)，权重 0.5"""
    q = (query or "").lower().strip()
    t = (title or "").lower().strip()
    a = (artist or "").lower().strip()
    if not q:
        return 0.0
    # 用 SequenceMatcher 计算相似度
    title_sim = difflib.SequenceMatcher(None, q, t).ratio()
    artist_sim = difflib.SequenceMatcher(None, q, a).ratio()
    # 取更高者或加权
    combined = max(title_sim, artist_sim * 0.8 + title_sim * 0.2)
    return combined


def _duration_score(duration_sec: float) -> float:
    """时长合理性 (90-480秒内满分)，权重 0.2"""
    if duration_sec <= 0:
        return 0.0
    if 90 <= duration_sec <= 480:
        return 1.0
    # 越离谱扣分，线性衰减
    if duration_sec < 90:
        return max(0.0, duration_sec / 90.0)
    # >480
    excess = duration_sec - 480
    return max(0.0, 1.0 - (excess / 600.0))  # 10分钟以上大幅衰减


def _popularity_score(popularity: float, max_pop: float) -> float:
    """热度归一化 (0~1)，权重 0.3"""
    if max_pop <= 0:
        return 0.0
    return min(1.0, popularity / max_pop)


async def search_all(
    query: str, limit: int, enabled_sources: list[Source]
) -> list[SearchResult]:
    """并发调用各 source.search，捕获异常，汇总打分排序后返回。"""
    if not enabled_sources:
        return []

    # 并发搜索
    tasks = [s.search(query, limit) for s in enabled_sources]
    results_list = await asyncio.gather(*tasks, return_exceptions=True)

    all_results: list[SearchResult] = []
    for i, res in enumerate(results_list):
        src = enabled_sources[i]
        if isinstance(res, Exception):
            logger.warning(f"source {src.name} search failed: {res}")
            continue
        if isinstance(res, list):
            all_results.extend(res)

    if not all_results:
        return []

    # 计算 max_pop 用于归一化
    max_pop = max((r.popularity for r in all_results), default=0.0)

    scored: list[tuple[float, SearchResult]] = []
    for r in all_results:
        ta = _title_artist_score(query, r.title, r.artist) * 0.5
        dur = _duration_score(r.duration_sec) * 0.2
        pop = _popularity_score(r.popularity, max_pop) * 0.3
        total = ta + dur + pop
        scored.append((total, r))

    # 按分数降序
    scored.sort(key=lambda x: x[0], reverse=True)

    # 去重（同 source + id）
    seen = set()
    final: list[SearchResult] = []
    for score, r in scored:
        key = (r.source, r.id)
        if key in seen:
            continue
        seen.add(key)
        # 把分数塞到 stream_hint 里方便上层（也可扩展字段，但保持简单）
        r.stream_hint = {**r.stream_hint, "score": round(score, 4)}
        final.append(r)
        if len(final) >= limit * 3:  # 多取一点给上层 music_play 用
            break

    return final
