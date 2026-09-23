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
# 2026-09-23 起所有模式统一 deny（9-19 的模式分支已撤）；顶层 decision 只认 approve/block，出现 "deny" 整条作废
top_decision_pm() { # top_decision_pm <mode> <cmd>：返回 0 = 输出带顶层 decision 键（应当永远没有）
  out=$(jq -nc --arg m "$1" --arg c "$2" '{permission_mode:$m,tool_input:{command:$c}}' | bash "$GUARD")
  printf '%s' "$out" | jq -e 'has("decision")' >/dev/null 2>&1
}
top_decision() { top_decision_pm default "$1"; }
denied_pm() {   # denied_pm <mode> <cmd>
  out=$(jq -nc --arg m "$1" --arg c "$2" '{permission_mode:$m,tool_input:{command:$c}}' | bash "$GUARD")
  printf '%s' "$out" | grep -q '"permissionDecision":"deny"'
}
hardnote_pm() { # hardnote_pm <mode> <cmd>：带硬红线标记的提醒
  out=$(jq -nc --arg m "$1" --arg c "$2" '{permission_mode:$m,tool_input:{command:$c}}' | bash "$GUARD")
  printf '%s' "$out" | grep -q '硬红线'
}
denied_auto()    { denied_pm auto "$1"; }
hardnote_auto()  { hardnote_pm auto "$1"; }
denied_default() { denied_pm default "$1"; }
hardnote_default(){ hardnote_pm default "$1"; }
denied_camel() {  # grok 形态：camelCase 键
  out=$(jq -nc --arg c "$1" '{permissionMode:"auto",toolInput:{command:$c}}' | bash "$GUARD")
  printf '%s' "$out" | grep -q '"permissionDecision":"deny"'
}
hardnote_camel() {
  out=$(jq -nc --arg c "$1" '{permissionMode:"auto",toolInput:{command:$c}}' | bash "$GUARD")
  printf '%s' "$out" | grep -q '硬红线'
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
echo "═══ 2b. 所有模式都 deny（2026-09-23 更正：9-18「auto 只能提醒」的根因是输出多了顶层 decision）═══"
r 1 'auto: git add -A deny'           denied_auto   'git add -A'
r 1 'auto: pkill -f deny'             denied_auto   'pkill -f node'
r 1 'auto: commit 署名 deny'          denied_auto   'git commit -m "x Co-Authored-By: y"'
r 0 'auto 反例: git add path 不 deny'  denied_auto   'git add rules/tools.md'
r 1 'bypass: git reset --hard deny'   denied_pm bypassPermissions 'git reset --hard origin/main'
r 1 'default: git add -A deny'        denied_default 'git add -A'
r 0 'default: 不带顶层 decision'       top_decision  'git add -A'
r 0 'auto: 不带顶层 decision'          top_decision_pm auto 'pkill -f node'
r 1 'camel(grok) auto: deny'          denied_camel  'git reset --hard origin/main'
r 1 'camel(grok) auto: 带 🔴 提醒兜底'  hardnote_camel 'git reset --hard origin/main'
r 1 '无 mode 字段: 仍 deny(旧夹具兼容)' denied 'git add -A'

echo
echo "═══ D. 新规则「| … || 兜底」：|| 绑的是管道尾恒成功命令 = 死代码 ═══"
# ⚠️ 锚必须是**本规则独占**的串。正例（rg|grep|head||echo）会同时触发上面的「截断」规则，
# 拿交集串当锚 → 本档永远绿，而新规则从没被验过（feedback_channel_exclusive_anchor）。
# '管道尾接 || 兜底' 只出现在本规则文案里，已手跑对过真实输出。
PMARK='管道尾接 || 兜底'
pfire() {
  out=$(jq -nc --arg c "$1" '{tool_input:{command:$c}}' | bash "$GUARD")
  printf '%s' "$out" | grep -q "$PMARK"
}
if pfire 'cat a.txt | head -5 || echo none'; then
  echo "  ✅ pfire() 对已知正例返回真（锚在真实输出里存在，且为本规则独占）"
else
  echo "  ❌ HARNESS_BROKEN: pfire() 对已知正例返回假。两种根因同症状，都查："
  echo "     ① 锚 '$PMARK' 不是 $GUARD 输出里真实连续存在的子串"
  echo "     ② 规则本身失效或被改坏"
  echo "     D 档下面的结果一律作废——反例档在检测器死掉时会全绿伪装成健康。"
  exit 2
fi
p() { local want=$1 label=$2 cmd=$3
      if pfire "$cmd"; then got=1; else got=0; fi
      if [ "$got" = "$want" ]; then printf "  ✅ %-44s\n" "$label"; PASS=$((PASS+1))
      else printf "  ❌ %-44s 期望fire=%s 实际=%s\n" "$label" "$want" "$got"; FAIL=$((FAIL+1)); fi; }
p 1 '正: grep|head||echo（2026-08-22 原形）'  'rg foo . | grep bar | head -5 || echo "(没找到)"'
p 1 '正: |wc -l||echo'                       'cat f | wc -l || echo 0'
p 1 '正: |jq||echo'                          'curl -s http://x/y | jq .name || echo 无'
p 1 '正: |sort||true'                        'ps aux | sort || true'
p 0 '反: grep 收尾（正确写法，会真触发）'      'ls | grep foo || echo 没有'
p 0 '反: grep -q 无管道（正确写法）'           'grep -q foo file || echo 没有'
p 0 '反: head 在中间、grep 收尾'              'ls | head -20 | grep foo || echo 没有'
p 0 '反: 有恒成功管道尾但没有 ||'             'cat a | head -5'
p 0 '反: 无管道的 || 容错'                    'make build || exit 1'
p 0 '反: 提示推荐的替代写法不许自报'           'out=$(rg foo . | head -5); [ -z "$out" ] && echo 没找到'

echo
echo "═══ E. 换行盲区：grep 按行匹配，多行命令曾让所有跨行规则静默 ═══"
# 2026-08-15 记录为「待办（未做）」：$? 规则要求字面分号，换行写法完全不响，
# 而多行脚本是更常用的写法 —— 守护器覆盖的是较少用的那一半。2026-08-22 修在 has() 输入侧。
# ⚠️ 旧规则的锚必须与新规则**互斥**：两条文案都含「退出码」「PIPESTATUS」，
# 用交集串会让本档恒绿。'没有大写 PIPESTATUS' 只在 $? 那条里。
QMARK='没有大写 PIPESTATUS'
qfire() {
  out=$(printf '%s' "$1" | jq -Rs '{tool_input:{command:.}}' | bash "$GUARD")
  printf '%s' "$out" | grep -q "$QMARK"
}
pfire_ml() {   # 多行版 pfire（走 -Rs 保留换行，不能用 --arg 的单行路径）
  out=$(printf '%s' "$1" | jq -Rs '{tool_input:{command:.}}' | bash "$GUARD")
  printf '%s' "$out" | grep -q "$PMARK"
}
e() { local want=$1 fn=$2 label=$3 cmd=$4
      if "$fn" "$cmd"; then got=1; else got=0; fi
      if [ "$got" = "$want" ]; then printf "  ✅ %-46s\n" "$label"; PASS=$((PASS+1))
      else printf "  ❌ %-46s 期望fire=%s 实际=%s\n" "$label" "$want" "$got"; FAIL=$((FAIL+1)); fi; }

e 1 qfire     '正: $? 换行形态（2026-08-15 的漏网）' 'rsync -a a b | head -5
echo $?'
e 1 qfire     '正: $? 单行形态（不许回归）'          'rsync -a a b | head -5; echo $?'
e 1 pfire_ml  '正: || 反斜杠续行'                    'cat a | head -5 \
  || echo none'
e 1 pfire_ml  '正: || 单行（不许回归）'              'cat a | head -5 || echo none'
e 0 pfire_ml  '反: 两条无关命令，折叠后不许粘成误报'  'ls | head -5
echo done || true'
e 0 pfire_ml  '反: && 右侧的 ||（不绑管道）'          'cat a | head -5 && echo ok || echo ng'
e 0 qfire     '反: 多行但无 $?'                      'ls | head -5
echo done'

echo
echo "═══ 结果：$PASS 通过 / $FAIL 失败（FAIL 必须为 0）═══"
[ "$FAIL" = 0 ] || exit 1
