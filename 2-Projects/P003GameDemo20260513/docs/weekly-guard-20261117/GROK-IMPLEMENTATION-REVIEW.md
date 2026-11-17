# P003 护眼周报实现审计

签署：grok
日期：2026-11-17
结论：未复现 P0 或 P1。当前提交上的三套隔离测试与三条私有反例均通过。

## 审计对象

- HEAD：`972f27d2650170bda0021577e3b639738dd4bc33` `feat(p003): persist device weekly guard reports and shared dashboards`
- 对照基线：`0401a58a402b25b845c20648014aa7250fcbee34`
- 工作区：仅未跟踪 `2-Projects/P003GameDemo20260513/docs/weekly-guard-20261117/`。本审计没有把它当产品代码，也没有修改任何仓内文件。
- 批准方案：`/Users/fu-121/.local/state/p003-weekly-implementation-20261117/APPROVED-SPEC.md`
- Node：`/Users/fu-121/.local/node-v24/bin/node` v24.19.0。未执行 npm install，未部署，未接生产，未读凭据，未启动 `src/index.ts`。

落盘哈希（写本文件前即时计算）：

- `2-Projects/P003GameDemo20260513/apps/server/src/weekly-calculation.ts` `ee1d211d10af7631fadceffb39cec5df86814e41380641ab5fa530987adf72ae`
- `2-Projects/P003GameDemo20260513/apps/server/src/weekly-report-store.ts` `49643954d5f07eb5cd9cdac6178cc4fd7b88cb1b920fc7eb0e813091947676f2`
- `2-Projects/P003GameDemo20260513/apps/server/src/weekly-report-service.ts` `ec96accaa21ea8b51753716b81f92dac9d5c4d46beeac18ebbe866f988dbf5f5`
- `2-Projects/P003GameDemo20260513/apps/server/src/history-usage.ts` `8f16b10027d824951be9691ea2d1df6b58cc5b1d85bd4845f8bf12d9646941c9`
- `2-Projects/P003GameDemo20260513/apps/server/src/history-scope.ts` `bb8318f26973b71a13ba2ea9c4c1095077b12d7d681054d34c015a38b4cd657f`
- `2-Projects/P003GameDemo20260513/apps/server/src/routes/telemetry.ts` `7a16f1fc7962e2210bf04fb63cad96d109627f12f9f2a7d6e57cf140ae84856a`
- `2-Projects/P003GameDemo20260513/apps/server/src/routes/miniapp-admin.ts` `449c99af2a70fe734d5cde220a5674e45835146672b5f37e1968faedb771243d`
- `2-Projects/P003GameDemo20260513/apps/server/src/index.ts` `4e5734d9ac14e874b24e6a8007f7c6e66a7d0567a40159a74dfa68ef931c87e2`
- `2-Projects/P003GameDemo20260513/apps/server/scripts/weekly-calculation.test.ts` `215ac080480ab8fbe3bae0fb30f2185c35eb6a07de27a13836264630c17260a0`
- `2-Projects/P003GameDemo20260513/apps/server/scripts/weekly-report-store.test.ts` `85915be4e9faaa3e90b131f048c980882f239e93bd3cc4ea4649d3a6f35a9409`
- `2-Projects/P003GameDemo20260513/apps/server/scripts/weekly-report-service.test.ts` `04c3a45c783bfa0428684b4d6fa6274d84d1e422497e3d7a6aad966a46825e65`
- `2-Projects/P003GameDemo20260513/apps/web/public/admin/index.html` `db76d5eb047e8fc9f73ada6eedcc01d4879c585434e0309e23df0f0225522d0b`
- `2-Projects/P003GameDemo20260513/apps/miniapp/src/services/weekly-report.ts` `220886de3b15b0a7ef450a72f8a973e61452b264ae6ce0546ce6f7e5d8284ef6`
- `2-Projects/P003GameDemo20260513/apps/miniapp/src/pages/index/weekly-report.tsx` `024f8a0f727dde9fe6d64d388d62f1c983ecac2a8f7684241861ccc875369f20`

`git diff 0401a58a..HEAD -- apps/server/src/routes/telemetry.ts` 只替换家长周报 GET，并给该路径加 `no-store`。POST 事件类型与上传校验不在该 diff 中。`index.ts` 增加 `startWeeklyReportScheduler()`。`miniapp-admin.ts` 增加管理员周报 GET。

## 命令与结果

工作目录均为 `2-Projects/P003GameDemo20260513/apps/server`。

```
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx scripts/weekly-calculation.test.ts
```

24 pass，0 fail，duration_ms 75.300667。

```
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx scripts/weekly-report-store.test.ts
```

14 pass，0 fail，duration_ms 106.953375。

```
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx scripts/weekly-report-service.test.ts
```

16 pass，0 fail，duration_ms 1505.483333。输出含一行 `[weekly-report] refresh failed sn=****0008`。调度器遍历此前夹具留下的设备；其中有家长角色被改成 device、或绑定被解开的设备，刷新被捕获后继续。同一次运行里“无人请求也会补发布”的断言通过：状态 published，真实 300 秒，cutoff 等于周期结束。未把它记为缺陷。这 16 项包含本轮新增的亚秒片段用例：299.999 秒保持真实时长，补充量为 0，不因四舍五入变成补充用量。

私有反例（仓外，`{"type":"module"}`，临时库，`ANALYTICS_INTERNAL_URL=http://127.0.0.1:9`）：

```
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx /Users/fu-121/.local/state/p003-weekly-implementation-20261117/grok-counterexamples/weekly-counterexamples.test.ts
```

文件 SHA-256 `84fa9d7f698c35f695eb761677e6283bbc2ce2b3446d008415d881dbd3fe9dd3`。最终 3 pass，0 fail，duration_ms 141.371792。

1. 换绑另一名家长后，新主人的真实时长、活跃天数、提醒均为 null，且 `report_id` 与旧报告不同；旧主人读取得到 `WeeklyReportError` 404。
2. 已发布 300 秒后把 `PARENT_CONVERSATION_SCOPE_JSON` 设为 `{`。直接调用 `readParentWeeklyReport` 抛出 status 503、message `history_configuration_invalid`。删除该环境变量后，同一 `report_id`、真实 300 秒、同一 revision 仍在。
3. 299999 毫秒不构成活跃日；`played` 计 1，`suppressed_cooldown` 不另计，`PLAYED` 不把缺测变成 0。周日 21:59:59.999 为 collecting 且 `published_at_ms` 为 null；周日 22:00 首次 published，发布时间、cutoff、计划发布时间都是该时刻。周日 23:30 晚到的 300000 毫秒把本周修到 599.999 秒、日均 599.999/7、活跃 1，revision 加 1，首次发布时间不变。恰好周一 00:00 的 played，以及从周一 00:00 起的 300 秒合法片段，不改变本周提醒 1、真实 599.999、`invalid_event_count` 0。周一相位再使 revision 加 1，状态为 revised，首次发布时间仍是周日 22:00。直接计算：结束于下一周一 00:00 的 300 秒留在本周周日并计活跃；开始于下一周一 00:00 的片段不计入本周。

第 3 条第一次运行失败在倒置区间 `end < start`。现有 `telemetry-store` 的 `focusInterval` 对 `end <= start` 返回 `invalid_event_data`，事件进不了库。这是原上传校验，不是周报回归。私有测试已改为断言该拒绝，并另放一条合法的下周一片段。未改仓内代码。

## 与方案对照（已由上述运行覆盖）

- 北京时间自然周：周一 00:00 含、下一周一 00:00 不含。周日 22:00 首版，周一完整重算，revision 增加，首次 `published_at_ms` 不变。
- 旧 URL 仍返回 `week_start`、`eye_health_rate`、`guarded_minutes`、`posture_alert_count`、`percentile`、`highlights`、`data_quality`，并附加 `report`。停用设备或家长账号缺失时旧字段保留且 `report` 为 null。错误主人、错误角色为 404。非 `Asia/Shanghai` 为 400。
- 主指标为真实片段毫秒和再除以 7。连续合并后达到 300000 毫秒才是活跃日。端点相接合并，1 毫秒间隙拆开，跨午夜先切日。提醒只认 `posture_reminder` 且 `outcome` 精确等于 `played`。仅 cooldown 时已确认为 0；没有事件或未知结果为 null。估算不制造真实时长、提醒或活跃。
- scope 含绑定、epoch、历史授权标志等身份。C 的显式历史授权保留清理前的补充；其他设备的授权替换不吞掉当前普通 scope。新 scope 只收开通之后、且 `start_ms` 不早于开通时刻的片段。await 期间换主人、epoch、角色或共享账号则整次读取 404，不落缓存。旧主人数据不出现在新主人周报。
- 原始事件删除后已留存周报仍在。晚到修订原发生周。别周非法事件不改本周输出。重叠补充取并集，不把两段相加。
- 超过 672 次仍保留真实次数并标 `above_reference_max`。后台与参考小程序都有对应提示。`coverage.complete` 固定为 false 时，页面用“已同步折算日均 / 覆盖不足”，null 显示暂无数据，不显示 0。后台日均使用服务端 `daily_average_seconds/60`，没有再除以已观测天数。此项为静态阅读，没有在浏览器或手机上执行。

## 残留

P2，已复现，无数据丢失。`weekly-report-service.ts` 的 `authority()` 对每个读取都先调用 `configuredHistoryScope()`。JSON 无法解析时，`history-scope.ts` 抛出 `ObservationError` 503 `history_configuration_invalid`，发生在按设备判断历史授权之前。因此一台无关设备已经发布的周报在配置损坏期间读不出来。HTTP 路由只识别 `WeeklyReportError`，这个异常会变成通用 503 `weekly_report_dependency_unavailable`。HTTP 映射来自阅读 `routes/telemetry.ts`，没有发 HTTP 请求。配置恢复后报告身份、300 秒和 revision 不变，没有新 scope，也没有被写成 0。这是失败关闭，比把坏 JSON 当成“没有历史授权”更安全。不升为 P1。

## 未验证面

- 没有现役手机小程序源码，也没有实机。`apps/miniapp` 只作参考前端，静态阅读通过不等于手机通过。
- 没有在浏览器里跑 `apps/web/public/admin/index.html`，也没有跑 `apps/web/scripts/test-miniapp-admin-ui.cjs`。
- 没有请求生产或 `127.0.0.1:3006`。没有执行进程内 60 秒调度器的启动路径；服务测试只直接调用了 `refreshWeeklyReports`。
- 上传协议只对照了 diff，并用 `telemetryStore.ingestEvent` 做了隔离写入。没有走 HTTP POST。
- 另一项 design 任务不在本次范围内。本次只核当前工作区里的周报实现。

签署：grok
