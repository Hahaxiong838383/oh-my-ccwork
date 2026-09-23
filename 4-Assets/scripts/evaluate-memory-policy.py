#!/usr/bin/env python3
"""evaluate-memory-policy.py — 评估器 v0（Dream-RSI Phase 1 · Step 1）。

摩擦真值 = 我自己写下的新教训。每条新记忆 N 的正文里手写的 [[同族 O]] 表示
「写 N 的那个会话踩了 O 所防的坑」。这是目前唯一既有归因、又不需要读原文的信号。

对每对 (O, N)：
  resident   = O 现在是否在 MEMORY.md ★ 区常驻（⚠️ 用当前版近似「当时」：本机 ~/.claude
               不是 git 仓，热索引无历史；窗口仅 1 个月，近似可接受，报告里声明）
  retrieved  = 在 N 被写入之前，同一会话轨迹里是否引用过 O（prefix-only：只看写入事件之前）
               无轨迹 → None（不是 False：那是「没通道」不是「没检索」）

四象限（只对 resident/retrieved 可判定的对子）：
  常驻 & 仍踩            → 常驻没防住 → hook 化 / 改写候选
  非常驻 & 未检索 & 仍踩  → 召回失败   → 晋升 / 改召回词候选
  非常驻 & 已检索 & 仍踩  → 看到也没用 → 认知类，改写措辞
  常驻 & 窗口内没被链接   → 不可判定（悖论），不出现在本表

两把尺子（2026-09-23 P0 修尺子）：
  宽口径 = 正文里每个 [[旧]] 都算「又踩了它」。实测多数只是「关联/参见」，是虚高上界，只作对照。
  严口径 = 真值。按优先级取：
    ① 新记忆 frontmatter 写了 recurrence_of 字段 → 只认字段（[] = 作者明说不是复发），正文怎么写都不看
    ② 没写字段（历史文件）→ 看每个指向该旧文件的链接前后语境，有「同族/又踩/变体/复发…」才算
  写法（lesson-nudge B 组在写记忆时会提醒）：metadata 下 `recurrence_of: [旧文件名, …]`，不是复发写 `[]`。

只读。不改任何记忆文件。
"""
import os, re, glob, json, datetime, collections

HOME = os.path.expanduser('~')
MEM_DIR = os.environ.get('EVAL_MEM_DIR', os.path.join(HOME, '.claude/projects/-home-hahaxiong83-mycc/memory'))
TRJ = os.environ.get('EVAL_TRJ', os.path.join(HOME, '.mycc-global/0-System/trajectories'))
WINDOW_START = datetime.datetime(2026, 8, 20)
DECL_START = datetime.datetime(2026, 9, 23)   # recurrence_of 字段启用日；此后的新教训应当都声明

LINK_ANY = re.compile(r'\[([^\]]+)\]\(([^)]+\.md)\)')
WIKI = re.compile(r'\[\[([A-Za-z0-9_\-]+)\]\]')
OSID = re.compile(r'originSessionId:\s*([0-9a-f-]+)')
FM_NAME = re.compile(r'^name:\s*(.+?)\s*$', re.M)

def hot_resident():
    """MEMORY.md 三个 ★ 区里以链接出现的文件名集合。场景簇没有文件链接，不计。
    同时返回 slug→file：记忆正文里的 [[x]] 常写热索引短别名（silent_non_events）而非文件名。"""
    res, slug2file = {}, {}
    section = None
    for line in open(os.path.join(MEM_DIR, 'MEMORY.md'), errors='replace'):
        if line.startswith('## '):
            section = ('lesson' if '★ 教训' in line else 'project' if '★ 项目' in line
                       else 'reference' if '★ 参考' in line else None)
            continue
        if line.startswith('- '):
            for slug, f in LINK_ANY.findall(line):
                slug2file[slug] = f
                slug2file[slug.replace('-', '_')] = f
                if section:
                    res[f] = section
    return res, slug2file

def load_all_memories():
    """文件名 → {name, mtime}；并建 name→file 的反查（[[x]] 可能写 name 而非文件名）。"""
    mems, by_name = {}, {}
    for fp in glob.glob(os.path.join(MEM_DIR, '*.md')):
        b = os.path.basename(fp)
        if b in ('MEMORY.md', 'INDEX-full.md'):
            continue
        head = open(fp, errors='replace').read(2500)
        nm = FM_NAME.search(head)
        name = nm.group(1).strip() if nm else b[:-3]
        mems[b] = {'name': name, 'mtime': os.stat(fp).st_mtime, 'body': None}
        by_name[name] = b
        by_name[name.replace('-', '_')] = b
        by_name[b[:-3]] = b
        by_name[b[:-3].replace('_', '-')] = b
    return mems, by_name

BIRTHS = os.environ.get('EVAL_BIRTHS', os.path.join(HOME, '.local/share/memory-eval/births.json'))

def load_births(mems):
    """文件名 → 首次出现时间（epoch），给「新/旧」「哪一周」用。
    不能用 mtime：编辑老文件、Air 同步回推都会刷新它（2026-09-23 实测：7-26 建的 project_feishu_grok_h_byos
    9-22 被编辑，67 个链接全被算成「本周新踩」）。台账只增不改：没见过的文件记它此刻的 mtime；
    历史文件由 --seed-births 用 git 首次入库时间回填（取 min）。台账不在任何 git 仓里。"""
    try:
        b = json.load(open(BIRTHS))
    except FileNotFoundError:
        b = {}
    add = {f: info['mtime'] for f, info in mems.items() if f not in b}
    if add:
        b.update(add)
        os.makedirs(os.path.dirname(BIRTHS), exist_ok=True)
        tmp = BIRTHS + '.tmp'
        with open(tmp, 'w') as fh:
            json.dump(b, fh, indent=0, sort_keys=True)
        os.replace(tmp, BIRTHS); os.chmod(BIRTHS, 0o600)
    return b

def seed_births(stream):
    """读 `git log --diff-filter=A --format=@%at --name-only` 的输出，按文件名取最早时间并入台账。"""
    try:
        b = json.load(open(BIRTHS))
    except FileNotFoundError:
        b = {}
    t, n = None, 0
    for line in stream:
        line = line.strip()
        if line.startswith('@'):
            t = int(line[1:]); continue
        f = os.path.basename(line)
        if t and f.endswith('.md') and t < b.get(f, float('inf')):
            b[f] = t; n += 1
    os.makedirs(os.path.dirname(BIRTHS), exist_ok=True)
    tmp = BIRTHS + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(b, fh, indent=0, sort_keys=True)
    os.replace(tmp, BIRTHS); os.chmod(BIRTHS, 0o600)
    return n, len(b)

DIFFLOG = os.environ.get('EVAL_DIFFLOG', os.path.join(HOME, '.local/share/memory-eval/air-memory-diff.log'))
INCIDENT_HEAD = re.compile(r'^(#{2,4}\s|\*\*|- \*\*|\d+[.)、]\s*\*\*)')

def parse_difflog(by_name, births, path=None):
    """Air ~/.claude 仓 memory 路径的 `git log -p --reverse`（pull-air-replay.sh 每天 12:30 拉，只读）。
    返回 appended{(new, old): ts} 与 self_events{(file, 'YYYY-MM-DD'): heading}：
      appended    = 往【已存在的】文件里新写进一个指向 old 的链接（同一提交里删了又加=改写，不算新写）
      self_events = 往已存在 ≥1 天的 feedback 教训文件里追加 ## 小节（或带「变体/又一次/第N例」的加粗首句）= 这条教训又被踩了一次
    2026-09-23 双盲标（opus+sonnet，98 段）：检测到的 93% 是真复发；此前评估器完全没统计这一类，它与链接式复发同量级。"""
    path = path or DIFFLOG
    appended, self_events = {}, {}
    if not os.path.exists(path):
        return appended, self_events
    def flush(f, t, new, plus, minus):
        if not f or new or f not in births:
            return
        gone = {resolve(w, by_name) for ln in minus for w in WIKI.findall(ln)}
        for ln in plus:
            for w in WIKI.findall(ln):
                o = resolve(w, by_name)
                if o and o != f and o not in gone:
                    appended.setdefault((f, o), t)
        if t - births[f] < 86400 or not f.startswith('feedback_'):
            return   # 项目档案里追加的小节多是状态更新，不是教训复发（双盲标 2 段全判 NOT）
        old_heads = {ln.strip() for ln in minus}
        for ln in plus:
            h = ln.strip()
            if h in old_heads:
                continue   # 同一提交里删了又加 = 挪位置/改格式
            # 2026-09-23 双盲标：往老教训追加的 ## 小节 93% 是新一例（含「二犯/第五形态/日期：…」这类不带关键词的），
            # 加粗首句则要带「变体/又一次/第N例…」才算
            if re.match(r'^#{2,4}\s', h) or (INCIDENT_HEAD.match(h) and STRONG.search(h[:80])):
                self_events.setdefault((f, datetime.date.fromtimestamp(t).isoformat()), h[:120])
                break
    t = f = None; new = False; plus, minus = [], []
    for line in open(path, errors='replace'):
        if line.startswith('@@COMMIT '):
            flush(f, t, new, plus, minus); f = None
            t = int(line.split()[1]); continue
        if line.startswith('diff --git '):
            flush(f, t, new, plus, minus)
            f = os.path.basename(line.split()[-1]); new = False; plus, minus = [], []; continue
        if line.startswith('new file mode'):
            new = True; continue
        if line.startswith('+') and not line.startswith('+++'):
            plus.append(line[1:])
        elif line.startswith('-') and not line.startswith('---'):
            minus.append(line[1:])
    flush(f, t, new, plus, minus)
    return appended, self_events

def resolve(wiki, by_name):
    for k in (wiki, wiki.replace('-', '_'), wiki.replace('_', '-')):
        if k in by_name:
            return by_name[k]
    return None

TRJ_AIR = os.environ.get('EVAL_TRJ_AIR', os.path.join(HOME, '.mycc-global/0-System/trajectories-air'))   # 每日 12:30 从 Air 拉回（pull-air-replay.sh）

# ── lesson-nudge 各组对准的教训（按提醒文案归类，属推断；改提醒文案时同步改这里）──
# 用途：日报第 2b 节按周比「被提醒覆盖的教训」与「没覆盖的教训」的复发——提醒有效应表现为前者相对后者下降。
NUDGE_LIVE = datetime.datetime(2026, 9, 23)
NUDGE_COVER = {
    'A': ['acceptance_numbers_need_causal_link', 'verification_path_vs_production_path', 'probe_not_on_the_production_path',
          'absence_of_symptom_is_not_proof_of_fix', 'benefit_claim_needs_live_path_check', 'silent_non_events',
          'negative_result_needs_signal_capable_channel'],
    'B/M': ['asserted_the_side_i_cannot_see'],
    'C': ['truncated_output_negative_conclusion'],
}
# 2026-09-23 试过 D 组（数数/curl/读配置时泛泛三问）后回滚：触发面宽、最吵、无证据。
# 同日自然实验：no-guessing-guard 的窄守门（grep|head 截断、unit 名/端口）上线后，它盯的那种写法 7 周 0 复发，
# 复发全转移到它没盯的变体（cut -c、按主键过滤、git remote|head…）——有效的是「窄而具体」，不是「宽而泛」。
_COVER = {f'feedback_{x}.md': g for g, xs in NUDGE_COVER.items() for x in xs}

def cover_group(f):
    return _COVER.get(f)

# ── 严口径 ──
STRONG = re.compile(r'同族|同类|同一个坑|同一类|又一次|再次|又踩|第[二三四五六七八九十0-9]+[次例]|变体|同形|同根|复发|老毛病|重犯|同款')
STRONG_NEG = re.compile(r'反向|方向相反|相反|区别|不同于|别合并')   # 「反向同族」「这条讲 A 那条讲 B（别合并）」明说不是同一个坑
CTX_BEFORE, CTX_AFTER = 60, 10
STRICT = ('declared', 'strong')
FRONT = re.compile(r'\A---\n(.*?)\n---', re.S)
DECL_KEY = re.compile(r'^(\s*)recurrence_of:\s*(.*?)\s*$')

def _norm(x):
    x = x.strip().strip('\'"').strip()
    if x.startswith('[[') and x.endswith(']]'): x = x[2:-2]
    return x[:-3] if x.endswith('.md') else x

def declared_recurrence(body):
    """frontmatter 里的 recurrence_of。None = 没写这个字段（历史文件，走语境判定）；[] = 写了、作者明说不是复发。
    支持 `[a, b]` 行内列表、单值、YAML 块列表（下一行起 `- a`）。"""
    m = FRONT.match(body)
    if not m:
        return None
    lines = m.group(1).split('\n')
    for i, ln in enumerate(lines):
        k = DECL_KEY.match(ln)
        if not k:
            continue
        v = k.group(2)
        if v.startswith('['):
            items = re.split(r'[,\s]+', v.strip('[]'))
        elif v:
            items = [v]
        else:
            items = []
            for nxt in lines[i + 1:]:
                b = re.match(r'^(\s*)-\s*(.+?)\s*$', nxt)
                if not b or len(b.group(1)) < len(k.group(1)):
                    break
                items.append(b.group(2))
        return [x for x in map(_norm, items) if x]
    return None

def link_contexts(body, old, by_name, before=CTX_BEFORE, after=CTX_AFTER):
    """body 里每个解析到 old 的 [[x]] 的前后语境（含热索引短别名写法）。"""
    return [body[max(0, m.start() - before):m.end() + after]
            for m in WIKI.finditer(body) if resolve(m.group(1), by_name) == old]

def link_kind(body, old, by_name, declared):
    """declared / declared_not（字段优先）；strong / weak（无字段时看语境）。"""
    if declared is not None:
        return 'declared' if old in {resolve(d, by_name) for d in declared} else 'declared_not'
    # 2026-09-23 双盲标金标准（159 对）校准：窗口内精确率 64% / 召回率 50%；加否定词排除后验证集精确率 57%→65%、召回不变。
    # 去掉「同族」召回会从 52% 掉到 20%（多数真复发就写「同族」），所以保留。正则到顶了，往后靠 recurrence_of 字段。
    return 'strong' if any(STRONG.search(c) and not STRONG_NEG.search(c)
                           for c in link_contexts(body, old, by_name)) else 'weak'

def load_traces():
    out = {}
    for fp in glob.glob(os.path.join(TRJ, '*.jsonl')) + glob.glob(os.path.join(TRJ_AIR, '*.jsonl')):
        lines = [json.loads(l) for l in open(fp)]
        if lines:
            out[lines[0]['sid8']] = lines[1:]
    return out

def retrieved_before_write(events, new_file, old_file):
    """prefix-only：找到写 new_file 的第一个事件，看它之前有没有引用 old_file。
    找不到写入事件（例如 Write 不经 mem_refs 抓到）→ 用全会话作前缀并标 approx。"""
    write_idx = None
    for i, e in enumerate(events):
        if new_file in e.get('mem_refs', []):
            write_idx = i
            break
    prefix = events[:write_idx] if write_idx is not None else events
    hit = any(old_file in e.get('mem_refs', []) for e in prefix)
    return hit, (write_idx is not None)

def compute():
    """返回 (pairs, resident, mems, unresolved, new_count)。pairs 元素:
    (old_file, new_file, sid8, resident_section|None, retrieved(bool|None), exact_prefix)
    旧接口，dream-policy.py 在用；要严口径用 compute_full()。"""
    r = compute_full()
    return r['pairs'], r['resident'], r['mems'], r['unresolved'], r['new_count']

def compute_full():
    """compute() 的全部 + kinds{(old,new): declared|declared_not|strong|weak} + declared{new: list|None}
    + decl_unresolved Counter（字段里写了但解析不到的名字）。"""
    resident, slug2file = hot_resident()
    mems, by_name = load_all_memories()
    for k, v in slug2file.items():
        by_name.setdefault(k, v)
    traces = load_traces()
    cut = WINDOW_START.timestamp()
    births = load_births(mems)
    for b_, info in mems.items():
        info['birth'] = births[b_]
    appended, self_ev = parse_difflog(by_name, births)
    osid = {}
    for b_ in mems:
        m_ = OSID.search(open(os.path.join(MEM_DIR, b_), errors='replace').read(2500))
        osid[b_] = m_.group(1)[:8] if m_ else None

    pairs = []      # (old, new, sid8, resident_section|None, retrieved(bool|None), exact_prefix)
    kinds, declared_of = {}, {}
    unresolved, decl_unresolved = collections.Counter(), collections.Counter()
    new_count = 0
    dates, same_session = {}, 0
    late = {n for n, _ in appended}
    for b, info in sorted(mems.items()):
        if info['birth'] < cut and b not in late:
            continue
        body = open(os.path.join(MEM_DIR, b), errors='replace').read()
        declared = declared_recurrence(body)
        declared_of[b] = declared
        for d in declared or []:
            if not resolve(d, by_name):
                decl_unresolved[d] += 1
        # 字段里声明的也算候选对子：真值不该依赖正文里恰好写了链接
        links = [w for w in WIKI.findall(body) + (declared or []) if w not in (b[:-3], info['name'])]
        if not links:
            continue
        new_count += 1
        m = OSID.search(body)
        sid8 = m.group(1)[:8] if m else None
        seen = set()
        for w in dict.fromkeys(links):
            old = resolve(w, by_name)
            if not old or old == b:
                if w not in (declared or []):
                    unresolved[w] += 1
                continue
            if old in seen:
                continue   # 同一旧文件以别名+文件名各写一次，只算一对
            seen.add(old)
            when = appended.get((b, old), info['birth'])   # 后来追加的链接按追加时刻算，不按文件出生
            if when < cut:
                continue
            if mems[old]['birth'] >= when:
                continue   # 链接指向更晚写的文件，不是「旧坑」
            if sid8 and osid.get(old) == sid8:
                same_session += 1
                continue   # 同一会话写的两条 = 同一事件拆成两篇，不是「又踩旧坑」
            rsec = resident.get(old)
            if sid8 and sid8 in traces and (b, old) not in appended:
                hit, exact = retrieved_before_write(traces[sid8], b, old)
            else:
                hit, exact = None, False   # 追加进老文件的链接不知道是哪个会话写的
            pairs.append((old, b, sid8, rsec, hit, exact))
            kinds[(old, b)] = link_kind(body, old, by_name, declared)
            dates[(old, b)] = when

    selfs = [(f, day, h, resident.get(f)) for (f, day), h in sorted(self_ev.items())
             if f in mems and day >= f'{WINDOW_START:%Y-%m-%d}']
    return {'pairs': pairs, 'resident': resident, 'mems': mems, 'unresolved': unresolved,
            'new_count': new_count, 'kinds': kinds, 'declared': declared_of, 'decl_unresolved': decl_unresolved,
            'dates': dates, 'self_events': selfs, 'same_session': same_session,
            'difflog': os.path.exists(DIFFLOG)}


def _quad(p):
    return '常驻&仍踩' if p[3] else ('召回失败' if p[4] is False else ('翻到仍踩' if p[4] else '无轨迹'))

def _ret(ps):
    return dict(collections.Counter('无轨迹' if p[4] is None else ('已检索' if p[4] else '未检索') for p in ps))

def main():
    r = compute_full()
    pairs, mems, unresolved, new_count, kinds = r['pairs'], r['mems'], r['unresolved'], r['new_count'], r['kinds']
    dates, selfs = r['dates'], r['self_events']
    strict = [p for p in pairs if kinds[(p[0], p[1])] in STRICT]
    n_decl = sum(1 for p in pairs if kinds[(p[0], p[1])] == 'declared')
    by_old = collections.defaultdict(list)
    for p in pairs:
        by_old[p[0]].append(p)
    s_by_old = collections.defaultdict(list)      # 严口径：链接式对子 + 自身追加事件（后者 p[1] 记作 '（自身追加 日期）'）
    for p in strict:
        s_by_old[p[0]].append(p)
    for f, day, h, rsec in selfs:
        s_by_old[f].append((f, f'（自身追加 {day}）', None, rsec, None, False))
    n_strict = len(strict) + len(selfs)

    L = []; W = L.append
    W("# 评估器日报 —— 「我写下的教训」当摩擦真值（严口径=真值，宽口径=对照）\n")
    W(f"> 生成 {datetime.datetime.now().astimezone():%Y-%m-%d %H:%M %Z} · 脚本 `4-Assets/scripts/evaluate-memory-policy.py`（只读）\n")
    W(f"> 窗口 {WINDOW_START:%Y-%m-%d} 起 · **严口径复发 {n_strict}** = 链接式 {len(strict)}（字段声明 {n_decl} + 语境强标记 {len(strict) - n_decl}）"
      f"+ 自身追加 {len(selfs)} · 宽口径对子 {len(pairs)} · 严口径涉及旧教训 {len(s_by_old)} 条 · 同会话对子已排除 {r['same_session']} 个\n")
    if not r['difflog']:
        W(f"> ⚠️ 没有 Air 记忆差异日志（{DIFFLOG}）：追加时刻与「自身追加」都算不了，本报告低估复发。先跑 pull-air-replay.sh。\n")
    W("\n## 0. 读数前的声明\n")
    W("1. **两把尺子**。宽口径把正文里每个 [[旧教训]] 都当「又踩了它」，多数其实只是「关联/参见」——虚高上界，只作对照。"
      "**严口径是真值**，三个来源：①新记忆 frontmatter 的 `recurrence_of` 字段（作者自报，有字段就只认字段）；"
      "②没字段的历史文件，看链接前后语境有无「同族/又踩/变体/复发…」；③往老教训自己的文件里追加「变体/又一次/第 N 例」小节（取自 Air git 逐次差异）。"
      "准确率对照见 `1-Inbox/2026-09-23-评估器尺子校准.md`。")
    W("2. **时间用出生台账，不用 mtime**。编辑老文件、Air 同步回推都会刷新 mtime；台账记每个文件首次出现（历史由 Air git 首次入库回填），"
      "后来追加进老文件的链接按追加时刻算。同一会话写的两条互链算同一事件，不计复发。")
    W("3. **「常驻」用当前 MEMORY.md 近似「踩坑当时」**。某条若是窗口内才晋升的，会被误判为「常驻仍踩」。")
    n_tr = sum(1 for p in strict if p[4] is not None)
    W(f"4. **检索维只对 {n_tr}/{n_strict} 个严口径事件可判**。自身追加和追加链接不知道是哪个会话写的，检索维一律无轨迹（None，**不是 False**）。")
    decl_new = [b for b, v in r['declared'].items() if mems[b]['birth'] >= DECL_START.timestamp() and b.startswith('feedback_')]
    decl_yes = [b for b in decl_new if r['declared'][b] is not None]
    W(f"5. **`recurrence_of` 字段覆盖**：{DECL_START:%Y-%m-%d} 起新写的 feedback 教训 {len(decl_new)} 条，写了字段 {len(decl_yes)} 条。"
      "没写的回落到语境判定——覆盖率越高，严口径越接近真值。\n")

    W("\n## 1. 四象限（严 / 宽）\n")
    W("| 象限 | 严 | 其中自身追加 | 宽 | 含义 | 动作候选 |")
    W("|---|---:|---:|---:|---|---|")
    qs = collections.Counter(_quad(p) for p in strict); ql = collections.Counter(_quad(p) for p in pairs)
    sr = sum(1 for x in selfs if x[3]); sn = len(selfs) - sr
    W(f"| **常驻 & 仍踩** | {qs['常驻&仍踩'] + sr} | {sr} | {ql['常驻&仍踩']} | 在热索引里常驻，我还是踩了 | 动作时刻提醒 / hook 化 / 改写 |")
    W(f"| **非常驻 & 未检索 & 仍踩** | {qs['召回失败']} | — | {ql['召回失败']} | 库里有、没翻到、踩了 = **召回失败** | 晋升 / 改召回词 |")
    W(f"| 非常驻 & 已检索 & 仍踩 | {qs['翻到仍踩']} | — | {ql['翻到仍踩']} | 翻到了也没防住 | 认知类，改写措辞 |")
    W(f"| 非常驻 & 检索维无通道 | {qs['无轨迹'] + sn} | {sn} | {ql['无轨迹']} | 没轨迹，判不了 | 等轨迹积累 |")

    W("\n## 2. 按周复发（严口径）—— 判断动作时刻提醒有没有用的主指标\n")
    W("lesson-nudge A/B/C 组 2026-09-23 上线。上线后几周的「严口径合计 / 新记忆数」若不降，提醒就是无效的，该撤。\n")
    W("| 周（周一起） | 新记忆 | 严·链接式 | 严·自身追加 | **严合计** | 其中常驻 | 宽口径对子 |")
    W("|---|---:|---:|---:|---:|---:|---:|")
    monday = lambda d: d - datetime.timedelta(days=d.weekday())
    wk = lambda ts: monday(datetime.date.fromtimestamp(ts))
    new_files = [b for b, info in mems.items() if info['birth'] >= WINDOW_START.timestamp()]
    rows_w = collections.defaultdict(lambda: [0, 0, 0, 0, 0])
    for b in new_files:
        rows_w[wk(mems[b]['birth'])][0] += 1
    for p in pairs:
        w = wk(dates[(p[0], p[1])]); rows_w[w][4] += 1
        if kinds[(p[0], p[1])] in STRICT:
            rows_w[w][1] += 1; rows_w[w][3] += bool(p[3])
    for f, day, h, rsec in selfs:
        w = monday(datetime.date.fromisoformat(day)); rows_w[w][2] += 1; rows_w[w][3] += bool(rsec)
    for w in sorted(rows_w):
        a, b_, c, d, e = rows_w[w]
        W(f"| {w:%Y-%m-%d} | {a} | {b_} | {c} | **{b_ + c}** | {d} | {e} |")

    W("\n## 2b. 提醒覆盖 vs 未覆盖（严口径，双重差分）—— 提醒有效 = 覆盖的那几列相对「未覆盖」下降\n")
    W(f"A/B·M/C 各组对准的教训见脚本 NUDGE_COVER（按提醒文案归类，属推断）。{NUDGE_LIVE:%Y-%m-%d} 起 A/B/C/M 全部在线；"
      "周总数随活动量大起大落，所以只看比例：「覆盖 ÷ 未覆盖」在上线后若不降，提醒无效。\n")
    W("| 周（周一起） | A | B·M | C | 未覆盖 | 覆盖÷未覆盖 |")
    W("|---|---:|---:|---:|---:|---:|")
    evd = [(datetime.date.fromtimestamp(dates[(p[0], p[1])]), cover_group(p[0]) or '未覆盖') for p in strict] + \
          [(datetime.date.fromisoformat(day), cover_group(f) or '未覆盖') for f, day, h, rsec in selfs]
    cw = collections.defaultdict(collections.Counter)
    for d, g in evd:
        cw[monday(d)][g] += 1
    for w in sorted(cw):
        c = cw[w]; cov = sum(v for k, v in c.items() if k != '未覆盖')
        mark = ' ⬅ 提醒上线' if w == monday(NUDGE_LIVE.date()) else ''
        W(f"| {w:%Y-%m-%d}{mark} | {c['A']} | {c['B/M']} | {c['C']} | {c['未覆盖']} | "
          f"{(cov / c['未覆盖']) if c['未覆盖'] else float('nan'):.2f} |")
    live = NUDGE_LIVE.date()
    for name, sel in ((f'**上线前合计**（< {live:%m-%d}）', lambda d: d < live), (f'**上线后合计**（≥ {live:%m-%d}）', lambda d: d >= live)):
        c = collections.Counter(g for d, g in evd if sel(d)); cov = sum(v for k, v in c.items() if k != '未覆盖')
        W(f"| {name} | {c['A']} | {c['B/M']} | {c['C']} | {c['未覆盖']} | "
          f"{(cov / c['未覆盖']) if c['未覆盖'] else float('nan'):.2f} |")
    today = datetime.date.today()
    recent = sum(1 for d, g in evd if g == '未覆盖' and (today - d).days < 28) / 4
    post_un = sum(1 for d, g in evd if g == '未覆盖' and d >= live)
    need = max(0, 30 - post_un)
    W(f"\n单周比值波动极大（事件太少），只看两行合计。上线后「未覆盖」攒到 30 次再下结论（现 {post_un}）；"
      f"按最近 4 周的速率（每周 {recent:.1f} 次）还需约 {need / recent:.0f} 周。" if recent else
      f"\n单周比值波动极大，只看两行合计。最近 4 周没有未覆盖的复发，攒不出对照，暂时判不了。")

    W("\n## 3. 严口径「常驻 & 仍踩」排名\n")
    W("| 旧教训（常驻区） | 严 | 宽 | 复发它的新记忆 / 自身追加（最多 3 条） | 检索维 |")
    W("|---|---:|---:|---|---|")
    rows = sorted(((o, ps) for o, ps in s_by_old.items() if ps[0][3]), key=lambda x: (-len(x[1]), x[0]))
    for o, ps in rows:
        news = sorted(set(p[1][:-3] if p[1].endswith('.md') else p[1] for p in ps))
        W(f"| `{o[:-3]}` ({ps[0][3]}) | {len(ps)} | {len(by_old[o])} | {', '.join('`'+n[:45]+'`' for n in news[:3])} | {_ret(ps)} |")

    W("\n## 4. 严口径「召回失败」名单（库里有、没翻到、踩了）\n")
    W("| 旧教训 | 新记忆 | 前缀精确 |")
    W("|---|---|---|")
    rf = [p for p in strict if not p[3] and p[4] is False]
    for p in sorted(rf):
        W(f"| `{p[0][:-3]}` | `{p[1][:-3][:45]}` | {'是' if p[5] else '否（写入事件未定位，用全会话）'} |")
    if not rf:
        W("| （空） | | |")

    W("\n## 5. 非常驻但严口径复发 ≥2 次\n")
    W("| 旧教训 | 严 | 宽 | 检索维 |")
    W("|---|---:|---:|---|")
    rows3 = sorted(((o, ps) for o, ps in s_by_old.items() if not ps[0][3] and len(ps) >= 2), key=lambda x: (-len(x[1]), x[0]))
    for o, ps in rows3:
        W(f"| `{o[:-3]}` | {len(ps)} | {len(by_old[o])} | {_ret(ps)} |")
    if not rows3:
        W("| （空） | | | |")

    W("\n## 6. 负向验证\n")
    tgt = [p for p in pairs if p[0] == 'feedback_asserted_the_side_i_cannot_see.md' and p[1] == 'project_replay_world_phase0.md']
    if tgt:
        p = tgt[0]; k = kinds[(p[0], p[1])]
        expect = (p[3] is not None) and (p[4] is False) and k in STRICT
        W(f"- 已知事实：2026-09-17 会话 `4728ca46` 写 `project_replay_world_phase0` 时承认踩了 `asserted_the_side_i_cannot_see`（断言轨迹「非 git」没验）。"
          f"该旧教训**在 ★教训区常驻**，写之前**没有检索过它**，正文写的是「教训同族」。")
        W(f"- 评估器判定：resident={p[3]!r}, retrieved_before_write={p[4]!r}, 口径={k} → "
          f"{'✅ 落在严口径「常驻 & 仍踩 & 未检索」，与事实一致' if expect else '❌ 与事实不符，评估器有 bug'}")
    else:
        W("- ❌ 负向验证对子没找到——链接解析或窗口过滤有问题，本报告其余数字不可信。")

    W("\n## 7. 未解析\n")
    W("正文 [[x]] 指向的不是 A 库文件（会话级 memory、别名、笔误）Top 10：\n")
    for w, c in unresolved.most_common(10):
        W(f"- `{w}` × {c}")
    if r['decl_unresolved']:
        W("\n⚠️ `recurrence_of` 字段里写了但解析不到的名字（这些声明没被计入，去改字段）：\n")
        for w, c in r['decl_unresolved'].most_common():
            W(f"- `{w}` × {c}")

    print('\n'.join(L))

if __name__ == '__main__':
    import sys
    if sys.argv[1:2] == ['--seed-births']:
        n, tot = seed_births(sys.stdin)
        print(f'出生台账：回填 {n} 条，共 {tot} 个文件 → {BIRTHS}')
    else:
        main()
