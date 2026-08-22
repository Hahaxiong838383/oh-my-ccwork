#!/bin/bash
# PostToolUse 全工具审计 —— 记 cc 在这台机器上真正做了什么。
#
# 由来：no-guessing-guard 只挂 PreToolUse(Bash)，而改文件走的是 Edit/Write，
# 完全没有记账。mycc-run 的 wrapper 审计也只记「发起了一次调用」，
# 记不到调用内部。这一层补的就是 cc 自己的内部操作。
#
# ⚠️ 覆盖边界（写在这里，防止以后把它当成全机器的账）：
#   只约束 cc。codex / grok 用各自 CLI，Claude Code 的 hook 完全管不到它们。
#   grok 侧有自己的 hooks（matcher=run_terminal_command），codex 侧未验证。
#
# 隐私：只记「动了哪个对象」，不记内容。
#   file_path / pattern / url 原样留（追查「谁改了这个文件」必需）；
#   Bash 只留首个命令词，content/new_string 只留长度。
#   泄露面 = 写入点全集，多一个日志就多一个泄露点（隐私墙）。
#
# 实测开销（2026-08-22 home-studio，各跑 5 次取均）：
#   116B payload ≈ 6ms/次（基本是 jq 冷启动）；1MB payload ≈ 55ms/次。
#   jq 必须解析整个 JSON 才能取字段，而 tool_response 会带上被读文件的全文，
#   所以开销随读取体积涨。没做快速路径——先观察真实 payload 分布再谈优化，
#   免得又优化一个从未 bound 的约束（feedback_optimizing_a_constraint_that_never_bound）。
# 日志增长：每条约 150 字节，未做轮转。真实跑起来后按体积再决定。
#
# 失败策略：永远 exit 0。审计不得阻断任何工具调用。

set -uo pipefail
AUDIT_LOG="${TOOL_AUDIT_LOG:-$HOME/.mycc-global/0-System/tool-audit.jsonl}"

payload="$(cat)"
[ -n "$payload" ] || exit 0

mkdir -p "$(dirname "$AUDIT_LOG")" 2>/dev/null

line="$(printf '%s' "$payload" | jq -c '
  . as $in
  # tool_input 未必是对象（实测：字符串型 tool_input 会让 .file_path 直接报错，
  # 整条掉进 degraded 分支、连 tool_name 都丢掉）。先夹一层保护，
  # 让「结构意外」仍能记到工具名，只有「JSON 非法」才降级。
  | (if ($in.tool_input | type) == "object" then $in.tool_input else {} end) as $ti
  # 动了哪个对象。顺序即优先级：文件 > 笔记本 > 命令首词 > 检索式 > URL
  | (
      $ti.file_path
      // $ti.notebook_path
      // (if ($ti.command // "") != "" then ($ti.command | split(" ")[0]) else null end)
      // $ti.pattern
      // $ti.url
      // null
    ) as $t
  | {
      ts:   (now | todate),
      sid:  (($in.session_id // "") | .[0:8]),
      cwd:  (($in.cwd // "") | split("/") | last),
      tool: ($in.tool_name // "?"),
      target: $t,
      # 载荷规模：只留长度，不留内容
      size: (($ti.content // $ti.new_string // $ti.command // "") | length),
      # 认不出 target 的工具（MCP 居多）退一步记参数**键名**：
      # MCP 工具参数千变万化无法穷举字段，记键名有信息量，记值可能带 secret。
      args: (if $t == null
             then ($ti | keys)
             else null end)
    }' 2>/dev/null)"

# jq 解析失败（payload 非法/schema 变化）不能静默：留一条可查的降级记录，
# 否则「审计没记」与「这次没发生」同形（feedback_silent_non_events）。
if [ -z "$line" ]; then
  line="$(jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{ts:$ts, tool:"?", target:null, size:0, degraded:"jq-parse-failed"}' 2>/dev/null)"
fi

[ -n "$line" ] && printf '%s\n' "$line" >> "$AUDIT_LOG"
chmod 600 "$AUDIT_LOG" 2>/dev/null
exit 0
