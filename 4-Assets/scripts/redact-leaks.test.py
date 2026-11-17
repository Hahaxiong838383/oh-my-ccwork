#!/usr/bin/env python3
"""redact-leaks.py 的单元测试：全部用假密钥（替换 load_secrets），不碰密码库与真实文件。

用法：python3 redact-leaks.test.py [--module 路径]   （--module 测改坏的副本，必须变红）
"""
import os, sys, json, sqlite3, tempfile, hashlib, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
MOD = args[args.index('--module') + 1] if '--module' in args else os.path.join(HERE, 'redact-leaks.py')
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location('rl', MOD)
rl = importlib.util.module_from_spec(spec); spec.loader.exec_module(rl)

G1 = 'FAKE-gw-key-0123456789abcdefghij'          # 全局档：普通长密钥
G2 = 'p@ss"w\\ord-XY12'                         # 全局档：带引号和反斜杠，只能靠转义变体抓到
C1 = 'publicname'                               # 语境档：公开值（假装是 GitHub 用户名前缀）
SECRETS = [('v01', G2, 'pw', 'global'), ('v02', C1, 'pw', 'context'), ('k01', G1, 'known', 'global')]
rl.load_secrets = lambda: SECRETS

PASS = FAIL = 0
def check(label, cond):
    global PASS, FAIL
    if cond: PASS += 1; print(f'  ✅ {label}')
    else: FAIL += 1; print(f'  ❌ {label}')

def md5(p): return hashlib.md5(open(p, 'rb').read()).hexdigest()

with tempfile.TemporaryDirectory() as td:
    # ---- 文本（JSONL，模拟会话记录）----
    inner = json.dumps({'login': {'username': 'u', 'password': C1}, 'note': G2})   # 工具输出里的 JSON（再被外层 JSON 转义）
    lines = [
        {'type': 'tool_use', 'command': f'curl -H "Authorization: Bearer {G1}" https://x'},
        {'type': 'tool_result', 'content': inner},
        {'type': 'tool_result', 'content': json.dumps({'content': inner})},             # JSON 里套 JSON 再套一层
        {'type': 'text', 'text': f'git remote: https://github.com/{C1}8383/repo.git'},   # 公开值出现在地址里：不许动
        {'type': 'tool_result', 'content': f'"password": "{C1}"'},
    ]
    p = os.path.join(td, 's.jsonl')
    open(p, 'w').write('\n'.join(json.dumps(l, ensure_ascii=False) for l in lines) + '\n')
    size0 = os.path.getsize(p); os.utime(p, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
    m0 = md5(p)
    n_dry, _ = rl.redact_file(p, SECRETS, dry=True)
    check('dry-run 不改文件', md5(p) == m0 and n_dry > 0)
    done, left = rl.redact_file(p, SECRETS, dry=False)
    raw = open(p, 'rb').read()
    check('文件大小不变（等长覆盖）', os.path.getsize(p) == size0)
    check('mtime 保留', os.stat(p).st_mtime_ns == 1_700_000_000_000_000_000)
    check('每行仍是合法 JSON', all(json.loads(l) is not None for l in raw.decode().splitlines()))
    check('全局密钥原文 0 残留', G1.encode() not in raw)
    # 判据独立于被测的 variants()：自己逐层构造 0～3 层转义（第 3 行把密钥套了三层 JSON）
    esc = [G2]
    for _ in range(3):
        esc.append(json.dumps(esc[-1])[1:-1])
    check('带引号反斜杠的密钥：0～3 层转义写法都 0 残留', all(e.encode() not in raw for e in esc))
    check('语境档：password 字段里的公开值被遮', b'"password": "publicname"' not in raw and b'\\"password\\": \\"publicname\\"' not in raw)
    check('语境档：地址里的公开值原样保留', f'github.com/{C1}8383'.encode() in raw)
    check('复扫剩余 0 处', left == 0 and len(rl.find_spans(raw, SECRETS)) == 0)
    check(f'遮蔽处数 = 预演处数（{done}）', done == n_dry)

    # ---- SQLite（模拟会话检索库）----
    d = os.path.join(td, 'x.sqlite')
    con = sqlite3.connect(d); con.execute('create table t(id integer primary key, body text, b blob)')
    con.execute('insert into t(body) values (?)', (f'token={G1} end',))
    con.execute('insert into t(body) values (?)', ('clean row',))
    # 以前删掉的行：内容还躺在空闲页里，UPDATE 碰不到，只有 VACUUM 能清。
    # Ubuntu 的 SQLite 默认 secure_delete=1（删时清零），grok/codex 自带的库不一定——这里显式关掉模拟它们
    con.execute('PRAGMA secure_delete=OFF')
    con.executemany('insert into t(body) values (?)', [(f'old {i} {G1} ' + 'x' * 3000,) for i in range(5)])
    con.commit(); con.execute('delete from t where body like ?', ('old %',)); con.commit(); con.close()
    changed, left = rl.redact_sqlite(d, SECRETS, dry=False)
    con = sqlite3.connect(d)
    rows = [r[0] for r in con.execute('select body from t order by id')]; con.close()
    check('SQLite：命中行被遮、行数不变', len(rows) == 2 and G1 not in rows[0] and rows[0].startswith('token=REDACTED'))
    check('SQLite：未命中行原样', rows[1] == 'clean row')
    check('SQLite：库文件字节里 0 残留（secure_delete + VACUUM 生效）', G1.encode() not in open(d, 'rb').read() and left == 0)

    # ---- 合法存放列：codeg.db 的 agent_setting.env_json 保留，同库别的表照遮 ----
    cdb = os.path.join(td, 'codeg.db')
    con = sqlite3.connect(cdb)
    con.execute('create table agent_setting(id integer primary key, env_json text)')
    con.execute('create table chat_channel_message_log(id integer primary key, content text)')
    con.execute('insert into agent_setting(env_json) values (?)', (json.dumps({'OPENAI_API_KEY': G1}),))
    con.execute('insert into chat_channel_message_log(content) values (?)', (f'leaked {G1}',))
    con.commit(); con.close()
    changed, left = rl.redact_sqlite(cdb, SECRETS, dry=False)
    con = sqlite3.connect(cdb)
    env = con.execute('select env_json from agent_setting').fetchone()[0]
    msg = con.execute('select content from chat_channel_message_log').fetchone()[0]; con.close()
    check('codeg.db：agent_setting.env_json 原样保留（服务在用）', G1 in env)
    check('codeg.db：消息日志表照遮，剩余只数保留列以外', G1 not in msg and left == 0)

    # ---- 全文索引：外部内容 + 触发器（仿 claude-mem）、内部内容 trigram（仿 chroma）----
    fdb = os.path.join(td, 'mem.db')
    con = sqlite3.connect(fdb)
    con.executescript("""
      create table observations(id integer primary key, facts text);
      create virtual table observations_fts using fts5(facts, content='observations', content_rowid='id');
      create trigger observations_ai after insert on observations begin
        insert into observations_fts(rowid, facts) values (new.id, new.facts); end;
      create trigger observations_ad after delete on observations begin
        insert into observations_fts(observations_fts, rowid, facts) values ('delete', old.id, old.facts); end;
      create trigger observations_au after update on observations begin
        insert into observations_fts(observations_fts, rowid, facts) values ('delete', old.id, old.facts);
        insert into observations_fts(rowid, facts) values (new.id, new.facts); end;
      create table embedding_metadata(id integer primary key, string_value text);
      create virtual table efs using fts5(string_value, tokenize='trigram');
    """)
    con.execute('insert into observations(facts) values (?)', (f'token is {G1} here',))
    con.execute('insert into embedding_metadata(string_value) values (?)', (f'k={G1}',))
    con.execute('insert into efs(string_value) values (?)', (f'k={G1}',))
    con.commit()
    pre_ext = con.execute('select count(*) from observations_fts where observations_fts match ?', ('"0123456789abcdefghij"',)).fetchone()[0]
    pre_tri = con.execute('select count(*) from efs where efs match ?', ('"key-0123456789"',)).fetchone()[0]
    con.close()
    check('锚点：遮之前两张索引都搜得到（否则下面「搜不到」是空检查）', pre_ext == 1 and pre_tri == 1)
    changed, left = rl.redact_sqlite(fdb, SECRETS, dry=False)
    con = sqlite3.connect(fdb)
    ext_hit = con.execute('select count(*) from observations_fts where observations_fts match ?', ('"0123456789abcdefghij"',)).fetchone()[0]
    tri_hit = con.execute('select count(*) from efs where efs match ?', ('"key-0123456789"',)).fetchone()[0]
    ok_ic = True
    for vt in ('observations_fts', 'efs'):
        try: con.execute(f"insert into {vt}({vt}) values('integrity-check')")
        except sqlite3.DatabaseError: ok_ic = False
    con.close()
    check('FTS 外部内容：索引里搜不到密钥片段（触发器 + rebuild 生效）', ext_hit == 0)
    check('FTS 内部内容（trigram）：索引里搜不到密钥片段', tri_hit == 0)
    check('FTS：两张索引 integrity-check 都通过（没直接改影子表）', ok_ic)
    check('FTS 库：文件字节 0 残留', G1.encode() not in open(fdb, 'rb').read() and left == 0)

# ---- 白名单：只改日志类位置 ----
H = rl.HOME
check('白名单：Claude 会话记录可改', rl.allowed(f'{H}/.claude/projects/-home-x/abc.jsonl'))
check('白名单：grok 会话目录可改', rl.allowed(f'{H}/.grok/sessions/%2Fx/01a/updates.jsonl'))
check('白名单：记忆目录不批量改', not rl.allowed(f'{H}/.claude/projects/-home-x/memory/feedback_x.md'))
check('白名单：配置文件不改', not rl.allowed(f'{H}/.grok/config.toml') and not rl.allowed(f'{H}/MyAgent/2-Projects/P01/runtime/app.env'))
check('白名单：shell 快照不改（改了会把错值 export 进环境）', not rl.allowed(f'{H}/.claude/shell-snapshots/snapshot-bash-1.sh'))
check('旁路文件：-wal/-shm 不按字节改', f'{H}/.local/share/codeg/codeg.db-wal'.endswith(rl.SQLITE_SIDE))
check('白名单：同步仓库旧克隆里的记忆副本可改', rl.allowed('/tmp/codeg-memory-sync.abc/repo/projects/-Users-x/memory/f.md'))
check('白名单：air-mirror 副本可改、正本记忆不可', rl.allowed(f'{H}/.mycc-global/air-mirror/f.md') and not rl.allowed(f'{H}/.claude/projects/-home-x/memory/f.md'))

# ---- 按模式遮：codeg-mcp 的 --token（不在已知值里）----
FAKE_UUID = b'0000aaaa-1111-2222-3333-444455556666'   # 假值；别拿 ps 里的真 token 当样例（9-23 犯过一次）
blob = b'... /home/u/.local/bin/codeg-mcp --parent-connection-id e793 --token ' + FAKE_UUID + b' --parent-pid 1'
sp = rl.find_spans(blob, SECRETS)
check('codeg-mcp token：只遮 UUID 本身，参数名保留', len(sp) == 1 and blob[sp[0][0]:sp[0][1]] == FAKE_UUID)

print(f'\n═══ 结果：{PASS} 通过 / {FAIL} 失败（被测：{MOD}）═══')
sys.exit(1 if FAIL else 0)
