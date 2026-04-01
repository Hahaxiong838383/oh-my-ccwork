#!/bin/bash
# Mac Studio MLX-LM 推理服务器
# 模型: Qwen3.5-27B-4bit (MLX 原生, Metal GPU 加速)
# 用法: ./start-mlx-server.sh [端口] [模型]

PORT="${1:-8000}"
MODEL="${2:-mlx-community/Qwen3.5-27B-4bit}"
STUDIO_IP="192.168.100.2"
PYTHON="/opt/homebrew/bin/python3.11"

echo "=== Mac Studio MLX-LM Server ==="
echo "模型: $MODEL"
echo "端口: $PORT"
echo ""

# 1. 检查是否在 Studio 上运行
if [ "$(hostname)" != *"Studio"* ] && [ "$(whoami)" != "fu-121" ]; then
    echo "通过 SSH 在 Studio 上启动..."
    ssh macstudio "HF_ENDPOINT=https://hf-mirror.com nohup $PYTHON -m mlx_lm.server \
        --model $MODEL \
        --host 0.0.0.0 --port $PORT \
        > /tmp/mlx-server.log 2>&1 &"
    echo "等待模型加载..."
    for i in $(seq 1 30); do
        sleep 5
        if curl -s "http://$STUDIO_IP:$PORT/v1/models" > /dev/null 2>&1; then
            echo ""
            echo "=== ✅ Server 就绪 ==="
            echo "API: http://$STUDIO_IP:$PORT/v1/chat/completions"
            echo ""
            echo "测试: curl http://$STUDIO_IP:$PORT/v1/chat/completions \\"
            echo "  -H 'Content-Type: application/json' \\"
            echo "  -d '{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'"
            exit 0
        fi
        echo "  加载中... ($((i*5))s)"
    done
    echo "⚠️ 150秒内未就绪，查日志: ssh macstudio 'tail -20 /tmp/mlx-server.log'"
    exit 1
fi

# 直接在 Studio 本机运行
echo "本机启动..."
HF_ENDPOINT=https://hf-mirror.com exec $PYTHON -m mlx_lm.server \
    --model "$MODEL" \
    --host 0.0.0.0 --port "$PORT"
