# 自动接入最终交付只读审核（37→13）

> 最终复核（2026-11-04 15:58 CST）：三项应修订及两项补全均已落实，本轮交付文档审核通过。下文初审问题保留为历史，已关闭；不代表C真机闭环通过。

**结论：部署证据与已审候选一致，未发现新增源码或生产发布阻断；两份交付文档有三处应修订，修订前不作最终文档无问题的无条件回执。** 无需改代码、重启或改设备；13可直接采用以下修正文案。

本轮完整读取 deploy-result.json、postcheck-result.json、stage-test-result.json、stage-analytics-node24-result.json、air-station-result.json，以及13树 CLIENT_CONTRACT 和 TEST_CASES。仅本地核对证据与既存60485d45归档，未连接生产/Air/C，未发短信或签材料。

## 部署证据核对

- deploy-result记录候选60485d45e566eba7b6e26277e925b8e68852a16b，2026-11-04 15:35:10 CST部署；6个文件SHA独立对照37归档，6/6相同，无追加源码迹象。
- 窗口1793777707605～1794987307605转换为11月4日15:35:07.605～11月18日15:35:07.605 CST，恰14天，与合同一致；配置0600。
- 发布前后registry17条、归属摘要相同、C_registered=false。15:43 postcheck仍17条，声明0/challenge0/C记录0、integrity=ok。不能解释成C绑定成功，也不能给C编造public_id。
- p003-voice重启49→50；kidshub-voice和p003-analytics PID/重启数未变。postcheck主服务仍PID4172529/restarts50；仅支持记录时刻状态，长期稳定由13继续记录。
- 公网新接口401/RID、工位畸形输入400、短信非法号码400支持路由/鉴权/格式验收，不等于真实收码或生产设备正向全链。postcheck JSON本身没有证书链/CT/Safari证据，不能据此宣称原iPhone HTTPS问题已解决。
- Node22.22.2新HTTP、17边界、旧BLE26/HTTP/guards19均exit0；stage-test-result.all_pass=false保留Analytics exit1事实，原因是既有UNSAFE_ANALYTICS_SQLITE_VERSION保护。后续stage-analytics-node24-result在埋点现役Node24.19.0 exit0。TEST_CASES解释准确，不能写成Node22全部通过，也不需放宽保护。
- Air工具SHA f1486e8c5f154f479c0b28067cc200f00aca3b6c39b07ff75338c2c9bb3aaa1d与候选/发布一致；安装回执为配置0600、credential_in_downloads=false。37未读取配置秘密；该回执不等于USB读取/设备保存已验。

## 应修订三处

### D1：CLIENT_CONTRACT §3.5，claim超期恢复接口应明确

当前仅写“原账号重新建立BLE会话、nonce和临时密钥”，新enrollment窗口关闭后会503；另有禁止旧路径降级的文字，可能使端侧也禁掉合法恢复。

建议补入：
> 已成功登记绑定的设备，由原账号重新领证时，使用 POST /api/parent/ble-bindings/challenge，请求为 binding_protocol=ble-key-v1 加 sn/device_key_id/ble_session_id/ble_transcript_hash/pairing_nonce/credential_pk，共七字段，不提交identity_statement和identity_public_key_spki。设备走既有12行 P003-BLE-BIND-V1 证明，再向 /api/parent/ble-bindings/confirm 提交challenge_id/device_signature，取得新binding_id后claim。该恢复路径核云端已登记active公钥及原owner/version，不受新增登记窗口关闭影响。尚未成功登记的设备不能用它绕过enrollment，不能改用SoftAP或裸SN绑定。端侧需保留原12行prove_binding能力用于恢复。

证据：旧ble-binding-proof严格七字段/12行，旧BLE路由不读取enrollment配置；新confirm已登记公钥与兼容receipt，旧BLE回归通过。无需追加源码。

### D2：TEST_CASES N06，“全局容量已通过”超过已给证据

17边界只执行每账号12个pending限额及过期回收；37独立8组也未造全局4096条。提供日志只见 pending capacity has a finite per-account bound。全局4096有源码，不等于已实测。

建议N06改为：
> 数据库事务中断/双进程抢绑/每账号挑战容量已在隔离环境通过；全局4096上限已源码核对，本轮未做全局容量实测；不对生产故障注入。

若13另有实际执行记录可明确补证；本轮不必为文案新增生产测试。

### D3：TEST_CASES C03，工位stdout不含idempotent

签发HTTP响应有idempotent，交付的provision-device-identity.mjs只输出ok/sn/device_key_id/identity_fingerprint/identity_statement/identity_expires_at_ms/request_id，没有idempotent。

建议C03取证改为：
> 第二次RID、相同声明摘要/指纹/有效期；后台按RID核签发idempotent及无重复身份。适配器stdout不输出idempotent，不要求安卓读取该字段。

无需改工具或后端。

## 建议顺手补全

- C09“页面先显示pending_device_auth”不应是必须捕获的中间态。设备若立即鉴权，小程序首轮可直接读到activated。建议写“未鉴权为pending_device_auth；已鉴权可直接activated，以后台状态和鉴权证据为准”。
- 合同补齐 brain_state=ready|initializing|unavailable：initializing可经回执查询重试；unavailable表示当前Brain映射/账号无效等，不承诺自动重开。错误表可补旧BLE/claim的503 binding_temporarily_unavailable，它不同于新接口enrollment_unavailable。

## 其余合同核对通过

四字段签发、九字段新challenge、两字段confirm与源码一致；SPKI规范DER91字节/P256/base64url和33字节临时压缩公钥区分准确；model=P003而非硬件MAX正确。

14行顺序与enrollmentSigningPayload一致，LF无尾换行、ASCII、声明原文UTF8摘要、SPKI DER摘要、P1363固定64字节、SHA256一次哈希正确；新14行和旧12行用途隔离明确。120秒challenge、600秒首次claim、首次claim起900秒恢复、365天声明/业务凭据与源码一致。

confirm实际字段、claim_protocol=ble-key-v1、三个activation_state语义准确；bound不代表全链激活。限流12/60/90及body4096/8192与路由一致。

短信verify实际返回token，成功后upsertPhoneAccountWithStatus及parent JWT保持原手机号身份。合同没有误引入独立微信账号，也未混用工位/家长/设备Bearer。

工具只是stdin→签发API→stdout；Android自动USB读取及保存同一设备、本机确认、C配网/claim落盘/重启鉴权、真实数据A/B隔离明确待端侧实现与真机验收，边界表述准确。

审核文件hash见 evidence-37/final-delivery-review-metadata.json。最终生产稳定记录、文档修正和Air回执由13完成；本轮不启动其他会话。

署名：codex（OpenAI）| 2026-11-04 15:52 CST

## 文档修正最终复核

已只读逐项确认：CLIENT_CONTRACT明确已登记原账号的旧七字段/12行恢复接口和新增窗口例外，补齐Brain三态及旧BLE/claim的503；TEST_CASES明确全局4096仅源码核对、工位stdout不含idempotent，并允许鉴权后直接读到activated。此前D1–D3及两项建议全部关闭，未发现剩余交付文档阻断。

同时核对 recovery-after-window.log 与 recovery-verification/scripts/device-enrollment-http.test.ts：脚本在enabled=false后断言新enrollment拒绝，再经原账号真实HTTP旧12行challenge/confirm取得新回执，claim解密、prefetch及activated断言均有对应PASS记录。本轮为脚本/日志只读核验，没有重跑测试；这是隔离合成设备证据，不是C真机。

本轮只更新本审核报告及证据指纹，未改源码/生产/设备，未启动其他会话，也不扩展核查823秒稳定或回滚新证据。最终分发、Git收口及生产回执由13继续完成。

署名：codex（OpenAI）| 2026-11-04 15:58 CST
