#!/usr/bin/env python3
"""给 codex / grok 的记忆入口：从 home-studio 热索引派生一小段，写进它们会自动加载的全局说明文件（2026-09-24，第一段）。

问题（第 0 步实测）：codex/grok 拿不到 Claude 的热索引；codex 在 ~/MyAgent、codeg 会话目录下启动时连 ~/AGENTS.md 都不加载；
查记忆多走 0-System 旧库，8-30 codex 重犯 A 库早有的教训时查的全是旧库。
做法：读 ~/.claude/projects/-home-hahaxiong83-mycc/memory/MEMORY.md（派生热索引）→ 生成 ≤ BUDGET 字符的入口块：
  查法表（知识查 A / 旧库作补充 / 事件读末尾）+ 真值锚 + 🔥 近期高复发坑 + 教训一句话索引。
写到：~/.codex/AGENTS.md（codex 全局说明，二进制里有 codex-home 读取它的代码）、~/.grok/AGENTS.md（grok 会话 <rules> 里实测注入）。
只替换 BEGIN/END 标记之间的块，文件其余内容原样保留；内容没变就不写。
用法：agent-entry-derive.py [--dry-run] [--targets 文件1,文件2]    触发：systemd agent-entry.path 盯热索引
"""
import os, re, sys, datetime

H = os.path.expanduser('~')
SRC = os.environ.get('AGENT_ENTRY_SRC', f'{H}/.claude/projects/-home-hahaxiong83-mycc/memory/MEMORY.md')
TARGETS = [f'{H}/.codex/AGENTS.md', f'{H}/.grok/AGENTS.md']
# 宪法：§五 设计的 codex 接线是 `ln -s ~/AGENTS.md ~/.codex/AGENTS.md`，Air 上有，home-studio 上从来没建（9-24 查实）。
# codex 只读一个全局文件，所以在这里把宪法原文作为一块一起生成（宪法一改自动重同步，不手抄，不会漂）。
# grok 也不读 ~/AGENTS.md：9-24 验收会话的 rules 段里没有宪法原文，只有 Claude rules 目录里的指针文件 home-constitution.md
# （之前按「同时含『宪法』『白名单』」判成 15/20 注入，是把指针文件误算了——判据没对准对象）。所以 grok 也要这一块。
CONSTITUTION = os.environ.get('AGENT_ENTRY_CONSTITUTION', f'{H}/mycc/docs/HOME-AGENTS.md')
C_BEGIN = '<!-- home-constitution:begin（原文同步自 ~/mycc/docs/HOME-AGENTS.md，即 ~/AGENTS.md；勿改，改宪法原文会自动同步）-->'
C_END = '<!-- home-constitution:end -->'
WANTS_CONSTITUTION = ('/.codex/', '/.grok/')
MEMDIR = '~/.claude/projects/-Users-rayman-chen-mycc/memory'      # 两台机器都能用（开发机上是指向正本的软链）
BEGIN = '<!-- mem-entry:begin（自动生成，勿手改：mycc/4-Assets/scripts/agent-entry-derive.py）-->'
END = '<!-- mem-entry:end -->'
BUDGET = 7000
ANCHORS = ('user_hardware.md', 'reference_cloud_servers.md', 'project_feishu_grok_h_byos.md')
LINK = re.compile(r'\[([^\]]+)\]\(([^)]+?)\.md\)')

HEADER = f"""# home-studio 记忆入口（给 codex / grok）

你没有 Claude 的常驻热索引。这台机器的跨会话记忆在下面这些地方——**下结论前先查**：历史决策、机器/服务/Bot 归属、路径端口、「以前是不是做过/踩过」。

| 要找什么 | 去哪 | 怎么查 |
|---|---|---|
| 知识：教训、项目状态、设备与网络真值 | A 库 `{MEMDIR}/`（约 980 个 topic，全量索引 `INDEX-full.md`） | **首选** MCP `mycc-memory` 的 `memory_search`（一次查 A 库 + 旧库条目，带日期）→ `memory_read`；`rg -n <词> {MEMDIR}/` 只查 A |
| 补充知识（旧库） | `~/mycc/0-System/memory-items.md` | `memory_search` 已包含；单独查用 `rg -n <词>`。两台机器已分叉、可能过时，但有 A 没有的近期事实 |
| 最近发生了什么 | `~/mycc/0-System/RECENT_EVENTS.md`（很大，越往后越新） | 只读末尾：`tail -n 80`；**别用 `head` 或 `sed -n '1,Np'`，读到的是最旧的** |

- A 库与旧库说法冲突：以**日期更新**的为准，并在回复里点出冲突。
- 写记忆的规则本阶段不变（见 `~/AGENTS.md` 共享记忆一节）；home-studio 上改 A 库文件会被自动同步到 Air。
- 看配置/凭据用 `python3 ~/mycc/4-Assets/scripts/cfgview.py <文件>`（值自动遮蔽），不要整份打印含密钥的文件。
"""


def plain(s):
    """链接 [别名](文件.md) → 别名；去掉加粗与装饰符号，压成一行。"""
    s = LINK.sub(lambda m: m.group(1), s)
    s = s.replace('**', '').replace('🔴', '').replace('`', '')
    return re.sub(r'\s+', ' ', s).strip()


def cut(s, n):
    return s if len(s) <= n else s[:n - 1] + '…'


def section(text, head):
    m = re.search(r'\n## ' + re.escape(head) + r'[^\n]*\n(.*?)(?=\n## |\Z)', text, re.S)
    return [l for l in (m.group(1).split('\n') if m else []) if l.startswith('- ')]


def build(text, les_cap=60, hot_cap=150, anchor_cap=200):
    anchors = [l for l in text.split('\n') if l.startswith('- ') and any(f'({a})' in l for a in ANCHORS)]
    hot = section(text, '🔥')
    les = section(text, '★ 教训')
    if not les:
        raise ValueError('热索引里没找到「## ★ 教训」节，格式可能变了')
    def fmt(l, cap, with_file=False):
        m = LINK.search(l)
        alias, stem = (m.group(1), m.group(2)) if m else ('?', '?')
        gist = plain(l.split('—', 1)[1] if '—' in l else l[2:])
        head = f'{alias}（{stem}.md）' if with_file else alias
        return f'- {head}：{cut(gist, cap)}'
    out = [BEGIN, HEADER.rstrip(), '',
           '## 真值锚（设备 / 云服务器 / Bot 归属——别凭印象，先读原文件）']
    out += [fmt(l, anchor_cap, True) for l in anchors]
    if hot:
        out += ['', '## 近 28 天反复踩、还没有守门的坑（评估器统计）']
        out += [fmt(l, hot_cap, True) for l in hot]
    out += ['', f'## 教训一句话索引（原文：`memory_search <别名>`，或 `rg -n <别名> {MEMDIR}/INDEX-full.md` 找到文件）']
    out += [fmt(l, les_cap) for l in les]
    out += ['', f'更多场景关键词见热索引 `{MEMDIR}/MEMORY.md` 的「🗂 场景簇」节。', END]
    return '\n'.join(out) + '\n'


def fit(text):
    """超预算就逐步收紧每行上限。"""
    for les_cap, hot_cap in ((60, 150), (50, 120), (42, 100), (34, 80)):
        b = build(text, les_cap, hot_cap)
        if len(b) <= BUDGET:
            return b
    raise ValueError(f'收到最紧仍超预算 {len(b)} > {BUDGET}')


def merge(existing, block, begin=BEGIN, end=END, before=None):
    """替换已有块；没有就插到 before 标记前（有的话），否则追加到末尾。块外内容原样保留。"""
    if begin in existing and end in existing:
        a = existing.index(begin); b = existing.index(end) + len(end)
        rest = existing[b:]
        return existing[:a] + block.rstrip('\n') + (rest if rest.startswith('\n') else '\n' + rest)
    if before and before in existing:
        i = existing.index(before)
        return existing[:i] + block.rstrip('\n') + '\n\n' + existing[i:]
    sep = '' if not existing or existing.endswith('\n\n') else ('\n' if existing.endswith('\n') else '\n\n')
    return existing + sep + block


def constitution_block():
    body = open(CONSTITUTION, encoding='utf-8').read().rstrip('\n')
    if not body.strip():
        raise ValueError(f'宪法原文为空：{CONSTITUTION}')
    return f'{C_BEGIN}\n{body}\n{C_END}\n'


def write_if_changed(path, content):
    old = open(path, encoding='utf-8').read() if os.path.exists(path) else None
    if old == content:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.ae.{os.getpid()}'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(content)
    if old is not None:
        os.chmod(tmp, os.stat(path).st_mode & 0o777)
    os.replace(tmp, path)
    return True


def main():
    a = sys.argv[1:]
    targets = a[a.index('--targets') + 1].split(',') if '--targets' in a else TARGETS
    block = fit(open(SRC, encoding='utf-8').read())
    stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
    if '--dry-run' in a:
        sys.stdout.write(block); print(f'\n（{len(block)} 字符，{len(block.encode())} 字节）'); return
    cblock = constitution_block() if any(w in t for t in targets for w in WANTS_CONSTITUTION) else None
    for t in targets:
        old = open(t, encoding='utf-8').read() if os.path.exists(t) else ''
        new = merge(old, block)
        if cblock and any(w in t for w in WANTS_CONSTITUTION):
            new = merge(new, cblock, C_BEGIN, C_END, before=BEGIN)
        changed = write_if_changed(t, new)
        print(f'{stamp} {"更新" if changed else "未变"} {t}（块 {len(block)} 字符 / {len(block.encode())} 字节）')


if __name__ == '__main__':
    main()
