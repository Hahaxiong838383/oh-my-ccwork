# Task 1：共享读取与 admin GET

结论：已完成实现与隔离验收；主线程已挂载真实 adminDataRoute，尚未提交、push、部署。交主线程独立 review。首轮集成测试13/13，十组针对性脚本合计176项通过；独立审查修复后的最新14/14集成及45项局部回归见末尾追加记录。

## 修改范围

- 新增 `apps/server/src/miniapp-dashboard.ts`：抽出原家长 Dashboard 计算，正常 data 字段保持一致；admin wrapper 解析真实 parent role，读取前后核 SN/public_id/owner/device account/binding_version/Ark epoch/grant_id/启用及授权范围。头部 binding 与守卫起点也要一致，避免首个元组前的 ABA 返回旧绑定版本。
- 新增 `apps/server/src/routes/miniapp-admin.ts`：三个薄 GET，独立挂载也强制 admin token + no-store；400/410 分页语义保留。管理员不签、转发或伪造家长JWT。
- 修改 `apps/server/src/routes/telemetry.ts`：原家长 dashboard 调用同源计算；weekly-report 不变。
- 经主线程明确授权，修改 `apps/server/src/parent-conversations.ts`：导出真实同源分页读取函数与其错误类型；保留家长JWT验证与真实账户role验证。
- 新增 `apps/server/scripts/miniapp-admin.test.ts`：真实回环 HTTP、临时 SQLite；所有继承的 `*_DB_PATH` 也重定向临时目录，process.cwd 设临时目录。最终所有主验收经过真实 adminDataRoute，同时验证独立子router。
- 新增 `docs/miniapp-admin-20261117/API.md`，字段已提前通知UI代理。未写 admin-data.ts、HTML、pairing 或 registry。

## 字段/兼容裁决

- 顶层 `binding/observed_at_ms/data/reason/integration`；未绑定 data=null+unbound，绑定账号不存在或非parent则 data=null+parent_account_invalid。没有账户/配置/版本时不捏造值。
- integration 只含配置库真实流水上传开关/合同、OTA check 最近自报版本、许可布尔/原因白名单；不输出 last_result_json、grant_id、scope原串或凭据。`records.enabled` 仅准入名单开关，不能当成历史已授权。
- parent正常状态与admin data逐字段相同，固定Date.now夹具验证。保留缺测null与有效0、normal与非normal、完整latest_items.items、baseline非收入、流水无总count。
- **主线程裁决**：完整聚合守卫只在 admin wrapper；共享家长计算保留原 owner/SN 复核与域降级合同。家长 conversation ABA 仍200+not_enabled，admin同一竞态404无data；账户库故障家长仍按原逻辑降级。未篡改旧测试期待。
- telemetry仍按SN聚合，未声称跨家长隔离。Ark/对话/流水沿用原授权，不追认旧历史。

## RED 证据

1. 实现前运行 `node --experimental-sqlite --import tsx scripts/miniapp-admin.test.ts`，当时测试独立挂载待实现子router（缺失视为空HTTP面）：9项全部失败，真实HTTP 404≠401/200，非import崩溃。日志 `task-1-evidence/task-1-red.log`。
2. 补充发现头部绑定读取后、聚合守卫建立前ABA会返回200与旧binding_version。先添加真实第二连接写入用例，复现200≠404，再加头部元组比对与parent role复核。日志 `task-1-evidence/task-1-header-red.log`。最终该用例与全套均GREEN。
3. 两类竞态注入只包装现有读取边界，原SQL和回包真实执行；写入使用独立SQLite连接/registry SQL，不在生产代码增加测试钩子。

## 最终验证命令与结果

cwd：`2-Projects/P003GameDemo20260513/apps/server`。前十项命令统一为 `node --experimental-sqlite --import tsx scripts/<name>.test.ts`。

| name / 命令 | 结果 | 证据日志（相对 task-1-evidence/） |
|---|---:|---|
| miniapp-admin | 13/13 | task-1-green.log |
| mini008-dashboard | 16/16 | task-1-mini008-dashboard.log |
| telemetry | pass=37 fail=0 | task-1-telemetry.log |
| parent-conversations | 15/15 | task-1-parent-conversations.log |
| ark-records | 32/32 | task-1-ark-records.log |
| ark-records-legacy | 21/21 | task-1-ark-records-legacy.log |
| ark-records-summaries | 15/15（独跑） | task-1-ark-records-summaries.log |
| ark-records-legacy-http | 10/10 | task-1-legacy-http.log |
| ark-records-legacy-config | 1/1 | task-1-legacy-config.log |
| ark-records-legacy-summaries | 16/16 | task-1-legacy-summaries.log |
| ./node_modules/.bin/tsc --noEmit | exit2；仅存量 listening-content.ts:29 GeminiLlmClient.abort 缺失 | task-1-tsc.log |
| npm test | exit1；package.json没有默认test脚本 | task-1-npm-test.log |

异常与复核：六进程并行复跑时 `ark-records-summaries` 的容量性能用例测得1666ms，触发既有“不得持写锁一秒”门槛，14/15；保留原日志 `task-1-ark-records-summaries-parallel.log`。随后独跑同一未修改脚本，15/15通过；未放宽阈值、未改Ark汇总实现。此项仍对机器并行负载敏感，不能声称任意并发负载均通过。tsc存量错误已由主线程在旧HEAD单独复现，本任务新增role类型错误已消除。没有默认全套npm test，以上逐脚本结果是已实际执行范围。

## 主线程集成事项 / 风险

- 主线程已添加真实router挂载，并在外层认证前为miniapp路径加no-store；最终13用例均通过该真实入口，包含匿名401/editor403/no-store、admin成功、parent DTO equality、分页和竞态。
- 请保留本轮家长兼容裁决；API文档说明记录准入名单与已授权的差别。UI应保留非normal/缺测/基线/覆盖提示，不能把没有总count的记录分页当总量。
- 未部署、未访问生产SQLite或读取生产对话正文；所有HTTP只连随机本机loopback端口，未新增依赖、迁移、外部服务调用或提交。
- 建议主线程最终review后再执行受控环境联调，按原方案发布；本任务不自行发布。

## 最终 SHA

无提交，最终工作基线 HEAD：`53239abe320b1831c4101696f6243f09dd978efc`。这不是含实现的新commit；实现仍在共享工作树。精确源码SHA-256见 `task-1-evidence/source-sha256.txt`，避免把“未提交”冒充独立实现commit。

署名：codex（OpenAI）| 2026-11-17


## 独立审查 Important 修复：完整聚合守卫补齐 Brain 引用唯一性

结论：已修复。只改 `miniapp-dashboard.ts`、本任务新测试及本报告/证据；家长计算和原家长测试合同均保持不变。

根因：原admin授权指纹覆盖目标设备的身份、角色、代次、grant和开关，却未覆盖对话/legacy范围依赖的“当前Brain账号只被一台设备引用”。对话域完成自己的scope后、metadata读取期间，另一设备经独立SQLite连接挂到同Brain，不改变目标设备自己的epoch/binding_version。最后指纹相同，导致聚合还返回先前可用的对话摘要。

RED：新增 `admin aggregate rejects a shared Brain account introduced after domain authorization`。先验证原可读摘要message_count=1，在 `otaStore.listDeviceStatus` 边界执行真实第二连接 `UPDATE device_registry SET account_id`，再验证新的家长对话HTTP已404；修复前admin仍200，14项中13通过/1失败，断言200≠404。证据 `task-1-evidence/task-1-account-uses-red.log`；对应独立审查probe位于 `/tmp/p003-server-review/review-scope.mts`。

GREEN：authority前后指纹增加 `account_uses`；与原对话/legacy scope一致，计数包括disabled兄弟设备。该读取采用短生命周期只读SQLite连接、单条COUNT、finally关闭；不创建新表、不写库、不新增服务，也不使用会连带扫描会话统计的registry.list。账户为空时计数0。引用数变化则admin整体404且无data，原家长独立scope继续自行判定。

最新实际运行命令（cwd同前）：

| 命令 | 结果 | 证据 |
|---|---:|---|
| node --experimental-sqlite --import tsx scripts/miniapp-admin.test.ts | 14/14 | task-1-account-uses-green.log |
| node --experimental-sqlite --import tsx scripts/mini008-dashboard.test.ts | 16/16 | task-1-account-uses-mini008.log |
| node --experimental-sqlite --import tsx scripts/parent-conversations.test.ts | 15/15 | task-1-account-uses-parent.log |
| ./node_modules/.bin/tsc --noEmit | exit2；仍仅已知listening-content.ts29存量错误 | task-1-account-uses-tsc.log |
| git diff --check | exit0 | 本轮工具执行结果 |

复审修复后局部回归45项全部通过；其它脚本沿用本报告前面的实际结果，未冒称本轮重新全跑。最新源码SHA-256已同步更新 `task-1-evidence/source-sha256.txt`。未提交、未push、未部署。

署名：codex（OpenAI）| 2026-11-17
