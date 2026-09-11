#!/usr/bin/env python3
"""opcm_poc_mint_rooms.py — One-shot v0.3 POC：批量签发**隔离测试房**令牌（只派 `rust-worker-poc`）。

用途：给 Android Canary 一批短效、单房、受限的客户端 join token，让它不经生产 Session API 也能进
隔离 POC worker 的房。签发逻辑与 `opcm_device_sim.py` 已验证的完全一致；每房条目字段与生产
`apps/server/src/routes/device-session.ts` 的响应同名（server_url/room_name/identity/token/trace_id/
session_id/expires_at_ms/expected_agent_name），Android 可复用现有解析。

安全边界（不可放宽）：
- 只在持有 LiveKit API key/secret 的机器（64.90）运行；密钥只从 env 文件读 LIVEKIT_* 三个键，不打印。
- 输出文件 0600；`--public-out` 写去 token 的副本（只留 sha256 前 16 位指纹）用于归档/对账。
- token 只授 room_join/publish/subscribe/publish_data，房名钉死 `sn-<测试SN>-<签发秒>`；
  roomConfig.agents 只派 `--agent`（默认 rust-worker-poc），metadata 受信声明 input_mode=ordered_pcm。
- 测试 SN 默认 POCTEST0001（合成身份）。**禁止**传入现役设备 SN。
- 每房间隔 ≥1 s 铸造，房名尾秒即真实签发秒（worker `textproc::room_unix_secs`/job.rs 兜底口径都按秒解析）。
- 房名跨批次唯一：注册表 `<out 目录>/.minted_rooms.txt`（追加式）记录已铸房名；撞秒则等到下一秒，
  已存在即拒绝（2026-09-08 首铸实撞：两批同秒各签一个 token → 同房名两 trace，先进者建房后进者无派单）。

自检（对齐 device-session.ts assertTokenMatchesResponse）：解签 JWT 验证 sub/room/grants/agentName/
metadata(trace_id,session_id,input_mode)/exp 与条目一致，任一不符即整批不落盘。
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path

import jwt
from livekit import api
from livekit.api import RoomAgentDispatch, RoomConfiguration

ENV_FILES = ("/root/realtime-voice-agent/.env", "/root/realtime-voice-agent/poc-eou.env", "/root/rust-worker/rust-worker.env")
KEYS = ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")
TOPIC = "p003.audio.history.v1"
FORBIDDEN_SN_PREFIX = "BJP"  # 现役设备 SN 前缀；测试身份不得长这样


def load_env(files) -> dict[str, str]:
    env: dict[str, str] = {}
    for f in files:
        p = Path(f)
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip().removeprefix("export ").strip()
            if k in KEYS:
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                env[k] = v
    return env


def iso_ms(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _get(d: dict, *names):
    for n in names:
        if isinstance(d, dict) and n in d:
            return d[n]
    return None


def self_check(token: str, env: dict, entry: dict, agent: str) -> None:
    c = jwt.decode(token, env["LIVEKIT_API_SECRET"], algorithms=["HS256"], issuer=env["LIVEKIT_API_KEY"],
                   options={"require": ["exp", "sub", "iss"]})
    if c["sub"] != entry["identity"]:
        raise SystemExit(f"自检失败: sub={c['sub']} ≠ identity")
    v = c.get("video") or {}
    if _get(v, "room") != entry["room_name"]:
        raise SystemExit("自检失败: video.room ≠ room_name")
    for k in (("roomJoin", "room_join"), ("canPublish", "can_publish"), ("canSubscribe", "can_subscribe"), ("canPublishData", "can_publish_data")):
        if _get(v, *k) is not True:
            raise SystemExit(f"自检失败: grant {k[0]} 不为 true")
    for k in (("roomAdmin", "room_admin"), ("roomCreate", "room_create"), ("roomList", "room_list"), ("roomRecord", "room_record")):
        if _get(v, *k):
            raise SystemExit(f"自检失败: 越权 grant {k[0]}")
    rc = _get(c, "roomConfig", "room_config") or {}
    agents = _get(rc, "agents") or []
    if len(agents) != 1:
        raise SystemExit(f"自检失败: roomConfig.agents 数={len(agents)} ≠ 1")
    if _get(agents[0], "agentName", "agent_name") != agent:
        raise SystemExit("自检失败: agentName ≠ " + agent)
    m = json.loads(_get(agents[0], "metadata") or "{}")
    if m.get("trace_id") != entry["trace_id"] or m.get("session_id") != entry["session_id"] or m.get("input_mode") != "ordered_pcm":
        raise SystemExit("自检失败: metadata trace/session/input_mode 不一致")
    if (m.get("local_receipt") or "") != (entry.get("local_receipt") or ""):
        raise SystemExit("自检失败: metadata local_receipt 与条目不一致")
    if (m.get("oneshot_first_turn") or "") != (entry.get("oneshot_first_turn") or ""):
        raise SystemExit("自检失败: metadata oneshot_first_turn 与条目不一致")
    if int(c["exp"]) * 1000 != entry["expires_at_ms"]:
        raise SystemExit("自检失败: exp 与 expires_at_ms 不一致")


def mint_one(env: dict, sn: str, agent: str, ttl_s: int, local_receipt: str = "", first_turn: str = "") -> dict:
    now_s = int(time.time())
    room = f"sn-{sn}-{now_s}"
    identity = f"dev-{sn}"
    trace_id = str(uuid.uuid4())
    session_id = str(uuid.uuid4())
    issue_ts_ms = int(time.time() * 1000)
    md = {"trace_id": trace_id, "session_id": session_id, "issue_ts_ms": issue_ts_ms, "input_mode": "ordered_pcm"}
    if local_receipt:
        md["local_receipt"] = local_receipt  # 本地承接 v1：受信房级能力（worker 只认签发 metadata，不认设备自述）
    if first_turn:
        md["oneshot_first_turn"] = first_turn  # B23 产品首句 v1：首句代次终态后同房切回 RTC 多轮（缺省 = POC 一房一代）
    meta = json.dumps(md)
    token = (api.AccessToken(env["LIVEKIT_API_KEY"], env["LIVEKIT_API_SECRET"])
             .with_identity(identity)
             .with_grants(api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True, can_publish_data=True))
             .with_room_config(RoomConfiguration(agents=[RoomAgentDispatch(agent_name=agent, metadata=meta)]))
             .with_ttl(dt.timedelta(seconds=ttl_s))
             .to_jwt())
    exp_s = int(jwt.decode(token, options={"verify_signature": False})["exp"])
    entry = {
        "status": "ok",
        "server_url": env["LIVEKIT_URL"],
        "room_name": room,
        "identity": identity,
        "token": token,
        "trace_id": trace_id,
        "session_id": session_id,
        "issue_ts_ms": issue_ts_ms,
        "expires_at_ms": exp_s * 1000,
        "expires_at_utc": iso_ms(exp_s * 1000),
        "expected_agent_name": agent,
        "input_mode": "ordered_pcm",
        "local_receipt": local_receipt or None,
        "oneshot_first_turn": first_turn or None,
        "token_fingerprint": hashlib.sha256(token.encode()).hexdigest()[:16],
    }
    self_check(token, env, entry, agent)
    return entry


def write_0600(path: str, obj: dict) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fo:
        json.dump(obj, fo, ensure_ascii=False, indent=2)
        fo.write("\n")
    os.chmod(path, 0o600)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sn", default="POCTEST0001", help="合成测试 SN（禁止现役设备 SN）")
    ap.add_argument("--agent", default="rust-worker-poc")
    ap.add_argument("--count", type=int, default=12)
    ap.add_argument("--ttl-seconds", type=int, default=48 * 3600)
    ap.add_argument("--label", default="", help="批次标签，进文件头，便于对账")
    ap.add_argument("--out", required=True, help="含 token 的输出（0600）")
    ap.add_argument("--public-out", default="", help="去 token 副本（归档用）")
    ap.add_argument("--env-file", action="append", default=[], help="覆盖默认 env 文件列表（可多次）")
    ap.add_argument("--local-receipt", default="", help="签进 metadata 的本地承接版本（如 v1）；空 = 不签（旧合同房，worker 对声明恒回 ignored）")
    ap.add_argument("--first-turn", default="", help="B23：签进 metadata 的产品首句合同版本（如 v1）→ 首句终态后同房切 RTC；空 = POC 一房一代")
    a = ap.parse_args()

    if a.sn.upper().startswith(FORBIDDEN_SN_PREFIX) or len(a.sn) >= 20:
        print("拒绝: --sn 像现役设备 SN，测试身份必须是合成标识", file=sys.stderr)
        return 2
    if not (1 <= a.count <= 64) or not (30 <= a.ttl_seconds <= 7 * 24 * 3600):
        print("拒绝: count ∈ [1,64], ttl ∈ [30s, 7d]", file=sys.stderr)
        return 2
    env = load_env(a.env_file or ENV_FILES)
    for k in KEYS:
        if not env.get(k):
            print("missing env", k, file=sys.stderr)
            return 2

    registry = Path(a.out).resolve().parent / ".minted_rooms.txt"
    seen: set[str] = set()
    last_sec = 0
    if registry.exists():
        for line in registry.read_text(encoding="utf-8").splitlines():
            name = line.split()[0] if line.strip() else ""
            if name:
                seen.add(name)
                tail = name.rsplit("-", 1)[-1]
                if tail.isdigit():
                    last_sec = max(last_sec, int(tail))
    rooms: list[dict] = []
    for i in range(a.count):
        # 房名尾秒=真实签发秒；与注册表里最后一秒及本批上一房都必须严格递增
        while int(time.time()) <= last_sec:
            time.sleep(0.05)
        e = mint_one(env, a.sn, a.agent, a.ttl_seconds, a.local_receipt, a.first_turn)
        if e["room_name"] in seen:
            print("拒绝: 房名已在注册表/本批出现", e["room_name"], file=sys.stderr)
            return 3
        seen.add(e["room_name"])
        last_sec = int(e["room_name"].rsplit("-", 1)[-1])
        with open(registry, "a", encoding="utf-8") as reg:
            reg.write(f"{e['room_name']} {a.label or '-'} {e['trace_id']} exp={e['expires_at_utc']}\n")
        os.chmod(registry, 0o600)
        rooms.append(e)
        print(f"minted {i:02d} room={e['room_name']} trace={e['trace_id']} exp={e['expires_at_utc']} fp={e['token_fingerprint']}", flush=True)

    issued_ms = int(time.time() * 1000)
    head = {
        "schema": "p003.oneshot.poc-rooms.v1",
        "label": a.label,
        "issued_at_ms": issued_ms,
        "issued_at_utc": iso_ms(issued_ms),
        "issuer": "cc/opcm_poc_mint_rooms.py",
        "purpose": "One-shot v0.3 隔离 POC：只派 rust-worker-poc；不进生产 worker/大脑/设备记忆；一房一次不复用",
        "server_url": env["LIVEKIT_URL"],
        "expected_agent_name": a.agent,
        "sn": a.sn,
        "identity": f"dev-{a.sn}",
        "input_mode": "ordered_pcm",
        "local_receipt": a.local_receipt or None,
        "oneshot_first_turn": a.first_turn or None,
        "worker_capabilities": (["android_local_receipt_v1"] if a.local_receipt == "v1" else []) + (["oneshot_first_turn_v1"] if a.first_turn == "v1" else []),
        "history_topic": TOPIC,
        "ttl_seconds": a.ttl_seconds,
        "count": len(rooms),
        "rules": [
            "一房一次：每次实验取一个未用条目，进房前不改任何字段；失败关房换下一条，不复用",
            "OPCM begin/chunk/end/cancel 头里的 trace_id/session_id 必须等于该条目的 trace_id/session_id（worker 只对撞 trace_id，session_id 记入证据）",
            "identity 必须用条目的 identity（dev-<SN>）；worker 只收该身份在 history_topic 上的包",
            "必须发布麦克风轨（与生产一致）：worker 用户轨订到后才起管线、才发 session.input_ready；ordered_pcm 房里该轨的 RTC 音频不进识别",
            "queued_next 只是 worker ASR 队列水位，不是 ASR ready/成功；终局只看 result.status",
        ],
        "rooms": rooms,
    }
    if a.local_receipt == "v1":
        head["rules"] += [
            "本地承接 v1：begin 头可带 local_receipt=true；只有 ack 回显 local_receipt=accepted 才播本地承接短语（ignored=退回旧路径，worker 照播垫句）",
            "本地承接 v1：本地短语播完发同 topic t=receipt_done（头同 begin 身份字段，可带 played_ms，空 body）；worker 正文门在 receipt_done 或 end 到达+3000ms 放行",
        ]
    write_0600(a.out, head)
    print(f"wrote {a.out} (0600) rooms={len(rooms)}", flush=True)
    if a.public_out:
        pub = dict(head)
        pub["rooms"] = [{k: v for k, v in r.items() if k != "token"} for r in rooms]
        pub["note"] = "去 token 副本；token_fingerprint=sha256(token) 前 16 位，仅供对账"
        with open(a.public_out, "w", encoding="utf-8") as fo:
            json.dump(pub, fo, ensure_ascii=False, indent=2)
            fo.write("\n")
        print(f"wrote {a.public_out} (public, no tokens)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
