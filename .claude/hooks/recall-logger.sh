#!/usr/bin/env bash
# 阶段0 记忆召回日志 v2 — 记录 cc 手动召回记忆事件,收集两周数据判断 CC 原生 side-query 是否成瓶颈
# 触发: PreToolUse hook, matcher "Bash|Grep|Read" (PreToolUse 只拿 tool_input,不含执行输出,轻+记意图)
# 强信号: rg/grep/git-grep/fd/find over memory|MEMORY.md  |  中信号: Read memory 文件
# 铁律: 不阻塞(快速退出)/ 不静默吞错(debug err 日志)/ 日志本地脱敏隔离(非外发)
RECALL_LOG="${RECALL_LOG:-$HOME/.mycc-global/0-System/recall-log.jsonl}"
ERR_LOG="${ERR_LOG:-$HOME/.mycc-global/0-System/recall-logger.err}"
input=$(cat 2>/dev/null)
# 快速预判(不分大小写,覆盖 MEMORY.md): 不含 memory 直接退,省 python 启动
shopt -s nocasematch 2>/dev/null
case "$input" in
  *memory*) ;;
  *) exit 0 ;;
esac
printf '%s' "$input" | RECALL_LOG="$RECALL_LOG" ERR_LOG="$ERR_LOG" python3 -c '
import json, sys, os, datetime, re
def log_err(m):
    try: open(os.environ["ERR_LOG"], "a").write(datetime.datetime.utcnow().isoformat() + " " + m + "\n")
    except Exception: pass
try:
    d = json.load(sys.stdin)
    ti = d.get("tool_input", {}) or {}
    name = d.get("tool_name", "")
    sid = (d.get("session_id", "") or "")[:8]
    cwd = os.path.basename(d.get("cwd", "") or "")
    MEM = re.compile(r"memory/|MEMORY\.md|/memory(\b|$)|0-System/memory|projects/.+/memory", re.I)
    if name == "Bash":
        cmd = ti.get("command", "")
        if not MEM.search(cmd): sys.exit(0)
        # 精确匹配检索命令(词边界,排除 pgrep/egrep/路径里的 grep)
        if not re.search(r"\b(rg|grep|git grep|ripgrep|fd|find|ag)\b", cmd): sys.exit(0)
        q, src, strength = cmd.strip()[:300], "bash-search", "strong"
    elif name == "Grep":
        if not MEM.search((ti.get("path", "") or "") + " " + (ti.get("glob", "") or "")): sys.exit(0)
        q, src, strength = (ti.get("pattern", "") or "")[:300], "grep-tool", "strong"
    elif name == "Read":
        fp = ti.get("file_path", "") or ""
        if not MEM.search(fp): sys.exit(0)
        q, src, strength = os.path.basename(fp), "read-mem", "medium"
    else:
        sys.exit(0)
    rec = {"ts": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
           "sid": sid, "cwd": cwd, "tool": name, "src": src, "strength": strength, "query": q}
    log = os.environ["RECALL_LOG"]
    os.makedirs(os.path.dirname(log), exist_ok=True)
    with open(log, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
except SystemExit:
    pass
except Exception as e:
    log_err(repr(e))
' 2>/dev/null
exit 0
