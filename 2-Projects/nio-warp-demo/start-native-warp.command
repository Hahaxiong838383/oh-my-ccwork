#!/bin/zsh
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$PROJECT_DIR"
APP_PATH="$PROJECT_DIR/native/dist/NIOWarpApp.app"
if [[ ! -d "$APP_PATH" ]]; then
  "$PROJECT_DIR/native/scripts/build-app.sh"
fi

exec "$APP_PATH/Contents/MacOS/NIOWarpApp"
