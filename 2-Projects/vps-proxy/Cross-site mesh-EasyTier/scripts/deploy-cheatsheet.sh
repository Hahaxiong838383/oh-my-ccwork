#!/usr/bin/env bash
# 把 web/index.html 部署成组网内的速查页（hk-relay 上，绑虚拟 IP）
#
#   ./scripts/deploy-cheatsheet.sh
#
# 幂等：改完 web/index.html 再跑一次就更新了。
# 绑 10.10.10.1 而非 0.0.0.0：公网打不开。供应商防火墙本来也没放 8080，
# 但不能靠它当唯一防线 —— 绑定地址是自己这侧能控制的那道。

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PORT="${CHEATSHEET_PORT:-8080}"
SRC="$PROJ_DIR/web/index.html"
[[ -f "$SRC" ]] || die "缺少 $SRC"

# 本脚本只传静态 HTML，不需要 network_identity。缺 secrets 文件时仍可发布。

log "上传页面…"
vps_ssh "mkdir -p /var/www/mesh"
vps_scp "$SRC" /var/www/mesh/index.html
vps_ssh "chmod 644 /var/www/mesh/index.html; ls -l /var/www/mesh/index.html"

log "写 systemd 服务…"
vps_ssh "cat > /etc/systemd/system/mesh-cheatsheet.service <<UNIT
[Unit]
Description=Mesh cheatsheet (LAN-only static page)
# 必须等 easytier 起来：要绑虚拟 IP 10.10.10.1，早启动会 bind 失败
After=easytier-mesh.service
Requires=easytier-mesh.service

[Service]
Type=simple
WorkingDirectory=/var/www/mesh
ExecStart=/usr/bin/python3 -m http.server $PORT --bind 10.10.10.1
Restart=always
RestartSec=5
# 只读静态文件，降权到 nobody
User=nobody
Group=nogroup
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now mesh-cheatsheet
systemctl restart mesh-cheatsheet"

sleep 4

# 验收：不只看 active，要拿到真实载荷
log "验收…"
vps_ssh "
  systemctl is-active mesh-cheatsheet || { echo SERVICE_DOWN; exit 1; }
  ss -tln | grep -q '10.10.10.1:$PORT' || { echo NOT_BOUND_TO_MESH_IP; exit 1; }
  ss -tln | grep -qE '0\.0\.0\.0:$PORT' && { echo 'LEAKED_TO_0.0.0.0'; exit 1; }
  echo BIND_OK
" || die "服务未正常绑定"

local_sum="$(sha256sum "$SRC" | awk '{print $1}')"
remote_sum="$(vps_ssh "sha256sum /var/www/mesh/index.html" | awk '{print $1}')"
[[ "$local_sum" == "$remote_sum" && -n "$local_sum" ]] || die "本地/线上 SHA256 不一致"

ok "已部署 → http://10.10.10.1:$PORT"
ok "SHA256 $local_sum"
