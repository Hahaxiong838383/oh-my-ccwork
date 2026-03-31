#!/bin/bash
# llama.cpp RPC 双节点集群启动脚本
# Mini (M4 32GB) → llama-server (主节点)
# Studio (M2 Max 32GB) → rpc-server (远程 GPU)
#
# 用法: ./start-rpc-cluster.sh [模型路径]
# 默认: /tmp/Qwen2.5-7B-Instruct-Q4_K_M.gguf

set -e

MODEL="${1:-/tmp/Qwen2.5-7B-Instruct-Q4_K_M.gguf}"
STUDIO_IP="192.168.100.2"
RPC_PORT=50052
API_PORT=8080
LLAMA_DIR="$HOME/llama-cpp/llama-b8589"

echo "=== llama.cpp RPC 双节点集群 ==="
echo "模型: $MODEL"
echo ""

# 检查模型文件
if [ ! -f "$MODEL" ]; then
    echo "ERROR: 模型文件不存在: $MODEL"
    exit 1
fi

# Step 1: 清理残留
echo "[1/4] 清理残留进程..."
kill $(pgrep -f "llama-server.*$API_PORT") 2>/dev/null || true
ssh macstudio "killall rpc-server" 2>/dev/null || true
sleep 2

# Step 2: Studio RPC（关键：--device MTL0 避免 BLAS bug）
echo "[2/4] 启动 Studio RPC (Metal only)..."
ssh macstudio "nohup $LLAMA_DIR/rpc-server --host 0.0.0.0 --port $RPC_PORT --device MTL0 > /tmp/rpc-server.log 2>&1 & disown"
echo "  等待 15 秒 Metal shader 编译..."
sleep 15

# Step 3: Mini llama-server（清除代理）
echo "[3/4] 启动 Mini llama-server..."
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  $LLAMA_DIR/llama-server \
  --model "$MODEL" \
  --host 0.0.0.0 \
  --port $API_PORT \
  --rpc $STUDIO_IP:$RPC_PORT \
  --n-gpu-layers 99 \
  --ctx-size 4096 \
  > /tmp/llama-server.log 2>&1 &
MINI_PID=$!
echo "  PID: $MINI_PID"

# Step 4: 等待就绪
echo "[4/4] 等待模型加载..."
for i in $(seq 1 30); do
    sleep 2
    if grep -q "server is listening" /tmp/llama-server.log 2>/dev/null; then
        echo ""
        echo "=== ✅ 集群就绪 ==="
        echo ""
        # 显示设备信息
        grep "using device" /tmp/llama-server.log 2>/dev/null | sed 's/.*using device/  ✓/' || true
        echo ""
        echo "API: http://localhost:$API_PORT"
        echo "测试: curl http://localhost:$API_PORT/v1/chat/completions -H 'Content-Type: application/json' -d '{\"model\":\"test\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello!\"}]}'"
        exit 0
    fi
    if grep -q "Failed to connect\|ggml_abort\|error" /tmp/llama-server.log 2>/dev/null; then
        echo ""
        echo "=== ❌ 启动失败 ==="
        grep -a "Failed\|error\|abort" /tmp/llama-server.log | head -5
        echo "详细日志: cat /tmp/llama-server.log"
        exit 1
    fi
done

echo "⚠️ 60 秒内未就绪，检查日志:"
echo "  Mini: tail -20 /tmp/llama-server.log"
echo "  Studio: ssh macstudio 'tail -20 /tmp/rpc-server.log'"
