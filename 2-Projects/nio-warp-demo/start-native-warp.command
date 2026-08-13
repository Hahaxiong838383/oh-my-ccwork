#!/bin/zsh
set -euo pipefail

APP_PATH="$HOME/Applications/NIOWarpApp.app"
if [[ ! -d "$APP_PATH" ]]; then
  osascript -e 'display alert "NIO Warp 未安装" message "请先运行 native/scripts/install-app.sh 安装最新版。" as critical'
  exit 1
fi

exec "$APP_PATH/Contents/MacOS/NIOWarpApp"
