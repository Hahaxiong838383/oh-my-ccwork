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
#   ⚠️ 输出只能放 hookSpecificOutput。claude 对顶层 `decision` 只认 approve/block，写成 "deny" 会抛
#   「Unknown hook decision type」，整条输出（连 additionalContext）作废，命令照跑。
#   沿革：9-02/9-18 在 codeg(auto) 会话里 deny 没拦住（当时的 claude 版本），9-19 为此加了按模式分支，
#   非 auto 分支还多写了顶层 decision:"deny"，等于把所有会话的 deny 都弄坏了。2026-09-23 在 codeg(auto)
#   会话里用探针实测（claude-agent-sdk 0.3.280）：合法格式的 deny 拦得住，带顶层 decision:"deny" 的照跑。
#   于是去掉模式分支、去掉顶层 decision，所有模式统一 deny。判「拦没拦住」仍要拿 guard-log 对撞
#   tool-audit，见 [[feedback_guard_itself_can_be_hollow]] 第 9、10 例。
#
# 失败策略：hook 自身出错必须放行（不能让守门器把所有命令卡死），但要把失败
# 说出来——静默放行等于没装。

set -uo pipefail

payload="$(cat)"
# Claude Code 使用 snake_case，Grok Build 原生 hook 使用 camelCase。
# Grok 会兼容加载 ~/.claude/settings.json，但不会替调用脚本改写 payload；只读
# .tool_input 会让 hook 看似已加载、实际对 Grok 每次都因 cmd 为空而静默放行。
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // .toolInput.command // empty' 2>/dev/null)"

# 取不到命令就放行：可能是 schema 变了，宁可不拦也别误伤
if [ -z "$cmd" ]; then
  exit 0
fi

notes=()
deny_reason=""
deny_rule=""

# ⚠️ grep -E 按**行**匹配，而 cc 写多行脚本远多于单行——任何跨行 pattern 都会静默失配。
# 2026-08-15 实测：`cmd | head -5` ⏎ `echo $?` 完全不响（同形单行则响），等于守护器
# 覆盖的是我较少用的那一半，而「装了之后我不会自己留神」比没装更危险。
# 修在输入侧一次性修好所有规则，比逐条正则放宽 `;` 更彻底：
#   `\` 续行 → 空格（同一条命令），裸换行 → `;`（命令分隔，避免把无关两行粘成一条误报）。
# 用 bash 参数替换，零外部进程（hook 在每条 Bash 前跑，冷启开销要压住）。
cmd_flat="${cmd//$'\\\n'/ }"
cmd_flat="${cmd_flat//$'\n'/;}"
has() { printf '%s' "$cmd_flat" | grep -Eq "$1"; }

# 记账：观察期要能数出「非测试场景真实拦到几次」。上一版定了这个判据却没有通道，
# 判据建在不存在的通道上 = 永远算不出来（feedback_negative_result_needs_signal_capable_channel）。
# ⚠️ 只记规则名与首个命令词，**绝不记命令原文**：命令可能带 secret，而泄露面 = 写入点全集，
# 多一个日志文件就多一个泄露点（隐私墙）。
GUARD_LOG="${GUARD_LOG:-$HOME/.mycc-global/0-System/guard-log.jsonl}"
log_hit() {   # $1=decision(note|deny)  $2..=rule ids
  local decision="$1"; shift
  local verb="${cmd%%[[:space:]]*}"
  local sid cwdb
  sid="$(printf '%s' "$payload" | jq -r '(.session_id // .sessionId // "")[0:8]' 2>/dev/null)"
  cwdb="$(basename "$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null)" 2>/dev/null)"
  {
    mkdir -p "$(dirname "$GUARD_LOG")" 2>/dev/null
    jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg sid "$sid" --arg cwd "$cwdb" \
           --arg d "$decision" --arg verb "$verb" --args \
       '{ts:$ts,sid:$sid,cwd:$cwd,decision:$d,verb:$verb,rules:$ARGS.positional}' "$@" >> "$GUARD_LOG"
    chmod 600 "$GUARD_LOG" 2>/dev/null
  } 2>/dev/null || true   # 记账失败绝不能让守门器自己失败（fail-open）
}
rule_ids=()


# ---------- 硬红线：川哥明令禁止过的 ----------
#
# ⚠️ 前缀一律用 `(^|[;&|]\s*)`——只在**命令位置**匹配，不是任意空白后。
# 第一版写成 `(^|[;&|]|\s)`，当场误伤：commit message 正文里写了 `git add -A/.`
# （在描述这条禁令本身），整条 commit 被自己拦下。命令字符串包含 heredoc 正文，
# 于是「提到某命令」被当成了「执行某命令」。守门器必须能区分这两件事，
# 否则以后写任何关于这些规则的文档、记忆、提交说明都会被自己拦住。

# 全量暂存。提交权收口在 cc，必须逐个文件选，否则会夹带别的 agent 的改动
if has '(^|[;&|]\s*)git[[:space:]]+add[[:space:]]+(-A|--all|\.)([[:space:]]|$)'; then
  deny_rule="git_add_all"; deny_reason="git add 全量暂存被禁：提交必须逐个文件选。
仓里同时有其他 agent 的改动和运行时状态文件，全量暂存会把它们一起带进 commit。
用 git add <具体路径>，先 git status --porcelain 看清再选。"

# pkill -f 会匹配到自己的命令行导致自杀
elif has '(^|[;&|]\s*)pkill[^;&|]*[[:space:]]-f'; then
  deny_rule="pkill_f"; deny_reason="pkill -f 被禁：pattern 会匹配到 pkill 自己的命令行，误杀自身或无关进程。
用 pgrep -f <pattern> 拿到 pid、核对确认是目标进程后，再 kill <pid>。"

# 工作区里有 owner 的活文件，hard reset 不可逆
elif has '(^|[;&|]\s*)git[[:space:]]+reset[^;&|]*--hard'; then
  deny_rule="git_reset_hard"; deny_reason="git reset --hard 被禁：会丢掉未提交内容且不可逆。
dev198 的 workspace/** 全是 owner 活文件，丢了找不回来。
要挪指针用 git reset --mixed（保留工作区），要看差异用 git diff。"

# 署名全局关闭。要求与 git commit 同现——单纯提到这个词（写文档/记忆）不该被拦
elif has '(^|[;&|]\s*)git[[:space:]]+commit' && has 'Co-Authored-By:'; then
  deny_rule="commit_signature"; deny_reason="commit 署名全局关闭：请去掉署名尾注。
（全局 settings 已设 attribution.commit=\"\" 关掉自动添加，这道只防手写。）"
fi

# 密钥进输出/落盘（2026-09-23 加，川哥：「secret 绝不写进对话」；本会话 8-29 `cat`、9-23 `grep -v` 两次把
# ~/.grok/config.toml 的 api_key 打进会话记录，9-02 另一会话把 `vw list items` 整份导出到 /tmp）。
# 判定逻辑在 secret-guard.py（正反例 fixtures 在 guard-fixtures/secret.jsonl）；这里先做零进程的前置过滤，
# 命令里没出现疑似密钥文件/密码库时不起 python。
if [ -z "$deny_reason" ] && has '(\.env|config\.toml|auth\.json|curlcfg|netrc|git-credentials|npmrc|pypirc|id_(rsa|ed25519|ecdsa)|\.pem|vw-items|credentials\.json|hosts\.yml|codeg\.db|(^|[;&|/[:space:]])vw[[:space:]]+(list|get))'; then
  SG="$(dirname "$0")/secret-guard.py"
  if [ -f "$SG" ]; then
    sg_out="$(printf '%s' "$cmd" | /usr/bin/python3 "$SG" 2>/dev/null)"
    sg_first="${sg_out%%$'\n'*}"
    if [ -n "$sg_first" ]; then
      deny_rule="${sg_first%%$'\t'*}"
      deny_reason="密钥会进会话或落盘（${sg_first#*$'\t'}）：会话记录、claude-mem、模型服务端都会留下它，事后收不回。
看配置用 cfgview：python3 ~/mycc/4-Assets/scripts/cfgview.py <文件>（键名照常、值遮蔽）；只想确认有没有某个键用 grep -c / grep -l。
取密钥只进变量与 stdin：VAL=\$(vw get password <名>)，绝不裸打印，也不写进 /tmp 或任何文件。"
    fi
  else
    notes+=("⚠️ secret-guard.py 不在 no-guessing-guard.sh 同目录，密钥守门已失效（本条命令像是在读密钥文件或密码库），先修路径。")
    rule_ids+=("secret_guard_missing")
  fi
fi

if [ -n "$deny_reason" ]; then
  log_hit deny "$deny_rule"
  # ⚠️ 只输出 hookSpecificOutput。顶层 decision 只认 approve/block，写成 "deny" 会让 claude 抛错、整条输出作废、命令照跑
  if printf '%s' "$payload" | jq -e 'has("toolInput")' >/dev/null 2>&1; then
    # grok（camelCase payload）认不认 deny 没验证过：额外带一份提醒兜底。claude 走下面那份已实测的格式
    ctx="🔴 硬红线：$deny_reason
若这条命令仍然执行了，说明本会话没认 hook 拒绝——立即评估后果并如实报告。"
    jq -nc --arg r "$deny_reason" --arg c "$ctx" '{
      additionalContext: $c,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
                            permissionDecisionReason: $r, additionalContext: $c }
    }'
    exit 0
  fi
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

# 管道结构类规则先把引号内容抹成 Q 再匹配（2026-09-23 夹具化试点抓出的漏洞）：
# 原规则用 [^|]* 找管道，`grep -nE "a|18775|b" SKILL.md | head -15`——8-01 原始案例本身——引号里的 | 让它断开，
# 从装上起就没盖住带「或」的 grep（真实命令里约每百条 5.7 次）；同时 [^|]* 会跨过 ; 把两条无关命令粘成误报。
# 修后：真实历史命令 1980 条上 19.9 → 17.8 次/百条，漏报补回 104、误报去掉 146。夹具 guard-fixtures/truncate.jsonl。
# 重定向里的 &（2>&1、>&2、&>）也换掉，否则 [^|;&]* 会在 `npm test 2>&1 | tail` 这种最常见写法上断开（夹具抓到）
cmd_noq="$(printf '%s' "$cmd_flat" | sed -E "s/'[^']*'/Q/g; s/\"([^\"\\\\]|\\\\.)*\"/Q/g; s/[0-9]*>&[0-9-]+/R/g; s/&>>?/R/g")"
hasq() { printf '%s' "$cmd_noq" | grep -Eq "$1"; }

# 检索类命令被 head/tail 截断。危险的不是截断本身，是拿截断结果下「不存在」的结论
# git 列表类子命令（remote/tag/ls-files…）是 8-16 `git remote -v | head -2` 漏网后补的；不含 push/commit 这类非列表输出
if hasq '\b(grep|rg|egrep|fgrep|find|ls|git[[:space:]]+(status|log|diff|branch|show|worktree|remote|tag|stash|ls-files|ls-tree|ls-remote|for-each-ref|rev-list|shortlog|reflog|config|blame|grep|submodule|cherry|name-rev|describe))\b[^|;&]*\|[^|;&]*\b(head|tail)\b'; then
  notes+=("检索输出被 head/tail 截断了。如果你要据此判断「有没有 X」——不行，截断过的结果只能证明「有」，永远证不了「没有」。存在性判断改用 grep -c / grep -q，或者去掉截断。（2026-08-01 就是这样把答案截掉后误报了零命中）")
  rule_ids+=("truncate_head_tail")
fi

# 反过来的顺序：先截 ≥10 行头尾再直接搜——只搜了头/尾那几行（教训记过的原形 `head -50 f | grep x`）
if hasq '\b(head|tail)[[:space:]]+-(n[[:space:]]*)?[0-9]{2,}[[:space:]]+[^|;&]*\|[[:space:]]*(grep|rg|egrep)\b'; then
  notes+=("先截断再搜索：head/tail -N 之后直接 grep，只搜了头/尾那 N 行，搜不到≠文件里没有。要下「有没有」的结论，直接对整个文件 grep -c / grep -q。")
  rule_ids+=("truncate_then_search")
fi

# cut -c 截断后再统计：不同的值被截成同一个（9-09 cut -c1-240 截成假值、grep|sed|cut -c1-30|sort|uniq -c 原形）
if hasq '\bcut[[:space:]]+-c[^|;&]*\|[^|;&]*\b(sort|uniq|wc)\b'; then
  notes+=("cut -c 截断之后再 sort/uniq/wc：不同的值会被截成同一个，计数、去重、MIN/MAX 都会错。统计用完整值（cut -f / awk 取字段），展示时再截。")
  rule_ids+=("truncate_then_aggregate")
fi

# 只看测试输出的头/尾就判通过（教训原形 `python3 -m pytest ... | tail -8`）
if hasq '\b(pytest|npm[[:space:]]+(run[[:space:]]+)?test|go[[:space:]]+test|cargo[[:space:]]+test|jest|vitest|node[[:space:]]+--test)\b[^|;&]*\|[^|;&]*\b(tail|head)\b'; then
  notes+=("只看测试输出的头/尾：失败可能落在被截掉的部分，而且管道的退出码是 tail 的。判通过看测试进程自己的退出码（cmd > log 2>&1; echo RC=\$?）或框架的汇总行。")
  rule_ids+=("test_output_truncated")
fi

# 服务名 / 端口最容易凭印象写。这两个猜错时，返回信号和「服务真挂了」一模一样
if has '\b(systemctl|launchctl)\b'; then
  notes+=("systemd/launchd 的 unit 名是待验事实：对不存在的 unit，is-active 照样答 inactive、print 照样报错——和服务真挂了长得一样。先确认名字（list-units / launchctl list 实际列出来），再判断状态。")
  rule_ids+=("systemd_unit_name")
fi

if has 'curl[^|]*127\.0\.0\.1:[0-9]'; then
  notes+=("healthz 端口按站点不同，别跨站复制：真值在 ops/deploy-sites.sh 的 DEV_HEALTH / MINI_HEALTH，以及 h-platform-ops SKILL.md 的双站对照表。curl 打错端口的「无响应」和服务真的没起来无法区分。")
  rule_ids+=("localhost_port")
fi

# 管道后紧跟 $?：这个退出码是管道末尾那个 tail/grep 的，不是被测程序的。
# 2026-08-11~12 一天三犯（npm test、deploy-sites、attest check 全被 tail 的 0 骗过）
if has '\|[^;]*\b(tail|head|grep|sed|awk|tee|cut)\b[^;]*;[^;]*\$\?'; then
  notes+=("这个 \$? 是管道最后一个命令（tail/head/grep…）的退出码，不是你关心的那个程序的。zsh 没有大写 PIPESTATUS（bash 才有；zsh 是小写 pipestatus）。要拿真退出码：先 'cmd > log 2>&1; echo RC=\$?' 落文件，再单独看 log。（2026-08-11~12 同一坑一天踩了三次）")
  rule_ids+=("pipe_exit_code")
fi

# 「| … || 兜底」：|| 绑的是**整条管道**的退出码，而管道退出码 = 最后一个命令的。
# head/tail/cat/sed/wc/jq 这些几乎恒返回 0，于是兜底分支永不执行——长得像容错，实际是死代码。
# 2026-08-22 实测：`… | grep … | head -5 || echo "(没找到)"` 零命中时什么都不打印，
# 而「真的没有」和「兜底根本没跑」输出完全同形，我把空输出读成了「确实没有」。
# [^|;&]* 而不是 [^|]*：折叠换行后，`ls | head -5` ⏎ `echo done || true` 会变成一行，
# 若允许跨 ; 就会把两条无关命令粘成假阳性；`&&` 同理（|| 绑的是 && 右边那段，不是管道）。
if has '\|[^|;&]*\b(head|tail|cat|sed|awk|tee|sort|uniq|wc|cut|tr|jq|column|nl)\b[^|;&]*\|\|'; then
  notes+=("管道尾接 || 兜底：|| 绑的是**整条管道**的退出码，而管道退出码 = 最后一个命令的。head/tail/cat/sed/wc/jq 这些几乎恒返回 0，所以兜底分支永远不会执行——它长得像容错，实际是死代码。更坑的是「真的没结果」和「兜底没跑」输出完全同形，从输出看不出区别。判空要先落变量：out=\$(cmd); [ -z \"\$out\" ] && echo 没找到；要拿管道里某一段的真退出码：bash 用 \${PIPESTATUS[0]}（zsh 是小写 \$pipestatus）。（2026-08-22 实测踩过；同族见上面 \$? 那条）")
  rule_ids+=("pipe_fallback_dead")
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
  rule_ids+=("zsh_word_split")
fi

if [ ${#notes[@]} -gt 0 ]; then
  log_hit note "${rule_ids[@]}"
  ctx="$(printf '%s\n' "${notes[@]}")"
  jq -nc --arg c "$ctx" '{
    additionalContext: $c,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: $c
    }
  }'
fi

exit 0
