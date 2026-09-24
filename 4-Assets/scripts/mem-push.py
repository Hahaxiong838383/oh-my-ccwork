#!/usr/bin/env python3
"""开发机记忆改动即时回推 Air（2026-09-24，川哥批的「第 1 步：写入不丢」）。

问题：Air 同步（每天 12:30，Air 醒着才跑）6a 只回流开发机「新建」的文件，6c 以 Air 为准推回开发机——
开发机上**改已有记忆**（任何 agent：Claude / codex / grok），下次同步就被冲掉。9-23 那晚是 cc 逐个手动 CAS 推的。

做法（不改 Air 脚本，Air 仍是权威）：
  基线 = ~/.mycc-global/air-mirror/（6d 逐字节镜像的 Air 版）。开发机文件 ≠ 基线 → 视为本机改动：
  1. 先把改动存进 pending（内容 + 基线 md5），之后无论推没推成、被 6c 冲没冲，改动都不会丢；
  2. 一次 ssh 取 Air 上这些文件的 md5：
       Air == 改动   → 已在 Air（手动推过/6a 回流过），清 pending、刷新镜像
       Air == 基线   → Air 没动过，推（Air 端先比 md5 再原子替换）；成功后若开发机那份已被 6c 冲回旧版，复原
       其他          → 冲突：Air 也改过。两边都不动，记进 conflicts.txt 等人合并
       Air 不可达    → pending 留着，下次再试
不处理：MEMORY.md（开发机是派生版）、点文件、删除。文件名只接受 [A-Za-z0-9._-]+.md。
用法：mem-push.py [--dry-run]    （systemd：mem-push.path 盯目录即触发；mem-push.timer 每 30 分钟兜底）
留痕：~/.mycc-global/mem-push/log.jsonl（每次动作一行）；Air 端文件变更由 Air 同步第 2 步进 git。
"""
import os, re, sys, json, time, fcntl, hashlib, subprocess, datetime

H = os.path.expanduser('~')
CANON = os.environ.get('MEMPUSH_CANON', f'{H}/.claude/projects/-home-hahaxiong83-mycc/memory')
MIRROR = os.environ.get('MEMPUSH_MIRROR', f'{H}/.mycc-global/air-mirror')
STATE = os.environ.get('MEMPUSH_STATE', f'{H}/.mycc-global/mem-push')
REMOTE = os.environ.get('MEMPUSH_REMOTE', 'ssh')        # 'ssh' 或 'local:/目录'（测试用）
AIR_SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-J', 'dev198', 'rayman.chen@RaymanMacBook-Air.local']
AIR_DIR = os.environ.get('MEMPUSH_AIR_DIR', '.claude/projects/-Users-rayman-chen-mycc/memory')   # 相对 Air 的 $HOME
NAME = re.compile(r'^[A-Za-z0-9._-]+\.md$')
SKIP = {'MEMORY.md'}
ABSENT = 'ABSENT'


def md5b(b):
    return hashlib.md5(b).hexdigest()


def md5f(p):
    try:
        with open(p, 'rb') as f:
            return md5b(f.read())
    except FileNotFoundError:
        return ABSENT


def atomic_write(path, data):
    d = os.path.dirname(path)
    tmp = os.path.join(d, f'.{os.path.basename(path)}.mp.{os.getpid()}')
    with open(tmp, 'wb') as f:
        f.write(data)
    if os.path.exists(path):
        os.chmod(tmp, os.stat(path).st_mode & 0o777)
    os.replace(tmp, path)


# ---------- Air 端 ----------
class SshAir:
    def md5s(self, names):
        script = ('cd "$HOME/%s" || exit 3; for f in %s; do if [ -f "$f" ]; then printf "%%s %%s\\n" "$(md5 -q "$f")" "$f"; '
                  'else printf "ABSENT %%s\\n" "$f"; fi; done') % (AIR_DIR, ' '.join(names))
        r = subprocess.run(AIR_SSH + [script], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise ConnectionError(f'ssh rc={r.returncode}')
        out = {}
        for l in r.stdout.splitlines():
            h, _, n = l.partition(' ')
            if n:
                out[n] = h
        if set(out) != set(names):
            raise ConnectionError('Air 返回的文件清单不全')
        return out

    def put(self, name, data, expected):
        script = ('cd "$HOME/{d}" || exit 3; f={n}; t=".{n}.mp.tmp"; cur=$(md5 -q "$f" 2>/dev/null || echo ABSENT); '
                  'if [ "$cur" != "{e}" ]; then cat >/dev/null; echo "CAS_FAIL $cur"; exit 0; fi; cat > "$t" || exit 4; '
                  'cur=$(md5 -q "$f" 2>/dev/null || echo ABSENT); '
                  'if [ "$cur" = "{e}" ]; then mv "$t" "$f" && echo "OK $(md5 -q "$f")"; else rm -f "$t"; echo "CAS_FAIL $cur"; fi'
                  ).format(d=AIR_DIR, n=name, e=expected)
        r = subprocess.run(AIR_SSH + [script], input=data, capture_output=True, timeout=60)
        if r.returncode != 0:
            raise ConnectionError(f'ssh rc={r.returncode}')
        out = r.stdout.decode().strip().split()
        return (out[:1] == ['OK'] and out[1:2] == [md5b(data)]), (out[1] if len(out) > 1 else '?')


class LocalAir:
    """测试用：一个本地目录扮演 Air。目录不存在 = 不可达。"""
    def __init__(self, d):
        self.d = d

    def md5s(self, names):
        if not os.path.isdir(self.d):
            raise ConnectionError('unreachable')
        return {n: md5f(os.path.join(self.d, n)) for n in names}

    def put(self, name, data, expected):
        if not os.path.isdir(self.d):
            raise ConnectionError('unreachable')
        p = os.path.join(self.d, name)
        cur = md5f(p)
        if cur != expected:
            return False, cur
        atomic_write(p, data)
        return True, md5b(data)


def air():
    return LocalAir(REMOTE[6:]) if REMOTE.startswith('local:') else SshAir()


# ---------- pending ----------
def pdir():
    d = os.path.join(STATE, 'pending')
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def pending_all():
    d = pdir()
    return {n[:-5]: json.load(open(os.path.join(d, n))) for n in os.listdir(d) if n.endswith('.json')}


def pending_set(name, content, base):
    d = pdir()
    atomic_write(os.path.join(d, name + '.data'), content)
    atomic_write(os.path.join(d, name + '.json'), json.dumps({'base': base, 'md5': md5b(content),
                                                               'since': datetime.datetime.now().isoformat(timespec='seconds')}).encode())


def pending_data(name):
    return open(os.path.join(pdir(), name + '.data'), 'rb').read()


def pending_clear(name):
    for suf in ('.json', '.data'):
        try:
            os.remove(os.path.join(pdir(), name + suf))
        except FileNotFoundError:
            pass


def log(rec):
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    rec = {'ts': datetime.datetime.now().isoformat(timespec='seconds'), **rec}
    with open(os.path.join(STATE, 'log.jsonl'), 'a') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    print(f"  {rec['action']:10} {rec.get('file', '')}")


# ---------- 主流程 ----------
def scan_local(dry=False):
    """开发机 ≠ 镜像 的文件 → 登记/更新 pending（dry 时只算不写）。返回 {本轮新登记的文件: (内容, 基线)}。"""
    touched = {}
    pend = pending_all()
    for n in sorted(os.listdir(CANON)):
        if n in SKIP or n.startswith('.') or not NAME.match(n):
            continue
        with open(os.path.join(CANON, n), 'rb') as f:
            data = f.read()
        d, m = md5b(data), md5f(os.path.join(MIRROR, n))
        if d == m:
            continue
        p = pend.get(n)
        if p is None:
            touched[n] = (data, m)
        elif p['md5'] != d and d != p['base']:     # 本机又改了一次（基线仍是最初那版 Air）
            touched[n] = (data, p['base'])
    if not dry:
        for n, (data, base) in touched.items():
            pending_set(n, data, base)
    return touched


def settle(dry=False, extra=None):
    pend = pending_all()
    extra = extra or {}
    for n, (data, base) in extra.items():      # dry-run：本轮扫描结果只在内存里
        pend[n] = {'base': base, 'md5': md5b(data), '_data': data}
    if not pend:
        return {'pushed': 0, 'already': 0, 'conflict': 0, 'unreachable': 0}
    names = sorted(pend)
    stat = dict.fromkeys(('pushed', 'already', 'conflict', 'unreachable', 'restored'), 0)
    try:
        airs = air().md5s(names)
    except (ConnectionError, subprocess.TimeoutExpired, OSError) as e:
        log({'action': 'unreachable', 'n': len(names), 'err': str(e)[:120]})
        stat['unreachable'] = len(names)
        return stat
    conflicts = []
    for n in names:
        p = pend[n]; a = airs[n]; data = p['_data'] if '_data' in p else pending_data(n)
        if a == p['md5']:
            action = 'already'
        elif a == p['base']:
            if dry:
                print(f'  将推送    {n}'); stat['pushed'] += 1; continue
            ok, cur = air().put(n, data, p['base'])
            if not ok:
                conflicts.append(n); log({'action': 'conflict', 'file': n, 'base': p['base'], 'air': cur, 'mine': p['md5']})
                stat['conflict'] += 1; continue
            action = 'pushed'
        else:
            conflicts.append(n); stat['conflict'] += 1
            if p.get('conflict_air') != a and not dry:   # 同一冲突只记一次，不每 30 分钟刷日志
                log({'action': 'conflict', 'file': n, 'base': p['base'], 'air': a, 'mine': p['md5']})
                p2 = {k: v for k, v in p.items() if not k.startswith('_')}; p2['conflict_air'] = a
                atomic_write(os.path.join(pdir(), n + '.json'), json.dumps(p2).encode())
            continue
        if dry:
            print(f'  已在 Air  {n}'); stat[action] += 1; continue
        # 成功：镜像跟上 Air；开发机若已被 6c 冲回基线，复原本机改动（本机又有新改动则不碰，下一轮处理）
        atomic_write(os.path.join(MIRROR, n), data)
        cp = os.path.join(CANON, n)
        if md5f(cp) == p['base'] and p['base'] != p['md5']:
            atomic_write(cp, data); log({'action': 'restored', 'file': n})
            stat['restored'] += 1
        pending_clear(n)
        log({'action': action, 'file': n, 'base': p['base'], 'new': p['md5']})
        stat[action] += 1
    cf = os.path.join(STATE, 'conflicts.txt')
    if dry:
        return stat
    if conflicts:
        atomic_write(cf, ('\n'.join(conflicts) + '\n').encode())
    elif os.path.exists(cf):
        os.remove(cf)
    return stat


def main():
    dry = '--dry-run' in sys.argv
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    with open(os.path.join(STATE, '.lock'), 'w') as lk:
        try:
            fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('另一实例在跑，跳过'); return
        total = {}
        for _ in range(3):                    # 跑的过程中又有新改动：再扫一轮，最多 3 轮
            touched = scan_local(dry)
            st = settle(dry, touched if dry else None)
            for k, v in st.items():
                total[k] = total.get(k, 0) + v
            if not touched or dry or st.get('unreachable'):
                break
    if any(total.values()):
        print('合计', {k: v for k, v in total.items() if v})


if __name__ == '__main__':
    main()
