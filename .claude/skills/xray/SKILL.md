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
| Claude/GPT | 固定 | **美宅-Claude-GPT_mychenchuan** (VLESS+Reality, 直连 154.44.3.170:8444) |
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

### 节点连得上但目标站 403/连不上 → 查出口IP信誉（非配置问题）

现象：某节点能连（reality 握手成功），但 ChatGPT/Claude 等站 **403 或 000**，google 却 200。
- **403 ≠ 000**：reality 握手成功时目标站返 403（流量出去被目标拦）；握手失败才 000/exit35。有 403 说明节点本身通，问题在**出口IP信誉**。
- **查真实出口IP**：`curl -x http://127.0.0.1:10808 https://ifconfig.me` → 再 `curl https://ipinfo.io/<IP>/json` 看归属。**ColoCrossing 等机房IP 会被 OpenAI/Cloudflare 403**（google 不严所以 200）。
- **同一中转入口不同端口落到不同出口机**：住宅IP中转常在一个入口IP开多端口，每端口NAT到不同落地。「v2rayN 正常、xray 不通」且其他参数全同时，**重点核对端口**。让用户导出 v2rayN 的 `vless://` 链接逐字段比对，差异常藏在端口。改 reality 节点要**按分享链接完整重建 outbound**，别在旧配置改单字段（残留临时字段会干扰）。
- 详见 memory `feedback_xray_port_routes_different_landing`。

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
- 路由规则一致: GPT/Claude → **美宅-Claude-GPT_mychenchuan** (154.44.3.170:8444 直连, 2026-06-25 从旧节点 美宅-Claud-GPT专用US 迁移), Gemini → Gemini 专用-US2-VLESS-Reality-IP
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

---

## REALITY 服务端运维（换伪装域名 / 加节点）—— VPS 侧，2026-06-25

> ⚠️ 上面全是**客户端**（本机走代理）。这一节是**服务端**：在 VPS 上管 Xray REALITY inbound。配置通常 `/usr/local/etc/xray/config.json`，systemd 服务 `xray.service`（**服务端用 `systemctl restart xray`，不是 launchd**）。

### 换伪装域名（dest / serverNames）零风险 SOP

REALITY 的 `serverNames`/`dest` **不是「随便填的伪装名」**：它去「借」一个真实站的 TLS 握手，非法探测来访时把流量回落转发到 `dest`。填错=代理握手失败用不了；**绝不直接改生产口断现网**。

**① dest 选站三硬条件**（填前 openssl 实测，别猜）：
```bash
D=<候选域名>
echo | openssl s_client -connect $D:443 -servername $D -tls1_3 2>/dev/null | grep "Verify return code"  # 要 0 (ok)
echo | openssl s_client -connect $D:443 -servername $D -alpn h2  2>/dev/null | grep -i ALPN              # 要 h2
# 且 dest 不能解析到 VPS 自己（防回环）。自己的 CF 后端站默认达标（CF 给 TLS1.3+H2+X25519）。
```

**② 加测试端口验证（不碰生产口）**：
```bash
CFG=/usr/local/etc/xray/config.json
cp "$CFG" "$CFG.bak.$(date +%s)"
# python3 deepcopy 生产 inbound → 只改 port + realitySettings.dest + serverNames，复用同 keypair/UUID/shortId
xray -test -config "$CFG" | grep "Configuration OK" && systemctl restart xray
ss -tlnp | grep -E ":<生产口>|:<测试口>"   # 新老端口都要在听
```

**③ 伪装层验证**（合法探测会回落到 dest）：
```bash
echo | openssl s_client -connect 127.0.0.1:<测试口> -servername <新域名> 2>/dev/null | openssl x509 -noout -subject
# subject == <新域名> 的证书 = 伪装生效；对比老口 -servername <老域名> 看老证书
```

**④ 出网闭环（终极）**：VPS 本地起临时客户端（socks → REALITY 测试口，SNI=新域名）：
```bash
# 推 publicKey： xray x25519 -i <privateKey>   ← 26.x 输出里标 "Password:" 那行就是 publicKey！
# /tmp/xc.json: socks inbound(10808) + vless outbound(127.0.0.1:<测试口>, reality serverName=<新域名>, 复用 UUID/pbk/sid/flow)
nohup xray run -c /tmp/xc.json >/tmp/xc.log 2>&1 & CPID=$!; sleep 3
curl -s --max-time 15 --socks5-hostname 127.0.0.1:10808 https://ifconfig.me; echo " exit=$?"
grep tunneling /tmp/xc.log     # exit 0 + 日志 "tunneling request ... via 127.0.0.1:<测试口>" = 全链路通
kill $CPID; rm -f /tmp/xc.json /tmp/xc.log
```

### 坑（实测）
- **`xray x25519 -i <priv>` 在 26.x 把 publicKey 标成 `Password:`**（不是 `Public key`），另有 `Hash32`（客户端不用）。别认错字段。
- **keypair 与 dest/serverName 正交**：换伪装域名**不用换密钥**，客户端只改 SNI(serverName)，publicKey/UUID/shortId/端口都不变。
- **同机客户端+服务端测试，socks 出口 IP == 直连 IP**（都是 VPS 自己）→ 判断走没走代理靠 `socks exit 0 + 客户端日志 tunneling`，不靠 IP。
- **测试口公网可达性看云安全组**（机器内 `ufw`/`iptables` 看不到云控制台规则）；本地闭环不受影响、最可靠。便宜 VPS 常默认全放行。
- **凭证（IP/UUID/pbk/sid/privateKey/密码）是 secret**，只对话交付，**绝不写进本 skill / 记忆 / git**。
- 详见 memory `feedback_xray_reality_serverName_swap`。

### 变体 A：x-ui / 3x-ui 面板管理的节点（2026-06-25 实战）

识别：xray 进程 args 是相对路径 `bin/xray-linux-amd64 -c bin/config.json`、cwd `/usr/local/x-ui`、systemd unit 叫 **`x-ui`**（非 `xray`）。

- **真源是 `/etc/x-ui/x-ui.db`（SQLite），不是 `bin/config.json`**（后者面板按 db 生成，直接改会被 `x-ui restart` 覆盖）。
- 换域名：备份 db → sqlite3 改 `inbounds.stream_settings` 的 `realitySettings.dest`+`serverNames` → **`x-ui restart`**（重启面板+重生成 config+拉起 xray；别用 `systemctl restart xray`）。

```bash
DB=/etc/x-ui/x-ui.db; cp "$DB" "$DB.bak.$(date +%s)"
python3 - <<'PY'
import sqlite3,json
con=sqlite3.connect("/etc/x-ui/x-ui.db")
ss=json.loads(con.execute("SELECT stream_settings FROM inbounds WHERE id=<N>").fetchone()[0])
rs=ss["realitySettings"]; rs["dest"]="<新域名>:443"; rs["serverNames"]=["<新域名>"]
con.execute("UPDATE inbounds SET stream_settings=? WHERE id=<N>",(json.dumps(ss),)); con.commit()
PY
x-ui restart
echo | openssl s_client -connect 127.0.0.1:443 -servername <新域名> 2>/dev/null | openssl x509 -noout -subject  # 验回落证书
```

### 变体 B：服务端节点是 cc 工作出口（如 Gemini 专用）→ 双侧多机联动

换了**服务端**伪装域名，**所有客户端**对应 outbound 的 `serverName` 必须同步改，否则该引擎链路立断（客户端 SNI ∉ 服务端 serverNames → 握手失败）。本案要改 **Air + Mini 两台** `~/xray/config.json` 的 `Gemini专用-US2-VLESS-Reality-IP`：

```bash
# 每台客户端（ssh mini 远程同样）：python3 匹配 address+reality 改 serverName（不靠 tag 名）→ 原子重启 → E2E
~/xray/xray -test -config ~/xray/config.json                     # Configuration OK（WS/VMess deprecated 警告无关）
launchctl kickstart -k gui/$(id -u)/com.xray.proxy
curl -s -o /dev/null -w "%{http_code}" --socks5-hostname 127.0.0.1:10808 https://generativelanguage.googleapis.com/v1beta/models  # 非000(403正常)=通
grep generativelanguage ~/xray/access.log | tail -1             # 见 [socks -> 节点tag] = 走对节点
```
客户端 serverName 必须 ∈ 服务端 serverNames 且与 dest 证书域名一致 → 同口换 serverNames 时 dest 单一=证书单一，**无法零中断**，切换有几秒窗口（cc 自用节点可接受）。

### 切换策略（决定客户端链接命运）

换域名后客户端分享链接**只改 `sni` 一个字段**（UUID/pbk/sid/端口/flow 全不变，因 keypair 与 serverName 正交）。两种切法对旧链接影响完全不同：

- **单口直切**（改原端口 serverNames 只留新域名，如 x-ui 改 db）→ **旧 SNI 链接立即失效**，所有客户端必须同步更新 sni，否则握手失败。适合 cc 自用节点（Air/Mini 能一起改）。
- **双口并存**（旧端口不动 + 新域名挂新端口）→ 旧链接照用、新链接是增量，**平滑迁移零中断**。这才是零中断的正解（≠ 同口多挂 serverNames，那个 dest/证书单一做不到）。适合客户端分散 / 不能同时改 / 要过渡期。

详见 memory `feedback_xray_reality_serverName_swap`。

