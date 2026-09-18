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

只读。不改任何记忆文件。
"""
import os, re, glob, json, datetime, collections

HOME = os.path.expanduser('~')
MEM_DIR = os.path.join(HOME, '.claude/projects/-home-hahaxiong83-mycc/memory')
TRJ = os.path.join(HOME, '.mycc-global/0-System/trajectories')
WINDOW_START = datetime.datetime(2026, 8, 20)

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

def resolve(wiki, by_name):
    for k in (wiki, wiki.replace('-', '_'), wiki.replace('_', '-')):
        if k in by_name:
            return by_name[k]
    return None

def load_traces():
    out = {}
    for fp in glob.glob(os.path.join(TRJ, '*.jsonl')):
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
    (old_file, new_file, sid8, resident_section|None, retrieved(bool|None), exact_prefix)"""
    resident, slug2file = hot_resident()
    mems, by_name = load_all_memories()
    for k, v in slug2file.items():
        by_name.setdefault(k, v)
    traces = load_traces()
    cut = WINDOW_START.timestamp()

    pairs = []      # (old, new, sid8, resident_section|None, retrieved(bool|None), exact_prefix)
    unresolved = collections.Counter()
    new_count = 0
    for b, info in sorted(mems.items()):
        if info['mtime'] < cut:
            continue
        body = open(os.path.join(MEM_DIR, b), errors='replace').read()
        links = [w for w in WIKI.findall(body) if w not in (b[:-3], info['name'])]
        if not links:
            continue
        new_count += 1
        m = OSID.search(body)
        sid8 = m.group(1)[:8] if m else None
        for w in dict.fromkeys(links):
            old = resolve(w, by_name)
            if not old or old == b:
                unresolved[w] += 1
                continue
            if mems[old]['mtime'] >= info['mtime']:
                continue   # 链接指向更晚写的文件，不是「旧坑」
            rsec = resident.get(old)
            if sid8 and sid8 in traces:
                hit, exact = retrieved_before_write(traces[sid8], b, old)
            else:
                hit, exact = None, False
            pairs.append((old, b, sid8, rsec, hit, exact))

    return pairs, resident, mems, unresolved, new_count


def main():
    pairs, resident, mems, unresolved, new_count = compute()
    traces = load_traces()
    # ── 聚合到旧记忆 ──
    by_old = collections.defaultdict(list)
    for p in pairs:
        by_old[p[0]].append(p)

    L = []; W = L.append
    W("# 评估器 v0 首份产出 —— 「我写下的教训」当摩擦真值\n")
    W(f"> 生成 {datetime.datetime.now().astimezone():%Y-%m-%d %H:%M %Z} · 脚本 `4-Assets/scripts/evaluate-memory-policy.py`（只读）\n")
    W(f"> 窗口 {WINDOW_START:%Y-%m-%d} 起 · 新记忆（带同族链接）{new_count} 条 · 归因对子 {len(pairs)} 个 · "
      f"涉及旧记忆 {len(by_old)} 条 · 未解析链接 {sum(unresolved.values())} 个\n")
    W("\n## 0. 读数前的两条声明\n")
    W("1. **「常驻」用当前 MEMORY.md 近似「踩坑当时」**。本机 `~/.claude` 不是 git 仓，热索引没有历史可回溯。窗口只有 1 个月，近似可接受，但某条若是窗口内才晋升的，会被误判为「常驻仍踩」。")
    n_tr = sum(1 for p in pairs if p[4] is not None)
    W(f"2. **检索维只对 {n_tr}/{len(pairs)} 个对子可判**（其余会话没有轨迹：transcript 已轮转或记忆来自 Mac 侧）。"
      f"无轨迹的对子 retrieved=None，**不是 False**。这正是 Step 2 定时器要解决的。\n")

    # ── 四象限 ──
    q_res = [p for p in pairs if p[3]]
    q_nres_nret = [p for p in pairs if not p[3] and p[4] is False]
    q_nres_ret = [p for p in pairs if not p[3] and p[4] is True]
    q_nres_unk = [p for p in pairs if not p[3] and p[4] is None]
    W("3. **「被点名」是上界**。我写新记忆时在正文链 [[同族]] 有两种意思：这次踩的就是它的变体；或它只是相关的邻居。"
      "v0 不区分（区分要读正文），所以「被点名 11 次」读作「最多 11 次」。排名的相对顺序仍有意义。\n")
    W("\n## 1. 四象限（按归因对子数）\n")
    W("| 象限 | 对子数 | 含义 | 动作候选 |")
    W("|---|---:|---|---|")
    W(f"| **常驻 & 仍踩** | {len(q_res)} | 在热索引里常驻，我还是踩了 | hook 化 / 改写；常驻位可让出 |")
    W(f"| **非常驻 & 未检索 & 仍踩** | {len(q_nres_nret)} | 库里有、没翻到、踩了 = **召回失败** | 晋升 / 改场景簇关键词 |")
    W(f"| 非常驻 & 已检索 & 仍踩 | {len(q_nres_ret)} | 翻到了也没防住 | 认知类，改写措辞 |")
    W(f"| 非常驻 & 检索维无通道 | {len(q_nres_unk)} | 没轨迹，判不了 | 等 Step 2 积累 |")

    # ── 常驻仍踩 排名 ──
    W("\n## 2. 「常驻 & 仍踩」排名（被几条新教训点名 = 同类坑踩了几次）\n")
    W("这是 Phase 1 dreaming 最硬的输入：**常驻 + hook 双保险都没拦住的，常驻位是浪费的**。\n")
    W("| 旧记忆（常驻区） | 被点名次数 | 点名它的新教训（最多 3 条） | 检索维 |")
    W("|---|---:|---|---|")
    rows = [(o, ps) for o, ps in by_old.items() if ps[0][3]]
    rows.sort(key=lambda x: -len(x[1]))
    for o, ps in rows:
        news = sorted(set(p[1][:-3] for p in ps))
        ret = collections.Counter('无轨迹' if p[4] is None else ('已检索' if p[4] else '未检索') for p in ps)
        W(f"| `{o[:-3]}` ({ps[0][3]}) | {len(ps)} | {', '.join('`'+n[:45]+'`' for n in news[:3])} | {dict(ret)} |")

    # ── 召回失败 ──
    W("\n## 3. 「召回失败」名单（库里有、没翻到、踩了）\n")
    W("| 旧记忆 | 被点名 | 新教训 | 前缀精确 |")
    W("|---|---:|---|---|")
    rows2 = [(o, ps) for o, ps in by_old.items() if not ps[0][3] and any(p[4] is False for p in ps)]
    rows2.sort(key=lambda x: -len(x[1]))
    for o, ps in rows2:
        news = sorted(set(p[1][:-3] for p in ps if p[4] is False))
        exact = all(p[5] for p in ps if p[4] is False)
        W(f"| `{o[:-3]}` | {len(ps)} | {', '.join('`'+n[:45]+'`' for n in news[:3])} | {'是' if exact else '否（写入事件未定位，用全会话）'} |")
    if not rows2:
        W("| （空） | | | |")

    # ── 非常驻高频被点名（即使无轨迹） ──
    W("\n## 4. 非常驻但被反复点名（≥2 次）—— 不论检索维，这些坑在持续被踩\n")
    W("| 旧记忆 | 被点名 | 检索维分布 |")
    W("|---|---:|---|")
    rows3 = [(o, ps) for o, ps in by_old.items() if not ps[0][3] and len(ps) >= 2]
    rows3.sort(key=lambda x: -len(x[1]))
    for o, ps in rows3:
        ret = collections.Counter('无轨迹' if p[4] is None else ('已检索' if p[4] else '未检索') for p in ps)
        W(f"| `{o[:-3]}` | {len(ps)} | {dict(ret)} |")

    # ── 负向验证 ──
    W("\n## 5. 负向验证\n")
    tgt = [p for p in pairs if p[0] == 'feedback_asserted_the_side_i_cannot_see.md' and p[1] == 'project_replay_world_phase0.md']
    if tgt:
        p = tgt[0]
        expect = (p[3] is not None) and (p[4] is False)
        W(f"- 已知事实：2026-09-17 本会话（`4728ca46`）我写 `project_replay_world_phase0` 时承认踩了 `asserted_the_side_i_cannot_see`（断言轨迹「非 git」没验）。"
          f"该旧记忆**在 ★教训区常驻**，且我写之前**没有检索过它**。")
        W(f"- 评估器判定：resident={p[3]!r}, retrieved_before_write={p[4]!r}, 写入事件精确定位={p[5]} → "
          f"{'✅ 落在「常驻 & 仍踩 & 未检索」，与事实一致' if expect else '❌ 与事实不符，评估器有 bug'}")
    else:
        W("- ❌ 负向验证对子没找到——链接解析或窗口过滤有问题，本报告其余数字不可信。")

    W("\n## 6. 未解析的链接（Top 10）\n")
    W("这些 [[x]] 指向的不是 A 库文件（会话级 memory、别名、笔误）。不影响上面的判定，列出来是为了让「未解析」可见。\n")
    for w, c in unresolved.most_common(10):
        W(f"- `{w}` × {c}")

    print('\n'.join(L))

if __name__ == '__main__':
    main()
