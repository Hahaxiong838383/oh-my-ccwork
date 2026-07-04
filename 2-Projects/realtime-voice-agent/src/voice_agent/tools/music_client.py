"""music-orchestrator HTTP 客户端封装。

所有调用均为 async，网络错误返回明确错误结构，不裸抛。
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger("voice_agent.music.client")

DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


class MusicClient:
    """封装 music-orchestrator 的 5 个工具端点。"""

    def __init__(self, base_url: str, api_key: str = "") -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or ""
        headers: dict[str, str] = {}
        if self.api_key:
            headers["X-Music-Key"] = self.api_key
        self._client = httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, headers=headers or None)

    async def aclose(self) -> None:
        await self._client.aclose()

    def _url(self, path: str) -> str:
        p = path if path.startswith("/") else f"/{path}"
        return f"{self.base_url}{p}"

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            resp = await self._client.post(self._url(path), json=payload)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict):
                return data
            return {"raw": data}
        except httpx.HTTPStatusError as e:
            logger.warning("music post %s status=%s", path, e.response.status_code)
            try:
                err = e.response.json()
            except Exception:
                err = {"message": e.response.text}
            return {"status": "error", "error": err, "code": e.response.status_code}
        except httpx.HTTPError as e:
            logger.warning("music post %s error: %s", path, e)
            return {"status": "error", "message": str(e)}
        except Exception as e:
            logger.exception("music post %s unexpected", path)
            return {"status": "error", "message": str(e)}

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            resp = await self._client.get(self._url(path), params=params or {})
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict):
                return data
            return {"raw": data}
        except httpx.HTTPStatusError as e:
            logger.warning("music get %s status=%s", path, e.response.status_code)
            try:
                err = e.response.json()
            except Exception:
                err = {"message": e.response.text}
            return {"status": "error", "error": err, "code": e.response.status_code}
        except httpx.HTTPError as e:
            logger.warning("music get %s error: %s", path, e)
            return {"status": "error", "message": str(e)}
        except Exception as e:
            logger.exception("music get %s unexpected", path)
            return {"status": "error", "message": str(e)}

    async def music_search(
        self, query: str, limit: int = 5, session_id: str = ""
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"query": query, "limit": limit}
        if session_id:
            payload["session_id"] = session_id
        return await self._post("/tools/music_search", payload)

    async def music_play(
        self, query: str, mode: str = "track", session_id: str = ""
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"query": query, "mode": mode}
        if session_id:
            payload["session_id"] = session_id
        return await self._post("/tools/music_play", payload)

    async def music_control(
        self, action: str, value: Any | None = None, session_id: str = ""
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"action": action}
        if value is not None:
            payload["value"] = value
        if session_id:
            payload["session_id"] = session_id
        return await self._post("/tools/music_control", payload)

    async def music_queue(
        self, action: str, item: Any | None = None, session_id: str = ""
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"action": action}
        if item is not None:
            payload["item"] = item
        if session_id:
            payload["session_id"] = session_id
        return await self._post("/tools/music_queue", payload)

    async def music_status(self, session_id: str = "") -> dict[str, Any]:
        params: dict[str, Any] = {}
        if session_id:
            params["session_id"] = session_id
        return await self._get("/tools/music_status", params)
