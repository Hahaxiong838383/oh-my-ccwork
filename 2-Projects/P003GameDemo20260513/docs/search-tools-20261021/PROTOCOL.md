# P003 后台搜索 v1：双端合同与启用条件

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
| GET 空 | 查当前会话待处理/待播任务；已完成/打断不会自动回列 | 200 + protocol/tasks |
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
- 插话后不自动整段重播；显式续讲回云端查权限/状态，按既有played_samples/文本进度映射估计余文，不延长原5分钟期限。不是字级语音对齐；极早打断发生在首段TTS进度登记前时，续讲可能重读该短段，需在真机验收中量测。
- 大脑重启不重放外网；在途任务记process_interrupted，已领取未结算记unknown，避免重复音频。查询正文只留进程内，账本保存摘要键、状态、公开结果和来源，24小时保留。
- 关闸/退出销毁待播与可续讲内容。已开始播音的实时撤销受网络和媒体缓冲影响，须真机量测，不能承诺零延迟。

## 配置（仅说明，未在生产设置）

| 位置 | 项 | 说明 |
|---|---|---|
| 大脑env | SEARCH_ENABLED=1 | 部署能力前置；缺失默认关闭 |
| 大脑env | SEARCH_TASK_DB_PATH | 独立SQLite绝对路径，禁止复用人格/埋点数据库 |
| 大脑env | SEARCH_ALLOWED_DOMAINS | 经审核公开域名CSV；拒绝内网、userinfo、非HTTPS和任意非默认端口 |
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
