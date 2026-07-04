"""Source 协议与搜索结果数据结构"""

from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class SearchResult:
    id: str
    source: str
    title: str
    artist: str
    duration_sec: float
    popularity: float = 0.0
    stream_hint: dict = field(default_factory=dict)


class Source(Protocol):
    name: str

    async def search(self, query: str, limit: int) -> list[SearchResult]:
        ...

    async def resolve(self, track_id: str) -> str:
        """返回可直接被 yt-dlp/httpx 消费的直链，或抛出异常。"""
        ...
