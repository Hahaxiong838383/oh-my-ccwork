# 公司 H 引擎 CPA 凭据与模型切换流程

更新时间：2026-08-08（Asia/Shanghai）

## 当前生产状态

- QNAP Agent Core 通过 HMAC 调用 dev198 的 `company-h-engine-worker`。
- Worker 继续以 Grok Build CLI 作为 Agent Runtime，不绕开 Grok Build 直接请求模型 API。
- Grok Build 使用独立 HOME、Grok HOME 和自定义模型配置，通过 CPA OpenAI 兼容入口调用 `grok-4.5`。
- CPA API Key 只保存在 dev198 的 0600 环境文件；QNAP、Git、文档、日志和记忆均不持有明文。
- 当前运行状态为 `credentialMode=cpa-api-key`、`provider=cpa-openai-compatible`、`model=grok-4.5`。

## 配置结构

```text
/srv/h-platform/company-agent-home/
└── .grok/
    └── config.toml  # 无明文密钥，0600

/srv/h-platform/config/
└── company-h-engine-worker.env  # 含 CPA_API_KEY，0600
```

Worker 配置：

```text
H_ENGINE_WORKER_CREDENTIAL_MODE=cpa-api-key
H_ENGINE_WORKER_PROVIDER=cpa-openai-compatible
H_ENGINE_WORKER_MODEL=grok-4.5
H_ENGINE_WORKER_GROK_MODEL=cpa-grok-4-5
H_ENGINE_WORKER_HOME=/srv/h-platform/company-agent-home
GROK_HOME=/srv/h-platform/company-agent-home/.grok
CPA_API_KEY=<仅远端 0600 环境文件>
```

Grok Build 自定义模型必须使用独立别名 `cpa-grok-4-5`，再通过 `model = "grok-4.5"` 映射上游模型。若自定义模型与内置模型同名，Grok Build 会优先走内置 xAI 鉴权，导致 CPA Key 被错误发送到 xAI 官方入口。

## 模型升级流程

1. 使用 CPA Direct 的实时 `GET /v1/models` 获取当前可调用模型，不从旧文档或记忆猜测。
2. 用 xAI 官方模型文档和 Grok Build 官方自定义模型文档交叉核对。
3. 先在隔离临时 HOME 中运行 Grok Build 最小推理，验证模型别名、协议和凭据解析。
4. 更新无密钥的 Grok Build `config.toml` 与 Worker 的模型元数据。
5. 重启 Worker，依次验证 `/readyz`、真实 HMAC 推理、请求临时文件清零和 `NRestarts=0`。
6. 验证 QNAP Agent Core `/readyz` 继续为 `productionReady=true`，再做公司 Bot 真实问答。

## 回滚

- 首选：恢复 `/srv/h-platform/config/company-h-engine-worker.last-backup` 指向的环境文件与 Worker 文件备份，重启 Worker。
- OAuth 兜底：切回 `existing-h-platform-oauth` 或已完成独立登录的 `company-dedicated-oauth`。
- 回滚只影响公司 H Worker；QNAP Agent Core、H-Lite、Ontology 数据和员工私人 Bot 不切换 Consumer、不迁移会话。

## 验收标准

- Worker `/readyz` 返回 `credentialMode=cpa-api-key`、`provider=cpa-openai-compatible`、`model=grok-4.5`。
- 真实 HMAC 推理返回预期文本，且 runtime 元数据与 `/readyz` 一致。
- Prompt 临时目录无残留，Worker 与 Agent Core `restart_count/NRestarts=0`。
- 有权限 Principal 获得 Evidence 并正确回答；无权限 Principal 的标题、摘要和正文零泄露。
- 员工私人 Bot 的 App、OAuth、会话、记忆和事件订阅无变化。
