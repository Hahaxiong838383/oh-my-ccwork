#!/bin/bash
# 从 Mini 测试 Studio 上的 LLM 推理
# 支持 mlx-lm 和 Ollama 两种后端

STUDIO_TB="192.168.100.2"    # 雷电直连
STUDIO_WIFI="10.9.1.155"     # WiFi 备用
MLX_PORT=8000
OLLAMA_PORT=11434

# 清除代理
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY

echo "=== Studio LLM 推理测试 ==="
echo ""

# 选择连接路径
if ping -c 1 -W 1 $STUDIO_TB > /dev/null 2>&1; then
    STUDIO=$STUDIO_TB
    echo "连接: 雷电直连 ($STUDIO_TB)"
else
    STUDIO=$STUDIO_WIFI
    echo "连接: WiFi ($STUDIO_WIFI)"
fi

# 测试 mlx-lm
echo ""
echo "--- mlx-lm.server (port $MLX_PORT) ---"
if curl -s "http://$STUDIO:$MLX_PORT/v1/models" > /dev/null 2>&1; then
    echo "状态: ✅ 在线"
    echo "发送测试请求..."
    START=$(date +%s%3N)
    RESULT=$(curl -s --max-time 120 "http://$STUDIO:$MLX_PORT/v1/chat/completions" \
        -H "Content-Type: application/json" \
        -d '{
            "model": "mlx-community/Qwen3.5-27B-4bit",
            "messages": [{"role": "user", "content": "用三句话介绍分布式计算的优势。"}],
            "max_tokens": 200
        }')
    END=$(date +%s%3N)
    ELAPSED=$(( (END - START) ))

    echo "$RESULT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if 'error' in data:
        print(f'错误: {data[\"error\"]}')
    else:
        msg = data['choices'][0]['message']['content']
        usage = data.get('usage', {})
        prompt_t = usage.get('prompt_tokens', '?')
        comp_t = usage.get('completion_tokens', '?')
        print(f'回答: {msg[:200]}')
        print(f'tokens: prompt={prompt_t}, completion={comp_t}')
except Exception as e:
    print(f'解析失败: {e}')
" 2>&1
    echo "耗时: ${ELAPSED}ms"
else
    echo "状态: ❌ 离线"
fi

# 测试 Ollama
echo ""
echo "--- Ollama (port $OLLAMA_PORT) ---"
if curl -s "http://$STUDIO:$OLLAMA_PORT/api/version" > /dev/null 2>&1; then
    echo "状态: ✅ 在线 ($(curl -s http://$STUDIO:$OLLAMA_PORT/api/version | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version","?"))' 2>/dev/null))"
    MODELS=$(curl -s "http://$STUDIO:$OLLAMA_PORT/api/tags" | python3 -c "
import json,sys
data = json.load(sys.stdin)
for m in data.get('models',[]):
    print(f'  {m[\"name\"]} ({m.get(\"size\",0)//1024//1024//1024}GB)')
" 2>/dev/null)
    if [ -n "$MODELS" ]; then
        echo "模型: $MODELS"
    else
        echo "模型: 无（待下载）"
    fi
else
    echo "状态: ❌ 离线"
fi

echo ""
echo "=== 完成 ==="
