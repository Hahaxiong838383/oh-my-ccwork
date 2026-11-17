#!/usr/bin/env python3
"""secret-guard.py — 判定一条 shell 命令会不会把密钥打到输出或落盘（供 no-guessing-guard.sh 的硬红线调用）。

由来（2026-09-23，川哥：key 为什么进了会话、以后怎么避免）：
  · 8-29 本会话 `cat ~/.grok/config.toml`、9-23 本会话 `grep -vE '^\\s*#|^\\s*$' ~/.grok/config.toml`
    → 中转网关 api_key 两次进了会话记录；
  · 9-02 另一个 cc 会话 `vw list items > /tmp/vw-items.txt` → 12 个密码库条目（11 个带明文密码）
    以 664 权限在 /tmp 放了三周。
规则（每条都是「窄守门」：盯死一种写法，fixtures 在 guard-fixtures/secret.jsonl）：
  secret_file_dump   打印/拷出已知含密钥文件的内容（cat/grep/sed/jq/sqlite3… 读 config.toml、auth.json、*.env…）
                     放行：grep/rg 只计数/只列文件名/静默（-c -l -L -q）、管道进 cfgview、在 $( ) 里被捕获
  vault_to_file      vw list/get 的输出重定向或 tee 到文件
  vault_to_stdout    vw list items / vw get item / vw get password 直接打到屏幕
                     放行：在 $( ) 里被捕获；管道进 jq 且只取 name/id
输入：命令文本（stdin）。输出：每行「规则名<TAB>原因」；无命中则无输出。永远 exit 0（fail-open，出错写 stderr）。
"""
import re, sys

SECRET_PATH = re.compile(r'''(?x)
   \.grok/(?:config\.toml|auth\.json)
 | \.codex/auth\.json          # codex 的 config.toml 不含密钥（9-23 核过，历史 18 次命中全是误报）
 | (?:^|[\s/'"=:])[\w.\-]*\.env(?!\.(?:example|sample|template|dist)\b)(?:\.[\w\-]+)?(?=$|[\s'";)|&>])
 | \.gateway\.env | \.mycc-secrets\.env
 | \.curlcfg | \.netrc | \.git-credentials | \.npmrc | \.pypirc
 | /id_(?:rsa|ed25519|ecdsa)(?=$|[\s'";)|&>])
 | [\w.\-]+\.pem(?=$|[\s'";)|&>])
 | vw-items | \.claude/\.credentials\.json | gh/hosts\.yml
''')
CODEG_DB = re.compile(r'codeg\.db')
def codeg_secret_query(st):
    """读 codeg 库时，只有「查出密钥值」才算：.dump 整库导出，或 select 了 env_json/api_key/* 且表是 agent_setting/model_provider。"""
    q = st.lower()
    if '.dump' in q: return True
    return 'select' in q and re.search(r'env_json|api_key|\*', q) is not None and re.search(r'agent_setting|model_provider', q) is not None
PRINT_VERB = re.compile(r'^\s*(?:sudo\s+(?:-\S+\s+)*)?(cat|bat|batcat|less|more|head|tail|nl|tac|strings|xxd|od|hexdump|grep|egrep|fgrep|rg|ag|sed|awk|gawk|jq|yq|sqlite3)\b')
SED_INPLACE = re.compile(r'(?:^|\s)(?:-i\S*|--in-place\S*)(?=\s|$)')
SEARCH_VERBS = {'grep', 'egrep', 'fgrep', 'rg', 'ag'}
SAFE_SEARCH_FLAGS = re.compile(r'(?:^|\s)(?:-[a-zA-Z]*[clLq][a-zA-Z]*|--count|--files-with-matches|--files-without-match|--quiet|--silent)(?=\s|$)')
SAFE_SINK = re.compile(r'^\s*(?:\S*/)?(?:cfgview(?:\.py)?|wc|md5sum|sha1sum|sha256sum|shasum|cksum)\b|^\s*(?:python3?\s+)?\S*cfgview\.py\b')
VW = re.compile(r'^\s*(?:(?:timeout\s+(?:-\S+\s+)*\S+|env(?:\s+\w+=\S*)+|sudo(?:\s+-\S+)*|nice|stdbuf\s+\S+)\s+)*(?:\S*/)?vw\s+(list|get)\b(.*)$')
STDOUT_REDIRECT = re.compile(r'(?<![0-9&<>])>>?\s*(?!&)(?!/dev/null\b)\S')

def split_top(s, seps):
    """按分隔符切，但不切引号里面的（'…' / "…"，双引号内认 \\ 转义）。& 两侧是 < 或 > 时是重定向（2>&1、&>），不当分隔符。
    2026-09-23 教训：首版不认引号，`grep -vE '^\\s*#|^\\s*$' ~/.grok/config.toml` 里正则的 | 被当成管道，
    读配置那一段被切碎、真实泄漏命令漏判——「宁可误切」恰恰会漏。"""
    out, cur, i, q = [], [], 0, None
    while i < len(s):
        c = s[i]
        if q:
            cur.append(c)
            if c == '\\' and q == '"' and i + 1 < len(s):
                cur.append(s[i + 1]); i += 2; continue
            if c == q: q = None
            i += 1; continue
        if c in '\'"':
            q = c; cur.append(c); i += 1; continue
        if c == '\\' and i + 1 < len(s):
            cur.append(c); cur.append(s[i + 1]); i += 2; continue
        for sep in seps:
            if s.startswith(sep, i):
                if sep == '&' and ((i > 0 and s[i - 1] in '<>') or (i + 1 < len(s) and s[i + 1] == '>')):
                    continue
                if sep == '|' and i + 1 < len(s) and s[i + 1] == '|':
                    continue
                out.append(''.join(cur)); cur = []; i += len(sep); break
        else:
            cur.append(c); i += 1
    out.append(''.join(cur))
    return out

HEREDOC = re.compile(r'<<-?\s*([\'"]?)([A-Za-z_][A-Za-z0-9_]*)\1')

def pipelines(cmd):
    """逐行（\\ 续行先拼接）→ 按 ; && || & 切成管道 → 按 | 切成阶段；引号状态每行重置。
    heredoc 正文（<<EOF … EOF）是数据不是命令，整段跳过——9-23 写记忆时正文里提到
    `vw … | jq`、`~/.codex/config.toml`，被当成命令误判成硬红线（CLI 模式下会把写记忆拦掉）。"""
    lines = cmd.replace('\\\n', ' ').split('\n')
    pending = []                 # 本行开启、从下一行起生效的 heredoc 终止符（可多个）
    for line in lines:
        if pending:
            if line.strip() == pending[0]:
                pending.pop(0)
            continue
        for pl in split_top(line, ['&&', '||', ';', '&']):
            if pl.strip():
                yield split_top(pl, ['|'])
        pending = [m.group(2) for m in HEREDOC.finditer(line)]

SECRET_DIR = re.compile(r'(?:^|/)\.(?:grok|codex)/?$')
RELATIVE_SECRET = re.compile(r'(?:^|\s)(?:\./)?(?:config\.toml|auth\.json)(?=$|[\s;)|&>])')

def check(cmd):
    hits = []
    in_secret_dir = False   # 同一条命令里 cd 进了 ~/.grok / ~/.codex，之后的相对路径 config.toml/auth.json 也算
    for stages in pipelines(cmd):
        cdm = re.match(r'^\s*cd\s+(\S+)', stages[0])
        if cdm:
            in_secret_dir = bool(SECRET_DIR.search(cdm.group(1).strip('\'"')))
        for i, st in enumerate(stages):
            # ── 已知含密钥文件被打印/拷出 ──
            m = PRINT_VERB.match(st)
            if m and (SECRET_PATH.search(st) or (in_secret_dir and RELATIVE_SECRET.search(st)) or (CODEG_DB.search(st) and m.group(1) == 'sqlite3' and codeg_secret_query(st))):
                verb = m.group(1)
                later = stages[i + 1:]
                if verb in SEARCH_VERBS and SAFE_SEARCH_FLAGS.search(st):
                    pass
                elif verb == 'sed' and SED_INPLACE.search(st) and not re.search(r"(?:^|\s)-n\b", st):
                    pass   # sed -i 就地改文件，不打印
                elif any(SAFE_SINK.match(s) for s in later) or any(
                        re.match(r'^\s*(?:grep|egrep|rg)\b', s) and SAFE_SEARCH_FLAGS.search(s) for s in later):
                    pass
                else:
                    hits.append(('secret_file_dump', f'{verb} 读含密钥文件且内容会进输出/落盘'))
            # ── 密码库 ──
            v = VW.match(st)
            if v:
                sub, rest = v.group(1), v.group(2)
                if STDOUT_REDIRECT.search(rest) or any(re.match(r'^\s*tee\b', s) for s in stages[i + 1:]):
                    hits.append(('vault_to_file', 'vw 输出被写进文件'))
                    continue
                full_items = sub == 'list' and re.match(r'\s+items\b', rest) or sub == 'get' and re.match(r'\s+(item|password|notes|totp)\b', rest)
                if not full_items:
                    continue
                nxt = stages[i + 1] if i + 1 < len(stages) else None
                if nxt is None:
                    hits.append(('vault_to_stdout', 'vw 条目/密码直接打到屏幕'))
                elif re.match(r'^\s*jq\b', nxt):
                    f = nxt
                    if re.search(r'\.(login|password|notes|fields|totp|passwordHistory)\b', f) or not re.search(r'\.(name|id)\b', f):
                        hits.append(('vault_to_stdout', 'vw 条目经 jq 输出了密码/备注字段或整条'))
    # 去重保序
    seen, out = set(), []
    for r, why in hits:
        if r not in seen:
            seen.add(r); out.append((r, why))
    return out

def main():
    try:
        cmd = sys.stdin.read()
        for r, why in check(cmd):
            print(f'{r}\t{why}')
    except Exception as e:
        print(f'secret-guard 内部错误（放行）：{e!r}', file=sys.stderr)
    sys.exit(0)

if __name__ == '__main__':
    main()
