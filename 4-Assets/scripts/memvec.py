#!/usr/bin/env python3
"""memvec.py — 记忆语义检索（markdown 真源之上的派生索引，可随时删除重建）。

用法：
  memvec.py index                 增量索引（按 mtime+size，只重嵌入变更文件；flock 防并发）
  memvec.py query "文本" [-k 5]    混合检索（关键词 + 语义，RRF 融合），打印指针
  memvec.py hook                  PostToolUse：会话刚搜过记忆 → 补「意思相近但这次没搜到」的最多 3 条

设计依据（2026-09-23）：评估器 50 次召回失败全是「搜了没搜到」，新旧措辞重叠中位 1%——rg 结构上找不到。
不新建记忆库、不改真源；索引是一个 sqlite 文件。嵌入走本机 Ollama（全程不调大模型）。
"""
import os, re, sys, json, time, sqlite3, hashlib, fcntl, subprocess, urllib.request
import numpy as np

HOME = os.path.expanduser('~')
MEM_DIR = os.environ.get('MEMVEC_DIR') or next((d for d in (
    os.path.join(HOME, '.claude/projects/-home-hahaxiong83-mycc/memory'),
    os.path.join(HOME, '.claude/projects/-Users-rayman-chen-mycc/memory')) if os.path.isdir(d)), '')
STATE = os.path.join(HOME, '.local/share/memvec'); os.makedirs(STATE, exist_ok=True)
DB = os.environ.get('MEMVEC_DB', os.path.join(STATE, 'index.db'))
ERR = os.path.join(STATE, 'memvec.err')
OLLAMA = os.environ.get('MEMVEC_OLLAMA', 'http://127.0.0.1:11434')
MODEL = os.environ.get('MEMVEC_MODEL', 'qwen3-embedding:0.6b')
THRESH = float(os.environ.get('MEMVEC_THRESH', '0.55'))      # 由离线回放定，见 memvec-replay-eval.py
INST = "Instruct: Given a search query about past engineering work, retrieve the relevant memory notes\nQuery: "
SKIP = {'MEMORY.md', 'INDEX-full.md'}
LINK_MD = re.compile(r'\b((?:feedback|project|reference|user)_[A-Za-z0-9_]+\.md)\b')

def err(m):
    try:
        with open(ERR, 'a') as f: f.write(time.strftime('%F %T ') + m + '\n')
    except Exception: pass

def embed(texts, timeout=60):
    req = urllib.request.Request(OLLAMA + '/api/embed', method='POST', headers={'Content-Type': 'application/json'},
        data=json.dumps({'model': MODEL, 'input': texts, 'keep_alive': '30m'}).encode())
    v = np.array(json.load(urllib.request.urlopen(req, timeout=timeout))['embeddings'], dtype=np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)

def db():
    c = sqlite3.connect(DB)
    c.execute('create table if not exists files(file text primary key, mtime real, size int, descr text)')
    c.execute('create table if not exists chunks(file text, j int, vec blob, primary key(file, j))')
    c.execute('create table if not exists meta(k text primary key, v text)')
    return c

def split(path, f):
    s = open(path, encoding='utf-8', errors='replace').read()
    m = re.search(r'^description:\s*"?(.+?)"?\s*$', s, re.M); desc = m.group(1) if m else ''
    body = re.sub(r'^---\n.*?\n---\n', '', s, count=1, flags=re.S).strip()
    out, i = [], 0
    while i < len(body) or not out:
        ch = body[i:i + 800]; out.append((f'{f[:-3]}：{desc}\n' + ch) if i == 0 else f'{f[:-3]}：' + ch); i += 680
        if i >= len(body): break
    return desc, out

def index(quiet=False):
    if not MEM_DIR: err('no MEM_DIR'); return
    lock = open(os.path.join(STATE, 'index.lock'), 'w')
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError: return                      # 另一个索引进程在跑
    c = db(); cur = {r[0]: (r[1], r[2]) for r in c.execute('select file, mtime, size from files')}
    disk = {}
    for f in os.listdir(MEM_DIR):
        if f.endswith('.md') and f not in SKIP:
            st = os.stat(os.path.join(MEM_DIR, f)); disk[f] = (st.st_mtime, st.st_size)
    gone = set(cur) - set(disk); todo = [f for f in disk if cur.get(f) != disk[f]]
    for f in gone:
        c.execute('delete from files where file=?', (f,)); c.execute('delete from chunks where file=?', (f,))
    t0 = time.time()
    for f in todo:
        desc, parts = split(os.path.join(MEM_DIR, f), f)
        vecs = np.vstack([embed(parts[i:i + 16]) for i in range(0, len(parts), 16)])
        c.execute('delete from chunks where file=?', (f,))
        c.executemany('insert into chunks values(?,?,?)', [(f, j, v.tobytes()) for j, v in enumerate(vecs)])
        c.execute('insert or replace into files values(?,?,?,?)', (f, disk[f][0], disk[f][1], desc))
        c.commit()
    c.execute("insert or replace into meta values('model', ?)", (MODEL,))
    c.execute("insert or replace into meta values('indexed_at', ?)", (str(time.time()),)); c.commit()
    if not quiet: print(f'索引：{len(disk)} 文件，更新 {len(todo)}，删除 {len(gone)}，{time.time()-t0:.1f}s')

def load():
    c = db(); rows = c.execute('select file, vec from chunks').fetchall()
    if not rows: return None, None, None
    files = sorted({r[0] for r in rows}); fi = {f: i for i, f in enumerate(files)}
    M = np.frombuffer(b''.join(r[1] for r in rows), dtype=np.float32).reshape(len(rows), -1)
    owner = np.array([fi[r[0]] for r in rows]); desc = dict(c.execute('select file, descr from files').fetchall())
    return files, (M, owner), desc

def vector_scores(q, files, mo):
    M, owner = mo; s = M @ embed([INST + q], timeout=5)[0]
    out = np.full(len(files), -1.0, dtype=np.float32); np.maximum.at(out, owner, s); return out

def keyword_scores(q, files):
    terms = [t.lower() for t in re.split(r'[\s|,，;；]+', q) if len(t) >= 2]
    out = np.zeros(len(files), dtype=np.float32)
    for i, f in enumerate(files):
        try: txt = open(os.path.join(MEM_DIR, f), encoding='utf-8', errors='replace').read().lower()
        except OSError: continue
        out[i] = sum(1 for t in terms if t in txt)
    return out

def query(q, k=5):
    files, mo, desc = load()
    if not files: print('索引为空，先跑 memvec.py index'); return []
    v = vector_scores(q, files, mo); kw = keyword_scores(q, files)
    rv = np.argsort(np.argsort(-v)); rk = np.argsort(np.argsort(-kw))
    rrf = 1 / (61 + rv) + np.where(kw > 0, 1 / (61 + rk), 0)
    top = np.argsort(-rrf)[:k]
    res = [(files[i], float(v[i]), int(kw[i]), desc.get(files[i], '')) for i in top]
    for f, sv, sk, d in res: print(f'{f[:-3]}  语义{sv:.2f} 词{sk}  {d[:90]}')
    return res

VAL_OPTS = {'-g', '--glob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '--context',
            '-j', '--threads', '-f', '--file', '-M', '--max-columns', '--max-depth', '-d', '--color', '--colors',
            '--sort', '--sortr', '--type-add', '-E', '--encoding', '--include', '--exclude', '--exclude-dir', '--iglob'}
PAT_OPTS = {'-e', '--regexp'}
SEARCH_BIN = {'rg', 'grep', 'egrep', 'fgrep', 'ugrep'}

def _clean(p):
    p = re.sub(r'\\[bBwWsSdD]', ' ', p)
    return re.sub(r'[\\^$()\[\]{}.*+?]', ' ', p).replace('|', ' ')

def extract_query(tool, ti):
    """从一次记忆检索里抠出检索意图。Bash：按 shell 语法切词，找 rg/grep 那段，跳过选项与选项值，
    取 -e 的值或第一个位置参数；Grep 工具：pattern 字段。"""
    import shlex
    if tool == 'Grep': return _clean(str(ti.get('pattern') or ''))
    cmd = str(ti.get('command') or '')
    try:
        lex = shlex.shlex(cmd.replace('\n', ' ; '), posix=True, punctuation_chars=';&|')
        lex.whitespace_split = True; toks = list(lex)
    except ValueError:
        return ''
    segs, cur = [], []
    for t in toks:
        if t and set(t) <= set(';&|'): segs.append(cur); cur = []
        else: cur.append(t)
    segs.append(cur)
    pats = []
    for seg in segs:
        i = 0
        while i < len(seg) and (re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', seg[i]) or seg[i] in ('sudo', 'command', 'time')): i += 1
        if i >= len(seg) or os.path.basename(seg[i]) not in SEARCH_BIN: continue
        args, j, got = seg[i + 1:], 0, []
        positional = None
        while j < len(args):
            a = args[j]
            if a == '--':
                if j + 1 < len(args) and positional is None: positional = args[j + 1]
                break
            if a in PAT_OPTS and j + 1 < len(args): got.append(args[j + 1]); j += 2; continue
            if any(a.startswith(o + '=') for o in PAT_OPTS): got.append(a.split('=', 1)[1]); j += 1; continue
            if a in VAL_OPTS: j += 2; continue
            if a.startswith('-'): j += 1; continue
            if positional is None: positional = a
            j += 1
        if got: pats += got
        elif positional: pats.append(positional)
    return ' '.join(_clean(p) for p in pats)

def hook():
    d = json.loads(sys.stdin.read() or '{}')
    tool = d.get('tool_name') or d.get('toolName') or ''
    ti = d.get('tool_input') or d.get('toolInput') or {}
    if not isinstance(ti, dict) or not MEM_DIR: return
    blob = json.dumps(ti, ensure_ascii=False)
    if 'memvec' in blob or not re.search(r'/memory(/|\b)|memory/|MEMORY\.md|INDEX-full|air-mirror', blob): return
    if tool not in ('Grep', 'Bash', 'run_terminal_command'): return
    if tool != 'Grep' and not re.search(r'\b(rg|grep|egrep|ugrep)\b', str(ti.get('command', ''))): return
    q = extract_query(tool, ti).strip()
    if len(q) < 2: return
    resp = json.dumps(d.get('tool_response') or d.get('toolResponse') or '', ensure_ascii=False)
    seen = set(LINK_MD.findall(resp)) | set(LINK_MD.findall(blob))
    files, mo, desc = load()
    if not files: return
    v = vector_scores(q, files, mo)
    sid = (d.get('session_id') or d.get('sessionId') or 'x')[:8]
    sp = os.path.join(STATE, 'hook-seen.json')
    try: shown = json.load(open(sp))
    except Exception: shown = {}
    mine = set(shown.get(sid, []))
    picks = [i for i in np.argsort(-v) if v[i] >= THRESH and files[i] not in seen and files[i] not in mine][:3]
    # 陈旧则后台增量索引（不阻塞本次）
    try:
        c = db(); t = float((c.execute("select v from meta where k='indexed_at'").fetchone() or ['0'])[0])
        if time.time() - t > 600:
            subprocess.Popen([sys.executable, os.path.abspath(__file__), 'index', '--quiet'], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
    except Exception as e: err('bg index: ' + repr(e)[:120])
    if not picks: return
    shown[sid] = list(mine | {files[i] for i in picks}); shown = dict(list(shown.items())[-50:])
    json.dump(shown, open(sp, 'w'))
    lines = [f"- [{files[i][:-3]}]({files[i]}) 相似度{v[i]:.2f} — {desc.get(files[i], '')[:100]}" for i in picks]
    msg = "🔎 这次记忆检索里没出现、但意思相近的（语义检索补漏，只是线索，相关再去读）：\n" + "\n".join(lines)
    print(json.dumps({'additionalContext': msg, 'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': msg}}, ensure_ascii=False))

if __name__ == '__main__':
    a = sys.argv[1:] or ['help']
    try:
        if a[0] == 'index': index(quiet='--quiet' in a)
        elif a[0] == 'query': query(a[1], int(a[a.index('-k') + 1]) if '-k' in a else 5)
        elif a[0] == 'hook': hook()
        else: print(__doc__)
    except Exception as e:
        err(f'{a[0]}: {e!r}'[:300])
        if a[0] != 'hook': raise
    sys.exit(0) if a[0] == 'hook' else None
