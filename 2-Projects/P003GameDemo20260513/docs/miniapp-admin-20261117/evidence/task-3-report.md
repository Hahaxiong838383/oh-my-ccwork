# Task 3 实施报告

已完成独立小程序 Dashboard 与旧 Brain 家长解除兼容，真实 Vue 页面隔离浏览器验收通过。未部署，未连接生产 API，未操作真实绑定，未 commit/push。

## 交付范围

- `2-Projects/P003GameDemo20260513/apps/web/public/admin/index.html`
- `2-Projects/P003GameDemo20260513/apps/web/scripts/test-miniapp-admin-ui.cjs`
- `2-Projects/P003GameDemo20260513/apps/web/scripts/fixtures/miniapp-admin/data.cjs`

只修改上述产品页与隔离测试，未修改 server 源码。采用已批准方案、Task 1 `API.md`；执行 TDD 与完成前验证。

## 实际页面

1. Worker 顶层 `WORKER_NAVS` 新增 `miniapp`，只向 admin 显示，不依赖 Brain 是否开通。全局顶部状态条明确“小程序真实数据 · 当前家长可见范围”。
2. 独立设备台账状态，GET devices 后仅映射 SN、备注、public_id、parent_account_id、parent_phone、binding_version、Brain 开通状态与设备状态。搜索 SN/public_id/owner/phone 只在内存匹配，不入 URL 或 localStorage。每页20台，绑定状态筛选、返回保留条件，设备数/已绑定/未绑定/Brain数直接从台账计算，无详情 N+1。
3. 固定身份头、默认手机号掩码、按需查看。六标签完整接真实 DTO：有效用时与近7日观测/缺测、设备最近自报状态、Ark 当前快照、昨日收益、整组最新获得、流水及兼容基线/状态变化、消息正文与数量/覆盖、接入配置/最近OTA自报/历史授权与准入/来源诊断。
4. 只用 `usage.today/daily`；兼容 today/week 不回退。0与null区分。最近上报不称在线探活，非normal资产保持不可用，baseline不算收入/新获得，不推算流水总数，不伪造 OpenID/UnionID。任务等本机演示边界明确列出。records.enabled 按服务端准入解释，不冒称历史授权。
5. 流水与对话分别拥有加载/错误/筛选/数据/游标状态，支持北京时间日期、存档/资源及20/50条。筛选立即失效旧分页；400/410清旧数据和游标，刷新首屏503也不恢复旧cursor。摘要/双分页/设备切换/角色/退出均核session epoch、token、序列与SN；迟到响应丢弃。
6. 列表和详情的家长解绑复用 Element Plus 两点击确认弹窗。打开时复制并冻结 SN/public_id/parent_account_id/binding_version，备注≤200字；取消不写；确认提交 expected 三字段及可选note，提交期间禁重复。409关旧确认、清详情、刷新台账，要求重新确认。成功清详情和分页、更新数量与设备行。确认说明包括保留设备/Brain/存档/原始历史/队列、访问立即失效、对话和Ark重新授权、用时仍按SN聚合及非全量凭据撤销。
7. 旧 Brain“家长关联→解除”改为获取当前台账再打开同一冻结确认，不再先发无条件 PATCH。Brain账号自己的“解绑”函数与入口保留。
8. 移动版390px导航/六标签可横向滚动、卡片两列/单列适配、数据表自身滚动，详情页面无整体横向溢出。

## 线上漂移保留

主线程在实施中发现线上HTML已先于git基线。本代理尚未修改产品页时，直接采用主线程只读取得的线上完整源为底座，再插入本次功能；无需三方冲突处理，没有用旧git页覆盖线上。

- 线上底座：`/Users/fu-121/.local/state/p003-miniapp-admin-20261117/production-source/admin/index.html`
- 底座 SHA256：`14872ac50c89ccd06cc4ea73cf76e674c0953da6151a28512c75dc16ec9e2bee`
- 当前页对线上底座差异：`task-3-production-delta.diff`
- 原函数保留证明：`task-3-preserved-functions.json`。

16个原功能函数逐段字节一致：loadHostsStatus、loadVoice、saveVoice、loadPairingPending、confirmPairing、loadDevices、unbindBrain、loadP1、loadCanary、loadRouting、loadOta、loadPck、loadDevcfg、loadDiaglog、loadRace、loadRelease。线上天气/服务器/语音等既有改动作为底座一并保留。浏览器验证原12个Worker导航和设备接入配对入口仍在。除新增miniapp代码/导出/导航/响应式样式外，必要共用修改仅为顶部真实数据提示、旧家长解除入口和deviceApi的非枚举HTTP状态元信息；deviceApi原JSON可枚举字段保持不变。

## 验证证据

先对git基线与真实线上HTML底座分别运行真实页面RED，均观察到两个目标失败：新导航缺失；旧Brain入口立即提交 `{parent_account_id:null}`，缺少冻结确认及expected条件。日志：`task-3-red.log`、`task-3-red-production-base.log`。

最终浏览器命令：

```sh
node 2-Projects/P003GameDemo20260513/apps/web/scripts/test-miniapp-admin-ui.cjs
```

真实admin HTML + 实际Vue3/ElementPlus组件运行；仅在传输层给API隔离合成DTO、把CDN资源映射到已有vendor；未mock组件或业务计算，未安装依赖。40个miniapp读取、3个隔离家长PATCH、设备状态PATCH=0、pageerror=0。日志 `task-3-green.log` 包括以下通过项：

- 四字段搜索/绑定筛选/20台分页/返回条件/掩码与查看/列表无N+1。
- 有效0、缺测null、不回退兼容9999哨兵值、未绑定/未Brain、非normal、未知枚举、整组物品及完整时间来源。
- 独立两域分页/消息计数、baseline/GM/未知/原归属未验证/兼容库存变化。
- 流水400、对话410→清cursor→首屏503→恢复首屏无旧cursor；日期/存档/资源/50条请求参数。
- 迟到摘要、流水页、对话页切设备均不串台。
- 取消0写、冻结expected及note payload、409重新确认、禁重复提交、成功后清数据、旧Brain真实入口同样带条件提交；Brain账号未被删除。
- 权限变为editor清内存/隐藏导航；真实退出登录后换editor账号，旧admin迟到响应丢弃。
- 原12导航/配对入口保留、390px无整体横向溢出。

截图均为合成身份与合成文本，没有真实儿童正文或手机号：`task-3-desktop.png`、`task-3-390.png`；布局边界数据 `task-3-layout.json`。

其他验证：`node --check apps/web/scripts/test-miniapp-admin-ui.cjs` 通过，`node scripts/check-scope-boundary.mjs` 通过。当前web本地没有tsx/tsc：`npm run test:tutorial` 与 `npm run lint` 均因命令不存在exit127；test:typewriter/test:experience的串行链因此未执行。按“不装依赖”要求未安装；web package.json没有默认test脚本。本任务HTML的实际Vue编译与浏览器执行已覆盖，server API与解绑回归由对应任务代理及主线程执行。

## 部署与剩余边界

- 未部署、未触碰生产绑定、未发送外部消息。
- 浏览器覆盖的是实际产品HTML配隔离传输，尚未进行生产同设备三方读取对账；主线程负责最终review和发布决策。
- 当前UI使用真实API合同。记录/对话鉴权与并发权威由后端任务负责，前端没有替代服务端授权检查。

署名：codex（OpenAI）| 2026-11-17


## 独立评审修复与最终重跑

- 已查真实枚举：`device-registry-store.ts` 的 `DeviceStatus = 'active' | 'disabled'`，admin PATCH也只接受这两值。新增设备专用 `maDeviceStatus`，设备active显示“已启用”、disabled显示“已停用”；物品active仍为“已激活”。夹具改用真实active/disabled，不再用错误enabled。
- 修复前先跑真实页面新断言，准确失败 `已激活 !== 已启用`，见 `task-3-review-red.log`。修复后active/disabled身份显示及物品激活文案同时通过。
- 先前错误enabled夹具进入原设备接入表格时，被现有el-switch规范化成disabled，产生24次隔离status PATCH；原测试只统计家长PATCH，故没有识别该测试夹具副作用。原生产状态开关代码无需更改。现已修正夹具并常驻断言完整测试设备status PATCH数量为0；最终输出 `device_status_writes:0`，避免把夹具误写当成页面正常行为。
- 桌面截图在390→1440 resize后等待aside宽度达到220（等待既有0.3秒过渡结束），再复位祖先scrollLeft取图。最终 `task-3-layout.json` 明确aside.x=0,width=220，main.x=220,width=1220，app-layout.width/scrollWidth均1440；截图已重生成。原半程截图不再作为最终证据。
- 浏览器测试入口移除本机绝对路径硬编码。默认 `require('playwright')` 并使用其默认安装浏览器；可通过 `P003_PLAYWRIGHT_MODULE`、`P003_CHROMIUM_PATH` 配置既有依赖。本机最终运行设置二者为既有Playwright模块和Chromium可执行文件，没有安装依赖。
- 固化真实HTTP401用例：设备4对话首屏→延迟下一页REVIEW-401-LATE哨兵→详情刷新返回401→真实登录框→释放迟到页，确认SN/data/devices/search/双cursor/maUnbind.target清空且页面无哨兵，再通过真实登录表单登录admin恢复读取。
- 最终整轮：40个miniapp请求、3个隔离家长PATCH、0个设备状态PATCH、0 pageerror，日志 `task-3-green.log`。`node --check`再次通过，保留的16个线上函数重新校验仍字节一致，delta与SHA证据已刷新。

署名：codex（OpenAI）| 2026-11-17
