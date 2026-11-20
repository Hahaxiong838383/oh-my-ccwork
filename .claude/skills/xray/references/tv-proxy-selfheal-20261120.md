# 电视盒代理栈自愈、线路偏好与冷启动验收（2026-11-20）

本篇记录一次完整处置：断电后代理栈不自启、DNS 全挂、以及"野草云优先"的正确实现。
设备：X96_X10Pro / Android 11 / Magisk；代理 `/data/adb/video-proxy`，守护 `youtube-failover`。

## 1. 故障形态与两个真根因

断电或重启后 SmartTube 报 `UnknownHostException: www.youtube.com`，而"看起来"代理还在。真因两条：

1. **守护的 DNS 升级事务拒绝启动**：`guard-live-*/transaction.tsv` 记的是旧基线，`config.json` 被后续改动
   （UID 迁移、线路切换）改了哈希 → `dns-upgrade-apply.sh --apply` 判"未知漂移"→ `preflight` 失败 →
   `video-boot-start.sh` 根本没跑 → DNS 接管没做（`net.dns1` 还是路由器）→ 应用解析失败。
2. **DNS 上游真的坏了**：配置里 DNS 服务器用 DoT `1.1.1.1:853`。实测同一隧道 **443 通、853 不通**
   （Cloudflare DoT 被挡）。改用 DoH over 443 后恢复。

判读要点：`ping www.youtube.com` 能通不代表应用能用——系统解析器与 tun 内解析是两条路。查
`dns-upgrade.log` 里的 `preflight` / `refused` 与 `boot-start.log` 里有没有 `dns_takeover_ready`。

## 2. 事务重基线（rebless）——必须自带兜底

`/data/adb/video-proxy/rebless-transaction.sh`：把 `transaction.tsv` 的 16 条全部改成
`old = new = 当前文件哈希`，并同步 `backup/` 与 `payload/`。做法与约束：

- 先校验三个锚点：`config.json` 摘要 == `active-main.sha256`；`release-id` == `enabled`；
  `workers/rack/config.sha256` == 该 config 的摘要。任一不符就拒绝。
- 再校验文件权限：`.sh` 必须 700，其余 600（历史事故：`cp` 出来的 666 会让 preflight 直接失败）。
- **坑**：脚本原来用 `mktemp -d`，冷启动 uptime≈11s 时 Android 的 `/tmp` 还没创建 → `auto_rebless_refused`。
  改成在 `$D/.rebless.$$` 建临时目录。

## 3. 开机入口改成自愈（service.d/video-proxy.sh v3）

四步，缺一步就会出现"日志说启动成功但服务不在"：

1. 首次安装延后一次（与原版一致，比较 `installed-boot-id`）。
2. 跑 `dns-upgrade-apply.sh --apply`；失败就自动 `rebless` 后继续（rebless 成功即等价于"已应用"，不必重试 apply）。
3. 把当前 `boot_id` 写进 `youtube-failover/authorized-boot-id`（守护的授权门，人工不写守护就不跑）。
4. 若 `pidof sing-box` 为空：先 `authorized-boot-id=revoked` + `kill $(cat guard.pid)` 释放
   **`boot-start.lock`**（守护继承了这把锁，不释放则后续 `video-boot-start.sh` 静默退出，什么都看不到），
   再清 `boot-ready-boot-id`、覆写 `boot-fix-installed-boot-id`，然后完整启动；最后兜底检查守护。

## 4. 守护 YoutubeFailover 的两条硬约束（改就崩）

调试时踩过两次，务必先读：

| 字段 | 结果 |
|---|---|
| `recovery_hold_ms` 任何改动（60000/120000） | ❌ 崩 `InvalidConfiguration` |
| `recovery_successes` 改动 | ❌ 同上（连带） |
| `candidates` 增删/改序 | ❌ 崩 `CandidateOrderOrWorker`（顺序硬编码在 dex 里） |
| `light_timeout_ms` 4000→8000 | ✅ 唯一可调，用来避免 4K 占满带宽时误判 |

**验证方式**：改完必须 `ps -A | grep YoutubeFailover` 确认真起来了；只看 204/配置文件写成功会被骗——
守护崩了之后 `lane-hold` 仍在工作，线路照样会切，播放看着正常。

## 5. "某条线优先"不能靠守护，靠 lane-hold 断言

守护是**按探针速率最快选**，不是按候选顺序；实测手工设成 HK 后 30 秒内被抢回 ZGO。
正确做法（`lane-hold.sh` 第 4 段）：非播放期把 `youtube-video` **持续断言**回首选线路，
只有该线连续 2 次探针失败才应急退到备用线。

## 6. 播放期换线安全（防 403）

googlevideo 的 URL 绑定出口 IP，播放中换线必 403。三条措施：

- **在播判定要三重**：`session_state∈{3,6}`、或观察器样本过期 >60s（保守当在播）。
  ⚠ 不要把"SmartTube 在前台"当作在播——会把停播状态误判成播放中，导致永远回不到首选线。
- 播放中 lane-hold 绝不主动换线；若守护自己抢线，回切节流从 60s 收紧到 **5s**（实测 8s 内拉回）。
- 剩余风险：被守护抢线那一瞬仍可能 403 一次，属守护不可配置的固有代价。

## 7. 中继保活（避免冷启动后线路爬坡）

现象：冷启动后 HK 通道要 ~90s 才从 0.44MB/s 爬到 4.4MB/s。处理：在 relay 所在机（home-studio）
加 systemd user timer，每 2 分钟经 relay 拉 2KB（`OnUnitActiveSec=120`，`Linger=yes`）。

- 流量：2KB×30/h×24 ≈ **1.4MB/天，约 43MB/月**（早期版本 100KB/2min = 70MB/天，纯浪费）。
- **实测对照**：开机 +11s 即 5.81MB/s（对比无保活时 0.44MB/s），组件全绿、选路自动落首选线。
- 注意 relay 监听在 `192.168.1.133:10888`（不是 127.0.0.1），保活脚本地址写错会 `exit 7`。

## 8. 冷启动验收清单（每步都要看数据）

1. 掉线→恢复时长；恢复后 ADB 就绪时长。
2. `ps | grep sing-box` 应有主进程 + rack/zgo 两个 worker。
3. `ps | grep YoutubeFailover` 守护在跑；`tail guard-console.log` 无 `fatal`。
4. `ping www.youtube.com` 与 `video-boot-net dns www.youtube.com 127.0.0.1 5354`。
5. 选路 `GET /proxies/youtube-video` 是否落在首选线。
6. 播放验收用**连续帧计数差**，不看单次读数；`drop` 必须持续为 0。

## 9. 常用命令

```bash
SEC=$(adb shell cat /data/adb/video-proxy/youtube-failover/api-secret)
# 看选路
adb shell "printf 'GET /proxies/youtube-video HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer $SEC\r\nConnection: close\r\n\r\n' | busybox nc -w 2 127.0.0.1 19090 | tail -1"
# 手工选路（Content-Length 必须等于 body 字节数，否则 400）
# 重基线（改过 16 个受管文件后）
adb shell sh /data/adb/video-proxy/rebless-transaction.sh
# 观察器样本（在播判定的唯一依据）
adb shell tail -1 /data/adb/video-proxy/playback-observer/observations.jsonl
```
