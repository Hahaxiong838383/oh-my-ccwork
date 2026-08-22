#!/usr/bin/env bash
# mycc-run —— 三家 agent 运行时的统一调用入口
#
# 收敛掉四类记不住的差异（都是 2026-08-22 实测得出）：
#   1. 代理方向相反：codex/grok 走 CPA 必须直连（吃到代理必卡死），claude 走境外 API 需要代理
#   2. 审批 flag 各不相同：--approve-for-me / --always-approve / --permission-mode
#   3. grok 的 repo-local MCP server 需要 --trust，否则静默不启动（症状是空转数分钟）
#   4. grok 默认模型是 TUI 设置项不是配置字段，headless 必须显式 -m
#
# 用法: mycc-run <claude|codex|grok> [options] [prompt]
#       prompt 省略时从 stdin 读。
# 源码位置: ~/mycc/.claude/skills/mcp-hub/scripts/mycc-run.sh（详见同目录 SKILL.md）
set -uo pipefail

CPA_ENV="${MYCC_CPA_ENV:-$HOME/.cpa.env}"
GROK_MODEL_DEFAULT="${MYCC_GROK_MODEL:-cpa-grok}"
PROXY_VARS="HTTPS_PROXY HTTP_PROXY ALL_PROXY https_proxy http_proxy all_proxy"

die() { printf 'mycc-run: %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'USAGE'
mycc-run <engine> [options] [prompt]

engine:
  claude    Claude Code        （保留代理；模型由 CLI 自身决定）
  codex     OpenAI Codex       （直连 CPA；模型取 ~/.codex/config.toml）
  grok      Grok Build         （直连 CPA；默认模型 cpa-grok，自动加 --trust）

options:
  -m, --model <M>   覆盖模型（codex 传 -m，grok 传 -m；claude 忽略）
  -C, --cd <DIR>    切到该目录再执行（默认当前目录）
  -n, --dry-run     只打印将要执行的命令，不执行
      --safe        不自动批准工具调用（改为各引擎的默认审批行为）
  -h, --help        本帮助

其他:
  mycc-run doctor   检查三家是否就绪（凭据 / CLI / MCP server）

示例:
  mycc-run grok "总结 README"
  mycc-run codex -C ~/mycc "看看 mcp-hub 有哪些脚本"
  echo "长 prompt" | mycc-run claude
  mycc-run grok -n "dry run 看看真实命令"
USAGE
}

# ---------- doctor ----------
doctor() {
  local ok=0 bad=0
  chk() { if eval "$2" >/dev/null 2>&1; then printf '  ✓ %s\n' "$1"; ok=$((ok+1)); else printf '  ✗ %s\n' "$1"; bad=$((bad+1)); fi; }
  echo "CLI:"
  chk "claude 已安装" "command -v claude"
  chk "codex 已安装"  "command -v codex"
  chk "grok 已安装"   "command -v grok"
  echo "凭据:"
  chk "$CPA_ENV 存在"          "[ -f '$CPA_ENV' ]"
  chk "$CPA_ENV 权限为 600"    "[ \"\$(stat -c%a '$CPA_ENV' 2>/dev/null)\" = 600 ]"
  chk "CPA_API_KEY 非空"       "[ -n \"\$(grep -m1 '^CPA_API_KEY=' '$CPA_ENV' 2>/dev/null | cut -d= -f2-)\" ]"
  echo "网关直连（不经代理）:"
  chk "smart-api 可直连"  "curl -sS --noproxy '*' --max-time 8 -o /dev/null https://smart-api.hahaxiong.top/v1/models"
  echo "MCP server 注册:"
  chk "codex 已注册 mycc-*" "grep -q '^\[mcp_servers\.mycc-' \$HOME/.codex/config.toml"
  chk "grok 已注册 mycc-*"  "grep -q '^\[mcp_servers\.mycc-' \$HOME/.grok/config.toml"
  echo
  printf '%d ok / %d failed\n' "$ok" "$bad"
  [ "$bad" -eq 0 ] || return 1
}

[ $# -ge 1 ] || { usage; exit 1; }
case "$1" in
  -h|--help) usage; exit 0 ;;
  doctor)    doctor; exit $? ;;
esac

ENGINE="$1"; shift
MODEL=""; WORKDIR=""; DRYRUN=0; SAFE=0; PROMPT=""

while [ $# -gt 0 ]; do
  case "$1" in
    -m|--model)  [ $# -ge 2 ] || die "-m 需要一个参数"; MODEL="$2"; shift 2 ;;
    -C|--cd)     [ $# -ge 2 ] || die "-C 需要一个参数"; WORKDIR="$2"; shift 2 ;;
    -n|--dry-run) DRYRUN=1; shift ;;
    --safe)      SAFE=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    --)          shift; PROMPT="$*"; break ;;
    -*)          die "未知选项 $1（用 -h 看帮助）" ;;
    *)           PROMPT="$*"; break ;;
  esac
done

# prompt 省略则从 stdin 读（支持长 prompt / 管道）
if [ -z "$PROMPT" ]; then
  [ -t 0 ] && die "没有 prompt：作为参数给出，或从 stdin 传入"
  PROMPT="$(cat)"
fi
[ -n "${PROMPT//[[:space:]]/}" ] || die "prompt 为空"

if [ -n "$WORKDIR" ]; then
  [ -d "$WORKDIR" ] || die "目录不存在: $WORKDIR"
  cd "$WORKDIR" || die "无法进入 $WORKDIR"
fi

case "$ENGINE" in
  claude|codex|grok) ;;
  *) die "未知引擎 '$ENGINE'（可选: claude / codex / grok；或 doctor）" ;;
esac
command -v "$ENGINE" >/dev/null 2>&1 || die "$ENGINE 未安装或不在 PATH"

# CPA 凭据：只 source 进环境，不回显。claude 不需要。
needs_cpa=0
case "$ENGINE" in codex|grok) needs_cpa=1 ;; esac
if [ "$needs_cpa" -eq 1 ]; then
  [ -f "$CPA_ENV" ] || die "缺少 $CPA_ENV（CPA 凭据）。先从凭据库取：见 skill secrets-vault-ops"
  set -a; . "$CPA_ENV"; set +a
  [ -n "${CPA_API_KEY:-}" ] || die "$CPA_ENV 里 CPA_API_KEY 为空"
fi

# 组装命令。codex/grok 剥掉全部代理变量（网关只能直连）；claude 保留代理。
cmd=()
if [ "$needs_cpa" -eq 1 ]; then
  cmd+=(env)
  for v in $PROXY_VARS; do cmd+=(-u "$v"); done
fi

case "$ENGINE" in
  claude)
    cmd+=(claude -p "$PROMPT")
    [ "$SAFE" -eq 1 ] || cmd+=(--permission-mode bypassPermissions)
    ;;
  codex)
    cmd+=(codex exec)
    [ "$SAFE" -eq 1 ] || cmd+=(--approve-for-me)
    [ -n "$MODEL" ] && cmd+=(-m "$MODEL")
    cmd+=("$PROMPT")
    ;;
  grok)
    cmd+=(grok -p "$PROMPT" -m "${MODEL:-$GROK_MODEL_DEFAULT}" --trust)
    [ "$SAFE" -eq 1 ] || cmd+=(--always-approve)
    ;;
  *)
    die "未知引擎 '$ENGINE'（可选: claude / codex / grok；或 doctor）"
    ;;
esac

if [ "$DRYRUN" -eq 1 ]; then
  printf '将执行（cwd=%s）:\n' "$(pwd)"
  printf '  '; printf '%q ' "${cmd[@]}"; printf '\n'
  exit 0
fi

exec "${cmd[@]}" < /dev/null
