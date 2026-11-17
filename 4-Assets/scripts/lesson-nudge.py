#!/usr/bin/env python3
"""lesson-nudge.py — 把高频踩坑教训在「动作发生的那一刻」递到眼前（PreToolUse hook，只提醒不拦截）。

由来（2026-09-23 川哥拍板，home-studio 与 Air 同装）：
  评估器 v0 显示「常驻了还在踩」215 对 vs「库里有但没翻到」2 对——瓶颈不是检索，是开会话时读到的
  教训到了动作时刻已经淹在上下文里。截断检索那条守门在动作时刻提醒 242 次的效果证明这条路可行。
三组（按评估器点名数覆盖 81/442 对）：
  A 交付前四问：commit/push/部署/重启服务/远程推送时——验收类教训（58 对）
  B 结论落盘三档：Edit/Write 记忆文件、1-Inbox/0-System 报告时——断言类教训（14 对）
  C 截断：Grep 工具带结果条数上限时——阴性结论类（9 对）
  M 写教训记忆（2026-09-23 P0 修尺子加）：B 的三档 + 复发声明写法。评估器严口径只认两种写法算复发：
    新文件 frontmatter metadata 下 `recurrence_of: [旧文件名]`（不是复发写 []）；往旧教训文件追加新一例用「## 日期 变体：」小节。
    不跟 B 共用冷却——写完报告紧接着写记忆时，这句不能被冷却吞掉。
防疲劳：同一会话同一组 COOLDOWN 秒内只提醒一次。只发 additionalContext，永不 deny。
失败策略：任何异常都静默放行并写 err 文件（fail-open 但留痕）。
兼容：Claude Code（snake_case）与 grok（camelCase）payload；macOS bash 3.2 环境（本脚本直接由 python3 执行）。
"""
import json, os, re, sys, time, datetime

HOME = os.path.expanduser('~')
BASE = os.path.join(HOME, '.mycc-global/0-System')
if not os.path.isdir(BASE): BASE = os.path.join(HOME, '.claude')
STATE = os.environ.get('NUDGE_STATE', os.path.join(BASE, '.lesson-nudge-state.json'))
GLOG = os.environ.get('GUARD_LOG', os.path.join(BASE, 'guard-log.jsonl'))
ERR = os.environ.get('NUDGE_ERR', os.path.join(BASE, '.lesson-nudge.err'))
COOLDOWN = int(os.environ.get('NUDGE_COOLDOWN', '1200'))

A_PAT = re.compile(r'''(?x)
  \bgit\s+(?:-c\s+\S+\s+)*(?:commit|push)\b
 |\b(?:systemctl|launchctl)\b[^;&|]*\b(?:restart|reload|start|kickstart|bootstrap)\b
 |\bpm2\s+(?:restart|reload|start|deploy)\b
 |\bdocker\s+(?:compose\s+)?(?:up|restart)\b
 |\b(?:rsync|scp)\b[^;&|]*\s[\w.@-]+:\S
 |\bdeploy[\w.-]*\.sh\b
 |\bssh\b[^;&|]*\b(?:restart|reload|deploy)\b
''')
B_PATH = re.compile(r'(/\.claude/projects/[^/]+/memory/[^/]+\.md$|/1-Inbox/.+\.md$|/0-System/[^/]+\.md$)')
M_PATH = re.compile(r'/\.claude/projects/[^/]+/memory/(?!MEMORY\.md$|INDEX-full\.md$)[^/]+\.md$')
MSG = {
 'A': "📋 交付前四问（这一步会把东西交出去/让它生效）：①这个数字/现象和目标有因果链吗？②验的是生产路径，还是我方便的路径？③症状消失，有没有别的解释（缓存/没流量/换了实例）？④「没报错」是真没发生，还是没有通道看得见？答不上的那条，先补验证再说「完成」。",
 'B': "✍️ 结论落盘前分三档：每句机制/事实陈述标清是【验过】【能验没验】【验不了】。后两档写成断言就是错——改成「推断/待验」或先去验。别替看不见的那一侧（对端代码、另一台机器、未来行为）下断言。",
 'C': "✂️ 这次搜索带了结果条数上限：截断后的结果只能证明「有」，证明不了「没有」。要下「不存在/零命中」的结论，去掉上限或改用计数。",
}
MSG['M'] = MSG['B'] + ("\n🔁 若这条是某个旧教训又踩了一次（同一个坑/变体）：新文件在 frontmatter 的 metadata 下写 `recurrence_of: [旧文件名]`，"
                       "只是相关不是复发就写 `recurrence_of: []`；往旧教训文件里追加新一例，小节标题写「## YYYY-MM-DD 变体：…」。"
                       "评估器只认这两种写法算复发，正文里的 [[链接]] 不算。")

def err(m):
    try:
        with open(ERR, 'a') as f: f.write(datetime.datetime.now().isoformat(timespec='seconds') + ' ' + m + '\n')
    except Exception: pass

def classify(tool, ti):
    cmd = str(ti.get('command') or '')
    if cmd and tool in ('Bash', 'run_terminal_command', 'bash', 'shell'):
        flat = cmd.replace('\\\n', ' ').replace('\n', ' ; ')
        if A_PAT.search(flat): return 'A'
        return None
    fp = str(ti.get('file_path') or ti.get('path') or ti.get('target_file') or '')
    if tool in ('Edit', 'Write', 'MultiEdit', 'search_replace', 'write', 'edit_file', 'write_file') and fp:
        fp = os.path.expanduser(fp)
        if M_PATH.search(fp): return 'M'
        if B_PATH.search(fp): return 'B'
        return None
    if tool in ('Grep', 'grep'):
        hl = ti.get('head_limit')
        try:
            if hl is not None and int(hl) > 0: return 'C'
        except (TypeError, ValueError): pass
    return None

def main():
    raw = sys.stdin.read()
    try: d = json.loads(raw)
    except Exception as e: err('bad json: ' + repr(e)[:100]); return
    ti = d.get('tool_input') or d.get('toolInput') or {}
    if not isinstance(ti, dict): return
    tool = d.get('tool_name') or d.get('toolName') or ''
    g = classify(tool, ti)
    if not g: return
    sid = (d.get('session_id') or d.get('sessionId') or 'nosid')[:8]
    now = time.time()
    try: st = json.load(open(STATE)) if os.path.exists(STATE) else {}
    except Exception: st = {}
    key = sid + ':' + g
    if now - st.get(key, 0) < COOLDOWN: return
    st[key] = now
    st = {k: v for k, v in st.items() if now - v < 86400}      # 只留 24h 内
    try:
        tmp = STATE + '.tmp'
        with open(tmp, 'w') as f: json.dump(st, f)
        os.replace(tmp, STATE); os.chmod(STATE, 0o600)
    except Exception as e: err('state: ' + repr(e)[:100])
    try:
        rec = {'ts': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'sid': sid,
               'cwd': os.path.basename(d.get('cwd') or ''), 'decision': 'note', 'verb': tool, 'rules': ['lesson_' + g]}
        with open(GLOG, 'a') as f: f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except Exception as e: err('log: ' + repr(e)[:100])
    print(json.dumps({'additionalContext': MSG[g],
                      'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'additionalContext': MSG[g]}}, ensure_ascii=False))

if __name__ == '__main__':
    try: main()
    except Exception as e: err(repr(e)[:200])
    sys.exit(0)
