"""测试 ranking 打分排序逻辑（不走网络）"""

import asyncio

import pytest

from app.ranking import search_all
from app.sources.base import SearchResult


class FakeSource:
    def __init__(self, name: str, results: list[SearchResult]):
        self.name = name
        self._results = results

    async def search(self, query: str, limit: int) -> list[SearchResult]:
        return self._results[:limit]

    async def resolve(self, track_id: str) -> str:
        return "http://fake"


def make_result(sid: str, title: str, artist: str, dur: float, pop: float = 100.0) -> SearchResult:
    return SearchResult(id=sid, source="fake", title=title, artist=artist, duration_sec=dur, popularity=pop)


@pytest.mark.asyncio
async def test_ranking_sorts_by_score_desc():
    # query = "周杰伦 七里香"
    # 构造三个候选：高匹配+合理时长、高热度但时长离谱、低匹配
    good = make_result("1", "七里香", "周杰伦", 280, 99999)
    bad_dur = make_result("2", "七里香", "周杰伦", 1200, 88888)
    poor_match = make_result("3", "青花瓷", "周杰伦", 240, 77777)

    src = FakeSource("fake", [poor_match, good, bad_dur])

    res = await search_all("周杰伦 七里香", 10, [src])

    assert len(res) == 3
    # good 应该排第一
    assert res[0].id == "1"
    # 第二个应该是 poor_match（时长合理但匹配稍差）或 bad_dur，看具体分数
    scores = [r.stream_hint.get("score", 0) for r in res]
    assert scores == sorted(scores, reverse=True)


@pytest.mark.asyncio
async def test_ranking_handles_exception():
    class BrokenSource:
        name = "broken"

        async def search(self, query: str, limit: int):
            raise RuntimeError("network down")

        async def resolve(self, track_id: str):
            raise RuntimeError("no")

    good_src = FakeSource("good", [make_result("a", "test", "t", 200)])
    res = await search_all("test", 5, [BrokenSource(), good_src])
    assert len(res) == 1
    assert res[0].id == "a"
