#!/usr/bin/env python3
"""agent-entry-derive.py 的测试（临时文件，不碰真实的 ~/.codex、~/.grok）。用法：python3 agent-entry-derive.test.py [--script 路径]"""
import os, sys, tempfile, subprocess, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
a = sys.argv[1:]
SCRIPT = a[a.index('--script') + 1] if '--script' in a else os.path.join(HERE, 'agent-entry-derive.py')
spec = importlib.util.spec_from_file_location('ae', SCRIPT); ae = importlib.util.module_from_spec(spec); spec.loader.exec_module(ae)
PASS = FAIL = 0


def check(label, cond):
    global PASS, FAIL
    if cond: PASS += 1; print(f'  ✅ {label}')
    else: FAIL += 1; print(f'  ❌ {label}')


SRC = """# idx
## ★ 项目
- [user_hw](user_hardware.md) — 设备真值：Mini 在 10.0.0.2
- [other](project_other.md) — 别的项目
## ★ 教训（只留…）
- [alpha](feedback_alpha.md) — **第一条**教训：先查再说
- [beta](feedback_beta.md) — 第二条 🔴 教训
## 🗂 场景簇
- 关键词行
## 🔥 近 28 天复发
- [gamma](feedback_gamma.md) — 反复踩的坑 ×3
"""


def run(src_text, targets, *extra):
    with tempfile.TemporaryDirectory() as td:
        s = os.path.join(td, 'MEMORY.md'); open(s, 'w').write(src_text)
        r = subprocess.run([sys.executable, SCRIPT, '--targets', ','.join(targets), *extra],
                           env={**os.environ, 'AGENT_ENTRY_SRC': s}, capture_output=True, text=True)
        return r


with tempfile.TemporaryDirectory() as td:
    grok = os.path.join(td, 'grok', 'AGENTS.md'); codex = os.path.join(td, 'codex', 'AGENTS.md')
    os.makedirs(os.path.dirname(grok)); open(grok, 'w').write('# 原有权限说明\n保持不动\n')
    r = run(SRC, [grok, codex])
    g = open(grok).read(); c = open(codex).read()
    print('═══ 写入 ═══')
    check('原有内容原样保留在块前', g.startswith('# 原有权限说明\n保持不动\n'))
    check('不存在的目标文件被新建且只有块', c.startswith(ae.BEGIN) and c.rstrip().endswith(ae.END))
    check('两个目标的块内容一致', g[g.index(ae.BEGIN):] == c)
    print('═══ 内容 ═══')
    check('链接展开：不再有 ](…md) 形式', '](' not in c)
    check('真值锚带文件名', 'user_hw（user_hardware.md）' in c and '10.0.0.2' in c)
    check('🔥 节带文件名、教训节只带别名', 'gamma（feedback_gamma.md）' in c and '- alpha：第一条教训：先查再说' in c)
    check('去掉加粗与装饰', '**' not in c.split('## 真值锚')[1] and '🔴' not in c)
    check('场景簇与非锚项目不进入口', '关键词行' not in c and '别的项目' not in c)
    print('═══ 幂等与更新 ═══')
    open(grok, 'a').write('\n# 块后别人加的内容\n')
    m1 = os.stat(grok).st_mtime_ns
    r2 = run(SRC, [grok, codex])
    check('源不变再跑：块外新增内容保留、文件未重写', '# 块后别人加的内容' in open(grok).read() and os.stat(grok).st_mtime_ns == m1 and '未变' in r2.stdout)
    r3 = run(SRC.replace('先查再说', '先查再说再改'), [grok, codex])
    g3 = open(grok).read()
    check('源变了：只替换块，块只有一份，块前块后都在', g3.count(ae.BEGIN) == 1 and '先查再说再改' in g3
          and g3.startswith('# 原有权限说明') and '# 块后别人加的内容' in g3)
    print('═══ 预算与异常 ═══')
    big = SRC.replace('- [beta]', ''.join(f'- [l{i}](feedback_l{i}.md) — ' + '很长的教训摘要' * 12 + '\n' for i in range(120)) + '- [beta]')
    b = ae.fit(big)
    check(f'超预算时自动收紧到 ≤ {ae.BUDGET} 字符（实得 {len(b)}）', len(b) <= ae.BUDGET)
    before = open(codex).read()
    r4 = run('# 没有教训节\n## ★ 项目\n- x\n', [codex])
    check('源格式不对：报错退出且不改目标', r4.returncode != 0 and open(codex).read() == before)

print('═══ 真实热索引预演 ═══')
r = subprocess.run([sys.executable, SCRIPT, '--dry-run'], capture_output=True, text=True)
check('真实热索引生成成功且在预算内', r.returncode == 0 and ae.BEGIN in r.stdout and len(r.stdout.split(ae.END)[0]) <= ae.BUDGET)

print(f'\n═══ 结果：{PASS} 通过 / {FAIL} 失败（被测：{SCRIPT}）═══')
sys.exit(1 if FAIL else 0)
