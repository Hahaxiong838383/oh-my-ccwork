# 最终全分支独立审查

结论：**PASS（源码与集成交付审查通过），0 个 Critical、0 个未关闭 Important。** 冻结分支满足本次批准的实现范围，可继续最终 Node22 候选验证和受控发布；这不是生产验收通过，尚不能据此宣称用户目标全部完成。

审查范围：`53239abe320b1831c4101696f6243f09dd978efc..677d519eb87267627fb1e3d702dbd7fd687a92ff`。阅读冻结 diff、PLAN/IMPLEMENTATION/API、ledger、三个任务报告、服务端及 UI 独立复审；直接核对实际产品源码与发布/验收脚本。没有修改业务代码，没有访问或操作生产；只新增本报告。

## 集成结论

| 重点 | 结论及依据 |
|---|---|
| 真实管理入口 | `index.ts` 实际挂载 `/api/admin`，`adminDataRoute` 权限中间件后挂载新 router；外层提前设置 no-store，子 router 自身也校验 admin。新集成测试使用真实 adminDataRoute，包含匿名401、editor403及正常200。 |
| 跨任务 DTO | 三个路径与 UI 调用一致；dashboard envelope、binding 字段、integration 元数据、两种原分页 DTO 和 HTTP 状态信息均对齐。列表由台账字段映射，无逐设备详情 N+1；数据仅保留于本次会话内存。 |
| 原家长兼容 | dashboard 原计算抽取到共享函数，旧正常字段、owner/SN 检查、各域降级保留；对话复用真实 reader，并继续验证家长身份。admin 独有完整聚合授权守卫，没有把 admin 权限换成家长 JWT 来调用产品逻辑。 |
| 完整授权范围 | 最终 authority 包含目标身份、binding version、Ark epoch/grant/settings、真实角色、历史范围、启用状态及 Brain 引用数；`account_uses` 原失败探针和仓库新增测试均已独立复审14/14，旧家长局部回归保留。 |
| 两个解绑 UI 入口 | 新页和旧 Brain 家长解除都进入 `maAskUnbind` / `maConfirmUnbind`，弹窗冻结 public_id/owner/version，取消不提交，忙碌禁重复，409清旧详情并刷新重新确认；原 Brain 账号解绑函数保留。 |
| 写入权威与旧意图 | 注册表 BEGIN IMMEDIATE + 条件 UPDATE 只允许匹配代次解绑；旧预授权和会话传创建时 owner/version，最终 claim 再 CAS，签发使用事务返回版本。跨库清理失败不能绕过最终代次保护。 |
| 页面需求 | Worker 独立标签，不受 Brain 门限；六详情页、缺测/有效0、normal资产、整组物品、部分历史、SN用时边界、未知状态、双分页与迟到响应失效均有实际 Vue 浏览器证据。最终 UI 独立复审40次GET、3次预期隔离parent PATCH、0次status PATCH、0 pageerror。 |
| 线上源码漂移 | HTML采用取得的线上完整源为底座。此次独立再次比对16个原功能函数块，与线上快照逐字节一致；当前HTML SHA256为 `d46500fdba5dd3be981fc3f7e03c551efd8fd25d5608cc01f456e3fab526023b`，与最终UI复审一致。 |

## 发布与验收脚本

静态检查未发现新的可复现 Important。release.py 核目标与候选 hash、非目标源文件、环境 hash、关联 manifest 的 Node22/审查证明；要求新鲜空房和无活跃配对意图；备份源码及一致性数据库副本，仅重启目标服务；核其他进程、绑定和公开HTML/API；异常回滚源码，不恢复旧数据库。schema 是幂等增量新增字段，旧意图不补盖新代次。

probe.mjs 使用真实当前绑定读取，对比 admin/家长 DTO、记录与对话 ID/字段（随机游标以是否存在比较），核 no-store、400、401和公开HTML精确字节。browser-probe 仅允许 GET/HEAD，使用真实公开 admin 与三个读取入口；失败清理已由独立注入验证，浏览器只接收 admin token。上述是可行性审查，尚未取得本冻结版本的生产执行结果。

本轮实际执行：冻结范围 `git diff --check`、release.py Python AST解析、preflight/probe/browser-probe/UI-test 的 `node --check`、16个线上原函数块独立对比与HTML hash，全部通过。没有重复运行已有全套或把其旧批次记为最终候选新执行。

## Ledger 裁决与可接受边界

- **接受家长兼容裁决**：完整聚合前后守卫在admin wrapper，原parent保留已存在的各域降级。不能宣称原家长所有历史数据已获得新增整体原子快照语义；这次正常同源一致与admin强守卫有对应测试。
- **接受CAS为跨库权威**：清理只释放旧意图，不能代替最终事务校验；双连接和提交后ABA用例覆盖了关键窗口。
- **接受生产HTML为底座**：已有weather/status/voice等变更已保留；发布时仍必须通过manifest漂移守卫，旧快照本身不能证明发布当刻未变化。
- **接受已记录的测试边界**：server存量类型错误已有旧基线复现；web常规工具缺失未通过安装扩大范围，实际HTML编译运行已覆盖；既有性能阈值未放宽。不能称全仓类型检查全绿。
- **接受既定功能边界**：telemetry按SN、legacy无版本凭据/v1既有兼容、未ACK队列无设备端E2E证据、生产不解绑C，均需保留在交付说明；本次代码没有清队列/恢复出厂路径。

## 尚待主线程完成的交付门槛

1. 将最终冻结源码叠加真实线上底座，完成 Node22 隔离候选测试并把证据与发布 manifest 绑定。
2. 发布前重核源/环境漂移、空房及待配对意图；实际发布后核健康、其他进程、绑定保持、公开HTML hash和真实浏览器读取。
3. 完成当前绑定同观察窗口的 admin/家长/小程序只读对账；不能用隔离fixture、历史C数量或本审查代替。
4. 回填 EVIDENCE/发布交付状态及最终remote SHA。当前未跟踪 EVIDENCE 草稿仍有“UI修复进行中”的旧状态，最终交付时按已关闭复审和实际生产结果更新。

以上是原实施计划已列出的执行门槛，不是新增审批要求，也不是未关闭的代码审查问题。源发布尚未发生，生产结果仍待验证。

署名：codex（OpenAI）| 2026-11-17
