"""会话状态管理（进程内存）

MVP 阶段说明：
- 状态不持久化，重启即丢失。
- 这是可接受的已知简化，后续如需持久化再引入数据库/Redis。
- 不同 session_id 完全隔离（支持 MyJavis roomId + realtime-voice-agent room name 并发）。
"""

from typing import Any, Dict

# 内存字典：session_id -> state
# state 结构：
# {
#   "queue": list[dict],          # 队列中的 track 信息
#   "current_track": dict | None, # 当前播放曲目 {id, source, title, artist, duration_sec, stream_url?}
#   "playing": bool,
#   "position_sec": float,
# }
_sessions: Dict[str, Dict[str, Any]] = {}


def get_session(session_id: str) -> Dict[str, Any]:
    if session_id not in _sessions:
        _sessions[session_id] = {
            "queue": [],
            "current_track": None,
            "playing": False,
            "position_sec": 0.0,
        }
    return _sessions[session_id]


def reset_session(session_id: str) -> None:
    if session_id in _sessions:
        del _sessions[session_id]


def get_all_sessions() -> Dict[str, Dict[str, Any]]:
    """仅用于 admin/report 等内部诊断"""
    return dict(_sessions)
