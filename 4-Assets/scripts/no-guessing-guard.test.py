#!/usr/bin/env python3
"""no-guessing-guard.sh 的夹具测试（Semgrep 式：每条规则配「必须命中 / 必须不命中」样例，没有负例的规则不上线）。

用法：
  python3 no-guessing-guard.test.py                    跑 guard-fixtures/*.jsonl 全部样例（端到端调用真实守门脚本）
  python3 no-guessing-guard.test.py --guard 路径       测一份故意改坏的副本（负向验证：必须变红）
  python3 no-guessing-guard.test.py --corpus 文件.jsonl 额外统计：真实历史命令上每条规则每百条命令触发几次（噪声预算）
夹具格式（每行一个 JSON）：{"rule": 规则名, "expect": "hit"|"ok", "src": 来源, "cmd": 命令文本}
硬红线规则（HARD）额外核对：default / auto / bypassPermissions 三种模式都必须 deny；grok 形态（camelCase）
必须 deny 并带「🔴 硬红线」提醒兜底。所有输出还要过 claude 的校验（claude_accepts）：顶层 decision 只认
approve/block，9-19 写成 "deny" 让所有 deny 失效、命令照跑，9-23 才用探针查实。
判「命中哪条规则」读的是守门自己的记账（GUARD_LOG），与线上判据同一个通道。
"""
import os, sys, json, glob, tempfile, subprocess, collections

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from hook_output_check import claude_accepts, denies
args = sys.argv[1:]
GUARD = args[args.index('--guard') + 1] if '--guard' in args else os.path.join(HERE, 'no-guessing-guard.sh')
CORPUS = args[args.index('--corpus') + 1] if '--corpus' in args else None
HARD = {'git_add_all', 'pkill_f', 'git_reset_hard', 'commit_signature', 'secret_file_dump', 'vault_to_file', 'vault_to_stdout'}

def run_guard(cmd, mode='default', camel=False):
    """返回 (命中规则集合, 决策集合, stdout)。camel=True 模拟 grok 的 camelCase payload。"""
    with tempfile.TemporaryDirectory() as td:
        log = os.path.join(td, 'g.jsonl')
        if camel:
            payload = json.dumps({'toolName': 'Bash', 'toolInput': {'command': cmd}, 'permissionMode': mode,
                                  'sessionId': 'fixture0', 'cwd': '/tmp'})
        else:
            payload = json.dumps({'tool_name': 'Bash', 'tool_input': {'command': cmd}, 'permission_mode': mode,
                                  'session_id': 'fixture0', 'cwd': '/tmp'})
        p = subprocess.run(['bash', GUARD], input=payload, capture_output=True, text=True,
                           env={**os.environ, 'GUARD_LOG': log}, timeout=30)
        rules, decisions = set(), set()
        if os.path.exists(log):
            for l in open(log):
                d = json.loads(l); rules |= set(d.get('rules', [])); decisions.add(d.get('decision'))
        return rules, decisions, p.stdout

def main():
    fx = []
    for f in sorted(glob.glob(os.path.join(HERE, 'guard-fixtures', '*.jsonl'))):
        for i, l in enumerate(open(f, encoding='utf-8'), 1):
            if l.strip():
                d = json.loads(l); d['_where'] = f'{os.path.basename(f)}:{i}'; fx.append(d)
    PASS = FAIL = 0
    by_rule = collections.defaultdict(lambda: [0, 0])
    for d in fx:
        rules, dec, out = run_guard(d['cmd'])
        hit = d['rule'] in rules
        ok = hit if d['expect'] == 'hit' else not hit
        msg = ''
        acc, why = claude_accepts(out)
        if not acc:
            ok = False; msg = f'（输出会被 claude 整条作废：{why}）'
        if ok and d['expect'] == 'hit' and d['rule'] in HARD:
            for mode in ('default', 'auto', 'bypassPermissions'):
                r2, _, out2 = run_guard(d['cmd'], mode)
                acc2, why2 = claude_accepts(out2)
                if not denies(out2) or not acc2 or d['rule'] not in r2:
                    ok = False; msg = f'（{mode} 模式没有有效 deny{"：" + why2 if why2 else ""}）'
                    break
            if ok:
                r3, _, out3 = run_guard(d['cmd'], 'auto', camel=True)
                acc3, why3 = claude_accepts(out3)
                if not denies(out3) or not acc3 or '🔴 硬红线' not in out3 or d['rule'] not in r3:
                    ok = False; msg = f'（grok 形态没有 deny + 🔴 提醒{"：" + why3 if why3 else ""}）'
        by_rule[d['rule']][0 if ok else 1] += 1
        if ok: PASS += 1
        else:
            FAIL += 1
            print(f"  ❌ {d['_where']} [{d['rule']} 期望 {d['expect']}] 实得 {sorted(rules) or '无'}{msg} ｜ {d['src']} ｜ {d['cmd'][:90]!r}")
    for r, (p, f) in sorted(by_rule.items()):
        print(f"  {'✅' if not f else '❌'} {r}: {p} 过 / {f} 挂")
    if CORPUS:
        n = 0; fires = collections.Counter()
        for l in open(CORPUS, encoding='utf-8'):
            if not l.strip(): continue
            n += 1
            rules, _, _ = run_guard(json.loads(l)['cmd'])
            fires.update(rules)
        print(f"\n═══ 真实历史命令 {n} 条上的触发率（每百条）═══")
        for r, c in fires.most_common():
            print(f"  {r:<24} {c:>5} 次  {100 * c / max(n, 1):5.2f}/百条")
    print(f"\n═══ 结果：{PASS} 通过 / {FAIL} 失败（守门：{GUARD}）═══")
    sys.exit(1 if FAIL else 0)

if __name__ == '__main__':
    main()
