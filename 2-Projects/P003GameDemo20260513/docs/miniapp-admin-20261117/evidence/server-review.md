# 服务端独立审查

结论：**未完全通过；1 个 Important，0 个 Critical。** 解绑原子性与旧意图防复绑的关键测试通过；新管理员聚合仍遗漏一项实际历史授权条件，应修复并回归后发布。未修改业务代码、未提交、未执行生产命令。

审查基线：`53239abe320b1831c4101696f6243f09dd978efc`，2026-11-17 当前工作区。阅读 PLAN/IMPLEMENTATION/API、Task2 报告与 progress，核对全部服务端 diff、新查询/路由/测试，并额外静态检查 release.py、preflight.mjs、probe.mjs。前端业务由另一审阅任务负责。

## Important：最终授权指纹缺少 Brain 账号引用唯一性

位置：`apps/server/src/miniapp-dashboard.ts:26-43,145-148`。

`authority()` 纳入当前设备的 SN/public_id/owner/account_id/version/epoch/grant/角色/启用状态，却没有纳入该 Brain account 被多少个设备引用。实际对话授权在 `parent-conversations.ts:62-65` 要求 `account_uses === 1`；legacy 流水授权在 `ark/records-store.ts:104` 也有此要求。另一设备挂到同一 Brain 不改变当前设备的任何上述字段及 epoch，因此聚合最终校验漏检已经失效的历史范围。

已用真实 HTTP、隔离 SQLite 与第二连接复现，无业务结果 stub：

1. 创建唯一引用 Brain 的合法设备和授权，加入一条虚构对话；管理员 Dashboard 初始可读。
2. 在对话独立查询完成、`integration()` 的 OTA 元数据读取边界，通过第二个 devices.db 连接，把另一设备的 account_id 设为相同 Brain。该状态也可由已有后台 `POST /devices/:sn/brain` 的 account_id 参数形成。
3. 当前管理员 Dashboard 返回 **200，conversations.available=true，message_count=1**。
4. 紧接着调用现有家长 conversations 返回 **404**。预期新 admin 最终完整范围复核应整体 404，且不返回 data。

私有复现文件：`/tmp/p003-server-review/review-scope.mts`；日志：`/tmp/p003-server-review/review-scope.log`。执行：在 server 目录使用 `NODE_OPTIONS=--experimental-sqlite ./node_modules/.bin/tsx /tmp/p003-server-review/review-scope.mts`。日志摘要为 `REVIEW_UNIQUENESS {"fired":true,"adminStatus":200,"adminAvailable":true,"adminCount":1,"freshStatus":404}`，14 项中已有 13 项通过、新增 1 项失败。

建议最小修复：仅增强 admin 的授权指纹/复核，纳入 Brain 引用唯一性，并覆盖聚合及分页共用的 authority。保留原 parent 降级、owner/SN 竞态合同；增加真实第二连接回归。不要为补此问题改原家长测试或把其历史 200 降级改成整体错误。

## 已核实通过

- 条件解绑由 `BEGIN IMMEDIATE` 中单条带 SN/public_id/owner/version 的 UPDATE 完成；不命中不推进版本，拒绝 ABA、重放与陈旧弹窗。
- 旧 preauth、confirm 未 claim、历史 null-version 意图不能恢复旧关系。跨库清理不是权威防线，最终注册表条件绑定才是；新版本意图不会被旧清理条件删除。
- claim 使用绑定事务返回的版本，避免提交后 ABA 再读取最新版本给旧会话重新盖章；签名后还复核 owner/version。
- Brain/public_id/档案/对话/流水/遥测与原 grant 原行保留；解绑后旧历史范围失效，同人重绑不自动恢复历史授权。未声称验证设备客户端未 ACK 队列。
- 正向 legacy 预授权、扫码确认、后台一键确认、BLE confirm/claim 均有真实回归；后台立即关联家长行为保留。
- 管理路由实际挂载以及独立子路由均验证 admin 权限，401/403/成功响应 no-store；分页保留原参数、400/410、历史授权门，未伪造家长 JWT 供业务读取。
- 正常状态 admin.data 与 parent.data 逐字段相等；原 parent owner/SN 复核与各域降级保留。共享函数抽取没有新增全局账户角色门影响原 parent。

## 本次实际运行

均在 server 目录以 `NODE_OPTIONS=--experimental-sqlite ./node_modules/.bin/tsx scripts/<name>.test.ts` 执行，日志在 `/tmp/p003-server-review/`。

| 测试 | 结果 |
|---|---|
| miniapp-admin（包含实际 adminDataRoute 集成） | 13 pass / 0 fail |
| miniapp-unbind | 70 pass / 0 fail |
| pairing | 148 pass / 0 fail |
| mini008-dashboard | 16 pass / 0 fail |
| parent-conversations | 15 pass / 0 fail |
| telemetry | 37 pass / 0 fail |
| ark-records | 32 pass / 0 fail |
| 独立新增唯一性竞态复现 | 13 pass / 1 fail（上文 Important） |

`git diff --check` 通过。未修改既有 parent 测试。pairing/SMS 的工作区断言调整已核对 baseline 差异及原代码，属于已记录的旧断言校准，不是放松产品权限。

## 发布脚本与规格边界

release.py 的 Python AST、preflight.mjs/probe.mjs 的 `node --check` 均通过；仅静态审查，未执行生产。当前脚本有目标/非目标源码与环境 hash 守卫、测试和审阅 manifest 绑定、60 秒空房证据、pending 意图检查、只重启 p003-voice、其他进程核对、绑定快照核对、源码回滚且不回灌数据库。未发现新增可复现的 Critical/Important 发布脚本缺陷。真实 Node22、依赖解析、PM2、空房以及线上对账仍由主线程验收，语法通过不代替生产验证。

两个非阻塞边界需在完成汇报保留：

1. legacy v1 bind_token 无固定 SN 创建快照，仍保留既有行为；本次禁止复绑保护覆盖固定 SN 的 v2/v3 意图。Task2 已明确记录，默认 v1 关闭；若日后启用，不能宣称本次覆盖其全部旧意图。
2. 设备端未 ACK 队列未由服务端隔离测试端到端验证；源码没有清队列/恢复出厂调用，用时仍按 SN 聚合，均不应扩大验收结论。

署名：codex（OpenAI）| 2026-11-17

## 复审：account_uses 修复

**ADDRESSED。** 此结论覆盖上文唯一的服务端 Important；原始报告保留作为 RED 证据。此次仅复审新增 accountUses/authority 变更及对应测试，未改业务代码。

- 原独立探针 `/tmp/p003-server-review/review-scope.mts` 重跑 **14 pass / 0 fail**，日志 `review-scope-recheck.log`；原竞态输出现在为 `{"fired":true,"adminStatus":404,"freshStatus":404}`，没有返回旧 data。
- 仓库 `miniapp-admin.test.ts` 重跑 **14 pass / 0 fail**，日志 `admin-recheck.log`；新增测试以独立 devices.db 连接在元数据边界制造重复引用，覆盖原失败路径。
- 未修改的 `mini008-dashboard.test.ts` 重跑 **16 pass / 0 fail**，日志 `mini008-recheck.log`。accountUses 只由 admin authority 调用，原 readParentDashboard 的 owner/SN 检查、字段和各域降级不变。
- accountUses 的 `resolve(process.env.DEVICES_DB_PATH?.trim() || './data/devices.db')` 与 registry 的 cwd/绝对/相对路径规则一致；连接以 readOnly 打开，成功或查询抛错均在 finally close。COUNT 不过滤 status，因此 disabled sibling 与原历史范围唯一性检查一致。连接/查询故障向上传播为失败关闭，不输出家庭 data。

### browser-probe.cjs 额外审查

`node --check` 通过。脚本当前主页面拦截 GET/HEAD 之外请求；只点查询页签，没有解绑或业务写入口，输出仅状态/路径等结果，不保存儿童正文或截图。本次没有启动真实浏览器或访问生产。

发现一个独立的验收脚本清理缺陷，已通知主线程：Playwright require、token 文件读取/JSON解析在 try/finally 外；finally 中又先 await browser.close，close 抛错也会跳过后面的 token 文件删除。故“失败也删除 token 文件”的保证目前不成立。

本地使用临时目录内纯虚构 token，令 P003_PLAYWRIGHT_MODULE 指向不存在模块（在任何联网代码执行前必然失败），实际结果：`exit_code=1, token_file_remaining=true, result_receipt_exists=false`。验证后手动移除了虚构文件。建议把依赖加载、文件解析纳入 try；删除文件放入独立 finally，确保浏览器关闭失败也执行，并写失败回执。

另建议 addInitScript 只传 admin 字符串；当前传整个 auth 对象会把本不需要的 parent token 一并序列化到浏览器初始化脚本。没有发现该 token 被用于请求，但可避免多余凭据暴露。

上述脚本问题独立于已修复的服务端 Important；正式浏览器验收前由主线程修正并验证。署名：codex（OpenAI）| 2026-11-17

### 浏览器脚本修复复审

**ADDRESSED；本轮审查发现全部关闭。** root 已把依赖加载和 token 解析移到 try 内，browser.close 独立捕获失败，嵌套 finally 删除私有文件并输出失败回执；addInitScript 仅传 admin 字符串。

本地纯虚构文件/Playwright 模块、无浏览器无网络的失败注入全部通过：

| 注入 | 退出码 | token 删除 | 回执 pass |
|---|---|---|---|
| 缺 Playwright 依赖 | 1 | 是 | false，Error |
| token JSON 损坏 | 1 | 是 | false，SyntaxError |
| 页面完整流程成功后 browser.close 抛错 | 1 | 是 | false，close_error_type=Error |

第三项让全部虚构页面检查成功、生成三个读取回执，再单独触发 close 失败，确认不会误报 pass=true。测试模块同时断言 addInitScript 参数必须为字符串，验证不再注入 parent token。`node --check` 再次通过。D 未指定时 tokenPath=null，assert 在 try 内，未引入无目录误删。

最终复审结论：服务端 Important 和验收脚本清理缺陷均已解决；本次证据仍仅为隔离测试及静态检查，不代替主线程的真实生产验收。

署名：codex（OpenAI）| 2026-11-17
