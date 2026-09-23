#!/usr/bin/env python3
"""hotindex-derive.py — 开发机热索引 = Air 全量热索引的「规则式派生物」（2026-09-23 川哥放行）。

为什么：Claude Code 加载 MEMORY.md 上限 25000 **字符**（二进制实测 N2=25000，r.length），
Air 全量热索引已 28K+ 字符，末尾场景簇整段加载不到；Air 侧不压（影响在跑项目）。
架构：Air 同步步骤 6d 把 canonical 全量镜像到 ~/.mycc-global/air-mirror/（逐字节=Air，
      rg 精确检索、历史在 mycc-global-backup 的 memory-canonical/ git）；6c 不再推 MEMORY.md；
      本脚本读镜像版 → 规则压缩 → 写开发机 MEMORY.md。被压掉的原文就在镜像里，零丢失。
规则（纯规则，Air 的行每天变，不能手写替换行）：
  - 头部原样 + 一行派生说明；★参考、🗂场景簇原样（簇是 rg 召回入口）
  - ★项目：真值锚行原样；其余行正文截到 PROJ_CAP 字符（保留链接/星级），原行里的 rg '…' 指引保留
  - ★教训：删 ≥PAREN_MIN 字符、不含加粗/链接/代码的括号旁白；仍超预算则正文截到 LES_CAP
  - 末尾「## 🏠 开发机本地」区块从现有开发机 MEMORY.md 原样带过（本机会话新加的索引行不丢）
验证（任一不过 → 不替换，保留上一版，exit 非 0）：
  字符 ≤ BUDGET；Air 版全部链接文件在派生版里一个不少；本地区块原样存在。
用法：hotindex-derive.py [--write] [--src 镜像MEMORY.md] [--dst 开发机MEMORY.md]
"""
import os, re, sys, datetime

HOME = os.path.expanduser('~')
SRC = os.path.join(HOME, '.mycc-global/air-mirror/MEMORY.md')
DST = os.path.join(HOME, '.claude/projects/-home-hahaxiong83-mycc/memory/MEMORY.md')
BUDGET = int(os.environ.get('HX_BUDGET', '24000'))       # 加载上限 25000 字符，留 1000 余量
PROJ_CAP = int(os.environ.get('HX_PROJ_CAP', '120'))
LES_CAP = int(os.environ.get('HX_LES_CAP', '0'))         # 0 = 不截，只删旁白
PAREN_MIN = int(os.environ.get('HX_PAREN_MIN', '14'))
ANCHORS = {'user_hw', 'h_byos', 'cloud_servers', 'hs_vault'}   # 头部声明「真值锚不限长度不下沉」
LOCAL_HEAD = '## 🏠 开发机本地'
LINK = re.compile(r'\[([^\]]+)\]\(([^)]+\.md)\)')
PAREN = re.compile(r'[（(]([^（）()]{%d,})[）)]' % PAREN_MIN)
RG = re.compile(r"(?:→\s*)?rg\s+'[^']+'")

def args():
    a = sys.argv
    src = a[a.index('--src') + 1] if '--src' in a else SRC
    dst = a[a.index('--dst') + 1] if '--dst' in a else DST
    return src, dst, '--write' in a

def section_of(line, cur):
    if not line.startswith('## '): return cur
    if '★ 项目' in line: return 'proj'
    if '★ 参考' in line: return 'ref'
    if '★ 教训' in line: return 'les'
    if '场景簇' in line: return 'cluster'
    if line.startswith(LOCAL_HEAD): return 'local'
    return 'other'

def cut_gist(line, cap):
    """保留 `- [slug](file) ★★ — ` 前缀，正文截到 cap 字符；原行 rg 指引补回末尾。"""
    m = re.match(r'^(- .*?\)\s*[★]*\s*—\s*)(.*)$', line)
    if not m: return line
    head, gist = m.group(1), m.group(2)
    rg = RG.search(gist)
    body = RG.sub('', gist).rstrip(' ；;,，')
    tail_links = ''
    if len(body) > cap:
        # 先把正文里的链接换成占位，截断只作用于文字；被截掉的链接补回行尾（次级链接一个不丢）
        keep = [m.group(0) for m in LINK.finditer(body)]
        cut = body[:cap]
        lost = [lk for lk in keep if lk not in cut]
        partial = cut.rfind('[')
        if partial > cut.rfind(')') and partial >= 0: cut = cut[:partial]   # 别截在半个链接中间
        body = cut.rstrip(' ；;,，*/(（') + '…'
        if body.count('**') % 2: body = body.rsplit('**', 1)[0] + body.rsplit('**', 1)[1]
        if lost: tail_links = ' 另见 ' + ' '.join(lost)
    return head + body + tail_links + ((' → ' + rg.group(0).lstrip('→ ').strip()) if rg else '')

def strip_parens(line):
    masked = LINK.sub(lambda x: 'X' * len(x.group(0)), line)
    out = line
    for m in PAREN.finditer(masked):
        span = line[m.start():m.end()]
        if '**' in span or '`' in span or '](' in span: continue
        out = out.replace(span, '', 1)
    return re.sub(r'[;；,，]{2,}', '；', out)

def derive(src_text, local_block, les_cap, proj_cap=None):
    global PROJ_CAP
    if proj_cap: PROJ_CAP = proj_cap
    out, sec = [], 'head'
    for line in src_text.split('\n'):
        sec = section_of(line, sec)
        if sec == 'local': continue          # Air 版不该有，防御
        if line.startswith('- '):
            slug = (LINK.search(line).group(1) if LINK.search(line) else '')
            if sec == 'proj' and slug not in ANCHORS:
                line = cut_gist(line, PROJ_CAP)
            elif sec == 'les':
                line = strip_parens(line)
                if les_cap: line = cut_gist(line, les_cap)
        out.append(line)
    # 头部加派生说明（插在第一个 ## 之前）
    note = (f"> 🔁 **本文件是 Air 全量热索引的派生压缩版**（{datetime.datetime.now():%Y-%m-%d %H:%M} 生成，hotindex-derive.py）："
            f"加载上限 25000 字符，Air 版超限。**被截的全文逐字在 `~/.mycc-global/air-mirror/MEMORY.md`，"
            f"任何条目 `rg <词> ~/.mycc-global/air-mirror/`**。本机新增索引行写进文末「{LOCAL_HEAD}」区块，其余部分每次 Air 同步后重新生成，手改会被冲掉。")
    i = next((k for k, l in enumerate(out) if l.startswith('## ')), len(out))
    out.insert(i, note); out.insert(i + 1, '')
    text = '\n'.join(out).rstrip('\n') + '\n'
    if local_block: text += '\n' + local_block.rstrip('\n') + '\n'
    return text

def local_block_of(dst_text):
    i = dst_text.find('\n' + LOCAL_HEAD)
    return dst_text[i + 1:] if i >= 0 else ''

def verify(src_text, new_text, local_block):
    P = []
    if len(new_text) > BUDGET: P.append(f"字符 {len(new_text)} > 预算 {BUDGET}")
    miss = {f for _, f in LINK.findall(src_text)} - {f for _, f in LINK.findall(new_text)}
    if miss: P.append(f"链接丢失 {len(miss)}：{sorted(miss)[:5]}")
    if local_block and local_block.strip() not in new_text: P.append("本地区块丢失")
    return P

def main():
    src, dst, write = args()
    s = open(src, encoding='utf-8').read()
    d = open(dst, encoding='utf-8').read() if os.path.exists(dst) else ''
    lb = local_block_of(d)
    base_proj = PROJ_CAP
    new = derive(s, lb, LES_CAP, base_proj); level = '0'
    # 预算不够时逐档收紧：先教训区正文，再项目区正文。都到下限仍超 → 验证失败、保留上一版（不写残缺文件）
    for les, proj in [(260, base_proj), (200, base_proj), (160, 100), (130, 90), (110, 80), (90, 70)]:
        if len(new) <= BUDGET: break
        new = derive(s, lb, les, proj); level = f'教训≤{les}/项目≤{proj}'
    print(f"收紧档位: {level}")
    probs = verify(s, new, lb)
    print(f"Air 版 {len(s)} 字符 → 派生 {len(new)} 字符（预算 {BUDGET}）；链接 {len(set(LINK.findall(s)))}→{len(set(LINK.findall(new)))}；本地区块 {len(lb)} 字符")
    # 负向验证：删一个链接，验证器必须红
    neg = LINK.sub('', new, 1)
    neg_ok = any('链接丢失' in p for p in verify(s, neg, lb))
    print("验证:", "✅ 全绿" if not probs else "❌ " + "；".join(probs), "| 负向:", "✅ 能抓" if neg_ok else "❌ 验证器失灵")
    if probs or not neg_ok:
        # 失败不写残缺文件，保留上一版；留告警给下一个会话看见（Air 版涨到收紧档位都兜不住时会走到这里）
        try:
            with open(os.path.join(HOME, '.mycc-global/0-System/.hotindex-derive.err'), 'a') as f:
                f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M} 派生失败，开发机热索引停在上一版：{'；'.join(probs) or '验证器失灵'}\n")
        except Exception: pass
        sys.exit(2)
    if write:
        if d == new: print("无变化"); return
        tmp = dst + '.derive.tmp'
        open(tmp, 'w', encoding='utf-8').write(new); os.replace(tmp, dst)
        print(f"已写入 {dst}")
    else:
        open('/tmp/MEMORY.derived.md', 'w', encoding='utf-8').write(new); print("dry-run → /tmp/MEMORY.derived.md")

if __name__ == '__main__':
    main()
