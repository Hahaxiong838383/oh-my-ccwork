#!/usr/bin/env python3
"""找出并等长遮蔽泄漏到会话日志等位置的密钥（2026-09-23，川哥放行：「要脱敏」）。

密钥来源（只在本进程内存里，交给 grep 走 stdin，绝不进 argv / 磁盘 / 输出）：
  v01..  密码库条目的密码、历史密码、TOTP、隐藏字段、卡号（vw list items）
  k01..  cfgview.known_secret_values()：grok/codex 配置、P01 app.env、codeg agent 环境变量里的密钥值（含中转网关 key）
两档遮蔽：
  全局：出现即遮（长度 ≥ MIN_LEN，且不是公开值）
  语境：公开值（是 git 远端地址 / git 用户名的子串，例如与 GitHub 用户名重合的密码）与短值，
        只在 "password"/"totp" 字段语境里遮——全局遮会把仓库地址之类的公开信息改坏，且没有安全收益
用法：
  redact-leaks.py scan [--out 报告.json] [根目录...]    只读：命中文件、每号密钥次数、整库痕迹行数
  redact-leaks.py ctx <编号> <文件> [条数]               看语境（所有值换成 ‹编号›，其余过 cfgview 遮蔽）
  redact-leaks.py apply --list 清单.txt [--dry-run]     就地等长遮蔽清单里的文件（文本 pwrite；SQLite 走 UPDATE）
输出只含编号、长度、计数与路径，绝不含值或条目名。
"""
import os, re, sys, json, sqlite3, subprocess, collections

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from cfgview import known_secret_values

HOME = os.path.expanduser('~')
VW = os.path.join(HOME, '.local/bin/vw')
MIN_LEN = 8                   # 更短的值不做全局匹配，只在字段语境里认（9-23 实测：6 位的那个密码在第三方库、
                              # 安卓镜像、工具调用 ID 这些随机串里到处撞上）
DUMP_MIN = 3                  # 同一行出现 ≥3 个不同的库密钥 = 整库/半库导出痕迹
TAG = b'REDACTED-by-cc-20260923'
PUBLIC_REPOS = [os.path.join(HOME, 'mycc'), os.path.join(HOME, 'MyAgent')]


def vault_secrets():
    """[(值, 种类)]，种类 ∈ pw/hist/totp/hidden/card。"""
    r = subprocess.run([VW, 'list', 'items'], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        sys.exit(f'vw list items 失败 rc={r.returncode}（stderr 不打印，可能含敏感信息）')
    vals = []
    for it in json.loads(r.stdout):
        login = it.get('login') or {}
        for k, kind in (('password', 'pw'), ('totp', 'totp')):
            if isinstance(login.get(k), str) and login[k]:
                vals.append((login[k], kind))
        for h in it.get('passwordHistory') or []:
            if isinstance(h.get('password'), str) and h['password']:
                vals.append((h['password'], 'hist'))
        for f in it.get('fields') or []:
            if f.get('type') == 1 and isinstance(f.get('value'), str) and f['value']:
                vals.append((f['value'], 'hidden'))
        card = it.get('card') or {}
        for k in ('number', 'code'):
            if isinstance(card.get(k), str) and card[k]:
                vals.append((card[k], 'card'))
    return vals


def public_strings():
    """公开信息：本机仓库的 git 远端地址与 git 用户名/邮箱。密钥若是它们的子串，就不做全局遮蔽。"""
    out = []
    for repo in PUBLIC_REPOS:
        r = subprocess.run(['git', '-C', repo, 'remote', '-v'], capture_output=True, text=True)
        out += r.stdout.split()
    for k in ('user.name', 'user.email'):
        r = subprocess.run(['git', 'config', '--global', k], capture_output=True, text=True)
        out += r.stdout.split()
    return [s for s in out if s]


def proc_tokens():
    """正在运行的 codeg-mcp 进程的 --token 值（只读 /proc，进内存）。进程退出后就读不到了，要趁它还活着时遮。"""
    vals = []
    for d in os.listdir('/proc'):
        if not d.isdigit():
            continue
        try:
            argv = open(f'/proc/{d}/cmdline', 'rb').read().split(b'\0')
        except OSError:
            continue
        if argv and argv[0].endswith(b'codeg-mcp') and b'--token' in argv:
            i = argv.index(b'--token')
            if i + 1 < len(argv) and argv[i + 1]:
                vals.append(argv[i + 1].decode())
    return vals


def load_secrets():
    """[(编号, 值, 种类, 档位)]；档位 global/context。重复值只留第一个编号。"""
    pub = public_strings()
    res, seen = [], set()
    def add(sid, v, kind):
        if v in seen:
            return
        seen.add(v)
        tier = 'context' if len(v) < MIN_LEN or any(v in p for p in pub) else 'global'
        res.append((sid, v, kind, tier))
    for i, (v, kind) in enumerate(vault_secrets(), 1):
        add(f'v{i:02d}', v, kind)
    for i, v in enumerate(sorted(known_secret_values()), 1):
        add(f'k{i:02d}', v, 'known')
    for i, v in enumerate(proc_tokens(), 1):
        add(f'p{i:02d}', v, 'proc')
    return res


def variants(s, depth=4):
    """同一个值在文件里可能的写法：原文，以及逐层 JSON 转义 1～depth 层（会话记录里常见 JSON 套 JSON 再套），
    每层分 \\u 转义与不转义两种。纯字母数字的值各层都一样，只剩一个。"""
    out = []
    for asc in (False, True):
        v = s
        for _ in range(depth + 1):
            b = v.encode('utf-8')
            if b not in out:
                out.append(b)
            v = json.dumps(v, ensure_ascii=asc)[1:-1]
    return out


def context_regex(v):
    """"password"/"totp" 字段语境：(\\\\*)"password\\1"\\s*:\\s*\\1"<值>\\1"，转义深度用反向引用对齐。只捕获值本身。"""
    alts = b'|'.join(re.escape(b) for b in variants(v))
    return re.compile(rb'(\\*)"(?:password|totp)\1"\s*:\s*\1"(' + alts + rb')\1"')


def mask_for(n):
    if n >= len(TAG):
        return TAG + b'*' * (n - len(TAG))
    if n >= 8:
        return (b'REDACTED' + b'*' * n)[:n]
    return b'*' * n


# 按模式遮、不在已知值里的凭据：codeg-mcp 每个进程一枚 --token（进程参数里世界可读，`ps` 一打就进会话）
PATTERN_RULES = [('p-codeg-mcp-token', re.compile(rb'--token[ =]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'))]


def find_spans(data, secrets):
    """返回 [(起点, 终点, 编号)]，互不重叠，长的优先。"""
    cands = []
    for sid, rx in PATTERN_RULES:
        for m in rx.finditer(data):
            cands.append((m.start(1), m.end(1), sid))
    for sid, v, _, tier in secrets:
        if tier == 'global':
            for b in variants(v):
                i = data.find(b)
                while i >= 0:
                    cands.append((i, i + len(b), sid))
                    i = data.find(b, i + 1)
        else:
            for m in context_regex(v).finditer(data):
                cands.append((m.start(2), m.end(2), sid))
    cands.sort(key=lambda c: (-(c[1] - c[0]), c[0]))
    taken, spans = [], []
    for s, e, sid in cands:
        if any(s < te and ts < e for ts, te in taken):
            continue
        taken.append((s, e)); spans.append((s, e, sid))
    return sorted(spans)


def candidate_files(roots, patterns, mode='-F'):
    """GNU grep 多模式扫盘，模式经 stdin 传入（不进 argv、不落盘）。只返回文件名。mode：-F 定长串 / -E 正则。"""
    cmd = ['/usr/bin/grep', '-rls' + mode[1], '-D', 'skip', '-f', '/dev/stdin', '--', *roots]
    r = subprocess.run(cmd, input=b'\n'.join(patterns) + b'\n', capture_output=True,
                       env={**os.environ, 'LC_ALL': 'C'}, timeout=3600)
    if r.returncode not in (0, 1):
        print(f'⚠️ grep rc={r.returncode}（部分目录读不了属正常，-s 已静默）', file=sys.stderr)
    return [p for p in r.stdout.decode('utf-8', 'surrogateescape').split('\n') if p]


def context_ere(v):
    """语境档的 grep -E 版（只做候选筛选，精确判定仍用 context_regex）：\\"password\\" : \\"<值>。"""
    esc = lambda b: re.sub(rb'([][\\.^$*+?(){}|])', rb'\\\1', b)
    return [rb'"(password|totp)\\*"[[:space:]]*:[[:space:]]*\\*"' + esc(b) for b in variants(v)]


def dump_lines(data, vault_vs):
    return sum(1 for line in data.split(b'\n')
               if sum(1 for vs in vault_vs if any(x in line for x in vs)) >= DUMP_MIN)


def is_sqlite(path):
    try:
        with open(path, 'rb') as f:
            return f.read(16) == b'SQLite format 3\x00'
    except OSError:
        return False


def scan(roots, out_path):
    secrets = load_secrets()
    tiers = collections.Counter(t for *_, t in secrets)
    print(f"密钥：密码库 {sum(1 for s in secrets if s[0][0] == 'v')} 个、配置已知值 {sum(1 for s in secrets if s[0][0] == 'k')} 个；"
          f"全局遮 {tiers['global']} 个、只在字段语境遮 {tiers['context']} 个（公开值/短值）")
    glob_pats = sorted({b for sid, v, _, t in secrets if t == 'global' for b in variants(v)})
    ctx_pats = [p for sid, v, _, t in secrets if t == 'context' for p in context_ere(v)]
    files = candidate_files(roots, glob_pats)
    if ctx_pats:   # 语境档单独一遍 -E（只筛「password/totp 字段 + 该值」，不再拿 "password 当锚把大文件全拉进来）
        files = sorted(set(files) | set(candidate_files(roots, ctx_pats, '-E')))
    vault_vs = [variants(v) for sid, v, _, _ in secrets if sid[0] == 'v' and len(v) >= MIN_LEN]
    report = []
    for p in files:
        try:
            st = os.stat(p)
            with open(p, 'rb') as f:
                data = f.read()
        except OSError as e:
            report.append({'path': p, 'error': type(e).__name__}); continue
        spans = find_spans(data, secrets)
        if not spans:
            continue
        hits = collections.Counter(sid for *_, sid in spans)
        nv = sum(1 for s in hits if s[0] == 'v')
        report.append({'path': p, 'size': st.st_size, 'sqlite': is_sqlite(p), 'hits': dict(hits),
                       'dump_lines': dump_lines(data, vault_vs) if nv >= DUMP_MIN else 0})
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump({'secrets': {sid: {'len': len(v), 'kind': k, 'tier': t} for sid, v, k, t in secrets},
                   'files': report}, f, ensure_ascii=False, indent=1)
    print(f'候选 {len(files)} 个，确认命中 {len(report)} 个，报告：{out_path}')


def redact_file(path, secrets, dry):
    """文本/二进制文件：就地等长覆盖（不截断不改名，与并发追加兼容），保留 atime/mtime。返回 (改动数, 剩余数)。"""
    st = os.stat(path)
    with open(path, 'rb') as f:
        data = f.read()
    spans = find_spans(data, secrets)
    if dry or not spans:
        return len(spans), len(spans) if dry else 0
    fd = os.open(path, os.O_RDWR)
    try:
        done = 0
        for s, e, _ in spans:
            if os.pread(fd, e - s, s) == data[s:e]:     # 写前复核：这段字节没被别人改过
                os.pwrite(fd, mask_for(e - s), s); done += 1
        os.fsync(fd)
    finally:
        os.close(fd)
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))
    with open(path, 'rb') as f:
        left = len(find_spans(f.read(), secrets))
    return done, left


SQLITE_SIDE = ('-wal', '-shm', '-journal')     # 带校验和/锁状态，绝不按字节改；随主库 checkpoint 清理
# 合法存放处（库文件名, 表, 列）：这些列本来就该存密钥，遮了服务会坏
SQLITE_KEEP = {('codeg.db', 'agent_setting', 'env_json'), ('codeg.db', 'model_provider', 'api_key'),
               ('codeg.db', 'app_metadata', 'value')}   # app_metadata 里有 web_service_token（codeg 网页端登录用）
FTS_SHADOW = ('_data', '_idx', '_content', '_docsize', '_config', '_segments', '_segdir', '_stat')


def fts_layout(con):
    """返回 (要跳过的表名集合, 需要事后 rebuild 的外部内容 FTS 表, 内部内容 FTS 表)。
    外部内容（content='基础表'）：只改基础表，靠触发器同步索引，虚拟表本身不能再改；事后 rebuild 兜底。
    内部内容：通过虚拟表本身 UPDATE（FTS5 自己维护影子表）。影子表一律不直接碰，否则索引会坏。"""
    skip, rebuild, internal = set(), [], []
    for name, sql in con.execute("select name, sql from sqlite_master where sql like 'CREATE VIRTUAL TABLE%'"):
        skip |= {name + s for s in FTS_SHADOW}
        if re.search(r"content\s*=\s*['\"]\w+['\"]", sql or ''):
            skip.add(name); rebuild.append(name)
        elif re.search(r"content\s*=\s*['\"]['\"]", sql or ''):
            skip.add(name)                       # 无内容表：原文不在库里，索引里的词没法改
        else:
            internal.append(name)
    return skip, rebuild, internal


def db_hits(path, secrets):
    """只读：按 表.列 统计每号全局密钥的命中行数。返回 {(表, 列): {编号: 行数}}。"""
    con = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=30)
    out = {}
    for t in [r[0] for r in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]:
        for c in [r[1] for r in con.execute(f'pragma table_info("{t}")')]:
            for sid, v, _, tier in secrets:
                if tier != 'global':
                    continue
                n = 0
                for b in variants(v):
                    try:
                        n += con.execute(f'select count(*) from "{t}" where instr(CAST("{c}" AS BLOB), ?) > 0', (b,)).fetchone()[0]
                    except sqlite3.OperationalError:
                        pass
                if n:
                    out.setdefault((t, c), {})[sid] = n
    con.close()
    return out


def redact_sqlite(path, secrets, dry):
    """SQLite：逐表逐文本列 UPDATE replace()；secure_delete + VACUUM 清掉旧页里的残留。返回 (改动数, 剩余数)。
    SQLITE_KEEP 里的列不动；剩余数只数「不在保留列里」的命中。"""
    base = os.path.basename(path)
    con = sqlite3.connect(path, timeout=30)
    con.execute('PRAGMA secure_delete=ON')
    changed = 0
    skip, rebuild, _ = fts_layout(con)
    tables = [r[0] for r in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
              if r[0] not in skip]
    for t in tables:
        cols = [r[1] for r in con.execute(f'pragma table_info("{t}")')]
        for c in cols:
            if (base, t, c) in SQLITE_KEEP:
                continue
            for sid, v, _, tier in secrets:
                if tier != 'global':
                    continue
                for b in variants(v):
                    s = b.decode('utf-8')
                    n = con.execute(f'select count(*) from "{t}" where typeof("{c}")=\'text\' and instr("{c}", ?) > 0', (s,)).fetchone()[0]
                    if n and not dry:
                        con.execute(f'update "{t}" set "{c}" = replace("{c}", ?, ?) where typeof("{c}")=\'text\' and instr("{c}", ?) > 0',
                                    (s, mask_for(len(b)).decode(), s))
                    changed += n
    if not dry:
        for vt in rebuild:                       # 外部内容 FTS：按基础表重建索引，旧词一并清掉
            con.execute(f'INSERT INTO "{vt}"("{vt}") VALUES(\'rebuild\')')
        con.commit()
        con.execute('VACUUM')
        con.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    con.close()
    if any(k[0] == base for k in SQLITE_KEEP):   # 库里有合法存放的列：按表列数，保留列不算剩余
        left = sum(n for (t, c), d in db_hits(path, secrets).items() if (base, t, c) not in SQLITE_KEEP for n in d.values())
    else:                                        # 没有保留列：直接查文件字节（连空闲页残留一起查）
        with open(path, 'rb') as f:
            left = len(find_spans(f.read(), secrets))
    return changed, left


# 只改日志类位置（会话记录、会话检索库、工具日志、由日志派生的数据）。配置/脚本/项目文件里的密钥可能是
# 服务在用的，遮了会坏——一律只报告不动；记忆目录（*/memory/）走 Edit 工具单独处理，不在这里批量改。
LOG_ALLOW = [re.compile('^' + re.escape(HOME) + p) for p in (
    r'/\.claude/projects/[^/]+/[^/]+\.jsonl$', r'/\.claude/projects/[^/]+/[^/]+/(subagents|tool-results)/',
    r'/\.grok/sessions/', r'/\.codex/(sessions|archived_sessions)/', r'/\.codex/history\.jsonl$',
    r'/\.codex/log/', r'/\.codex/(logs|thread_history|state)_\d+\.sqlite$', r'/\.claude-mem/',
    r'/\.local/share/codeg/(server\.log$|logs/|codeg\.db$)',
    r'/\.local/share/(memory-eval|guard-fixtures|memvec)/',
    r'/\.mycc-global/0-System/(recall-log\.jsonl$|trajectories-air/)',            # 召回日志、从 Air 拉回的轨迹
    r'/\.mycc-global/(air-mirror|backups/memory-canonical-archived-[^/]+)/[^/]+\.md$',  # 记忆的镜像与归档副本
)] + [re.compile(r'^/tmp/(codeg-memory-sync|myclaudecode|mycc-global)[^/]*/.+\.md$')]  # 同步仓库的旧临时克隆
CANON_MEMORY = re.compile('^' + re.escape(HOME) + r'/\.claude/projects/[^/]+/memory/')


def allowed(path):
    """正本记忆目录一律不批量改（走 Edit 工具，热索引有并发 CAS）；其余按白名单。"""
    return not CANON_MEMORY.search(path) and any(r.search(path) for r in LOG_ALLOW)


def apply(list_path, dry):
    secrets = load_secrets()
    paths = [l.strip() for l in open(list_path, encoding='utf-8') if l.strip() and not l.startswith('#')]
    tot = collections.Counter()
    for p in paths:
        if p.endswith(SQLITE_SIDE):
            print(f'  ⏭ {p}：SQLite 旁路文件（带校验和），不按字节改，随主库 checkpoint 清理'); tot['skip'] += 1; continue
        if not allowed(p):
            print(f'  ⏭ {p}：不在日志白名单（可能是在用的配置），只报告不动'); tot['skip'] += 1; continue
        try:
            fn = redact_sqlite if is_sqlite(p) else redact_file
            done, left = fn(p, secrets, dry)
        except Exception as e:      # 单个文件失败不影响其他文件，但必须报出来
            print(f'  ❌ {p}：{type(e).__name__}: {e}'); tot['error'] += 1; continue
        tot['done'] += done; tot['left'] += left
        flag = '预计' if dry else ('✅' if left == 0 else '⚠️ 仍剩')
        print(f"  {flag} {p}：{'将' if dry else '已'}遮 {done} 处{'' if dry else f'，剩 {left} 处'}")
    print(f"合计：{'将' if dry else '已'}遮 {tot['done']} 处，剩 {tot['left']} 处，跳过 {tot['skip']} 个、失败 {tot['error']} 个文件")


def contexts(sid, path, n=5, width=120):
    """列出编号 sid 在文件里的前后文：所有密钥值一律换成 ‹编号›，其余再过 cfgview 遮蔽。"""
    from cfgview import redact_text
    secrets = load_secrets()
    target = {s: v for s, v, _, _ in secrets}.get(sid)
    if target is None:
        sys.exit(f'没有编号 {sid}')
    data = open(path, 'rb').read()
    shown = 0
    for b in variants(target):
        start = 0
        while shown < n:
            i = data.find(b, start)
            if i < 0:
                break
            seg = data[max(0, i - width):i + len(b) + width]
            for s, v, _, _ in sorted(secrets, key=lambda x: -len(x[1])):
                for vb in variants(v):
                    seg = seg.replace(vb, f'‹{s}›'.encode())
            txt = redact_text(seg.decode('utf-8', 'replace'), known=set())
            # 语境里还可能有别的未登记凭据片段（9-23 实例：recall-log 里的 grep 模式带着 VPS 配置的 ID 前缀和 IP，
            # cfgview 没遮住就打进了会话）——字母数字混合 ≥8 位的串和 IP 一律再遮一遍，宁可看不清也别漏
            txt = re.sub(r'(?<![\w‹])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{8,}', lambda m: f'‹{len(m.group(0))}位›', txt)
            txt = re.sub(r'\b\d{1,3}(?:\\*\.\d{1,3}){3}\b', '‹IP›', txt)
            print(f'--- @{i}: …{txt}…'.replace('\n', '⏎'))
            shown += 1; start = i + len(b)


def main():
    a = sys.argv[1:]
    if a and a[0] == 'ctx':
        contexts(a[1], a[2], int(a[3]) if len(a) > 3 else 5); return
    if a and a[0] == 'scan':
        out = a[a.index('--out') + 1] if '--out' in a else os.path.join(HOME, '.local/share/memory-eval/leak-scan.json')
        roots = [x for i, x in enumerate(a[1:], 1) if not x.startswith('--') and a[i - 1] != '--out'] or [HOME, '/tmp', '/var/tmp']
        scan(roots, out); return
    if a and a[0] == 'dbscan':
        secrets = load_secrets()
        for p in a[1:]:
            print(f'=== {p}')
            for (t, c), d in sorted(db_hits(p, secrets).items()):
                keep = '（合法存放，保留）' if (os.path.basename(p), t, c) in SQLITE_KEEP else ''
                print(f'  {t}.{c}: {d}{keep}')
        return
    if a and a[0] == 'apply' and '--list' in a:
        apply(a[a.index('--list') + 1], '--dry-run' in a); return
    sys.exit(__doc__)


if __name__ == '__main__':
    main()
