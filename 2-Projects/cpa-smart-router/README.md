# CPA Smart Router

CPA Smart Router 是部署在 `aliyun-jp` 的 CLIProxyAPI 旁路调度层：客户端先打本服务，本服务按候选上游的健康度、延迟、错误率、用量与 sticky 状态选择 CPA 的 prefixed model 或混合入口。

## 当前状态

- M-1：已验证 CPA `openai-compatibility.prefix` 可固定命中候选上游。
- M0/M1：Go 单二进制 MVP，支持 `/v1/chat/completions`、`/v1/responses`、`/v1/models`、`/v1/images/generations`、`/v1/images/edits` 转发、鉴权、sticky、熔断、异步 JSONL 指标。
- M2：支持 CST 日用量重置与鉴权状态查看 `/debug/state`。
- M3：支持 SQLite 持久聚合、`/debug/summary` 与简易 `/dashboard`。

## 运行

```bash
go run ./cmd/router -config config/router.example.json
```

配置里的 secret 推荐用环境变量：

- `CPA_SMART_ROUTER_KEY`：客户端访问 smart-router 的 key
- `CPA_API_KEY`：smart-router 访问本机 CPA 的 key
- `client_api_key_envs` 可加入 `CPA_API_KEY`，让客户端继续用个人 CPA key 访问 smart-router。

## 安全规则

- 公网入口必须校验 `Authorization: Bearer <CPA_SMART_ROUTER_KEY>`。
- 后端 CPA key 只在服务端注入，不透传客户端 key。
- 长期 API Key、Management Key 或密码的轮换/撤销必须由用户明确授权；疑似泄露只触发停止扩散与告警，不得自动替换凭据。OAuth access token 的既有自动刷新不受此限制。
- `blocked_models` 用于拦截测试/玩具模型；正式流量不要调用 `fable-5`。
- `gpt-5.3-codex` 是 Codex app 可能发出的模型名，router 将其别名映射到已验证的 `gpt-5.5` 上游候选，避免 CPA mixed 返回 unknown provider。
- 2026-09-22 xAI 文本主模型提升到 `grok-4.7`：显式注册 `grok-4.7` / `grok-4.7-latest`，`grok-4.6` / `grok-4.6-latest`、`grok-4.5`、`grok-4.3`、`grok-4.20-*` 和 `grok-3-mini*` 历史文本别名统一重写到 `grok-4.7`。09:29 完成 CPA 核心的全局 xAI OAuth 别名更新，CPA Direct 和 Smart API 均覆盖旧文本名，并提供稳定入口 `grok-latest`。图像、视频、Build 与 Composer 专用模型保持直通；独立 `grok-4.7-build-fast` 未做额外启用。
- 生产 CLIProxyAPI 已升级到 `7.3.11`，保留 `cpa-key-policy 0.4.4` 与原有资源保护、OAuth 调度和 Key 白名单。隔离 Canary 验证了 Grok 4.7 Chat/Responses、`high`/`xhigh`、SSE completed/usage、旧别名映射及 Codex 请求；实际 Grok 响应模型为 `grok-4.7-build`。7.3.11 内置目录没有 4.7，当前仍依赖远程模型目录，不能把在线成功视为离线兜底已完成。
- 本次发布、回滚路径、测试和启动就绪门修正见 `GROK47-UPGRADE-20260922.md`。浮窗“主模型”是当日历史请求聚合，不应把未清零的 4.6 历史统计改写成 4.7；后续请求会自然进入 4.7 统计。
- 全局别名真源模板为 `config/xai-latest-aliases.example.yaml`，通过官方管理接口 PATCH `oauth-model-alias` 的 `xai` channel 触发运行时 reload hook。不能把原子替换配置文件当作热加载成功；必须验证运行时目录和实际响应。原生 Key 的旧名请求直接报告 `grok-4.7-build`；插件受限 Key 的非流式响应可能为兼容客户端而回写旧别名，须用不重写的流式完成事件验证真实上游模型。
- `grok-latest` 当前固定指向已验收的 4.7，不会未经测试自动追逐新发布型号。现有受限 Key 的允许模型/RPM/额度不扩充，继续使用原有允许的旧别名即可调用最新后端；未来若增加 xAI API Key 或第三方兼容后端，需要另行验证该通道，不把 OAuth 别名机制泛化到所有上游类型。
- 流式响应开始输出后不做 failover。
- `/v1/chat/completions` 流式请求会自动注入 `stream_options.include_usage=true` 并解析 SSE usage，用于 dashboard 和调度用量统计。
- `/v1/responses` 强制 sticky，避免 `previous_response_id` 断链。
- Default backend 若明确返回 `503 auth_unavailable` / `no auth available`，可通过 `auth_unavailable_retries` 与 `auth_unavailable_retry_delay_ms` 做同后端有界重试；生产使用 2 次、每次等待 6 秒，与 CLIProxyAPI 12 秒 transient cooling 对齐。普通 503 不重试，避免放大真实上游故障。
- `/v1/responses` 当前先启用 state probe 观测，不改变路由；M1 门控看 `previous_response_id` 占比和 response id 捕获率。
- 图片生成与编辑端点透明转发到默认 CPA 后端，保留 JSON 或 multipart 请求体、查询参数与响应类型；图片模型不进入文本模型调度、sticky 或 token 用量统计。
- Codex 网站验收可能携带 32 MiB 以上的图片、截图或上下文；Nginx `client_max_body_size` 与 Router `body_limit_bytes` 必须统一为 64 MiB。只提高一层会在下一层继续返回 413；验证使用大体积无效模型请求，预期应穿透到模型路由错误而不是产生付费推理。

## 灰度接入

`4-Assets/Prompt/omp-team-templates/_codex_lane.sh` 支持以下开关：

- `CODEX_API_SMART_BASE_URL`：smart-router base URL。
- `CODEX_API_SMART_KEY`：smart-router 客户端 key。
- `CODEX_SMART_CANARY_PERCENT`：0-100，命中时先试 smart-router，失败自动回原网关链。

## 观察

```bash
curl https://smart-api.hahaxiong.top/debug/state \
  -H "Authorization: Bearer $CPA_SMART_ROUTER_KEY"
curl https://smart-api.hahaxiong.top/debug/summary \
  -H "Authorization: Bearer $CPA_SMART_ROUTER_KEY"
ssh aliyun-jp 'tail -n 20 /opt/cpa-smart-router/router-metrics.jsonl'
```

## Dashboard

- `/dashboard`：简易 HTML 聚合页，支持 `Authorization: Bearer <key>`；浏览器可用 Basic Auth，密码填同一个 key。
- `/debug/summary?hours=24`：JSON 聚合，字段包含总量、调度解释、按 provider、按 model、最近错误。
- `Responses State Probe`：观测 `previous_response_id`、`store`、`stream`、response id 捕获率、provider mismatch 和错误样本；只观测不强制 sticky。
- `sqlite_path` 为空时禁用 SQLite 聚合；生产建议写到 `/opt/cpa-smart-router/router.sqlite`。
- JSONL 指标仍保留，SQLite 写入走后台 channel，不阻塞流式转发路径。

## 主机资源保护（2026-08-12）

`aliyun-jp` 是 1 GB 内存的轻量实例。`scripts/cpa-resource-guard.sh` 每 30 秒限制 Aegis 安全扫描 cgroup 的 CPU、内存与磁盘调度优先级，并在 IO 压力或低内存时记录进程级证据。

- 部署单元：`deploy/cpa-resource-guard.service`、`deploy/cpa-resource-guard.timer`。
- 压力日志：`/var/log/cpa-resource-guard.log`，由 `deploy/cpa-resource-guard.logrotate` 控制大小。
- Cloud Assistant 保持不限流，但系统 OOM/IO 卡死时仍可能无法执行命令。CloudMonitor 使用 `deploy/cloudmonitor-cpa-resource-guard.conf` 限制为 CPU 20%、读盘 200 IOPS / 2 MB/s；高读盘采样不能单独证明它是故障触发源。
- K12 账号池已于 2026-08-12 退役；生产与代码仓不再保留账号源、历史账号、轮换脚本或定时器。

### 长上下文内存保护（2026-09-17）

- 11:14:21 内核记录全局 OOM，杀掉 `cli-proxy-api`；当时 CPA RSS 约 393 MiB、Router 约 224 MiB，主机可用物理内存总量仅 894 MiB。故障前连续 Responses 请求约 24–26 万输入 Token，长上下文负载是有证据支持的主要诱因；尚未做堆分析，不能断言具体泄漏函数。
- `/etc/sysctl.d/99-sysctl.conf` 链接到 `/etc/sysctl.conf`，其中旧 `vm.swappiness=0` 覆盖 `99-cpa-memory.conf` 的 10，OOM 时 2 GiB swap 全空。已统一两个配置源为 10，并检查 `/proc/sys/vm/swappiness`。只看 swap 文件存在或单个配置文件不算生效。
- `deploy/cpa.slice` 限制三项 CPA 工作负载合计内存 576 MiB、swap 1 GiB、CPU 160%（双核上预留部分 CPU 给系统）。`MemoryMax` 是故障隔离，极端负载仍可能使单个服务重启；不代表 1 GiB 主机已通过任意长上下文压力验收。
- 将 `deploy/cliproxy-memory.conf`、`deploy/router-memory.conf`、`deploy/bridge-memory.conf` 分别安装到对应 unit 的 `30-cpa-memory.conf` drop-in。Go `GOMEMLIMIT` 分别为 256/128/48 MiB，服务硬上限为 384/256/96 MiB；Go 软目标不能代替 cgroup 硬边界。
- Slice 与 Go 环境变量需在 `daemon-reload` 后重启对应服务才能生效。发布前保留配置，设置独立回滚 watchdog，验收服务 cgroup、进程环境、Desktop 鉴权请求和真实流式推理后再撤销 watchdog。
- 本次备份位于服务器 `/root/cpa-ops-backups/20260917-114127-memory-recovery`。验证结果：Desktop 直连/代理四次 200，真实 Sol 流式完成并返回预期结果，60 秒无新增 OOM，CPU idle 86–98%；未重放故障时的完整私有长上下文。

## Codex OAuth 自动刷新（2026-07-27）

生产 CLIProxyAPI 已开启核心 auth 自动刷新：`auth-auto-refresh-workers: 16`（配置位于 `aliyun-jp:/opt/cliproxy/config.yaml`）。

要点：

- 只有 auth 文件内存在 `refresh_token` 的 Codex OAuth 授权才可自动续期。
- 刷新线程日志应出现 `core auth auto-refresh started (interval=15m0s)`。
- 配置修改后需重启 `cliproxy.service`，并用低成本 `gpt-5.4-mini` / `gpt-5.5` 请求确认仍返回 200。
- 不要把 `access_token`、`refresh_token`、`id_token`、API key 或响应正文写入 git、记忆、通知或 Grok payload。

## Codex Fast 模式（2026-07-28）

- Codex 客户端配置使用 `service_tier = "fast"`，实际 `/v1/responses` 请求应发送 `service_tier: "priority"`。
- CLIProxyAPI 的 Codex 专用模型目录接口是 `GET /v1/models?client_version=<version>`；响应中的 `service_tiers` 与 `additional_speed_tiers` 是客户端是否发送 Fast 意图的能力真源。
- smart-router 转发模型目录和推理请求时必须保留 `r.URL.RawQuery`；丢失 `client_version` 会让 CPA 降级返回普通四字段模型列表，导致本地 catalog 看不到 Fast。
- 受 Git 管理的刷新器维护源是 `scripts/refresh-cc-switch-model-catalog.mjs`；运行 `scripts/install-air-codex-runtime-guard.sh` 后，本机 LaunchAgent 每 5 分钟刷新，并为 launchd 会话设置 Node/Codex 所需 PATH。安装前备份已有运行脚本和 plist；不改模型、鉴权或推理配置。
- Codex App 只读取 `~/.codex/cc-switch-model-catalog.json`，不会主动选择 `.bak-*`。若主文件曾被缩水目录覆盖，App 会在启动时缓存缺少模型、推理档位和速度元数据的状态；恢复完整文件后还必须重启 App。刷新器必须先做模型数量防缩水校验，再通过临时文件原子 rename，异常时保留上一份完整目录；少于 12 个模型的旧备份不得保留。
- GUI App 的 PATH 可能只有系统目录。若 `codex` 是 `#!/usr/bin/env node` 的 npm shim，终端可运行不代表 GUI 可运行；必须用最小 GUI 环境复测。部分 App 会清理继承的 PATH，runtime guard 设置成功不等于目标进程必然生效，仍需核对目标进程环境与运行时检测；这也不能单独证明原始 Node ESM 报错的原因。
- 验收必须分开记录：客户端请求是否携带 `priority`、CPA 是否返回 HTTP 200、上游响应回报的 service tier。当前真实请求已携带 `priority`，但上游流式响应仍回 `auto/default`，不得把“请求已发出”写成“后台加速已确认”。
- 生产 CLIProxyAPI 已于 2026-09-15 通过空 auth-dir 隔离 Canary、插件兼容、Codex/Grok 真实请求和 watchdog 回滚门升级到 `7.3.3`。当前 transient error cooling 显式为 12 秒，credential retry 为 3 轮、单轮全部凭据、最大等待 12 秒；升级新版本仍须独立回归，不能直接覆盖生产。
