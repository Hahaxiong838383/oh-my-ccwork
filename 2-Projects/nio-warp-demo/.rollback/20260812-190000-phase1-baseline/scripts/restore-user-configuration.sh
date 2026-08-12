#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLLBACK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_JSON="$ROLLBACK_DIR/user-defaults-warp-configuration.json"
DOMAIN="com.mycc.nio-warp-demo"
KEY="nioWarpConfiguration.v1"
MODE="${1:---dry-run}"

if [[ "$MODE" != "--dry-run" && "$MODE" != "--apply" ]]; then
  echo "用法：$0 [--dry-run|--apply]" >&2
  exit 2
fi

if ! /usr/bin/swift -e 'import Foundation
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let data = try Data(contentsOf: url)
let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
guard let object,
      object["aaRect"] != nil,
      object["canvas"] != nil,
      object["displayPixelWidth"] != nil,
      object["displayPixelHeight"] != nil else { exit(3) }
' "$CONFIG_JSON"; then
  echo "配置 JSON 结构无效，已停止。" >&2
  exit 3
fi

CONFIG_HEX="$(xxd -p "$CONFIG_JSON" | tr -d '\n')"
RESTORED_SHA="$(printf '%s' "$CONFIG_HEX" | xxd -r -p | shasum -a 256 | awk '{print $1}')"
SOURCE_SHA="$(shasum -a 256 "$CONFIG_JSON" | awk '{print $1}')"
if [[ "$RESTORED_SHA" != "$SOURCE_SHA" ]]; then
  echo "恢复数据校验失败，已停止。" >&2
  exit 4
fi

if [[ "$MODE" == "--dry-run" ]]; then
  echo "恢复演练通过：JSON、plist 数据和 SHA-256 一致；当前配置未被修改。"
  exit 0
fi

if pgrep -x NIOWarpApp >/dev/null 2>&1; then
  echo "NIOWarpApp 正在运行。请先退出应用，再执行恢复。" >&2
  exit 5
fi

BACKUP="$ROLLBACK_DIR/pre-restore-user-defaults-$(date +%Y%m%d-%H%M%S).plist"
defaults export "$DOMAIN" "$BACKUP" >/dev/null 2>&1 || true
defaults write "$DOMAIN" "$KEY" -data "$CONFIG_HEX"
killall cfprefsd >/dev/null 2>&1 || true
echo "配置已恢复；恢复前 defaults 已备份到：$BACKUP"
