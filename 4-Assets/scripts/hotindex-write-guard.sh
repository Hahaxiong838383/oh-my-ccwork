#!/bin/bash
# hotindex-write-guard.sh — 共享索引文件的写前 CAS 守门（PreToolUse + PostToolUse 同一脚本）。
#
# 由来：2026-09-18 我 14:44 写入 MEMORY.md 三刀压缩，21:06 另一个 cc 会话把它写回旧版
# （它在我写之前读的，写回时带的是旧内容）。A 库早有 [[feedback_parallel_session_concurrent_file_revert]]
# 与「改旧文件先读后写」纪律，但纪律拦不住，只能让 harness 拦。
#
# 守护对象：canonical 目录下的 MEMORY.md / INDEX-full.md（按 realpath 判，symlink 入口一律归一；
#          0-System/MEMORY.md 是 B 系统另一个文件，不在此列）。
# 机制：PostToolUse 任何工具碰到目标文件 → 记「本会话最后见到的 mtime」；
#       PreToolUse 写形态（Edit/Write/MultiEdit，或 Bash 里 >/>>/tee/sed -i/open('w')/hotindex-compress --write）
#       → 比对：没见过 → deny「先 Read」；mtime 变了 → deny「被并发改过，先重读」。
# 覆盖边界：只管 cc（Claude Code hook；grok 会兼容加载但 payload camelCase，已兼容；codex 不管）。
# 失败策略：脚本自身出错必须放行，错误写 .err 文件（fail-open 但不静默）。
# 覆盖边界（2026-09-18 实测）：Edit/Write 工具本身已有内置 CAS（「modified since read」），本守门补的是 Bash 直写。
#   2026-09-23 更正：codeg 会话里 deny 能生效，之前失效是输出里多了顶层 decision:'deny'（见下方输出处注释）。
set -uo pipefail
payload="$(cat)"
# 快速退出：payload 里没提到目标就不起 python
case "$payload" in
  *MEMORY.md*|*INDEX-full.md*|*hotindex-compress*) ;;
  *) exit 0 ;;
esac
STATE="${HOTINDEX_STATE:-$HOME/.mycc-global/0-System/.hotindex-seen.json}"
CANON="${HOTINDEX_CANON_DIR:-$HOME/.claude/projects/-home-hahaxiong83-mycc/memory}"
GUARD_LOG="${GUARD_LOG:-$HOME/.mycc-global/0-System/guard-log.jsonl}"
ERR="${HOTINDEX_ERR:-$HOME/.mycc-global/0-System/.hotindex-guard.err}"
# ⚠️ 不能写 `printf … | python3 - <<'PY'`：heredoc 会顶掉管道成为 stdin，python 读到的 payload 永远是空串
#（首版 14 个用例全红、err 里 23 条 JSONDecodeError 就是这个）。代码进变量，payload 走管道。
code=$(cat <<'PY'
import json, os, re, sys, datetime, time
UTC = datetime.timezone.utc
def err(m):
    try: open(os.environ['ERR'], 'a').write(datetime.datetime.now(UTC).isoformat() + ' ' + m + '\n')
    except Exception: pass
try:
    d = json.load(sys.stdin)
    ev = d.get('hook_event_name') or d.get('hookEventName') or ''
    tool = d.get('tool_name') or d.get('toolName') or ''
    ti = d.get('tool_input') or d.get('toolInput') or {}
    if not isinstance(ti, dict): sys.exit(0)
    sid = (d.get('session_id') or d.get('sessionId') or '')[:8]
    cwd = d.get('cwd') or os.getcwd()
    CANON = os.path.realpath(os.environ['CANON'])
    TARGETS = ('MEMORY.md', 'INDEX-full.md')

    def canon_targets(paths):
        out = set()
        for p in paths:
            if not p: continue
            p = os.path.expanduser(p)
            if not os.path.isabs(p): p = os.path.join(cwd, p)
            rp = os.path.realpath(p)
            if os.path.dirname(rp) == CANON and os.path.basename(rp) in TARGETS:
                out.add(rp)
        return out

    cmd = str(ti.get('command', '') or '')
    fp = ti.get('file_path') or ti.get('notebook_path') or ''
    cands = set(); conservative = set()   # conservative：只参与拒写判断，不参与登记
    if fp: cands |= canon_targets([fp])
    if cmd:
        # ⚠️ 2026-09-18 真机触发抓到的盲区：`A=~/…/memory; printf '' >> $A/MEMORY.md` 里 token 是 `$A/MEMORY.md`，
        # python 不展开 shell 变量 → realpath 落在 cwd 下 → 判为「不是目标」→ 放行。临时目录里的 16 个用例全是
        # bash 先展开好的字面路径，测不到这个形态。修法：回填命令内的 VAR=value；仍含 $ 的写目标保守视为 canonical。
        assigns = dict(re.findall(r'(?:^|[;&|\s])([A-Za-z_][A-Za-z0-9_]*)=([^\s;&|]+)', cmd))
        def subst(t):
            for _ in range(3):
                t2 = re.sub(r'\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?', lambda m: assigns.get(m.group(1), m.group(0)), t)
                if t2 == t: break
                t = t2
            return t.strip('"\'')
        toks = [subst(t) for t in re.findall(r'[^\s"\'`|;&()<>]*(?:MEMORY|INDEX-full)\.md', cmd)]
        cands |= canon_targets(toks)
        for t in toks:
            if '$' in t:   # 解析不了的变量路径：宁可多拦一次「先 Read」，不放走一次静默覆盖
                c = os.path.join(CANON, os.path.basename(t)); cands.add(c); conservative.add(c)
        if re.search(r'hotindex-compress\.py.*--(write|rollback)', cmd):
            cands.add(os.path.join(CANON, 'MEMORY.md'))   # 它只写 MEMORY.md + topic 文件，不碰 INDEX-full
    if not cands: sys.exit(0)

    # 写形态判定
    is_write = False
    if tool in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'):
        is_write = True
    elif tool == 'Bash' and cmd:
        flat = cmd.replace('\\\n', ' ').replace('\n', ';')
        if re.search(r'(>>?|\btee\b)\s*["\']?[^\s|;&]*(MEMORY|INDEX-full)\.md', flat): is_write = True
        if re.search(r'\bsed\s+-[a-zA-Z]*i[a-zA-Z]*\b[^;|]*(MEMORY|INDEX-full)\.md', flat): is_write = True
        if re.search(r"open\([^)]*(MEMORY|INDEX-full)\.md[^)]*['\"]w", flat) or (re.search(r"open\([^)]*['\"][wa]['\"]", flat) and re.search(r'(MEMORY|INDEX-full)\.md', flat) and 'python' in flat): is_write = True
        if re.search(r'\b(mv|cp|os\.replace|shutil\.(copy|move))\b[^;|]*(MEMORY|INDEX-full)\.md', flat): is_write = True
        if re.search(r'hotindex-compress\.py.*--(write|rollback)', flat): is_write = True

    state = {}
    try:
        if os.path.exists(os.environ['STATE']): state = json.load(open(os.environ['STATE']))
    except Exception as e:
        err('state load: ' + repr(e)); state = {}
    seen = state.setdefault(sid, {})

    def mtime(p):
        try: return os.stat(p).st_mtime_ns
        except FileNotFoundError: return None

    def log(decision, rule, verb):
        try:
            rec = {'ts': datetime.datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ'), 'sid': sid,
                   'cwd': os.path.basename(cwd), 'decision': decision, 'verb': verb, 'rules': [rule]}
            with open(os.environ['GUARD_LOG'], 'a') as f: f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        except Exception as e: err('log: ' + repr(e))

    # ⚠️ 真机抓到：Edit 被拒（内置「modified since read」+本守门 stale 双拒）会触发 PostToolUseFailure，
    # 首版在失败事件上也登记 mtime → 「被拒」被当成「看过」→ 紧接着的 Bash 写放行。失败事件一律不登记。
    if ev == 'PostToolUseFailure':
        sys.exit(0)
    if ev == 'PostToolUse':
        rec = 0
        for rp in cands - conservative:
            m = mtime(rp)
            if m is not None: seen[rp] = m; rec += 1
        if not rec: sys.exit(0)
        tmp = os.environ['STATE'] + '.tmp'
        os.makedirs(os.path.dirname(os.environ['STATE']), exist_ok=True)
        with open(tmp, 'w') as f: json.dump(state, f)
        os.replace(tmp, os.environ['STATE']); os.chmod(os.environ['STATE'], 0o600)
        sys.exit(0)

    if ev != 'PreToolUse' or not is_write: sys.exit(0)

    problems = []
    for rp in sorted(cands):
        cur = mtime(rp)
        if cur is None: continue
        last = seen.get(rp)
        base = os.path.basename(rp)
        if last is None:
            problems.append(f"{base}：本会话没有读过它就要写。先 Read（或 cat）一次再改——写前必须基于最新内容。")
        elif last != cur:
            when = datetime.datetime.fromtimestamp(cur / 1e9).strftime('%m-%d %H:%M:%S')
            problems.append(f"{base}：你上次看到它之后，文件在 {when} 被改过（多半是另一个并行会话）。你手里的是旧版，直接写会把别人的改动冲掉。先重新 Read，把你的改动重放到最新内容上再写。")
    if not problems: sys.exit(0)
    reason = "共享索引写前 CAS 拦截（2026-09-18 起）：\n" + "\n".join("- " + p for p in problems) + \
             "\n规矩：MEMORY.md / INDEX-full.md 是多会话共享文件，改它只能「读→改→写」一气呵成，中间被人改了就重来。"
    log('deny', 'hotindex_stale' if any('被改过' in p for p in problems) else 'hotindex_unseen', tool)
    # ⚠️ 只输出 hookSpecificOutput：claude 对顶层 decision 只认 approve/block，写成 'deny' 会抛错、整条输出
    # （连 additionalContext）作废、写入照样发生。9-18 看到的「auto 下 deny 连提醒一起被丢」，推断就是这个顶层
    # 字段造成的；2026-09-23 在 codeg(auto) 会话里探针实测：合法格式的 deny 拦得住，带顶层 decision 的照跑。
    out = {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                  'permissionDecisionReason': reason}}
    if 'toolInput' in d:   # grok（camelCase）认不认 deny 没验证过：额外带一份提醒兜底
        ctx = "🔴 " + reason + "\n（若写入仍然发生了，说明本会话没认 hook 拒绝——立即用 .bak 或 topic『热索引沉淀』节核对有无冲掉别人的改动。）"
        out['additionalContext'] = ctx
        out['hookSpecificOutput']['additionalContext'] = ctx
    print(json.dumps(out, ensure_ascii=False))
except SystemExit: raise
except Exception as e:
    err(repr(e))
PY
)
printf '%s' "$payload" | STATE="$STATE" CANON="$CANON" GUARD_LOG="$GUARD_LOG" ERR="$ERR" python3 -c "$code"
exit 0
