#!/usr/bin/env bash
# 部署单个 EasyTier 节点（幂等，可反复跑）
#
#   ./scripts/deploy-node.sh mini
#   ./scripts/deploy-node.sh all            # 除需要交互密码的节点外全部
#   SUDO_PASS=xxx ./scripts/deploy-node.sh linux-lan
#
# 设计要点：
#  · network_secret 只经 ssh stdin 传输，绝不出现在命令行参数里（ps 可见 = 泄露）
#  · 渲染后的实配置落在目标机 /etc/easytier/node.toml，0600 root:root
#  · 装完立刻做**三项独立验证**，任何一项不过就报错退出，不给「装好了」的假绿灯

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

TARGET="${1:?用法: deploy-node.sh <节点名|all>}"

# ── 远程执行封装：不同节点的 ssh 通道与 sudo 方式不同 ──────────────────────
remote() {  # remote <node> <cmd...>   —— 以 root 身份执行
  local node="$1"; shift
  local alias sudo_kind
  alias="$(node_field "$node" 2)"
  sudo_kind="$(node_field "$node" 5)"

  case "$sudo_kind" in
    root)     # hk-relay：走 common.sh 的 vps_ssh（密钥优先，密码回落）
      vps_ssh "$@" ;;
    nopasswd)
      ssh -o BatchMode=yes -o ConnectTimeout=20 "$alias" "sudo bash -c $(printf '%q' "$*")" ;;
    secret:*)
      local var="${sudo_kind#secret:}"
      ssh -o BatchMode=yes -o ConnectTimeout=20 "$alias" \
        "echo $(printf '%q' "${!var}") | sudo -S -p '' bash -c $(printf '%q' "$*")" ;;
    literal:*)
      local pw="${sudo_kind#literal:}"
      ssh -o BatchMode=yes -o ConnectTimeout=20 "$alias" \
        "echo $(printf '%q' "$pw") | sudo -S -p '' bash -c $(printf '%q' "$*")" ;;
    ask)
      [[ -n "${SUDO_PASS:-}" ]] || die "$node 需要 sudo 密码：SUDO_PASS=xxx $0 $node"
      if [[ "$alias" == "__LOCAL__" ]]; then
        echo "$SUDO_PASS" | sudo -S -p '' bash -c "$*"
      else
        ssh -o BatchMode=yes -o ConnectTimeout=20 "$alias" \
          "echo $(printf '%q' "$SUDO_PASS") | sudo -S -p '' bash -c $(printf '%q' "$*")"
      fi ;;
    *) die "未知 sudo 方式: $sudo_kind" ;;
  esac
}

# 把 stdin 写到目标机某个 root 文件。
#
# ⚠ 不能直接写成 remote "$node" "cat > $path"：
#   密码型 sudo 走的是 `echo 密码 | sudo -S`，这个管道**占用了 stdin**，
#   配置内容根本到不了 cat，结果是一个 0 字节的配置文件 —— 而进程照样能起来
#   （EasyTier 对空配置用默认值），验收的前两项还是绿的。2026-08-16 dev198 实测踩到。
# 所以：先以普通用户身份写到 $HOME 下的 600 临时文件（这一步不需要 sudo，stdin 干净），
#      再用 sudo install 搬到 /etc 并改属主，最后立刻删临时文件。
remote_write() {  # remote_write <node> <路径>  < 内容
  local node="$1" path="$2" alias sudo_kind
  alias="$(node_field "$node" 2)"; sudo_kind="$(node_field "$node" 5)"

  if [[ "$sudo_kind" == "root" || "$sudo_kind" == "nopasswd" ]]; then
    # 这两种 stdin 是干净的，可以直接写
    remote "$node" "umask 077; cat > '$path'"
    return
  fi

  local tmp="/tmp/.et-stage.$$.toml"
  if [[ "$alias" == "__LOCAL__" ]]; then
    ( umask 077; cat > "$tmp" )
  else
    ssh -o BatchMode=yes -o ConnectTimeout=20 "$alias" "umask 077; cat > '$tmp'"
  fi
  # 落地即 600（umask 077），随后立刻搬走并删除，暴露窗口只有这两条命令之间
  remote "$node" "[ -s '$tmp' ] || { echo 'STAGE_EMPTY'; exit 1; }; \
                  install -m 600 '$tmp' '$path' && rm -f '$tmp' && echo STAGED_OK"
}

# 本机（Air）下载并解包一次；已缓存则跳过。Air 有代理，GitHub 可达。
ensure_cache() {  # ensure_cache <plat>
  local plat="$1" cdir="$PROJ_DIR/.cache/$plat-$ET_VERSION"
  [[ -x "$cdir/easytier-core" && -x "$cdir/easytier-cli" ]] && return 0
  log "  本机缓存 $plat $ET_VERSION …"
  mkdir -p "$cdir"
  local zip="$PROJ_DIR/.cache/easytier-$plat-$ET_VERSION.zip"
  [[ -s "$zip" ]] || curl -fsSL --connect-timeout 20 --max-time 300 -o "$zip" \
    "https://github.com/EasyTier/EasyTier/releases/download/$ET_VERSION/easytier-$plat-$ET_VERSION.zip" \
    || die "下载 $plat 包失败"
  rm -rf "$cdir.x" && mkdir -p "$cdir.x"
  unzip -o -q "$zip" -d "$cdir.x" || die "解包失败"
  cp "$cdir.x/easytier-$plat/easytier-core" "$cdir/easytier-core"
  cp "$cdir.x/easytier-$plat/easytier-cli"  "$cdir/easytier-cli"
  chmod 755 "$cdir/easytier-core" "$cdir/easytier-cli"
  rm -rf "$cdir.x"
  ok "  缓存就绪 $cdir"
}

# 把本机文件推到目标机（普通用户可写的 /tmp），之后由 remote 用 sudo install 搬走
push_file() {  # push_file <node> <本地路径> <远端临时路径>
  local node="$1" src="$2" dst="$3" alias sudo_kind
  alias="$(node_field "$node" 2)"; sudo_kind="$(node_field "$node" 5)"
  if [[ "$sudo_kind" == "root" ]]; then
    vps_scp "$src" "$dst"
  elif [[ "$alias" == "__LOCAL__" ]]; then
    cp "$src" "$dst"
  else
    scp -o BatchMode=yes -o ConnectTimeout=30 "$src" "$alias:$dst" >/dev/null
  fi
}

deploy_one() {
  local node="$1"
  local vip plat alias
  vip="$(node_field "$node" 3)"
  plat="$(node_field "$node" 4)"
  alias="$(node_field "$node" 2)"
  node_arg="$node"

  [[ "$plat" == windows-* ]] && die "$node 是 Windows 节点，当前由 SYSTEM 开机任务 EasyTier Mesh 托管，不走 Unix deploy-node.sh"

  log "部署 $node  (虚拟IP $vip, 平台 $plat, 入口 $alias)"

  local tmpl="$PROJ_DIR/nodes/$node.toml"
  [[ -f "$tmpl" ]] || die "缺少模板 $tmpl"

  # ── 1. 渲染配置（纯 bash 替换，密钥不进任何进程参数）──
  local content; content="$(<"$tmpl")"
  content="${content//__NETWORK_NAME__/$EASYTIER_NETWORK_NAME}"
  content="${content//__NETWORK_SECRET__/$EASYTIER_NETWORK_SECRET}"
  # macOS 不支持自定义 TUN 名（内核分配 utunN），带上会启动失败
  [[ "$plat" == macos-* ]] && content="$(printf '%s\n' "$content" | grep -v '^dev_name')"

  # ── 2. 装二进制 ──
  #
  # 不在目标机上 curl，而是**本机下载一次、scp 分发**。两个理由：
  #  1) Studio 没有本地代理，从 GitHub Release CDN 拉包会静默卡死
  #     （2026-08-16 实测：25MB 的包停在 1MB，8 分钟不动，且 curl 不超时退出）。
  #  2) 全网节点保证跑**同一份**二进制，避免各自下到不同构建。
  ensure_cache "$plat"
  local cdir="$PROJ_DIR/.cache/$plat-$ET_VERSION"

  remote "$node" "mkdir -p /etc/easytier /var/log/easytier; chmod 700 /etc/easytier"

  if remote "$node" "[ -x /usr/local/bin/easytier-core ] && /usr/local/bin/easytier-core --version 2>/dev/null | grep -q '${ET_VERSION#v}'" 2>/dev/null; then
    echo "BIN_ALREADY_${ET_VERSION}"
  else
    log "  分发二进制到 $node …"
    push_file "$node" "$cdir/easytier-core" /tmp/easytier-core
    push_file "$node" "$cdir/easytier-cli"  /tmp/easytier-cli
    remote "$node" "
      install -m 755 /tmp/easytier-core /usr/local/bin/easytier-core
      install -m 755 /tmp/easytier-cli  /usr/local/bin/easytier-cli
      rm -f /tmp/easytier-core /tmp/easytier-cli
      xattr -d com.apple.quarantine /usr/local/bin/easytier-core /usr/local/bin/easytier-cli 2>/dev/null || true
      echo BIN_INSTALLED"
  fi
  remote "$node" "/usr/local/bin/easytier-core --version"

  # ── 3. 写配置（stdin 通道）──
  printf '%s\n' "$content" | remote_write "$node" /etc/easytier/node.toml
  # 落地后立刻断言「非空且含网络身份」——空配置不会报错，EasyTier 会安静地用默认值起来
  remote "$node" "chmod 600 /etc/easytier/node.toml
    ls -l /etc/easytier/node.toml
    [ -s /etc/easytier/node.toml ] || { echo 'CONFIG_EMPTY'; exit 1; }
    grep -q '^\[network_identity\]' /etc/easytier/node.toml || { echo 'CONFIG_NO_IDENTITY'; exit 1; }
    grep -q '__NETWORK_SECRET__' /etc/easytier/node.toml && { echo 'CONFIG_PLACEHOLDER_NOT_RENDERED'; exit 1; }
    echo CONFIG_OK" || die "$node 配置落地失败"

  # ⚠ --check-config 只验 TOML 语法，**不验键名**（未知键静默丢弃，照样 PASS）。
  #   所以它只是拦语法错的第一道闸，绝不能当作「配置正确」的证据。真证据在第 5 步。
  remote "$node" "/usr/local/bin/easytier-core -c /etc/easytier/node.toml --check-config" \
    || die "$node 配置语法不过"

  # ── 4. 注册服务 ──
  if [[ "$plat" == linux-* ]]; then
    remote "$node" "cat > /etc/systemd/system/easytier-mesh.service <<'UNIT'
[Unit]
Description=EasyTier mesh node ($node)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/easytier-core -c /etc/easytier/node.toml --rpc-portal 127.0.0.1:15888 --config-server $ET_CONFIG_SERVER
Restart=always
RestartSec=5
LimitNOFILE=1048576
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now easytier-mesh
systemctl restart easytier-mesh"
  else
    remote "$node" "cat > /Library/LaunchDaemons/cn.easytier.mesh.plist <<'PLIST'
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>cn.easytier.mesh</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/easytier-core</string>
    <string>-c</string><string>/etc/easytier/node.toml</string>
    <string>--rpc-portal</string><string>127.0.0.1:15888</string>
    <string>--config-server</string><string>$ET_CONFIG_SERVER</string>
  </array>
  <!-- launchd daemon 默认不带 HOME，而 --config-server 需要它来定位 machine-id
       的持久化目录，缺了会以 \"HOME is not set, cannot resolve machine id state
       directory\" 直接启动失败。systemd 会自动给 root 服务设 HOME=/root，所以
       同一个参数在 Linux 上没问题、在 macOS 上会挂 —— 2026-08-16 实测踩到。 -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/var/root</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/easytier/stdout.log</string>
  <key>StandardErrorPath</key><string>/var/log/easytier/stderr.log</string>
</dict>
</plist>
PLIST
chmod 644 /Library/LaunchDaemons/cn.easytier.mesh.plist
# launchctl bootout 是**异步**的：它返回时旧 job 往往还没销毁完，
# 紧接着 bootstrap 会拿到 'Bootstrap failed: 5: Input/output error'，
# 而且失败后服务处于「既没旧的也没新的」状态，看起来像装崩了。
# 所以：先 bootout，轮询确认真的消失，再 bootstrap，并留重试。
launchctl bootout system/cn.easytier.mesh 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print system/cn.easytier.mesh >/dev/null 2>&1 || break
  sleep 1
done
BOOTED=0
for i in 1 2 3 4 5; do
  if launchctl bootstrap system /Library/LaunchDaemons/cn.easytier.mesh.plist 2>/dev/null; then
    BOOTED=1; break
  fi
  sleep 2
done
[ \"\$BOOTED\" = 1 ] || { echo 'LAUNCHD_BOOTSTRAP_FAIL'; exit 1; }
launchctl enable system/cn.easytier.mesh"
  fi

  sleep 8

  # ── 5. 四项验收，每项都**断言**，不是打印 ──
  #
  # 血泪来源（2026-08-16 首次部署 mini 时真踩到）：客户端模板漏了 [network_identity]，
  # 节点用默认值加入了名为 "default" 的空密钥网络。此时：
  #   · 进程 active ✅   · TUN 拿到虚拟 IP ✅   · connector 状态 Connected ✅
  # 三项全绿，唯独 peer 表里只有自己 —— 因为 TCP/UDP 通道建得起来，握手鉴权才不过。
  # 当时第 3 步只「打印」peer 表不「断言」，于是假绿灯放行。
  # 教训：验收项必须是断言，且必须包含一个**只有真的联网才可能满足**的条件。
  log "$node 验收中…"
  remote "$node" "
    set -e
    echo '--- [1/4] 进程 ---'
    pgrep -f easytier-core >/dev/null && echo 'PROC_OK' || { echo 'PROC_FAIL'; exit 1; }

    echo '--- [2/4] 虚拟IP ---'
    (ip -4 addr 2>/dev/null || ifconfig 2>/dev/null) | grep -q '$vip' && echo 'VIP_OK $vip' || { echo 'VIP_FAIL'; exit 1; }

    echo '--- [3/4] 网络身份非空（防止静默落进 default 网）---'
    NN=\$(grep -E '^network_name'   /etc/easytier/node.toml | sed -E 's/.*= *\"(.*)\"/\1/')
    NS=\$(grep -E '^network_secret' /etc/easytier/node.toml | sed -E 's/.*= *\"(.*)\"/\1/')
    [ -n \"\$NN\" ] && [ -n \"\$NS\" ] && [ \"\$NN\" != 'default' ] \\
      && echo \"IDENTITY_OK (name=\$NN secret_len=\${#NS})\" \\
      || { echo 'IDENTITY_FAIL 配置里 network_name/secret 为空或仍是 default'; exit 1; }

    echo '--- [4/4] 至少看见 1 个远端 peer（唯一能证明真的入网的判据）---'
    for i in 1 2 3 4 5 6 7 8 9 10; do
      N=\$(/usr/local/bin/easytier-cli peer 2>/dev/null | grep -c 'Local' || true)
      T=\$(/usr/local/bin/easytier-cli peer 2>/dev/null | grep -cE '^\| 10\.' || true)
      REMOTE=\$((T - N))
      [ \"\$REMOTE\" -ge 1 ] && break
      sleep 3
    done
    /usr/local/bin/easytier-cli peer 2>&1
    [ \"\$REMOTE\" -ge 1 ] && echo \"PEER_OK 远端 peer 数=\$REMOTE\" \\
      || { echo 'PEER_FAIL 30s 内没看到任何远端 peer'; exit 1; }
  " || die "$node 验收未过 —— 不视为部署成功"
  ok "$node 部署完成"
}

load_secrets
export SSHPASS="${VPS_ROOT_PASS:-}"

if [[ "$TARGET" == "all" ]]; then
  for row in "${ET_NODES[@]}"; do
    n="${row%%|*}"
    [[ "$(node_field "$n" 4)" == windows-* ]] && { warn "跳过 $n（Windows 节点由 SYSTEM 开机任务托管）"; continue; }
    [[ "$(node_field "$n" 5)" == "ask" && -z "${SUDO_PASS:-}" ]] && { warn "跳过 $n（需要 sudo 密码）"; continue; }
    deploy_one "$n"
  done
else
  deploy_one "$TARGET"
fi

# ── 收尾：重新生成并实时发布速查页 ──────────────────────────────────────────
# 节点入表、生成页面、发布页面必须是同一个闭环；发布失败只告警，不反转节点部署结果。
if [[ -x "$PROJ_DIR/scripts/gen-cheatsheet.sh" ]]; then
  "$PROJ_DIR/scripts/gen-cheatsheet.sh" || echo "⚠ 速查页生成失败（不影响本次节点部署），请手动跑 scripts/gen-cheatsheet.sh"
  if [[ -x "$PROJ_DIR/scripts/deploy-cheatsheet.sh" ]]; then
    "$PROJ_DIR/scripts/deploy-cheatsheet.sh" \
      || echo "⚠ 速查页发布失败（不影响节点部署），请手动跑 scripts/deploy-cheatsheet.sh"
  fi
fi
