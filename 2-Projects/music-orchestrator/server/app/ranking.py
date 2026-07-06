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
    """标题+歌手匹配分数 (0~1)，权重 0.5。

    精确子串信号优先（2026-07-06 真机踩坑修复）：搜"夜曲"时 B 站自然排序不稳定，
    《蛋仔派对：把惊魂夜唱成一首歌》这类游戏视频曾冲到 top（标题不含连续"夜曲"，
    但 SequenceMatcher 对短 query 的区分度差 + 热度分把它顶上去）。标题/歌手包含
    完整 query 子串 → 强信号直接高分；query 含多词（如"夜曲 周杰伦"）时按词逐个
    检查子串命中率。模糊相似度只做兜底。
    """
    q = (query or "").lower().strip()
    t = (title or "").lower().strip()
    a = (artist or "").lower().strip()
    if not q:
        return 0.0

    # 精确子串：query 整体或全部分词都出现在 标题+歌手 里 → 0.9+；部分命中按比例
    haystack = f"{t} {a}"
    words = [w for w in q.split() if w]
    if words:
        hit = sum(1 for w in words if w in haystack)
        if hit == len(words):
            return 1.0 if q in haystack or len(words) > 1 else 0.95
        if hit > 0:
            exact_partial = 0.5 + 0.3 * (hit / len(words))
        else:
            exact_partial = 0.0
    else:
        exact_partial = 0.0

    # 模糊相似度兜底（长错拼/近似写法）
    title_sim = difflib.SequenceMatcher(None, q, t).ratio()
    artist_sim = difflib.SequenceMatcher(None, q, a).ratio()
    fuzzy = max(title_sim, artist_sim * 0.8 + title_sim * 0.2)
    return max(exact_partial, fuzzy)


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
