# 3.2.0 历史证据与维护接口

以下均为 **2026-10-21 对特定 3.2.0 发布物的观察**，使用前核对当前版本。完整报告见 `~/home-lan/2-Projects/P01-家里局域网与飞牛/06-OK笔记功能分析与开启记录.md`；仓库发布快照见 [项目档案](../../../../2-Projects/home-lan/oknote/README.md)。

## 当次部署

- 飞牛 2：`192.168.1.115`，应用中心包/容器 `oknote`，HTTP 38080。地址需现场重核。
- Compose：`/vol1/@appcenter/oknote/docker/docker-compose.yaml`。
- 配置：`/vol1/@appdata/oknote/.env`；数据：同目录 `data/`；`config/` 和 `data/.secrets.env` 也是恢复依赖。
- 镜像 ID：`sha256:aab435231ab37de91e588a997ce7f8b6321313a7f5b7ca007e33e72801324dc0`。
- bundle SHA-256：`6eb34dbc27619c0d3d7f6cae522e4fa68176c0c765e9b5aaab4b8b98929d07e7`。
- 用户授权变更为 `LICENSE_ENFORCEMENT=disabled`、`ENABLE_REGISTRATION=false`；其他环境变量与镜像保持不变。这是已执行事实，不是默认处方。
- 变更前备份：`/vol1/@appdata/oknote/maintenance-backups/features-20261021T025244Z`；24 文件和数据库完整性检查通过，没有全应用真实数据恢复演练。

## 容易误判的分支

| 观察 | 正确解释 |
|---|---|
| `cloud` 环境值 | 归一化为 grace，仍执行能力限制 |
| `enforced=false` | grace 与 disabled 都可能返回，不能单独证明全开 |
| 本次已核实 disabled 下返回 enterprise 和 `features=["*"]` | 是本地内置 FULL_ACCESS 模式，非购买证明；单独看后两个字段不能反推模式，云账号权益不因此改变 |
| `notebook_max_depth=99` | 正常入口还受用户偏好与 UI/schema 上限 5 约束 |
| `ai_enabled=false` | `/info` 只看环境 AI，还要结合 `/ai/status`、`/ai-config` |
| 普通聊天可用 | 不证明 AI 搜索可用；`POST /search/ai` 单独读环境 provider |
| `subuser_ai_self_config=true` | 原本被强制 admin-shared 的存储策略可能恢复 user-own，需回读实际共享策略 |
| 录音时长/段数=0 | 本地许可不限，上传大小、磁盘、HTTPS、ASR/LLM 条件依然存在 |
| realtime/analytics/failover/cluster flags | 当次未找到足够完整的消费链，不能据此承诺实现 |
| 邮箱账户0 / AI配置0 | 是当次现场状态，不是该能力不存在 |
| 无有效云记录 | 本地功能配置不需激活；但 disabled 本身不会停掉已有云绑定心跳 |

Google/Microsoft OAuth 有独立 `mail-oauth` 路由；不要被普通 IMAP 创建接口的 `OAUTH_NOT_IMPLEMENTED` 分支误导。个人邮箱 SMTP 与系统通知 SMTP 也不是同一套。

官网功能页、指南、下载日志之间曾有矛盾；以版本匹配的实码与实测为准。官网当次 NAS 下载为 3.2.7，含局域网附件上传与异地备份导入修复，不能当作当前 3.2.0 已具备。协议称不提供云托管；代码含 relay 开通分支不证明云服务已经可购买或可用。

## 接口与验证边界

下面路径均加 `/api` 前缀；先核当前路由。

| 接口 | 认证/作用 | 不能证明什么 |
|---|---|---|
| `GET /health` | 公共，ok/version 非空载荷 | 非完整业务验收；根路径 `/health` 当次只是 SPA |
| `GET /info` | 公共，部署/环境 AI/OAuth/上传大小 | 非完整 AI 或权益真值 |
| `GET /license/status` | 登录，caps/features/modules/limits | 标志不等于实际调用成功 |
| `GET /ai/status` | 登录，生效 provider 与 quota | 不证明外部模型真实可达 |
| `GET /ai-config` | 登录，脱敏配置及 policies_effective | configs 中 null 占位不能计为已配置 |
| `POST /billing/check` | 登录，feature 准入，不扣次数 | 不等于执行了 OCR/PDF |
| `GET /mail/accounts` | 登录，本人邮箱列表 | 不证明收发同步成功 |
| `POST /search/ai` | 登录，参数为 `{q:...}` | MODULE_LOCKED→AI_NOT_CONFIGURED 只证明跨过门禁 |

`POST /ai-config/test` 会真实调用模型；邮件 test/smtp-test 会连接外部服务。不能把这些当纯读探针。邮箱绑定会同步实际邮件，不能在服务/内容范围未确定时自动绑定。

## 当次验收的边界

同镜像禁网络隔离测试：白板创建、子本创建、本地 Ollama 配置保存由 403 变 200；合成 AI 搜索由模块锁变为缺 provider。没有实际模型调用。生产回读 caps、OCR/PDF quota、401 负例、注册403及数据哈希通过；未在生产创建测试笔记或分享。

HTTP 页面实际无 `getUserMedia`、clipboard、serviceWorker，即使有 MediaRecorder 也不能录音。全功能完成仍取决于 AI/ASR/邮箱选择和实际 HTTPS 入口；当次未接通这些服务。
