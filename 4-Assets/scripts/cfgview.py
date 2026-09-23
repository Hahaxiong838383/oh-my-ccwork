#!/usr/bin/env python3
"""cfgview.py — 看配置文件的安全方式：键名、结构、非敏感值照常显示，敏感值只显示「已遮蔽 + 长度」。

由来（2026-09-23）：同一个会话里两次整份打印 ~/.grok/config.toml（8-29 `cat`、9-23 `grep -v '^#'`），
把中转网关 api_key 打进了会话记录；9-02 另一个会话把 `vw list items` 整份导出到 /tmp。
守门（no-guessing-guard 的 secret_file_dump）会把「直接打印含密钥文件」判为硬红线，并指向本工具。

用法：cfgview.py FILE [FILE ...]      cfgview.py -  （读 stdin）
遮蔽规则（任一命中即遮）：
  ① 键名像密钥：api_key / token / secret / password / auth / credential / private_key / access_key / cookie / bearer …
  ② 值本身像密钥：sk-…、ghp_…、xox?-…、AKIA…、JWT、PEM 块、≥24 位的十六进制/base64 串
  ③ 值等于本机已知密钥（从已知密钥存放处读出，只在内存里比对，从不打印）
只读，不改任何文件。
"""
import os, re, sys, json, glob, sqlite3

SECRET_KEY = re.compile(r'(?i)(api[_-]?key|apikey|token|secret|passw(?:or)?d|passwd|pwd|auth(?:orization)?|credential|'
                        r'private[_-]?key|access[_-]?key|session[_-]?key|cookie|bearer|client[_-]?secret|signing[_-]?key)')
TOKEN_LIKE = re.compile(r'''(?x)
   sk-[A-Za-z0-9_\-]{16,}
 | gh[pousr]_[A-Za-z0-9]{20,}
 | xox[abposr]-[A-Za-z0-9\-]{10,}
 | AKIA[0-9A-Z]{16}
 | eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}
 | (?<![A-Za-z0-9/+=_\-])[A-Fa-f0-9]{32,}(?![A-Za-z0-9/+=_\-])
 | (?<![A-Za-z0-9_\-])(?=[A-Za-z_\-]*\d)(?=[0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{40,}={0,2}(?![A-Za-z0-9_\-])   # 不含 /：路径段不误遮（9-23 实测误遮 MCP 脚本路径）
''')
PEM = re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----', re.S)

HOME = os.path.expanduser('~')
# 已知密钥存放处（只读取值用于比对遮蔽；新增存放处加在这里）
KNOWN_STORES = [f'{HOME}/.grok/config.toml', f'{HOME}/.codex/auth.json', f'{HOME}/.gateway.env', f'{HOME}/.mycc-secrets.env']
KNOWN_STORE_GLOBS = [f'{HOME}/MyAgent/2-Projects/*/runtime/app.env']

def mask(v):
    return f'‹已遮蔽 {len(v)} 字符›'

def _values_from_text(text):
    out = set()
    for m in re.finditer(r'''(?im)^\s*(?:export\s+)?([A-Za-z0-9_.\-"]+)\s*[:=]\s*["']?([^"'\s#]+)''', text):
        if SECRET_KEY.search(m.group(1)) and len(m.group(2)) >= 12:
            out.add(m.group(2))
    return out

def _values_from_json(o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, str) and SECRET_KEY.search(str(k)) and len(v) >= 12:
                out.add(v)
            else:
                _values_from_json(v, out)
    elif isinstance(o, list):
        for v in o: _values_from_json(v, out)

def known_secret_values():
    """本机已知密钥值的集合（只进内存）。任何读取失败都跳过，不报错。"""
    vals = set()
    paths = list(KNOWN_STORES)
    for g in KNOWN_STORE_GLOBS: paths += glob.glob(g)
    for p in paths:
        try:
            t = open(p, encoding='utf-8', errors='replace').read()
        except OSError:
            continue
        if p.endswith('.json'):
            try: _values_from_json(json.loads(t), vals); continue
            except ValueError: pass
        vals |= _values_from_text(t)
    try:   # codeg 给 agent 配的环境变量
        con = sqlite3.connect(f'file:{HOME}/.local/share/codeg/codeg.db?mode=ro', uri=True, timeout=2)
        for (ej,) in con.execute('select env_json from agent_setting where env_json is not null'):
            try: _values_from_json(json.loads(ej), vals)
            except ValueError: pass
        con.close()
    except Exception:
        pass
    return {v for v in vals if len(v) >= 12}

def redact_text(text, known=None):
    known = known if known is not None else known_secret_values()
    for v in sorted(known, key=len, reverse=True):
        if v in text: text = text.replace(v, mask(v))
    text = PEM.sub(lambda m: '-----BEGIN PRIVATE KEY----- ' + mask(m.group(0)) + ' -----END PRIVATE KEY-----', text)
    def line(m):
        k, sep, q, v = m.group(1), m.group(2), m.group(3), m.group(4)
        return f'{k}{sep}{q}{mask(v)}{q}' if SECRET_KEY.search(k) and v and not v.startswith('‹已遮蔽') else m.group(0)
    text = re.sub(r'''(?im)^(\s*(?:export\s+)?[A-Za-z0-9_.\-"]+)(\s*[:=]\s*)(["']?)([^"'\n#]*?)\3(?=\s*(?:#.*)?$)''', line, text)
    text = TOKEN_LIKE.sub(lambda m: mask(m.group(0)), text)
    return text

def redact_json(o, known):
    if isinstance(o, dict):
        return {k: (mask(v) if isinstance(v, str) and (SECRET_KEY.search(str(k)) or v in known or TOKEN_LIKE.fullmatch(v)) and v
                    else redact_json(v, known)) for k, v in o.items()}
    if isinstance(o, list):
        return [redact_json(v, known) for v in o]
    if isinstance(o, str):
        return redact_text(o, known)
    return o

def view(path, known):
    raw = sys.stdin.read() if path == '-' else open(path, encoding='utf-8', errors='replace').read()
    if path.endswith('.json') or raw.lstrip()[:1] in '[{':
        try:
            return json.dumps(redact_json(json.loads(raw), known), ensure_ascii=False, indent=2)
        except ValueError:
            pass
    return redact_text(raw, known)

def main():
    args = sys.argv[1:] or ['-']
    known = known_secret_values()
    for p in args:
        if len(args) > 1: print(f'==> {p} <==')
        try:
            sys.stdout.write(view(p, known).rstrip('\n') + '\n')
        except OSError as e:
            print(f'cfgview: 读不了 {p}：{e.strerror}', file=sys.stderr)

if __name__ == '__main__':
    main()
