# 发布与回滚记录

源码回滚点：`rollback/p003-ark-natural-history-pre-20261115` → `a7feb1489546d9d899de555a9e520c2ac4643fd9`，已推送。最终业务候选 `d34955cd16189b90ee3b1d69c6ceba4793faa182`，最终push结果见发布回执。

本轮只替换10份运行文件：三个池的`src/ark/answer.ts`、`src/xiaoke-kb.ts`、`src/ark/language.ts`，主池另加`src/ark/history.ts`。使用当前各池源码为基线，绝不整树覆盖。保留搜索/倾听自己的代理和会话实现；没有Worker二进制、语音SDK或供应商连接改动。

发布前比较所有运行树文件hash和四份环境文件hash、确认无活动房间、四个健康接口正常。发布顺序搜索→倾听→主Brain→Analytics；每池重启后以其真实部署源码运行隔离HTTP/回复测试。后续至少60秒核PID、重启次数、文件hash和健康。

源码包的本地失败注入已验证：三个池换完后模拟Analytics重启失败，10个源码文件全部恢复，按Analytics→主池→倾听→搜索恢复进程；拒绝并发源码漂移。未恢复数据库或环境文件。

生产备份路径为`/opt/p003/backups/ark-natural-history-20261115-d34955cd`，22:06:36已实际发布，证据见RELEASE_RECEIPT.md及evidence/RELEASE_EVIDENCE.json。该目录内`rollback.py`只恢复包内文件，hash不符会拒绝，避免盖掉后续发布。

## 三台上传范围的独立回滚

已执行上传范围调整，保留`/opt/p003/backups/ark-three-device-upload-20261115`：before.json、rollback-request.json、receipt.json。策略revision3只03800006，改为revision4的03800006/02000026/02000031，hour23、总闸true，其他设备仍false。容量接口当时允许6台。

回滚通过现有认证管理接口`PUT /api/admin/analytics/control`，先读当前策略，必须仍等于本次revision4和三个目标。再提交expected_revision=4、enabled=true、subjects恢复仅03800006、hour=23，保持revision单调递增。若被他人改过，停止并重新比对，不用旧JSON强盖。服务器配置回退不代表端侧已立刻应用，须等待配置轮询/端侧ACK。

该配置回滚仅关闭新增两台上传，不清理客户端pending、不删除已接收事件、不回灌config.db/analytics.db/ark.db，也不撤Ark授权或改变owner。新事件兼容入口继续保留。代码发布的10文件回滚与上传范围回滚是两项独立操作。

凭据仅在既有运行环境中取用，登录token不写回执/包/群聊。私有发布脚本与证据目录：`/Users/fu-121/.local/state/p003-ark-three-device-20261115`。

署名：codex（OpenAI）｜2026-11-15
