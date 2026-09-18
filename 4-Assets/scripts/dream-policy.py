#!/usr/bin/env python3
"""dream-policy.py — Step 3 首轮 dreaming：在回放世界上评估热索引策略候选，输出 diff 提案。

⚠️ 与 Dream-RSI 的本质差距（必须写在前面）：
  论文的历史树里存了每个节点的真实评分，换策略只是换遍历顺序，所以能精确回放。
  我们的历史里只有「踩了」，没有「不常驻会怎样」的对照——**没有反事实就没有精确回放**。
  所以本脚本不做 argmax，做三件更诚实的事：
    1. 找两种世界观下都成立的动作（一致动作集）→ 这部分可以直接提案
    2. 把两种世界观的分歧名单摆出来 → 不拍，配时间切片验证
    3. 算字节账 → 一致动作集能不能让热索引回到线内

  世界观 A「常驻有边际效果」：踩 12 次是上界，不常驻会踩更多 → 点名多 = 高风险 = 留
  世界观 B「认知类常驻无效」：踩 12 次与常驻无关 → 点名多 = 常驻浪费 = 换形态
  数据分不出 A/B。这就是 Phase 0 报告里的悖论换了个形式。

只读。不写 MEMORY.md。产出是 diff 提案文本。
"""
import os, re, sys, json, glob, collections, datetime, importlib.util

HOME = os.path.expanduser('~')
MEM_DIR = os.path.join(HOME, '.claude/projects/-home-hahaxiong83-mycc/memory')
TRJ = os.path.join(HOME, '.mycc-global/0-System/trajectories')
HERE = os.path.dirname(os.path.abspath(__file__))
TRIPWIRE_KB = 40.0

spec = importlib.util.spec_from_file_location('ev', os.path.join(HERE, 'evaluate-memory-policy.py'))
ev = importlib.util.module_from_spec(spec); spec.loader.exec_module(ev)

LINK_ANY = re.compile(r'\[([^\]]+)\]\(([^)]+\.md)\)')
CLUSTER_RE = re.compile(r'^- \*\*(.+?)\*\*\(~?(\d+)\)[：:](.*?)→\s*`rg\s+\'(.+?)\'`')

# 验收类（评估器 Top 4）：三层都没拦住，两种世界观都同意「换形态」而非「留/删」
ACCEPTANCE_FAMILY = {
    'feedback_acceptance_numbers_need_causal_link.md',
    'feedback_verification_path_vs_production_path.md',
    'feedback_absence_of_symptom_is_not_proof_of_fix.md',
    'feedback_silent_non_events.md',
}

def parse_hot():
    """★教训区逐行：[(line_text, bytes, [(slug,file),...])]；场景簇：[(name, claimed, gist, rg_terms, line)]"""
    lessons, clusters, section = [], [], None
    lines = open(os.path.join(MEM_DIR, 'MEMORY.md'), errors='replace').read().split('\n')
    for line in lines:
        if line.startswith('## '):
            section = ('lesson' if '★ 教训' in line else 'cluster' if '场景簇' in line else None)
            continue
        if not line.startswith('- '):
            continue
        if section == 'lesson':
            links = LINK_ANY.findall(line)
            if links:
                lessons.append((line, len(line.encode()) + 1, links))
        elif section == 'cluster':
            m = CLUSTER_RE.match(line)
            if m:
                clusters.append((m.group(1), int(m.group(2)), m.group(3).strip(), m.group(4), line))
    return lessons, clusters

def sessions_citing():
    """回放世界：每个记忆文件被哪些会话引用（跨会话 = 有检索路径）。"""
    cited = collections.defaultdict(set)
    for fp in glob.glob(os.path.join(TRJ, '*.jsonl')):
        rows = [json.loads(l) for l in open(fp)]
        if not rows: continue
        sid = rows[0]['sid8']
        for e in rows[1:]:
            for r in e.get('mem_refs', []):
                cited[r].add(sid)
    return cited

def index_line(file):
    for line in open(os.path.join(MEM_DIR, 'INDEX-full.md'), errors='replace'):
        if f'({file})' in line:
            return line.rstrip('\n')
    return None

def keywords_from_file(file):
    stem = file[:-3]
    for p in ('feedback_', 'project_', 'reference_', 'user_'):
        if stem.startswith(p): stem = stem[len(p):]
    words = [w for w in stem.split('_') if len(w) >= 4 and w not in ('must', 'needs', 'that', 'with', 'from', 'into', 'your')]
    return words[:4]

def main():
    pairs, resident, mems, unresolved, new_count = ev.compute()
    lessons, clusters = parse_hot()
    cited = sessions_citing()
    hits = collections.Counter(p[0] for p in pairs)
    hot_total = os.path.getsize(os.path.join(MEM_DIR, 'MEMORY.md'))

    # 每条常驻教训的属性（按行；同行多链接取第一个为主）
    rows = []
    for line, nb, links in lessons:
        f = links[0][1]
        rows.append({
            'line': line, 'bytes': nb, 'file': f, 'slug': links[0][0], 'all_files': [x[1] for x in links],
            'hits': sum(hits.get(x[1], 0) for x in links),
            'sessions': len(set().union(*[cited.get(x[1], set()) for x in links])),
        })

    # ── 一致动作集 ──
    demote = [r for r in rows if r['sessions'] >= 2 and r['file'] not in ACCEPTANCE_FAMILY]
    demote.sort(key=lambda r: (-r['sessions'], -r['bytes']))
    # 晋升过滤（治「被点名是上界」）：点名者必须是 feedback 类（project/reference 链 feedback 多为「相关」非「踩了」），
    # 且来自 ≥2 个不同 originSessionId——同一会话连写三条互链不算三次踩坑。
    citers = collections.defaultdict(list)
    for old_f, new_f, sid8, _, _, _ in pairs:
        if new_f.startswith('feedback_'):
            citers[old_f].append(sid8)
    promote_cands = []
    for f, sids in citers.items():
        if f in resident or not f.startswith('feedback_'): continue
        if len(sids) >= 3 and len(set(sids)) >= 2:
            promote_cands.append((f, len(sids), len(set(sids))))
    promote_cands.sort(key=lambda x: (-x[1], -x[2]))
    reshape = [r for r in rows if r['file'] in ACCEPTANCE_FAMILY]

    demote_bytes = sum(r['bytes'] for r in demote)
    def shorten(l, limit=160):
        if not l or ' — ' not in l: return l
        head, gist = l.split(' — ', 1)
        g = gist.encode()[:limit].decode('utf-8', 'ignore').rstrip('，,、；;。 ')
        return f"{head} — {g}" + ('…' if len(gist.encode()) > limit else '')
    promote_lines = [(f, n, ns, shorten(index_line(f))) for f, n, ns in promote_cands]
    promote_bytes = sum(len((l or '').encode()) + 1 for _, _, _, l in promote_lines)
    cluster_add_bytes = sum(len(('|'.join(keywords_from_file(r['file']))).encode()) + 1 for r in demote)
    after = hot_total - demote_bytes + promote_bytes + cluster_add_bytes

    # ── 世界观分歧名单 ──
    cognitive = [r for r in rows if r['file'] not in ACCEPTANCE_FAMILY and r['sessions'] < 2]
    view_a_demote = sorted(cognitive, key=lambda r: (r['hits'], -r['bytes']))[:8]        # A：点名少+字节大 → 降
    view_b_demote = sorted(cognitive, key=lambda r: (-r['hits'], -r['bytes']))[:8]       # B：点名多 → 常驻无效 → 换形态

    L = []; W = L.append
    W("# Step 3 首轮 dreaming —— 热索引策略候选与 diff 提案（不写入）\n")
    W(f"> 生成 {datetime.datetime.now().astimezone():%Y-%m-%d %H:%M %Z} · 脚本 `4-Assets/scripts/dream-policy.py`（只读）\n")
    W(f"> 输入：评估器 {len(pairs)} 对归因 · 回放世界 {len(glob.glob(os.path.join(TRJ,'*.jsonl')))} 条轨迹 · 热索引 {hot_total/1024:.1f} KB（绊线 {TRIPWIRE_KB:.0f} KB）\n")

    W("\n## 0. 先说与 Dream-RSI 的差距\n")
    W("论文能精确回放，是因为历史树里存了每个节点的真实评分，换策略只是换遍历顺序。"
      "我们的历史里只有「踩了」，**没有「不常驻会怎样」的对照**。没有反事实就没有精确回放，所以本轮不做 argmax。")
    W("做三件更诚实的事：找两种世界观都成立的动作直接提案；把分歧名单摆出来配验证方案；算字节账。\n")
    W("| 世界观 | 含义 | 对「被点名 12 次的常驻条目」的读法 |")
    W("|---|---|---|")
    W("| **A 常驻有边际效果** | 踩 12 次是上界，不常驻会踩更多 | 高风险，留 |")
    W("| **B 认知类常驻无效** | 踩 12 次与常驻无关 | 常驻浪费，换形态 |")
    W("\n数据分不出 A/B。这是 Phase 0 那个悖论换了个形式。**能分出来的只有时间切片实验**（§4）。\n")

    # ── §1 一致动作集 ──
    W("\n## 1. 一致动作集（A/B 都支持，可直接提案）\n")
    W(f"### 1a. 降到场景簇：跨 ≥2 会话被主动检索过的常驻教训（{len(demote)} 条，省 {demote_bytes/1024:.1f} KB）\n")
    W("逻辑：我在那个场景**会去搜**，且搜得到。A 说检索能补常驻；B 说常驻本来就无效。两边都同意。\n")
    W("| 条目 | 跨会话数 | 被点名 | 字节 | 建议塞进簇 / 关键词 |")
    W("|---|---:|---:|---:|---|")
    for r in demote:
        kw = '|'.join(keywords_from_file(r['file']))
        flag = ' ⚠️ 名单内风险最高：仍被点名且字节大' if r['hits'] >= 3 else ''
        W(f"| `{r['slug']}` | {r['sessions']} | {r['hits']} | {r['bytes']} | `{kw}`{flag} |")
    W(f"\n### 1b. 晋升到 ★教训：非常驻、被点名 ≥3 次（{len(promote_lines)} 条，费 {promote_bytes/1024:.1f} KB）\n")
    W("逻辑：反复踩且不在眼前。A 说该晋升；B 说晋升也未必有用但**不会更差**（不劣动作）。\n")
    W("过滤：点名者须是 feedback 类且来自 ≥2 个不同会话（同一会话连写互链不算反复踩）。\n")
    W("| 条目 | 被点名 | 来自几个会话 | 晋升行（INDEX-full 行截到 160B） |")
    W("|---|---:|---:|---|")
    for f, n, ns, l in promote_lines:
        W(f"| `{f[:-3]}` | {n} | {ns} | {'✅' if l else '❌ 需手写'} |")
    W(f"\n### 1c. 形态改造：验收类四条（{len(reshape)} 条，{sum(r['bytes'] for r in reshape)/1024:.1f} KB，**不删不降**）\n")
    W("逻辑：`rules/workflow.md` Verify 段有规则 + 热索引常驻 + 部分 guard，三层都没拦住。A 说要加强，B 说换掉无效形态——两边都不是「留着不动」。\n")
    W("**提案**：PreToolUse(Bash) hook 在 `git commit|git push|deploy|systemctl restart` 类命令前注入四问："
      "①这个数字和目标有因果链吗 ②验的是生产路径还是我方便的路径 ③症状消失有没有其他解释 ④「没报错」是「没发生」还是「没通道」。"
      "hook 上线后这四条常驻行可压成一行指针。**这是 Step 4 的活，本轮只提案。**\n")
    for r in reshape:
        W(f"- `{r['slug']}`：被点名 {r['hits']}，{r['bytes']} B")

    # ── §2 字节账 ──
    W("\n## 2. 字节账\n")
    W("| 项 | KB |")
    W("|---|---:|")
    W(f"| 当前热索引 | {hot_total/1024:.1f} |")
    W(f"| 1a 降簇省 | −{demote_bytes/1024:.1f} |")
    W(f"| 1a 簇内加关键词 | +{cluster_add_bytes/1024:.2f} |")
    W(f"| 1b 晋升费 | +{promote_bytes/1024:.1f} |")
    W(f"| **一致动作后** | **{after/1024:.1f}** |")
    W(f"| 绊线 | {TRIPWIRE_KB:.0f} |")
    gap = after/1024 - TRIPWIRE_KB
    if gap > 0:
        W(f"\n**一致动作集不够回线内，还差 {gap:.1f} KB。** 剩下的只能从 §3 的分歧名单里出，而那要先做 §4 的实验。"
          f"或者承认 40 KB 这条线和 08-22 那次一样，又卡在真实需要量上了。\n")
    else:
        W(f"\n一致动作集已回线内（余量 {-gap:.1f} KB）。\n")

    # ── §2b 单列：三层都在仍踩 ──
    trunc = [r for r in rows if 'feedback_truncated_output_negative_conclusion.md' in r['all_files']]
    if trunc:
        t = trunc[0]
        W("\n## 2b. 单列一条：「阴性结论三兄弟」行\n")
        W(f"- 热索引里**最大的一行**：{t['bytes']} B（含 {len(t['all_files'])} 个链接）")
        W(f"- guard `truncate_head_tail` 事前提醒：回放窗口内 **152 次**（占 guard 全部命中 87%）")
        W(f"- 仍被新教训点名：**{t['hits']} 次**")
        W("- 常驻 + hook + 规则三层都在，仍是被踩最多的坑。**这比任何一条都更支持世界观 B**（形态无效），但 A 仍不能排除（不常驻可能踩 30 次）。")
        W("- 它不进一致动作集，但应是 §4 实验里**第一个单独观察的对象**：若 1b 结果支持 B，这行是第一个换形态的（例如改成 guard 硬 deny 一段时间，看阻碍 vs 收益）。\n")

    # ── §3 分歧名单 ──
    W("\n## 3. 分歧名单（A/B 结论相反，本轮不拍）\n")
    W("范围：常驻、非验收类、无跨会话检索路径的认知类教训。两个世界观各选 8 条「最该降」。\n")
    W("| 世界观 A 最该降（点名少、字节大 = 占位不干活） | 点名 | B | 世界观 B 最该降（点名多 = 常驻没用） | 点名 | B |")
    W("|---|---:|---:|---|---:|---:|")
    for i in range(8):
        a = view_a_demote[i] if i < len(view_a_demote) else None
        b = view_b_demote[i] if i < len(view_b_demote) else None
        W(f"| {'`'+a['slug']+'`' if a else ''} | {a['hits'] if a else ''} | {a['bytes'] if a else ''} | "
          f"{'`'+b['slug']+'`' if b else ''} | {b['hits'] if b else ''} | {b['bytes'] if b else ''} |")
    overlap = {r['file'] for r in view_a_demote} & {r['file'] for r in view_b_demote}
    W(f"\n两个名单交集：{len(overlap)} 条。{'交集为空说明 A/B 真的指向相反的动作。' if not overlap else '交集里的条目两边都嫌，可并入一致动作集。'}\n")

    # ── §4 验证方案 ──
    W("\n## 4. 时间切片实验（Dream-RSI 的「上线 → 扩池 → 再评」）\n")
    W("1. 执行 §1 一致动作集（川哥确认 diff 后我改 MEMORY.md，git 可回滚）。")
    W("2. 定时器每日积累轨迹（已在跑）。")
    W("3. **一个月后重跑评估器**，看两个数：")
    W("   - 1a 降簇的条目是否出现在「非常驻 & 未检索 & 仍踩」→ 出现 = 降错了，恢复该条；不出现 = 降对了。")
    W("   - 1b 晋升的条目被点名次数是否下降 → 下降支持 A；不变支持 B。")
    W("4. **§3 的 A/B 分歧由第 3 步的 1b 结果裁决**：支持 A 就按 A 名单降，支持 B 就按 B 名单换形态。")
    W("5. 每轮把结果追加进评估器报告，形成 Dream-RSI 的「模拟器池」——越跑越准。\n")

    # ── §5 diff ──
    W("\n## 5. MEMORY.md diff 提案（一致动作集，供确认；本脚本不写入）\n")
    W("```diff")
    for r in demote:
        W(f"- {r['line']}")
    for f, n, ns, l in promote_lines:
        if l: W(f"+ {l}")
    W("```")
    W("\n场景簇追加关键词（按建议簇手工塞入对应行的 rg 词表）：")
    for r in demote:
        W(f"- `{r['slug']}` → `{'|'.join(keywords_from_file(r['file']))}`")

    print('\n'.join(L))

if __name__ == '__main__':
    main()
