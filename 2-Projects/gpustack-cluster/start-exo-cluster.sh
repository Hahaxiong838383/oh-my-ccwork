#!/bin/bash
# Exo 双节点集群启动脚本
# Mini (192.168.100.1) + Studio (192.168.100.2)
# 模型: Llama-3.3-70B-Instruct-4bit (37.9GB MLX)

set -e

MODEL="mlx-community/Llama-3.3-70B-Instruct-4bit"
STUDIO_IP="192.168.100.2"
STUDIO_LIBP2P_PORT=52525
STUDIO_API_PORT=52415
MINI_LIBP2P_PORT=52526
MINI_API_PORT=52416
EXO_BIN="/Applications/EXO.app/Contents/Resources/exo/exo"

echo "=== Exo 双节点集群启动 ==="

# Step 1: 杀掉残留进程
echo "[1/4] 清理残留进程..."
kill $(pgrep -f "exo.*5241") 2>/dev/null || true
ssh macstudio 'kill $(pgrep -f "exo.*5241") 2>/dev/null' || true
sleep 1

# Step 2: 启动 Studio（Master）
echo "[2/4] 启动 Studio 节点..."
ssh macstudio "HF_ENDPOINT=https://hf-mirror.com nohup $EXO_BIN --libp2p-port $STUDIO_LIBP2P_PORT --api-port $STUDIO_API_PORT --offline > /tmp/exo-studio.log 2>&1 &"
sleep 3

# 获取 Studio Peer ID
STUDIO_PEER_ID=$(ssh macstudio "grep 'Starting node' /tmp/exo-studio.log | tail -1 | awk '{print \$NF}'")
if [ -z "$STUDIO_PEER_ID" ]; then
    echo "ERROR: 获取不到 Studio Peer ID"
    ssh macstudio 'cat /tmp/exo-studio.log'
    exit 1
fi
echo "  Studio Peer ID: $STUDIO_PEER_ID"

# Step 3: 启动 Mini（Worker）— 关键：清除代理！
echo "[3/4] 启动 Mini 节点（无代理）..."
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  HF_ENDPOINT=https://hf-mirror.com \
  $EXO_BIN \
  --libp2p-port $MINI_LIBP2P_PORT \
  --api-port $MINI_API_PORT \
  --offline \
  --bootstrap-peers "/ip4/$STUDIO_IP/tcp/$STUDIO_LIBP2P_PORT/p2p/$STUDIO_PEER_ID" \
  > /tmp/exo-mini.log 2>&1 &
MINI_PID=$!
echo "  Mini PID: $MINI_PID"

# Step 4: 等待集群组网
echo "[4/4] 等待集群组网..."
for i in $(seq 1 15); do
    sleep 1
    if grep -q "demoting self" /tmp/exo-mini.log 2>/dev/null; then
        echo "  ✅ Mini 降级为 Worker，集群组网成功！"
        echo ""
        echo "=== 集群就绪 ==="
        echo "Master API: http://$STUDIO_IP:$STUDIO_API_PORT"
        echo "Worker API: http://localhost:$MINI_API_PORT"
        echo ""
        echo "测试推理:"
        echo "  curl http://$STUDIO_IP:$STUDIO_API_PORT/v1/chat/completions \\"
        echo "    -H 'Content-Type: application/json' \\"
        echo "    -d '{\"model\": \"$MODEL\", \"messages\": [{\"role\": \"user\", \"content\": \"Hello!\"}]}'"
        exit 0
    fi
done

echo "  ⚠️ 15秒内未完成组网，检查日志:"
echo "  Mini: tail -20 /tmp/exo-mini.log"
echo "  Studio: ssh macstudio 'tail -20 /tmp/exo-studio.log'"
