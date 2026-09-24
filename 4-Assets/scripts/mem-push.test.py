#!/usr/bin/env python3
"""mem-push.py 的测试：本地目录扮演 Air（MEMPUSH_REMOTE=local:…），全部在临时目录里，不碰真实记忆与 Air。
用法：python3 mem-push.test.py [--script 路径]   （--script 测改坏的副本，必须变红）
"""
import os, sys, json, shutil, tempfile, subprocess, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
a = sys.argv[1:]
SCRIPT = a[a.index('--script') + 1] if '--script' in a else os.path.join(HERE, 'mem-push.py')
PASS = FAIL = 0


def check(label, cond):
    global PASS, FAIL
    if cond: PASS += 1; print(f'  ✅ {label}')
    else: FAIL += 1; print(f'  ❌ {label}')


def md5(p):
    return hashlib.md5(open(p, 'rb').read()).hexdigest() if os.path.exists(p) else 'ABSENT'


class World:
    def __init__(self):
        self.t = tempfile.mkdtemp()
        self.dev, self.mir, self.air, self.st = (os.path.join(self.t, x) for x in ('dev', 'mirror', 'air', 'state'))
        for d in (self.dev, self.mir, self.air):
            os.makedirs(d)

    def put(self, where, name, text):
        open(os.path.join(getattr(self, where), name), 'w').write(text)

    def get(self, where, name):
        p = os.path.join(getattr(self, where), name)
        return open(p).read() if os.path.exists(p) else None

    def sync(self, name, text):      # 模拟一次正常的 Air 同步后状态：三处一致
        for w in ('dev', 'mir', 'air'):
            self.put(w, name, text)

    def run(self, *args, air_up=True):
        airdir = self.air if air_up else self.air + '.down'
        env = {**os.environ, 'MEMPUSH_CANON': self.dev, 'MEMPUSH_MIRROR': self.mir, 'MEMPUSH_STATE': self.st,
               'MEMPUSH_REMOTE': 'local:' + airdir}
        return subprocess.run([sys.executable, SCRIPT, *args], env=env, capture_output=True, text=True, timeout=60)

    def log(self):
        p = os.path.join(self.st, 'log.jsonl')
        return [json.loads(l) for l in open(p)] if os.path.exists(p) else []

    def pending(self):
        d = os.path.join(self.st, 'pending')
        return sorted(n[:-5] for n in os.listdir(d) if n.endswith('.json')) if os.path.isdir(d) else []

    def done(self):
        shutil.rmtree(self.t)


print('═══ 1. 无改动：不登记、不联系 Air ═══')
w = World(); w.sync('a.md', 'v1')
r = w.run(air_up=False)
check('无 pending、无日志（Air 不可达也不报）', w.pending() == [] and w.log() == [] and r.returncode == 0)
w.done()

print('═══ 2. 开发机改了已有文件、Air 没动 → 推送 ═══')
w = World(); w.sync('a.md', 'v1'); w.sync('b.md', 'keep')
w.put('dev', 'a.md', 'v2-dev')
r = w.run()
check('Air 上变成开发机版本', w.get('air', 'a.md') == 'v2-dev')
check('镜像跟上、pending 清空', w.get('mir', 'a.md') == 'v2-dev' and w.pending() == [])
check('没改的文件不碰', w.get('air', 'b.md') == 'keep' and [x['file'] for x in w.log() if x['action'] == 'pushed'] == ['a.md'])
w.done()

print('═══ 3. 已手动推过（Air == 开发机、镜像旧）→ 不推，只刷新镜像 ═══')
w = World(); w.sync('a.md', 'v1'); w.put('dev', 'a.md', 'v2'); w.put('air', 'a.md', 'v2')
m0 = os.stat(os.path.join(w.air, 'a.md')).st_mtime_ns
w.run()
check('Air 文件没被重写', os.stat(os.path.join(w.air, 'a.md')).st_mtime_ns == m0)
check('记为 already、镜像刷新', [x['action'] for x in w.log()] == ['already'] and w.get('mir', 'a.md') == 'v2')
w.done()

print('═══ 4. Air 也改过 → 冲突，两边都不动 ═══')
w = World(); w.sync('a.md', 'v1'); w.put('dev', 'a.md', 'v2-dev'); w.put('air', 'a.md', 'v2-air')
w.run(); w.run()
check('Air 与开发机都原样', w.get('air', 'a.md') == 'v2-air' and w.get('dev', 'a.md') == 'v2-dev')
check('conflicts.txt 记了它、pending 保留', open(os.path.join(w.st, 'conflicts.txt')).read().split() == ['a.md'] and w.pending() == ['a.md'])
check('跑两次冲突日志只记一次', sum(1 for x in w.log() if x['action'] == 'conflict') == 1)
w.done()

print('═══ 5. Air 不可达 → 改动留在 pending；随后 6c 把开发机冲回旧版 → Air 回来后推送并复原 ═══')
w = World(); w.sync('a.md', 'v1'); w.put('dev', 'a.md', 'v2-dev')
w.run(air_up=False)
check('不可达时 pending 保留改动', w.pending() == ['a.md'] and w.get('air', 'a.md') == 'v1')
w.put('dev', 'a.md', 'v1')                     # 模拟 12:30 的 6c：开发机被 Air 旧版覆盖
w.run()
check('Air 回来后推送了改动', w.get('air', 'a.md') == 'v2-dev')
check('开发机那份被复原', w.get('dev', 'a.md') == 'v2-dev' and any(x['action'] == 'restored' for x in w.log()))
w.done()

print('═══ 6. 开发机新建文件 → 推（Air 端要求文件不存在）═══')
w = World(); w.put('dev', 'new_one.md', 'hello')
w.run()
check('新文件到了 Air、镜像也有', w.get('air', 'new_one.md') == 'hello' and w.get('mir', 'new_one.md') == 'hello')
w.done()

print('═══ 7. 不处理的文件 ═══')
w = World(); w.sync('MEMORY.md', 'idx'); w.put('dev', 'MEMORY.md', 'derived-local')
w.put('dev', '.hidden.md', 'x'); w.put('dev', 'bad name.md', 'x'); w.put('dev', 'notes.txt', 'x')
w.run()
check('MEMORY.md / 点文件 / 非法文件名 / 非 .md 都不推', w.get('air', 'MEMORY.md') == 'idx' and sorted(os.listdir(w.air)) == ['MEMORY.md'] and w.pending() == [])
w.done()

print('═══ 8. --dry-run 什么都不写 ═══')
w = World(); w.sync('a.md', 'v1'); w.put('dev', 'a.md', 'v2')
r = w.run('--dry-run')
check('Air/镜像/pending/日志都不变，但报告了「将推送」', w.get('air', 'a.md') == 'v1' and w.get('mir', 'a.md') == 'v1'
      and w.pending() == [] and w.log() == [] and '将推送' in r.stdout)
w.done()

w = World(); w.sync('a.md', 'v1'); w.put('dev', 'a.md', 'v2-dev'); w.put('air', 'a.md', 'v2-air')
w.run('--dry-run')
check('冲突情形下预演也不写 conflicts.txt / pending', not os.path.exists(os.path.join(w.st, 'conflicts.txt')) and w.pending() == [])
w.done()

print('═══ 9. 推不出去期间又改了一次 → pending 取最新内容，基线仍是最初那版 ═══')
w = World(); w.sync('a.md', 'v1'); w.put('dev', 'a.md', 'v2')
w.run(air_up=False)
w.put('dev', 'a.md', 'v3')
w.run(air_up=False)
meta = json.load(open(os.path.join(w.st, 'pending', 'a.md.json')))
check('基线 = v1 的 md5', meta['base'] == hashlib.md5(b'v1').hexdigest())
w.run()
check('最终推上去的是 v3', w.get('air', 'a.md') == 'v3')
w.done()

print(f'\n═══ 结果：{PASS} 通过 / {FAIL} 失败（被测：{SCRIPT}）═══')
sys.exit(1 if FAIL else 0)
