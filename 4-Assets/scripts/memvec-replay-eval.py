#!/usr/bin/env python3
"""memvec-replay-eval.py — 向量检索上线前的离线回放验收（Dream-RSI 式：拿历史当模拟器）。

样本：评估器里「非常驻 & 查过记忆但没查到 & 仍踩」的对子；查询 = 该会话写新教训之前真实用过的检索词。
比较：rg 式关键词（按命中词数排序，并列时给它最有利的名次）、语义检索（块级最大余弦）、两者 RRF 融合。
对照：同一批查询换成随机目标文件，得到「碰运气」的命中率，真实命中率必须显著高于它才算数。
防泄漏：语料里排除新教训本身、以及同一会话写出的所有新文件（它们写于检索之后）。
"""
import json, os, re, random, sys
import numpy as np
D = '/tmp'; K = [5, 10]
cor = json.load(open(f'{D}/replay_corpus.json')); meta = cor['meta']
Q = json.load(open(f'{D}/replay_queries.json')); EXC = json.load(open(f'{D}/replay_exclude.json'))
dim = 1024
def load(n, rows): return np.fromfile(f'{D}/emb_{n}.f32', dtype=np.float32).reshape(rows, dim)
C = load('chunks', len(meta)); QV = load('queries', len(cor['queries'])); NV = load('neg', len(cor['neg']))
for M in (C, QV, NV): M /= np.linalg.norm(M, axis=1, keepdims=True)
files = sorted({m[0] for m in meta}); fidx = {f: i for i, f in enumerate(files)}
chunk_file = np.array([fidx[m[0]] for m in meta])
first_chunk = {m[0]: i for i, m in enumerate(meta) if m[1] == 0}
SRC = os.path.expanduser('~/.mycc-global/air-mirror')
text = {f: open(os.path.join(SRC, f), encoding='utf-8', errors='replace').read().lower() for f in files}
qpos = {q: i for i, q in enumerate(cor['queries'])}

def file_scores(vec):
    s = C @ vec; out = np.full(len(files), -1.0, dtype=np.float32)
    np.maximum.at(out, chunk_file, s); return out
_vcache = {}
def vec_rank(q):
    if q not in _vcache:
        sc = file_scores(QV[qpos[q]]); _vcache[q] = sc
    return _vcache[q]
def kw_scores(q):
    terms = [t.lower() for t in q.split() if len(t) >= 2]
    return np.array([sum(1 for t in terms if t in text[f]) for f in files], dtype=np.float32)
_kcache = {}
def kw(q):
    if q not in _kcache: _kcache[q] = kw_scores(q)
    return _kcache[q]

def rank_of(scores, target, excl, optimistic=True, zero_is_miss=False):
    t = fidx[target]
    if zero_is_miss and scores[t] <= 0: return 10**9
    mask = np.ones(len(files), bool)
    for e in excl:
        if e in fidx: mask[fidx[e]] = False
    mask[t] = True
    better = np.sum((scores > scores[t]) & mask)
    return int(better) + 1 if optimistic else int(np.sum((scores >= scores[t]) & mask))
def rrf_scores(q):
    k, v = kw(q), vec_rank(q)
    rk = np.argsort(np.argsort(-k)); rv = np.argsort(np.argsort(-v))
    s = 1 / (60 + rv + 1)
    s = s + np.where(k > 0, 1 / (60 + rk + 1), 0)
    return s

methods = {'rg式关键词': lambda q: kw(q), '语义': vec_rank, '融合RRF': rrf_scores}
def evaluate(target_of):
    res = {m: {k: 0 for k in K} for m in methods}; n = 0
    for p in Q:
        if not p['search']: continue
        tgt = target_of(p)
        if tgt is None or tgt not in fidx: continue
        n += 1
        excl = set(EXC.get(p['sid'], [])) | {p['new']}
        for m, fn in methods.items():
            best = min(rank_of(fn(q), tgt, excl, zero_is_miss=(m == 'rg式关键词')) for q in p['search'])
            for k in K:
                if best <= k: res[m][k] += 1
    return n, res

n, real = evaluate(lambda p: p['old'])
random.seed(7); null = {m: {k: 0.0 for k in K} for m in methods}; R = 10
for r in range(R):
    pool = files[:]
    def rnd(p):
        excl = set(EXC.get(p['sid'], [])) | {p['new'], p['old']}
        while True:
            f = random.choice(pool)
            if f not in excl: return f
    _, res = evaluate(rnd)
    for m in methods:
        for k in K: null[m][k] += res[m][k] / R
print(f"== 搜索场景：{n} 对（每对用写入前的全部真实检索词，取最好名次）==")
print(f"{'方法':<10}" + ''.join(f"  命中@{k}  碰运气@{k}" for k in K))
for m in methods:
    print(f"{m:<10}" + ''.join(f"  {real[m][k]:>3}/{n} ({real[m][k]/n:>4.0%})  {null[m][k]/n:>5.0%}" for k in K))

# 读文件场景：会话读了记忆文件 X 时，X 的语义近邻里有没有那条旧教训
hits = {k: 0 for k in K}; nn = 0; nullr = {k: 0.0 for k in K}
for p in Q:
    reads = [r for r in p['read'] if r in first_chunk and r != p['old']]
    if not reads or p['old'] not in fidx: continue
    nn += 1; excl = set(EXC.get(p['sid'], [])) | {p['new']}
    best = 10**9; rnd_best = {r: 10**9 for r in range(R)}
    for r in reads:
        sc = file_scores(C[first_chunk[r]]); ex = excl | {r}
        best = min(best, rank_of(sc, p['old'], ex))
    for k in K:
        if best <= k: hits[k] += 1
print(f"\n== 读文件场景：{nn} 对（读到的记忆文件的语义近邻里是否有那条旧教训）==")
print(''.join(f"  命中@{k}: {hits[k]}/{nn} ({hits[k]/max(1,nn):.0%})" for k in K))

# 阈值：无关查询的最高相似度 vs 真实命中时旧教训的相似度
neg_top = sorted(float(file_scores(v).max()) for v in NV)
pos_sims = []
for p in Q:
    if p['old'] not in fidx: continue
    for q in p['search']:
        sc = vec_rank(q); excl = set(EXC.get(p['sid'], [])) | {p['new']}
        if rank_of(sc, p['old'], excl) <= 5: pos_sims.append(float(sc[fidx[p['old']]]))
pos_sims.sort()
print(f"\n== 阈值 ==\n无关查询 top1 相似度: 最小 {neg_top[0]:.3f} 中位 {neg_top[len(neg_top)//2]:.3f} 最大 {neg_top[-1]:.3f}")
if pos_sims:
    for t in (neg_top[-1], neg_top[-1] + 0.02, 0.5, 0.55, 0.6):
        print(f"  阈值 {t:.3f}: 真实命中里保留 {sum(1 for s in pos_sims if s >= t)}/{len(pos_sims)} ({sum(1 for s in pos_sims if s >= t)/len(pos_sims):.0%})，无关查询误报 {sum(1 for s in neg_top if s >= t)}/{len(neg_top)}")
