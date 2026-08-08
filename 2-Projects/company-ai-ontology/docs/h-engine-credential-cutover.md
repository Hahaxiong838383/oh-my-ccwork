# 公司 H 引擎正式凭据切换流程

更新时间：2026-08-08（Asia/Shanghai）

## 当前临时状态

- QNAP Agent Core 通过 HMAC 调用 dev198 的公司 H Engine Worker。
- Worker 复用现有 H 平台 Grok OAuth 文件，但不复制、不打印、不提交 OAuth 内容。
- Worker 使用独立工作目录、请求临时文件、并发限制和禁用 Web Search/Memory/Subagent 的最小执行参数。
- 当前健康状态应显示 `credentialMode=existing-h-platform-oauth`；这是临时生产联调状态，不是正式凭据隔离完成。

## 正式目标

正式方案使用独立公司凭据根，不与员工私人 Bot 或 H 平台 owner Runtime 共用 HOME、Grok HOME、会话、记忆和刷新生命周期：

```text
/srv/h-platform/company-agent-home/
└── .grok/
    └── auth.json  # 仅在 dev198 本地，0600，不进入 Git/文档/日志
```

Worker 配置切换为：

```text
H_ENGINE_WORKER_CREDENTIAL_MODE=company-dedicated-oauth
H_ENGINE_WORKER_HOME=/srv/h-platform/company-agent-home
GROK_HOME=/srv/h-platform/company-agent-home/.grok
```

## 川哥回来后的配置流程

1. 我在 dev198 创建独立 HOME、Workspace 和 600 权限环境文件，不触碰现有 H 平台凭据。
2. 川哥只完成一次交互式公司账号登录；登录凭据直接落到独立 `.grok/auth.json`，不经过聊天和剪贴板回传。
3. 我校验文件属主、权限、有效期和刷新能力，仅输出脱敏状态。
4. 将 Worker 的三项配置切换到 `company-dedicated-oauth`，重启 Worker。
5. 验证 Worker `/readyz`、QNAP Agent Core `/readyz` 均显示正式凭据模式和 `productionReady=true`。
6. 运行权限化知识正向测试、无权限员工负向测试、超时、并发 2、Worker 重启和 H-Lite 送达测试。
7. 川哥用公司 Bot 完成一条真实问答；确认回答、飞书送达和权限边界后，临时复用模式才算退出。

## 回滚

- 切回 `existing-h-platform-oauth` 的 HOME/Grok HOME 指针并重启 Worker。
- 不复制或移动任何 OAuth 文件；正式凭据目录保留在 dev198 本地等待排查。
- QNAP Agent Core、H-Lite、Ontology 数据和员工私人 Bot 均不回滚、不切换 Consumer。

## 验收标准

- `credentialMode=company-dedicated-oauth`。
- QNAP Agent Core `productionReady=true`、`restart_count=0`。
- 有权限 Principal 能获得知识 Evidence 并由 H 引擎正确回答。
- 无权限 Principal 返回空 Evidence，标题、摘要和正文均不泄露。
- 员工私人 Bot 会话、OAuth 文件、事件订阅和健康状态无变化。
