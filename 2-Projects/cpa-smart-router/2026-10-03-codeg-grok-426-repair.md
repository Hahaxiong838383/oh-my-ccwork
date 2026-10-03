# Codeg Grok 426 修复记录（2026-10-03）

Codeg Grok 的版本拒绝已修复。日本生产 CLIProxyAPI 从 `7.3.11` 升级到官方 `8.0.12` 后，公开网关推理与两次 Codeg 正常 API/WS 会话均完成。根因是网关发给上游的客户端版本头过旧。本机实际 Grok CLI 为 `1.0.41`。

本记录对应事件 `codeg-grok-426-20261003`。脱敏证据见 [validation.json](./2026-10-03-codeg-grok-426-validation.json)，证据归档快照时间为 `2026-10-03 11:47:16 CST`。请求正文、响应正文、凭据、完整配置和备份内容未纳入归档。

## 根因证据

Codeg 提示 `426 Upgrade Required`，错误文本称 Grok CLI `0.2.120` 过旧。本机运行、原生安装与 npm 安装的 Grok 二进制实际均为 `1.0.41`，三份 SHA256 一致：

```text
9ce03ed23e16ea01072b4496263d6213a27899e1e3e107f008d36edf82e70407
```

绕过 Grok CLI，直接请求同一 smart-api 网关也复现相同版本拒绝，说明故障仍存在于网关链路。核对 CLIProxyAPI 实现后确认：

| 组件版本 | 发往 xAI 的 `x-grok-client-version` | 本次结论 |
| --- | --- | --- |
| 生产 `7.3.11` | `0.2.120` | 触发上游版本拒绝 |
| 官方 `7.3.20` | `0.2.120` | 不能修复此根因 |
| 官方 `8.0.12` | `1.0.44` | 真实推理通过 |

错误中的版本来自网关声明，不能据此认定本机 CLI 版本。此次修复未重装 Codeg SDK、改 Grok 权限或代理设置，也未改已冻结的 Codeg Mesh APK。

## 部署与兼容验证

升级使用 [CLIProxyAPI 官方 v8.0.12 发布包](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.12)，下载资产为 `CLIProxyAPI_8.0.12_linux_amd64.tar.gz`，完成官方摘要校验。

| 产物 | SHA256 |
| --- | --- |
| 官方压缩包 | `433cea2c608cdb19bb22d22ea4041ee691dbeeacf38695f385a702b6b8682f7d` |
| 新生产二进制 | `2532add5faa6babb8f1314e3e11a48c8f39f925695773a772eb4564b674f6930` |
| 旧生产二进制 | `51a38dc5dfb387e880516f1d3ff78dd8d70508956a6d40ab3a627f10eeceb142` |

切换前保留 root-only 备份，使用隔离 canary 验证既有配置与 `cpa-key-policy`。临时 OAuth 副本去除 refresh token，插件状态单独隔离；canary 的 Grok 普通响应、SSE 流式响应及 Codex 推理均返回预期内容。生产切换通过独立 systemd job 和 120 秒 watchdog 执行，运行中二进制 SHA 与已校验发布产物一致。

生产验收记录如下：

| 验收项 | 结果 |
| --- | --- |
| 原生、公开、rich 模型目录 | 各 39 个模型 |
| `cpa-key-policy` | registered、effective_enabled，2 个 Key |
| OAuth 状态 | Codex 2 active；xAI 1 active、1 disabled，保持基线 |
| Desktop Bridge | 4 个账号均可刷新 |
| 公开 Grok 推理 | 请求 `grok-4.7`，响应 `grok-4.7-build`，completed，1470 tokens，3.66 秒 |
| 公开 Codex 推理 | `gpt-5.6-luna`，completed，27 tokens，1.36 秒 |
| 服务状态 | cliproxy、cpa-smart-router、cpa-desktop-bridge、nginx 均 active；归档快照中重启计数均为 0 |

生产配置和 OAuth auth-dir 保留。canary 已停止，临时凭据、配置及插件状态副本已清理，root-only 备份和验收证据仍保留。

## Codeg 正常机制验收

测试使用 Codeg 正常命令入口 `/api/open_folder`、`/api/acp_connect`、`/api/acp_prompt` 与 `/ws/events` attach，先注册临时工作区，再向连接发送带 `folderId` 的提示词。验收同时检查实际回复内容和 `turn_complete`，没有把 HTTP 命令确认当成推理完成。

| 验收 | 模型 | 预期内容匹配 | `content_delta` | `turn_complete` | stop reason | 整轮耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| 首次 | `grok-4.7` | 是 | 7 | 1 | `end_turn` | 3.992 秒 |
| 复查 | `grok-4.7` | 是 | 7 | 1 | `end_turn` | 5.931 秒 |

原失败会话也通过当前连接的只读 WS snapshot 确认 `connected`、`selectors_ready=true`、无待处理权限请求。各次测试创建的连接和工作区均已关闭。

这些是单条短提示词的真实功能验收，耗时包含对应测试的连接到回复完成过程；没有验证手机网络、长上下文或并发负载，不能据此推导它们的延迟或吞吐。

## 运维证据与恢复边界

服务器保留目录：

```text
aliyun-jp:/opt/cliproxy/upgrades/20261003-grok-8012-092359/
```

目录内保留 `metadata.json`、`staged/metadata.json`、`production-verification.json`、`codeg-verification.json`、`codeg-recheck-verification.json`、`canary/compatibility.json`、`canary/inference.json`、`verify.py`、`switch.py`、`rollback.py`、`backup/` 与 `SUCCESS`。备份目录和文件仅 root 可读，权限分别为 0700/0600；不要把原始文件整体复制入 Git 或记忆。

`rollback.py` 服务于本次升级未完成或失败的恢复流程；存在 `SUCCESS` 时会跳过执行，不能把它当作升级成功后的无条件回退命令。后续若需回退，应先读取备份元数据、核对现网状态，再确定二进制和服务恢复步骤。OAuth 刷新可能已推进凭据状态，不能自动用旧备份覆盖 `/root/.cli-proxy-api`。

## 经验教训

1. 代理链路宣称「客户端版本过旧」时，先核对实际运行二进制版本与 SHA，再用绕过 CLI 的同网关请求区分故障层。修复实际声明旧版本的网关组件。
2. 选择升级版本前核对相关实现。此次较新的 `7.3.20` 仍发送旧头，只有确认头值更新并通过真实推理的候选才适合切换。
3. Codeg HTTP 命令入口是 `/api/<command>`；新会话提示词必须有有效 `folderId`，通过 `open_folder` 注册临时工作区。
4. 本次运行中的 `acp_list_connections` 可能继续显示 `connecting`，而 WS snapshot 已 connected。就绪判据需检查 WS 状态、selectors 和 `session_started`，完成判据需检查真实内容及 `turn_complete(end_turn)`。
5. 网关升级前验证配置、插件、目录与真实普通/流式推理；升级后再次走用户实际使用的 Codeg 链路。将功能验收与手机延迟、长上下文及负载测试分开记录。

署名：codex（OpenAI）| 2026-10-03（CST）
