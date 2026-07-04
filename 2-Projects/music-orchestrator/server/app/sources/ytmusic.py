"""YouTube Music 源骨架（Phase 3 待接入）"""

from app.sources.base import SearchResult, Source


class YTMusicSource:
    name = "ytmusic"

    async def search(self, query: str, limit: int) -> list[SearchResult]:
        raise NotImplementedError("Phase 3 — 未接入")

    async def resolve(self, track_id: str) -> str:
        raise NotImplementedError("Phase 3 — 未接入")
