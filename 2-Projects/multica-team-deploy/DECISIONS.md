# 关键决策记录

> 按时间顺序记录方案演化中的关键选择 + 备选淘汰理由。后续质疑或回顾时按此对账。

## D1 · 为什么不上云服务器？

**选择**：QNAP TS-X65 + Mini M4 联合（不买云服务器）

**备选**：
| 方案 | 月成本 | 评分 |
|------|--------|------|
| AWS 东京 c7i.4xlarge 单机 | $290 | 稳但贵 |
| 档位 B 双机分离 | $420 | 团队级最优解但贵 |
| **QNAP + Mini（已有硬件）** | **$0** | ✅ 选此 |

**理由**：
1. 川哥实测 QNAP TS-X65（8C N355 / 16GB / 615GB SSD / Container Station 已装）资源**比单云服务器还好**
2. Mini M4 32GB 停 Ollama+mycc 后腾出 7-12GB，跑 3-5 个 daemon 容器没压力
3. 公网走已有 cli4.hahaxiong.cc FRP relay，团队访问延迟 50-80ms 体感够
4. 数据完全自有，不上别人云
5. 10 人小团队规模，IDC 级别 SLA 不必要

**风险接受**：
- 家庭网络断 → 团队断（接受，频率低）
- QTS 自动更新重启容器（关掉自动更新规避）
- 公网链路比直连云多 50ms（接受）

## D2 · 为什么 QNAP 跑 server 而不是 Mini？

**选择**：应用层（server + DB + brain）在 QNAP，算力层（daemon）在 Mini

**备选**：
- ❌ Mini 跑全栈：Mini 已是 Studio 网关 + cc-remote + mycc 编排中枢，再压 multica 全栈会爆
- ❌ QNAP 跑全栈：QNAP 上跑 daemon 需要装 claude/codex/gemini CLI，QNAP 是 NAS 系统，不适合做开发环境
- ✅ **分离**：QNAP 跑稳定的 server stack（DB 是 stateful 的，更适合 NAS 持久化），Mini 跑变化频繁的 daemon（Mac CLI 生态更全）

**额外考虑**：
- QNAP 7.1TB 大盘可挂 `backend_uploads`（附件存储），未来扩容方便
- Mini 跑 daemon 还能就近用本地 git / 本地 IDE 协同（虽然 daemon 不直接调）

## D3 · 客户端用官方 Multica.app vs 浏览器？

**选择**：Apple Silicon 同事装 Multica.app（v0.3.9 notarized .dmg），Intel Mac 同事用浏览器

**关键事实**：
- ✅ Multica.app 自托管支持完善（`~/.multica/desktop.json`）
- ✅ 已签名 + Apple notarized，同事 Mac 装不跳警告
- ❌ **官方未提供 Intel build**，Rosetta 救不了（缺 native module）
- 浏览器体验 95% 一致，主要差 系统通知 / 全局快捷键

**部署机制**：写 `install-multica.sh` 一键脚本（下载 dmg + 装到 /Applications/ + 写 desktop.json）

## D4 · 公网入口必须 HTTPS + WSS

**选择**：HK relay 上加 Caddy 做 TLS 终端 + Let's Encrypt 自动签证书

**关键事实**：
- 客户端 WebSocket 必须走 `wss://`（源码实测）
- 浏览器跨域 + CORS 也要 HTTPS
- 不能裸 TCP FRP 直转（之前的猜测错了）

**Caddy 选择理由**：
- 自动 Let's Encrypt（不用手动证书运维）
- 一行 reverse_proxy 配置（轻于 nginx）
- WebSocket Upgrade 默认支持

## D5 · Daemon 隔离用 Docker 容器（不用 OS user）

**选择**：Mini 上每个 daemon 独立 Docker 容器（独立 HOME + 独立卷）

**备选**：
| 方案 | 隔离强度 | 复杂度 |
|------|----------|--------|
| 单 OS user 多 daemon profile（multica CLI 原生支持 `--profile`）| 弱（同 user 凭据） | 低 |
| 每个 daemon 一个 macOS OS user | 强 | 高（用户管理麻烦）|
| **每 daemon 一个 Docker 容器** | **强** | **中** ✅ 选此 |

**理由**：
1. 容器化让 AI CLI 凭据严格隔离（不同容器不同 $HOME）
2. 资源限制可控（`mem_limit: 2g`）
3. 启停独立（一个 daemon 挂不影响别的）
4. Mac Docker 跑在 VM 里，daemon 主要是 CPU + 网络，IO 性能损失不严重

## D6 · 不与 EvoDesk 耦合

**选择**：本项目作为独立产品规划，**不修改 EvoDesk 任何代码 / 不共用 EvoDesk 后端**

**纪律来源**：[feedback_evodesk_mycc_independent.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/feedback_evodesk_mycc_independent.md) — "EvoDesk 与 mycc/小程序是独立项目，做 EvoDesk 决策不要带入 mycc"，反向同样适用。

**未来轻量接口（>3 个月后再评估）**：
- EvoDesk red-line 引擎可能开 `/v1/red-line/check` HTTP API 给 multica daemon 调
- EvoDesk Foresight 信任分（需各自训练，不复用模型）

详见上次对话中"multica × EvoDesk 结合分析"。

## D7 · AI 订阅方案（待定）

**当前状态**：川哥说"部署完成后另外配置"，先把架子搭起来。

**候选**：
| AI | 推荐方案 | 月成本/10人 | 合规度 |
|----|----------|------------|--------|
| **Anthropic Claude** | ✅ Claude Code for Teams（建议买） | ≈ $300 | 合规 |
| OpenAI Codex | 沿用 VPS:4001 Pro 代理（短期）/ ChatGPT Team（长期）| $20 / $300 | 灰色 / 合规 |
| Google Gemini | VPS:4000 v5 网关（已有）| $5-50 按量 | 合规 |

**待 Phase 7 拍板**。

## D8 · 版本 pin 还是 latest

**选择**：multica server 镜像 pin 到 `v0.3.9`（与客户端版本对齐）

**理由**：
- 客户端 Multica.app v0.3.9 与 backend v0.3.9 的 API 契约对齐
- 上游 v0.3.x → v0.4 高速演进（migration 有 fail-closed 守卫，需手动 backfill）
- 升级时同步升 server + 客户端 + Mini daemon，统一节奏

**升级 SOP**（写到运维手册）：
1. 前一晚 dump pgdata（QNAP 上快照）
2. 客户端先升（同事拉新 dmg）
3. server 升（docker compose pull + up -d）
4. daemon 升（Mini 上 docker compose pull + up -d）

## D9 · pg_cron 是否装

**事实**：multica v0.3.5+ Usage Dashboard 需要 `rollup_task_usage_hourly()` 定时刷新，bundled pgvector 镜像不带 pg_cron。

**选择**：用 **Option A**（外部 cron）—— 在 QNAP host 上跑 crontab `*/5` 调 docker exec 跑 SQL。

**理由**：
- 不换 pgvector 镜像（保持官方上游一致性）
- QNAP QTS 自带 cron
- 10 人量级 5 分钟刷新够用
