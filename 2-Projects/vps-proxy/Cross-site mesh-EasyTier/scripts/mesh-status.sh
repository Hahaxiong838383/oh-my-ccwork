#!/usr/bin/env bash
# 全网链路巡检 —— 逐节点取它自己的视角，汇总成一张矩阵
#
#   ./scripts/mesh-status.sh            # 人读表格
#   ./scripts/mesh-status.sh --check    # 只输出异常，全好则静默退出 0（给 cron/告警用）
#
# 为什么要「逐节点取视角」而不是只查一台：
#   EasyTier 的 peer 表是**本节点视角**。A 看得见 B 不代表 B 看得见 A，
#   单侧读数在「一边先死」的场景里会给出完全错误的结论。
#
# 判读规则（重要，脱离这条会误报）：
#   cost=p2p    直连，流量不经香港
#   cost=relay(N) 经 N 跳中继 —— 家↔公司若长期是 relay，说明打洞没成
#   刚建链的前 ~30s，loss 字段会因样本太少显示 50%/100% 这类假值，不要据此告警

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
set +e   # 巡检不因单节点不可达而中断

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

PROBLEMS=()

peer_of() {  # peer_of <node> -> 该节点的 peer 表原文
  local node="$1" alias sudo_kind
  alias="$(node_field "$node" 2)"; sudo_kind="$(node_field "$node" 5)"
  case "$sudo_kind" in
    root) vps_ssh 'easytier-cli peer 2>/dev/null' ;;
    nopasswd) ssh -o BatchMode=yes -o ConnectTimeout=12 "$alias" \
            'sudo /usr/local/bin/easytier-cli peer 2>/dev/null' ;;
    secret:*) et_sudo_env "$alias" "${sudo_kind#secret:}" "/usr/local/bin/easytier-cli peer" ;;
    windows-admin) ssh -o BatchMode=yes -o ConnectTimeout=12 "$alias" \
            "powershell.exe -NoProfile -NonInteractive -Command \"& 'C:\Program Files\EasyTier\easytier-cli.exe' peer\"" 2>/dev/null ;;
    ask) et_sudo_env "$alias" SUDO_PASS "/usr/local/bin/easytier-cli peer" ;;
    secret:*) local v="${sudo_kind#secret:}"
            [[ -n "${!v:-}" ]] || return 0
            ssh -o BatchMode=yes -o ConnectTimeout=12 "$alias" \
            "echo $(printf '%q' "${!v}") | sudo -S -p '' /usr/local/bin/easytier-cli peer 2>/dev/null" ;;
    literal:*) local pw="${sudo_kind#literal:}"
            ssh -o BatchMode=yes -o ConnectTimeout=12 "$alias" \
            "echo $(printf '%q' "$pw") | sudo -S -p '' /usr/local/bin/easytier-cli peer 2>/dev/null" ;;
    windows-admin) ssh -o BatchMode=yes -o ConnectTimeout=12 "$alias" \
            "powershell.exe -NoProfile -NonInteractive -Command \"& 'C:\Program Files\EasyTier\easytier-cli.exe' peer\"" 2>/dev/null ;;
    ask) if [[ "$alias" == "__LOCAL__" ]]; then
            [[ -n "${SUDO_PASS:-}" ]] && echo "$SUDO_PASS" | sudo -S -p '' /usr/local/bin/easytier-cli peer 2>/dev/null
         else
            [[ -n "${SUDO_PASS:-}" ]] && ssh -o BatchMode=yes -o ConnectTimeout=12 "$alias" \
              "echo $(printf '%q' "$SUDO_PASS") | sudo -S -p '' /usr/local/bin/easytier-cli peer 2>/dev/null"
         fi ;;
  esac
}

# 该节点的凭据是否齐备（决定「探不到」要归因给谁）
creds_ready() {
  local k; k="$(node_field "$1" 5)"
  case "$k" in
    # 密钥可用就算齐备；密码只是回落。只看密码会在密钥已通时误报「无凭据」。
    root)      ssh -o IdentitiesOnly=yes -i "$HOME/.ssh/id_ed25519" \
                   -o PreferredAuthentications=publickey -o PasswordAuthentication=no \
                   -o BatchMode=yes -o ConnectTimeout=8 -n "root@$VPS_HOST" true 2>/dev/null \
               || [[ -n "${VPS_ROOT_PASS:-}" ]] ;;
    nopasswd)  return 0 ;;
    secret:*)  local v="${k#secret:}"; [[ -n "${!v:-}" ]] ;;
    literal:*) return 0 ;;
    windows-admin) return 0 ;;
    ask)       [[ -n "${SUDO_PASS:-}" ]] ;;
    *)         return 1 ;;
  esac
}
creds_hint() {
  local k; k="$(node_field "$1" 5)"
  case "$k" in
    root)     echo "需在 ~/.mycc-secrets.env 设 VPS_ROOT_PASS" ;;
    secret:*) echo "需在 ~/.mycc-secrets.env 设 ${k#secret:}" ;;
    ask)      echo "需 SUDO_PASS=xxx 运行本脚本" ;;
    windows-admin) echo "需 Windows 管理员 SSH 公钥" ;;
    *)        echo "凭据方式 $k 未就绪" ;;
  esac
}

load_secrets
export SSHPASS="${VPS_ROOT_PASS:-}"

printf '\n\033[1m EasyTier 全网巡检  %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')"
printf '%s\n' "────────────────────────────────────────────────────────────────────"

for row in "${ET_NODES[@]}"; do
  node="${row%%|*}"
  out="$(peer_of "$node")"

  # ⚠ 探针失败 ≠ 目标失败。凭据缺失时脚本拿不到输出，与「节点真的挂了」返回同一个空串。
  # 必须先把「我够不到」和「它挂了」分开报，否则这份巡检会把自己的缺陷说成对方的故障。
  if [[ -z "$out" ]]; then
    if ! creds_ready "$node"; then
      printf ' \033[35m%-10s  探针无凭据（不是节点故障）— %s\033[0m\n' "$node" "$(creds_hint "$node")"
      PROBLEMS+=("$node 缺少凭据，本次未探测到")
    else
      printf ' \033[33m%-10s  不可达 / 未部署\033[0m\n' "$node"
      PROBLEMS+=("$node 不可达或未部署")
    fi
    continue
  fi

  # 远端 peer 行 = 以 | 10. 开头且 cost 不是 Local
  # 用 while-read 而非 mapfile：macOS 自带 bash 是 3.2，没有 mapfile
  lines=()
  while IFS= read -r _l; do [[ -n "$_l" ]] && lines+=("$_l"); done \
    < <(printf '%s\n' "$out" | grep -E '^\| 10\.' | grep -v 'Local')
  if [[ ${#lines[@]} -eq 0 ]]; then
    printf ' \033[31m%-10s  在线但看不到任何 peer（网络身份不一致？）\033[0m\n' "$node"
    PROBLEMS+=("$node 看不到任何 peer")
    continue
  fi

  printf ' \033[1m%-10s\033[0m\n' "$node"
  for l in "${lines[@]}"; do
    peer=$(awk -F'|' '{gsub(/ /,"",$3); print $3}' <<<"$l")
    cost=$(awk -F'|' '{gsub(/ /,"",$4); print $4}' <<<"$l")
    lat=$( awk -F'|' '{gsub(/ /,"",$5); print $5}' <<<"$l")
    loss=$(awk -F'|' '{gsub(/ /,"",$6); print $6}' <<<"$l")
    tun=$( awk -F'|' '{gsub(/ /,"",$9); print $9}' <<<"$l")
    color=32; mark=""
    if [[ "$cost" == relay* ]]; then color=33; mark=" ← 走中继，未直连"; PROBLEMS+=("$node→$peer 是 $cost"); fi
    printf '   \033[%sm%-12s %-9s %8s ms  loss %-6s %s%s\033[0m\n' \
      "$color" "$peer" "$cost" "$lat" "$loss" "$tun" "$mark"
  done
done

printf '%s\n' "────────────────────────────────────────────────────────────────────"
if [[ ${#PROBLEMS[@]} -eq 0 ]]; then
  printf ' \033[32m全部链路正常\033[0m\n\n'; exit 0
else
  printf ' \033[33m%s 项待关注：\033[0m\n' "${#PROBLEMS[@]}"
  printf '   · %s\n' "${PROBLEMS[@]}"; printf '\n'
  [[ $CHECK_ONLY -eq 1 ]] && exit 1 || exit 0
fi
