# 公司 Mac Studio Grok 推理强度选择修复（2026-10-08）

个人 CPA 接口在上一轮已正常使用，但公司 Studio 的自定义模型只写入了全局 `default_reasoning_effort = "high"`，缺少模型的 `reasoning_efforts` 能力声明。Codeg 根据 Grok 的 ACP 能力决定是否显示档位，所以全局默认不等于可见选择器。用户反馈后补齐该声明；这是上一轮具体配置遗漏，不是 CPA 接口故障。

## 修改范围

通过正式 `POST /api/acp_update_agent_config`，读取当前完整 Grok TOML，只在既有 `[model."grok-4.7"]` 内增加：

```toml
reasoning_efforts = [
  { value = "low", label = "Low" },
  { value = "medium", label = "Medium" },
  { value = "high", label = "High", default = true }
]
```

使用 `grokConfigToml` 原文与 `grokStructured = null`，完整语法解析确认其他配置和凭据均不变。模型仍 `grok-4.7`、个人 CPA Responses，High 默认，原权限保持，0600 权限保持。配置保存后的 SHA-256 为 `1b1e2f2d1421011b28e92e5ef5449c7237748b6e7080c2e6191370276f7a3886`；没有重启 Codeg/Xray。原有两个连接均保留，其中旧 Grok 连接被正常标记配置过期。

## 运行态验收

使用公司实际 Codeg 0.34.0 / Grok 1.0.46，正式 HTTP API 和 WebSocket，新建唯一测试工作区与 Grok 会话，未上传模型偏好。初始快照默认模型 `grok-4.7`，有 `reasoning_effort` 选择器，值精确为 Low/Medium/High，当前 High，config_stale=false。

逐档通过 `acp_set_config_option` 切换，等待独立快照回读成功，再发送真实提示，回合结束后再次回读档位。三个算术回合分别回答 `711 × 83 = 59013`、`722 × 86 = 62092`、`733 × 89 = 65237`，均内容正确、`end_turn` 且档位保持对应值。底层使用 Grok 原生 `session/set_model` 的 `_meta.reasoningEffort` 渠道；最终测试连接停在 High 后关闭。

独立 Chromium context 加载公司 Studio 的生产 0.34.0 网页，实际下拉菜单显示 Low/Medium/High，默认 High；真实点击三档后，独立服务快照分别为 low/medium/high，最终回到 High。该验证针对生产网页前端，没有操作 Air 正在使用的 native 旧会话。

测试时间窗中的个人 CPA Xray 记录仍均走 Lisa；所有自建会话、连接、工作区、历史和临时目录已清理。脚本只操作自己的 ID，没有断开用户会话。

这些短提示证明三档可选、被运行时接受且接口正常；没有测量推理质量差异、请求级上游 reasoning 字段或持续性能，不据此宣称 High 回答一定更好。

## 旧会话如何应用

Grok 缓存初始化时的模型能力。已有会话需要在 Codeg 黄色“智能体配置已更新”提示中点击“重连以应用”；官方机制断开并恢复同一 session，保留历史，正在回复时按钮会禁用。也可以新建 Grok 会话。单纯重新打开设置不会改旧连接的能力清单。

验证句：`711 乘以 83 等于多少？请直接回答，不调用工具。` 预期答复包含 `59013`，会话正常结束；逐档切换后选择器保持所选值。

## 经验

配置自定义模型时，接口地址/凭据/协议与模型能力都要分别验证。写入 High 默认只证明配置存在；应检查运行态 `reasoning_effort` 的可选值，并实际点选与独立回读，再跑真实回合。官方结构化保存保持同一模型 ID 会保留手工追加的能力字段；模型改名会重建受管段，届时需重新声明能力。

脱敏证据见 [推理强度验收](2026-10-08-grok-effort-validation.json)。秘密只保留在既有私有配置中，本目录与共享记忆不存值。按 HOME 提交分工未 commit/push。
