#!/bin/bash
#
# NAS 文件自动导入 Directus（守护进程）
# 每 10 分钟扫描一次，新文件自动导入
#
# 启动：nohup bash directus/auto-import.sh > /tmp/directus-auto-import.log 2>&1 &
# 停止：kill $(cat /tmp/directus-auto-import.pid)
# 日志：tail -f /tmp/directus-auto-import.log

INTERVAL=600  # 10 分钟
DIRECTUS_URL="${DIRECTUS_URL:-http://localhost:8055}"
ADMIN_EMAIL="hahaxiong83@gmail.com"
ADMIN_PASSWORD="admin123"
NAS_DIR="/vol1/1000/文件临时缓存"
MEDIA_EXTS="mp4|jpg|jpeg|png|gif|webp|pdf|mov|avi"
PID_FILE="/tmp/directus-auto-import.pid"

echo $$ > "$PID_FILE"
echo "[$(date '+%Y-%m-%d %H:%M')] 自动导入守护进程启动 (PID: $$, 间隔: ${INTERVAL}s)"

import_folder() {
  local DIR="$1"
  local FOLDER_NAME=$(basename "$DIR")
  local TOKEN="$2"
  local EXISTING="$3"
  local COUNT=0

  # 创建或获取 Directus 文件夹
  local FOLDER_ID=$(curl -s -X POST "$DIRECTUS_URL/folders" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$FOLDER_NAME\"}" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)

  if [ -z "$FOLDER_ID" ]; then
    FOLDER_ID=$(curl -s "$DIRECTUS_URL/folders" \
      -H "Authorization: Bearer $TOKEN" \
      | python3 -c "
import sys,json
for f in json.load(sys.stdin).get('data',[]):
    if f['name'] == '$FOLDER_NAME':
        print(f['id']); break
" 2>/dev/null)
  fi

  find "$DIR" -maxdepth 1 -type f -regextype posix-extended -iregex ".*\.($MEDIA_EXTS)$" 2>/dev/null | while read FILE; do
    local FILENAME=$(basename "$FILE")

    # 跳过已存在
    echo "$EXISTING" | grep -qx "$FILENAME" && continue

    # 上传
    local UPLOAD_ARGS="-F file=@$FILE"
    [ -n "$FOLDER_ID" ] && UPLOAD_ARGS="$UPLOAD_ARGS -F folder=$FOLDER_ID"

    local FILE_ID=$(curl -s -X POST "$DIRECTUS_URL/files" \
      -H "Authorization: Bearer $TOKEN" \
      $UPLOAD_ARGS \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)

    if [ -n "$FILE_ID" ]; then
      echo "[$(date '+%H:%M')] ✓ $FOLDER_NAME/$FILENAME → $FILE_ID"
      COUNT=$((COUNT + 1))
    fi
  done
}

while true; do
  # 检查 Directus 是否可用
  HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$DIRECTUS_URL/server/health" 2>/dev/null)
  if [ "$HEALTH" != "200" ]; then
    echo "[$(date '+%H:%M')] Directus 不可用 ($HEALTH)，跳过"
    sleep $INTERVAL
    continue
  fi

  # 登录
  TOKEN=$(curl -s -X POST "$DIRECTUS_URL/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['access_token'])" 2>/dev/null)

  if [ -z "$TOKEN" ]; then
    echo "[$(date '+%H:%M')] 登录失败，跳过"
    sleep $INTERVAL
    continue
  fi

  # 获取已有文件
  EXISTING=$(curl -s "$DIRECTUS_URL/files?fields=filename_download&limit=-1" \
    -H "Authorization: Bearer $TOKEN" \
    | python3 -c "
import sys,json
for f in json.load(sys.stdin).get('data', []):
    print(f.get('filename_download', ''))
" 2>/dev/null)

  # 扫描所有子文件夹
  NEW_COUNT=0
  for DIR in "$NAS_DIR"/*/; do
    [ -d "$DIR" ] && import_folder "$DIR" "$TOKEN" "$EXISTING"
  done

  sleep $INTERVAL
done
