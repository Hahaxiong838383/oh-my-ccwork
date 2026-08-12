#!/bin/zsh
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if ! command -v uv >/dev/null 2>&1; then
  echo "未找到 uv，无法启动 Demo。"
  echo "请确认 ~/.local/bin 已加入 PATH。"
  read -r "?按回车关闭窗口..."
  exit 1
fi

echo "正在启动 NIO 外接屏畸变校正 Demo..."
uv sync --python 3.12
exec uv run nio-warp-display-demo
