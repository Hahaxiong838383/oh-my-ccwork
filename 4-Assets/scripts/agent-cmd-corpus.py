#!/usr/bin/env python3
"""三家 agent（Claude / codex / grok）的 shell 命令语料 + 守门触发率对比（2026-09-24，川哥批的「第 0 步：先量」）。

问题：home-studio 近 30 天 codex 约 173 个会话、grok 约 89、Claude 约 11，守门与提醒只挂在 Claude（grok 兼容加载），
codex 犯不犯同样的错没有数据。这里用同一份守门、同一个时间窗、同样的遮蔽，给三家各跑一遍。

用法：
  agent-cmd-corpus.py build [--days 30]      抽命令 → ~/.local/share/guard-fixtures/corpus-{claude,codex,grok}-30d.jsonl（600）
  agent-cmd-corpus.py measure                每家逐条跑 no-guessing-guard.sh，写报告 measure-30d.json（含每规则样例，已遮蔽）
命令来源：Claude = transcripts 里 Bash 的 tool_use；codex = rollout 里 exec 自定义工具的 JS 代码中
`tools.exec_command({cmd: "…"})` 的字面量；grok = updates.jsonl 里 _meta["x.ai/tool"].input.command（按 toolCallId 去重）。
遮蔽：已知密钥（redact-leaks 的密钥集，只在内存）→ 令牌形状（cfgview.TOKEN_LIKE）→ IP。每家内部按命令文本去重。
"""
import os, re, sys, json, glob, time, collections, importlib.util, concurrent.futures

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
H = os.path.expanduser('~')
OUT = os.path.join(H, '.local/share/guard-fixtures')
_spec = importlib.util.spec_from_file_location('ngt', os.path.join(HERE, 'no-guessing-guard.test.py'))
_ngt = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_ngt)
run_guard = _ngt.run_guard


# ---------- 抽取 ----------
def recent(paths, days):
    now = time.time()
    return [p for p in paths if now - os.path.getmtime(p) < days * 86400]


def claude_cmds(days):
    for f in recent(glob.glob(f'{H}/.claude/projects/*/*.jsonl'), days):
        if '/-Users-rayman-chen-mycc/' in f:        # 指向 -home-hahaxiong83-mycc 的软链，别重复算
            continue
        for l in open(f, encoding='utf-8', errors='replace'):
            if '"tool_use"' not in l or '"Bash"' not in l:
                continue
            try:
                d = json.loads(l)
            except ValueError:
                continue
            for c in (d.get('message') or {}).get('content') or []:
                if isinstance(c, dict) and c.get('type') == 'tool_use' and c.get('name') == 'Bash':
                    cmd = (c.get('input') or {}).get('command')
                    if isinstance(cmd, str) and cmd.strip():
                        yield cmd, os.path.basename(f)[:8]


# JS 里 exec_command({cmd:"…"}) / {"cmd":'…'}：只认双引号和单引号字面量（模板字符串带 ${} 的不收，算不出真值）
JS_CMD = re.compile(r'''exec_command\(\s*\{[^{}]*?["']?cmd["']?\s*:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')''', re.S)


def js_str(lit):
    if lit[0] == "'":
        lit = '"' + lit[1:-1].replace('\\\'', "'").replace('"', '\\"') + '"'
    try:
        return json.loads(lit)
    except ValueError:
        return None


def codex_cmds(days):
    for f in recent(glob.glob(f'{H}/.codex/sessions/2026/*/*/rollout-*.jsonl'), days):
        for l in open(f, encoding='utf-8', errors='replace'):
            if '"custom_tool_call"' not in l:
                continue
            try:
                p = json.loads(l).get('payload') or {}
            except ValueError:
                continue
            if p.get('type') != 'custom_tool_call' or p.get('name') != 'exec':
                continue
            for m in JS_CMD.finditer(p.get('input') or ''):
                cmd = js_str(m.group(1))
                if cmd and cmd.strip():
                    yield cmd, os.path.basename(f)[-44:-36]


def grok_cmds(days):
    for f in recent(glob.glob(f'{H}/.grok/sessions/*/*/updates.jsonl'), days):
        seen = set()
        for l in open(f, encoding='utf-8', errors='replace'):
            if 'x.ai/tool' not in l:
                continue
            try:
                u = (json.loads(l).get('params') or {}).get('update') or {}
            except ValueError:
                continue
            t = (u.get('_meta') or {}).get('x.ai/tool') or {}
            cmd = (t.get('input') or {}).get('command')
            tid = u.get('toolCallId') or t.get('id') or cmd
            if isinstance(cmd, str) and cmd.strip() and tid not in seen:
                seen.add(tid)
                yield cmd, f.split('/')[-2][:8]


# ---------- 遮蔽 ----------
def make_redactor():
    spec = importlib.util.spec_from_file_location('rl', os.path.join(HERE, 'redact-leaks.py'))
    rl = importlib.util.module_from_spec(spec); spec.loader.exec_module(rl)
    from cfgview import TOKEN_LIKE
    secrets = rl.load_secrets()

    def red(s):
        b = s.encode('utf-8', 'surrogateescape')
        for a, e, _ in sorted(rl.find_spans(b, secrets), reverse=True):
            b = b[:a] + b'<SECRET>' + b[e:]
        t = b.decode('utf-8', 'replace')
        t = TOKEN_LIKE.sub('<TOKEN>', t)
        return re.sub(r'\b\d{1,3}(?:\.\d{1,3}){3}\b', '<IP>', t)
    return red


def write600(path, lines):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        for x in lines:
            f.write(json.dumps(x, ensure_ascii=False) + '\n')


def build(days):
    red = make_redactor()
    os.makedirs(OUT, exist_ok=True)
    for name, gen in (('claude', claude_cmds), ('codex', codex_cmds), ('grok', grok_cmds)):
        raw = 0; uniq = {}; sessions = set()
        for cmd, sid in gen(days):
            raw += 1; sessions.add(sid)
            c = red(cmd)
            uniq.setdefault(c, sid)
        path = os.path.join(OUT, f'corpus-{name}-{days}d.jsonl')
        write600(path, [{'cmd': c, 'sid': s} for c, s in uniq.items()])
        print(f'{name:6} 会话 {len(sessions):4}  命令 {raw:6}  去重后 {len(uniq):6} → {path}')


# ---------- 测量 ----------
def measure(days, workers=12):
    report = {}
    for name in ('claude', 'codex', 'grok'):
        path = os.path.join(OUT, f'corpus-{name}-{days}d.jsonl')
        rows = [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]
        t0 = time.time()
        with concurrent.futures.ThreadPoolExecutor(workers) as ex:
            results = list(ex.map(lambda r: run_guard(r['cmd'])[0], rows))
        fires = collections.Counter(); samples = collections.defaultdict(list)
        for r, rules in zip(rows, results):
            for rule in rules:
                fires[rule] += 1
                if len(samples[rule]) < 40:
                    samples[rule].append({'sid': r['sid'], 'cmd': r['cmd'][:400]})
        n = len(rows)
        report[name] = {'n': n, 'fires': dict(fires), 'per100': {k: round(100 * v / n, 2) for k, v in fires.items()},
                        'samples': samples}
        print(f'{name:6} {n:6} 条，{time.time() - t0:5.0f}s')
    path = os.path.join(OUT, f'measure-{days}d.json')
    write600(path, [report])
    rules = sorted({k for v in report.values() for k in v['fires']},
                   key=lambda k: -max(report[a]['per100'].get(k, 0) for a in report))
    print(f"\n{'规则':<26}" + ''.join(f'{a:>16}' for a in report))
    print(f"{'（命令条数）':<24}" + ''.join(f"{report[a]['n']:>16}" for a in report))
    for k in rules:
        print(f'{k:<26}' + ''.join(f"{report[a]['fires'].get(k, 0):>7} {report[a]['per100'].get(k, 0):6.2f}/百" for a in report))
    print(f'\n报告（含每规则样例，已遮蔽）：{path}')


# ---------- 纠正信号：川哥在各家会话里纠正 agent 的比例 ----------
# 命令形态只说明「像」，不说明「错」；川哥的纠正才是结果信号。关键词只做候选筛选，结论靠抽样人工判读。
CORR = re.compile(r'不对|错了|搞错|弄错|又(犯|错|忘|没|在|来|是)|说过|跟你说|不是让你|怎么又|为什么(没|不|要)|别再|别跑题|跑题|'
                  r'我没(让|说|发|要)|你猜|瞎(猜|编|写)|不准猜|没验证|没核|凭什么|谁让你|不要擅自|擅自|推给我|看清楚|不是这个')


def user_msgs(days):
    """yield (agent, 会话, 文本)。codex 只取顶层会话（子代理收到的是父代理的话）；Claude 排除工具结果与注入块。"""
    for f in recent(glob.glob(f'{H}/.codex/sessions/2026/*/*/rollout-*.jsonl'), days):
        ls = open(f, encoding='utf-8', errors='replace').read().splitlines()
        try:
            meta = json.loads(ls[0]).get('payload') or {}
        except (ValueError, IndexError):
            continue
        # 子代理（收到的是父代理的话）与定时巡检（机器发的提示）都不算川哥的消息
        if not isinstance(meta.get('source'), str) or 'h-platform-daily-ops' in (meta.get('cwd') or ''):
            continue
        sid = os.path.basename(f)[-44:-36]
        ev = [json.loads(l).get('payload') or {} for l in ls if '"user_message"' in l]
        ev = [p['message'] for p in ev if p.get('type') == 'user_message' and p.get('message')]
        if ev:                                   # 有事件就用事件（response_item 里是同一句的另一份）
            for t in ev:
                yield 'codex', sid, t
            continue
        for l in ls:                             # 部分会话只有 response_item 里的原话
            if '"role":"user"' not in l:
                continue
            p = json.loads(l).get('payload') or {}
            if p.get('type') == 'message' and p.get('role') == 'user':
                t = ''.join(x.get('text', '') for x in p.get('content', []) if isinstance(x, dict)).strip()
                if t and not t.startswith('<') and not t.startswith('# AGENTS.md'):
                    yield 'codex', sid, t
    for f in recent(glob.glob(f'{H}/.grok/sessions/*/*/chat_history.jsonl'), days):
        for l in open(f, encoding='utf-8', errors='replace'):
            try:
                d = json.loads(l)
            except ValueError:
                continue
            if (d.get('role') or d.get('type')) == 'user':
                c = d.get('content')
                t = c if isinstance(c, str) else ''.join(x.get('text', '') for x in c or [] if isinstance(x, dict))
                if t.strip():
                    yield 'grok', f.split('/')[-2][:8], t
    for f in recent(glob.glob(f'{H}/.claude/projects/*/*.jsonl'), days):
        if '/-Users-rayman-chen-mycc/' in f:
            continue
        for l in open(f, encoding='utf-8', errors='replace'):
            if '"type":"user"' not in l:
                continue
            try:
                d = json.loads(l)
            except ValueError:
                continue
            if d.get('isMeta') or d.get('isCompactSummary'):
                continue
            c = (d.get('message') or {}).get('content')
            t = c if isinstance(c, str) else ''.join(x.get('text', '') for x in c or [] if isinstance(x, dict) and x.get('type') == 'text')
            t = t.strip()
            if t and not t.startswith('<') and not t.startswith('This session is being continued') and not t.startswith('[Request interrupted'):
                yield 'claude', os.path.basename(f)[:8], t


INJECTED = re.compile(r'<(user_info|rules|system-reminder|environment_context|user_instructions|agent_skills|memories|'
                      r'available_skills|workspace_rules|mcp_instructions)\b[^>]*>.*?</\1>', re.S)
AUTOMATION = ('H 平台每日只读巡检',)   # Codeg Automation 定时发的提示，不是川哥说的话


def human_text(t):
    """剥掉 agent 注入的上下文块（grok 每条用户消息前都有 <user_info>/<rules>…），只留川哥自己打的字。"""
    t = INJECTED.sub('', t)
    t = re.sub(r'</?user_query>', '', t).strip()
    return '' if t.startswith(AUTOMATION) else t


def corrections(days):
    red = make_redactor()
    tot = collections.Counter(); hit = collections.Counter(); sess = collections.defaultdict(set); rows = []
    for agent, sid, t in user_msgs(days):
        t = human_text(t)
        if not t:
            continue
        tot[agent] += 1; sess[agent].add(sid)
        if CORR.search(t):
            hit[agent] += 1
            rows.append({'agent': agent, 'sid': sid, 'text': re.sub(r'\d{7,}', '‹数字›', red(t))[:600]})
    path = os.path.join(OUT, f'corrections-{days}d.jsonl')
    write600(path, rows)
    for a in ('claude', 'codex', 'grok'):
        print(f'{a:6} 会话 {len(sess[a]):3}  用户消息 {tot[a]:4}  含纠正词 {hit[a]:3}（{100 * hit[a] / max(tot[a], 1):4.1f}%）')
    print(f'候选原文（已遮蔽）：{path}')


if __name__ == '__main__':
    a = sys.argv[1:]
    days = int(a[a.index('--days') + 1]) if '--days' in a else 30
    if a and a[0] == 'build':
        build(days)
    elif a and a[0] == 'measure':
        measure(days)
    elif a and a[0] == 'corrections':
        corrections(days)
    else:
        sys.exit(__doc__)
