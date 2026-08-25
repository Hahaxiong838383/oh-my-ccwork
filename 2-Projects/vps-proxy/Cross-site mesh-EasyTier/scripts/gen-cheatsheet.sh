#!/usr/bin/env bash
# 从 common.sh 的 ET_NODES 真值表**生成** web/index.html 的节点表段落。
#
# 为什么要有这个脚本（2026-08-21 加）：
#   原先 web/index.html 是手写的，deploy-cheatsheet.sh 只负责部署不负责生成。
#   于是「加了节点」和「更新速查页」是两个动作 —— 而第二个已经被漏掉两次：
#   fnos2（8-16 接入）和 home-studio（8-20 接入）在页面上根本不存在，
#   页面一直停在最早的 6 节点，还装作是完整的。
#
# 设计原则：**让「漏掉」变得不可能，让「不完整」变得显眼。**
#   · 遍历 ET_NODES —— 真值表里有的节点必然出现在页面上，不靠人记得
#   · 描述缺失不静默跳过，而是印出醒目的「⚠ 描述待补」，逼人补上
#   · mesh 别名去 ~/.ssh/config 里**实查**，查不到就如实标注，不假设 <name>-mesh 一定存在
#
# 幂等：反复跑结果一致。只替换 NODES:BEGIN/END 之间的内容，手写的其他段落不动。

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/common.sh"
PAGE="$PROJ_DIR/web/index.html"
SSH_CONFIG="${SSH_CONFIG:-$HOME/.ssh/config}"

# 节点描述。**用 case 不用关联数组** —— macOS 自带 bash 是 3.2，
# `declare -A` 在 3.2 上会误解析成 "hk: unbound variable"，本脚本 2026-08-21 就踩了。
# 新节点没登记也会出现在页面上，只是带醒目告警标记（宁可难看，不可静默漏掉）。
node_role() {
  case "$1" in
    hk-relay)    echo "香港 · 中继 / 发现" ;;
    mini)        echo "公司 · Mac Mini M4 · 编排中枢" ;;
    studio)      echo "公司 · Mac Studio M2 Max · 算力" ;;
    dev198)      echo "公司 · Ubuntu + RTX A2000" ;;
    linux-lan)   echo "家 · Ubuntu 桌面 · 家侧网关（主）· 探针宿主" ;;
    fnos2)       echo "家 · 飞牛 NAS 2 号 · 家侧网关（备）· Docker" ;;
    home-studio) echo "家 · 主力开发机 · 20 线程 / 31G" ;;
    maxtkf-server) echo "家 · Windows 11 · SYSTEM 开机任务" ;;
    air)         echo "MacBook Air M5 · 随身" ;;
    *)           echo "" ;;
  esac
}
# 本机节点（页面上显示「本机」而不是 ssh 命令）
LOCAL_NODE="${ET_LOCAL_NODE:-air}"

mesh_alias() {   # 去 ssh config 实查，不假设一定叫 <name>-mesh
  local n="$1" a
  for a in "${n}-mesh" "${n%%-*}-mesh"; do
    if grep -qiE "^[[:space:]]*Host[[:space:]]+.*${a}([[:space:]]|$)" "$SSH_CONFIG" 2>/dev/null; then
      echo "$a"; return
    fi
  done
  echo ""   # 查不到
}

rows=""; missing_role=0; missing_alias=0; n=0
for entry in "${ET_NODES[@]}"; do
  IFS='|' read -r name _alias vip _plat _sudo <<<"$entry"
  n=$((n+1))
  role="$(node_role "$name")"
  if [[ -z "$role" ]]; then role='⚠ 描述待补 —— 请到 gen-cheatsheet.sh 的 ROLE 表登记'; missing_role=$((missing_role+1)); fi
  if [[ "$name" == "$LOCAL_NODE" ]]; then
    conn='<kbd>本机</kbd>'
  else
    ma="$(mesh_alias "$name")"
    if [[ -n "$ma" ]]; then conn="<code class=\"cp\">ssh ${ma}</code>"
    else conn="<code class=\"cp\">ssh ${vip}</code><span class=\"role\">⚠ 无 -mesh 别名</span>"; missing_alias=$((missing_alias+1)); fi
  fi
  rows+="      <tr><td class=\"name\">${name}<span class=\"role\">${role}</span></td>
          <td><code class=\"cp\">${vip}</code></td>
          <td>${conn}</td></tr>
"
done

python3 - "$PAGE" "$rows" <<'PY'
import sys,pathlib
page,rows=pathlib.Path(sys.argv[1]),sys.argv[2]
t=page.read_text(encoding="utf-8")
B="<!-- NODES:BEGIN"; E="      <!-- NODES:END -->"
i=t.index(B); i=t.index("\n",i)+1
j=t.index(E)
page.write_text(t[:i]+rows+t[j:],encoding="utf-8")
PY

echo "✓ 已从 ET_NODES 生成节点表：${n} 个节点"
[[ $missing_role  -gt 0 ]] && echo "⚠ ${missing_role} 个节点缺描述，页面上已标红，请登记 ROLE 表"
[[ $missing_alias -gt 0 ]] && echo "⚠ ${missing_alias} 个节点在 ~/.ssh/config 里没有 -mesh 别名"
echo "  页面：$PAGE"
echo "  下一步：./scripts/deploy-cheatsheet.sh  推到 http://10.10.10.1:8080/"
