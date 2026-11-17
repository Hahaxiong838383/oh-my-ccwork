#!/usr/bin/env python3
"""memory-server.mjs 的端到端测试：临时 A 库 + 临时旧库，经 stdio JSON-RPC 真实调用（2026-09-24 加旧库检索时补）。
用法：python3 memory-server.test.py [--server 路径]   （--server 测改坏的副本，必须变红）
"""
import os, sys, json, tempfile, subprocess, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
a = sys.argv[1:]
SERVER = a[a.index('--server') + 1] if '--server' in a else os.path.join(HERE, 'memory-server.mjs')
NODE = shutil.which('node') or os.path.expanduser('~/local/node/bin/node')
PASS = FAIL = 0


def check(label, cond, extra=''):
    global PASS, FAIL
    if cond: PASS += 1; print(f'  ✅ {label}')
    else: FAIL += 1; print(f'  ❌ {label} {extra[:300]!r}')


def call(env, name, args):
    reqs = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'test'}}},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}}]
    p = subprocess.run([NODE, SERVER], input='\n'.join(json.dumps(r) for r in reqs) + '\n', capture_output=True, text=True,
                       env={**os.environ, **env}, timeout=30)
    out = [json.loads(l) for l in p.stdout.splitlines() if l.strip()]
    r = next(o for o in out if o.get('id') == 2)['result']
    return r.get('isError', False), r['content'][0]['text']


with tempfile.TemporaryDirectory() as td:
    mem = os.path.join(td, 'mem'); os.makedirs(mem)
    open(os.path.join(mem, 'feedback_bot_site.md'), 'w').write('---\nname: bot_site\ndescription: 两个 Bot 的站点\n---\n产品专家 在 dev198，专家 在 Mini\n')
    open(os.path.join(mem, 'project_other.md'), 'w').write('---\nname: other\n---\n无关内容 alpha beta\n')
    legacy = os.path.join(td, 'memory-items.md')
    open(legacy, 'w').write('# 旧库\n### [project/网络]（2026-09-15）\n- ★★ 2026-09-15 DMIT 限速 从 5Mbps 调到 10Mbps\n'
                            '- ★ 产品专家 旧说法：在 Mini（2026-07-01）\n非条目行里也有 DMIT 不应返回\n- ★ alpha 与 gamma 同行\n')
    env = {'MYCC_MEMORY_DIR': mem, 'MYCC_LEGACY_ITEMS': legacy, 'HOME': td}

    print('═══ 两库都命中 ═══')
    err, t = call(env, 'memory_search', {'query': '产品专家'})
    check('A 库结果在前、旧库段在后', not err and t.index('feedback_bot_site.md') < t.index('legacy memory-items'), t)
    check('旧库条目带行号与日期', '[L4] (2026-07-01)' in t, t)
    check('提示旧库可能过时、冲突按日期', 'newer dated statement' in t, t)

    print('═══ 只在旧库 ═══')
    err, t = call(env, 'memory_search', {'query': '10Mbps'})
    check('A 无结果时不再报「真零结果」，并给出旧库命中', not err and 'genuine zero-result' not in t and '10Mbps' in t and '[L3] (2026-09-15)' in t, t)
    err, t = call(env, 'memory_search', {'query': 'DMIT'})
    check('非条目行不返回（该行也含 DMIT，只应返回条目行）', 'DMIT 限速' in t and '非条目行' not in t, t)

    print('═══ 多词降级 ═══')
    err, t = call(env, 'memory_search', {'query': 'alpha gamma'})
    check('旧库全词命中（同一行两个词）', 'all-terms(2)' in t.split('legacy')[1] and 'alpha 与 gamma' in t, t)

    print('═══ 两库都没有 ═══')
    err, t = call(env, 'memory_search', {'query': 'zzz_nothing'})
    check('两边都说明没命中', 'No A-canonical memory matched' in t and 'no entry matched' in t, t)

    print('═══ 旧库文件不存在 ═══')
    err, t = call({**env, 'MYCC_LEGACY_ITEMS': os.path.join(td, 'nope.md')}, 'memory_search', {'query': '产品专家'})
    check('A 照常返回，旧库段说明文件不在', not err and 'feedback_bot_site.md' in t and 'not present on this machine' in t, t)

    print('═══ memory_read 不受影响 ═══')
    err, t = call(env, 'memory_read', {'name': 'feedback_bot_site'})
    check('读得到全文', not err and 'dev198' in t, t)
    err, t = call(env, 'memory_read', {'name': '../memory-items'})
    check('路径穿越仍被拒', err, t)

print(f'\n═══ 结果：{PASS} 通过 / {FAIL} 失败（被测：{SERVER}）═══')
sys.exit(1 if FAIL else 0)
