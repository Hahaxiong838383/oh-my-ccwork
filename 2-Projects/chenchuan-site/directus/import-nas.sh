#!/bin/bash
#
# NAS 文件导入到 Directus 文件库
#
# 用法：
#   bash directus/import-nas.sh                          # 导入全部 NAS 文件夹
#   bash directus/import-nas.sh "mimic机器人"             # 导入指定文件夹
#   bash directus/import-nas.sh "眼动+手势 多模态识别交互"  # 导入指定文件夹
#
# 原理：
#   1. 扫描 NAS 挂载目录（/vol1/1000/文件临时缓存/）中的媒体文件
#   2. 复制到 Directus uploads 目录
#   3. 通过 API 注册到 Directus 文件库
#   4. 在 Directus 后台即可看到并管理
#
# 支持的文件类型：mp4 jpg jpeg png gif webp pdf

set -e

DIRECTUS_URL="${DIRECTUS_URL:-http://localhost:8055}"
ADMIN_EMAIL="${ADMIN_EMAIL:-hahaxiong83@gmail.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"
NAS_DIR="/vol1/1000/文件临时缓存"
UPLOADS_DIR="$(cd "$(dirname "$0")" && pwd)/uploads"

# 文件类型
MEDIA_EXTS="mp4|jpg|jpeg|png|gif|webp|pdf|mov|avi"

# 登录
echo "=== NAS → Directus 文件导入 ==="
TOKEN=$(curl -s -X POST "$DIRECTUS_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['access_token'])" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "✗ 登录失败"
  exit 1
fi
echo "✓ 登录成功"

# 获取已有文件名，避免重复导入
EXISTING=$(curl -s "$DIRECTUS_URL/files?fields=filename_download&limit=-1" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c "
import sys,json
data = json.load(sys.stdin).get('data', [])
for f in data:
    print(f.get('filename_download', ''))
" 2>/dev/null)

# 确定要扫描的目录
if [ -n "$1" ]; then
  SCAN_DIRS=("$NAS_DIR/$1")
  echo "→ 扫描: $1"
else
  SCAN_DIRS=()
  for d in "$NAS_DIR"/*/; do
    [ -d "$d" ] && SCAN_DIRS+=("$d")
  done
  echo "→ 扫描全部文件夹 (${#SCAN_DIRS[@]} 个)"
fi

IMPORTED=0
SKIPPED=0

for DIR in "${SCAN_DIRS[@]}"; do
  FOLDER_NAME=$(basename "$DIR")
  echo ""
  echo "── $FOLDER_NAME ──"

  # 在 Directus 创建对应文件夹
  FOLDER_ID=$(curl -s -X POST "$DIRECTUS_URL/folders" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$FOLDER_NAME\"}" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)

  # 如果文件夹已存在，查找它的 ID
  if [ -z "$FOLDER_ID" ]; then
    FOLDER_ID=$(curl -s "$DIRECTUS_URL/folders?filter[name][_eq]=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$FOLDER_NAME'))")" \
      -H "Authorization: Bearer $TOKEN" \
      | python3 -c "import sys,json; d=json.load(sys.stdin).get('data',[]); print(d[0]['id'] if d else '')" 2>/dev/null)
  fi

  [ -n "$FOLDER_ID" ] && echo "  文件夹 ID: $FOLDER_ID"

  # 扫描媒体文件
  find "$DIR" -maxdepth 1 -type f -regextype posix-extended -iregex ".*\.($MEDIA_EXTS)$" 2>/dev/null | while read FILE; do
    FILENAME=$(basename "$FILE")

    # 检查是否已导入
    if echo "$EXISTING" | grep -qx "$FILENAME"; then
      echo "  跳过 (已存在): $FILENAME"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    echo -n "  导入: $FILENAME ... "

    # 通过 API 上传文件
    UPLOAD_ARGS="-F file=@$FILE"
    [ -n "$FOLDER_ID" ] && UPLOAD_ARGS="$UPLOAD_ARGS -F folder=$FOLDER_ID"

    RESULT=$(curl -s -X POST "$DIRECTUS_URL/files" \
      -H "Authorization: Bearer $TOKEN" \
      $UPLOAD_ARGS)

    FILE_ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)

    if [ -n "$FILE_ID" ]; then
      echo "✓ $FILE_ID"
      IMPORTED=$((IMPORTED + 1))
    else
      echo "✗"
    fi
  done
done

echo ""
echo "=== 完成 ==="
echo "导入: $IMPORTED 个文件"
echo "Directus 后台: $DIRECTUS_URL → 文件库 查看"
