# 公司 Mac Studio Grok 四档推理强度（2026-10-08）

按用户指出的“低、中、高、最高”补齐第四档。此前仅恢复三档的配置不完整；当前公司 Studio 自定义 `grok-4.7` 的推理菜单是 Low / Medium / High / Max，真实值为 `low / medium / high / xhigh`，默认仍 High。最高显示名 Max 对应协议值 **xhigh**，不能把显示名当成 `max` 发给接口。

## 修改

通过正式 `acp_update_agent_config` 的 raw-only 路径，只把现有模型声明从三档扩为四档：

```toml
reasoning_efforts = [
  { value = "low", label = "Low" },
  { value = "medium", label = "Medium" },
  { value = "high", label = "High", default = true },
  { value = "xhigh", label = "Max" }
]
```

原 CPA 地址/Key、模型、协议、上下文和权限全量解析对比一致，配置保持0600。新 SHA-256：`9d85f3da0a0439c620cde4efa9fc09f502fd2cf7db6cb810880a3c720b86a7a8`。没有重启 Codeg/Xray，保存前已有用户连接仍在；此时没有已有 Grok stale 连接。后续若旧会话仍缓存能力，按官方黄色提示“重连以应用”，历史保留。

Codeg官方v0.34源码明确将xhigh标成Max，并覆盖四档能力解析；旧Grok1.0.41随包文档也说明low/medium/high/xhigh与max协议值不同。生产验收用的是公司实际 Grok1.0.46与Codeg0.34.0，不能仅拿旧版文档代替当前运行态验证。

## 验收与边界

个人 CPA 真实 `/responses` 请求使用 `reasoning.effort=xhigh`，算术答案正确、流式 `response.completed`；created与completed载荷均回显xhigh，证明接口接受第四档。

新Codeg连接不上传偏好，默认High、模型grok-4.7，快照包含四个准确值。正式选择xhigh后等待独立快照回读，再发送真实算术提示并验内容正确、end_turn，回合后档位仍xhigh；最后恢复测试连接High并关闭。已有三档在上一轮已经真实验证，本轮聚焦新增第四档。

独立生产0.34网页真实下拉显示Low/Medium/High/Max，初始High；实际点击Max时界面和独立服务快照为xhigh，再点击High时两路均为high。测试连接、唯一临时目录与按session ID核实的native历史、浏览器和SSH转发均已清理，没有操作原用户会话。

这些是档位声明、请求接受和会话完成的功能验收，不声称最高档必然产生更好答案，也不以一次短提示词比较推理质量或长期耗时。

经验：自定义模型的可用档位不能取自以前的三档配置直接当成完整能力。以当前需求四档为验收基准，区分界面label与协议value，并验真实请求回显和前端选择回读。

当前脱敏证据见 [四档与最高档验收](2026-10-08-grok-xhigh-validation.json)。原三档报告是历史阶段；本记录与最新共享记忆为当前状态。凭据只在既有私有配置，未commit/push。
