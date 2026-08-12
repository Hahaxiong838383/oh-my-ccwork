---
name: cpa-smart-router
description: CPA Smart Router 运维与迭代指南。用于检查、部署、验证阿里云日本服务器上的个人 CPA 调度 sidecar，排查 smart-api.hahaxiong.top、SQLite dashboard、provider 路由、Codex lane 灰度问题。
---

# CPA Smart Router

个人 CPA 的 Go sidecar 调度层，部署在阿里云日本服务器 `aliyun-jp`，负责给 CLIProxyAPI 增加鉴权、provider 候选调度、sticky、熔断、指标记录、SQLite 聚合和简易 dashboard。

## 触发场景

- 用户提到 `CPA`、`smart-router`、`smart-api.hahaxiong.top`、`fable-5`、`gpt-5.5` 调度。
- 用户要测试或部署个人中转 CPA。
- 用户要看 `/debug/state`、`/debug/summary`、`/dashboard`。
- 用户要调整 Codex lane 的 smart-router 灰度比例。

## 关键位置

- 本地代码：`/Users/rayman.chen/mycc/2-Projects/cpa-smart-router`
- 远端部署：`aliyun-jp:/opt/cpa-smart-router`
- systemd：`cpa-smart-router.service`
- 本地监听：`127.0.0.1:8327`
- 公网入口：`https://smart-api.hahaxiong.top/v1`
- CPA Direct：`https://api-direct.hahaxiong.top/v1`
- 远端 SQLite：`/opt/cpa-smart-router/router.sqlite`
- 远端 JSONL：`/opt/cpa-smart-router/router-metrics.jsonl`
- Codex lane：`/Users/rayman.chen/mycc/4-Assets/Prompt/omp-team-templates/_codex_lane.sh`
- CLIProxyAPI：`aliyun-jp:/opt/cliproxy`，auth-dir `/root/.cli-proxy-api`
- K12 池运维文档：`2-Projects/cpa-smart-router/docs/k12-auth-pool-ops.md`
- CPA 菜单栏：`/Users/rayman.chen/mycc/2-Projects/cpa-menubar`
- 桌面 Bridge：`cpa-desktop-bridge.service`，本地监听 `127.0.0.1:8330`

## 公司 H 引擎接入（2026-08-08）

- 公司 H Worker 通过 CPA Direct `https://api-direct.hahaxiong.top/v1` 调用实时模型目录中的 `grok-4.5`。
- H Worker 必须继续通过 Grok Build CLI 执行；使用 `[model.cpa-grok-4-5]` 映射 `model = "grok-4.5"`，不能用与内置模型相同的配置名。
- Grok Build 配置使用 `env_key = "CPA_API_KEY"`，Key 只保存在 dev198 0600 环境文件，不写 TOML、不放命令行、不复制到 QNAP。
- 每次升级模型先调用带鉴权的 `/v1/models`，只输出模型 ID 等非敏感字段，再做隔离 HOME 最小推理和 Worker HMAC 推理。
- 当前个人 CPA 的 xAI 来源是单账号，无同厂冗余；公司正式放量前应建立公司专用 Key/账号和故障切换策略。

## CPA Menu xAI 账号用量与最新模型路由（2026-08-08）

- xAI 总览和账号明细是两套口径：Smart Router `/debug/summary?hours=24` 提供 provider 级近 24 小时聚合；CLIProxyAPI `usage-queue` 的 `provider + auth_index` 用于 CPA Menu 当日账号归因。
- `usage-queue` 是 destructive pop，同一 CPA 实例只能保留一个消费者。Canary Bridge 必须禁用 Management Key/collector，禁止与生产 Bridge 并发消费。
- Bridge 的 Codex 总桶只能累计 `provider=codex`；按账号桶可以累计 `codex/xai`。直接放开 provider 过滤而同时写总桶，会把 xAI Token 污染到 Codex 今日汇总。
- auth index 只在 Bridge 内用于匹配 auth 文件，Desktop API 只返回脱敏账号与聚合结果，不返回原始 index、文件名、Token、Key、Header、IP 或上游正文。
- xAI OAuth 当前没有稳定的账号级官方订阅剩余额度接口。账号卡只展示真实请求、Token、成功率、最近使用、主要模型和刷新状态，并明确写“官方未提供”；不得用 Management API 团队账单、Smart Router 日预算或自定义预算冒充。
- 用量解析必须同时支持 Chat Completions 的 `prompt_tokens/completion_tokens`、Responses 的 `input_tokens/output_tokens`，以及 SSE 完成事件中的 `response.usage`。若总 Token 更新但输入/输出为 0，先查 schema 覆盖，不要误判 App 没刷新。
- xAI 文本主路由当前使用 `grok-4.5`。`grok-3-mini*`、`grok-4.3`、`grok-4.20-*` 旧文本别名重写到 `grok-4.5`；图像、视频、Build 与 Composer 是专用模型，不做文本模型强制替换。
- 模型升级验收必须覆盖五层：带鉴权 `/v1/models` 可见、Router 候选明确重写、旧别名与新名 Canary 均 200、真实响应 `model` 命中目标系列、Bridge 与 macOS Accessibility 文本显示新主模型。配置文件写了新名字不算完成。
- `fill-first` 会优先使用一个 xAI OAuth 账号；第二张卡显示“今日暂无请求记录”不代表坏账号。只有调度实际切换或显式安全测试后，第二个账号才会产生自己的用量。
- 生产切换使用独立 systemd oneshot：备份二进制/配置/usage state，原子替换，重启后验证 health、鉴权模型目录、真实推理、Bridge 内外网与近期错误；失败或超时立即回滚。

## K12 账号池（2026-07-14+）

- 大源：`aliyun-jp:/opt/cliproxy/k12-source/accounts.json`（80500，root 600）；备份在 racknerd secrets，**不进 Grok 只读**。
- 源包 **无 refresh_token**；保活 = 验活剔除 + 小池/大源随机补号。
- 脚本：`k12-health-rotate.py`（`--status-only` / 默认 rotate；大源优先前 2000）。
- 定时：`cpa-k12-health.timer` 每 30 分钟。
- AI Ops 限权动作：`k12-status`、`k12-rotate`（确认词 `ROTATE_CPA_K12`）；Grok harness：`docs/aiops-k12-grok-harness.md`。
- k12 可用模型：`gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini`；Team 仍负责 `gpt-5.6-*`。
- **gpt-5.5 优先 k12**：k12 auth `priority=100`，Team `priority=10`，`routing.strategy=fill-first`；Team 不 exclude 5.5（作兜底）。川哥 2026-07-14 测试 OK。
- 图生冲突：`disable-image-generation: "chat"`（Codex `image_gen.imagegen` vs hosted tool）。
- 禁止输出/提交 token 与账号文件。
- 教训全文：`docs/k12-lessons-learned-2026-07-14.md`（OOM/源质量/模型/限权）。

## 安全边界

- 不输出 `CPA_SMART_ROUTER_KEY`、`CPA_API_KEY`、`CODEX_API_SMART_KEY` 的明文。
- 不提交 `~/.gateway.env`、`/etc/cpa-smart-router.env` 或任何 secret。
- 提交前避开无关运行态文件，例如 `.claude/skills/mycc/current.json`。
- 公网接口必须带鉴权；dashboard 支持 Bearer，也支持 Basic Auth，密码填同一个 key。
- 正式客户端可继续使用个人 `CPA_API_KEY`；smart-router 通过 `client_api_key_envs` 兼容该 key，同时可保留 `CPA_SMART_ROUTER_KEY` 作为管理备用 key。

## 常用验证

```bash
source ~/.gateway.env

curl -sS https://smart-api.hahaxiong.top/debug/state \
  -H "Authorization: Bearer $CPA_SMART_ROUTER_KEY"

curl -sS https://smart-api.hahaxiong.top/debug/summary \
  -H "Authorization: Bearer $CPA_SMART_ROUTER_KEY" | python3 -m json.tool

curl -I https://smart-api.hahaxiong.top/dashboard \
  -H "Authorization: Bearer $CPA_SMART_ROUTER_KEY"
```

## Codex App 图片输入排障

如果 Codex app 使用 smart-router 的 `gpt-5.5` 时提示“不支持图片输入”，优先检查本地模型 catalog，而不是先怀疑 smart-router：

- Codex app 读取 `~/.codex/cc-switch-model-catalog.json` 判断模型输入模态。
- `gpt-5.5` 必须包含 `input_modalities: ["text", "image"]`。
- `~/.codex/refresh-cc-switch-model-catalog.mjs` 会通过 LaunchAgent 每小时刷新 catalog；持久修复要改刷新脚本，不能只手改 JSON。
- API 层验证可直接向 `https://smart-api.hahaxiong.top/v1/responses` 发送带 `input_image` 的 `gpt-5.5` 请求；若返回 200，说明 CPA/smart-router 实际支持图片，问题在 Codex app catalog。

## Codex Fast 模式排障

- Codex 本机配置 `service_tier = "fast"` 只是意图；模型 catalog 还必须为目标模型声明 `service_tiers: [{"id":"priority",...}]` 和 `additional_speed_tiers: ["fast"]`，否则客户端会在发请求前省略 Fast。
- CLIProxyAPI 官方能力接口是 `GET /v1/models?client_version=<version>`。普通 `GET /v1/models` 只返回 OpenAI 四字段目录，不能用于判断 Fast、图片或推理级别。
- smart-router 的所有上游 URL 都必须保留 `r.URL.RawQuery`；尤其不能丢失 `client_version`，否则 Codex 专用目录会被静默降级。
- 本机目录刷新器维护源：`2-Projects/cpa-smart-router/scripts/refresh-cc-switch-model-catalog.mjs`；运行态路径 `~/.codex/refresh-cc-switch-model-catalog.mjs` 由 LaunchAgent 每小时执行。
- 真实验收优先使用透明转发或安全日志，只记录 `model`、`service_tier`、状态码和脱敏 client metadata key，禁止记录 Authorization 或请求正文。
- 当前已验证 Codex 0.145.0 经 `smart-api` 对 `gpt-5.6-sol` 发送 `service_tier: "priority"` 并返回 200；但响应元数据仍显示 `auto/default`。结论只能是“Fast 意图已成功发送和透传”，不能声称上游调度档位已确认。

## CPA Menu 桌面监控

- macOS App 只通过 `https://smart-api.hahaxiong.top/desktop/v1/*` 访问 Bridge；Desktop Token 只存远端 `0600` 文件与本机 Keychain。
- CPA Menu `0.3.2+` 的“添加订阅”统一提供 Codex PKCE 与 xAI Grok 设备码 OAuth。xAI 生产契约以 CLIProxyAPI 实机为准：`GET /v0/management/xai-auth-url?is_webui=true` 返回 `flow=device`、`url`、`user_code`、`state`、`expires_in`，状态轮询为 `GET /v0/management/get-auth-status?state=...`；Management Center 前端源码可能仍保留旧的手工 callback 兼容逻辑，不能替代生产契约探测。
- Desktop Bridge 只暴露 `POST /desktop/v1/oauth/xai/start` 与 `GET /desktop/v1/oauth/xai/status?state=...` 的白名单字段；授权 URL 必须是 HTTPS 且 host 精确等于 `accounts.x.ai`。Management Key、Token、Cookie、上游错误正文、设备码和 state 不得持久化或进入日志；最终 xAI auth 文件仍由 CLIProxyAPI 官方流程写入。
- `MenuBarExtra(.window)` 打开浏览器后可能因失焦关闭浮窗；xAI 授权会话必须由 `AppModel` 独立持有，用户重新点开菜单时继续显示设备码弹层和倒计时，不能把会话状态只放在临时 View 状态里。
- xAI 设备码测试会创建真实的短时待授权会话：自动验收只报告字段名、官方 host、有效期和 `pending/complete`，禁止输出设备码/state；含设备码的临时截图必须在验收后删除。不能在用户完成网页授权前声称“账号已添加”。
- 用户完成后，以 Bridge `/summary` 的 `xai_accounts` 与 `/accounts` 中 provider=xAI 的过滤数量双重核对，并确认账号未停用且具备 refresh token。2026-08-08 17:45 CST 的验收快照为 2 个 xAI 授权账号，均启用且可自动刷新；这是时效快照，复用前必须实时查询。
- 账号列表返回脱敏邮箱、套餐、是否可刷新、周额度、`credits` 充值余额和 `rate_limit_reset_credits` 重置卡状态；Bridge 必须继续使用顶层白名单并递归删除敏感字段。
- Codex 当前没有 5 小时限制，界面不显示 5 小时进度条；`primary_window` 现在也可能是周窗口，必须按 `limit_window_seconds` 分类，不能按 primary/secondary 槽位命名。
- xAI 官方账单真源是 Management API：`POST /v1/billing/teams/{team_id}/usage` 查询本月费用，`GET /v1/billing/teams/{team_id}/prepaid/balance` 查询预付余额；Management Key 与普通推理/OAuth 凭据分离，只从 `/etc/xai-management.env` 读取。
- Smart Router `GET /debug/summary?hours=24` 只保留为 CPA 路由观测；provider 聚合不能归因到某个 OAuth 账号，`daily_token_limit - tokens_today` 只能称“路由日预算剩余”，禁止标成 xAI 官方余额、官方配额或账号剩余量。
- Desktop API、日志和错误文案不得返回 Management Key、路由密钥、Token、上游响应正文或内部错误正文；官方账单未配置/不可用时必须明确标记，不能静默用 CPA 数据冒充。
- 重置卡消费入口为 `POST /desktop/v1/accounts/{id}/reset-credit`。这是不可逆写操作，必须同时满足 App 二次确认、Bridge 固定确认词 `CONSUME_RESET_CREDIT`、消费前实时 `available_count > 0` 与 `applicable_available_count > 0` 校验。
- AI Ops、Grok、定时任务和自动刷新只能读取余额/卡数，禁止自动消费重置卡；卡数、余额属于实时状态，不得把历史快照当成当前结论。
- 部署新 Bridge 二进制后必须显式 `systemctl restart cpa-desktop-bridge.service`；`systemctl enable --now` 不会重启已运行服务。验收要同时检查进程启动时间、新字段和接口行为。
- 覆盖安装新版 macOS App 前必须先结束旧 `CPAMenuBar` 进程，再复制 Bundle、启动并核对新进程启动时间；否则旧进程可能继续运行被替换前的代码。
- `MenuBarExtra(.window)` 的内容不能随账号数量无限增高：窗口使用固定尺寸（当前 `400×560`），标题/Tab/底部操作栏固定，只有中间内容区域进入 `ScrollView`；账号列表使用 `LazyVStack`。
- 菜单栏浮窗优先使用紧凑的分段 `Picker` 做“总览 / 账号 / xAI”切换，不使用会引入额外页签装饰和尺寸波动的默认 `TabView`。设置继续由齿轮入口独立承载。
- 账号页按“停用 → 用量读取失败 → 周额度不高于 10% → 其余账号”排序，并提供“全部 / Plus / K12 / 异常”筛选；xAI 账号不混入 Codex 账号列表。
- 账号卡默认折叠，只保留邮箱、套餐、自动刷新标记和周额度；充值余额、重置卡等低频或危险操作只在展开区显示，重置卡仍必须走 App 二次确认与 Bridge 实时校验。
- CPA Menu `0.3.1+` 的 API Key 美元额度必须读取 `cpa-key-policy` 原生接口：Key 配置来自 `GET /v0/management/plugins/cpa-key-policy/keys`，消费来自 `GET /v0/management/plugins/cpa-key-policy/keys/usage?id=...`；只解码白名单字段，禁止返回 `plain_key`、`key_hash`、`key_preview` 或 Management Key。
- API Key 的可用余额口径固定为 `min(max(0, daily_limit_usd-daily_spend_usd), max(0, weekly_limit_usd-weekly_spend_usd))`；浮窗主值显示这个“更先触发限制”的剩余金额，日剩余和周剩余作为明细，不能用 OAuth 百分比或 Router Token 预算代替。
- 当用户要求给已消费 Key “再增加 N 美元额度”时，先实时读取窗口累计消费，再把目标限制设置为 `current_spend + N`；若直接执行 `old_limit + N`，历史超额会吞掉部分新增余额。更新后复核插件 usage、Bridge `/desktop/v1/summary`、浮窗、模型/RPM 与撤销 timer，原 Key 明文不得重新输出。
- “正式长期原生 Key”和 `cpa-key-policy` 限额 Key 是两套机制：前者是 CLIProxyAPI 顶层 `api-keys`，通过 `GET/PUT /v0/management/api-keys` 管理，天然继承当前及后续全局模型且没有插件额度、RPM 或到期字段；后者用于按用户限制模型、RPM、日/周美元额度和统计。用户明确要求“参考自用 Key、长期、全部模型”时必须选原生 Key，不能用 `models=[]` 的插件 Key 冒充全模型推理权限。
- 原生 Key 创建流程：先备份 `/opt/cliproxy/config.yaml`，读取当前 Key 数组，生成独立高熵值后用管理接口原子回写完整数组，禁止直接覆盖 YAML 或替换既有自用 Key。明文只保存到指定 Keychain 项和 Git 工作区外的临时 `0600` 交付文件；用户取得后应删除交付文件。
- 原生 Key 验收不能停在 `/v1/models` 200：模型目录可能可见但推理仍无权。必须用新 Key 分别完成目录、目标模型真实推理和另一模型真实推理，并验证 Key 数量、无同名到期 timer、服务 active；长期原生 Key 不进入 CPA Menu 的插件美元余额卡是正常语义，不应伪造余额展示。
- 禁止把 `/v0/management/config` 或 `/v0/management/api-keys` 的完整响应输出到终端后再尝试正则脱敏；配置中可能同时包含顶层下游 Key 和多个上游供应商 Key，字段结构变化会造成漏脱敏。只在 VPS 内用 Python/YAML 解析并输出数量、布尔值、模型名等白名单字段，明文通过受限管道直接进入 Keychain 或目标 `0600` 文件。
- Codex 请求级统计优先读取 CLIProxyAPI 本地 `GET /v0/management/usage-queue?count=500`，Bridge 默认每 5 秒拉取并按小时持久化到 `/var/lib/cpa-desktop-bridge/usage.json`；该文件必须为 root-only `0600`，只保留最近 8 天。
- `usage-queue` 请求数可能包含重试、账号重选等上游尝试，不等同于用户对话轮数。总请求与 `usage_samples` 要分开统计；部分上游未返回 usage 时，浮窗必须显示 Token 覆盖率，不能把缺失 usage 解释成 0 消耗。
- 原始队列记录在进入持久化前必须丢弃 API Key、Token 指纹、IP/X-Forwarded-For、User-Agent、响应 Header 和错误正文；稳定 auth index 只用于 root-only 聚合与账号关联，Desktop API 只返回既有脱敏账号 ID。
- Fast 统计必须分开记录请求 `service_tier=priority/fast` 和响应 `response_service_tier=priority/fast`。验收至少同时证明请求档位、HTTP 状态、响应档位；请求 `priority` 但响应 `default` 时，实际命中必须记为 0。
- CLIProxyAPI Management Key 若只剩 bcrypt 哈希无法恢复明文。需要轮换时生成新随机值，只保存到 macOS Keychain 与 VPS `/etc/cpa-cliproxy-management.env`（`0600`），不得打印、下载或写入 Git/记忆。
- Management Center 登录出现 `HTTP 401` 时不要先轮换密钥：先在 VPS 内用 `/etc/cpa-cliproxy-management.env` 对 `127.0.0.1:8317/v0/management/config` 做只输出状态码的探针，再确认 macOS Keychain 与服务器当前值一致，最后按时间/IP 对齐公开 `/v0/management/config` 日志。VPS 本地 200、浏览器公开请求 401 通常是浏览器仍提交旧值或表单状态未真正更新，不是服务或配置失效。
- 自动恢复网页登录时必须先确认 Accessibility 焦点角色为 `AXTextField`；仅看到密码圆点、执行剪贴板粘贴或按回车，不代表 React 表单状态已更新或登录按钮已触发。优先逐字符输入以触发真实 input 事件，再激活登录按钮；登录后刷新页面并确认公开管理接口继续 200。密钥进入剪贴板后必须立即清空，浏览器额外密码保存提示默认关闭，避免增加新的凭据副本。
- 开启 usage statistics 的远端切换脚本要忽略 YAML section 内无缩进注释，并限制 run id 为 `[A-Za-z0-9._-]+`；终态不能只看成功 marker，还要验证 systemd result、三个服务、`8317/8327/8330`、真实请求和 Bridge 增量。
- HTTP 200 不是请求级统计验收充分条件；还要核对响应 ID、model、usage、服务端请求日志，以及 `/desktop/v1/summary` 和 `/desktop/v1/accounts` 的增量与敏感字段零命中。
- xAI 请求级 usage 本轮明确暂缓；继续保留官方 Billing/Prepaid 与 Smart Router 聚合两层语义，禁止把 Codex 队列采集逻辑顺手扩展到 xAI。
- CPA Menu 发布验收至少包括：`swift test`、Release 构建、结束旧进程后覆盖安装、核对 Bundle 版本、新进程启动时间、安装包与运行二进制 SHA-256 一致、`codesign --verify` 通过。

验证命令：

```bash
cd /Users/rayman.chen/mycc/2-Projects/cpa-menubar/bridge
go test -race ./...
go vet ./...

cd ../app
swift test
```

## 生产升级与自断线预案（2026-08-04）

CPA 是 Codex 当前连接链路的一部分，升级 `cliproxy` 或 `cpa-smart-router` 时不能依赖当前会话继续完成回滚：

1. **先锁基线**：记录三个 service 的 PID/启动时间/重启次数、监听端口、账号数量、健康 Codex 数、xAI 状态、rich model catalog 和低成本真实请求。
2. **root-only 备份**：二进制、配置、unit、auth-dir 和环境文件留在 VPS，目录 `0700`、敏感文件 `0600`，不下载、不打印正文。
3. **新版先旁路 canary**：Bridge 使用独立 `18330`，Router 使用独立 `18327`；确认 rich catalog、真实请求和账号基线后才允许动生产端口。
4. **远端自治切换**：通过独立 systemd job 原子替换并重启；可能影响当前 Codex 的 Router/CLIProxy 使用延迟 job，让当前回复先结束。Bridge 不影响 Codex，可先部署。
5. **双重回滚**：升级脚本任一验收失败立即恢复旧二进制；另设从升级开始计时约 120 秒的 watchdog，无终态 marker 时二次回滚。auth-dir 不自动回滚，避免覆盖已轮换的 refresh token。
6. **最终验收不能只看 marker**：同时验证生产 SHA-256、service active/PID、`8317/8327/8330`、内外网目录、公开真实请求、Bridge 账号与 xAI、近时段 panic/fatal。

推荐顺序：`CLIProxyAPI → Desktop Bridge → Smart Router`。2026-08-04 已按此顺序验证 CLIProxyAPI `7.2.116`；当时 5 个 Codex 中 4 个用量正常、原有 1 个 401，属于升级前后相同基线，后续仍须实时复核。

### 本次踩坑与防复发

- 备份二进制可以安全地设为 `0600`；回滚源只需存在且可读，升级前门禁用 `test -f`，不要用 `test -x`。`install -m 755 <backup> <staged>` 会恢复执行位。
- `git archive HEAD:<project>` 得到的源码没有 `.git`，Go 构建必须显式加 `-buildvcs=false`；同时把源码 commit 单独写入 root-only release metadata。禁止从含无关脏文件的主工作区直接构建生产二进制。
- macOS 一次性后台监控不要用裸 `launchctl submit`；该任务可能在退出后被 launchd 反复拉起，造成通知轰炸。若必须使用 launchd，提供 `KeepAlive=false` 的 plist 并在终态卸载；默认不发通知，只保留可查询日志/marker。
- zsh 的 `status` 是只读特殊变量，轮询状态使用 `result_state` 等名字；macOS BSD `date` 不支持 `date -Is`，统一用 `date '+%Y-%m-%dT%H:%M:%S%z'`。
- 任何 run id、目录名和 unit 名都要限制为 `[A-Za-z0-9._-]+`，禁止把终端颜色、Markdown 或控制字符拼进生产路径。
- Fast 验收继续拆分：请求是否携带 `priority`、HTTP 是否 200、上游回报档位。上游仍回 `default` 时只能称“意图已发送”，不能称“加速已确认”。

## CPA Menu 感叹号与 VPS 卡死排障

浮窗感叹号只是“Desktop Bridge 刷新失败”的汇总信号，不能直接归因于 App 或 Bridge。按以下顺序缩小故障域：

1. **本机层**：确认 `/Applications/CPA Menu.app/Contents/MacOS/CPAMenuBar` 进程存在、Bundle 版本正确、Keychain Token 存在；不要输出 Token。
2. **公网层**：分别测试 `https://smart-api.hahaxiong.top/desktop/v1/summary` 与 `/v1/models` 的 DNS、TCP、TLS 和 HTTP。无凭据 401 只能证明入口与鉴权门在线，不能证明 Bridge 或真实推理正常。
3. **主机层**：测试 `443`、SSH 端口和 SSH banner，再检查 `8317/8327/8330`。TCP connect 成功但 SSH banner/TLS handshake 同时超时，通常是主机 OS 已卡住，不是单纯 nginx 配置错误。
4. **控制面层**：先查 SWAS instance status、Cloud Assistant 和 CloudMonitor；实例显示 Running 但 Assistant 不在线时，结合 CPU、磁盘 IOPS、内存与 `sar` 判断是否为主机级资源故障。
5. **恢复层**：普通 reboot 超过合理窗口仍停在 Stopping，才使用 force reboot。开机后先隔离可疑旁路服务，确认 nginx/CLIProxyAPI/Router，再恢复 Bridge；不要一次性把全部服务同时拉起后只看 active。

关键取证与验收：

```bash
ssh aliyun-jp 'sar -u -f /var/log/sysstat/sa$(date +%d) | tail -20'
ssh aliyun-jp 'sar -b -f /var/log/sysstat/sa$(date +%d) | tail -20'
ssh aliyun-jp 'pidstat -d -u -p ALL 5 12'
ssh aliyun-jp 'systemctl is-active nginx cliproxy cpa-smart-router cpa-desktop-bridge'
ssh aliyun-jp 'ss -lnt | grep -E "[:](8317|8327|8330)[[:space:]]"'
```

- `GET /v0/management/usage-queue` 是 **destructive pop**。返回恰好 500 条时继续拉取是正确排空队列，不是重复读取；同一 CPA 实例只能保留一个消费者。
- 怀疑采集器热循环前，必须同时验证官方 handler 语义、服务端 `usage-queue` 请求时序、连续两次实机读取结果和 Bridge 进程 CPU/I/O。只看一段 `for` 循环不能定根因。
- 强制重启会丢失 `/proc` 活现场。若 SSH 尚可用，优先用 `pidstat -d`、`iotop -oPa`、`systemd-cgtop` 记录具体 reader；没有进程证据时只写“系统级 I/O 卡死，具体来源未知”。
- 最终恢复必须同时满足：四服务 active、端口监听、Desktop `summary`/`accounts` 带 Keychain Token 返回 200、敏感字段零泄漏、App 重启后感叹号消失、账号数据可见，以及至少 60 秒 CPU/内存/磁盘稳定观察。

## 构建部署

```bash
BUILD_ROOT="$(mktemp -d /tmp/cpa-clean-build.XXXXXX)"
git -C /Users/rayman.chen/mycc archive HEAD:2-Projects/cpa-smart-router | tar -x -C "$BUILD_ROOT"
cd "$BUILD_ROOT"
go test ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -buildvcs=false -trimpath -ldflags='-s -w -buildid=' \
  -o /tmp/cpa-smart-router ./cmd/router
go version -m /tmp/cpa-smart-router
sha256sum /tmp/cpa-smart-router
```

构建完成后按“生产升级与自断线预案”部署，禁止退化为无备份的直接覆盖重启。

## 当前实现状态

- 已验证 CPA `openai-compatibility.prefix` 能区分候选 provider：`ccsub2/...`、`gw1052/...`。
- 已支持 `/v1/chat/completions`、`/v1/responses`、`/v1/models`。
- 已支持鉴权、请求体上限、sticky、最多 2 次重试、被动 EWMA、熔断 cooldown。
- 已支持 JSONL 指标、SQLite 持久聚合、`/debug/summary`、`/dashboard` 和 provider 调度解释。
- 已支持 `/v1/responses` state probe 观测：`previous_response_id`、`store`、`stream`、response id 捕获率、parent/provider mismatch 和错误采样；当前只观测，不启用 strict response-chain sticky。
- 正式使用默认优先走 `gpt-5.5`；`fable-5` 只是测试玩具模型，生产配置应放入 `blocked_models`，不要调用。
- `/v1/chat/completions` 流式响应会注入 `stream_options.include_usage=true` 并解析 SSE usage；若上游不返回 usage，token 仍会是 0。

## 提交前检查

```bash
cd /Users/rayman.chen/mycc
git status --short
rg -n 'sk-[A-Za-z0-9_-]{12,}|CPA_SMART_ROUTER_KEY=.*[A-Za-z0-9_-]{12,}|CPA_API_KEY=.*[A-Za-z0-9_-]{12,}|Bearer [A-Za-z0-9._-]{12,}' \
  2-Projects/cpa-smart-router 4-Assets/Prompt/omp-team-templates/_codex_lane.sh .claude/skills/cpa-smart-router || true
```
