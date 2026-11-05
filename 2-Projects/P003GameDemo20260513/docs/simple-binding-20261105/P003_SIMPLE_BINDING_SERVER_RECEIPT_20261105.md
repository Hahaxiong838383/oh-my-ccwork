# P003 手机号 + SN 简化绑定：服务端上线回执

**结果：服务端已完成修复、独立验收与上线，可以由安卓和小程序按V3合同适配联调；C真机整体闭环尚未验收。**

- 上线：2026-11-05 16:01 CST；核验到 2026-11-05 16:03:45 CST，同PID稳定 157.5 秒，无额外重启。
- 运行代码：`c412d67f44b5b1384df3cc33da47ace8ed7d03cd`；分支 `codex/p003-auto-enrollment-20261104`。只发布6个文件，保留线上Ark/custom-llm现役差分，未整树覆盖。
- 主服务PID157492/restarts52；Analytics PID157401/restarts10，均health/ready正常；个人站PID1626403/restarts0未变。
- 未改环境、设备上传开关或owner。台账仍17台，C机0条，等待真实首次请求自动建档；未伪造C设备事件、绑定或激活。

## 实现结果

短信登录后的当前家长账号按SN自动建台账/public_id并绑定，复用Brain初始化。同账号幂等，其他owner冲突409；Brain暂时失败保留归属、准确initializing、同账号可重试。普通新机不依赖工位、预置JSON、identity_statement、长期公钥登记、prove_enrollment或限时开窗。

配网复用pairing2/ECIES，首次及恢复领证都核当前归属；实际设备prefetch/session认证成功才记录本会话activated。已加归属代际与跨会话激活隔离，原legacy无版本凭据及旧BLE协议兼容保留。

## 验收证据

| 层次 | 实际结果 |
|---|---|
| 独立37固定SHA复验 | 17/17；三轮双进程/同库竞争均200/409。首次候选200/500锁冲突已关闭，旧失败证据保留。 |
| 完整main入口 | 线上源码快照覆盖候选6文件，隔离Linux网络命名空间；5组/35请求覆盖SMS校验→绑定→解密领证→认证→遥测→A读/B拒绝→服务器重启。 |
| 回归 | pairing148、device-session45、旧BLE core26/guards19/HTTP通过；接收端实际Node24独立reader与Analytics HTTP通过。 |
| 生产校验 | 6/6源哈希匹配；pairing.db两个新增列在位；主服务health与Analytics ready=200；公网未登录绑定/confirm/status与Analytics=401，pairing2缺字段=400并返回X-Request-ID。 |
| 保留边界 | 全仓tsc仍12项既有错误，不声称typecheck全通过；没有把路由测试当作真实SMS送达或C/iPhone测试。公网/health是静态页面，未当作服务健康证据。 |

证据索引：RELEASE_EVIDENCE.json、REVIEW-37.md/JSON、DEPLOY_MANIFEST.json。主13核实证据后发布，不仅凭会话回传宣布通过。

## 回滚记录

源码回滚tag：`rollback/p003-simple-binding-pre-20261105` → `b31cd36bd0bb175a599ad0ae5009fb935daf5b23`。

线上备份：`/opt/p003/_backup/simple-binding-20261105T160107`，含6文件before/after清单、SQLite一致性备份、源码恢复脚本。优先把 `SIMPLE_SN_BINDING_ENABLED=0` 停止未知SN自动建档，保留已有归属/新凭据兼容；禁止整库回灌。完整退旧验证器会失去新legacy凭据代际检查，已联调使用后不能盲退；具体见ROLLBACK.md。

## 两端下一步

仅需把 **P003_MINIAPP_SIMPLE_BINDING_V3_20261105.md** 发给安卓和小程序同事。小程序改bind-sn→pairing/confirm→Wi-Fi→pairing/status；Android取消简单模式声明门槛、使用pairing_protocol:2领证，并验证解密保存、重启恢复与prefetch。普通绑定长期可用，不需要再等人工登记或开窗。

按文档Q1–Q7使用C `BJP00326081002000031`跑真实链路，回传版本/北京时间/session_id/RID/HTTP/错误码/public_id。该阶段仍待现场配合，不能认定371_mini_002已无修改适配完成。

署名：codex（OpenAI）| 2026-11-05
