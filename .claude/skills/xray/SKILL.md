# xray - Xray 代理管理

> 管理 Xray 代理引擎：启动/停止/切换/状态检查/分流测试。触发词："/xray"、"代理状态"、"网络不通"

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
| **Gemini/AI Studio** | 固定 | Gemini专用-US2 (VLESS+Reality) |
| YouTube/视频娱乐 | leastPing | HK×5, TW×2, SG×2, JP×5 |
| 大陆域名 | direct | 直连 |
| 其他 | 默认 | HK-HKT-A |

### Google Cloud Code Assist 路由（antigravity / gemini-cli，2026-06-19 实测加固）

team 的 gemini lane（omp `google-antigravity/*`）和 antigravity 调用走 **`cloudcode-pa.googleapis.com`** 系列（不是 `generativelanguage`）。这条通道对出口 IP 风控极严：

- **症状**：`Cloud Code Assist API error (400): User location is not supported`。普通美宅/机房节点会被判 400（≠ 限流，≠ token 问题）。
- **根因坑**：`domain:googleapis.com` 这类**宽匹配规则会先截走**所有 `*.googleapis.com` 子域，把 cloudcode-pa 导到通用美宅节点 → 400。
- **修复**：在 `~/xray/config.json` 的 `routing.rules` **最前面**（抢在 `domain:googleapis.com` 之前）加精确规则，3 个域名 → `Gemini专用-US2-VLESS-Reality-IP`：
  ```
  domain:cloudcode-pa.googleapis.com
  domain:daily-cloudcode-pa.googleapis.com
  domain:daily-cloudcode-pa.sandbox.googleapis.com
  ```
- **改后**：`~/xray/xray run -test -c config.json` 验 `Configuration OK` → `launchctl kickstart -k gui/$(id -u)/com.xray.proxy`（原子重启）。
- **验证走对节点**：`grep cloudcode ~/xray/access.log | tail` 看 `[socks -> Gemini专用-US2-...]`（不是美宅）。
- 详见 memory `project_antigravity_team_b3`。

### GitHub / HuggingFace / 包管理器下载节点优化（2026-06-24）

rule[5] 是「开发者下载」大组（github + githubusercontent + codeload + PyPI + crates + conda + **huggingface.co + cdn-lfs**）。原走 `美宅-Claud-GPT专用US` 单住宅节点 → **git clone/push、HF 大文件下载反复 `SSL_ERROR_SYSCALL` / curl `exit 35` / `000`**（住宅节点带宽小 + 无冗余，还挤占 Claude 命脉节点）。

**连锁病根（最关键）**：observatory + burstObservatory 探测 URL 是 `google.com/generate_204`（**被墙**）→ 所有节点探测超时被判 dead → **所有 leastPing/leastLoad balancer 失效、全 fallback 美宅**。balancer 形同虚设（这也是 media/asia-fast balancer 一直只走美宅的原因）。

**修复**：
1. 探测 URL `google.com` → `http://cp.cloudflare.com/generate_204`（节点真能到，恢复活性判断）。改 `observatory.probeURL` + `burstObservatory.pingConfig.destination`。
2. rule[5] outboundTag 美宅 → **JP-Linode-V1**（rule[17] 默认出站 = 日常验证可用机房；**不赌脆弱的 balancer 探测，直接钉死可用节点**）。
3. `~/xray/xray run -test -c config.json` → `launchctl kickstart -k gui/$(id -u)/com.xray.proxy`。
4. 验证三件套：`git ls-remote https://github.com/<x> HEAD`（之前 SSL EOF→现返回 hash）+ `grep github ~/xray/access.log`（→ JP-Linode-V1）+ HF resolve `307→200`。

**坑**：① balancer 探测 URL 必须选节点真能到的（cloudflare 非 google），否则全 fallback。② **节点别假设可用**：US-V1 实测死（cloudflare 探测也超时），用默认节点最稳。③ 单次 curl `exit 35` 可能瞬时抖动，多测几次。④ 改 config 先 `cp` 备份（本次 `config.json.bak-github-opt-20260624`），`xray -test` 过了再 kickstart；排查完 loglevel 记得改回 `warning`。

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

## 多机部署（2026-05-27 加）

**当前 xray 已在两台 Mac 部署**：

| 机器 | binary | config 来源 | 用途 |
|------|--------|------------|------|
| Air M5 | v25.10.15 darwin/amd64 (Rosetta) | 主配 (V1.6) | 川哥日常 AI CLI 走代理 |
| Mini M4 | **v26.3.23 darwin/arm64 (原生)** | rsync from Air | multica daemon + AI CLI runtime 走代理 |

**Mini 部署经验**：
- 推 config + scripts + geo dat（不推 binary, Mini 原生 arm64 v26.x 更新更原生）
- 推 3 launchd plist (proxy/manager/rule-updater), 不推 proxy-setup (Mini 无需 macOS 系统代理设置)
- 路由规则一致: GPT/Claude → 美宅-US-A, Gemini → Gemini 专用-US2-VLESS-Reality-IP
- Web UI: http://10.9.1.54:8888 (Mini) 同 http://127.0.0.1:8888 (Air)

**多机扩展 rsync 命令模板**:
```bash
rsync -avz --delete \
    --exclude='xray' --exclude='xray-*.bak' \
    --exclude='*.log*' --exclude='config.json.bak*' \
    --exclude='backups/' \
    ~/xray/ TARGET:~/xray/

# scp 3 plists (不含 proxy-setup, 服务器机器无需)
for p in com.xray.proxy com.xray.manager com.xray.rule-updater; do
    scp ~/Library/LaunchAgents/$p.plist TARGET:~/Library/LaunchAgents/$p.plist
done

# 远程 bootstrap
ssh TARGET 'for p in com.xray.proxy com.xray.manager com.xray.rule-updater; do
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$p.plist
done'
```

**关联**: [project_multica_team_deploy.md](memory/project_multica_team_deploy.md) 14:30-14:40 段落

