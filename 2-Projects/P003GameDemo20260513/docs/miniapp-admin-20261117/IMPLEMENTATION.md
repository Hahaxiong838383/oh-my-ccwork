# 小程序 Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 任务按下列所有权并行实施，主线程集成、复核与发布；不得并行写同一文件。

**Goal:** 按已批准方案上线 Worker 独立小程序 Dashboard、全部当前真实数据详情和二次确认解绑，保持原小程序/后台/配对能力。

**Architecture:** 复用设备台账及管理员认证；抽共享 dashboard 查询，三条薄 admin GET 与家长同源。解绑为现 parent PATCH 的条件更新，旧绑定意图带代次并在最终 claim 事务复核；前端仍为现单 HTML/Vue/ElementPlus。

**Tech Stack:** TypeScript/Hono/node:sqlite、Vue3/ElementPlus、Node22生产/Node24本地、Playwright浏览器。

**Spec:** [PLAN.md](PLAN.md)（用户于2026-11-17明确批准实施）。

## Global Constraints

- 不复制业务计算、不签发家长 JWT、不引入新服务/依赖；小程序现合同与状态码保持。
- 缺测null不补0；当前资产只normal；收益家族币/星尘；流水无总count；历史coverage不完整；用时仍按SN。
- 解绑只解除家长关联，保留Brain/原始数据/队列；旧确认409；无真实C解绑测试。
- 不接生产造样本，不向外发送消息；发布前读真实线上源和环境，增量守卫、仅重启公司Brain，禁止整库回灌。
- 必须完成新功能回归、旧域回归、真实页面交互、独立审阅和发布后只读对账，不能以局部测试替代整体验收。

## Review Focus

- 当前绑定A→B→A和Ark grant切换：新后台/原小程序不得返回错代际数据（Task1）。
- 解绑弹窗陈旧、重复提交、旧预授权与已确认未claim会话：最终写入不能恢复旧关系（Task2）。
- 未开通Brain、尚未绑定、账户角色异常、部分依赖缺失：明示原因而不是伪造空值/泄露旧数据（Task1/3）。
- 400/410→刷新503、快速切设备/退出与迟到响应：旧数据/游标不得复活（Task3）。
- 小程序原字段/设备配置/旧配对正向流程不回归，未授权后台访问拒绝；部署资产与源码匹配（Task4）。

### Task 1: 同源查询与管理读取

**Files:** 新建 `apps/server/src/miniapp-dashboard.ts`、`src/routes/miniapp-admin.ts`、`scripts/miniapp-admin.test.ts`；修改 `src/routes/telemetry.ts`；不得修改admin-data.ts（主线程挂载）。

**Interfaces:** `miniappAdminRoute` 导出Hono，路径为 `/devices/:sn/miniapp/dashboard|records|conversations`，由adminDataRoute在现权限中间件之后 `.route('/', miniappAdminRoute)`。dashboard返回 `{ok:true,binding:{sn,public_id,parent_account_id,parent_phone,binding_version,brain_opened,status,note},observed_at_ms,data,integration}`；未绑定data=null并reason=unbound。integration只列真实可查上传配置/最近自报版本（字段细化立即写API.md通知UI）。其他两路返回 `{ok:true,data:<原分页DTO>}`。抽取 `readParentDashboard(publicId, accountId, authRole, now?)`，同源保持原所有字段；作用域内部含当前grant/启用状态。

- [ ] 先写真实隔离SQLite/HTTP失败用例：admin401/403、当前owner下admin.data等于家长.data、合法0/缺测null、normal/基线、解绑或读中换代不泄露、分页过滤与过期游标。运行并记录RED。
- [ ] 实现共享读取与薄路由，元组前后校验及no-store；在API.md冻结前端字段。配置/版本取不到时null+原因，不猜值。
- [ ] 运行新测试及 mini008-dashboard、telemetry、parent-conversations、ark-records/legacy/summaries回归，记录结果。
- [ ] 交主线程review，不自行commit/发布。

### Task 2: 条件解绑与绑定意图代次

**Files:** `apps/server/src/device-registry-store.ts`、`src/pairing-store.ts`、`src/routes/pairing.ts`、`src/routes/admin-data.ts`；必要的已有SN绑定helper调用点；新 `scripts/miniapp-unbind.test.ts` 和相关配对回归。不得修改HTML/telemetry/miniapp-admin。

**Interfaces:** 增强PATCH `/api/admin/devices/:sn/parent`，仅parent_account_id=null分支要求 `expected_public_id:string,expected_parent_account_id:string,expected_binding_version:number`，可选note≤200；成功现ok兼容并返回新binding_version，条件变化409，缺条件400。旧入口由Task3补参数。注册表条件解绑事务为权威；预授权创建存owner/version，传会话，自动确认/claim最终绑定条件核验；历史null意图失效，不盖新版本。

- [ ] 先复现陈旧确认误解绑、旧预授权复绑；真实SQLite及路由测试RED，包括已确认但未claim、ABA、重复提交与取消无写。
- [ ] 最小实现条件更新、旧意图失效及最终claim门控，非解绑正向绑定保持；既有schema做可重复增量迁移。注明字段/签名变化供集成。
- [ ] 跑新测试及pairing/ble-binding/claim/bind-sn/device-credential相关旧回归；证据包含原始数据保留及旧父权限失效。
- [ ] 交主线程review，不自行commit/部署；admin-data的路由挂载由主线程在本任务结束后做。

### Task 3: Worker 独立标签及真实详情

**Files:** `apps/web/public/admin/index.html`；新增页面行为脚本 `apps/web/scripts/test-miniapp-admin-ui.cjs`，可新增隔离fixture文件。仅此agent写HTML，必须兼容Task2的旧unbindParent入口。

**Interfaces:** 读取Task1 API.md；默认接口见Task1；现GET/admin/devices列表字段白名单本地映射，搜索不入URL；调用Task2 PATCH时提交弹窗冻结的expected字段。

- [ ] 先写现真实admin HTML的浏览器失败用例（新导航不存在；旧解绑缺expected），保留RED输出；无需给原型补实现镜像测试。
- [ ] 用批准preview的布局接现Vue：顶层miniapp标签；列表搜索/筛选/20条分页/手机号掩码；六个详情标签完整当前DTO，时间/coverage/空态清楚；详情和两个分页独立状态。
- [ ] 解绑弹窗两点击；取消无请求；409刷新再确认；成功清详情/旧响应。旧Brain解除家长关联复用同一冻结确认；Brain账号解绑不改。
- [ ] 覆盖实际页面搜索/返回/切设备竞态/400-410→503/分页/正常和缺测/取消及确认/角色与退出清理，桌面+390px；检查现导航及Brain/配对按钮无回归。只拦截传输fixture，不mockVue组件或业务计算。
- [ ] 交主线程review，不自行commit/发布。

### Task 4: 主线程集成、独立审阅、回归与发布

**Files:** admin-data.ts仅挂载新router；必要集成修正；本目录EVIDENCE、RELEASE、HANDOFF等脱敏证据；共享记忆/交付按最终实际结果。

- [ ] 三任务每项交付做独立规格+质量review，修完所有重要问题；冻结所有源文件SHA。
- [ ] 全部受影响测试统一重跑；server无默认npm test，列明确脚本矩阵（包含所有配对/认证/档案/配置/遥测/Ark与新接口），miniapp npm test/typecheck，admin HTML实际浏览器交互；全仓类型检查如有旧错明确分离。
- [ ] 获取线上源清单/配置/绑定只读快照、Node22隔离候选测试；不得覆盖线上其他任务漂移。
- [ ] 仅增量发布本次source及admin静态页，短空房窗重启公司Brain；配对schema前置备份和旧意图处理可核验，不恢复DB。发布失败按源回滚并保持数据。
- [ ] 真实admin与家长只读API同ID/时点对账，公开HTML哈希+页面GET验证；解绑实写仅隔离环境（生产不解除C）。检查原页面与服务健康。
- [ ] 更新实施状态/回执/两机Downloads；commit+push任务分支并核remote；逐项completion audit后才完成goal。

## 工作记录

起点：`53239abe320b1831c4101696f6243f09dd978efc`，已有隔离工作树且clean。本次需求已批准，无需再次请求实施许可。主线程持有最终集成/提交/发布权限；并行任务按文件所有权隔离，路由挂载最后串行。
