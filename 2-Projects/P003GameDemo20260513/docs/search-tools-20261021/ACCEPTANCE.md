# P003 后台搜索：候选验收与发布清单

当前结论：候选代码和隔离测试可供复核，**尚未部署、未开启生产搜索，不满足全量发布条件**。

## 证据入口

- [实施/回滚记录](IMPLEMENTATION.md)：R0、基线溯源、已改文件、已过与未过验证。
- [v1合同/配置](PROTOCOL.md)：双侧开关、白名单、协议、期限、兼容组合。
- `evidence/search-tests-final.log`：22个大脑搜索测试。
- `evidence/voice-regression-final.log`：5个既有语音测试文件。
- `evidence/typecheck-final.log`：tsc成功无输出；命令退出码在TEST_RESULTS.json记录。
- `evidence/worker-test.log`、`worker-build.log`：Linux全量352测试与发布构建/符号门禁。
- `evidence/ledger-bench-before.json`、`ledger-bench-after.json`：单机隔离账本优化前后；不是生产RTC压测。
- `evidence/adapter-live-smoke.json`保留修复前失败；`adapter-live-smoke-final.json`为修复后真实P1/P2。
- `evidence/adapter-live-fetch-smoke.json`：正常策略没有选择Fetch，明确fetch_exercised=false。
- `evidence/adapter-controlled-fetch-smoke.json`：测试仅将第二轮tool_choice指定为fetch_page；其余适配器、真实官方模型/Search/Fetch/回填均照常执行，五个请求HTTP200。不能将此解释成自动规划必然选择Fetch。
- `evidence/search-admin-{desktop,mobile}.png`：本机合成管理员、临时数据库、合成设备台账截图，**不是线上截图**。设备号码与待测SN相同，但没有修改生产设备。

## 下一阶段：隔离 RTC / 单机灰度

优先沿用末8位03800006的内测机；当前仅提出待验收范围，未向生产白名单加入任何设备。房间ID、真实MCU/Device Bearer身份和设备版本重新核对，不沿用ADB显示的其他号码。

1. 准备独立canary派单身份、隔离大脑端口/路由与临时DB；禁用测试会话的长期记忆/人格写入。TLS和Worker通行证验证保留。先证明该房间不会被现役Worker接走。
2. 同机、同配置源、同网络路径采集旧版普通语音基线；保留audio/transcription/metrics三通道，不用只测HTTP代替。
3. 默认关闭候选启动后，回归普通问答、真人打断、退出、设备控制、本地回复语下拉和人格读回。确认闭闸状态与原逻辑一致。
4. 双侧只放目标SN，先P1，P2保留关闭。测试“帮我查一下…”；记录接单时刻、任务ID、ready、claim、音频实际开始/结束与receipt。
5. 查询未完成期间连续3轮普通聊天；结果不得抢正在说话或刚提交ASR的用户；空闲800ms后才补播；前台首声延迟与同机旧版对照。
6. 结果播报中真人插话，覆盖pause/假打断窗口；随后普通聊天不自动重播，明确续讲只读剩余内容。连续两次打断不回退进度、不延长结果期限。
7. 覆盖明确取消、改查、退出、断线、关闸、撤销设备、提交ACK丢失、领取回执丢失、超时、满队列、上游402/429/5xx。故障注入仅针对隔离canary，不影响其他设备。
8. P1过门后才在同一台设备打开P2；验证至少一次真实Fetch和完整tool_call_id配对，验证不允许的域名/超大参数/网页指令被拒。
9. 内容质量另取儿童常见问题样本，核对来源与适用范围，不能把API链路跑通等同于回答事实正确。本轮技术样本检索到Responses API页面，回答存在把某API说明概括为全平台的风险，不能作为Chat Completions能力的权威说明。
10. 单机连续观察并对账后，才能决定扩大范围；本次没有全量搜索授权。

## R1部署前与恢复门

- 重新读取现役源码/二进制哈希、有效配置、进程PID/重启数、活跃job；若与R0不同，先解释差异并生成新恢复点，禁止把他人更新覆盖掉。
- R1包含精确产物、变更文件清单、私有配置副本、服务配置、哈希；私有env不离开服务器、不进入Git。
- 大脑和Worker分支是不同生产基线，禁止为了凑成一个分支而整树覆盖。合并/cherry-pick只取本次新增提交，分别核对各自发布目录。
- 新版本先关闸部署。Worker只在job=0时stop→确认sidecar退出→原子替换产物→start；不裸restart，不影响旁边Python线/同事线服务。
- 异常优先后台热关闸，确认普通聊天恢复；必要时按R1精确回退文件和二进制。账本保留，不回灌人格/埋点DB。
- 部署后检查哈希、开关、注册、错误日志和三通道；3分钟后复核无重启风暴。服务online不能代替功能通过。

## 本轮操作边界

生产大脑/Worker仅建立R0私有备份并做只读取证；官方API合成冒烟运行在独立脚本进程，没有调用生产聊天路由，也没有写真实儿童记忆。没有修改生产src/env/业务DB/Nginx，没有替换现役binary，没有重启服务或改变现役设备范围。新构建产物只在隔离Linux构建目录。

署名：codex（OpenAI）| 2026-10-21 北京时间
