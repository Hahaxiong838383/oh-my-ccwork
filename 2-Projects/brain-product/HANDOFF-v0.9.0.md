# HANDOFF: brain v0.9.0 算力重规划

**日期**: 2026-04-09
**状态**: 部署完成，默认已切回 Gemini 云端保证可用。本地 MLX thinking 问题待解决
**回滚点**: `7a84018`（v0.8.0 最后 commit）

## 当前稳定状态

- brain v0.9.0 在线，默认 cc-gemini-2.5-flash（云端，和 v0.8.0 一样能用）
- Studio：brain(:19080) + MLX 9B(:8000) + Ollama(视觉 minicpm-v)
- Mini：Ollama(:11434) 承接 intake/consolidation（雷电 192.168.100.1）
- Admin UI 公网可访问（cli4.hahaxiong.cc:19080/admin）

## 已完成

- [x] 算力架构重规划：Studio 精简 + Mini 分流
- [x] config.ts：intake/consolidation → Mini 雷电
- [x] Studio 旧进程清理（mlx-intake、mlx-9b pm2 已删）
- [x] Admin UI auth 修复（?logout + catch 兜底）
- [x] macOS 代理绕行 cli4.hahaxiong.cc
- [x] 无效路由删除（cc-local、cc-gemma4）
- [x] 决策记录 + memory 更新

## 核心阻塞：MLX Qwen3.5 thinking 模式

**现象**：27B TTFT ~85s，9B TTFT ~28s，content 字段空（输出全在 reasoning 里）
**根因**：Qwen3.5 系列 MLX 版本默认启用 thinking，chat_template 为空（内置在 mlx_lm 代码中）
**已尝试失败**：
1. `/no_think` 注入 system prompt → 模型返回空内容
2. 修改 tokenizer_config.json → chat_template 字段为空，无处可改
3. supportsThinking: false → 只控制 brain 是否传 enable_thinking 参数，MLX server 不支持该参数

**下一步研究方向**（需要干净 session 仔细研究）：
1. `mlx_lm.server --chat-template` 参数——传一个自定义 jinja 文件（需要从 Qwen3.5 源模型提取 template 并修改 enable_thinking=false）
2. 降级到非 Qwen3.5 模型（如 Qwen2.5 系列不带 thinking）
3. 升级 mlx-lm 版本看是否有 `--no-thinking` 参数
4. 研究 MLX server 的 OpenAI 兼容 API 是否支持 `enable_thinking` 请求参数

## 其他待修复

### P1: 前端图谱点击
- 用户报告左键功能失效，排查 auth 状态 + JS 错误

### P2: 视觉模型理解力
- visual-state 数据有（位置/活动/物体），但 9B 模型说"需要接入实时视觉"——模型理解不了自己已有视觉数据
- 可能需要在 system prompt 中更明确告知"你已经有摄像头"

### P3: Studio MLX pm2 管理
- 当前 MLX server 是 nohup 手动启动，需要加入 pm2 持久化

## 关键文件

| 文件 | 当前状态 |
|------|---------|
| `env.ts` | DEFAULT = cc-gemini-2.5-flash（已恢复） |
| `config.ts` | intake/consolidation → Mini 雷电；cc-mlx → 9B；cc-local/gemma4 已删 |
| `brain-api.ts` | 无 /no_think（已回滚） |
| `admin-ui.html` | auth 修复 + ?logout |

## Studio 进程

```
brain v0.9.0  :19080  pm2（在线）
MLX 9B        :8000   nohup（在线，但 thinking 慢）
Ollama        :11434  手动（视觉 minicpm-v）
```

## 可粘贴提示词

```
读 2-Projects/brain-product/HANDOFF-v0.9.0.md。核心任务：解决 MLX Qwen3.5 的 thinking 模式问题，让本地模型 TTFT < 3s。研究 mlx_lm.server 的 --chat-template 参数，制作禁用 thinking 的 jinja 模板，在 Studio 上验证后切回本地主力。
```
