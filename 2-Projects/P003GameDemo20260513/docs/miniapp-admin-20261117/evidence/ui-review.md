# 小程序 Dashboard 独立 UI 审查

结论：核心需求及修后 scope 复审均通过；原 1 项 P2 与 2 项 P3 均已 ADDRESSED，无未关闭的 UI 审查发现。未发现阻断发布的数据串台、授权复活或无条件解绑缺口。本报告不代表生产验收。

## 审查范围与基线

- 阅读 PLAN.md、IMPLEMENTATION.md、API.md、Task 3 报告，实际 admin HTML、浏览器脚本与合成夹具。
- 基线使用私有线上完整 admin 源 `/Users/fu-121/.local/state/p003-miniapp-admin-20261117/production-source/admin/index.html`（SHA256 `14872ac50c89ccd06cc4ea73cf76e674c0953da6151a28512c75dc16ec9e2bee`），未将旧 git HTML 当线上基线。
- 本次审查页 SHA256 `c620cbfea6ddb3ce0985f20695371988fc9584b6281745b60b65c1ea47bf8982`；线上 weather/status/voice 作为已有底座保留，审查差异为 miniapp 与必要共用接线。
- 只运行实际产品 HTML、真实 Vue / Element Plus，API 与 CDN 仅由本地传输 fixture 拦截；无生产网络、短信、真实业务写入、解绑或提交。审查未改产品代码。

## 首轮发现（均已在下方复审关闭）

### P2：设备 active 被翻译成物品“已激活”，夹具写 enabled 掩盖真实合同

- 位置：`apps/web/public/admin/index.html:1331` 身份页调用 `maLabel(maBinding.status)`；同文件 `:4998` 将通用 `active` 翻译为“已激活”。真实台账状态为 `active/disabled`，此处应为设备“已启用/已停用”。
- `apps/web/scripts/fixtures/miniapp-admin/data.cjs:3` 写 `status:'enabled'`。将临时内存 fixture 改为真实 `active` 后，实际身份页稳定显示“设备启用状态：已激活”，截图 `ui-review-desktop-stable.png` 可复核。
- 错误的 enabled 还导致先进入原“设备接入”页时 Element Plus switch 归一化值，产生 24 个停用 PATCH（全部被 fixture 拦截）。现脚本只统计 parent PATCH，未暴露这些额外写请求；这不是本次产品新增的停用功能，也没有生产写入。
- 最小修复：设备状态用独立上下文翻译，保留物品 active→已激活；fixture 使用真实 active；对意外写请求加断言，允许仅预期的隔离 parent 写入。

### P3：Playwright 与 Chromium 绝对路径使脚本无法换机直接执行

- 位置：`apps/web/scripts/test-miniapp-admin-ui.cjs:2,12`，require 和 executablePath 均硬编码当前用户名与 npm/cache 版本目录。
- 最小修复：常规 require / Playwright 默认浏览器查找为默认值，提供明确 env 覆盖入口；不为此安装新依赖或扩展范围。
- 影响是验收可复跑性，不是业务授权正确性。

### P3：resize 后立即截图采到侧栏 .3s transition 中间态

- 原截图左侧总导航约 109px，原 layout 记录亦有 24.8px；固定1440加载并等待稳定后总导航为220px，390为0px，均无页面整体横向溢出。未确认产品布局缺陷。
- 已重拍 `task-3-desktop.png`，更新 `task-3-layout.json` 为 desktop/mobile 稳定布局；另存 `ui-review-desktop-stable.png`、`ui-review-390-stable.png`、`ui-review-layout.log`。之后的作者复跑可能覆盖正式截图，以作者最终稳定快照为准。
- 最小修复：测试在 viewport 修改后等待布局达到目标或 transition 完成，再截图。

## 实际验证结果

1. 独立执行原脚本 `node 2-Projects/P003GameDemo20260513/apps/web/scripts/test-miniapp-admin-ui.cjs`：通过；35次 miniapp GET、3次预期 parent fixture PATCH、pageerror=0。
2. 使用 `/tmp/p003-ui-independent-review.cjs` 临时副本补测真实 HTTP401：通过；共40次 miniapp GET、3次parent fixture PATCH、pageerror=0，日志 `ui-review-extra.log`。没有仅靠改 Vue role 模拟401。
3. 401步骤：设备4历史对话首屏→gate下一页并写入唯一哨兵→dashboard刷新返回401→等待真实登录框→释放旧页→检查 SN/data/devices/search/双cursor/确认target清空，DOM无旧哨兵→重新admin登录成功，再继续原角色撤回及退出换账号验证。
4. 查看桌面与390px截图，固定1440总导航/Worker导航/六标签可用；390面板372px，横向滚动限于导航、标签与数据表，页面390px。

覆盖需求：顶层独立导航、不受Brain门限；SN/publicID/owner/phone本地搜索与返回保留、20台分页、手机号默认掩码/按需查看；六详情标签、来源/时间/授权/缺失原因、整组获得、合法0与null、baseline/GM/unknown/原归属未验证；独立双分页、400/410后清旧cursor且首屏503不复活；切设备迟到摘要/流水/对话不串台；角色撤回、退出后换editor及真实401清理；取消不写、冻结expected三字段、409重新确认、提交禁重复、成功清旧数据；旧Brain家长解除共用确认、Brain账号解绑独立保留；旧12个Worker导航及配对入口保留。

## 风险边界

- 本地页面fixture验证不能替代后端隔离SQLite竞争测试和生产同绑定只读对账；由主线程负责。
- 非正常资产、缺测、未绑定、未Brain均已验证；真实生产绑定未操作。
- 三项发现均已在修后 scope 复审中关闭；后续生产发布与同绑定只读对账仍由主线程负责。

署名：codex（OpenAI）| 2026-11-17 08:16 CST


## 修后 scope 复审（2026-11-17 08:20 CST）

结论：**通过，三项发现全部 ADDRESSED**。本次只复核前述修正及真实401常驻测试，没有扩展新审查范围。

| 发现 | 状态 | 复核证据 |
|---|---|---|
| P2 设备状态文案/错误fixture | ADDRESSED | 身份页改用 maDeviceStatus，active→已启用、disabled→已停用；物品active→已激活保留；fixture改真实active/disabled；实际页面断言及status PATCH=0均通过 |
| P3 本机路径硬编码 | ADDRESSED | 默认require('playwright')与默认安装浏览器；P003_PLAYWRIGHT_MODULE / P003_CHROMIUM_PATH可配置；本次以env指向既有安装独立执行成功 |
| P3 截图过渡中间态 | ADDRESSED | 390等待aside<0.1，1440等待aside=220后取证；实际layout为220px，最终桌面/390截图均查看通过 |

额外固化项：真实HTTP401+延迟对话页哨兵+清理全部miniapp内存/确认目标+admin表单重新登录已纳入原脚本，本次独立复跑通过。

最终HTML SHA256：`d46500fdba5dd3be981fc3f7e03c551efd8fd25d5608cc01f456e3fab526023b`。

最终实际运行：

```sh
P003_PLAYWRIGHT_MODULE=/Users/fu-121/.npm/_npx/31e32ef8478fbf80/node_modules/playwright P003_CHROMIUM_PATH=/Users/fu-121/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell node 2-Projects/P003GameDemo20260513/apps/web/scripts/test-miniapp-admin-ui.cjs
```

exit0，`pass=true`；**40次miniapp GET、3次预期隔离parent PATCH、0次设备status PATCH、0 pageerror**。完整独立日志 `ui-review-final-scope.log`。正式 `task-3-desktop.png`、`task-3-390.png`、`task-3-layout.json` 已由最终原脚本生成，替代首轮中间态截图。旧 `ui-review-*-stable` 保留首轮定位历史，不作为最终修后产品截图。

署名：codex（OpenAI）| 2026-11-17 08:20 CST
