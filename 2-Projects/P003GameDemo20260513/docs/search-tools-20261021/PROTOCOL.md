> R14续讲与阶段上下文增量合同：[R14_RESUME_PROTOCOL_20261024.md](R14_RESUME_PROTOCOL_20261024.md)。运行开关与验收状态以当轮验收记录为准。

# P003 后台搜索 v1：双端合同与启用条件

> 历史首版快照：本文件中的“未部署/当前/配置”描述对应首版交付时点。2026-10-21后续已部署独立候选与最小签发补丁，但正式设备窗口仍未开；最新事实见 [R1验收记录](CANARY_ACCEPTANCE_20261021.md)。

状态：候选合同，未发布。共享JSON夹具为仓库`4-Assets/contracts/p003-search-task-v1.json`，大脑与Worker分支字节相同，双侧测试消费。

## 边界

```text
真人明确搜索 → committed提交 → Worker有界后台actor → 大脑独立任务账本
                                       ↓                  ↓
                              普通语音轮次照常      Search → 可选Fetch/Tool Calls
                                       ↑                  ↓
                         空闲800ms → 领取 → TTS播出 → 实际回执
```

明确识别首版词表：“帮我查一下/查一下/搜索一下/改查…”；“取消搜索/别查了/不用查了”取消；“继续刚才的搜索结果/刚才查到了吗/刚才的搜索结果呢”显式续讲。普通“停”与普通插话只影响当前播放，不自动取消后台查询。

Worker不为prewarm/speculative提交搜索。常规轮次变化只使旧承接语失效，不使后台结果失效。新查询/改查/取消使用epoch拒绝旧响应。所有联网在后台actor执行；语音tick仅非阻塞收发有界消息。

## API

前缀`/v1/internal/search-tasks`，query仅`room=sn-<完整SN>-<时间戳>`。JWT通过`x-p003-worker-token`头传递，不放URL。要求有效p003/kidshub JWT、role=device、accountId与`SEARCH_WORKER_ACCOUNT_ID`一致；若配置`CUSTOM_LLM_API_KEY`，还要求同值Bearer。后端按房间SN映射已启用且开通brain的设备，禁止parent/普通设备账号借房间冒充Worker。

| 方法/后缀 | 输入/用途 | 成功 |
|---|---|---|
| POST 空 | `{protocol:1,phase:"committed",turn,query,replace?:旧任务UUID}` | 202 + protocol/task |
| GET 空 | 查当前会话待处理/待播任务；已完成/打断不会由列表重复领取；R5 极早打断通过独立 replay 尝试恢复 | 200 + protocol/tasks |
| GET /:id | 显式续讲前重新授权、验原结果期限；仅已completed/interrupted | 200 + task |
| POST /:id/claim | `{delivery}`，原子领取；不同delivery重复领409 | 200 + task |
| POST /:id/receipt | `{delivery,outcome:"completed"或"interrupted"或"dropped"}` | 200 + task |
| POST /:id/cancel | `{}`，跨主体/会话不可取消 | 200 + task |
| POST /session/cancel | `{}`，注销会话并立墓碑拒绝迟到提交 | 200 + ok |

请求最多8192字节，严格字段；turn/delivery为1～80位字母数字下划线/连字符。非法输入400、未授权401、无目标404、状态冲突409、超限413、容量/日配额429、关闭/上游暂停503。错误不回凭据或用户正文。

`task`包含id/turn/revision/status/created_at/deadline/ready_at/result/delivery/error及`valid_for_ms`、`automatic_for_ms`。后两项为服务端剩余时间，Worker用本机单调时间转为期限，不用双机墙钟互减。HTTP客户端3秒超时、禁止重定向、响应最多64KiB；大脑上游响应最多128KiB。

## 状态与幂等

- queued→running→ready/failed；claimed是delivery子状态，不等于已播；实际回执才变为delivered。取消/过期拒绝迟到结果。
- 从创建起20秒含排队；ready起60秒内可自动领取，结果总有效期5分钟。自动领取最多一次。已领取但未得到播出回执而过期，delivery=unknown。
- 网络不确定的提交仅用同一turn/query/replace重试一次；确定HTTP拒绝不盲重试。不能在未确认时说“已接单/已取消”。
- Worker连续空闲800ms，且无VAD说话/待ASR裁决/当前回复或TTS/设备命令/首句输入，才可起播。已领取仍持续查状态，最近验证超过1.5秒暂停起播。
- R5：不足1000ms且未完整播完一个语音段的极早插话，在原ready后60秒内最多自动回队一次；超过阈值、第二次打断仍仅显式续讲。普通停、取消、改查、退出和关闸阻止自动回队。显式续讲回云端查权限/状态，按既有played_samples/文本进度映射估计余文，不延长原5分钟期限。不是字级语音对齐；极早打断发生在首段TTS进度登记前时，续讲可能重读该短段，需在真机验收中量测。
- 大脑重启不重放外网；在途任务记process_interrupted，已领取未结算记unknown，避免重复音频。查询正文只留进程内，账本保存摘要键、状态、公开结果和来源，24小时保留。
- 关闸/退出销毁待播与可续讲内容。已开始播音的实时撤销受网络和媒体缓冲影响，须真机量测，不能承诺零延迟。

## 配置（仅说明，未在生产设置）

| 位置 | 项 | 说明 |
|---|---|---|
| 大脑env | SEARCH_ENABLED=1 | 部署能力前置；缺失默认关闭 |
| 大脑env | SEARCH_TASK_DB_PATH | 独立SQLite绝对路径，禁止复用人格/埋点数据库 |
| 大脑env | SEARCH_ALLOWED_DOMAINS | 经审核公开域名CSV；抓取仍拒绝内网、userinfo、非HTTPS和任意非默认端口。R5仅允许搜索HTTPS响应中的审核域HTTP引用元数据，不发HTTP抓取请求 |
| 大脑env | SEARCH_WORKER_ACCOUNT_ID | 从有效Worker通行证安全核对accountId，不猜值、不记录token；签发脚本当前使用worker-service，现役旧票仍需读回核对 |
| 大脑env | DEEPSEEK_API_KEY/AUTH_JWT_SECRET | 沿用服务端私有凭据，不进仓库/文档 |
| configStore热标记 | p003.search.enabled | 仅'1'开启；默认关闭 |
| configStore热标记 | p003.search.allowlist | 完整SN的JSON数组；空不允许开 |
| configStore热标记 | p003.search.tools | '0'为P1直接Search；'1'增加有界Tool Calls与可选Fetch |
| Worker env | P003_SEARCH_ENABLED=1 | 缺失默认关闭；在会话创建时读取 |
| Worker env | P003_SEARCH_DEVICE_ALLOWLIST | 完整SN CSV，空列表关闭，不能把空当全量 |

首版Worker搜索API仅允许现有大脑HTTPS域名、443端口，不自动切备用模型地址。隔离canary需规划独立路由/证书，不能临时关闭TLS校验或把测试身份映射到真实儿童记忆。

管理页`/admin/search.html`复用`kidshub_admin_token`，API为`/api/admin/search/settings`、`/tasks`，admin专属，editor/guest均拒绝。保存先热关闸并取消在途，再写范围/tools，最后启用；改范围会取消原任务，不能拿保存当无副作用的刷新。刷新为只读。

## 兼容与回退

| 组合 | 行为 |
|---|---|
| 旧Worker＋新大脑默认关 | 继续旧聊天，不请求新任务API |
| 新Worker本地关＋旧/新大脑 | 继续原语音路径 |
| 新Worker开＋大脑关/不兼容 | 搜索收到拒绝/失败提示；不得自动fallback到其他模型伪称查到；普通聊天继续 |
| 两端具备v1＋双侧单机范围 | 才进入灰度搜索验收 |

两端开关均需检查，不能只见后台“总闸开启”就宣告功能上线。回滚先热关新任务，再按IMPLEMENTATION.md恢复对应代码/产物，保留账本审计。

署名：codex（OpenAI）| 2026-10-21 北京时间


## R5 增量合同（2026-10-22）

protocol 保持1，旧端点保留；候选 Worker 与 Brain 成对升级。

- `POST /:id/replay`：严格字段 `{previous, delivery, automatic}`，均为当前认证会话所属任务；新 delivery 不得等于 previous。同一尝试幂等，旧尝试回执不覆盖新尝试。
- `GET /:id/playback`：每次续讲/自动补播前及播放中重新检查开关、名单、任务期限；取消/到期拒绝。原 GET /:id 保留旧可续讲语义。
- 每任务自动补播最多一次、全部续讲尝试最多8次；ready 60秒自动窗口及5分钟保留期限均不刷新。进程丢失的 claimed 标记 unknown，不自动重播。
- 极早判据使用服务端播放进度和完整语音段；这不是设备实听证明。继续聊天仍走普通对话通道，待完整空闲800ms后才补播。
- P1每次请求最多10条候选、选最多3条审核来源；确定性附加有界site约束。今天/当前天气按北京时间日期过滤，历史显式日期保留。证据不足返回明确兜底，不能将HTTP200、ready或带来源等同事实验收通过。
- 诊断仅记录返回/采纳/过滤计数、任务ID和尝试编号，不保存搜索原文。独立候选的能力说明与开关一致，不导入生产个人记忆。
- 未引入Android pending/terminal新协议；v319约5秒退出仍待端侧原因取证，不宣称兼容性问题已修复。


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
