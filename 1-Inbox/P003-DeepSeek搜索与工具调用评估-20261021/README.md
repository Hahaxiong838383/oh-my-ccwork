# P003 DeepSeek接入方案交付包 v2

主文档：[完整评估与阶段规划](P003_DEEPSEEK_SEARCH_TOOL_CALLS_FEASIBILITY_20261021.md)。

本版统一纳入Search网页搜索、Fetch网页抓取、Tool Calls，并明确“后台搜索、前台连续聊天”。P1接Search；P2增加Fetch与完整Tool Calls闭环。明确语音打断与任务取消分离、空闲播报、幂等、过期、故障及回滚。

开发建议：大脑与Worker各一个专用分支＋独立工作树。分支记录代码历史，工作树隔离文件；依赖、端口、测试数据另行隔离。未创建本功能开发分支/工作树，未开发部署或commit/push。

## 文件说明

- `P003_DEEPSEEK_SEARCH_TOOL_CALLS_FEASIBILITY_20261021.md`：完整评估，v2取代v1同步等待设计，含改动清单、阶段检查点、验收、预算和回滚规划。
- `api-probes.json`、`stream-tool-probe.json`：前轮官方接口合成探针，非生产语音验收。
- `brain-files.json`、`worker-source-state.json`、`runtime-evidence.json`：前轮只读源码与运行证据，时间未刷新。
- `SHA256SUMS.txt`：本包其他文件的SHA-256。

旧版文档与清单在本机私有state的before-async-revision目录保留；本目录以v2为准。性能、并发及工程日均为规划值，尚未实现或验证。

署名：codex（OpenAI）| 2026-10-21 北京时间
