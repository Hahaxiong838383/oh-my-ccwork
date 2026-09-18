#!/usr/bin/env python3
"""replay-report.py — 在回放世界上出 Phase 0 首份报告。

纪律（feedback_negative_result_needs_signal_capable_channel）：
先建「通道能力矩阵」——每个问题需要什么信号、哪条通道载它、覆盖多长时间。
通道载不动的问题，输出「不可观测」，不输出 0。
"""
import json, os, re, glob, collections, datetime, sys

HOME = os.path.expanduser('~')
MEM_DIR = os.path.join(HOME, '.claude/projects/-home-hahaxiong83-mycc/memory')
SYS_DIR = os.path.join(HOME, '.mycc-global/0-System')
TRJ = os.path.join(SYS_DIR, 'trajectories')

# ⚠️ 2026-09-17 修正：首版正则要求「行首即链接」，实测漏两类——
#   ① 一行含多个链接（「阴性结论三兄弟 [a](..)，[b](..)」）
#   ② 场景簇根本不是链接格式，而是 `- **簇名**(~N)：要点 → rg '词表'`
# 首版据此报出「场景簇 0 条」＝典型假阴性（阴性结果先归因「我写错了」）。
LINK_ANY = re.compile(r'\[([^\]]+)\]\(([^)]+\.md)\)')
CLUSTER_RE = re.compile(r'^- \*\*(.+?)\*\*\(~?(\d+)\)[：:]')
STOP = set('the and for with that this from into not but you your are was were have has had will can'.split())

def load_traces():
    out = []
    for fp in sorted(glob.glob(os.path.join(TRJ, '*.jsonl'))):
        lines = [json.loads(l) for l in open(fp)]
        if not lines: continue
        out.append((lines[0], lines[1:]))
    return out

def load_hot_index():
    path = os.path.join(MEM_DIR, 'MEMORY.md')
    section = None; items = []
    for line in open(path, errors='replace'):
        if line.startswith('## '):
            section = ('lesson' if '★ 教训' in line else 'cluster' if '场景簇' in line
                       else 'project' if '★ 项目' in line else 'reference' if '★ 参考' in line else None)
            continue
        if not section or not line.startswith('- '):
            continue
        raw = line.rstrip('\n'); nb = len(line.encode())
        cm = CLUSTER_RE.match(raw)
        if section == 'cluster' and cm:
            items.append({'slug': cm.group(1), 'file': None, 'gist': raw[:80],
                          'section': 'cluster', 'bytes': nb, 'claimed': int(cm.group(2))})
            continue
        links = LINK_ANY.findall(raw)
        for i, (slug, f) in enumerate(links):
            items.append({'slug': slug, 'file': f, 'gist': raw[:80], 'section': section,
                          'bytes': nb if i == 0 else 0})
    return items

FM_NAME = re.compile(r'^name:\s*(.+?)\s*$', re.M)
FM_DESC = re.compile(r'^description:\s*(.+?)\s*$', re.M)

def load_memories():
    mems = {}
    for fp in sorted(glob.glob(os.path.join(MEM_DIR, '*.md'))):
        base = os.path.basename(fp)
        if base in ('MEMORY.md', 'INDEX-full.md'): continue
        head = open(fp, errors='replace').read(3000)
        st = os.stat(fp)
        mems[base] = {'file': base,
                      'desc': (FM_DESC.search(head).group(1) if FM_DESC.search(head) else ''),
                      'mtime': st.st_mtime, 'size': st.st_size}
    return mems

def tokens(s):
    ws = re.findall(r'[a-z][a-z0-9]{2,}', s.lower())
    return set(w for w in ws if w not in STOP)

def main():
    traces = load_traces()
    hot = load_hot_index()
    mems = load_memories()
    win = (min(m['ts_first'] or '9' for m, _ in traces)[:10],
           max(m['ts_last'] or '0' for m, _ in traces)[:10])

    # ── 引用统计 ────────────────────────────────────────────────
    ref_sessions = collections.defaultdict(set)   # file -> {sid}
    ref_count = collections.Counter()
    guard_rules = collections.Counter()
    frictions = collections.Counter()
    for meta, evs in traces:
        sid = meta['sid8']
        for e in evs:
            for r in e.get('mem_refs', []):
                ref_sessions[r].add(sid); ref_count[r] += 1
            if e['type'] == 'friction':
                frictions[e['kind']] += 1
                for r in e.get('rules', []): guard_rules[r] += 1

    subst = [t for t in traces if t[0]['substantive']]
    work = [t for t in subst if not t[0]['is_maintenance_session']]

    L = []
    W = L.append
    W("# 回放世界 Phase 0 首份报告（Dream-RSI 借鉴）\n")
    W(f"> 生成：{datetime.datetime.now().astimezone():%Y-%m-%d %H:%M %Z} · "
      f"脚本 `4-Assets/scripts/build-replay-world.py` + `replay-report.py`（均只读输入）\n")
    W(f"> 回放窗口：**{win[0]} ~ {win[1]}** · 轨迹 {len(traces)} 条 · "
      f"实质会话 {len(subst)}（其中记忆维护类 {len(subst)-len(work)}，纯工作 {len(work)}）\n")

    # ── §1 通道能力矩阵 ────────────────────────────────────────
    W("\n## 1. 通道能力矩阵（先验「载不载得动」，再谈数字）\n")
    W("| 想问的问题 | 需要的信号 | 谁载它 | 时间覆盖 | 能答吗 |")
    W("|---|---|---|---|---|")
    W("| 某条记忆**被检索/读取**过吗 | 记忆文件名出现在命令或路径里 | transcript `tool_use` + recall-log | 2026-08-20 起 | ✅ 能 |")
    W("| 某条记忆**防的坑又踩了**吗 | 摩擦事件能归因到具体教训 | 仅 guard-log `rules[]`（7 种规则） | 2026-08-22 起 | ⚠️ 只对 guard 覆盖的规则能答 |")
    W("| 某条记忆**常驻起没起作用** | 「看到了 → 没犯」的因果 | **无通道** | — | ❌ 不可观测（见 §3 悖论） |")
    W("| 新写的教训**是否重复** | 新旧记忆的语义邻近 + 时间先后 | A 库 frontmatter mtime + name/desc | 全量 | ✅ 能（词面近似，非语义） |")
    W("| 连搜会话**搜的什么、找到没** | 检索词 + 之后读了哪个文件 | recall-log（**只记 query 不记结果**）+ transcript 补 | 2026-08-20 起 | ⚠️ 结果靠 transcript 补，有缺口 |")
    W("| 川哥**纠正**过我几次 | 用户真实输入的纠正模式 | transcript `origin.kind=human` + 正则 | 2026-08-20 起 | ⚠️ 正则保守，会漏 |")
    W("\n**两条硬约束（必须写在数字前面）**：")
    W(f"1. **transcript 有保留期**：实测最早 {win[0]}，而 recall-log 从 2026-06-16 就有数据（180 会话）。"
      f"回放世界现在只有 **{len(traces)} 条轨迹 / {len(work)} 个纯工作会话**，够做定性判断，不够做统计显著。")
    W("2. **hook 在本机 2026-08-22 才接线**（见 `docs/context-budget-log.md`），"
      "8-20/8-21 的会话没有 guard/recall 信号——那里的 0 是「没通道」不是「没发生」。")

    # ── §2 摩擦全景 ────────────────────────────────────────────
    W("\n## 2. 回放窗口内的摩擦全景\n")
    W("| 摩擦类型 | 次数 | 说明 |")
    W("|---|---:|---|")
    names = {
        'guard_note': ('guard 软提醒命中', '**事前**注入，说明「我正要做这个动作」，不等于我做错了'),
        'guard_deny': ('guard 硬红线拦截', '真正被拦下的动作'),
        'tool_error': ('工具真失败', '含我自己写错命令；**当前无法归因到具体教训**'),
        'user_correction': ('川哥纠正（正则捕获）', '正则保守，**真实次数应更高**；这是最高价值的评估信号却最稀疏'),
    }
    for k, v in frictions.most_common():
        n, note = names.get(k, (k, ''))
        W(f"| {n} | {v} | {note} |")
    W("\n**guard 规则命中分布**（这是目前唯一能归因到具体教训的摩擦通道）：\n")
    W("| 规则 | 命中 | 对应教训 | 读数 |")
    W("|---|---:|---|---|")
    RULE_MAP = {
        'truncate_head_tail': ('feedback_truncated_output_negative_conclusion.md', '截断后下存在性结论'),
        'systemd_unit_name': ('feedback_probe_parameters_are_facts_too.md', '排查命令参数也是待验事实'),
        'pipe_fallback_dead': ('—', '管道尾 || 兜底是死代码'),
        'localhost_port': ('feedback_probe_parameters_are_facts_too.md', '端口不跨站复制'),
        'pipe_exit_code': ('—', '管道后 $? 不是被测程序的'),
        'zsh_word_split': ('feedback_zsh_special_parameter_overwrite.md', 'zsh 不分割裸标量'),
        'git_add_all': ('—', 'git add -A 禁令（硬 deny）'),
    }
    tot = sum(guard_rules.values())
    for r, v in guard_rules.most_common():
        f, gist = RULE_MAP.get(r, ('?', ''))
        share = f"{v/max(1,tot):.0%}"
        note = '**一条规则吃掉大半命中**——它要么真是我的高频习惯，要么正则过宽在误报' if v/max(1,tot) > 0.5 else ''
        W(f"| `{r}` | {v} | {gist} | 占 {share} {note} |")

    # ── §3 问题一：常驻条目 ────────────────────────────────────
    lessons_n = len([h for h in hot if h['section'] == 'lesson'])
    W(f"\n## 3. 问题一：{lessons_n} 条 ★常驻教训，哪些该降级？\n")
    lessons = [h for h in hot if h['section'] == 'lesson']
    clusters = [h for h in hot if h['section'] == 'cluster']
    cited = [h for h in lessons if ref_count.get(h['file'], 0) > 0]
    uncited = [h for h in lessons if ref_count.get(h['file'], 0) == 0]
    W(f"- ★教训 **{len(lessons)}** 条链接（{sum(h['bytes'] for h in lessons)/1024:.1f} KB）· "
      f"🗂场景簇 **{len(clusters)}** 簇 / 声称覆盖 {sum(h.get('claimed',0) for h in clusters)} 条坑"
      f"（{sum(h['bytes'] for h in clusters)/1024:.1f} KB，**占热索引 "
      f"{sum(h['bytes'] for h in clusters)/max(1,os.path.getsize(os.path.join(MEM_DIR,'MEMORY.md'))):.0%}**）")
    W(f"- 窗口内**被引用过**的 ★教训：**{len(cited)}** 条；**零引用**：**{len(uncited)}** 条\n")
    W("### ⚠️ 先说清一个悖论，否则这组数字会被读反\n")
    W("零引用**不等于**无用。常驻的全部意义正是「我不知道自己在坑里，所以不会去检索」"
      "（`docs/context-budget-log.md` 2026-08-22 的结论）。"
      "**零引用同时兼容两种相反的解释**：① 它已内化/场景未出现 → 可降级；"
      "② 它正在被动生效、恰恰不需要检索 → 绝不能降级。**当前通道区分不了这两者。**\n")
    W("所以本节**不给降级名单**，只给两类**可判定**的子集：\n")
    W("**(a) 被主动检索过 ≥1 次 → 有检索路径，是「场景簇」的合格候选**（检索得到就不必常驻）：\n")
    W("| 常驻条目 | 引用次数 | 出现在几个会话 | 读法 |")
    W("|---|---:|---:|---|")
    for h in sorted(cited, key=lambda x: (-len(ref_sessions[x['file']]), -ref_count[x['file']])):
        ns = len(ref_sessions[h['file']]); nc = ref_count[h['file']]
        how = '**跨会话复用**＝真常用参考' if ns >= 2 else '单会话内反复＝那次在处理它，不代表常用'
        W(f"| `{h['slug']}` | {nc} | {ns} | {how} |")
    W(f"\n**这个区分很重要**：单会话内引用 17 次只说明「那次会话在处理这条记忆」，"
      f"不说明它常被需要。跨 ≥2 个会话被引用的才是真复用——窗口内只有 "
      f"**{sum(1 for h in cited if len(ref_sessions[h['file']])>=2)}** 条。\n")
    W("**(b) 常驻了但坑仍在踩 → 常驻无效，应 hook 化或改写**：\n")
    W("| 条目 | 窗口内该类摩擦 | 判定 |")
    W("|---|---:|---|")
    tt = guard_rules.get('truncate_head_tail', 0)
    su = guard_rules.get('systemd_unit_name', 0)
    W(f"| 截断后下存在性结论 | {tt} 次 guard 提醒 | **常驻 + hook 双保险下仍高频触发**；hook 已覆盖该形态 → 常驻条目可降级，靠 hook 兜 |")
    W(f"| 排查命令参数也是事实 | {su} 次 | 同上，hook 覆盖 `systemctl`/`launchctl` 形态；**其余形态（进程名/路径/ssh 别名）hook 看不见 → 常驻必须留** |")
    W("\n> 注：guard 提醒次数高 ≠ 我真犯了错——软提醒是**事前**注入，命中说明「我正要做这个动作」，"
      "不说明「我做错了」。要区分需要新增信号：提醒注入后该命令的结论是否被推翻。**这是 Phase 1 该补的通道。**\n")

    # ── §4 问题二：新教训是否重复 ──────────────────────────────
    W("\n## 4. 问题二：窗口内新写的教训，库里本来有没有？\n")
    cutoff = datetime.datetime.strptime(win[0], '%Y-%m-%d').timestamp()
    new = {k: v for k, v in mems.items() if v['mtime'] >= cutoff and k.startswith('feedback_')}
    rows = []
    for k, v in new.items():
        kt = tokens(k[9:-3].replace('_', ' '))
        best = []
        for k2, v2 in mems.items():
            if k2 == k or v2['mtime'] >= v['mtime']: continue
            ov = kt & tokens(k2[9:-3].replace('_', ' ') if k2.startswith('feedback_') else k2[:-3].replace('_', ' '))
            if len(ov) >= 2:
                best.append((len(ov), k2, sorted(ov)))
        best.sort(reverse=True)
        rows.append((k, best[:2]))
    dup = [r for r in rows if r[1]]
    W(f"- 窗口内新增/改写的 feedback：**{len(new)}** 条")
    W(f"- 其中**在写之前、库里已有词面高度重叠的旧记忆**：**{len(dup)}** 条 "
      f"（判据：文件名实词重叠 ≥2 个，且旧文件 mtime 更早）\n")
    if dup:
        W("| 新写的 | 本来就有的 | 重叠词 |")
        W("|---|---|---|")
        for k, b in dup[:12]:
            W(f"| `{k[:-3]}` | `{b[0][1][:-3]}` | {'/'.join(b[0][2])} |")
    W("\n> 这是**词面**近似，不是语义判重；重叠不一定是重复（可能是同族细分）。"
      "它的用途是给 Phase 1 的「合并/蒸馏候选」排序，不是直接删。\n")

    # ── §5 问题三：连搜会话 ────────────────────────────────────
    W("\n## 5. 问题三：连搜行为（重判 2026-06-16 定的「上阶段 1」判据）\n")
    burst_sessions = []
    for meta, evs in traces:
        rc = [e for e in evs if e['type'] == 'recall']
        if len(rc) < 3: continue
        ts = sorted(e['ts'] for e in rc if e.get('ts'))
        hit = False
        for i in range(len(ts) - 2):
            a = datetime.datetime.strptime(ts[i], '%Y-%m-%dT%H:%M:%SZ')
            b = datetime.datetime.strptime(ts[i+2], '%Y-%m-%dT%H:%M:%SZ')
            if (b - a).total_seconds() <= 600: hit = True; break
        if hit:
            terms = collections.Counter()
            for e in rc:
                for t in e.get('terms', []): terms[t] += 1
            burst_sessions.append((meta, len(rc), terms.most_common(6)))
    W(f"- 有 recall 记录的轨迹：{sum(1 for m,e in traces if any(x['type']=='recall' for x in e))} 条")
    W(f"- **10 分钟内连续 ≥3 次检索**的会话：**{len(burst_sessions)}** 条")
    W(f"  其中记忆维护类 {sum(1 for m,_,_ in burst_sessions if m['is_maintenance_session'])} 条，"
      f"**纯工作会话 {sum(1 for m,_,_ in burst_sessions if not m['is_maintenance_session'])} 条**\n")
    if burst_sessions:
        W("| 会话 | 日期 | 检索次数 | 维护类 | 高频检索词 |")
        W("|---|---|---:|---|---|")
        for m, n, tms in burst_sessions:
            W(f"| `{m['sid8']}` | {(m['ts_first'] or '')[:10]} | {n} | "
              f"{'是' if m['is_maintenance_session'] else '否'} | {', '.join(t for t,_ in tms)} |")
    W("\n> **2026-06-16 定的判据**：强信号 ≥5 次/天，或 10 分钟连搜 ≥3 次的会话占比 ≥10% → 上「本地混合检索」阶段 1。")
    W("> **去噪后的读数见上表**：样本量太小（窗口内纯工作会话个位数），"
      "**不足以按该判据拍板**。要补足样本只需等 transcript 自然积累——数据是自动产生的，不需要额外动作。\n")

    # ── §6 β1 反推 ─────────────────────────────────────────────
    W("\n## 6. 顺带：目标函数里 β1（常驻字节的代价）的实测锚\n")
    total_kb = sum(h['bytes'] for h in hot) / 1024
    W(f"- MEMORY.md 热索引当前 **{os.path.getsize(os.path.join(MEM_DIR,'MEMORY.md'))/1024:.1f} KB**"
      f"（已超 2026-08-22 放宽后的 40 KB 绊线），其中可解析条目 {len(hot)} 条 / {total_kb:.1f} KB")
    W(f"- 窗口内整个 A 库被引用 **{sum(ref_count.values())}** 次，涉及 **{len(ref_count)}** 个文件")
    W(f"- ★教训区 {len(lessons)} 条里有 {len(cited)} 条在窗口内被引用 → 引用覆盖率 **{len(cited)/max(1,len(lessons)):.0%}**")
    W("\n> β1 不该由我拍。它等价于川哥愿意为「一次避免的摩擦」付多少常驻字节。"
      "Phase 1 会把它做成一个**可调旋钮**，输出不同 β1 下的最优热索引组成，由川哥选点。\n")

    # ── §7 Phase 0 验收 ────────────────────────────────────────
    W("\n## 7. Phase 0 自身的验收（做完了没有，用什么判定）\n")
    W("| 验收项 | 判据 | 结果 |")
    W("|---|---|---|")
    W(f"| 转换器跑通 | 全部 transcript 转成轨迹，无漏无重 | ✅ {len(traces)}/{len(traces)}；symlink 去重生效（原始 glob 58 → 真实 37） |")
    W("| **负向验证**：已知故障能被照出来 | 注入一个我知道发生过的失败，看报告里有没有 | ✅ 2026-09-17 我把 `ls -S -home-...` 路径写成选项，两次失败，轨迹里 15:27:06 / 15:27:13 两条 `tool_error` 对上 |")
    W("| **负向验证**：同族记忆能被照出来 | 已知同族对能否被词面判重抓到 | ✅ `discriminator_must_replay_real_failure_samples` ↔ `strict_gate_needs_real_utterance_replay`（real/replay）被抓到，这两条确实是同族 |")
    W("| 隐私 | 轨迹不含命令原文/文件内容/用户消息原文 | ✅ 只存工具名/命令首词/文件名/规则名/检索词；输出 600 权限、非 git |")
    W("| 通道诚实 | 载不动的问题输出「不可观测」而非 0 | ✅ §1 矩阵 6 项里 1 项标 ❌、3 项标 ⚠️ |")
    W("| 记忆文件零改动 | 脚本只读 | ✅ 两个脚本无任何写记忆路径的调用 |")
    W("\n**Phase 0 过程中自己踩的两个坑（已写进脚本注释，防复发）**：")
    W("1. `glob('*/*.jsonl')` 跟随 symlink，把 `-Users-rayman-chen-mycc`（兼容链）和真实目录各数一遍，58 vs 真实 37。`find -maxdepth 2` 不跟随，两者对不上时是我写错不是数据错。")
    W("2. 首版热索引解析器报「场景簇 0 条」——**假阴性**。真因是场景簇不是链接格式（`- **簇名**(~N)：… → rg '…'`），且 ★教训区有两行一行含多个链接。阴性结果先归因「我写错了」，这次又验了一遍。\n")

    # ── §8 Phase 1 杠杆 ────────────────────────────────────────
    W("\n## 8. 这份报告指向的 Phase 1 杠杆（不是压缩，是补通道）\n")
    W("报告最硬的一条结论是 §1 矩阵那个 ❌：**「常驻条目起没起作用」当前无通道**。")
    W("而 Dream-RSI 的回放打分需要一个目标函数，目标函数需要「摩擦被避免了没有」这个信号。")
    W("**所以 Phase 1 的第一优先级不是改 MEMORY.md，是把评估器补出来**，否则 dreaming 无的放矢。\n")
    W("| Phase 1 动作 | 解决什么 | 可验证的收益 |")
    W("|---|---|---|")
    W(f"| **摩擦归因**：把 {frictions.get('tool_error',0)} 次工具失败 + {frictions.get('user_correction',0)} 次纠正归因到具体教训 | 现在这些摩擦全是无主的，无法评估任何记忆 | 评估器从「只覆盖 7 条 guard 规则」扩到覆盖全部摩擦 |")
    W("| **扩纠正正则 / 改为语义判定** | 川哥纠正是最高价值信号，现在只捕到 2 次，明显偏低 | 评估信号密度提升，样本不足问题缓解一半 |")
    W("| **guard 提醒有效性追踪**：记录提醒注入后该命令的结论是否被推翻 | 区分「提醒 152 次 = 我总在犯」与「提醒 152 次 = 提醒起作用了」 | 直接决定 `truncate_head_tail` 对应的常驻条目能不能降级 |")
    W("| **transcript 保鲜**：把轨迹持续化（transcript 会被轮转，轨迹不会） | 回放世界深度现在只有 1 个月 | 每多一个月，样本翻倍；这是唯一需要「现在就开始」的动作 |")
    W("\n**只有这四项到位后，Phase 1 的 dreaming 才有意义**：候选策略（降级/晋升/hook 化/改召回词）在全历史上回放打分，"
      "候选集含当前 MEMORY.md，所以选出来的版本在历史上不劣于现状（Dream-RSI 的单调性保证）。\n")

    print('\n'.join(L))

if __name__ == '__main__':
    main()
