#!/bin/bash
# EvoMap Heartbeat - 每15分钟发送心跳保持节点在线
# 根据 EvoMap 协议，节点需要在45分钟内发送心跳才能保持在线

ASSETS_DIR="/Users/rayman.chen/mycc/.claude/skills/evomap-assets"
LOG_FILE="$ASSETS_DIR/heartbeat.log"

# 读取保存的 node_id
NODE_ID_FILE="$ASSETS_DIR/.node_id"
if [ ! -f "$NODE_ID_FILE" ]; then
    # 如果没有保存的 node_id，先发送 hello 获取
    echo "$(date): 首次注册节点..." >> "$LOG_FILE"
    HELLO_RESPONSE=$(curl -s -X POST https://evomap.ai/a2a/hello \
        -H "Content-Type: application/json" \
        -d '{
            "protocol": "gep-a2a",
            "protocol_version": "1.0.0",
            "message_type": "hello",
            "message_id": "msg_'"$(date +%s)"'_heartbeat",
            "sender_id": "node_cc_'"$(openssl rand -hex 4)"'",
            "timestamp": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
            "payload": {
                "capabilities": {},
                "gene_count": 0,
                "capsule_count": 0,
                "env_fingerprint": {
                    "platform": "darwin",
                    "arch": "arm64",
                    "node_version": "'"$(node -v)"'"
                }
            }
        }')

    echo "$HELLO_RESPONSE" >> "$LOG_FILE"

    # 提取 node_id
    NODE_ID=$(echo "$HELLO_RESPONSE" | grep -o '"your_node_id":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$NODE_ID" ]; then
        echo "$NODE_ID" > "$NODE_ID_FILE"
        echo "$(date): 节点注册成功，node_id: $NODE_ID" >> "$LOG_FILE"
    else
        echo "$(date): 节点注册失败" >> "$LOG_FILE"
        exit 1
    fi
fi

NODE_ID=$(cat "$NODE_ID_FILE")

# 读取 node_secret（每次 hello 后更新）
NODE_SECRET_FILE="$ASSETS_DIR/.node_secret"
AUTH_HEADER=""
if [ -f "$NODE_SECRET_FILE" ]; then
    NODE_SECRET=$(cat "$NODE_SECRET_FILE")
    AUTH_HEADER="-H \"Authorization: Bearer $NODE_SECRET\""
fi

# 发送心跳
echo "$(date): 发送心跳，node_id: $NODE_ID" >> "$LOG_FILE"

HEARTBEAT_RESPONSE=$(curl -s -X POST https://evomap.ai/a2a/heartbeat \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${NODE_SECRET:-}" \
    -d "{
        \"node_id\": \"$NODE_ID\",
        \"worker_enabled\": true,
        \"worker_domains\": [\"javascript\", \"typescript\", \"python\"],
        \"max_load\": 3
    }")

echo "$HEARTBEAT_RESPONSE" >> "$LOG_FILE"

# 检查响应
if echo "$HEARTBEAT_RESPONSE" | grep -q '"status":"ok"'; then
    CREDIT_BALANCE=$(echo "$HEARTBEAT_RESPONSE" | grep -o '"credit_balance":[0-9]*' | cut -d':' -f2)
    echo "$(date): 心跳成功，余额: $CREDIT_BALANCE" >> "$LOG_FILE"
else
    echo "$(date): 心跳可能失败，响应: $HEARTBEAT_RESPONSE" >> "$LOG_FILE"
fi
