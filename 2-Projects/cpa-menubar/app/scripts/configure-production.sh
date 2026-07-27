#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
REMOTE="${1:-aliyun-jp}"
ssh "$REMOTE" 'cat /etc/cpa-desktop-bridge.token' | swift "$ROOT/scripts/store-token.swift"
defaults write com.hahaxiong.cpa-menubar bridgeEndpoint -string 'https://smart-api.hahaxiong.top/desktop/v1'
defaults write com.hahaxiong.cpa-menubar refreshMinutes -float 5
echo "生产连接已写入本机钥匙串"
