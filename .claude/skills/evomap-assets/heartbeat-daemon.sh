#!/bin/bash
# EvoMap Heartbeat Daemon - 每15分钟循环发送心跳保持节点在线

ASSETS_DIR="/Users/rayman.chen/mycc/.claude/skills/evomap-assets"
LOG_FILE="$ASSETS_DIR/heartbeat.log"
PID_FILE="$ASSETS_DIR/heartbeat.pid"

# 检查是否已经在运行
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "$(date): 心跳守护进程已在运行，PID: $OLD_PID" >> "$LOG_FILE"
        exit 0
    fi
fi

# 保存当前 PID
echo $$ > "$PID_FILE"
echo "$(date): 启动心跳守护进程，PID: $$" >> "$LOG_FILE"

# 无限循环，每15分钟发送一次心跳
while true; do
    NODE_ID_FILE="$ASSETS_DIR/.node_id"

    if [ ! -f "$NODE_ID_FILE" ]; then
        echo "$(date): 首次注册节点..." >> "$LOG_FILE"

        RANDOM_HEX="$(date +%s)$RANDOM"

        HELLO_RESPONSE=$(curl -s -X POST https://evomap.ai/a2a/hello \
            -H "Content-Type: application/json" \
            -d "{
                \"protocol\": \"gep-a2a\",
                \"protocol_version\": \"1.0.0\",
                \"message_type\": \"hello\",
                \"message_id\": \"msg_${RANDOM_HEX}\",
                \"sender_id\": \"node_cc_${RANDOM_HEX}\",
                \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
                \"payload\": {
                    \"capabilities\": {},
                    \"gene_count\": 0,
                    \"capsule_count\": 0,
                    \"env_fingerprint\": {
                        \"platform\": \"darwin\",
                        \"arch\": \"arm64\"
                    }
                }
            }")

        echo "$HELLO_RESPONSE" >> "$LOG_FILE"

        NODE_ID=$(echo "$HELLO_RESPONSE" | grep -o '"your_node_id":"[^"]*"' | cut -d'"' -f4)
        if [ -n "$NODE_ID" ]; then
            echo "$NODE_ID" > "$NODE_ID_FILE"
            echo "$(date): 节点注册成功，node_id: $NODE_ID" >> "$LOG_FILE"
        else
            echo "$(date): 节点注册失败" >> "$LOG_FILE"
            sleep 60
            continue
        fi
    fi

    NODE_ID=$(cat "$NODE_ID_FILE")

    echo "$(date): 发送心跳，node_id: $NODE_ID" >> "$LOG_FILE"

    HEARTBEAT_RESPONSE=$(curl -s -X POST https://evomap.ai/a2a/heartbeat \
        -H "Content-Type: application/json" \
        -d "{\"node_id\": \"$NODE_ID\", \"worker_enabled\": true, \"worker_domains\": [\"javascript\", \"typescript\", \"python\"], \"max_load\": 3}")

    echo "$HEARTBEAT_RESPONSE" >> "$LOG_FILE"

    if echo "$HEARTBEAT_RESPONSE" | grep -q '"status":"ok"'; then
        CREDIT_BALANCE=$(echo "$HEARTBEAT_RESPONSE" | grep -o '"credit_balance":[0-9]*' | cut -d':' -f2)
        echo "$(date): 心跳成功，余额: $CREDIT_BALANCE" >> "$LOG_FILE"
    else
        echo "$(date): 心跳可能失败" >> "$LOG_FILE"
    fi

    sleep 900
done
