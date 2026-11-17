#!/usr/bin/env python3
"""memvec-replay-eval-v2.py — 按新尺子（2026-09-23 P0 修尺子后）重测向量检索与嵌入模型。

与 v1（上午）的区别：
  目标  v1 = 旧尺子的「召回失败」51 对（盲标：窗口内真复发只有 2 对，其余是「关联」链接）
        v2 = 真复发对子 = 双盲标一致 RECUR ∪ 新尺子严口径，且新记忆所在会话在写它之前真实搜过记忆
  防泄漏 v1 = 排除同会话写出的文件；v2 = 只让「查询那一刻已经出生」的文件参与排名（出生台账）+ 排除同会话文件
  模型  v1 = qwen3-embedding:0.6b；v2 = 多模型对比（本机临时 ollama，端口见 OLLAMA）
查询 = 会话里 bash-search 类 recall 事件的检索词（与 v1 同口径：一次检索的全部词拼成一句）。
每对取该会话所有查询里的最好名次（与 v1 同）；对照 = 同一批查询换随机目标（R 次平均）。
「点名查询」= 检索词里直接出现旧教训文件名——那是已经知道它、去查它，不是「发现」，单列一栏。
用法：python3 memvec-replay-eval-v2.py [模型 ...]   向量缓存在 ~/.local/share/memvec/eval-v2/
"""
import os, re, sys, json, glob, random, datetime, hashlib, importlib.util, urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('ev', os.path.join(HERE, 'evaluate-memory-policy.py'))
ev = importlib.util.module_from_spec(spec); spec.loader.exec_module(ev)
OLLAMA = os.environ.get('MEMVEC_OLLAMA', 'http://127.0.0.1:11435')
CACHE = os.path.expanduser('~/.local/share/memvec/eval-v2'); os.makedirs(CACHE, exist_ok=True)
CAL = os.path.expanduser('~/.local/share/memory-eval/calibration-2026-09-23')
INST = {'qwen3-embedding': "Instruct: Given a search query about past engineering work, retrieve the relevant memory notes\nQuery: "}
K = (1, 5, 10); R = 20
OSID = re.compile(r'originSessionId:\s*([0-9a-f]{8})')

# ── 目标对子 ──
r = ev.compute_full(); kinds = r['kinds']; traces = ev.load_traces(); mems = r['mems']
key = json.load(open(f'{CAL}/key.json')); lab = {}
for who in ('opus', 'sonnet'):
    for b in (1, 2):
        for l in open(f'{CAL}/labels-{who}-b{b}.jsonl'):
            if l.strip():
                j = json.loads(l); lab.setdefault(j['id'], []).append(j['label'])
gold = {(v['old'], v['new']) for i, v in key.items() if lab[i] == ['RECUR', 'RECUR']}
strict = {(p[0], p[1]) for p in r['pairs'] if kinds[(p[0], p[1])] in ev.STRICT}
births = json.load(open(ev.BIRTHS))
files = sorted(f for f in os.listdir(ev.MEM_DIR) if f.endswith('.md') and f not in ('MEMORY.md', 'INDEX-full.md'))
fidx = {f: i for i, f in enumerate(files)}
osid = {f: (lambda m: m.group(1) if m else None)(OSID.search(open(os.path.join(ev.MEM_DIR, f), errors='replace').read(2500))) for f in files}
born = np.array([births.get(f, 0) for f in files])
# 台账在 8-10 前不可靠：6-14/7-26/8-09 是 Air git 批量入库（465/111/96 个文件），那之前的「出生」只是上界。
# 这些文件一律视为查询时已存在（=v1 口径），之后每天提交，才按出生时间严格过滤。
HORIZON = datetime.datetime(2026, 8, 11).timestamp()

def ts(s):
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()

pairs = []
for o, n in sorted(gold | strict):
    if o not in fidx or n not in fidx:
        continue
    s = osid.get(n)
    if not s or s not in traces:
        continue
    evs = traces[s]
    wi = next((i for i, e in enumerate(evs) if n in e.get('mem_refs', [])), None)
    pre = evs[:wi] if wi is not None else evs
    qs = []
    for e in pre:
        if e.get('type') == 'recall' and e.get('src') == 'bash-search' and e.get('terms'):
            qs.append((' '.join(e['terms']), ts(e['ts'])))
    if qs:
        excl = {f for f in files if osid.get(f) == s} | {n}
        pairs.append({'old': o, 'new': n, 'sid': s, 'q': list(dict.fromkeys(qs)), 'excl': excl,
                      'resident': r['resident'].get(o) is not None, 'gold': (o, n) in gold})

# ── 语料切块（与 memvec.py 同口径：800 字窗、步长 680，首块带 description）──
def split(f):
    s = open(os.path.join(ev.MEM_DIR, f), encoding='utf-8', errors='replace').read()
    m = re.search(r'^description:\s*"?(.+?)"?\s*$', s, re.M); desc = m.group(1) if m else ''
    body = re.sub(r'^---\n.*?\n---\n', '', s, count=1, flags=re.S).strip()
    out, i = [], 0
    while i < len(body) or not out:
        ch = body[i:i + 800]; out.append((f'{f[:-3]}：{desc}\n' + ch) if i == 0 else f'{f[:-3]}：' + ch); i += 680
        if i >= len(body): break
    return out
HEAD_ONLY = bool(os.environ.get('EVAL_HEAD'))     # 每文件只取首块（description+开头 800 字）：模型对比用，CPU 上省 2/3
chunks, owner = [], []
for f in files:
    for c in (split(f)[:1] if HEAD_ONLY else split(f)):
        chunks.append(c); owner.append(fidx[f])
owner = np.array(owner)
queries = sorted({q for p in pairs for q, _ in p['q']})
qpos = {q: i for i, q in enumerate(queries)}
text = {f: open(os.path.join(ev.MEM_DIR, f), errors='replace').read().lower() for f in files}

def embed(model, texts, bs=32):
    out = []
    for i in range(0, len(texts), bs):
        req = urllib.request.Request(OLLAMA + '/api/embed', method='POST', headers={'Content-Type': 'application/json'},
                                     data=json.dumps({'model': model, 'input': texts[i:i + bs], 'keep_alive': '30m'}).encode())
        out.append(np.array(json.load(urllib.request.urlopen(req, timeout=600))['embeddings'], dtype=np.float32))
        if i // bs % 20 == 0:
            print(f'  {model} {i + len(texts[i:i + bs])}/{len(texts)}', file=sys.stderr, flush=True)
    v = np.vstack(out); return v / np.linalg.norm(v, axis=1, keepdims=True)

def vectors(model):
    """按文本逐条缓存（texts.json + vecs.npy）：语料改了几块就只补算几块。
    2026-09-23 教训：首版按「整份语料的 md5」缓存，追加一节记忆就整份作废、CPU 上白跑 90 分钟。
    EVAL_CACHE_ONLY=1 时缺向量直接报错，不偷偷重算。"""
    tag = re.sub(r'[^A-Za-z0-9]+', '_', model)
    inst = next((v for k, v in INST.items() if model.startswith(k)), '')
    want = chunks + [inst + q for q in queries]
    tp, vp = os.path.join(CACHE, f'{tag}.texts.json'), os.path.join(CACHE, f'{tag}.vecs.npy')
    have = {}
    if os.path.exists(tp):
        T = json.load(open(tp)); V_ = np.load(vp)
        have = {t: i for i, t in enumerate(T)}
    else:
        T, V_ = [], np.zeros((0, 1), np.float32)
    old = os.path.join(CACHE, f'{tag}.npz')          # 迁移首版整份缓存（签名吻合才认）
    if os.path.exists(old) and not have:
        z = np.load(old, allow_pickle=True)
        if str(z['sig']) == hashlib.md5(json.dumps([chunks, queries], ensure_ascii=False).encode()).hexdigest():
            T = want[:]; V_ = np.vstack([z['C'], z['Q']]); have = {t: i for i, t in enumerate(T)}
            print(f'  {model}：首版缓存签名吻合，已迁移 {len(T)} 条', file=sys.stderr)
    miss = [t for t in dict.fromkeys(want) if t not in have]
    if miss:
        if os.environ.get('EVAL_CACHE_ONLY'):
            raise SystemExit(f'{model} 缺 {len(miss)} 条向量，EVAL_CACHE_ONLY=1 不重算')
        print(f'  {model}：补算 {len(miss)} 条（已缓存 {len(have)}）', file=sys.stderr)
        NV = embed(model, miss)
        V_ = NV if not len(T) else np.vstack([V_, NV]); T = T + miss
        have = {t: i for i, t in enumerate(T)}
    if miss or not os.path.exists(tp):
        json.dump(T, open(tp, 'w'), ensure_ascii=False); np.save(vp, V_)
        os.chmod(tp, 0o600); os.chmod(vp, 0o600)
    idx = [have[t] for t in want]
    M_ = V_[idx]
    return M_[:len(chunks)], M_[len(chunks):]

# ── 打分 ──
def kw_scores(q):
    terms = [t.lower() for t in re.split(r'[\s|]+', q) if len(t) >= 2]
    return np.array([sum(1 for t in terms if t in text[f]) for f in files], dtype=np.float32)
def sem_scores(C, Q, q):
    s = C @ Q[qpos[q]]; out = np.full(len(files), -1.0, dtype=np.float32)
    np.maximum.at(out, owner, s); return out
def rank(scores, tgt, t_query, excl, zero_miss):
    t = fidx[tgt]
    if zero_miss and scores[t] <= 0:
        return 10 ** 9
    live = (born < t_query) | (born < HORIZON)   # 查询那一刻已经存在的文件
    for e in excl:
        live[fidx[e]] = False
    live[t] = True
    live[t] = False
    # 并列按随机打破的期望名次（v1 给目标最有利名次，通用检索词造成大量并列时会虚高）
    return int(np.sum((scores > scores[t]) & live)) + 1 + int(np.sum((scores == scores[t]) & live)) / 2
def rrf(a, b):
    ra = np.argsort(np.argsort(-a)); rb = np.argsort(np.argsort(-b))
    return 1 / (61 + rb) + np.where(a > 0, 1 / (61 + ra), 0)

def named(q, o):
    stem = o[:-3].lower(); ql = q.lower()
    return stem in ql or any(len(t) >= 12 and t in stem for t in re.split(r'[\s|]+', ql))

def evaluate(methods, target_of, drop_named, subset=None):
    hit = {m: {k: 0 for k in K} for m in methods}; n = 0
    for p in pairs:
        if subset and not subset(p): continue
        tgt = target_of(p)
        if tgt is None: continue
        qs = [(q, t) for q, t in p['q'] if not (drop_named and named(q, p['old']))]
        if not qs or (births.get(tgt, 0) >= HORIZON and births.get(tgt, 0) >= max(t for _, t in qs)):
            continue
        n += 1
        for m, fn in methods.items():
            best = min(rank(fn(q), tgt, t, p['excl'], m == 'rg式关键词') for q, t in qs)
            for k in K:
                hit[m][k] += best <= k
    return n, hit

def main():
    models = [] if sys.argv[1:] == ['--kw'] else (sys.argv[1:] or ['qwen3-embedding:0.6b'])
    print(f'目标：真复发对子 {len(pairs)}（金标准 {sum(p["gold"] for p in pairs)}，O 常驻 {sum(p["resident"] for p in pairs)}）；'
          f'查询 {len(queries)} 条；语料 {len(files)} 文件 / {len(chunks)} 块\n')
    V = {m: vectors(m) for m in models}
    cache = {}
    def memo(k, fn):                      # setdefault 会先把值算出来，缓存形同虚设，所以显式判断
        if k not in cache:
            cache[k] = fn()
        return cache[k]
    kw = lambda q: memo(('kw', q), lambda: kw_scores(q))
    sem = lambda b, q: memo(('sem', b, q), lambda: sem_scores(*V[b], q))
    def mk(m):
        if m == 'rg式关键词':
            return kw
        if m.startswith('融合 '):
            b = m[3:]
            return lambda q: memo(('rrf', b, q), lambda: rrf(kw(q), sem(b, q)))
        return lambda q: sem(m, q)
    names = ['rg式关键词'] + models + [f'融合 {m}' for m in models]
    methods = {m: mk(m) for m in names}
    for title, drop, sub in (('全部查询', False, None), ('去掉点名查询（只看「发现」）', True, None),
                             ('去掉点名查询 · 只看旧教训【非常驻】的（检索真正能帮上的那部分）', True, lambda p: not p['resident'])):
        n, real = evaluate(methods, lambda p: p['old'], drop, sub)
        rnd = {m: {k: 0.0 for k in K} for m in names}
        random.seed(7)
        for _ in range(R):
            def pick(p):
                pool = [f for f in files if f not in p['excl'] and f != p['old']]
                return random.choice(pool)
            _, h = evaluate(methods, pick, drop, sub)
            for m in names:
                for k in K: rnd[m][k] += h[m][k] / R
        print(f"== {title}：{n} 对，每对取最好名次 ==")
        print(f"{'方法':<28}" + ''.join(f'  命中@{k}（碰运气）' for k in K))
        for m in names:
            print(f'{m:<28}' + ''.join(f'  {real[m][k]:>2}/{n} {real[m][k]/max(n,1):>4.0%}（{rnd[m][k]/max(n,1):>3.0%}）' for k in K))
        print()

if __name__ == '__main__':
    main()
