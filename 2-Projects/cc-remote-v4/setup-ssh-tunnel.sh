#!/bin/bash
# Mac Mini SSH 公网穿透 — 一键配置脚本
# 基于 cc-remote v4 FRP 架构，在已有 frpc 中追加 SSH proxy
#
# 用法：在 Mac Mini 上执行  bash setup-ssh-tunnel.sh
# 完成后：ssh -p 22022 <用户名>@cli.hahaxiong.top

set -e

SSH_REMOTE_PORT=22022
SSH_LOCAL_PORT=22
PROXY_NAME="macmini-ssh"

echo "=== Mac Mini SSH 公网穿透配置 ==="

# ① 找到正在运行的 frpc 及其配置文件
FRPC_CMD=$(ps aux | grep '[f]rpc' | head -1)
if [ -z "$FRPC_CMD" ]; then
    echo "❌ 未找到运行中的 frpc 进程"
    echo "   请先确认 cc-remote v4 的 frpc 正在运行"
    exit 1
fi

FRPC_TOML=$(echo "$FRPC_CMD" | grep -oE '/[^ ]+frpc\.toml')
if [ -z "$FRPC_TOML" ]; then
    echo "❌ 无法从进程参数中提取 frpc.toml 路径"
    echo "   进程信息: $FRPC_CMD"
    echo "   请手动指定: FRPC_TOML=/path/to/frpc.toml bash $0"
    exit 1
fi

FRPC_DIR=$(dirname "$FRPC_TOML")
echo "  frpc.toml: $FRPC_TOML"
echo ""

# ② 检查 SSH 是否开启
if nc -z 127.0.0.1 "$SSH_LOCAL_PORT" 2>/dev/null; then
    echo "  ✓ SSH 服务正常 (端口 $SSH_LOCAL_PORT)"
else
    echo "❌ SSH 未监听端口 $SSH_LOCAL_PORT"
    echo "   请先开启: 系统设置 → 通用 → 共享 → 远程登录"
    exit 1
fi

# ③ 检查是否已配置过
if grep -q "$PROXY_NAME" "$FRPC_TOML" 2>/dev/null; then
    echo "  ⚠ frpc.toml 中已存在 $PROXY_NAME 配置"
    echo "  当前内容:"
    echo "  ---"
    cat "$FRPC_TOML"
    echo "  ---"
    echo "  跳过写入，直接重启 frpc..."
else
    # ④ 备份并追加 SSH proxy
    cp "$FRPC_TOML" "${FRPC_TOML}.bak.$(date +%s)"
    echo "  ✓ 已备份 frpc.toml"

    cat >> "$FRPC_TOML" << EOF

[[proxies]]
name = "$PROXY_NAME"
type = "tcp"
localIP = "127.0.0.1"
localPort = $SSH_LOCAL_PORT
remotePort = $SSH_REMOTE_PORT
EOF
    echo "  ✓ 已追加 SSH proxy (本地:$SSH_LOCAL_PORT → 远程:$SSH_REMOTE_PORT)"
fi

# ⑤ 重启 frpc
echo ""
echo "  重启 frpc..."
pkill -f 'frpc -c' 2>/dev/null || pkill -f 'frpc' 2>/dev/null || true
sleep 2

# 检查 launchd 是否自动拉起
if ps aux | grep '[f]rpc' | grep -q frpc; then
    echo "  ✓ frpc 已被 launchd 自动重启"
else
    echo "  launchd 未自动拉起，手动启动..."
    FRPC_BIN=$(find "$FRPC_DIR" -name 'frpc' -not -name '*.toml' -not -name '*.bak*' | head -1)
    if [ -z "$FRPC_BIN" ]; then
        FRPC_BIN=$(which frpc 2>/dev/null)
    fi
    if [ -n "$FRPC_BIN" ]; then
        HTTP_PROXY="" HTTPS_PROXY="" nohup "$FRPC_BIN" -c "$FRPC_TOML" >/tmp/frpc-ssh.log 2>&1 &
        sleep 2
        if ps aux | grep '[f]rpc' | grep -q frpc; then
            echo "  ✓ frpc 手动启动成功"
        else
            echo "  ❌ frpc 启动失败，查看日志: /tmp/frpc-ssh.log"
            exit 1
        fi
    else
        echo "  ❌ 找不到 frpc 二进制文件"
        exit 1
    fi
fi

# ⑥ 验证
echo ""
echo "=== 验证 ==="
echo "  frpc.toml 最终内容:"
cat "$FRPC_TOML"
echo ""
echo "  frpc 进程:"
ps aux | grep '[f]rpc' | head -3

echo ""
echo "========================================="
echo "  ✓ Mini 端配置完成！"
echo ""
echo "  还需要你做一步："
echo "  → 阿里云安全组放行 TCP 端口 $SSH_REMOTE_PORT"
echo "    (ECS 控制台 → 安全组 → 入方向 → 添加规则)"
echo ""
echo "  完成后测试连接："
echo "    ssh -p $SSH_REMOTE_PORT $(whoami)@cli.hahaxiong.top"
echo ""
echo "  建议加到 ~/.ssh/config:"
echo "    Host mini"
echo "        HostName cli.hahaxiong.top"
echo "        Port $SSH_REMOTE_PORT"
echo "        User $(whoami)"
echo "========================================="
