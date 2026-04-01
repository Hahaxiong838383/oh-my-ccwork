#!/bin/bash
# Exo 双节点集群一键启动
# 自动获取 Studio Peer ID，解决每次重启 ID 变化的问题

set -e

STUDIO_IP="192.168.100.2"
STUDIO_WIFI="10.9.1.155"
STUDIO_USER="fu-121"
STUDIO_API=52415
MINI_API=52416
EXO_BIN="/Applications/EXO.app/Contents/Resources/exo/exo"

echo "=== Exo 双节点集群启动 ==="

# 1. 确保雷电通
echo "[1/5] 检查雷电连接..."
if ! ping -c 1 -W 2 $STUDIO_IP > /dev/null 2>&1; then
    echo "  雷电不通，修复 IP..."
    sudo ifconfig en3 192.168.100.1 netmask 255.255.255.0 up 2>/dev/null
    ssh $STUDIO_USER@$STUDIO_WIFI "echo '1234' | sudo -S ifconfig en5 192.168.100.2 netmask 255.255.255.0 up" 2>/dev/null
    sleep 2
    ping -c 1 -W 2 $STUDIO_IP > /dev/null 2>&1 || { echo "雷电修复失败！"; exit 1; }
fi
echo "  雷电 OK"

# 2. 杀掉残留
echo "[2/5] 清理残留进程..."
kill $(pgrep -f "exo\|start-exo") 2>/dev/null || true
lsof -ti :$MINI_API 2>/dev/null | xargs kill -9 2>/dev/null || true
ssh macstudio 'kill $(pgrep -f exo) 2>/dev/null' || true
sleep 3

# 3. 启动 Studio
echo "[3/5] 启动 Studio Exo..."
ssh macstudio "HF_ENDPOINT=https://hf-mirror.com nohup $EXO_BIN --libp2p-port 52525 --api-port $STUDIO_API > /tmp/exo-studio.log 2>&1 &"
sleep 8
PEER=$(ssh macstudio "sed 's/\x1b\[[0-9;]*m//g' /tmp/exo-studio.log | grep 'Starting node' | tail -1 | awk '{print \$NF}'" 2>/dev/null)
echo "  Studio Peer: $PEER"
[ -z "$PEER" ] && { echo "获取 Peer ID 失败！"; exit 1; }

# 4. 启动 Mini（干净环境）
echo "[4/5] 启动 Mini Exo..."
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin HOME=$HOME HF_ENDPOINT=https://hf-mirror.com \
  $EXO_BIN --api-port $MINI_API \
  --bootstrap-peers "/ip4/$STUDIO_IP/tcp/52525/p2p/$PEER" \
  > /tmp/exo-mini.log 2>&1 &

# 5. 等待组网
echo "[5/5] 等待组网..."
for i in $(seq 1 20); do
    sleep 2
    if strings /tmp/exo-mini.log 2>/dev/null | grep -q "demoting self\|RequestEventLog"; then
        echo "  ✅ 双节点组网成功！"
        echo ""
        echo "Dashboard: http://localhost:$MINI_API"
        echo "Studio:    http://$STUDIO_IP:$STUDIO_API"
        exit 0
    fi
done
echo "  ⚠️ 40秒内未完成组网，查日志: strings /tmp/exo-mini.log | tail -10"
