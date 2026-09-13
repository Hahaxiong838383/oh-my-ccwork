"""Rust vs Python(colleague) 性能对比抽取(64.90 上跑)。
同口径指标(两边同款契约行,行内微秒时间戳):
  ① stt final→commit(判停决策等待): 契约 UserTranscriptFinal → 契约 UserTurnCommitted
  ② commit→首音(感知开口,含 filler): 契约 UserTurnCommitted → 契约 AgentSpeechStarted
各自专有: rust eou_ms/stt_ms/llm ttft; python join timing total / poc delay 挡位
job 内存: 两边同款 job rss 行。
样本窗: python=真人房 2ab76937(08-14~08-15,跨 unit 实例翻全量 journal);
        rust=今天 06:00 起(voice-test-rust 真人房单列)。
"""
import json
import re
import statistics
import subprocess
from datetime import datetime


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout


def parse_iso(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def stats(xs):
    if not xs:
        return "n=0"
    xs = sorted(xs)
    p50 = xs[len(xs) // 2]
    p90 = xs[int(len(xs) * 0.9)] if len(xs) >= 2 else xs[-1]
    return f"n={len(xs)} p50={p50:.0f}ms p90={p90:.0f}ms mean={statistics.mean(xs):.0f}ms"


def pair_delta(events, from_ev, to_ev, max_gap_s=8.0):
    """按时间序配对 from_ev→之后首个 to_ev,返回差值 ms 列表。"""
    out = []
    pend = None
    for t, ev in events:
        if ev == from_ev:
            pend = t
        elif ev == to_ev and pend is not None:
            d = (t - pend) * 1000
            if 0 <= d <= max_gap_s * 1000:
                out.append(d)
            pend = None
    return out


# ---------- Python colleague: 真人房(跨实例全量 journal) ----------
raw = sh("journalctl -u voice-worker-colleague --since -80h --no-pager | grep 契约")
py_events = []
py_jobrss = []
for line in raw.splitlines():
    m = re.search(r'"message": "契约 (\w+)[^"]*".*?"timestamp": "([^"]+)"', line)
    if m:
        py_events.append((parse_iso(m.group(2)), m.group(1)))
r2 = sh("journalctl -u voice-worker-colleague --since -80h --no-pager | grep -oE 'job rss: [0-9]+MB'")
py_jobrss = [int(x) for x in re.findall(r"(\d+)MB", r2)]
ctxc = sh("journalctl -u voice-worker-colleague --since -80h --no-pager | grep -oE 'ctx.connect=[0-9]+ms'")
py_ctx = [int(x) for x in re.findall(r"ctx.connect=(\d+)ms", ctxc)]
jt = sh("journalctl -u voice-worker-colleague --since -80h --no-pager | grep -oE 'join timing:.*total=[0-9]+ms'")
py_join = [int(x) for x in re.findall(r"total=(\d+)ms", jt)]
py_events.sort()
print("== Python colleague(全 unit 80h,样本主体=定时探活 job) ==")
print("  final→commit:", stats(pair_delta(py_events, "UserTranscriptFinal", "UserTurnCommitted", 5)))
print("  commit→首音:", stats(pair_delta(py_events, "UserTurnCommitted", "AgentSpeechStarted", 8)))
print(f"  job rss(全 unit 80h): n={len(py_jobrss)} min={min(py_jobrss)} max={max(py_jobrss)}MB" if py_jobrss else "  job rss: n=0")
print("  join timing total(含等参与者):", stats([float(x) for x in py_join]))
print("  ctx.connect(房连接,与 rust connect_ms 同口径):", stats([float(x) for x in py_ctx]))

# ---------- Rust: 今天 ----------
raw = sh("journalctl -u voice-worker-rust --since 06:00 --no-pager")
ru_events_all, ru_events_human = [], []
ru_eou, ru_stt, ru_ttft, ru_jobrss, ru_connect = [], [], [], [], []
for line in raw.splitlines():
    tm = re.search(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)", line)
    if not tm:
        continue
    t = parse_iso(tm.group(1))
    cm = re.search(r"契约 (\w+)", line)
    if cm:
        ru_events_all.append((t, cm.group(1)))
        if "voice-test-rust" in line:
            ru_events_human.append((t, cm.group(1)))
    m = re.search(r"turn committed:.*eou_ms=(\d+) stt_ms=(\d+)", line)
    if m:
        ru_eou.append(int(m.group(1)))
        ru_stt.append(int(m.group(2)))
    m = re.search(r"llm stream done ttft_ms=(\d+)", line)
    if m:
        ru_ttft.append(int(m.group(1)))
    m = re.search(r"job rss: (\d+)MB", line)
    if m:
        ru_jobrss.append(int(m.group(1)))
    m = re.search(r"connect_ms=(\d+)", line)
    if m:
        ru_connect.append(int(m.group(1)))
ru_events_all.sort()
ru_events_human.sort()
print("== Rust(今天全部: 真人+探针) ==")
print("  final→commit:", stats(pair_delta(ru_events_all, "UserTranscriptFinal", "UserTurnCommitted", 5)))
print("  commit→首音:", stats(pair_delta(ru_events_all, "UserTurnCommitted", "AgentSpeechStarted", 8)))
print("  commit→首音(仅真人房):", stats(pair_delta(ru_events_human, "UserTurnCommitted", "AgentSpeechStarted", 8)))
print("  eou_ms(自报判停):", stats([float(x) for x in ru_eou]))
print("  llm ttft_ms:", stats([float(x) for x in ru_ttft]))
print(f"  job rss: n={len(ru_jobrss)} min={min(ru_jobrss)} max={max(ru_jobrss)}MB" if ru_jobrss else "  job rss: n=0")
print("  room connect_ms:", stats([float(x) for x in ru_connect]))
