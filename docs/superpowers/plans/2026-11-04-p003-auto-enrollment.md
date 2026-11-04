# P003 自动首次接入 Implementation Plan

> 执行方式：主13亲自执行，使用executing-plans；37独立审查。用户已授权实现、验证及可联调部署，不再追加批准回合。

**Goal:** 无人工预录SN/公钥，自动可信初始化后，由家长小程序中转设备证明，原子建档并绑定，沿用claim和业务认证。
**Architecture:** 独立自动身份声明/入网存储与路由；现役ble-key-v1路由/claim不变。新增家长enrollment流程，设备签名使用独立用途域；可信工位调用自动签发接口，工位凭据与签发密钥留在服务端/可信工具，不能打包客户端。
**Tech Stack:** 现有Node24/TypeScript/Hono/node:sqlite/node:crypto，无新依赖。
**Spec:** 协调目录AUTO-ENROLL-HANDOFF-13.md与用户最新“先补完服务端再联调”指令。

## Global Constraints
- 只在codex/p003-auto-enrollment-20261104实现；线上src先SHA核对，基线7ccd1f7c；不动37未提交文件。
- 不手工预录C、不清owner、不伪造C设备材料。公网真实C留待端侧；服务端隔离测试覆盖全链并如实区分。
- 独立配置文件600，默认关闭，部署14天可联调窗口；到期仅停新增登记，既有绑定/claim/认证继续。
- 首次设备无需已有业务JWT。自动初始化工具调用签发API，身份声明仅证明可信签发与公钥绑定，设备PoP仍必需。
- 所有日志只输出RID、阶段及安全原因，不出Token/私钥/原始证明。生产数据不回灌。

## Review Focus
- 同SN并发抢注、不同公钥替换和跨账号confirm：唯一约束/事务内原态重核，输家不产生半成品。
- 关闭窗口/身份声明到期/重复confirm：未提交拒绝，已提交仍按签名和当前归属幂等回执。
- 台账删除/停用/撤销墓碑：不得当陌生新机复活。
- 非法签名/原文或statement被改/业务Bearer冒充工位：全部拒绝，无永久台账副作用。
- 旧BLE/短信/倾听/Ark/Analytics并行：当前基线受影响套件与精确增量部署，不覆盖其他源码。

### Task 1: 合同测试与身份声明
- [ ] 新建scripts/device-enrollment-http.test.ts，真实HTTP/SQLite/签名；无模块时接口404，预期200失败留证。
- [ ] 新建src/device-enrollment-proof.ts：配置读取、受控工位认证、HS256紧凑身份声明验证、P256 PoP原文；strict字段/时效/用途/哈希验证。
- [ ] 新建src/device-enrollment-store.ts：自动签发记录、短期挑战、事务confirm，签发不建业务台账；confirm建台账/身份/ble回执。

### Task 2: 路由、自动工具、兼容
- [ ] 新建src/routes/device-enrollments.ts；家长challenge/confirm/能力接口，工位自动issue接口；同源认证、限流、JSON错误、RID安全诊断。
- [ ] 修改src/routes/ble-bindings.ts仅导出现有receipt/initializeBrain供复用；src/index.ts增量挂载路由。
- [ ] 新建scripts/provision-device-identity.mjs从可信设备工具stdin自动读取真实身份并调用签发API，身份声明返回工具写入设备，不需要人工复制PEM；凭据仅环境/受控文件取，不出stdout。
- [ ] 独立HTTP全链通过；旧BLE/短信及相关业务回归。明确全仓旧typecheck错误，不掩盖。

### Task 3: 发布与交接
- [ ] 固定候选SHA交37独立审查，关闭阻断项；记录测试日志SHA和源码前后SHA。
- [ ] 在线只备份本次文件/新配置和devices.db一致快照；漂移拒绝；安装新文件后主服务重启，验证health/旧匿名入口/新匿名错误/窗口配置。
- [ ] 公网隔离测试用专用隔离进程/数据路径，绝不拿合成事件或身份冒充真实C。
- [ ] 工位受控凭据不写联调文档，后台及本地受控工具配置准备好；交付已固定接口、工具、测试用例与回滚文档到Air Downloads。
- [ ] commit/push专用分支并核远端；如缺真实客户端证据，写“服务器就绪、真机待联调”。
