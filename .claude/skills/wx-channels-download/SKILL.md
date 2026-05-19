---
name: wx-channels-download
description: 下载微信视频号原画视频（PC 微信解密路径）。本地起 MITM 代理 + 自签根 CA，截获 finder.video.qq.com 加密流并解密为 mp4。一次性使用，用完自动清理证书。触发词："/wx-channels-download"、"下载视频号视频"、"下载微信视频号"、"视频号原画下载"、"channels.weixin.qq.com/finder-preview"、"weixin.qq.com/sph"
---

# wx-channels-download — 微信视频号原画下载

基于开源工具 [ltaoo/wx_channels_download](https://github.com/ltaoo/wx_channels_download) 的本机部署。视频号 finder-preview 公开 API 不暴露视频 URL（反爬），PC 微信视频流走 WASM 客户端解密；只能靠本地 MITM 截获并复用工具自带的解密代码。

## 触发条件

- 用户给的链接形如 `https://weixin.qq.com/sph/<id>` 或 `https://channels.weixin.qq.com/finder-preview/pages/sph?id=<id>`
- 用户说"下载视频号视频"、"下载微信视频号"、"视频号原画"
- 触发词：`/wx-channels-download`

## 前置说明（每次启动必复述给用户）

这套流程会：

1. **sudo 运行** 一个本地 MITM 代理（绑 127.0.0.1:2023）
2. **把自签根 CA `SunnyNet` 装到 System 钥匙串并设为 trustRoot**
3. **临时把系统代理切到 127.0.0.1:2023**

证书留着 = 该 CA 持有者能给任意 HTTPS 站点签发假证书，**任务完成必须立刻清理**。本 skill 末尾的 §5 是强制步骤，不能跳。

需要用户配合的人工动作：在 macOS 弹出的密码框里输 1-2 次开机密码（一次给 sudo，一次给 trustRoot 信任设置）。

## 1. 检查 / 准备工具

```bash
# 1.1 Go 是否就位（编译需要）
which go || brew install go

# 1.2 仓库是否已克隆
REPO="$HOME/Downloads/wx-probe/wx_channels_download"
if [ ! -d "$REPO" ]; then
  mkdir -p "$HOME/Downloads/wx-probe"
  git clone --depth=1 https://github.com/ltaoo/wx_channels_download.git "$REPO"
fi

# 1.3 二进制是否已编译
if [ ! -x "$REPO/wx_channels_download" ]; then
  cd "$REPO" && GOFLAGS="-mod=mod" go build -o wx_channels_download main.go
fi
ls -la "$REPO/wx_channels_download"
```

## 2. 装信任根 CA（关键，需要 Terminal.app 前台跑 sudo）

osascript 后台 sudo 无法弹"信任根证书"对话框（缺 WindowServer UI 上下文），必须用 Terminal.app 拉前台。详见 [[feedback_macos_root_ca_dual_auth]]。

```bash
# 2.1 复制 CA 到 /tmp（osascript 起的 Terminal 没有 home 路径方便引用）
cp "$REPO/pkg/certificate/certs/SunnyRoot.cer" /tmp/SunnyRoot.cer

# 2.2 在 Terminal.app 里跑 sudo（用户会输 1-2 次密码）
osascript <<'EOF'
tell application "Terminal"
    activate
    do script "echo '=== 装 SunnyNet 信任根 CA ===' ; echo '会弹两次密码框：1) sudo 提权 2) trustRoot 信任设置，都输开机密码即可' ; sudo security delete-certificate -c SunnyNet /Library/Keychains/System.keychain 2>/dev/null ; sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /tmp/SunnyRoot.cer ; echo '=== 验证信任 ===' ; security verify-cert -c /tmp/SunnyRoot.cer -p basicX509 2>&1 | grep -E 'successful|NOT_TRUSTED'"
end tell
EOF
```

**等用户确认**：Terminal 输出含 `certificate verification successful` 才能继续；含 `CSSMERR_TP_NOT_TRUSTED` 说明信任对话框被取消了，回 §2.2 重试。

## 3. 启动代理服务（也走 Terminal.app 前台 sudo）

```bash
osascript <<EOF
tell application "Terminal"
    activate
    do script "sudo $HOME/Downloads/wx-probe/wx_channels_download/wx_channels_download"
end tell
EOF
```

等待 Terminal 输出包含 `代理服务启动成功, 地址: 127.0.0.1:2023` 和 `已修改系统代理为代理服务地址`。

**用户必做**：完全退出 PC 微信（菜单栏 → 退出 / `⌘Q`，不是关窗口）然后重开。微信只在启动时读系统代理 + 信任设置。

## 4. 引导用户下载

告诉用户：

> 在 PC 微信里打开目标视频号视频 → 开始播放后**暂停** → 视频下方按钮栏会多出一个**下载按钮**（或页面侧边/底部有悬浮按钮，效果一样） → 点下载 → 等下载完成提示出现在播放器上方。默认下载到 `~/Downloads/`，文件名是视频描述，owner 是 root（sudo 跑出来的，但 mode 是 `rw-r--r--`，正常读 / 移动 / 播放都没问题）。

## 5. 用完必清理（强制，不能跳）

确认用户下载完成后，立刻跑：

```bash
# 5.1 写清理脚本
cat > /tmp/wx_cleanup.sh <<'EOF'
#!/bin/bash
set +e
echo "=== 1. 停止 wx_channels_download ==="
pkill -f wx_channels_download
sleep 1
pgrep -f wx_channels_download >/dev/null && pkill -9 -f wx_channels_download
pgrep -f wx_channels_download >/dev/null && echo "  仍在跑" || echo "  已退出"

echo ""
echo "=== 2. 关闭系统代理 ==="
networksetup -setwebproxystate Wi-Fi off
networksetup -setsecurewebproxystate Wi-Fi off

echo ""
echo "=== 3. 卸 SunnyNet 根证书 ==="
security delete-certificate -c SunnyNet /Library/Keychains/System.keychain && echo "  已删除"

echo ""
echo "=== 4. 清 tmp ==="
rm -f /tmp/SunnyRoot.cer /tmp/wx_launch.sh /tmp/wx_cleanup.sh
echo "  done"
EOF
chmod +x /tmp/wx_cleanup.sh

# 5.2 跑清理（弹一次密码框）
osascript -e 'do shell script "/tmp/wx_cleanup.sh 2>&1" with administrator privileges'

# 5.3 二次独立校验
echo ""
echo "=== 校验 ==="
pgrep -f wx_channels_download >/dev/null && echo "进程: STILL RUNNING" || echo "进程: 已退出 ✓"
echo -n "HTTP 代理: "; networksetup -getwebproxy Wi-Fi 2>/dev/null | head -1
echo -n "HTTPS 代理: "; networksetup -getsecurewebproxy Wi-Fi 2>/dev/null | head -1
echo -n "SunnyNet 证书: "; security find-certificate -c SunnyNet /Library/Keychains/System.keychain 2>&1 | head -1
```

校验通过的标志：进程已退出 + HTTP/HTTPS 代理都 `Enabled: No` + SunnyNet 查询返回 `SecKeychainSearchCopyNext: The specified item could not be found`。

## 常见坑（按出现频率排序）

| 现象 | 根因 | 解 |
|------|------|----|
| 启动 binary 时报 `SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible` | 走的 osascript 后台 admin，没 WindowServer | 改走 Terminal.app 前台（§2.2） |
| 重新启动后没弹信任对话框 | 上次失败留下"半装"cert，binary 检测到已存在跳过装→信任流程 | 先 `sudo security delete-certificate -c SunnyNet ...` 删干净再走 |
| Terminal 输出 `代理服务启动成功` 但 PC 微信里没下载按钮 | 微信启动时才读代理 + 证书，需重启微信 | 完全退出 PC 微信再重开 |
| `nohup ... &` 在 osascript 里报 `Inappropriate ioctl for device` | spawned shell 无 TTY | 用 `cmd </dev/null > log 2>&1 & disown` 代替 |
| osascript 内嵌多行 shell 报 exit 144 / `预期是""` | AppleScript + shell 双重转义炸 | 写脚本文件，osascript 只调路径，详见 [[feedback_osascript_shell_quoting]] |
| 下载的 mp4 owner 是 root，能否 chown 回自己 | 下载目录有 macOS 保护属性，chown 失败 `Operation not permitted` | 不必处理，mode `rw-r--r--` 不影响读写移动 |

## 验证基线（2026-05-19 实测）

输入：`https://weixin.qq.com/sph/<id>`（公开视频号视频）
输出：竖版 1080×1920 / H.264 + AAC / ~4 Mbps / 100MB 原画 mp4，落在 `~/Downloads/`

比 finder-preview 公开 API 拿到的 720p 候选高一档质量（且公开 API 根本不给视频 URL，只给 coverUrl）。

## 关联

- [[project_wx_channels_download]] 工具仓库部署细节
- [[feedback_wechat_video_wasm_encrypt]] 为啥缓存扫描必败，必须 MITM
- [[feedback_macos_root_ca_dual_auth]] macOS 装信任根 CA 的双重授权机制
- [[feedback_osascript_shell_quoting]] osascript shell 转义陷阱
