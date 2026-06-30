# multica Agent Prompt Shards

> 从 `CLAUDE-FABLE-5.md` 提炼的可迁移行为内核。只吸收方法，不吸收 Claude 身份、Anthropic 专属语法、产品事实或 `antml` 工具格式。

## 使用原则

1. **按 agent 角色装配**：coordinator、deep worker、tool agent、single-shot worker 吃不同 shard。
2. **短 prompt 优先**：Gemma / fast coordinator 只吃压缩版，避免前置 token 拖慢。
3. **工具结果优先**：任何外部操作都以真实 CLI/API/sidecar 返回为准，不用记忆或历史 comment 代替。
4. **可验收**：每次改 agent instructions 后运行 `./validate-shards.sh`。

## Shard 清单

| Shard | 作用 | 适用 agent |
|------|------|------------|
| `base-behavior.md` | 中文、简洁、no-guessing、置信度、缺 O2 先问 | 全部 |
| `agent-routing.md` | 三档分流、复杂升级、角色边界 | coordinator / worker |
| `tool-source-of-truth.md` | 工具调用、权威源、证据化、错误分类 | 飞书 / theory-radar / runtime |
| `current-info.md` | 时效信息联网或标不确定 | theory-radar / 调研 / Gemma |
| `safety-boundary.md` | 隐私、敏感、高风险任务边界 | HR / 飞书 / coordinator |
| `file-output.md` | 产出文件、证据、可打开可复用 | 文档/报告/代码类 agent |

## 接入矩阵

| Agent / Runtime | 当前接入 | 原因 |
|---|---|---|
| 爱马仕grok（快速） | `base-behavior` + `agent-routing` + `safety-boundary` | 快速 triage，防复杂任务硬干 |
| 爱马仕grok（4.3） | `base-behavior` + `agent-routing` + `current-info` + `safety-boundary` | 深度推理，防脑补事实 |
| Gemma 4 E4B | `base-behavior` + `current-info` + 精简 routing | single-shot worker，不能塞长 prompt |
| 飞书代理操作员 | `tool-source-of-truth` + `safety-boundary` | 防 UUID/open_id 幻觉和身份误用 |
| theory-radar | `current-info` + `tool-source-of-truth` + `file-output` | 必须抓实时 arXiv、发真实 message_id |
| Runtime 运维 | `tool-source-of-truth` | 错误排查按真实日志/配置/验证链路 |

## 禁止吸收

- Claude / Anthropic 身份、人设、产品列表、模型名。
- `{antml:*}`、Claude Artifacts、Claude 专属工具 schema。
- 与 multica runtime 不匹配的路径，例如 `/mnt/user-data/...`。
- 任何未经当前工具验证的产品事实、版本事实、价格事实。

