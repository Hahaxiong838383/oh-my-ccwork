# Python worker 退役盘点（只盘点未动手，等川哥拍板）

时间：2026-09-07 13:57 CST。范围：realtime-voice-agent Python 线（主线 + 同事租户线）在 64.90（企航云 HK，worker 机）与 47.239（LiveKit 机）上的全部占用。全部数据为本轮只读实测（systemctl/ps/ss/du/journalctl/LiveKit 服务端日志），未改任何配置。

## 0. 结论

- **Python 线现在还有 4 个 unit 在 64.90 跑**：`voice-worker`（主线）、`voice-worker-colleague`（同事租户 worker，AGENT_NAME=javis-colleaguedem-5675d9）、`voice-console`（租户控制面，127.0.0.1:8930）、`caddy`（https://voice-api.hahaxiong.cc → 8930）。47.239 只有 livekit-server + nginx，没有 Python worker。
- **可立即释放（无人用）**：主线 `voice-worker`。近 30 天只有 6 个 job，最后一次 2026-08-19 07:53Z（就是拍板「Python 退役」那天），此后零流量；它注册的 agent 名 `realtime-voice-agent` 不会被 p003 房派到。
- **需拍板（还有人在用）**：同事租户三件套。LiveKit 服务端派单账：8-27 到 9-04 每天 6–50 次 javis job（9-03 高峰 50），**9-05 起每天 1–2 次**，最近一次今天 10:23 CST——外部调用方 IP 205.169.39.236 经 voice-api `POST /v1/sessions` 建房，真实对话（TTS「我在呢，指挥官」，30 s 后结束）。停掉三件套 = 同事接入立刻不可用（/v1/sessions 拒连）。
- **收益**：内存约 **1.15 GB**（cgroup 实测 voice-worker 536 MB + colleague 562 MB + console 50 MB）→ 64.90 可用内存从 1.8 GB 升到约 2.9 GB（总 3.9 GB，无 swap，rust 线 cgroup 529 MB 其中 sidecar 459 MB）；CPU 空闲基本不变（两 Python worker 平时各 ~1%，但 colleague 累计 CPU 25 520 s 是全机最高）；关掉公网可达的 0.0.0.0:8081/8082（两个 Python worker 的健康端口，ufw inactive）和 caddy 的 80/443；LiveKit 少两个 agent 注册。
- **不能顺手删的两样**：① `/root/voice-venv`（670 MB）——rust 的 EOT/声纹 sidecar `eot_sidecar.py` 用它的 python（numpy + sherpa_onnx + livekit.local_inference），退役 Python 线后仍要保留，或另建约 200 MB 的专用 venv；② 共享 `/root/realtime-voice-agent/.env` 与 `poc-eou.env`——rust unit 的 EnvironmentFile 前两行就是它们，rust 二进制实际读其中 **7 个键**（LIVEKIT_API_KEY、LIVEKIT_API_SECRET、LLM_BASE_URL、TTS_PROVIDER、VOLC_ASR_API_KEY、VOLC_TTS_SPEAKER、POC_RESUME_FADE_MS），先并进 `rust-worker.env` 再改 unit，否则删文件即断。

## 1. 现状清单

| 机 | unit | 状态/自启 | 内存(cgroup) | 端口 | env 文件 | 最近使用 | 依赖者 |
|---|---|---|---|---|---|---|---|
| 64.90 | voice-worker（Python 主线） | active / enabled，9-01 起 | 536 MB | 0.0.0.0:8081 | .env + poc-eou.env | 08-19 07:53Z（30 天 6 job） | 无 |
| 64.90 | voice-worker-colleague | active / enabled，9-01 起 | 562 MB | 0.0.0.0:8082 | .env + console.env + tenant-colleague.env | 今天 10:23 CST | 同事（租户 colleaguedem-5675d9） |
| 64.90 | voice-console（uvicorn） | active / enabled | 50 MB | 127.0.0.1:8930 | .env + console.env | 今天 10:23 CST（/v1/sessions） | 同事接入 + 健康探测（8-29–9-03 每天 ~1 650 次请求，9-04 起 <120） |
| 64.90 | caddy | active / enabled，7-27 起 | 22 MB | *:80/*:443 | /etc/caddy/Caddyfile（voice-api.hahaxiong.cc） | 同上 | 同上（Let's Encrypt 自动续） |
| 64.90 | voice-worker-rust（正式版） | active / enabled，9-06 23:49Z | 529 MB（rust 126 MB + eot_sidecar 459 MB） | 无监听 | .env + poc-eou.env + rust-worker.env | 持续（今天 88 job） | p003 全部设备 |
| 47.239 | livekit-server / nginx | active | 1.6 GB 机可用 873 MB | 7880/7881/7882/443 | /etc/livekit/config.yaml | — | 两条线共用 |

磁盘（64.90，/ 49 GB 用 9.5 GB）：voice-venv 670 MB、realtime-voice-agent 89 MB、/opt/voice-agent 45 MB（租户加密凭据 + tenants.json，只有 1 个租户）、**rust-worker 2.2 GB（其中 29 个历史二进制备份 2.0 GB）**、eot-snapshots 689 MB（1 348 房，每天 30–130 房）。

## 2. 流量证据（LiveKit 服务端，按天）

| 日期 | 租户房（t-colleaguedem，按参与者计） | javis 派单 | rust 派单 | p003 房 |
|---|---:|---:|---:|---:|
| 08-27 | 12 | 6 | 53 | 102 |
| 08-28 | 36 | 18 | 57 | 114 |
| 08-29 | 98 | 49 | 2 | 4 |
| 08-30 | 96 | 48 | 11 | 22 |
| 08-31 | 98 | 49 | 79 | 158 |
| 09-01 | 58 | 29 | 144 | 288 |
| 09-02 | 52 | 26 | 140 | 280 |
| 09-03 | 101 | 50 | 40 | 80 |
| 09-04 | 46 | 23 | 66 | 132 |
| 09-05 | 2 | 1 | 28 | 56 |
| 09-06 | 2 | 1 | 59 | 116 |
| 09-07（到 13:5x） | 4 | 2 | 88 | 176 |

租户房参与者身份形态（近 3 天）：`guest#hold`、`P32CN8RT#hold`、`P32CN8RT`（同事客户端的常连/保持房命名）。每个租户房都拿到了 agent（房数≈2×派单数是设备+agent 各一行），没有静默失败。9-05 起骤降是同事那边停用还是只剩探活，需向同事确认。voice-test.html（Python 线网页）近 30 天 nginx 零访问；voice-test-rust.html 同样零访问（4 个 voice-test-rust 房是 cc 自测）。

## 3. 耦合与边界

- rust ↔ voice-venv：`EOT_SIDECAR_PYTHON=/root/voice-venv/bin/python`，sidecar 只 import numpy/socket/struct/threading + 懒加载 sherpa_onnx（声纹 CAM++）+ livekit.local_inference（EOT）。venv 里大头是 transformers 105 MB、livekit 74 MB、av 100 MB、onnxruntime 56 MB、numpy 70 MB、sherpa_onnx 36 MB。
- rust ↔ 共享 env：见 §0 的 7 个键。`AGENT_NAME=rust-worker` 在 rust-worker.env，与租户 `javis-…` 互不串台；Python 主线注册名 `realtime-voice-agent`。
- 同事租户：凭据经 console 写在 /opt/voice-agent/tenants/（AES-GCM，永不回显），worker 每 job 热读；tenant-colleague.env 只有派单名与打断参数。**把租户迁到 rust 不是配置切换**：rust 按 `sn-<SN>-<ts>` 房名取设备、走设备台账/canary/回声库/本地音频，单租户单套讯飞+火山+LLM 配置；租户房 `t-*` 和 per-tenant 讯飞/kidshub.cn 凭据都不适配，属新开发，不在「释放资源」范围。
- 仓库：main 上 Python 线 src 62 个 .py（1.1 MB）+ scripts 7 个 + web 43 MB；rust worker 在 feat/rust-worker 分支（main 上没有）。

## 4. 释放方案（分级，每级可单独回滚）

**A. 主线 voice-worker（无需拍板，建议随 B 一起做）**：`systemctl disable --now voice-worker`；验收：LiveKit 日志不再出现 `realtime-voice-agent` 注册、rust 派单照常；回滚 `systemctl enable --now voice-worker`。释放 536 MB + 端口 8081。

**B. 同事租户三件套（拍板项）**：B1 先通知同事并给截止日（建议 7 天，届时 9-05 起的 1–2 次/天若仍在就是探活）；B2 到期 `systemctl disable --now voice-worker-colleague voice-console caddy`；voice-api.hahaxiong.cc 的 DNS 记录与证书处置另定（不摘也无害，只是 443 无人应答）；/opt/voice-agent 打 tar 留档不删（含租户加密凭据，删要同事同意）；回滚三条 enable --now。释放 612 MB + 端口 8082/80/443。

**C. 磁盘（无需拍板，低风险）**：rust 二进制备份 29 个 2.0 GB → 只留最近 5 个（deploy-worker-bin.sh 每次换装都会新增，建议脚本里顺手轮转）；eot-snapshots 保留 7 天 + cron 清理（这是 cc 首句取证工具，别全删）；voice-venv 保留。

**D. 收尾（A/B 之后）**：① 7 个共享键并入 rust-worker.env，unit 去掉前两行 EnvironmentFile，restart 一次验 job 正常；② 47.239 nginx 摘 `/voice-test.html`（30 天零访问；rust 页保留）；③ 仓库：main 的 Python src 顶部加「已退役，正式线见 feat/rust-worker」，不删代码；skill voice-agent-ops 的 Python 段落标退役；④ 记忆更新。

**E. 不建议**：为了释放资源而把同事迁到 rust（见 §3）。

## 5. 待川哥拍板

1. 同事三件套：直接停 / 通知后 7 天停 / 保留？
2. voice-api.hahaxiong.cc 域名与证书：摘 / 留？
3. venv：保留 670 MB 现状 / 另建专用小 venv（多一次 sidecar 验证）？
4. 备份留 5 个、快照留 7 天，这两个数字认不认？
5. 要不要 cc 出一份给同事的通知文案？

署名：cc（Claude）| 2026-09-07 13:57 CST
