# xray - Xray 代理管理

> 管理 Xray 代理服务：启动/停止/切换/状态检查/从 v2rayN 迁移。触发词："/xray"、"切换到 xray"、"关掉 v2ray"、"代理状态"、"网络不通"

## 触发条件

- 用户说"切换代理"、"关 v2ray"、"启动 xray"、"代理不通"、"网络不行"
- 需要检查或修复代理配置时

## 可用命令

### /xray switch — 从 v2rayN 切换到 xray（最常用）

关闭 v2rayN 后一键切换。等同于 `bash ~/xray/switch-to-xray.sh`。

执行流程：
```bash
bash ~/xray/switch-to-xray.sh
```

脚本自动完成：
1. 杀掉所有残留 xray 进程（包括 v2rayN 的）
2. 通过 launchctl 启动 xray
3. 启动 xray-manager Web UI (localhost:8888)
4. 设置系统代理（SOCKS + HTTP + HTTPS → 10808）
5. 验证 Anthropic / Gemini 连通性

### /xray status — 检查代理状态

```bash
echo "=== xray 进程 ==="
ps aux | grep '[x]ray/xray' | grep -v Claude

echo "=== 系统代理 ==="
networksetup -getsocksfirewallproxy Wi-Fi | grep -E "Enabled|Port"
networksetup -getwebproxy Wi-Fi | grep -E "Enabled|Port"
networksetup -getsecurewebproxy Wi-Fi | grep -E "Enabled|Port"

echo "=== Web UI ==="
curl -s http://127.0.0.1:8888/api/sysproxy --connect-timeout 2

echo "=== 连通性 ==="
for domain in api.anthropic.com gemini.google.com www.youtube.com; do
    code=$(curl --socks5 127.0.0.1:10808 "https://$domain" -o /dev/null -w "%{http_code}" -s --connect-timeout 5)
    echo "$domain -> $code"
done
```

### /xray restart — 重启 xray

```bash
launchctl unload ~/Library/LaunchAgents/com.xray.proxy.plist 2>/dev/null
sleep 1
launchctl load ~/Library/LaunchAgents/com.xray.proxy.plist
sleep 2
echo "xray 已重启"
```

**绝对不要用 `kill` 或 `killall xray`**，launchd 的 KeepAlive 会导致多进程抢端口。

### /xray proxy on|off — 开关系统代理

```bash
# 开启
networksetup -setsocksfirewallproxy Wi-Fi 127.0.0.1 10808
networksetup -setsocksfirewallproxystate Wi-Fi on
networksetup -setwebproxy Wi-Fi 127.0.0.1 10808
networksetup -setwebproxystate Wi-Fi on
networksetup -setsecurewebproxy Wi-Fi 127.0.0.1 10808
networksetup -setsecurewebproxystate Wi-Fi on

# 关闭
networksetup -setsocksfirewallproxystate Wi-Fi off
networksetup -setwebproxystate Wi-Fi off
networksetup -setsecurewebproxystate Wi-Fi off
```

必须同时设三个（SOCKS + HTTP + HTTPS），否则部分应用不走代理。

### /xray log — 查看日志

```bash
strings ~/xray/xray.log | tail -30
```

排查路由问题时临时开 info 日志：
```bash
# 修改 config.json 的 log.loglevel 为 "info"，然后 launchctl 重启
# 排查完改回 "warning"
```

## 路由规则速查

| 分组 | 策略 | 节点池 |
|------|------|--------|
| Claude/GPT | 固定 | 美宅专用 US (VLESS+Reality) |
| Gemini/AI Studio | leastPing | US-V1, US-R1, US-R2 |
| YouTube/视频娱乐 | leastLoad | HK×5, TW×2, SG×2, JP×5 |
| 大陆域名 | direct | 直连 |
| 其他 | 默认 | HK-HKT-A |

## 排查清单

当"网络不通"时按顺序检查：

1. **xray 进程在跑吗？** → `ps aux | grep xray`
2. **系统代理开了吗？** → 三个都要检查（SOCKS/HTTP/HTTPS）
3. **端口对吗？** → 必须是 10808
4. **Chrome 有代理扩展吗？** → 用 Safari 对比验证
5. **v2rayN 残留进程？** → 多个 xray 抢端口会异常
6. **终端环境变量？** → `echo $ALL_PROXY` 应为 `socks5://127.0.0.1:10808`

## 重要注意事项

- **Claude 必须走美宅节点**，不要尝试其他节点
- **curl 测 claude.ai 返回 403 是正常的**（Cloudflare challenge），用浏览器验证
- **balancer 必须用 burstObservatory**，不能用 observatory（会导致规则被跳过）
- **代理重启会中断所有 API 调用** 1-2 秒，修改前检查有无执行中的任务

## 相关文件

| 文件 | 说明 |
|------|------|
| `~/xray/config.json` | 路由规则配置 |
| `~/xray/xray-manager.py` | Web UI + API |
| `~/xray/switch-to-xray.sh` | 一键切换脚本 |
| `~/xray/xray.log` | 运行日志 |
| `~/Library/LaunchAgents/com.xray.proxy.plist` | launchd 服务 |
| `~/.zshrc` | 终端代理环境变量 |
