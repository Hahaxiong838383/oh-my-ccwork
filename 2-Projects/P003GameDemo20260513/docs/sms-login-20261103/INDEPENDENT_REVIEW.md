# 短信登录最终候选独立复审

**结论：PASS_ISOLATED，F-SMS-01已关闭，当前未发现未关闭的代码阻断。可以交主13按固定文件SHA做生产备份、最小发布及真实短信联调；这不是生产或手机实收通过。**

## 固定对象

固定候选 **`558607252f92b313cf1843970d637af3c792e9f9`**。最新独立归档 `audit-release-zm9d8lp0/`，来源主13 `/Users/fu-121/.codex/worktrees/p003-sms-login-20261103`。4个运行文件当前逐字节核同；具体SHA及日志SHA见`review-candidate-final.json`。我没有修改主13工作树。

- `src/routes/sms-auth.ts`：`937519d32f124b1d79f26ef2b2e0e9d3577856da8fdc7102b279a9061939edda`
- `src/spug-sms.ts`：`84f18dbf6dfd78af2e7b1385c178e557012747456cd17efb09b4846b8bdeb5e1`
- `src/sms-limit-store.ts`：`d7978ed6e87efdca3d8b95885372b0ab418f845bdcac6c27943d065cd76cecf3`
- `src/verify-code-store.ts`：`d10829cd350518d76c95f2053ee74d0f7bc1e263b68d756568da3e854ec7d19c`

## F-SMS-01复现、修复及关闭

第一候选的未知发送结果仅留30秒reservation，过期后不计入小时/日额度；code200缺request_id被立即release。独立真实Hono/SQLite测试证明：同号11次未知请求调用provider11次、持久流水0；同刻畸形成功11次也调用11次。原证据保留`audit-candidate-bll1r6h4/`和`review-candidate-first-failed.md`。

最终实现网络前事务写`pending:<reservation-id>`流水并预占，明确受理改成真实provider request_id；未知结果改`unknown:<业务request-id>`，不伪造供应商凭据；明确业务拒绝才删预占流水。进程崩溃和30秒租约到期不会消除可能计费的尝试预算。code200缺/坏request_id及异常形状按未知处理。

独立旧复现重跑：11次每31秒的请求仅5次调用provider，5条持久流水，其余429；同刻畸形成功仅1次provider，其余10次429；未知结果不生成可用OTP。另验新进程仍触发phone_hour，20次未知同IP后第21次ip_day；明确拒绝释放，正常成功不双计。F-SMS-01关闭。

## 独立验证结果

|验证|结果|证据|
|---|---|---|
|主13 hardening脚本|17/17 PASS|hardening-independent.log|
|真实localhost HTTP、隔离SQLite/JWT、A/B设备ACL及新号|21断言PASS|http-independent.log|
|实际Spug transport封装、模拟fetch、真实10秒超时|8项PASS|transport-independent.log|
|同IP并发20请求，第21拒绝|PASS|AUDIT_EDGE_RESULT.json|
|旧SHA码在原有效期可用且一次性、HMAC码新进程可读|PASS|AUDIT_EDGE_RESULT.json、AUDIT_RESTART_RESULT.json|
|reservation重启保留、租约到期仍有60秒尝试冷却|PASS|AUDIT_RESTART_RESULT.json、AUDIT_EDGE_RESULT.json|
|未知结果小时/IP额度持久化，明确拒绝释放，无可用OTP|PASS|AUDIT_UNKNOWN_PERSIST_RESULT.json|
|模拟发送期间进程退出，pending流水经租约回收/新进程仍占额度|PASS，5条保留、第6次phone_hour|AUDIT_CRASH_RESULT.json|

localhost HTTP用真正sms/verify生成的token读取旧设备接口：A原账号/设备保留、B列表不含A且直接dashboard404、匿名401、新号无继承设备、BLE家长鉴权可通过、并发同码只有一个200另一个401。这里A/B均隔离测试身份，不冒充生产A/B手机。

已核secret先验、HMAC namespace及旧SHA兼容、parent角色检查、事务is_new、no-store、Retry-After、可信IP、异常日志脱敏、4KiB请求体、新号与旧号身份隔离。未修改公共设备授权模型或重新绑定设备。

## 发布与未验范围

- 本审计全部SMS外部调用用替身；未访问生产、未发短信、未取真实手机号/凭据。短信受理、供应商送达、持有人实收三层仍由主13独立取证。
- 生产A/B历史账号/设备归属保留须发布前后回读，并最终用真实SMS登录得到的token核现有设备API；隔离测试不是手机实收证明。
- 原53断言及主服务其他回归由主13执行，我未在本次独立树重跑该旧脚本；不要把本报告写成全仓typecheck通过。
- rollback须保持sms.db/账号/归属；旧验证码实现不识别新`h1:`码，若退旧代码，在途用户重新取码，不回灌整库。改验证码代码不能静默更换AUTH_JWT_SECRET。

最终补验：路由onError已经将未处理的存储异常统一为503 `sms_unavailable` JSON，并仅记安全request_id；注入reserve异常的第17项测试通过，未调用provider、未回显私有错误。主13固定commit的4个运行文件已逐一git show校SHA核同。最新重跑hardening17、HTTP21、未知额度持久化/明确拒绝释放、崩溃pending计数全通过；Spug transport8项及旧SHA/并发/重启证据按相关源码等价复用。

非阻断限制：issue与complete不是同一个事务；当前10秒provider超时小于30秒租约，常规并发及恢复已验。后续扩多进程/改长超时，应重新核在途请求和租约所有权，不为本次内测新增分布式事务设施。

署名：codex（OpenAI）| 2026-11-03
