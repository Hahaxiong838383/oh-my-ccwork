#!/usr/bin/env python3
"""hotindex-audit.py — 热索引压缩前的信息单元对撞（只读）。

「不丢信息」的可执行定义：MEMORY.md 每一行是索引，指向 topic 文件。压掉的每个信息单元
必须在该行链接的 topic 文件正文里找得到（归一化子串匹配）。找不到 = 热索引独有信息，
必须先沉淀进 topic 文件再压。本脚本只产清单，不改任何文件。

信息单元类型：link / bold / code / date / paren(≥20字旁白) / num(数字+单位/IP/端口) / phrase(分隔符切出的短语)
"""
import os, re, sys, json, collections

MEM_DIR = os.path.expanduser('~/.claude/projects/-home-hahaxiong83-mycc/memory')
M = os.path.join(MEM_DIR, 'MEMORY.md')

LINK = re.compile(r'\[([^\]]+)\]\(([^)]+\.md)\)')
BOLD = re.compile(r'\*\*([^*]+?)\*\*')
CODE = re.compile(r'`([^`]+)`')
DATE = re.compile(r'(?<![\d.])(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{2})(?![\d.])')
PAREN = re.compile(r'[（(]([^（）()]{20,})[）)]')
NUM = re.compile(r'\b\d{1,3}(?:\.\d{1,3}){3}\b|\b\d+(?:\.\d+)?\s*(?:ms|s|m|KB|MB|GB|fps|tok|字符|条|台|天|次|行|B)\b|:\d{4,5}\b|\b[0-9a-f]{7,9}\b')
SPLIT = re.compile(r'[;；/｜|+，,。]| → |→|：|:')

def norm(s):
    s = re.sub(r'\*\*|`', '', s)
    s = re.sub(r'\s+', '', s)
    return s.lower()

RG_HINT = re.compile(r"rg\s+'[^']+'|rg\s+[A-Za-z0-9_|.-]+")

def units(line):
    out = []
    for m in LINK.finditer(line): out.append(('link', m.group(0)))
    # ⚠️ 首版在原行上提 paren，把 [slug](file.md) 的括号当成旁白，报出一堆假未命中——先剥链接再提
    body = LINK.sub('', line)
    body = re.sub(r'^- ', '', body)
    body = re.sub(r'^\s*★+\s*—\s*', '', body)
    for m in RG_HINT.finditer(body): out.append(('rghint', m.group(0)))
    body_no_rg = RG_HINT.sub('', body)
    for m in BOLD.finditer(body_no_rg): out.append(('bold', m.group(1)))
    for m in CODE.finditer(body_no_rg): out.append(('code', m.group(1)))
    for m in DATE.finditer(body_no_rg): out.append(('date', m.group(1)))
    for m in PAREN.finditer(body_no_rg): out.append(('paren', m.group(1)))
    for m in NUM.finditer(body_no_rg): out.append(('num', m.group(0)))
    for ph in SPLIT.split(body_no_rg):
        ph = ph.strip(' *`—-·()（）「」★')
        if len(norm(ph)) >= 6:
            out.append(('phrase', ph))
    # 去重
    seen = set(); res = []
    for t, v in out:
        k = (t, norm(v))
        if k in seen or not norm(v): continue
        seen.add(k); res.append((t, v))
    return res

COVER = 0.7
def toks(s):
    s = re.sub(r'\*\*|`', '', s)
    en = set(w.lower() for w in re.findall(r'[A-Za-z][A-Za-z0-9_.-]{2,}', s))
    zh = re.sub(r'[^一-龥]', '', s)
    bi = set(zh[i:i+2] for i in range(len(zh)-1))
    return en | bi

def coverage(unit, topic_norm):
    t = toks(unit)
    if not t: return 0.0
    return sum(1 for x in t if x in topic_norm) / len(t)

def load_topic(f):
    p = os.path.join(MEM_DIR, f)
    if not os.path.exists(p): return None
    return norm(open(p, errors='replace').read())

def main():
    lines = open(M, encoding='utf-8').read().split('\n')
    section = None
    rows = []
    for i, line in enumerate(lines, 1):
        if line.startswith('## '):
            section = ('proj' if '★ 项目' in line else 'ref' if '★ 参考' in line
                       else 'les' if '★ 教训' in line else 'cluster' if '场景簇' in line else 'head')
            continue
        if not line.startswith('- ') or section in (None, 'head'):
            continue
        links = LINK.findall(line)
        rows.append({'n': i, 'section': section, 'line': line, 'links': links,
                     'bytes': len(line.encode())})

    report = {'rows': len(rows), 'units_total': 0, 'found': 0, 'missing': 0,
              'missing_by_type': collections.Counter(), 'missing_by_section': collections.Counter(),
              'no_topic': [], 'details': []}
    for r in rows:
        us = units(r['line'])
        report['units_total'] += len(us)
        topics = {}
        for slug, f in r['links']:
            t = load_topic(f)
            if t is None: report['no_topic'].append((r['n'], f))
            else: topics[f] = t
        miss = []
        for typ, val in us:
            if typ == 'link':
                report['found'] += 1; continue   # 链接本身是索引结构，压缩必保留，不算「需沉淀」
            nv = norm(val)
            hit = any(nv in t for t in topics.values())
            if not hit and typ in ('phrase', 'paren'):
                # 措辞会变（热索引是压缩转述），改用 token 覆盖率：中文 2-gram + 英文词，≥ COVER 出现即命中
                hit = any(coverage(val, t) >= COVER for t in topics.values())
            if not hit and typ == 'date':
                # 日期归一：9-05 ↔ 2026-09-05 ↔ 09-05
                alt = re.sub(r'^(\d{1,2})-(\d{2})$', lambda m: f"{int(m.group(1)):02d}-{m.group(2)}", val)
                hit = any((alt in t) or (f"2026-{alt}" in t) or (f"{int(alt[:2])}-{alt[3:]}" in t) for t in topics.values())
            if hit: report['found'] += 1
            else:
                report['missing'] += 1
                report['missing_by_type'][typ] += 1
                report['missing_by_section'][r['section']] += 1
                miss.append((typ, val))
        if miss:
            report['details'].append({'n': r['n'], 'section': r['section'],
                                      'slug': r['links'][0][0] if r['links'] else '?',
                                      'files': [f for _, f in r['links']], 'missing': miss})
    return report

def selfcheck():
    """匹配器自验：从 topic 文件里抄一句当正锚必须命中；随机串当负锚必须不命中。"""
    import random
    f = 'project_p003_oneshot.md'
    t = load_topic(f)
    raw = [l.strip() for l in open(os.path.join(MEM_DIR, f), errors='replace') if len(l.strip()) > 30 and not l.startswith('#')]
    pos = raw[len(raw)//2][:60]
    neg = '这是一句绝不会出现在任何记忆里的随机负锚句子XQZV' + str(random.random())
    ok_pos = norm(pos) in t or coverage(pos, t) >= COVER
    ok_neg = not (norm(neg) in t or coverage(neg, t) >= COVER)
    print(f"[selfcheck] 正锚命中={ok_pos}  负锚未命中={ok_neg}  → {'✅ 匹配器可信' if ok_pos and ok_neg else '❌ 匹配器有问题，下面的数字作废'}")
    return ok_pos and ok_neg

if __name__ == '__main__':
    if not selfcheck(): sys.exit(1)
    rep = main()
    print(f"行数 {rep['rows']} · 信息单元 {rep['units_total']} · topic 命中 {rep['found']} · 未命中 {rep['missing']} "
          f"({rep['missing']/max(1,rep['units_total']):.0%})")
    print("未命中按类型:", dict(rep['missing_by_type']))
    print("未命中按区:", dict(rep['missing_by_section']))
    if rep['no_topic']: print("⚠️ 链接指向不存在的文件:", rep['no_topic'])
    print()
    if '--json' in sys.argv:
        json.dump(rep, open('/tmp/hotindex-audit.json', 'w'), ensure_ascii=False, indent=1, default=list)
        print("详情已写 /tmp/hotindex-audit.json")
    else:
        for d in rep['details']:
            print(f"--- L{d['n']} [{d['section']}] {d['slug']} → {', '.join(d['files'])}")
            for t, v in d['missing']:
                print(f"     {t:<7} {v[:110]}")
