#!/usr/bin/env python3
"""build-replay-world.py — Dream-RSI Phase 0：把已发生的历史转成可回放的结构化世界。

设计依据：Dream-RSI（arXiv 2609.14858）「完成的历史即回放模拟器」。
本脚本只做 ② 构建模拟器，不做 ③ dreaming（策略候选评估在 Phase 1）。

只读输入，绝不修改任何记忆文件。

隐私（与 tool-audit.sh 同口径，见该文件头部）：
  轨迹里只存「动了哪个对象」——工具名 / 命令首词 / 文件路径 / 规则名 / 关键词，
  绝不存命令原文、文件内容、用户消息原文。用户消息只留「是否命中纠正模式」+ 长度。
  输出落 ~/.mycc-global/0-System/trajectories/（非 git、600）。

⚠️ 纠正信号校准（2026-09-18，144 条真实输入内存中跑，不落盘）：
  当前 5 组正则总命中个位数；候选扩展组（否定词/疑问词/「你没…」）命中的多是指令与排查请求，
  不是纠正。结论：**川哥真实纠正本来就稀疏**（风格是下指令而非纠错），这不是通道问题，
  别再靠加正则「提升捕获率」——那只会把指令误报成纠正。只修了「还是X，没有Y」跨逗号形态。

⚠️ 两个实测坑（2026-09-17）：
  1. ~/.claude/projects 下 `-Users-rayman-chen-mycc` 是指向 `-home-hahaxiong83-mycc`
     的兼容 symlink。用 glob('*/*.jsonl') 会把同一批文件数两遍（58 vs 真实 37）。
     必须按 os.path.realpath 去重。
  2. transcript 有保留期：实测最早 2026-08-20，而 recall-log 从 2026-06-16 就有。
     回放世界的深度受限于 transcript，报告必须声明窗口。
"""
import json, os, re, sys, glob, sqlite3, collections, datetime, hashlib

HOME = os.path.expanduser('~')
PROJECTS = os.path.join(HOME, '.claude/projects')
MEM_DIR = os.path.join(PROJECTS, '-home-hahaxiong83-mycc/memory')
SYS_DIR = os.path.join(HOME, '.mycc-global/0-System')
OUT_DIR = os.path.join(SYS_DIR, 'trajectories')
CLAUDE_MEM_DB = os.path.join(HOME, '.claude-mem/claude-mem.db')

# ── 工具：与 tool-audit.sh 同口径提取 target ────────────────────────
def extract_target(tool, inp):
    if not isinstance(inp, dict):
        return None
    for k in ('file_path', 'notebook_path'):
        if inp.get(k):
            return inp[k]
    cmd = inp.get('command')
    if cmd:
        return str(cmd).strip().split()[0] if str(cmd).strip() else None
    for k in ('pattern', 'url', 'query', 'skill'):
        if inp.get(k):
            return str(inp[k])[:120]
    return None

MEM_PATH_RE = re.compile(r'memory/|MEMORY\.md|INDEX-full|0-System/memory|projects/.+/memory', re.I)
# 记忆文件引用：从命令/路径全文抠出 <type>_<slug>.md 与 MEMORY.md/INDEX-full。
# 只存文件名（公开结构，非内容），不存命令原文。解决「Bash 复合命令首词=cd 无信息」。
MEM_FILE_RE = re.compile(r'\b((?:feedback|project|reference|user)_[a-z0-9_]+\.md|MEMORY\.md|INDEX-full\.md)')

def memory_refs(inp):
    if not isinstance(inp, dict):
        return []
    blob = ' '.join(str(inp.get(k, '')) for k in ('command', 'file_path', 'pattern', 'path', 'glob', 'query'))
    return sorted(set(MEM_FILE_RE.findall(blob)))

# 纠正模式：川哥指出我做错/理解错。中文为主，保守取词（宁漏勿滥）。
CORRECTION_PATTERNS = [
    (r'不对|不是这样|错了|搞错|弄错|你搞反|反了', 'explicit_wrong'),
    # 2026-09-18 校准（144 条真实输入）：川哥的「还没好」形态是「还是5，没有5.1」——
    # 「还是」与「没」之间隔着别的词和逗号。首版要求紧邻，零命中。
    (r'没有(啊|呀)?$|还是.{0,15}?(没有|没|不行|不能|选不了|看不到)|仍然没|依然没|仍旧', 'still_broken'),
    (r'我说的是|我是说|我要的是|不是让你|谁让你', 'misunderstood'),
    (r'重新(看|查|做|来)|再(看|查)一(下|遍)|你再', 'redo'),
    (r'为什么(还|会|没)|怎么(还|会)', 'why_still'),
]
# 记忆维护/审计类会话（06-16 口径要求排除）
MAINT_PATTERNS = r'盘点|整理记忆|记忆系统|梳理一下记忆|审计|归档|压缩规则|recall-log|guard-log'

def sha8(s):
    return hashlib.sha256(s.encode()).hexdigest()[:8]

# ── 1. 收集 transcript（去重 symlink） ──────────────────────────────
def collect_transcripts():
    seen = {}
    for fp in glob.glob(os.path.join(PROJECTS, '*', '*.jsonl')):
        rp = os.path.realpath(fp)
        if rp in seen:
            continue
        seen[rp] = fp
    return sorted(seen.keys())

# ── 2. 读 hook 日志，按 sid 前缀索引 ────────────────────────────────
def load_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path, errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out

def index_by_sid(rows):
    idx = collections.defaultdict(list)
    for r in rows:
        sid = r.get('sid')
        if sid:
            idx[sid].append(r)
    return idx

# ── 3. A 库记忆索引（含创建时间，用于 prefix-only 防后见泄漏） ────────
FM_NAME = re.compile(r'^name:\s*(.+?)\s*$', re.M)
FM_DESC = re.compile(r'^description:\s*(.+?)\s*$', re.M)
FM_OSID = re.compile(r'^\s*originSessionId:\s*([0-9a-f-]+)', re.M)

def load_memories():
    mems = {}
    for fp in sorted(glob.glob(os.path.join(MEM_DIR, '*.md'))):
        base = os.path.basename(fp)
        if base in ('MEMORY.md', 'INDEX-full.md'):
            continue
        try:
            head = open(fp, errors='replace').read(4000)
        except Exception:
            continue
        st = os.stat(fp)
        mems[base] = {
            'file': base,
            'name': (FM_NAME.search(head).group(1).strip() if FM_NAME.search(head) else base[:-3]),
            'desc': (FM_DESC.search(head).group(1).strip() if FM_DESC.search(head) else ''),
            'origin_sid': (FM_OSID.search(head).group(1)[:8] if FM_OSID.search(head) else None),
            'mtime': datetime.datetime.utcfromtimestamp(st.st_mtime).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'size': st.st_size,
        }
    return mems

# 热索引：解析 MEMORY.md 的 ★教训 / 🗂场景簇 两区，拿到常驻条目 → 文件
LINK_RE = re.compile(r'^- \[([^\]]+)\]\(([^)]+\.md)\)\s*—\s*(.*)$')

def load_hot_index():
    path = os.path.join(MEM_DIR, 'MEMORY.md')
    section = None
    items = []
    for line in open(path, errors='replace'):
        if line.startswith('## '):
            if '★ 教训' in line:
                section = 'lesson'
            elif '场景簇' in line:
                section = 'cluster'
            elif '★ 项目' in line:
                section = 'project'
            elif '★ 参考' in line:
                section = 'reference'
            else:
                section = None
            continue
        m = LINK_RE.match(line.rstrip('\n'))
        if m and section:
            items.append({'slug': m.group(1), 'file': m.group(2), 'gist': m.group(3), 'section': section,
                          'bytes': len(line.encode())})
    return items

# ── 4. 转换一个 transcript → 轨迹事件流 ─────────────────────────────
def build_trace(fp, guard_idx, recall_idx, audit_idx):
    events = []
    sid = None
    proj = os.path.basename(os.path.dirname(fp))
    cwd = None
    ts_first = ts_last = None
    tool_by_id = {}
    counts = collections.Counter()
    human_texts = []

    for line in open(fp, errors='replace'):
        try:
            d = json.loads(line)
        except Exception:
            continue
        sid = d.get('sessionId') or sid
        cwd = d.get('cwd') or cwd
        ts = d.get('timestamp')
        if ts:
            ts_first = min(ts_first, ts) if ts_first else ts
            ts_last = max(ts_last, ts) if ts_last else ts
        t = d.get('type')

        if t == 'assistant':
            for b in (d.get('message', {}).get('content') or []):
                if not isinstance(b, dict) or b.get('type') != 'tool_use':
                    continue
                tool = b.get('name')
                tgt = extract_target(tool, b.get('input'))
                tool_by_id[b.get('id')] = (tool, tgt)
                counts['tool_call'] += 1
                ev = {'ts': ts, 'type': 'tool_call', 'tool': tool, 'target': tgt}
                refs = memory_refs(b.get('input'))
                blob = ' '.join(str((b.get('input') or {}).get(k, '')) for k in ('command', 'file_path', 'pattern', 'path'))
                if refs:
                    ev['mem_refs'] = refs
                    counts['memory_ref'] += len(refs)
                if (tgt and MEM_PATH_RE.search(str(tgt))) or MEM_PATH_RE.search(blob):
                    ev['touches_memory'] = True
                    counts['memory_touch'] += 1
                events.append(ev)

        elif t == 'user':
            # 工具结果：只取成败
            for b in (d.get('message', {}).get('content') or []):
                if isinstance(b, dict) and b.get('type') == 'tool_result' and b.get('is_error') is True:
                    tool, tgt = tool_by_id.get(b.get('tool_use_id'), (None, None))
                    counts['tool_error'] += 1
                    events.append({'ts': ts, 'type': 'friction', 'kind': 'tool_error',
                                   'tool': tool, 'target': tgt})
            # 真实用户输入：只留结构
            if (d.get('origin') or {}).get('kind') == 'human':
                c = d.get('message', {}).get('content')
                txt = c if isinstance(c, str) else ' '.join(
                    b.get('text', '') for b in (c or []) if isinstance(b, dict) and b.get('type') == 'text')
                txt = (txt or '').strip()
                if not txt:
                    continue
                counts['human_turn'] += 1
                human_texts.append(txt)
                hits = [lbl for pat, lbl in CORRECTION_PATTERNS if re.search(pat, txt)]
                ev = {'ts': ts, 'type': 'human_turn', 'len': len(txt)}
                if hits:
                    ev = {'ts': ts, 'type': 'friction', 'kind': 'user_correction',
                          'signals': hits, 'len': len(txt)}
                    counts['user_correction'] += 1
                events.append(ev)

    if not sid:
        return None
    s8 = sid[:8]

    # hook 日志按 sid 并入
    for g in guard_idx.get(s8, []):
        counts['guard_' + g.get('decision', '?')] += 1
        events.append({'ts': g.get('ts'), 'type': 'friction', 'kind': 'guard_' + g.get('decision', '?'),
                       'rules': g.get('rules', []), 'verb': g.get('verb')})
    for r in recall_idx.get(s8, []):
        counts['recall'] += 1
        q = r.get('query', '')
        terms = sorted(set(w for w in re.findall(r'[A-Za-z_][A-Za-z0-9_-]{3,}|[一-龥]{2,}', q)
                           if w.lower() not in ('memory', 'home', 'hahaxiong83', 'claude', 'projects', 'echo', 'grep')))[:8]
        rev = {'ts': r.get('ts'), 'type': 'recall', 'src': r.get('src'),
               'strength': r.get('strength'), 'terms': terms}
        refs = sorted(set(MEM_FILE_RE.findall(q)))
        if refs:
            rev['mem_refs'] = refs
        events.append(rev)

    events.sort(key=lambda e: e.get('ts') or '')
    joined = ' '.join(human_texts)
    is_maint = bool(re.search(MAINT_PATTERNS, joined))
    meta = {
        'sid': sid, 'sid8': s8, 'project': proj, 'cwd': cwd,
        'ts_first': ts_first, 'ts_last': ts_last,
        'counts': dict(counts),
        'is_maintenance_session': is_maint,
        'substantive': counts['human_turn'] >= 2 and counts['tool_call'] >= 5,
    }
    return meta, events

# ── 5. 主流程 ───────────────────────────────────────────────────────
def _args():
    """--out DIR：输出目录（Air 上用 ~/.claude/replay-world/，不在任何 git 仓里——
    Air 的 ~/.mycc-global 每天自动提交并推 GitHub，默认的 0-System/trajectories 会被带上去）。"""
    global OUT_DIR
    a = sys.argv
    if '--out' in a: OUT_DIR = os.path.expanduser(a[a.index('--out') + 1])

def main():
    _args()
    os.makedirs(OUT_DIR, exist_ok=True)
    guard_idx = index_by_sid(load_jsonl(os.path.join(SYS_DIR, 'guard-log.jsonl')))
    recall_idx = index_by_sid(load_jsonl(os.path.join(SYS_DIR, 'recall-log.jsonl')))
    audit_idx = index_by_sid(load_jsonl(os.path.join(SYS_DIR, 'tool-audit.jsonl')))

    files = collect_transcripts()
    traces = []
    for fp in files:
        r = build_trace(fp, guard_idx, recall_idx, audit_idx)
        if not r:
            continue
        meta, events = r
        day = (meta['ts_first'] or '0000-00-00')[:10]
        out = os.path.join(OUT_DIR, f"{day}-{meta['sid8']}.jsonl")
        with open(out, 'w') as f:
            f.write(json.dumps({'type': 'meta', **meta}, ensure_ascii=False) + '\n')
            for e in events:
                f.write(json.dumps(e, ensure_ascii=False) + '\n')
        os.chmod(out, 0o600)
        meta['_path'] = out
        traces.append(meta)

    manifest = {
        'built_at': datetime.datetime.now().astimezone().strftime('%Y-%m-%dT%H:%M:%S%z'),
        'transcripts_seen': len(files),
        'traces_written': len(traces),
        'window': [min((t['ts_first'] or '') for t in traces)[:10],
                   max((t['ts_last'] or '') for t in traces)[:10]] if traces else None,
        'substantive': sum(1 for t in traces if t['substantive']),
        'maintenance': sum(1 for t in traces if t['is_maintenance_session']),
    }
    mp = os.path.join(OUT_DIR, 'MANIFEST.json')
    json.dump(manifest, open(mp, 'w'), ensure_ascii=False, indent=2)
    os.chmod(mp, 0o600)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return traces

if __name__ == '__main__':
    main()
