#!/bin/bash
# lesson-nudge.py 正负向测试。每例用独立 state 文件，冷却测试除外。
N="${NUDGE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lesson-nudge.py}"; PY="${PY:-python3}"
T=$(mktemp -d); export GUARD_LOG=$T/g.jsonl NUDGE_ERR=$T/err; PASS=0; FAIL=0
run(){ NUDGE_STATE=$T/s-$RANDOM.json $PY "$N" <<<"$1"; }
chk(){ out=$(run "$3"); got=none; for g in 交付前四问:A 结论落盘前:B 截断后:C; do case "$out" in *"${g%%:*}"*) got=${g##*:};; esac; done
  if [ "$got" = "$2" ]; then PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; else FAIL=$((FAIL+1)); printf '  ❌ %s（期望 %s 得 %s）\n' "$1" "$2" "$got"; fi; }
B(){ printf '{"tool_name":"Bash","session_id":"t1","tool_input":{"command":%s}}' "$(printf '%s' "$1" | $PY -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"; }
F(){ printf '{"tool_name":"%s","session_id":"t1","tool_input":{"file_path":"%s"}}' "$1" "$2"; }
echo "═══ A 交付前四问 ═══"
chk 'git commit'                    A "$(B 'git commit -m x')"
chk 'git -c helper push'            A "$(B 'git -c credential.helper=x push origin HEAD:refs/heads/a')"
chk 'systemctl --user restart'      A "$(B 'systemctl --user restart codeg-server')"
chk 'launchctl kickstart'           A "$(B 'launchctl kickstart -k gui/501/x')"
chk 'pm2 restart'                   A "$(B 'pm2 restart p003')"
chk 'rsync 到远端'                   A "$(B 'rsync -az dist/ hk:/srv/app/')"
chk 'ssh 远程重启'                   A "$(B 'ssh hk "pm2 restart all"')"
chk '多行里第二行 push'              A "$(B $'cd x\ngit push')"
chk '反: git status'                none "$(B 'git status --porcelain')"
chk '反: git log'                   none "$(B 'git log -1')"
chk '反: systemctl status'          none "$(B 'systemctl --user status x')"
chk '反: 本地 rsync'                 none "$(B 'rsync -a a/ b/')"
chk '反: grep commit 字样'           none "$(B 'grep -n commit notes.md')"
echo "═══ B 结论落盘三档 ═══"
chk 'Write 记忆 topic'               B "$(F Write /home/u/.claude/projects/-home-u-mycc/memory/feedback_x.md)"
chk 'Edit Air 记忆'                  B "$(F Edit /Users/r/.claude/projects/-Users-r-mycc/memory/MEMORY.md)"
chk 'Write 1-Inbox 报告'             B "$(F Write /home/u/mycc/1-Inbox/2026-09-23-报告.md)"
chk 'Edit 0-System'                  B "$(F Edit /home/u/.mycc-global/0-System/RECENT_EVENTS.md)"
chk 'grok search_replace 记忆'       B "$(F search_replace /home/u/.claude/projects/p/memory/a.md)"
chk '反: Edit 源码'                  none "$(F Edit /home/u/mycc/src/app.ts)"
chk '反: Write 记忆目录非 md'         none "$(F Write /home/u/.claude/projects/p/memory/x.json)"
echo "═══ C 截断 ═══"
chk 'Grep head_limit=20'             C '{"tool_name":"Grep","session_id":"t1","tool_input":{"pattern":"x","head_limit":20}}'
chk '反: Grep 无 head_limit'          none '{"tool_name":"Grep","session_id":"t1","tool_input":{"pattern":"x"}}'
chk '反: Grep head_limit=0'           none '{"tool_name":"Grep","session_id":"t1","tool_input":{"pattern":"x","head_limit":0}}'
echo "═══ 兼容与健壮 ═══"
chk 'camelCase(grok) Bash commit'   A '{"toolName":"run_terminal_command","sessionId":"t1","toolInput":{"command":"git commit -m x"}}'
chk '坏 JSON 静默'                   none 'not json'
chk 'tool_input 非对象'              none '{"tool_name":"Bash","tool_input":"git commit"}'
echo "═══ 冷却：同会话同组 20 分钟只一次，不同组/不同会话不受影响 ═══"
S=$T/cool.json; c1=$(NUDGE_STATE=$S $PY "$N" <<<"$(B 'git commit -m a')"); c2=$(NUDGE_STATE=$S $PY "$N" <<<"$(B 'git push')")
c3=$(NUDGE_STATE=$S $PY "$N" <<<"$(F Write /h/.claude/projects/p/memory/a.md)"); c4=$(NUDGE_STATE=$S $PY "$N" <<<'{"tool_name":"Bash","session_id":"t2","tool_input":{"command":"git push"}}')
c5=$(NUDGE_STATE=$S NUDGE_COOLDOWN=0 $PY "$N" <<<"$(B 'git push')")
for p in "首次 A 出:${c1:+y}" "冷却内 A 不出:${c2:-y}" "冷却内 B 仍出:${c3:+y}" "别的会话 A 出:${c4:+y}" "冷却=0 再出:${c5:+y}"; do case "${p##*:}" in y) PASS=$((PASS+1)); echo "  ✅ ${p%%:*}";; *) FAIL=$((FAIL+1)); echo "  ❌ ${p%%:*}";; esac; done
echo "═══ 记账 ═══"; n=$(grep -c lesson_ $T/g.jsonl); [ "$n" -gt 0 ] && { PASS=$((PASS+1)); echo "  ✅ guard-log 记了 $n 条 note"; } || { FAIL=$((FAIL+1)); echo "  ❌ 没记账"; }
grep -q '"decision": "deny"' $T/g.jsonl && { FAIL=$((FAIL+1)); echo "  ❌ 出现 deny"; } || { PASS=$((PASS+1)); echo "  ✅ 从不 deny"; }
echo; echo "═══ 结果：$PASS 通过 / $FAIL 失败 ═══"; rm -rf $T; [ $FAIL -eq 0 ]
