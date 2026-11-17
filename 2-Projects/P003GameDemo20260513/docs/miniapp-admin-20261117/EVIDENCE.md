# 小程序 Dashboard 脱敏验收证据

结论：已发布且生产只读验收通过。以下区分初轮集成、修复后回归、候选运行时与生产结果；交付入口和当前数据见 [HANDOFF.md](HANDOFF.md)。

## 证据索引

私有证据根：`~/.local/state/p003-miniapp-admin-20261117/`。以下仅给路径及脱敏摘要；原日志不直接作为公开交付附件。

| 范围 | 已观察结果 | 证据 |
|---|---|---|
| 服务端集成批次 | 20 脚本 exit 0；RESULTS 的 pass/complete 均 true | `integrated-tests/RESULTS.json` |
| 新 admin 初轮集成 | 13/13（早于唯一性修复） | 同上 `miniapp-admin` 项 |
| 新 admin 审查修复后 | 14/14；新增真实第二连接修改 Brain 引用数，整体 404 无 data | Task 1 报告追加记录及 `task-1-evidence/task-1-account-uses-green.log` |
| 修复后同源/对话局部回归 | mini008 16/16、parent-conversations 15/15；与 admin 共 45 项通过 | Task 1 `task-1-account-uses-mini008.log`、`task-1-account-uses-parent.log` |
| 条件解绑 | 70 通过 / 0 失败 | `task2/p003-unbind-green.log`、Task 2 报告 |
| 原 pairing | 148 通过 / 0 失败 | Task 2 报告、集成结果中的 pairing |
| 小程序单测 | 101 项通过 | `miniapp-tests.log` |
| 小程序类型检查 | 通过 | `miniapp-types.log` |
| 实际 admin 页面 | 作者和独立审阅最终复跑均通过：40 次读取、3 次预期家长 PATCH、0 次设备状态 PATCH、pageerror=0 | [Task 3](evidence/task-3-report.md)、[UI复审](evidence/ui-review.md) |
| 实际 401 清理 | 独立补测通过；旧分页迟到后无哨兵泄露、清身份与分页状态 | UI 审查 `ui-review-extra.log` |

集成 20 脚本：miniapp-admin、miniapp-unbind、pairing、device-registry、device-session、sms-auth、sms-login-http、device-config、telemetry、mini008-dashboard、parent-conversations、ark-records、ark-records-legacy-http、ark-records-summaries、ark-records-legacy-summaries、ark-history、profile-store、analytics-admin-auth、search-canary-admin、listening-admin。RESULTS 各项保留日志 SHA256，可由主线程据最终候选冻结核对。

## 验证方法与审查修复

服务端使用真实本机 HTTP、独立临时 SQLite 及第二连接竞争写入，覆盖管理员 401/403/no-store、admin 与家长正常 data 逐字段一致、合法 0/缺测 null、normal/基线、游标与换绑/grant 竞态。未用生产数据造样本。

解绑覆盖取消无写、缺条件 400、陈旧弹窗/ABA/重放 409、双请求只一次成功、旧预授权与 confirmed 未 claim 意图失效、最终 claim CAS 和提交后 ABA、legacy/BLE 正向流程。隔离库逐行验证 Brain/public_id/档案/对话/流水/遥测/grant 保留及旧父历史权限失效；不等于设备存储实机验收。

浏览器运行实际产品 HTML、Vue 和 Element Plus，仅传输层提供合成 DTO/CDN 映射。覆盖搜索筛选、掩码、六标签、独立双分页、400/410→首屏 503 不复活旧游标、切设备/角色/退出迟到响应、两个解除家长入口冻结条件、409 重确认、390px 布局和原导航/配对入口。

| 审查项 | 当前状态 |
|---|---|
| 服务端完整授权指纹遗漏 Brain 引用唯一性 | 已补 `account_uses`，含 disabled 兄弟设备计数；真实竞争 RED→GREEN，14/14 |
| 设备 active 文案与错误 enabled 夹具 | 已修复并独立复核；设备为已启用/已停用，物品 active 仍为已激活 |
| 浏览器依赖绝对路径、resize 过渡态截图 | 已改为环境变量可配，标准默认；桌面侧栏220px稳定截图通过 |
| 意外写请求断言 | 最终脚本断言通过：3次预期家长PATCH、0次设备状态PATCH |

## 源码与发布边界

server 相关旧基线已与线上源比较吻合；HTML 以线上完整源为底座，天气/服务器状态/语音等既有变更保留。Task 3 提供 16 个原函数逐段保留证明和对线上底座的增量差异。以上是源兼容性证据，不是发布证明。

- server `tsc --noEmit` 未全绿：仅已知 `src/listening-content.ts(29,133)` 的 `GeminiLlmClient.abort` 存量错误，旧基线已复现。
- server 无默认 npm test；采用明确脚本矩阵。web 缺本地 tsx/tsc，常规 lint/测试链未跑全；没有因此安装依赖。实际 HTML 浏览器执行通过的范围如上。
- Ark summaries 曾在高并行负载下触发既有耗时门槛，未放宽阈值；独跑及集成批次通过，不保证任意并行负载性能。
- 未做真实 C 解绑、安卓端未 ACK 队列实机验收；历史 usage 缺失未修复设备、未补造数据。用时按 SN、历史覆盖不完整和 legacy v1 兼容边界继续保留。

| 最终候选 / 生产证据 | 结果 |
|---|---|
| 代码审查 | [全分支终审](evidence/final-review.md)通过，0未关闭Important |
| 精确代码与SHA | 实现677d519e；[发布清单](evidence/MANIFEST.json) |
| 候选运行时 | [Node22/24回执](evidence/NODE22-TESTS.json)：19组Node22＋实际埋点Node24的11项 |
| 实际发布 | [发布回执](evidence/RELEASE.json)：08:25:14完成，10文件，一次公司Brain重启 |
| 同绑定API对账 | [只读对账](evidence/POST-RELEASE-PROBE.json)全部通过，当前消息274条 |
| 真实管理页 | [公网浏览器](evidence/PUBLIC-BROWSER.json)：三个真实GET200，0页面错误，0业务写入 |
| 保留状态 | 原绑定、环境、其他进程不变；未恢复数据库、未解绑真实C |

文档不包含真实手机号、家长账号、儿童正文或密钥。最终交付状态以本目录已回读的证据为准。

署名：codex（OpenAI）| 2026-11-17

## 最终发布补充（2026-11-17）

最终状态以 [HANDOFF.md](HANDOFF.md) 为准。独立复审全部关闭，冻结实现677d519e。Node22候选19组通过、埋点实际Node24运行时11项通过；发布10文件，C绑定版本1未变。公网页面实际读取三个域200/0页面错误。当前历史274条、流水首屏0条、今日用时null；不能沿用昨日186条或把缺测当0。

首轮Node22失败及原因、补测均保留在私有任务目录；[运行时回执](evidence/NODE22-TESTS.json)未将不同Node运行时混称全Node22通过。原根20脚本基线通过时admin为13项；随后唯一性修复新admin14项及相关45项回归单独通过。
