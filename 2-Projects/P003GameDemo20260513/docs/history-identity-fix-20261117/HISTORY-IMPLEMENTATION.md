# 历史观测与使用时长实现回执

结论：历史/使用时长服务端实现及本地主机验证已完成。新增五套测试30项通过，旧业务回归通过；源码未独立提交、未由本子任务部署。远端实际Node22/24回归、源指纹冻结、发布与真实C/页面验收由主执行者接管，不能把此回执当作生产上线结果。

## 已实现

- 保留现有Ark当前normal快照、R1昨日正常收益/最新获得语义，新增Analytics原始历史观测；原始事件不写回R1、不改grant、不伪造模式或币种数值。
- 库存变化覆盖所有真实item_id，奖励保留整组items，另列补勤卡、奖励进度和钱包变化；没有币余额仍为未知，钱包变化0条与余额0分开。
- Dashboard增加`observations`与`historical_usage`；usage近7日兼容原字段，授权范围内融合新增历史用时。observations.latest按五个域各选最新一条，避免被单一时间列表挤掉。
- 新增家长与admin observations分页，支持kind/date/limit/cursor；内部Analytics只读gateway返回同源DTO。原发生归属未验证、来源模式unknown、发生/接收时间、原逻辑日、覆盖不完整明确保留。
- 历史只开放既有明确授权的单C完整scope，新增读取不以grant.not_before裁掉已授权旧事实；现有grant与正常业务门不修改。

## 文件与接线

本子任务产品文件：

| 文件（相对apps/server） | 职责 |
|---|---|
| `src/history-observations.ts` | 原始Analytics白名单投影、每域统计/最新项、加密游标和固定水位分页 |
| `src/history-usage.ts` | 用时计算、来源与coverage、只读Telemetry事件装载 |
| `src/history-scope.ts` | 显式scope、真实账号角色/Brain唯一性/active/绑定与epoch复核；fresh只读SQLite连接 |
| `src/parent-observations.ts` | Brain调用内部Analytics、独立域降级、家长历史与用时读入口 |
| `src/analytics/observations-route.ts` | 内部token保护的只读gateway；不import账户store，不运行其迁移 |
| `src/miniapp-dashboard.ts` | 增量DTO及async wrappers；兼容原parent同步降级；async完整权限指纹；admin身份顶层DTO |

主执行者负责路由挂载：家长`/v1/parent/devices/:publicId/observations`、admin`/api/admin/devices/:sn/miniapp/observations`，以及内部`/internal/analytics/parent-observations`；parent/admin Dashboard调用新的`WithHistory` wrapper。Analytics与Brain各需加载新源码，具体重启/发布由主执行者执行。

内部gateway options：`{db,deviceKey,internalSecret,cursorSecret}`。Analytics环境需同一已授权`PARENT_CONVERSATION_SCOPE_JSON`和真实只读`DEVICES_DB_PATH/ACCOUNTS_DB_PATH`；这不是新建其他设备授权。Brain优先用`ANALYTICS_INTERNAL_URL`，兼容`ARK_ANALYTICS_INTERNAL_URL`，仅允许loopback HTTP(S)，2秒deadline、2MiB响应上限。

## 用时算法与限制

用户本轮明确要求奖励进度、在位/姿态也用于使用时长，本实现按该授权实现，旧技能中一律禁止推导的要求不适用。

算法`daily_max_union_v1`：

1. 有效focus起止片段作为设备有效片段；同ID去重，重叠区间求并集，跨北京时间午夜分摊。
2. `presence_transition`真实`to=present`从发生时刻算到下一次明确状态或300秒上限；未收结束仅取到当前时间且仍受300秒上限。unknown/absent结束前段，不累积其自身。
3. `posture_round`仅correct/deviated且valid_frames>0，取当时向前最多60秒、不过当日零点的补充窗口；no_person/failed/0帧不算。此60秒是显式估算窗口，不宣称等于检测处理耗时。
4. 这些有位置区间先求并集，避免focus/在位/姿态重叠累加。
5. 奖励进度是不可定位的累计计数，按发生自然日取合法最高elapsed_seconds；301/600/902只计902，不计1803。一天的最终秒数取`max(有位置区间并集秒数,奖励进度高水位)`；不能倒推出连续902秒再额外加presence。同日跨session/重置采取最高值，可能保守少计，不假设每个重启都是新增长。
6. 合法counter0保留available=true/0秒；没有有效观测保留null。负值、>86400秒、可疑Analytics时钟、2020年前或未来时间不用于计算。

`observed_seconds`只含有效focus；`estimated_seconds`是最终合并值减有效focus，包含奖励进度和有界在位/姿态补充。按天返回total_seconds以及兼容四舍五入的focus_minutes，前端可按秒精确显示。coverage始终complete=false，列presence_window_seconds=300、posture_window_seconds=60、reward_counter_policy=calendar_day_high_water和各依赖域是否可读。不会将估算说成完整全天使用，也不把使用时间等同学习质量。

每次Analytics最多5000条相关业务事件，Telemetry最多100000条相关原始事件，超过界限显式降级本域；Analytics原始实际留存按接收时间14天，旧历史覆盖不完整。列表日期按设备报告发生北京时间筛选，原逻辑日单独保留；模式unknown可显示事实但不进入normal资产/收益。

## 授权、异步与降级

- scope冻结public_id/SN/parent/device-account/binding_version/epoch；真实parent/device角色和Brain account唯一性（包括disabled兄弟设备）必须符合。只用新只读连接，不持有旧WAL快照跨网络等待。
- gateway和Brain均在读取前后复核完整scope；换绑、ABA、epoch或共享Brain变化拒绝。分页绑定完整scope指纹、kind/date/limit、高水位和锚ID；到期/锚消失410，篡改或scope/filter变更400。
- async parent wrapper在既有同步读取之后、网络await之前冻结兼容权限指纹，返回前比较设备完整元组/epoch、双账户角色、Brain引用数、Ark开关/settings/revision/grant、records开关和两个历史scope。任一实际变化整包404，不泄漏旧Ark/records/conversation；静态字段查询故障记录明确不可用值，保留原parent域降级语义。admin继续采用原完整严格authority。
- 同步Dashboard遥测读取故障不再阻塞其他域，旧today/week相关数值为null、usage未知，不用0假装测量。新增Telemetry与Analytics分别降级：Analytics不可用仍保Telemetry用时；Telemetry不可用仍保奖励/库存和progress用时；最终scope变化仍整包404。
- 新history DTO不携带手机号、儿童正文、密钥、原context_json或任意properties。no-store沿用在公开路由，内部gateway自身也设置。

## 实际RED→GREEN与回归

新增测试均使用隔离SQLite和loopback HTTP，未向生产造奖励。

| 测试 | 最终结果 | RED证据/行为 |
|---|---:|---|
| `history-usage.test.ts` | 10/10 | 初始缺实现6失败；计数定位反例1202≠902、0帧60≠null、合法0被当缺测false≠true后分别修复 |
| `history-observations.test.ts` | 4/4 | 原投影为空、无法分页/过滤/锚失效；修复后旧事实、稳定ID、水位、跨设备与日期过滤通过 |
| `history-scope.test.ts` | 5/5 | 初始scope未校验，错误owner/ABA/sharedBrain/角色拒绝断言失败；真实库校验修复后通过 |
| `history-gateway.test.ts` | 8/8 | 真实HTTP→SQLite；Analytics故障曾整体throw、Telemetry缺表曾整体throw；分域修复后保留另一域，真实第二连接撤销仍拒绝 |
| `history-dashboard.test.ts` | 3/3（含四种await权限变更） | 实际父路由503≠200、epoch变化200≠404、settings变化200≠404；修复后事件表缺失仍显示3条progress/902秒，权限变更不返回data |

新增合计30项。执行方式均为：`node --import tsx scripts/<name>.test.ts`，本地主机Node v24.19.0。

既有回归：Telemetry37、mini008 Dashboard16、parent conversations15、miniapp admin16、Ark history11、Ark runtime7、R1 records32、R1 summaries15、legacy records21、legacy HTTP10、legacy config1、legacy summaries16，均通过。`npm run test:analytics`完整10组通过。主执行者另做远端实际Node22/24候选回归。

`./node_modules/.bin/tsc --noEmit --pretty false`仅报原有`src/listening-content.ts:29`的GeminiLlmClient.abort类型错误；无本次新增文件错误。`git diff --check`通过。

本地证据目录：`~/.local/state/p003-history-identity-audit-20261117/`，含`*-red.txt`、`final-history-*.txt`、`regression-*.txt`、`HISTORY-FINAL-TESTS.json`、`final-server-tsc.txt`。首次旧回归因不恰当复用admin严格权限而失败的日志保留，已修兼容权限后复跑通过，不将第一次失败抹去。

独立审查已复现并确认async Ark撤销漏洞修复：此前gateway返回期间关闭Ark仍200/旧资产可见，现404且无data。审查结论与最后合法0补丁复核以主执行者REVIEW和候选manifest为准。

最后增量为`history-usage.ts`合法counter0条件`<=0`改`<0`，SHA256 `fba53fac143f363a9f1b02d231a81655bfd3598a8eb09fe36356adb0b26700b4`；该变化完成时主执行者冻结通知刚到达，已即时报告要求重新冻结并重同步候选，不擅自部署。其余产品源码此后不变。

署名：codex（OpenAI）| 2026-11-17（北京时间）
