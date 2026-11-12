# mini008 服务端固定候选说明

> 2026-11-12 更新：固定运行候选 ac21c2d7 已通过主13与 Grok 独立验收，08:09:16 CST 三文件发布并仅增量开通 C 机。最终事实见 [服务端就绪及实机联调回执](P003_mini008_服务端就绪及实机联调回执_20261112.md) 与 [发布证据](release-20261112/MAIN-ACCEPTANCE-20261112.json)。以下保留为发布前历史说明；真人全链仍待验。

结论：服务端最小实现与隔离自检完成，待主13固定候选复核、Grok独立复验及统一发布。没有生产变更、scope/grant变更、真实token签发、短信、设备或OTA操作；未宣称生产/真机/小程序端到端通过。

## 现役基线与范围

初始7ccd1f7c不是生产基线。2026-11-11 15:34 CST通过既有remote_dns.py command('brain', ...)只读捕获 `/opt/p003/server` 全部204份src（包括生产目录的备份源码）及package/lock/tsconfig/assets，共214文件；不取env/data/凭据。BASELINE.json是逐文件SHA256清单。60ebdbe5回流源码，36f18f55补存被gitignore忽略的现役package-lock；基线内容已逐份与Git固定版本核同。

业务发布只有：

- `src/routes/telemetry.ts`：原dashboard追加ark/usage，保留device/today/week/availability；结尾再查publicId/current owner，不属于当前家长仍404。
- `src/ark/dashboard.ts`：新增同步只读投影；复用现Ark范围、账户角色、identity epoch、master、grant/current，读取后复核；只返回当前normal快照的白名单数值/metadata。不走Analytics、prompt、历史余额或网络等待。
- `src/telemetry-store.ts`：focus有效性与重叠检查；focus写入/日聚合原子事务；从有效原始片段投影近7日可用性与首次接收时间。

**禁止部署基线回流整树或部署41项差异。** 基线回流只是复原正确开发/测试起点，部署清单以协调目录CANDIDATE.json三份业务文件为准。

## 行为合同

Ark有效normal即available=true，三个资源各自保null/0，normal全null也不伪造0；GM/unknown/失效/无快照均available=false，资源及source_mode/snapshot_id/captured/received为null。reason只用冻结四枚举。资产不会因奖励倒计时30秒期限自动失效。底层读取异常返回503 dashboard_dependency_unavailable，不伪装成真实0。

usage仍用 `telemetry.focus_segment` / `focus_minutes` 技术名称，含普通游戏、设置、聊天的设备已上报使用片段，不代表学习质量、心理专注或全天完整覆盖。近7日固定7点，today等于末点；无合法片段时null/false/更新时间null，20秒舍入0仍available=true。跨CST自然日分摊毫秒，updated_at_ms取贡献该日的片段中最大首次server_received_ms；快照、姿态、presence、重复上传与查询时间不刷新usage时间。

仅focus新增约束：start/end必须数值安全整数、非负、end>start、单段不超过24小时、在四位公历年份可表示范围内；occurred_at_ms同样须安全有效。24小时是保护旧按日循环的宽松上限，mini008常规约60秒及尾段无需变更。保留既有钟差/晚到政策，不新增未来钟差窗口、不限定focus_active、不限制旧extra data键，不改其他事件语义。

同ID先按原payload hash判duplicate/conflict，duplicate不重算/不改首次接收。不同ID同SN与已有有效片段重叠时逐项rejected=focus_segment_overlap；邻接段可计。非法focus逐项invalid_event_data，同批其他合法项正常ACK，events-only响应snapshot=null原样。

不迁表、不回灌、不清历史。旧daily可能是姿态造出的0或历史非法/重叠累计，新usage不直接信daily；读取原始合法片段、保守排除晚接收的历史重叠段。旧today/week仍保持旧兼容数值，不应由新小程序当可用数据兜底。保留期仍取决于原始事件，未新增TTL或完整覆盖承诺。

## 已执行验证

运行Node `/Users/fu-121/.local/node-v24/bin/node` v24.19.0，复用既有node_modules/缓存，未装全局依赖。新增测试用临时工作目录+临时SQLite+合成JWT，Hono通过真实127.0.0.1随机端口接HTTP，包含真实telemetry/Ark上传路由与家长dashboard。

| 验证 | 结果 |
|---|---|
| mini008-dashboard.test.ts | 16组全部通过，ACK→DB→dashboard、双owner404、normal/GM/unknown/partial/null/0、epoch/grant/account/status/scope/master、姿态/presence空态、非法区间、重叠、重复/冲突、跨日、晚到/重放时间、旧字段、401/时区、snapshot:null请求兼容 |
| 原telemetry.test.ts | 37项通过 |
| Ark state/runtime/proxy/history | 16+7+4+11=38项通过 |
| 未改基线运行初版新增矩阵 | 12组失败，证明基线缺新字段/验证；危险超大区间在首轮红测中触发长循环，已终止隔离进程；受限红测换成小范围非法小数完成，不向线上注入 |
| 全量tsc（含新增测试另外复查） | 候选与未改基线均仅同一既有错误：listening-content.ts:29 GeminiLlmClient.abort不存在；无新增类型错误 |
| ark-resource.test.ts | 候选与未改基线均失败于第14行旧“实时余额”文案断言；未改知识库/测试绕过 |
| npm test | 现役package没有通用test脚本；上面列出的定向套件实际执行 |

不能称全仓测试全绿。日志与基线对照在本目录evidence。原有类型/文案断言问题已隔离，不扩修。

复跑新增套件（server目录）：

```sh
/Users/fu-121/.local/node-v24/bin/node --import tsx scripts/mini008-dashboard.test.ts
```

## 发布与回滚交给主13

1. 从CANDIDATE.json指定固定Git SHA导出三份文件，逐文件核after SHA；线上两个既有文件必须仍匹配before SHA，新文件必须不存在。发现漂移停止，不整树覆盖。
2. 备份这两个线上原文件，并记录新文件原先不存在。只替换三份源码；不带env/data/依赖/源码备份文件，不整库恢复，不改Worker。
3. 主13统一安排必要服务重载、范围/grant开通及生产验收。C范围/grant与13:35历史403结论独立由主13负责，本候选不包含授权变更。unknown合法授权后应成功上传，但dashboard资产仍空态。
4. 新小程序只看usage逐日available与可空字段；不退回旧daily的0；资源按字段null判断。部署后的HTTP、数据库、真实设备与页面须再同ID对账。
5. 最小回滚：逐文件确认仍是本候选后恢复两个before文件，删除本次新增ark/dashboard.ts（仅匹配候选SHA时），按主13安排重载。**不回滚数据库**，保留已收到事件及Ark快照；scope/grant若另有变更由主13单独记录处置。

正常资产真人用例仍需合法normal档。当前unknown和缺focus的事实不能靠合成测试升级成真机通过。

署名：codex（OpenAI）| 2026-11-11
