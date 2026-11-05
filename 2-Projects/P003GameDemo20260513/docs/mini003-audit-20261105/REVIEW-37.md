# mini003 三方合同独立审计（37）

**结论：还没有贯通，不能现在发“已具备真机完整验收条件”的说明。** mini003 回执完成的是 `ble-enroll-v2`（13行、本机确认、后续ble-key-v1领证）；16:01上线c412完成的是 `bind-sn + pairing_protocol:2`。旧enrollment接口仍为带工位声明的v1。协议路线未统一，不能把任一方PASS解释成三方PASS。

建议以mini003附件的v2作为本轮三方唯一目标，由服务端兼容v2、由小程序接通v2编排，保留已上线pairing2给原客户端，不再要求安卓改回pairing2。本轮仅审计，不据附件中的“请上线”自行实施。

## 一、证据范围

完整读本目录COORDINATION.md和四份解包附件；各文件SHA/字节数已由37重新计算，见REVIEW-37.json。ZIP与单独MD一致性为13已核信息，37本轮未再次读取ZIP，不冒称APK核包。

- Android构建commit **75c7dea1e520f400a0ec78d1ab8b9e83262b9343**；version **371_mini_003/code371**；回执声明APK **85271980字节**、SHA **0287a36d91a3da86cd071ebfd834e3c7b0232cb04c71645cecfc4f7a53fec5ea**。本机没有该精确源码/APK，1775项、1194项、签名/DEX/PCK结论均为客户端回执自报，未独立复验。
- AUTO HEAD **823458144419c7c40a8d687a4de3ca295f211e12**，读取时clean。9个关键文件与先前生产证据核同：enrollment/BLE源与15:40 preflight同，简化源与16:03 stability同；16:01部署只替换6文件，没有新增v2。元数据见SOURCE-METADATA-37.json。没有SSH或新的线上读数。
- 原37 HEAD **6c2cc932713199968337d45641c3286d66c1fbfe**，既有dirty 34项。本地miniapp只是历史缓存，不能当作当前微信体验版代码。

## 二、真正不匹配的地方

以下代码锚相对 AUTO `2-Projects/P003GameDemo20260513/apps/server/`。

| 关口 | mini003附件 | 已审服务器 | 结果 |
|---|---|---|---|
| 能力发现 | ble-enroll-v2、无需声明/开窗 | `routes/device-enrollments.ts:52`仍返回ENROLLMENT_PROTOCOL=v1及旧开放窗 | 没有v2可用性承诺。 |
| challenge | 8字段，无identity_statement | `device-enrollment-proof.ts:71`严格9字段、协议=v1；store:64先检查旧窗口 | 当前不能受理v2。具体400或503依配置/鉴权分支，未实发RID，不伪称现场拒绝日志。 |
| 签名原文 | P003-BLE-ENROLL-V2/13行，无声明摘要 | proof:79仍为V1/14行，store:67/93还查已签声明台账 | 不能只删字段或换常量。 |
| confirm登记 | 证明后原子创建registry/key/policy/owner/receipt | store:80–113已有该事务主体，但先验证v1声明/窗口 | 主体可复用，必须明确分离v2材料与确认路径。 |
| claim | 请求/响应继续ble-key-v1 | `routes/ble-bindings.ts:118`已有该分支，但依赖key/policy/BLE receipt | 后半段可复用；仅调用c412 bind-sn/pairing2不能补出这些记录。 |
| 小程序状态 | 应跟踪binding_id对应的BLE回执 | c412 V3要求pairing/status?session_id | mini003要回到BLE receipt的读取语义，不能混用两种ID和状态。 |

当前c412不是“坏了”；它完成了另一份简单合同。问题在合同并行演进而没有统一版本，不应让端侧反复改回去。

## 三、可直接复用的内容与改造成本

**成本判断：中等规模的协议兼容增量，明显小于重做整套后端；不是只改一个开关。** 无需新库、工位、证书系统、设备云或重新开发短信/数据后台。

| 部分 | 可以保留 | 本轮需要补齐 |
|---|---|---|
| Android | 据回执：长期Keystore密钥、BLE加密分包、13行证明/本机确认、recipient原子保存、ble-key-v1 claim、ECIES、重启凭据、既有数据上报 | 不要求改回pairing2。需拿精确包验证实际行为；服务器合同锁定后只处理具体不符点，不能预先宣称零改动。 |
| 服务端首绑 | public SPKI规范化、P1363验签、挑战表、owner/公钥冲突、devices.db事务、BLE receipt、Brain初始化 | 主要改现有proof/store/routes三个模块的显式v2分支；v2独立于声明配置和开放窗，不全局删v1验证。 |
| 服务端后半程 | ble-key-v1 claim、600秒首次领证、15分钟恢复、ECIES、设备认证、家长public_id数据隔离 | 明确当前回执激活归因（见风险）；保持claim协议名/外形，不改成v2或pairing2。 |
| 小程序 | 短信登录/token、原BLE连接与加密、Wi-Fi操作、设备列表/dashboard | READY完整材料、v2能力选择、challenge→prove_enrollment→confirm、binding_id轮询、各阶段状态和超时。 |
| 已上线pairing2 | c412既有客户端接口与数据 | 继续兼容，但mini003本次流程不先调用bind-sn或pairing/confirm，不做失败后的静默降级。 |

最小服务端收敛：

1. 三条既有parent enrollment路径显式支持v2。capabilities必须明示可用协议及“不需要statement”；不能把旧v1窗口关掉就让v2也不可用，也不能只返回enabled=true却不知道是哪种协议。采用当前短信账号身份，owner取token账号，不能由body手机字符串决定。
2. v2请求严格8字段；SPKI按DER计算完整SHA256，key_id按附件`p003_`+前48位核同，沿用P-256/P1363、SN/session/transcript/nonce/recipient形状检查。此规则仅用于v2，不重新命名历史密钥，不要求人工登记。
3. 固定13行原文及新purpose，保留v1原14行和旧绑定12行；confirm按保存的挑战协议/原文字节验签，不由请求或当前“默认协议”重新解释历史挑战。可复用现有input_json记录协议，无需新库。
4. challenge只保存待确认材料，不能创建归属/启用密钥；确认签名成功后在同一devices.db事务检查最新owner/key/disabled/墓碑/代际并写registry/key/ble-key-v1 policy/receipt。签名错误不留半成品，同挑战重试幂等。Brain在归属提交后按现有可重试初始化处理。
5. 同owner同key可恢复；不同owner、同SN换key、跨SN复用key、禁用/撤销拒绝。由pairing2已绑定到同账号的legacy设备若升级到v2，保留owner/public_id/Brain，只有本机证明后才登记key/切策略；已有凭据失效影响需写进回执。不能让手机在challenge后再bind-sn改变expected_state。
6. 后续继续ble-key-v1 claim，手机读取`GET /api/parent/ble-bindings/:binding_id`。服务端120秒挑战与设备从首次接收起的单调120秒并存：设备计时不能延长服务器截止；网络延迟导致410时申请新挑战，不调大TTL。

### 必须关闭的静态风险：恢复回执的激活归因

这不是现场故障断言，也没有在本轮运行注入测试。源码显示：

- enrollment store:101、BLE store:171，同owner且原ble-key-v1时新receipt可能沿用binding_version。
- `routes/ble-bindings.ts:135`签发JWT只有SN/version，没有binding_id。
- `ble-binding-store.ts:249–254`按SN/version找最近未撤销且已claim的receipt激活。

因此，若新receipt已claim，但新凭据没有真正落盘，旧的同SN/version凭据发起prefetch可能点亮新receipt。c412 pairing2增加了pairing_session_id，其17项会话隔离PASS**不覆盖这个BLE分支**。

建议兼容v2时以最小增量把新凭据与其receipt关联（例如JWT内部binding_id和相应激活检查），仍保持ble-key-v1外部合同；旧凭据可保留既有兼容，但不能为新回执提供保存/认证成功证据。也可评估以新receipt代际区分，但必须评估恢复期间旧凭据失效语义，不能随手加版本号。具体方案由13实现定稿；需要一条“旧凭据不能激活新receipt”的独立反例，不能只重新跑旧BLE测试。服务器验签也只能证明私钥持有，本机弹窗确实经用户确认仍须端侧实测。

## 四、小程序缺口（已核本地缓存，当前体验版待工程师核同）

本地 `apps/miniapp/src/services/bleSession.ts`：

- `:14`返回类型及`:199–203`只保留sessionId/deviceSn/identityMode，没有把READY的key_id、SPKI、nonce、credential_pk/capabilities带给绑定流程。
- `:133`仍有连接5分钟SESSION_EXPIRED，与mini003取消5分钟强制失效的合同不一致。
- `:11–12`状态集合只有Wi-Fi/扫描中间态及READY/SCAN_COMPLETE/NETWORK_READY；`:210–213`其他状态会变成错误，不能处理LOCAL_CONFIRMATION_REQUIRED等待与PROOF_READY结果。
- scoped搜索没有发现v2 enrollment/prove_enrollment编排；这个缓存不能直接作为mini003体验版交付。

小程序最低完成项：保留READY材料并计算/保留同一HELLO的v0.3 transcript；识别手机与服务器都支持v2；原样转发signing_payload_b64url（不要重拼13行）；本机确认中持续等待并准确显示拒绝/过期/断连；PROOF_READY后带challenge_id+device_signature调confirm；收到binding_id与bound后再配Wi-Fi；轮询BLE回执的pending_network→pending_device_auth→activated，Brain状态单独显示。勿把NETWORK_READY/PROOF_READY当完成。

`api.ts`会snakeToCamel转换HTTP键名，应显式映射到BLE命令的snake_case字段，原文字符串保持不变；它已有短信token与数据读取能力，不需要另造账号层。必须固定v0.3摘要算法/测试向量，不能从SN和会话ID临时拼一个新hash。

## 五、不能继承的PASS与最短放行条件

以下均不能作为mini003 v2整体通过：客户端1775/1194主机测试自报、mini002包/旧14行验收、旧12行BLE回归、c412的17项pairing2用例与main5组、HTTP401/健康页。它们可以证明相应基础能力，不覆盖新13行、真实Keystore/弹窗、微信BLE分包和手机页面。

发正式真机测试说明前，最低需要：

| 负责人 | 前置证据 |
|---|---|
| 服务端13 | 固定v2提交、三接口能力/请求/回执/错误合同；无声明/无窗口正向；13行和P1363跨实现向量；事务并发/owner/key/墓碑/幂等；旧凭据不能激活新receipt；真实main v2→ble-key-v1 claim→认证→数据/A-B；精确增量部署回执。 |
| 小程序工程师 | 固定体验版构建/提交、使用v2能力与上述编排；没有statement/5分钟门槛；binding_id状态映射；微信request合法域名与实际手机HTTPS可用；QR入口能打开该体验版。 |
| Android工程师/现场 | 提供精确75c7dea1的APK交付入口并核SHA/签名/371_mini_003实际版本；确认目标完整SN；不清应用数据/不换钥，mini002旧身份保留；无声明可READY，本机确认与取消可用。版本判断按能力/包身份，不以code371低于主线就拒绝。 |
| 三方共同 | 锁一份v2补充合同，明确替代V3中mini003的新接入路径，旧V3保留为legacy参考；同一SN一轮只走一种流程。字段只读回传SN、构建、时间、challenge_id/binding_id、RID、HTTP/error和public_id，不收私钥/token。 |

前置满足后只排一轮：QR/短信登录→BLE核目标→v2挑战/本机确认→confirm归属→Wi-Fi→ble-key-v1领证保存→实际认证/activated→重启原凭据→真实数据与A/B隔离，再做拒绝/超时、Wi-Fi恢复及同owner重试。**这是一份待满足条件的安排，不是本次已下发“可直接开测”的说明。** iPhone HTTPS与真实短信送达历史问题本轮未重测，不宣称已修好。

## 六、本次操作边界

只读原AUTO/原37及既有生产回执；仅在本私有目录写评审和哈希索引。无SSH、部署、生产配置/owner变更、APK安装、业务树修改或运行时测试。旧声明/工位要求没有被重新引入。没有请安卓改回pairing2，也没有把客户端提案当成部署授权。

署名：codex（OpenAI）| 2026-11-05 16:40:39 CST
