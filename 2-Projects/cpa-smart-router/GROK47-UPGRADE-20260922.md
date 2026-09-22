# CPA Grok 4.7 适配与 CLIProxyAPI 7.3.11 升级

## 范围

用户授权在已验证 Grok 4.7 可调用后更新适配。本轮升级日本 CLIProxyAPI 二进制及 Smart Router 的文本模型映射，并更新 Air 的目录排序；不改服务器账号、API Key、插件白名单、账本、Codex 默认模型、图片/视频专用模型或 macOS App 二进制。

| 层级 | 结果 |
| --- | --- |
| CLIProxyAPI | 7.3.3 → 7.3.11，官方 Linux amd64 插件版，校验官方 checksums.txt |
| cpa-key-policy | 保持 0.4.4，隔离与生产均正常加载；keys/aliases 配置逐项比对未改变 |
| Grok 文本主路由 | grok-4.7，响应报告 grok-4.7-build |
| 显式入口 | grok-4.7、grok-4.7-latest |
| 旧文本入口 | grok-4.6、grok-4.6-latest、grok-4.5、grok-4.3、grok-4.20-*、grok-3-mini* → 4.7 |
| 专用型号 | Imagine 图片/视频、Build、Composer 不做强制重写；未启用独立 4.7 Fast 型号 |
| Air 目录 | Grok 4.7 排在其他 Grok 文本模型之前；用户现有默认模型优先级仍最高 |

首阶段别名重写只属于 Smart Router；09:29 的后续全局 xAI OAuth 别名更新已补齐 CPA Direct，详见末节。受限 Key 的允许模型集合没有扩充，原有允许的旧文本别名会调用最新后端。

## 验证

- Router `go test -race ./...`、`go vet ./...` 通过；新增 Chat Completions/Responses 双协议的 6 个别名子场景，验证实际转发 model 和回写的 usage/响应模型归因。
- 11 个配置文本入口均指向 4.7；回归断言媒体、Build、Composer 和独立 Fast 型号不进入强制重写表。
- Node 目录脚本语法与排序检查通过，保留已有用户默认模型及防缩水门禁。
- 新版 CLIProxyAPI 在 18317、Router 在 18327 隔离运行；临时 OAuth 副本仅保留同机有效 access，不携带 refresh credential，插件状态文件也使用副本。未启动第二个生产 usage-queue 消费者。
- 六项真实 Canary 全过：4.7 Chat high、4.7 Responses xhigh、gpt-5.6-sol Responses、旧 4.6/4.5 Chat → 4.7、4.7-latest Responses；均验证 200、正确算术回复、实际模型、usage，流式还须有 completed。
- 正式切换于 **2026-09-22 08:24:12 CST** 验收：旧 4.5 Chat → 4.7、4.7 Responses 流式、Codex Sol Responses 均通过；Bridge summary/accounts 200；独立 watchdog 停止。
- 切换后 Air 使用正式个人 `CPA_API_KEY` 从公网验证了 `grok-4.6` 和 `grok-4.7-latest`：均 200，分别约 1.70 / 2.05 秒，实际响应为 `grok-4.7-build` 且回复/usage 正常。带鉴权 rich catalog 返回 4.7、500k、文本/图片及 low/medium/high/xhigh；本机目录含 18 个模型，4.7 排在其他 Grok 文本模型前。
- 08:26–08:27 连续观察 60 秒，四服务一直 active，CPA slice 的 max/oom/oom_kill 均为 0，内存约 171–182 MiB；主机可用内存约 455 MiB，swap 使用约 71 MiB。Bridge 的 Codex/xAI 采集状态均 ok，原有 2 Codex + 2 xAI（其中 1 xAI 停用）数量保留。
- 隔离 Canary 已停止，含临时 access、API 配置及插件状态副本的 canary 目录已移除。仅保留 root-only 回滚、发行包与不含凭据的验证回执，未触碰生产 auth-dir。

这不是长上下文压力或完整图片输入验收。目录声明的 500k 上下文及图片能力不应当作本轮负载实测结果。

## 回滚及现场记录

远端 root-only 目录：

```text
/root/cpa-upgrades/grok47-20260922/
```

- `manifest.json`：新旧二进制、原始 Router/CPA 配置与发行包校验值。
- `backup/cliproxy`：7.3.3 二进制；`backup/router.json`：升级前生产路由。
- `backup/cliproxy-config.yaml`：配置审计备份，本轮未修改生产该文件。
- `next-cli-proxy-api`：7.3.11 二进制，SHA-256 `51a38dc5dfb387e880516f1d3ff78dd8d70508956a6d40ab3a627f10eeceb142`。
- `canary-results.json`、`accepted.json`：隔离及正式业务验收记录，不含密钥或完整账号。
- `cleanup.json`：临时 Canary 凭据与配置副本清理记录及操作脚本 SHA。
- `operations.py`：本次独立部署及回滚入口。该目录不下载、不提交 Git，不把里面的配置或账号文件放入知识库。

需要回滚时，先评估活动请求，再经 SSH 执行：

```sh
python3 /root/cpa-upgrades/grok47-20260922/operations.py rollback-force
```

仅恢复 CLIProxyAPI 二进制和 Router 配置，并重启这两个服务；不回滚 auth-dir、最新 OAuth Token、插件账本或 Key 配置。保留 9 月 17 日上线的内存/CPU/swap 限额。

Air 刷新器旧版备份（本次官方补充目录请求失败时已按原设计回退本机缓存，CPA 实际模型目录仍成功刷新；未改变默认模型或重启客户端）：

```text
~/.codex/backups/grok47-catalog-20260922-082004/refresh-cc-switch-model-catalog.mjs
```

## 发布中修正的门禁

1. 首次切换在 systemd active、HTTP 监听尚未建立的瞬间遇到 ConnectionRefused，已自动恢复旧二进制和路由。验收门改为有界等待带鉴权模型接口就绪，不把进程 active 等同于业务就绪。
2. 第二次在修改生产前因 Canary oneshot 已退出并被 systemd 回收而停止；生产未变。清理步骤改为先查 active，已停止/不存在视为满足条件，不要求再次 stop 成功。
3. 第三次通过相同独立回滚保护完成。180 秒 watchdog 和部署服务不依赖当前客户端连接；最终 accepted、服务、SHA 和业务请求分别验证。
4. Grok 4.7 对“Reply exactly OK.”探针曾给出有意拒绝文本，HTTP/模型/SSE/usage 均正常。最终改用普通算术问题并验证答案 4，没有把非 2xx、缺 completed 或缺 usage 当作通过。

## 交付状态

生产 CLIProxyAPI 已更新至 7.3.11，本机模型目录已刷新。08:24 第一阶段仅更新模型路由时保留 CPA Menu 0.4.1(13)，没有重启 App 或重新进行账号授权；后续状态以本节及全入口灰度记录为准。

后续用户截图指出“主要模型4.5”歧义，已单独发布 CPA Menu 0.4.2(14) 与 Bridge 展示字段补丁，将当前 Smart API 路由目标和今日最多请求型号分开，保留原历史计数；见 `../cpa-menubar/docs/RELEASE-0.4.2.md`。这不改变上述模型适配或 Key 权限。

09:29 全局 xAI OAuth 别名经官方管理接口热加载通过，09:31 公网 Direct/Smart 旧型号及 `grok-latest` 均返回真实 4.7。用户随后授权更新记忆与 commit/push；代码、测试及两项目交付文档在隔离工作树按明确文件清单共同收口，提交号以 Git 历史和本机 `release-receipt.json` 为准，不夹带其他任务改动。

## 全入口最新优先：09:29 已通过灰度并热加载上线

以下保留容量故障时的调查经过；**最新状态以本节末的恢复验收记录和远端 `accepted.json` 为准，已不再是待部署状态。**

用户进一步要求所有普通 Grok 文本入口默认优先最新型号。实测旧名 `grok-4.5` 在 Smart API 返回 `grok-4.7-build`，但 CPA Direct 仍返回 `grok-4.5-build`。因此不只是展示问题：前一阶段仅更改 Smart Router，未覆盖 CPA 核心的 OAuth 模型别名。生产 Key 插件的文本 alias 目标也保持旧名。

准备方案为 CLIProxyAPI 原生 `oauth-model-alias.xai`：以 4.7 为上游，提供 grok-latest、grok-4.7-latest 和旧文本入口，`fork: true` 保留原模型入口。不启用 `force-mapping`，因为该字段会把真实响应模型重新标成客户端旧别名，并不是“强制选择最新模型”的开关。媒体、Build、Composer 不加入此映射。

09:00 容量故障期间的历史状态为 **prepared_not_deployed**，当时并未完成：

- `config/xai-latest-aliases.example.yaml` 已落盘；远端 root-only 准备目录 `/root/cpa-upgrades/xai-global47-20260922/` 保存原配置、候选配置、哈希和 `pending-upstream-capacity.json`。
- 隔离实例注册了 11 个别名，旧 4.5 请求的上游选择日志已变成 4.7，但上游没有给出完整响应，Canary 业务门未通过。
- 生产未修改映射的原始 4.7 请求也失败；09:00 CST 的 4.7 high、4.6 low 返回 HTTP 200 后的 SSE error，明确说明高需求导致模型容量满载，没有 completed 或 usage，不能以 HTTP 200 当成功。
- Grok-only 插件限制使用相同规则的临时 loopback 测试 Key 准备验证，但因首项上游请求失败尚未完成该门；没有创建任何生产 Key，也没有扩充现有 Key 白名单。
- 生产 config.yaml 和 Key 规则哈希保持不变，四服务 active；Canary 已停止，临时 access 与测试 Key 副本已删除。

当时的恢复计划是先复验生产原始 4.7，再重建短时 Canary，验证 Direct 旧型号/稳定别名均返回真实 4.7，以及插件 Grok-only Key 能调用旧别名但仍拒绝非 Grok。原计划通过原子写配置检查热加载，后被下述验收证据纠正为官方管理接口；不要为了消除浮窗中的旧请求标识，清空历史或虚报实际响应型号。

### 恢复后验收与启用

- 09:08 生产 4.7 在 Direct/Smart API 的 Chat/Responses 共四项复测通过后，用户明确要求继续灰度。
- 新 Canary 使用同机 access-only OAuth 副本；按现有 Grok-only Key 规则生成仅限 loopback Canary 的临时测试凭据，不创建生产 Key。7 项正向验收全部通过，非 Grok 的 gpt-5.6-sol 请求仍返回 401。
- 原生 Key 请求 grok-4.5、grok-4.6、grok-latest 均返回 grok-4.7-build；插件测试 Key 的 grok-4.5、grok-3-mini-fast 流式请求也返回 grok-4.7-build、completed、正常答案与 usage。
- **兼容别名不等于实际模型**：cpa-key-policy 的 `interceptResponse` 有意将非流式顶层 model 回写为客户端 alias；因此受限 Key 的普通响应仍可能显示 grok-4.5。插件不改写流式响应，本轮以流式真实模型验证后端，未禁用该兼容行为。
- 首次直接原子替换 YAML 未触发运行时别名生效，被就绪门拦截并恢复旧配置，无服务重启。最终使用官方 `PATCH /v0/management/oauth-model-alias`（channel=xai、11条 aliases），经 reload hook 生效。
- **2026-09-22 09:29:28 CST** 正式验收成功：Direct 旧 4.5 Chat、旧 4.6 Responses 和 grok-latest Responses 均命中 4.7，约 1.31 / 1.22 / 1.41 秒，答案和 usage 完整。CLIProxyAPI PID 保持 136915，无重启；Key 规则与其他配置逐项确认不变，watchdog 已停止。
- 稳定入口 grok-latest 当前指向已验收的4.7；后续升级应复用验收门更新该指针，不让目录发布事件未经验证直接改变所有流量。

### 全局别名回滚

正式操作脚本为 `/root/cpa-upgrades/xai-global47-20260922/management-deploy.py`，回执为同目录 `accepted.json`、`canary-results.json`、`public-acceptance.json`。早期文件替换方式的 `deploy.py` 仅作失败尝试审计，不再用作当前回滚入口。

需要撤销本轮全局映射时，先确认当前 xAI 别名没有后续变更，再执行：

```sh
python3 /root/cpa-upgrades/xai-global47-20260922/management-deploy.py rollback-force
```

该脚本通过官方管理接口仅移除本轮 xAI 别名，不覆盖整个 YAML、不回滚 Token、Key 或账本；如果别名已被后续版本修改会拒绝覆盖。撤销后 Direct 恢复按原名调用，Smart Router 的4.7规则仍保留。若需撤销更早的 CLIProxyAPI/Router 升级，应先撤销本轮全局别名，再按前节版本回滚步骤执行，避免新旧映射叠加。
