"""工具接口路由 (/tools)"""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from app.config import config
from app.ranking import search_all
from app.session_state import get_session
from app.signing import sign_stream
from app.sources.base import SearchResult


def _signed_stream_url(source: str, track_id: str) -> str:
    """拼带签名 token 的相对 stream 地址（供浏览器 `<audio>` 无 header 取流）。"""
    token, exp = sign_stream(source, track_id)
    return f"/stream/{source}/{track_id}?token={token}&exp={exp}"

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tools", tags=["tools"])


def require_music_key(x_music_key: Optional[str] = Header(None)):
    if not config.music_key or x_music_key != config.music_key:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Music-Key")
    return x_music_key


class SearchRequest(BaseModel):
    query: str
    limit: int = 5
    session_id: str


class PlayRequest(BaseModel):
    query: str
    mode: str = "track"  # 目前仅支持 track
    session_id: str
    exclude_ids: Optional[List[str]] = None  # "换一首"：跳过已放过的曲目 id


class ControlRequest(BaseModel):
    action: str  # pause | resume | next | prev | stop | volume
    value: Optional[Any] = None
    session_id: str


class QueueRequest(BaseModel):
    action: str  # add | clear | list
    item: Optional[Dict[str, Any]] = None
    session_id: str


class SearchResponseItem(BaseModel):
    id: str
    source: str
    title: str
    artist: str
    duration_sec: float
    score: float


@router.post("/music_search")
async def music_search(req: SearchRequest, _: str = Depends(require_music_key)):
    from app.sources import get_enabled_sources  # 延迟避免循环

    sources = get_enabled_sources()
    results = await search_all(req.query, req.limit, sources)

    out = []
    for r in results:
        score = r.stream_hint.get("score", 0.0) if isinstance(r.stream_hint, dict) else 0.0
        out.append(
            SearchResponseItem(
                id=r.id,
                source=r.source,
                title=r.title,
                artist=r.artist,
                duration_sec=r.duration_sec,
                score=round(score, 4),
            )
        )
    return {"results": [o.model_dump() for o in out]}


@router.post("/music_play")
async def music_play(req: PlayRequest, _: str = Depends(require_music_key)):
    from app.sources import get_enabled_sources

    sources = get_enabled_sources()
    results = await search_all(req.query, 8, sources)

    # "换一首"：过滤掉已放过的曲目；全放过则清空重来（循环）
    if req.exclude_ids:
        excluded = set(req.exclude_ids)
        filtered = [r for r in results if r.id not in excluded]
        if filtered:
            results = filtered

    if not results:
        return {"status": "not_found"}

    top = results[0]
    score = top.stream_hint.get("score", 0.0) if isinstance(top.stream_hint, dict) else 0.0

    stream_url = _signed_stream_url(top.source, top.id)

    sess = get_session(req.session_id)
    track_dict = {
        "id": top.id,
        "source": top.source,
        "title": top.title,
        "artist": top.artist,
        "duration_sec": top.duration_sec,
    }

    # "换一首"（带 exclude_ids）语义是"随便给我下一首"，用户已认定这个查询，
    # 不该再走 ambiguous 让用户二次选——直接播下一首（哪怕相关度分低）。
    force_play = bool(req.exclude_ids)

    if score > 0.75 or force_play:
        sess["current_track"] = {**track_dict, "stream_url": stream_url}
        sess["playing"] = True
        sess["position_sec"] = 0.0
        return {
            "status": "playing",
            "track": track_dict,
            "stream_url": stream_url,
        }
    elif 0.5 <= score <= 0.75:
        sess["current_track"] = {**track_dict, "stream_url": stream_url}
        sess["playing"] = True
        sess["position_sec"] = 0.0
        alts = []
        for r in results[1:6]:
            sc = r.stream_hint.get("score", 0.0) if isinstance(r.stream_hint, dict) else 0.0
            alts.append(
                {
                    "id": r.id,
                    "source": r.source,
                    "title": r.title,
                    "artist": r.artist,
                    "duration_sec": r.duration_sec,
                    "score": round(sc, 4),
                }
            )
        return {
            "status": "playing",
            "track": track_dict,
            "stream_url": stream_url,
            "alternatives": alts,
        }
    else:
        # score < 0.5
        cands = []
        for r in results[:5]:
            sc = r.stream_hint.get("score", 0.0) if isinstance(r.stream_hint, dict) else 0.0
            cands.append(
                {
                    "id": r.id,
                    "source": r.source,
                    "title": r.title,
                    "artist": r.artist,
                    "duration_sec": r.duration_sec,
                    "score": round(sc, 4),
                }
            )
        return {"status": "ambiguous", "candidates": cands}


@router.post("/music_control")
async def music_control(req: ControlRequest, _: str = Depends(require_music_key)):
    sess = get_session(req.session_id)
    action = req.action.lower()

    if action == "pause":
        sess["playing"] = False
    elif action == "resume":
        if sess.get("current_track"):
            sess["playing"] = True
    elif action == "stop":
        sess["playing"] = False
        sess["current_track"] = None
        sess["position_sec"] = 0.0
        sess["queue"] = []
    elif action == "next":
        q = sess.get("queue", [])
        if q:
            next_track = q.pop(0)
            sess["current_track"] = next_track
            sess["playing"] = True
            sess["position_sec"] = 0.0
        else:
            sess["playing"] = False
            sess["current_track"] = None
    elif action == "prev":
        # 简化：不维护历史栈，直接回到开头
        sess["position_sec"] = 0.0
    elif action == "volume":
        # 仅记录 value，不做实际音量控制（由客户端或消费方处理）
        sess["volume"] = req.value
    else:
        pass

    return {
        "status": "ok",
        "current_state": {
            "playing": sess["playing"],
            "current_track": sess.get("current_track"),
            "queue": sess.get("queue", []),
            "position_sec": sess.get("position_sec", 0.0),
        },
    }


@router.post("/music_queue")
async def music_queue(req: QueueRequest, _: str = Depends(require_music_key)):
    sess = get_session(req.session_id)
    action = req.action.lower()

    if action == "add":
        if req.item:
            sess.setdefault("queue", []).append(req.item)
    elif action == "clear":
        sess["queue"] = []
    elif action == "list":
        pass

    return {"queue": sess.get("queue", [])}


@router.get("/music_status")
async def music_status(session_id: str, _: str = Depends(require_music_key)):
    if not session_id:
        return {
            "playing": False,
            "current_track": None,
            "queue": [],
            "position_sec": 0.0,
        }
    sess = get_session(session_id)
    return {
        "playing": sess.get("playing", False),
        "current_track": sess.get("current_track"),
        "queue": sess.get("queue", []),
        "position_sec": sess.get("position_sec", 0.0),
    }
