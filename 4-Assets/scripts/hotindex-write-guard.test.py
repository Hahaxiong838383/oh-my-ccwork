#!/usr/bin/env python3
"""hotindex-write-guard.sh 的端到端测试（2026-09-23 补：此前只有 9-18 的临时用例，没留文件）。

用法：python3 hotindex-write-guard.test.py [--guard 路径]   （--guard 测改坏的副本，必须变红）
全部在临时目录里跑：CANON/STATE/GUARD_LOG/ERR 都用环境变量指到临时目录，不碰真实热索引与状态。
"""
import os, sys, json, time, tempfile, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from hook_output_check import claude_accepts, denies

args = sys.argv[1:]
GUARD = args[args.index('--guard') + 1] if '--guard' in args else os.path.join(HERE, 'hotindex-write-guard.sh')


def main():
    PASS = FAIL = 0
    with tempfile.TemporaryDirectory() as td:
        canon = os.path.join(td, 'memory'); os.makedirs(canon)
        mem = os.path.join(canon, 'MEMORY.md')
        open(mem, 'w').write('# idx\n')
        env = {**os.environ, 'HOTINDEX_STATE': os.path.join(td, 'seen.json'), 'HOTINDEX_CANON_DIR': canon,
               'GUARD_LOG': os.path.join(td, 'g.jsonl'), 'HOTINDEX_ERR': os.path.join(td, 'err')}

        def run(ev, tool, ti, sid='sessA', mode='auto', camel=False):
            if camel:
                p = {'hookEventName': ev, 'toolName': tool, 'toolInput': ti, 'sessionId': sid,
                     'permissionMode': mode, 'cwd': td}
            else:
                p = {'hook_event_name': ev, 'tool_name': tool, 'tool_input': ti, 'session_id': sid,
                     'permission_mode': mode, 'cwd': td}
            r = subprocess.run(['bash', GUARD], input=json.dumps(p), capture_output=True, text=True, env=env, timeout=30)
            return r.stdout

        def check(label, cond, out=''):
            nonlocal PASS, FAIL
            acc, why = claude_accepts(out)
            if cond and acc:
                PASS += 1; print(f'  ✅ {label}')
            else:
                FAIL += 1; print(f"  ❌ {label}{'（输出会被 claude 整条作废：' + why + '）' if not acc else ''} ｜ {out[:160]!r}")

        write = {'command': f"printf 'x\\n' >> {mem}"}
        for mode in ('default', 'auto', 'bypassPermissions'):
            out = run('PreToolUse', 'Bash', write, sid='unseen0', mode=mode)
            check(f'{mode}：没读过就 Bash 写 → deny', denies(out) and '没有读过' in out, out)
        out = run('PreToolUse', 'Bash', write, sid='unseen1', camel=True)
        check('grok 形态：没读过就写 → deny + 🔴 提醒', denies(out) and '🔴' in out, out)
        out = run('PreToolUse', 'Bash', {'command': f'cat {mem}'}, sid='unseen2')
        check('只读不写 → 不输出', out.strip() == '', out)

        run('PostToolUse', 'Read', {'file_path': mem}, sid='sessB')
        out = run('PreToolUse', 'Bash', write, sid='sessB')
        check('读过之后再写 → 放行', out.strip() == '', out)

        later = time.time() + 5
        os.utime(mem, (later, later))   # 模拟另一个会话在我读之后改过
        out = run('PreToolUse', 'Bash', write, sid='sessB')
        check('读后被别人改过 → deny「被改过」', denies(out) and '被改过' in out, out)

        run('PostToolUseFailure', 'Edit', {'file_path': mem}, sid='sessC')
        out = run('PreToolUse', 'Bash', write, sid='sessC')
        check('失败事件不算「看过」→ 仍 deny', denies(out), out)
    print(f'\n═══ 结果：{PASS} 通过 / {FAIL} 失败（守门：{GUARD}）═══')
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()
