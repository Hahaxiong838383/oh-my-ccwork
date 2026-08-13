#!/bin/bash
# no-guessing-guard.sh 的负向验证：正例必须红、反例必须不红、旧规则不许回归。
# 判据本身要先被验证——所以每档都有反向对照，全绿而反例也全绿=检查器坏了。
# ⚠️ 默认测**同目录**那份，不是写死主 checkout。写死会让「在 worktree 里重跑」
# 实际测的还是主仓的文件——验证路径与被验对象脱钩，两份不一致时永远发现不了。
GUARD="${GUARD:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/no-guessing-guard.sh}"
[ -f "$GUARD" ] || { echo "❌ 找不到被测脚本: $GUARD"; exit 2; }
echo "被测脚本: $GUARD"
echo

# ⚠️ 匹配串必须是输出里**真实连续存在**的子串。第一版写成「不对未加引号的标量参数做
# 单词分割」，而真实输出是「不**对**未加引号…」（中间有加粗标记），于是 fire() 恒假：
# A 档 5 条正例全红、B 档 8 条反例全绿——反例的绿是假的，检测器压根没启动。
# 教训与今天那三次同族：期望零命中的判断，必须先证明检查器自己活着。
MARK='标量参数做单词分割'
fire() {   # 返回 0 = 触发了 zsh 分词提醒
  out=$(jq -nc --arg c "$1" '{tool_input:{command:$c}}' | bash "$GUARD")
  printf '%s' "$out" | grep -q "$MARK"
}
anynote() { # 返回 0 = 有任意软提醒
  out=$(jq -nc --arg c "$1" '{tool_input:{command:$c}}' | bash "$GUARD")
  printf '%s' "$out" | grep -q 'additionalContext'
}
denied() {
  out=$(jq -nc --arg c "$1" '{tool_input:{command:$c}}' | bash "$GUARD")
  printf '%s' "$out" | grep -q '"permissionDecision":"deny"'
}

PASS=0; FAIL=0
chk() { # chk <期望 fire?> <标签> <命令>
  local want=$1 label=$2 cmd=$3
  if fire "$cmd"; then got=1; else got=0; fi
  if [ "$got" = "$want" ]; then printf "  ✅ %-42s\n" "$label"; PASS=$((PASS+1))
  else printf "  ❌ %-42s  期望fire=%s 实际=%s\n" "$label" "$want" "$got"; FAIL=$((FAIL+1)); fi
}

echo "═══ 0. 检查器自检：先证明 fire() 自己活着，否则下面的绿全是假的 ═══"
if fire 'AAA="x y"; for f in $AAA; do :; done'; then
  echo "  ✅ fire() 能对已知正例返回真（匹配串 '$MARK' 在真实输出里存在）"
else
  # 两种根因同症状，都要说：① 匹配串没写成输出里真实连续的子串 ② 规则本身失效/被改坏。
  # 只报其中一个会把人支到错误方向（触发器 ≠ 根因）。
  echo "  ❌ HARNESS_BROKEN: fire() 对已知正例返回假。两种根因同症状，都查："
  echo "     ① 匹配串 '$MARK' 不是 $GUARD 输出里真实连续存在的子串（抄大意必失配）"
  echo "     ② 规则本身失效或被改坏（先手跑一次 guard 看它到底输出了什么）"
  echo "     下面的结果一律作废——尤其反例档，检测器死掉时它会全绿伪装成健康。"
  exit 2
fi

echo
echo "═══ A. 正例：必须触发（注入真 bug，确认它真变红）═══"
chk 1 'for f in $FILES（今早原形）' 'FILES="rules/tools.md docs/x.md"; NF=0; for f in $FILES; do NF=$((NF+1)); done'
chk 1 'cat $FILES（今早另一个原形）'  'FILES="a.md b.md"; cat $FILES | grep -c ""'
chk 1 'for f in $LIST（无同句赋值）'   'for f in $LIST; do :; done'
chk 1 'printf 喂裸标量'               'FILES="a b"; printf "%s\n" $FILES'
chk 1 'wc 喂裸标量'                   'SRCS="x.md y.md"; wc -c $SRCS'

echo
echo "═══ B. 反例：必须不触发（证明判据不恒真，不是见 \$ 就红）═══"
chk 0 '"${FILES[@]}" 真数组'          'for f in "${FILES[@]}"; do :; done'
chk 0 '$(cmd) 命令替换（zsh 会分割）'  'for f in $(git diff --cached --name-only); do :; done'
chk 0 '数组赋值 + 引号展开'            'FILES=(a.md b.md); for f in "${FILES[@]}"; do :; done'
chk 0 '$HOME/*.md 路径 glob'          'for f in $HOME/*.md; do :; done'
chk 0 '单词赋值 + 引号用'              'FILE="one.md"; cat "$FILE"'
chk 0 '多词赋值但只在引号内用'          'MSG="hello world"; echo "$MSG"'
chk 0 '完全无关的命令'                 'git status --porcelain'
chk 0 '${=FILES} 显式分割'             'FILES="a b"; for f in ${=FILES}; do :; done'

echo
echo "═══ C. 回归：原有 4 硬 deny + 4 软提醒不许坏 ═══"
r() { local want=$1 label=$2; shift 2; if "$@"; then got=1; else got=0; fi
      if [ "$got" = "$want" ]; then printf "  ✅ %-42s\n" "$label"; PASS=$((PASS+1));
      else printf "  ❌ %-42s 期望=%s 实际=%s\n" "$label" "$want" "$got"; FAIL=$((FAIL+1)); fi; }
r 1 'deny: git add -A'          denied 'git add -A'
r 1 'deny: pkill -f'            denied 'pkill -f node'
r 1 'deny: git reset --hard'    denied 'git reset --hard origin/main'
r 0 'deny 反例: git add path'   denied 'git add rules/tools.md'
r 1 'note: 检索管到 head'        anynote 'grep -rn foo . | head -5'
r 1 'note: systemctl'           anynote 'systemctl --user status feishu-grok-bridge'
r 1 'note: curl 127.0.0.1:port' anynote 'curl -s http://127.0.0.1:18765/healthz'
r 0 'note 反例: 纯 echo'         anynote 'echo hello'

echo
echo "═══ 结果：$PASS 通过 / $FAIL 失败（FAIL 必须为 0）═══"
[ "$FAIL" = 0 ] || exit 1
