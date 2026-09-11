#!/usr/bin/env bash
# safe-env-dump.sh —— 查看 env/进程环境时的**值级**脱敏器。
#
# 为什么存在：2026-09-11 我在 64.90 查 worker env，按**键名**过滤密钥
# （TOKEN/KEY/SECRET/PASS），结果 LLM_URL_QUERY 的**值**里嵌着一条 brain 通行证，
# 明文打进了会话上下文。同一天第二次同类。原理早就写在
# [[feedback_redaction_matched_key_not_value]]，所以缺的不是知识是机制。
#
# 用法：
#   safe-env-dump.sh <file>            # 脱敏打印 env 文件
#   safe-env-dump.sh --pid <PID>       # 脱敏打印 /proc/<PID>/environ
#   cat x.env | safe-env-dump.sh -     # 管道
#   safe-env-dump.sh --selftest        # 正负锚自检（改了实现必跑）
#
# 判据：键名命中 **或** 值长得像密钥，两者任一即整值替换为 <REDACTED:原因>。
# 值形态：JWT(eyJ…)、长十六进制(≥32)、长 base64(≥32)、值内嵌 token=/key=/secret=/password=。
set -uo pipefail

redact_line() {  # stdin: 一行 K=V；stdout: 脱敏后
  local line="$1" k v
  case "$line" in ''|'#'*) printf '%s\n' "$line"; return;; esac
  k=${line%%=*}; v=${line#*=}
  [ "$k" = "$line" ] && { printf '%s\n' "$line"; return; }
  # ① 键名轴
  case "$k" in
    *TOKEN*|*KEY*|*SECRET*|*PASS*|*CRED*|*AUTH*|*SIGN*)
      printf '%s=<REDACTED:key>\n' "$k"; return;;
  esac
  # ② 值形态轴（键名再无辜也拦）
  if printf '%s' "$v" | grep -qE 'eyJ[A-Za-z0-9_-]{10,}'; then
    printf '%s=<REDACTED:jwt-in-value>\n' "$k"; return
  fi
  if printf '%s' "$v" | grep -qiE '(token|api[_-]?key|secret|password|passwd)[=:][^[:space:]&]{8,}'; then
    printf '%s=<REDACTED:secret-in-value>\n' "$k"; return
  fi
  if printf '%s' "$v" | grep -qE '^[A-Fa-f0-9]{32,}$|^[A-Za-z0-9+/]{32,}={0,2}$'; then
    printf '%s=<REDACTED:high-entropy>\n' "$k"; return
  fi
  printf '%s=%s\n' "$k" "$v"
}

selftest() {
  local pass=0 fail=0
  ck() { # $1=名 $2=输入 $3=必须不出现的脏值 $4=必须保留的干净片段(可空)
    local out; out=$(redact_line "$2")
    if [ -n "$3" ] && printf '%s' "$out" | grep -qF "$3"; then
      echo "  FAIL $1 —— 脏值仍在: $out"; fail=$((fail+1)); return
    fi
    if [ -n "${4:-}" ] && ! printf '%s' "$out" | grep -qF "$4"; then
      echo "  FAIL $1 —— 干净值被误吃: $out"; fail=$((fail+1)); return
    fi
    echo "  ok   $1"; pass=$((pass+1))
  }
  # 负锚：脏值必须消失
  ck "键名轴 LLM_API_KEY"        'LLM_API_KEY=sk-live-0099abcdef' 'sk-live-0099abcdef'
  ck "值内 JWT（今天漏的那个形态）" 'LLM_URL_QUERY=token=eyJhbGciOiJIUzI1NiJ9.abcdefghijk.sig' 'eyJhbGciOiJIUzI1NiJ9'
  ck "值内 token= 无 JWT"        'SOME_URL=https://h/x?token=abcdefgh12345678' 'abcdefgh12345678'
  ck "裸长十六进制"              'P003_CANARY_HASHES=8fb71c4329885f35df498a2b4d0f7b401d0cfabc51bc58b50cc6306edc726ddb' '8fb71c4329885f35'
  # 正锚：干净值必须原样留（否则「全绿」与「全抹掉」不可区分）
  ck "正锚 普通布尔"             'P003_DEVICE_COMMANDS_ENABLED=1' '' 'P003_DEVICE_COMMANDS_ENABLED=1'
  ck "正锚 普通 URL"             'LLM_BASE_URL=https://kidshub-ai.hahaxiong.cc/v1' '' 'kidshub-ai.hahaxiong.cc/v1'
  ck "正锚 中文热词"             'INTERRUPT_HOTWORDS=停,停止,等一下' '' '停,停止,等一下'
  ck "正锚 注释行"               '# 这是注释' '' '# 这是注释'
  echo; echo "selftest: $pass 过 / $fail 不过"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  --selftest) selftest; exit $?;;
  --pid) [ -n "${2:-}" ] || { echo "用法: $0 --pid <PID>" >&2; exit 2; }
         tr '\0' '\n' < "/proc/$2/environ" | while IFS= read -r l; do redact_line "$l"; done;;
  -|'')  while IFS= read -r l; do redact_line "$l"; done;;
  *)     [ -r "$1" ] || { echo "读不到: $1" >&2; exit 2; }
         while IFS= read -r l; do redact_line "$l"; done < "$1";;
esac
