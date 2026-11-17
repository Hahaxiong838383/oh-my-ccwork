#!/usr/bin/env python3
"""cfgview.py 测试：假数据，钉住「该遮的遮了、路径与普通值不误遮、已知值在任何位置都遮」。用法：python3 cfgview.test.py [被测脚本]"""
import os, sys, importlib.util, tempfile
SCRIPT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cfgview.py')
spec = importlib.util.spec_from_file_location('cv', SCRIPT); cv = importlib.util.module_from_spec(spec); spec.loader.exec_module(cv)
FAKE = 'sk-jp-FAKEfake0123456789abcdefFAKEfake'
TOML = f'''[model."x"]
base_url = "https://example.invalid/v1"
api_key = "{FAKE}"
password: hunter2hunter2hunter2
[mcp_servers.a]
args = ["/home/u/mycc/.claude/skills/mcp-hub/scripts/probe-server.mjs"]
session_id = "8f6a2c1e-1111-2222-3333-444455556666"
note = "见 {FAKE} 这把"
'''
PASS = FAIL = 0
def chk(n, c):
    global PASS, FAIL
    if c: PASS += 1; print('  ✅', n)
    else: FAIL += 1; print('  ❌', n)
PLAIN = 'plainlooking_value_notatoken'   # 不带数字、不像令牌：只有「已知值」这一层能遮住它
out = cv.redact_text(TOML + f'comment = "{PLAIN}"\n', known={FAKE, PLAIN})
chk('api_key 的值被遮', FAKE not in out and 'api_key = "‹已遮蔽' in out)
chk('password: 形式被遮', 'hunter2' not in out)
chk('已知值出现在普通字段里也遮（不靠形状规则）', PLAIN not in out)
chk('MCP 脚本路径不误遮', '/home/u/mycc/.claude/skills/mcp-hub/scripts/probe-server.mjs' in out)
chk('base_url 与 UUID 不误遮', 'https://example.invalid/v1' in out and '8f6a2c1e-1111-2222-3333-444455556666' in out)
out2 = cv.redact_text('token=' + 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', known=set())
chk('未知的 ghp_ 令牌按形状遮', 'ghp_A1b2' not in out2)
j = cv.redact_json({'OPENAI_API_KEY': FAKE, 'OPENAI_BASE_URL': 'https://example.invalid/v1', 'nested': {'token': 'abc123abc123abc123'}}, {FAKE})
chk('JSON：密钥键与嵌套 token 遮、base_url 保留', j['OPENAI_API_KEY'].startswith('‹已遮蔽') and j['nested']['token'].startswith('‹已遮蔽') and j['OPENAI_BASE_URL'] == 'https://example.invalid/v1')
print(f'\n═══ 结果：{PASS} 通过 / {FAIL} 失败 ═══'); sys.exit(1 if FAIL else 0)
