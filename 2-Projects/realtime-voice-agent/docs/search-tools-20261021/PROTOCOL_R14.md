## R14 增量合同（2026-10-24，候选实施，发布状态见本轮验收记录）

以下仅在独立候选的新开关开启时覆盖旧条款；开关关闭沿用R13。

- `P003_SEARCH_ACK_V1`：仅真实搜索结果已起播时，精确短附和继续原播报；准备提示、未起播、复合句、控制词、普通聊天不适用。投机与提交用相同本地判据，不新增网络请求。
- 两端 `P003_SEARCH_CONTEXT_V1`：Worker发送独立 `search_dialogue_context`，只含protocol/task_id/revision/phase/dialogue_epoch及可选resume_grant。Brain经认证、候选范围和本地任务归属核验后生成固定本轮system提示。原user/history、会话存储及记忆抽取不加入阶段字段或搜索正文；无效字段忽略，不阻断普通聊天。
- Worker `P003_SEARCH_RESUME_V1`、Brain `SEARCH_RESUME_V1`：结果在首PCM前登记全文，按句登记合成样本边界。完整句游标取capture累计样本减220ms保守下界；自然排空并完成媒体收尾才确认末句。暂停不按墙钟增长。未完整的一句重播，不承诺逐字对齐或设备实听。
- `POST /:id/progress`：`{delivery,progress:{protocol:1,text_digest,complete_sentences,sequence}}`；原receipt可附相同progress。摘要绑定全文，序号单调，句数不能倒退或超界，关闭/过期/旧delivery不复活任务。
- `POST /session/close {}`：立关闭墓碑，取消queued/running/failed，只保留符合恢复权限的ready/delivered结果。旧会话不可再提交、领取、播放或推进游标。`/session/cancel`仍为强取消。
- `POST /resume/latest {protocol:1,request_id}`：仅用户明确续讲、本地无余文时后台请求。用SN＋候选账号＋生产设备台账当前授权epoch验证，原会话须已关闭；生成绑定新会话的grant。相同request幂等，同SN只允许一个活跃会话领取，全部续讲次数有界。
- `GET /resume/:grant/playback`、`POST /resume/:grant/receipt`（outcome为progress/completed/interrupted/dropped，progress可选）只作用于当前grant及当前认证会话。`POST /resume/cancel {}`撤销该授权范围内可恢复结果。
- 生产设备台账唯一只读路径 `SEARCH_RESUME_AUTHORITY_DB_PATH=/opt/p003/server/data/devices.db` 显式登记在候选启动隔离检查；以SQLite readOnly打开，忙等不超过50ms。绝不把该路径当可写singleton store。只在后台搜索接单/恢复/播放验证访问；普通聊天不新增此查询。不可读、停用、绑定或凭据撤销水位变化则拒绝恢复。
- 恢复到期为 `min(readyAt+5分钟, 原灰度结束时间)`，续讲不续期。恢复权限只在进程内，Brain重启清空。重连本身不自动取回或播报，取消/新查询成功接单/撤权/过期均使旧恢复权限失效。原 `/:id` 系列的subject＋session限制保留。
- 关闸/灰度截止仍销毁结果并由现有Worker窗口机制退出候选会话；恢复正常链路需结束旧会话并重新进入。服务端capture、receipt、grant日志均不是设备实际听到的证明。
- TTS新增首PCM即时观测和Drop终态日志，覆盖预连接或提供方流中途取消；不调整模型、音色、全局打断或备用连接并发策略。

- 已验证阶段内的精确未完整输入（如“我想聊”“我想问”）直接返回固定澄清“我在听，你想聊什么？”，不再等待模型猜测旧话题。完整新话题仍走正常模型；固定阶段元信息不落会话或记忆，真实问答仍按原合同保存。
- 关房先给pipeline最多500ms执行显式清理，冻结保守句游标；强制abort由Orchestrator的Drop兜底。进度HTTP后台有界并发，不排队挡取消；最终回执收尾最多2秒，关闭操作最多5秒，失败降级为已确认游标，不无限等待。
- 句级进度保留既有极早补播上限：小于1秒、没有确认完整句、未补播且用户未明确停止时，最多自动补播一次。显式“停”、取消、已补播及正常完整插话遵守原控制语义。

署名：codex（OpenAI）| 2026-10-24 北京时间
