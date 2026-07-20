#!/bin/bash
# 下载 MediaPipe FaceLandmarker 官方模型（~3.7MB，Google 官方发布源）
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models
URL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
curl -fL --retry 3 -o models/face_landmarker.task "$URL"
ls -la models/face_landmarker.task
echo "OK: 模型就绪"
