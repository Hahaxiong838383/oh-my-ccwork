#!/usr/bin/env python3
"""热词发布通道(2026-08-18,运营台「热词管理」P0;forced-command 唯一入口)。

stdin 单行 JSON,stdout 单行 JSON 回执(stderr 才是人读日志):
  {"action":"status"}   → env 文件值 + 进程 environ 生效值 + 近90s活动行数
  {"action":"fillers"}  → /opt/voice-agent/fillers-colleague/manifest.json 原文透传
  {"action":"apply_fillers","sn":..,"manifest":{fname:{bucket,text,duration_ms,chars,sha256}},"files":{fname:base64}}
      → 校验(桶白名单/条数/RIFF/sha 对撞/容量) → 写 fillers-persona/<SN>.staging → 原子 rename
      → 不碰 worker(F2 前无消费;F2 上线后 worker 按 SN 目录热载)。barge 桶结构性拒收(川哥拍板)。
  {"action":"apply","words":{三键任意子集},"force":bool,"drill":"corrupt"?}
      → 快照两 env → 原子写 → stop → 等 sidecar 清零 → start → 健康自检
      → 失败自动回滚快照再拉起 → 回执
  赛马配置（2026-09-03，运营台「🏇 赛马」，同一把 key 复用）:
  {"action":"race_get"}                          → 主路只读键 + 兜底可写键(文件值/进程值,key 只回 hint/len)
  {"action":"race_set","values":{白名单键},"force"} → 快照 → 写 → 纪律重启 → 健康自检/回滚(同 apply)
  {"action":"race_stats","hours":48}             → journal「llm race won」统计(胜负/首字分位/兜底胜出分布)
  {"action":"race_bench","models":[..],"runs":3,"system":"..","user_texts":[..]}
      → 用 env 里的兜底 base+key(key 绝不从载荷来)对候选模型做流式首字基准,总预算 140s
  语音链路配置（2026-09-03 晚,运营台「🎙 语音链路」,同一把 key 复用;川哥:供应商/方案/密钥后台手动配,不再找 cc 改 env）:
  {"action":"voice_get"}                         → VOICE_KEYS 三视图:rust(覆盖层 rust-worker.env)/base(python 线 .env,只读参考)/proc(进程生效);密钥只回 hint/len
  {"action":"voice_set","values":{白名单键},"force"} → 只写 rust-worker.env(覆盖层,EnvironmentFile 末位赢;绝不碰 .env/python 线)
      → 快照 → 原子写 → 纪律重启 → 健康自检/回滚(同 apply);TTS_PROVIDER=xfyun 缺凭据时 worker 启动 bail → 自检失败 → 自动回滚

安全纪律:
- 键白名单只认三热词键;值字符白名单 [中文 A-Za-z0-9 ,](防 env 注入换行/引号)。
- VOLC_ASR_HOTWORDS 同步写 poc-eou.env(python 线共享,防两处漂移),但**绝不重启
  python 线**(voice-worker 属禁碰红线),回执标注 python 线待其自然重启生效。
- 等 sidecar 清零:ps 全量输出进程内过滤(观察者=python3 apply_hotwords.py,cmdline
  不含 eot_sidecar 串,不自匹配;见 feedback_ssh_pkill_pgrep_self_match §五),30s 上限。
- 健康自检:is-active + journal 启动锚 registered worker;失败即回滚,回滚后再检。
- drill=corrupt(仅演练):写完合法词表后追加 VAD_MODEL_PATH=/nonexistent-drill,
  走 main.rs vad::preload fail-fast 真实启动失败路径,验证自动回滚安全网非空。
"""
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime

RUST_ENV = "/root/rust-worker/rust-worker.env"
POC_ENV = "/root/realtime-voice-agent/poc-eou.env"
MANIFEST = "/opt/voice-agent/fillers-colleague/manifest.json"
DEVICE_ALIASES = "/root/rust-worker/device_aliases.tsv"
UNIT = "voice-worker-rust"
# 2026-09-14:+BACKCHANNEL_HOTWORDS(播放中附和词,worker 未发版前发布=只落 env,旧二进制忽略该键)
ALLOW_KEYS = ("INTERRUPT_HOTWORDS", "VOLC_ASR_HOTWORDS", "EXIT_SWALLOW_HOTWORDS", "P003_DEVICE_ASR_HOTWORDS", "BACKCHANNEL_HOTWORDS")
# poc-eou.env(python 线)只持有这一个热词键——多写会污染它的 env
POC_KEYS = ("VOLC_ASR_HOTWORDS",)
VALUE_RE = re.compile(r"^[一-鿿A-Za-z0-9, ]+$")
BAK_KEEP = 10
DRILL_LINE = "VAD_MODEL_PATH=/nonexistent-drill"


def log(msg: str) -> None:
    print(f"[apply-hotwords] {msg}", file=sys.stderr, flush=True)


def run(cmd: list, timeout: int = 20) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def read_lines(path: str) -> list:
    with open(path, encoding="utf-8") as f:
        return f.read().splitlines()


def set_key(lines: list, key: str, value: str) -> list:
    out, hit = [], False
    for ln in lines:
        if ln.startswith(f"{key}="):
            out.append(f"{key}={value}")
            hit = True
        else:
            out.append(ln)
    if not hit:
        out.append(f"{key}={value}")
    return out


def atomic_write(path: str, lines: list) -> None:
    tmp = f"{path}.tmp-hotwords"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, path)


def env_values(path: str) -> dict:
    vals = {}
    for ln in read_lines(path):
        for k in ALLOW_KEYS:
            if ln.startswith(f"{k}="):
                vals[k] = ln[len(k) + 1 :]
    return vals


def main_pid() -> int:
    r = run(["systemctl", "show", UNIT, "-p", "MainPID", "--value"])
    try:
        return int(r.stdout.strip())
    except ValueError:
        return 0


def proc_values() -> dict:
    pid = main_pid()
    if pid <= 0:
        return {}
    try:
        raw = open(f"/proc/{pid}/environ", "rb").read().decode("utf-8", "replace")
    except OSError:
        return {}
    vals = {}
    for kv in raw.split("\0"):
        for k in ALLOW_KEYS:
            if kv.startswith(f"{k}="):
                vals[k] = kv[len(k) + 1 :]
    return vals


def recent_activity() -> int:
    """近 90s 非心跳活动行(TOCTOU 二道安静检查;主判据在 server 侧 LiveKit rooms)。"""
    r = run(["journalctl", "-u", UNIT, "--since", "-90s", "--no-pager"], timeout=15)
    n = 0
    for ln in r.stdout.splitlines():
        if "job rss" in ln:
            continue
        if re.search(r"job_assignment_received|user_track_subscribed|tts synth|input_loop_started", ln):
            n += 1
    return n


def sidecar_count() -> int:
    """ps 全量输出进程内过滤:观察者不在被观察集合(自身 cmdline 无该串)。"""
    r = run(["ps", "-eo", "pid,args"])
    return sum(1 for ln in r.stdout.splitlines() if "eot_sidecar.py" in ln and "ps -eo" not in ln)


def is_active() -> bool:
    return run(["systemctl", "is-active", UNIT]).stdout.strip() == "active"


def health(since_epoch: float) -> tuple:
    """启动锚:is-active 且 journal 在 start 之后出现 registered worker 且无 panic。"""
    if not is_active():
        return False, "unit 非 active"
    since = datetime.fromtimestamp(since_epoch).strftime("%Y-%m-%d %H:%M:%S")
    r = run(["journalctl", "-u", UNIT, "--since", since, "--no-pager"], timeout=15)
    if "panic" in r.stdout:
        return False, "journal 出现 panic"
    if "registered worker" not in r.stdout:
        return False, "journal 无 registered worker 锚"
    return True, "ok"


def stop_drain_start() -> tuple:
    run(["systemctl", "stop", UNIT], timeout=30)
    deadline = time.time() + 30
    while time.time() < deadline:
        if sidecar_count() == 0:
            break
        time.sleep(1)
    else:
        return False, "sidecar 30s 未清零"
    t_start = time.time()
    run(["systemctl", "start", UNIT], timeout=30)
    time.sleep(8)
    ok, why = health(t_start)
    return ok, why


def do_apply(req: dict) -> dict:
    words = req.get("words") or {}
    if not isinstance(words, dict) or not words:
        return {"ok": False, "error": "words 为空"}
    for k, v in words.items():
        if k not in ALLOW_KEYS:
            return {"ok": False, "error": f"键不在白名单: {k}"}
        if not isinstance(v, str) or not VALUE_RE.fullmatch(v):
            return {"ok": False, "error": f"{k} 值含白名单外字符(只允许中文/字母数字/逗号/空格)"}
    if not req.get("force") and (n := recent_activity()) > 0:
        return {"ok": False, "error": f"近 90s 有 {n} 条活动行(疑似通话中),拒绝重启;确认后带 force 重试"}

    ts = time.strftime("%Y%m%d-%H%M%S")
    snaps = {}
    for path in (RUST_ENV, POC_ENV):
        bak = f"{path}.bak-hotwords-{ts}"
        with open(path, encoding="utf-8") as src, open(bak, "w", encoding="utf-8") as dst:
            dst.write(src.read())
        snaps[path] = bak
    prune_backups()

    rust_lines = read_lines(RUST_ENV)
    for k, v in words.items():
        rust_lines = set_key(rust_lines, k, v)
    if req.get("drill") == "corrupt":
        log("DRILL: 注入 VAD 坏路径(真实 fail-fast 启动失败)")
        rust_lines = set_key(rust_lines, "VAD_MODEL_PATH", "/nonexistent-drill")
    atomic_write(RUST_ENV, rust_lines)

    poc_synced = []
    poc_lines = read_lines(POC_ENV)
    for k in POC_KEYS:
        if k in words:
            poc_lines = set_key(poc_lines, k, words[k])
            poc_synced.append(k)
    if poc_synced:
        atomic_write(POC_ENV, poc_lines)

    ok, why = stop_drain_start()
    if ok:
        return {
            "ok": True, "applied": sorted(words.keys()), "backup": snaps[RUST_ENV],
            "poc_synced": poc_synced, "poc_note": "python 线不重启,待其自然重启生效",
            "proc": proc_values(),
        }

    # ── 安全网:回滚快照再拉起 ──
    log(f"健康自检失败({why}),回滚快照")
    for path, bak in snaps.items():
        with open(bak, encoding="utf-8") as src:
            content = src.read()
        tmp = f"{path}.tmp-rollback"
        with open(tmp, "w", encoding="utf-8") as dst:
            dst.write(content)
        os.replace(tmp, path)
    run(["systemctl", "stop", UNIT], timeout=30)
    time.sleep(2)
    t_start = time.time()
    run(["systemctl", "start", UNIT], timeout=30)
    time.sleep(8)
    ok2, why2 = health(t_start)
    return {
        "ok": False, "rolled_back": True, "reason": why,
        "recovered": ok2, "recover_detail": why2, "backup": snaps[RUST_ENV],
        "proc": proc_values(),
    }


PERSONA_ROOT = "/opt/voice-agent/fillers-persona"
# barge 结构性排除（2026-08-26 川哥拍板：打断承接是功能音，永不人格化）
FILLER_ALLOWED_BUCKETS = {"greet", "gen", "task", "thanks", "emo_neg", "emo_pos", "story", "ask", "opinion"}
FILLER_MIN_PER_BUCKET, FILLER_MAX_PER_BUCKET = 6, 12
FILLER_MAX_FILE = 300 * 1024
FILLER_MAX_TOTAL = 10 * 1024 * 1024
SN_RE = re.compile(r"^[A-Z0-9]{10,24}$")
FNAME_RE = re.compile(r"^p_[a-z_]+_\d{2}\.wav$")


def do_apply_fillers(req: dict) -> dict:
    import base64
    import hashlib

    sn = str(req.get("sn", ""))
    if not SN_RE.fullmatch(sn):
        return {"ok": False, "error": f"非法 sn: {sn!r}"}
    manifest = req.get("manifest")
    files = req.get("files")
    if not isinstance(manifest, dict) or not isinstance(files, dict) or not manifest:
        return {"ok": False, "error": "manifest/files 缺失或为空"}
    if set(manifest.keys()) != set(files.keys()):
        return {"ok": False, "error": "manifest 与 files 键集不一致"}

    buckets: dict = {}
    blobs: dict = {}
    total = 0
    for fname, meta in manifest.items():
        if not FNAME_RE.fullmatch(str(fname)):
            return {"ok": False, "error": f"非法文件名: {fname!r}"}
        if not isinstance(meta, dict):
            return {"ok": False, "error": f"{fname} meta 非对象"}
        bucket = str(meta.get("bucket", ""))
        if bucket not in FILLER_ALLOWED_BUCKETS:
            return {"ok": False, "error": f"{fname} 桶不合法/被禁: {bucket!r}（barge 永不人格化）"}
        try:
            blob = base64.b64decode(files[fname], validate=True)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"{fname} base64 解码失败: {e}"}
        if len(blob) > FILLER_MAX_FILE:
            return {"ok": False, "error": f"{fname} 超单文件门 {len(blob)}B"}
        if blob[:4] != b"RIFF" or blob[8:12] != b"WAVE":
            return {"ok": False, "error": f"{fname} 非 WAV(RIFF 头不符)"}
        want_sha = str(meta.get("sha256", ""))
        got_sha = hashlib.sha256(blob).hexdigest()
        if got_sha != want_sha:
            return {"ok": False, "error": f"{fname} sha 对撞失败"}
        total += len(blob)
        buckets[bucket] = buckets.get(bucket, 0) + 1
        blobs[fname] = blob
    if total > FILLER_MAX_TOTAL:
        return {"ok": False, "error": f"总量超门 {total}B"}
    for bucket, n in buckets.items():
        if not (FILLER_MIN_PER_BUCKET <= n <= FILLER_MAX_PER_BUCKET):
            return {"ok": False, "error": f"桶 {bucket} 条数 {n} 不在 {FILLER_MIN_PER_BUCKET}..{FILLER_MAX_PER_BUCKET}"}

    staging = os.path.join(PERSONA_ROOT, f".staging-{sn}")
    final = os.path.join(PERSONA_ROOT, sn)
    os.makedirs(PERSONA_ROOT, exist_ok=True)
    if os.path.exists(staging):
        import shutil

        shutil.rmtree(staging)
    os.makedirs(staging)
    for fname, blob in blobs.items():
        with open(os.path.join(staging, fname), "wb") as f:
            f.write(blob)
    with open(os.path.join(staging, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    if os.path.exists(final):
        bak = f"{final}.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        os.rename(final, bak)
        log(f"旧套已备份 {bak}")
        # 只留最近 2 份 bak
        baks = sorted(d for d in os.listdir(PERSONA_ROOT) if d.startswith(f"{sn}.bak-"))
        for old in baks[:-2]:
            import shutil

            shutil.rmtree(os.path.join(PERSONA_ROOT, old))
    os.rename(staging, final)
    log(f"apply_fillers sn={sn} buckets={buckets} total={total}B → {final}")
    return {"ok": True, "sn": sn, "buckets": buckets, "total_bytes": total, "dir": final}


# ── 赛马配置通道（2026-09-03）──────────────────────────────────────────────────
RACE_RO_KEYS = ("LLM_BASE_URL", "LLM_MODEL", "LLM_THINKING")
RACE_RW = {
    "LLM_FALLBACK_BASE_URL": re.compile(r"^https://[A-Za-z0-9.-]+(?:/[A-Za-z0-9._/-]*)?$"),
    "LLM_FALLBACK_MODEL": re.compile(r"^[A-Za-z0-9._-]{2,64}$"),
    "LLM_FALLBACK_THINKING": re.compile(r"^(?:disabled|enabled|adaptive|off)$"),
    "LLM_FALLBACK_API_KEY": re.compile(r"^[A-Za-z0-9._-]{16,128}$"),
    "LLM_RACE_MAIN_GRACE_MS": re.compile(r"^\d{3,4}$"),
    # 单行;禁引号/反引号/$/反斜杠(env 注入面);≤1200 字
    "AGENT_INSTRUCTIONS": re.compile(r"^[^\r\n\"'`$\\]{0,1200}$"),
}
RACE_SECRET = ("LLM_FALLBACK_API_KEY",)
BENCH_HOST_ALLOW = ("ark.cn-beijing.volces.com",)
BENCH_TIME_BUDGET = 140.0
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _mask(k: str, v: str):
    if k in RACE_SECRET:
        return {"set": bool(v), "hint": (v[:8] + "…") if v else "", "len": len(v)}
    return v


def _race_values(kvs) -> dict:
    vals = {}
    keys = RACE_RO_KEYS + tuple(RACE_RW.keys())
    for kv in kvs:
        for k in keys:
            if kv.startswith(f"{k}="):
                vals[k] = _mask(k, kv[len(k) + 1 :])
    return vals


def race_proc_values() -> dict:
    pid = main_pid()
    if pid <= 0:
        return {}
    try:
        raw = open(f"/proc/{pid}/environ", "rb").read().decode("utf-8", "replace")
    except OSError:
        return {}
    return _race_values(raw.split("\0"))


def do_race_get() -> dict:
    return {
        "ok": True, "file": _race_values(read_lines(RUST_ENV)), "proc": race_proc_values(),
        "unit_active": is_active(), "main_pid": main_pid(), "recent_activity": recent_activity(),
        "ts": int(time.time()),
    }


def do_race_set(req: dict) -> dict:
    values = req.get("values") or {}
    if not isinstance(values, dict) or not values:
        return {"ok": False, "error": "values 为空"}
    for k, v in values.items():
        if k not in RACE_RW:
            return {"ok": False, "error": f"键不在白名单: {k}"}
        if not isinstance(v, str) or not RACE_RW[k].fullmatch(v):
            return {"ok": False, "error": f"{k} 值不合法"}
    if "LLM_RACE_MAIN_GRACE_MS" in values and not (200 <= int(values["LLM_RACE_MAIN_GRACE_MS"]) <= 5000):
        return {"ok": False, "error": "LLM_RACE_MAIN_GRACE_MS 须在 200~5000"}
    if not req.get("force") and (n := recent_activity()) > 0:
        return {"ok": False, "error": f"近 90s 有 {n} 条活动行(疑似通话中),拒绝重启;确认后带 force 重试"}
    ts = time.strftime("%Y%m%d-%H%M%S")
    bak = f"{RUST_ENV}.bak-race-{ts}"
    with open(RUST_ENV, encoding="utf-8") as src, open(bak, "w", encoding="utf-8") as dst:
        dst.write(src.read())
    lines = read_lines(RUST_ENV)
    for k, v in values.items():
        lines = set_key(lines, k, v)
    atomic_write(RUST_ENV, lines)
    ok, why = stop_drain_start()
    if ok:
        return {"ok": True, "applied": sorted(values.keys()), "backup": bak, "proc": race_proc_values()}
    log(f"赛马配置健康自检失败({why}),回滚快照")
    with open(bak, encoding="utf-8") as src:
        content = src.read()
    tmp = f"{RUST_ENV}.tmp-rollback"
    with open(tmp, "w", encoding="utf-8") as dst:
        dst.write(content)
    os.replace(tmp, RUST_ENV)
    run(["systemctl", "stop", UNIT], timeout=30)
    time.sleep(2)
    t_start = time.time()
    run(["systemctl", "start", UNIT], timeout=30)
    time.sleep(8)
    ok2, why2 = health(t_start)
    return {
        "ok": False, "rolled_back": True, "reason": why, "recovered": ok2, "recover_detail": why2,
        "backup": bak, "proc": race_proc_values(),
    }


# ── 语音链路配置(2026-09-03)：键表与 server 侧 VOICE_RW 同形(后端为真防线,这里是最后一道)。
# 值正则刻意窄:env 文件按行解析,任何换行/引号/$ 都可能变成注入;范围门在 server 也有一份。
VOICE_KEYS = {
    "VOLC_ASR_RESOURCE_ID": re.compile(r"^volc\.[a-z0-9_.]{3,60}$"),
    "VOLC_ASR_END_WINDOW_MS": re.compile(r"^\d{2,4}$"),
    "VOLC_ASR_ENABLE_DDC": re.compile(r"^[01]$"),
    "VOLC_PREFLIGHT_ENABLED": re.compile(r"^[01]$"),
    "VOLC_ASR_NONSTREAM_ENABLED": re.compile(r"^[01]$"),
    "VOLC_ASR_NONSTREAM_CANARY_SN": re.compile(r"^(?:[A-Za-z0-9]{6,40}(?:,[A-Za-z0-9]{6,40})*)?$"),
    "VOLC_ASR_BOOSTING_TABLE_ID": re.compile(r"^(?:[A-Za-z0-9-]{8,64})?$"),
    "VOLC_APP_ID": re.compile(r"^\d{6,16}$"),
    "VOLC_ACCESS_TOKEN": re.compile(r"^[A-Za-z0-9._-]{16,128}$"),
    "VOLC_ASR_API_KEY": re.compile(r"^[A-Za-z0-9._-]{16,128}$"),
    "TTS_PROVIDER": re.compile(r"^(?:volc|xfyun)$"),
    "VOLC_TTS_RESOURCE_ID": re.compile(r"^[A-Za-z0-9._-]{3,60}$"),
    "VOLC_TTS_SPEAKER": re.compile(r"^[A-Za-z0-9_]{4,80}$"),
    "VOLC_TTS_SPEED": re.compile(r"^\d(?:\.\d{1,2})?$"),
    "TTS_POOL_ENABLED": re.compile(r"^[01]$"),
    "TTS_MIN_SENTENCE_LEN": re.compile(r"^\d{1,2}$"),
    "XFYUN_TTS_VCN": re.compile(r"^[A-Za-z0-9_]{3,64}$"),
    "XFYUN_TTS_SPEED": re.compile(r"^\d{1,3}$"),
    "XFYUN_TTS_ORAL_LEVEL": re.compile(r"^(?:high|mid|low)$"),
    "XFYUN_TTS_PRECONNECT": re.compile(r"^[01]$"),
    "XFYUN_TTS_APP_ID": re.compile(r"^[A-Za-z0-9]{6,16}$"),
    "XFYUN_TTS_API_KEY": re.compile(r"^[A-Za-z0-9]{16,64}$"),
    "XFYUN_TTS_API_SECRET": re.compile(r"^[A-Za-z0-9]{16,64}$"),
}
VOICE_SECRET = ("VOLC_APP_ID", "VOLC_ACCESS_TOKEN", "VOLC_ASR_API_KEY", "XFYUN_TTS_APP_ID", "XFYUN_TTS_API_KEY", "XFYUN_TTS_API_SECRET")
VOICE_RANGES = {"VOLC_ASR_END_WINDOW_MS": (100, 2000), "TTS_MIN_SENTENCE_LEN": (2, 40), "XFYUN_TTS_SPEED": (0, 100)}
BASE_ENV = "/root/realtime-voice-agent/.env"  # python 线共享,只读参考,绝不写


def _voice_mask(k: str, v: str):
    if k in VOICE_SECRET:
        return {"set": bool(v), "hint": (v[:4] + "…" + v[-2:]) if len(v) >= 8 else ("…" if v else ""), "len": len(v)}
    return v


def _voice_values(kvs) -> dict:
    vals = {}
    for kv in kvs:
        for k in VOICE_KEYS:
            if kv.startswith(f"{k}="):
                vals[k] = _voice_mask(k, kv[len(k) + 1 :])
    return vals


def voice_proc_values() -> dict:
    pid = main_pid()
    if pid <= 0:
        return {}
    try:
        raw = open(f"/proc/{pid}/environ", "rb").read().decode("utf-8", "replace")
    except OSError:
        return {}
    return _voice_values(raw.split("\0"))


def voice_validate(values) -> str:
    """返回错误串;空串=通过。密钥空值由 server 层过滤,这里空密钥也拒(防误清空)。"""
    if not isinstance(values, dict) or not values:
        return "values 为空"
    for k, v in values.items():
        if k not in VOICE_KEYS:
            return f"键不在白名单: {k}"
        if not isinstance(v, str) or not VOICE_KEYS[k].fullmatch(v):
            return f"{k} 值不合法"
        if k in VOICE_RANGES:
            lo, hi = VOICE_RANGES[k]
            if not (lo <= int(v) <= hi):
                return f"{k} 须在 {lo}~{hi}"
        if k == "VOLC_TTS_SPEED" and not (0.5 <= float(v) <= 2.0):
            return "VOLC_TTS_SPEED 须在 0.5~2.0"
    return ""


def _prune_tagged(tag: str) -> None:
    d, prefix = os.path.dirname(RUST_ENV), os.path.basename(RUST_ENV)
    baks = sorted(f for f in os.listdir(d) if f.startswith(f"{prefix}.bak-{tag}-"))
    for old in baks[:-BAK_KEEP]:
        os.unlink(os.path.join(d, old))


def apply_env_and_restart(values: dict, tag: str, view) -> dict:
    """通用:快照 rust-worker.env → 写键 → 纪律重启 → 健康自检;失败回滚快照再拉起。view()=回执用的进程视图。"""
    ts = time.strftime("%Y%m%d-%H%M%S")
    bak = f"{RUST_ENV}.bak-{tag}-{ts}"
    with open(RUST_ENV, encoding="utf-8") as src, open(bak, "w", encoding="utf-8") as dst:
        dst.write(src.read())
    _prune_tagged(tag)
    lines = read_lines(RUST_ENV)
    for k, v in values.items():
        lines = set_key(lines, k, v)
    atomic_write(RUST_ENV, lines)
    ok, why = stop_drain_start()
    if ok:
        return {"ok": True, "applied": sorted(values.keys()), "backup": bak, "proc": view()}
    log(f"{tag} 健康自检失败({why}),回滚快照")
    with open(bak, encoding="utf-8") as src:
        content = src.read()
    tmp = f"{RUST_ENV}.tmp-rollback"
    with open(tmp, "w", encoding="utf-8") as dst:
        dst.write(content)
    os.replace(tmp, RUST_ENV)
    run(["systemctl", "stop", UNIT], timeout=30)
    time.sleep(2)
    t_start = time.time()
    run(["systemctl", "start", UNIT], timeout=30)
    time.sleep(8)
    ok2, why2 = health(t_start)
    return {
        "ok": False, "rolled_back": True, "reason": why, "recovered": ok2, "recover_detail": why2,
        "backup": bak, "proc": view(),
    }


def do_voice_get() -> dict:
    try:
        base = _voice_values(read_lines(BASE_ENV))
    except OSError:
        base = {}
    return {
        "ok": True, "rust": _voice_values(read_lines(RUST_ENV)), "base": base, "proc": voice_proc_values(),
        "unit_active": is_active(), "main_pid": main_pid(), "recent_activity": recent_activity(),
        "ts": int(time.time()),
    }


def do_voice_set(req: dict) -> dict:
    values = req.get("values") or {}
    err = voice_validate(values)
    if err:
        return {"ok": False, "error": err}
    if not req.get("force") and (n := recent_activity()) > 0:
        return {"ok": False, "error": f"近 90s 有 {n} 条活动行(疑似通话中),拒绝重启;确认后带 force 重试"}
    return apply_env_and_restart(values, "voice", voice_proc_values)


def do_race_stats(req: dict) -> dict:
    try:
        hours = int(req.get("hours", 48))
    except (TypeError, ValueError):
        hours = 48
    hours = max(1, min(hours, 168))
    r = run(["journalctl", "-u", UNIT, "--since", f"-{hours}h", "--no-pager"], timeout=30)
    main_n = fb_n = 0
    ttfts, fb_ttfts = [], []
    for ln in r.stdout.splitlines():
        if "llm race won" not in ln:
            continue
        ln = ANSI_RE.sub("", ln)
        m = re.search(r'won_by="?(main|fallback)"?', ln)
        t = re.search(r"race_ttft_ms=(\d+)", ln)
        if not m:
            continue
        v = int(t.group(1)) if t else None
        if m.group(1) == "main":
            main_n += 1
        else:
            fb_n += 1
            if v is not None:
                fb_ttfts.append(v)
        if v is not None:
            ttfts.append(v)
    ttfts.sort()
    fb_ttfts.sort()

    def q(p: float):
        return ttfts[min(len(ttfts) - 1, int(len(ttfts) * p))] if ttfts else None

    return {
        "ok": True, "hours": hours, "n": main_n + fb_n, "won_main": main_n, "won_fallback": fb_n,
        "p50": q(0.5), "p90": q(0.9), "p95": q(0.95), "max": ttfts[-1] if ttfts else None,
        "fallback_won_ttft": fb_ttfts[:50],
    }


def _bench_call(base: str, key: str, model: str, system: str, user: str, thinking, timeout: int = 40) -> dict:
    import urllib.error
    import urllib.request
    msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
    body = {"model": model, "stream": True, "max_tokens": 80, "temperature": 0.7, "messages": msgs}
    if thinking:
        body["thinking"] = {"type": thinking}
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions", data=json.dumps(body, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    t0 = time.time()
    ttft = None
    text = ""
    reasoning = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    j = json.loads(data)
                except json.JSONDecodeError:
                    continue
                d = (j.get("choices") or [{}])[0].get("delta") or {}
                if d.get("reasoning_content"):
                    reasoning += len(d["reasoning_content"])
                c = d.get("content")
                if c:
                    if ttft is None:
                        ttft = round((time.time() - t0) * 1000)
                    text += c
        return {
            "status": 200, "ttft_ms": ttft, "total_ms": round((time.time() - t0) * 1000), "chars": len(text),
            "reasoning_chars": reasoning, "text": text.replace("\n", " ")[:40],
        }
    except urllib.error.HTTPError as e:
        return {"status": e.code, "err": e.read().decode("utf-8", "ignore")[:160]}
    except Exception as e:  # noqa: BLE001
        return {"status": "EXC", "err": str(e)[:120]}


def do_race_bench(req: dict) -> dict:
    models = req.get("models") or []
    if not isinstance(models, list) or not (1 <= len(models) <= 8):
        return {"ok": False, "error": "models 须为 1~8 个"}
    for m in models:
        if not isinstance(m, str) or not RACE_RW["LLM_FALLBACK_MODEL"].fullmatch(m):
            return {"ok": False, "error": f"模型名不合法: {m}"}
    try:
        runs = int(req.get("runs", 3))
    except (TypeError, ValueError):
        runs = 3
    runs = max(1, min(runs, 5))
    system = req.get("system") or ""
    if not isinstance(system, str) or len(system) > 12000:
        return {"ok": False, "error": "system 过长(>12000)"}
    user_texts = req.get("user_texts") or ["太亮了"]
    if not isinstance(user_texts, list) or not (1 <= len(user_texts) <= 3) or any(
        (not isinstance(u, str)) or not (1 <= len(u) <= 60) for u in user_texts
    ):
        return {"ok": False, "error": "user_texts 须 1~3 条、每条 1~60 字"}
    env = {}
    for ln in read_lines(RUST_ENV):
        for k in ("LLM_FALLBACK_BASE_URL", "LLM_FALLBACK_API_KEY"):
            if ln.startswith(f"{k}="):
                env[k] = ln[len(k) + 1 :]
    base = req.get("base") or env.get("LLM_FALLBACK_BASE_URL", "")
    if not isinstance(base, str) or not RACE_RW["LLM_FALLBACK_BASE_URL"].fullmatch(base) or not any(
        base.startswith(f"https://{h}/") for h in BENCH_HOST_ALLOW
    ):
        return {"ok": False, "error": "base 不在允许主机内(仅 ark.cn-beijing.volces.com)"}
    key = env.get("LLM_FALLBACK_API_KEY", "")
    if not key:
        return {"ok": False, "error": "env 无 LLM_FALLBACK_API_KEY"}
    thinking = req.get("thinking", "disabled")
    if thinking not in ("disabled", "enabled"):
        thinking = "disabled"
    t_begin = time.time()
    rows = []
    truncated = False
    for u in user_texts:
        for m in models:
            for i in range(runs):
                if time.time() - t_begin > BENCH_TIME_BUDGET:
                    truncated = True
                    break
                r = _bench_call(base, key, m, system, u, thinking)
                if isinstance(r.get("status"), int) and r["status"] >= 400 and "thinking" in (r.get("err") or "").lower():
                    r = _bench_call(base, key, m, system, u, None)
                    r["thinking_fallback"] = True
                r.update({"model": m, "user": u, "run": i + 1})
                rows.append(r)
            if truncated:
                break
        if truncated:
            break
    return {
        "ok": True, "base": base, "runs": runs, "system_chars": len(system), "rows": rows,
        "truncated": truncated, "elapsed_ms": round((time.time() - t_begin) * 1000),
    }


def prune_backups() -> None:
    for d, prefix in ((os.path.dirname(RUST_ENV), os.path.basename(RUST_ENV)),
                      (os.path.dirname(POC_ENV), os.path.basename(POC_ENV))):
        baks = sorted(f for f in os.listdir(d) if f.startswith(f"{prefix}.bak-hotwords-"))
        for old in baks[:-BAK_KEEP]:
            os.unlink(os.path.join(d, old))


def main() -> None:
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        print(json.dumps({"ok": False, "error": "stdin 不是合法 JSON"}))
        return
    action = req.get("action")
    if action == "status":
        resp = {
            "ok": True, "env": env_values(RUST_ENV), "proc": proc_values(),
            "poc_env": env_values(POC_ENV), "unit_active": is_active(),
            "recent_activity": recent_activity(), "ts": int(time.time()),
        }
    elif action == "fillers":
        try:
            with open(MANIFEST, encoding="utf-8") as f:
                resp = {"ok": True, "manifest": json.load(f)}
        except (OSError, json.JSONDecodeError) as e:
            resp = {"ok": False, "error": f"读 manifest 失败: {e}"}
    elif action == "device_aliases":
        # S2-B2 命令词表只读透传(该文件=env P003_DEVICE_COMMAND_ALIASES_PATH 生效真值)
        try:
            with open(DEVICE_ALIASES, encoding="utf-8") as f:
                resp = {"ok": True, "tsv": f.read()}
        except OSError as e:
            resp = {"ok": False, "error": f"读 device_aliases 失败: {e}"}
    elif action == "apply":
        resp = do_apply(req)
    elif action == "apply_fillers":
        resp = do_apply_fillers(req)
    elif action == "race_get":
        resp = do_race_get()
    elif action == "race_set":
        resp = do_race_set(req)
    elif action == "race_stats":
        resp = do_race_stats(req)
    elif action == "race_bench":
        resp = do_race_bench(req)
    elif action == "voice_get":
        resp = do_voice_get()
    elif action == "voice_set":
        resp = do_voice_set(req)
    else:
        resp = {"ok": False, "error": f"未知 action: {action}"}
    print(json.dumps(resp, ensure_ascii=False))


if __name__ == "__main__":
    main()
