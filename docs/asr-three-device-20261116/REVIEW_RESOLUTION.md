# 独立评审问题处理
候选37c7a98f经Grok会话349独立复核发现2个回执检查器阻断。修订为262dfe9c0a7bc9c44769670e0312bcb66cb32671，会话351已完成固定候选独立复验，两个代码阻断关闭；仅本地/隔离代码验收通过。

| 问题 | 修订 | 已执行证据 |
|---|---|---|
| B1 末8位SN也会被接受 | 必须完整BJP003+14位数字且和room一致 | 尾号SN负例，缺失/不匹配负例 |
| B2 不完整、混代次或0交付也可能被当作成功 | 同room出现其他trace/job拒绝；runtime证明和PID/unit核同；同generation输入汇总与connection汇总闭环；重复request拒绝；Rtc final须有正写出/供应商响应/Final交付计数支持 | 19项单测，新增负例先失败再修，历史4轮复跑全NOT_COVERED，前三仍观察到final/R4仍NO_FINAL |

COVERED仅表示诊断覆盖。完整诊断报告里写出0或final0是有效失败证据；无final的CLI仍非零，不为凑PASS丢弃这类现场。服务器单独无法证明Android参与/实听，physical_device_participated置null；original_no_final固定unlocated。

运行Rust只保留4文件诊断钩子。主池原异步handoff测试已恢复send.await/closed，用cfg(test)代理；生产仍try_send。616过/0失败/2忽略，其中真实供应商测试明确未跑。正式编译源与全回归源逐文件一致。

计划意见采纳：不整文件覆盖主池、不改派单与租约、不启用闲置搜索池；本轮以本地WS协议夹具自检，不新增SFU/供应商调用。回滚方案保护后来换的key。三台身份未澄清前不写线上范围。评审文本不是发布授权主体；发布授权来源仍为用户，具体目标身份不能自行猜测。

历史health停更证据：Brain接收成功POST才续15秒租约，11/11最后成功时间17:59:56.742 CST；Worker忽略发送结果且拒绝日志未留，不能在事后区分发送失败与401/400/413。当前刷新只证明当前正常，不证明已修历史问题。本次通过主池补诊断覆盖fallback，不修改租约以掩盖失效。

署名：codex（OpenAI）｜2026-11-16
