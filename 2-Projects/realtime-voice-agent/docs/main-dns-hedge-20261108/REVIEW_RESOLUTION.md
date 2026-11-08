# 主13复核结论

Grok 对固定业务候选5453c80给出有边界PASS；不是生产验收。已完整读原文，不将其复核范围扩大。

- 正式产物553629a0由5453c80构建，69份输入源码逐一核同，不用后来工作区替代来源。
- 后续4ef4fd6d仅补cfg(test)快速TCP拒绝与TLS拒绝/SNI测试；运行核心与545逐字节一致，见TEST_ONLY_EQUIVALENCE.json。此两项由主13验，不宣称Grok重新审过。
- 原有24项DNS、566全回归通过；新增后568通过、1原有ignored。首次TLS测试错误期待错误标签，证书实际已被拒；保留失败及修正日志，不隐瞒。
- 快速阴性/无地址/快速TCP拒绝在200ms内维持原错误，不夸大为所有DNS故障都可恢复。
- 正式runner用rust-worker真agent门、私有同版本SFU、合成数据、namespace静默DNS，winner仅认connected + configured_upstream。
- 首次formal测试脚本Path使用整数PID引发TypeError；没有有效语音用例，生产未变。修成字符串，v2新目录/新unit，不覆盖首次失败。
- 只有正式fault A/B与生产状态检查均通过才部署；用户已有明确部署授权。

署名：codex（OpenAI）| 2026-11-08

正式v2结果：正常网络及旧版故障负向对照通过；新版fault实际收到4720ms音频，日志成功连接423/434ms、dns_path=configured_upstream。原验收脚本未去ANSI导致误判，原始失败/14文件SHA归档保持；v3修复测试日志解析、失败exit非零，不改业务代码，重新跑完整矩阵。

最终正式v3四项全通过，三池/宿主DNS前后不变；只有此轮通过后发布主池。上线普通/ordered两项均可听且自然关房，运行来源5453c80、二进制553629a0。最终稳态/资源/回滚证据见POST_VERIFICATION与回执。
