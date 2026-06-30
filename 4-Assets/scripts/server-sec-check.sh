#!/usr/bin/env bash
# server-sec-check.sh — 云服务器安全体检（纯只读，不改任何配置）
#
# 谁运行：cc（本地 Air 执行，经 SSH + aliyun CLI 采集）。川哥不用动手。
# 怎么触发：跟 cc 说「体检日本服务器 / 看下服务器安全状态」，cc 跑本脚本。
# 用法：bash server-sec-check.sh [ssh别名] [aliyun_profile] [instance_id] [region]
#   默认：aliyun-jp / intl-jp / <日本SWAS实例> / ap-northeast-1
#   只 SSH 别名、不带 aliyun 参数 → 跳过云防火墙检查（通用于任意 ssh 别名）
# 安全：全程只读（sshd -T / ss / systemctl is-active / list-firewall-rules），不改服务器。
set -uo pipefail

SSH_ALIAS="${1:-aliyun-jp}"
AL_PROFILE="${2:-intl-jp}"
INSTANCE_ID="${3:-3792460f545041cb9e61993d81919242}"
REGION="${4:-ap-northeast-1}"

red=0; yellow=0; green=0
RP(){ echo "🔴 $1"; red=$((red+1)); }
YP(){ echo "⚠️  $1"; yellow=$((yellow+1)); }
GP(){ echo "✅ $1"; green=$((green+1)); }

echo "═══════ 安全体检: ${SSH_ALIAS} ═══════"

# ── 主机侧快照（一次 SSH，全部只读）──
SNAP=$(ssh -o BatchMode=yes -o ConnectTimeout=12 "$SSH_ALIAS" '
  T=$(sshd -T 2>/dev/null)
  echo "PWAUTH=$(echo "$T"|awk "/^passwordauthentication/{print \$2}")"
  echo "ROOTLOGIN=$(echo "$T"|awk "/^permitrootlogin/{print \$2}")"
  echo "PORT=$(echo "$SSH_CONNECTION"|awk "{print \$4}")"  # socket-activation下sshd -T的port不准,用实连端口
  echo "MAXAUTH=$(echo "$T"|awk "/^maxauthtries/{print \$2}")"
  echo "FAIL2BAN=$(systemctl is-active fail2ban 2>/dev/null)"
  echo "UNATT=$(systemctl is-active unattended-upgrades 2>/dev/null)"
  echo "UPGRADABLE=$(apt list --upgradable 2>/dev/null|grep -c upgradable)"
  echo "SECUPD=$(apt list --upgradable 2>/dev/null|grep -ci security)"
  echo "BRUTE=$(journalctl -u ssh --since \"24 hours ago\" 2>/dev/null|grep -ci \"failed\|invalid\")"
  echo "REBOOT=$([ -f /var/run/reboot-required ]&&echo yes||echo no)"
  echo "BBR=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)"
  echo "KEYS=$(wc -l < /root/.ssh/authorized_keys 2>/dev/null)"
  echo "SSHPERM=$(stat -c %a /root/.ssh 2>/dev/null)"
  echo "NOPASSWD=$(grep -rhE NOPASSWD /etc/sudoers /etc/sudoers.d/ 2>/dev/null|grep -vcE "^[[:space:]]*#")"
  echo "SHELLUSERS=$(grep -E "/(bash|sh|zsh)$" /etc/passwd|cut -d: -f1|paste -sd, -)"
  echo "LISTEN=$(ss -tlnH 2>/dev/null|awk "{print \$4}"|grep -vE "127.0.0|\[::1\]"|paste -sd" " -)"
' 2>/dev/null)

if [ -z "$SNAP" ]; then RP "无法 SSH 连接 ${SSH_ALIAS}（检查别名/端口/网络）"; echo "体检中止"; exit 1; fi
getv(){ printf '%s\n' "$SNAP" | sed -n "s/^$1=//p" | head -1; }

PWAUTH=$(getv PWAUTH); ROOTLOGIN=$(getv ROOTLOGIN); PORT=$(getv PORT); MAXAUTH=$(getv MAXAUTH)
FAIL2BAN=$(getv FAIL2BAN); UNATT=$(getv UNATT); UPGRADABLE=$(getv UPGRADABLE); SECUPD=$(getv SECUPD)
BRUTE=$(getv BRUTE); REBOOT=$(getv REBOOT); BBR=$(getv BBR); KEYS=$(getv KEYS)
SSHPERM=$(getv SSHPERM); NOPASSWD=$(getv NOPASSWD); SHELLUSERS=$(getv SHELLUSERS); LISTEN=$(getv LISTEN)

echo "── SSH 加固 ──"
[ "$PWAUTH" = no ] && GP "密码登录已禁用" || RP "密码登录开启（爆破入口！）"
case "$ROOTLOGIN" in no|prohibit-password|without-password) GP "root 登录: $ROOTLOGIN（仅公钥）";; *) RP "root 登录: ${ROOTLOGIN:-?}（允许密码！）";; esac
[ "$PORT" = 22 ] && YP "SSH 端口 22（默认，易被扫描）" || GP "SSH 端口: $PORT（非默认，降噪）"
if [ -n "$MAXAUTH" ] && [ "$MAXAUTH" -le 3 ] 2>/dev/null; then GP "MaxAuthTries=$MAXAUTH"; else YP "MaxAuthTries=${MAXAUTH:-?}（建议≤3）"; fi
[ "$SSHPERM" = 700 ] && GP "/root/.ssh 权限 700" || RP "/root/.ssh 权限 ${SSHPERM:-?}（应 700，否则 StrictModes 拒公钥）"

echo "── 防护 / 更新 ──"
[ "$FAIL2BAN" = active ] && GP "fail2ban 运行中" || YP "fail2ban 未运行（已禁密码时可选）"
[ "$UNATT" = active ] && GP "自动安全更新开启" || YP "自动安全更新未开"
if [ "${SECUPD:-0}" -gt 0 ] 2>/dev/null; then RP "$SECUPD 个安全更新待装"; else GP "无待装安全更新"; fi
if [ "${UPGRADABLE:-0}" -gt 0 ] 2>/dev/null; then YP "$UPGRADABLE 个包可升级"; else GP "系统包最新"; fi
[ "$REBOOT" = yes ] && YP "有内核更新待重启" || GP "无待重启"
[ "$BBR" = bbr ] && GP "BBR 已开（跨境单流快）" || YP "BBR 未开"

echo "── 账户 / 暴露面 ──"
if [ "${NOPASSWD:-0}" -gt 0 ] 2>/dev/null; then YP "$NOPASSWD 条 NOPASSWD sudo（核查是否后门）"; else GP "无 NOPASSWD sudo"; fi
echo "ℹ️  有 shell 用户: ${SHELLUSERS:-?} | authorized_keys: ${KEYS:-?} 行"
echo "ℹ️  近 24h SSH 失败尝试: ${BRUTE:-?}"
echo "ℹ️  对外监听端口: ${LISTEN:-无}"

# ── 云防火墙（SWAS，需 aliyun CLI + 实例参数）──
if command -v aliyun >/dev/null 2>&1 && [ -n "$INSTANCE_ID" ]; then
  echo "── 云防火墙（SWAS）──"
  FW=$(aliyun swas-open list-firewall-rules --region "$REGION" --biz-region-id "$REGION" \
        --instance-id "$INSTANCE_ID" --profile "$AL_PROFILE" 2>/dev/null \
       | python3 -c "import json,sys
try:
  d=json.load(sys.stdin)
  print(' '.join(f\"{r['RuleProtocol']}:{r['Port']}\" for r in d.get('FirewallRules',[])))
except: print('')" 2>/dev/null)
  if [ -n "$FW" ]; then
    echo "ℹ️  开放规则: $FW"
    # 提示对外服务端口：开了 80/443 等但本机没监听 = 可能误暴露；反之有监听无放行 = 服务连不上
    echo "$FW" | grep -qE 'TCP:80|TCP:443' && YP "云防火墙开了 80/443 — 若在跑 Web 正常；若无服务建议收掉"
  else
    YP "云防火墙查询失败（profile/实例ID/网络）"
  fi
fi

echo "═══════ 汇总: ✅${green} 通过 / ⚠️${yellow} 关注 / 🔴${red} 高危 ═══════"
[ "$red" -gt 0 ] && echo "→ 有高危项，建议尽快处理"
exit 0
