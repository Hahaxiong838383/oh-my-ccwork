#!/bin/bash
# PreToolUse(Bash) 守门：把「知道但没做到」的规则变成 harness 强制。
#
# 由来：2026-08-01 一轮对话内犯三次同一类错——猜 systemd unit 名、猜 Mini 端口、
# 用 `grep … | head -15` 截断后下「不存在」的结论。规则、文档、记忆当时全都写着
# 正确答案。所以问题不是缺条文，是执行；文字拦不住，只能让 harness 拦。
#
# 分两档（依据 feedback_blocking_is_not_correcting：能给信息就别拦动作）：
#   软提醒 → additionalContext 注入上下文，命令照跑
#   硬红线 → permissionDecision=deny，只有川哥白纸黑字禁过的才进这档
#
# 失败策略：hook 自身出错必须放行（不能让守门器把所有命令卡死），但要把失败
# 说出来——静默放行等于没装。

set -uo pipefail

payload="$(cat)"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"

# 取不到命令就放行：可能是 schema 变了，宁可不拦也别误伤
if [ -z "$cmd" ]; then
  exit 0
fi

notes=()
deny_reason=""

has() { printf '%s' "$cmd" | grep -Eq "$1"; }

# ---------- 硬红线：川哥明令禁止过的 ----------
#
# ⚠️ 前缀一律用 `(^|[;&|]\s*)`——只在**命令位置**匹配，不是任意空白后。
# 第一版写成 `(^|[;&|]|\s)`，当场误伤：commit message 正文里写了 `git add -A/.`
# （在描述这条禁令本身），整条 commit 被自己拦下。命令字符串包含 heredoc 正文，
# 于是「提到某命令」被当成了「执行某命令」。守门器必须能区分这两件事，
# 否则以后写任何关于这些规则的文档、记忆、提交说明都会被自己拦住。

# 全量暂存。提交权收口在 cc，必须逐个文件选，否则会夹带别的 agent 的改动
if has '(^|[;&|]\s*)git[[:space:]]+add[[:space:]]+(-A|--all|\.)([[:space:]]|$)'; then
  deny_reason="git add 全量暂存被禁：提交必须逐个文件选。
仓里同时有其他 agent 的改动和运行时状态文件，全量暂存会把它们一起带进 commit。
用 git add <具体路径>，先 git status --porcelain 看清再选。"

# pkill -f 会匹配到自己的命令行导致自杀
elif has '(^|[;&|]\s*)pkill[^;&|]*[[:space:]]-f'; then
  deny_reason="pkill -f 被禁：pattern 会匹配到 pkill 自己的命令行，误杀自身或无关进程。
用 pgrep -f <pattern> 拿到 pid、核对确认是目标进程后，再 kill <pid>。"

# 工作区里有 owner 的活文件，hard reset 不可逆
elif has '(^|[;&|]\s*)git[[:space:]]+reset[^;&|]*--hard'; then
  deny_reason="git reset --hard 被禁：会丢掉未提交内容且不可逆。
dev198 的 workspace/** 全是 owner 活文件，丢了找不回来。
要挪指针用 git reset --mixed（保留工作区），要看差异用 git diff。"

# 署名全局关闭。要求与 git commit 同现——单纯提到这个词（写文档/记忆）不该被拦
elif has '(^|[;&|]\s*)git[[:space:]]+commit' && has 'Co-Authored-By:'; then
  deny_reason="commit 署名全局关闭：请去掉署名尾注。
（全局 settings 已设 attribution.commit=\"\" 关掉自动添加，这道只防手写。）"
fi

if [ -n "$deny_reason" ]; then
  jq -nc --arg r "$deny_reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
fi

# ---------- 软提醒：命令照跑，只把当天的教训递到眼前 ----------

# 检索类命令被 head/tail 截断。危险的不是截断本身，是拿截断结果下「不存在」的结论
if has '\b(grep|rg|egrep|fgrep|find|ls|git\s+(status|log|diff|branch|show|worktree))\b[^|]*\|[^|]*\b(head|tail)\b'; then
  notes+=("检索输出被 head/tail 截断了。如果你要据此判断「有没有 X」——不行，截断过的结果只能证明「有」，永远证不了「没有」。存在性判断改用 grep -c / grep -q，或者去掉截断。（2026-08-01 就是这样把答案截掉后误报了零命中）")
fi

# 服务名 / 端口最容易凭印象写。这两个猜错时，返回信号和「服务真挂了」一模一样
if has '\b(systemctl|launchctl)\b'; then
  notes+=("systemd/launchd 的 unit 名是待验事实：对不存在的 unit，is-active 照样答 inactive、print 照样报错——和服务真挂了长得一样。先确认名字（list-units / launchctl list 实际列出来），再判断状态。")
fi

if has 'curl[^|]*127\.0\.0\.1:[0-9]'; then
  notes+=("healthz 端口按站点不同，别跨站复制：真值在 ops/deploy-sites.sh 的 DEV_HEALTH / MINI_HEALTH，以及 h-platform-ops SKILL.md 的双站对照表。curl 打错端口的「无响应」和服务真的没起来无法区分。")
fi

# 管道后紧跟 $?：这个退出码是管道末尾那个 tail/grep 的，不是被测程序的。
# 2026-08-11~12 一天三犯（npm test、deploy-sites、attest check 全被 tail 的 0 骗过）
if has '\|[^;]*\b(tail|head|grep|sed|awk|tee|cut)\b[^;]*;[^;]*\$\?'; then
  notes+=("这个 \$? 是管道最后一个命令（tail/head/grep…）的退出码，不是你关心的那个程序的。zsh 没有大写 PIPESTATUS（bash 才有；zsh 是小写 pipestatus）。要拿真退出码：先 'cmd > log 2>&1; echo RC=\$?' 落文件，再单独看 log。（2026-08-11~12 同一坑一天踩了三次）")
fi

# zsh 不对未加引号的**标量参数**做单词分割（bash 会）。于是 `for f in $FILES` 只跑一轮、
# `cat $FILES` 把整串当成一个文件名——命令照常退 0，检查器报「零命中」，看着像通过。
# 2026-08-13 一天踩三次（全是提交前的 secret 自检），三次都只有「正向锚为 0」把它照出来。
#
# ⚠️ 实测过的对照，别记反：zsh 里命令替换 `$(cmd)` **是**会分割的，
# 所以同一天的 `for f in $(git diff --cached --name-only)` 完全正常。
# 出事的只有裸标量。故本规则只盯标量，不碰 $( )。
zsh_split_why=''

# ① `for X in $VAR` —— $VAR 必须是独立一个词（后面是空白/分号/结尾）。
#    天然排除 ${arr[@]}（$ 后是 {）、$(cmd)（$ 后是 (）、$HOME/*.md（后面是 /）。
if has '(^|[;&|]|[[:space:]])for[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]+in[[:space:]]+\$[A-Za-z_][A-Za-z0-9_]*([[:space:]]|;|$)'; then
  zsh_split_why='for X in $VAR'
fi

# ② 先把多个词赋进字符串，之后又把它裸着喂给吃多文件的命令（今早 `cat $FILES` 的原形）。
#    只在「取文件列表」的命令上触发，避免 `echo $MSG` 这类无害用法刷屏。
while IFS= read -r v; do
  [ -n "$v" ] || continue
  if printf '%s' "$cmd" | grep -qE '\b(cat|grep|rg|egrep|wc|head|tail|shasum|md5|md5sum|cp|mv|rm|ls|stat|tar|awk|sed|printf)\b[^;&|]*[^"$A-Za-z0-9_{]\$'"$v"'([^A-Za-z0-9_{]|$)'; then
    zsh_split_why="${zsh_split_why:+$zsh_split_why、}$v=\"多个词\" 之后裸用 \$$v"
  fi
done < <(printf '%s' "$cmd" | grep -oE '(^|[;&|[:space:]])[A-Za-z_][A-Za-z0-9_]*="[^"]+[[:space:]][^"]*"' | sed -E 's/^[^A-Za-z_]*//; s/=.*$//')

if [ -n "$zsh_split_why" ]; then
  notes+=("命中「$zsh_split_why」：zsh **不**对未加引号的标量参数做单词分割（bash 会）。\`FILES=\"a b c\"; for f in \$FILES\` 只跑一轮、\`cat \$FILES\` 会把整串当一个文件名——而且照常退 0，下游计数全为 0 时看着像「干净通过」。改用真数组 \`FILES=(a b c)\` + \"\${FILES[@]}\"，或 \`while IFS= read -r f\`，或显式 \`\${=FILES}\`。对照：\`\$(cmd)\` 在 zsh 里**是**会分割的，那种写法没问题。（2026-08-13 一天三犯，每次都只有「期望非零的锚」照出来——所以期望零命中的检查务必配锚）")
fi

if [ ${#notes[@]} -gt 0 ]; then
  ctx="$(printf '%s\n' "${notes[@]}")"
  jq -nc --arg c "$ctx" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: $c
    }
  }'
fi

exit 0
