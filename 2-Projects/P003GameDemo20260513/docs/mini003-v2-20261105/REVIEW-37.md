# mini003 固定候选独立审核回执

**结果：PASS_PREDEPLOY_INDEPENDENT_REVIEW，无发布阻断。** 仅对候选 `a92bd8f342144d6253cbb9a928925639ffa597cc` 成立；部署与真机验收不能由本回执替代。审核时间：2026-11-05 17:21:33 CST。

## 实际核验结果

| 事项 | 37证据与结论 |
|---|---|
| 固定输入 | 从git archive提取a92bd8f，未使用13未提交改动。7个运行文件after SHA核同；原37 HEAD6c2cc932、dirty34项保留。 |
| 精确v2合同 | 11/11独立组通过。八字段、13行原文字节、P1363 64B、单次SHA256；测试侧独立拼串并用noble纯JS签名、服务端Node/OpenSSL验签；错误purpose/CRLF/尾LF/指纹/双重hash拒绝。不是AndroidKeystore实测。 |
| 自动首绑 | 无配置、旧配置关闭/过期均可v2；challenge不建registry；confirm原子落owner/key/policy/receipt。key写失败真实SQLite回滚无半成品。Brain失败owner保留且initializing，恢复后poll ready。 |
| 归属竞态 | 两独立Node进程同SQLite，争同SN同key、同SN不同key两轮均200/409；赢家owner/key一致，无覆盖。 |
| 精确激活 | 新receipt已claim但未解密保存新token时，上一receipt token及无ble_binding_id历史token可兼容认证、都不能把新receipt点亮；新token真正prefetch后才activated。 |
| 时效/恢复 | 120s challenge截止拒绝；首次claim在600s截止拒绝；已claim后899999ms可幂等、900000ms拒绝。owner改变旧claim409/旧token401；disabled、删除墓碑拒绝。 |
| 旧协议 | 固定候选原字节 `device-enrollment-http`、`ble-binding-http`、`pairing` 3脚本独立exit0；pairing148/0。分别覆盖旧v1、旧12行BLE、pairing兼容，未继承上一轮PASS。 |
| 完整main | 37核13证据：203个src文件等于当时生产快照+候选7文件；10个内嵌源码/测试文件与候选逐字节同。真main v2 5组、pairing2 5组、v1重试9组通过；包括SMS verify、实际认证、HTTP数据落库/A读B拒、服务进程重启。37未SSH复跑main。 |

最终独立测试：`/Users/fu-121/.local/state/p003-mini003-contract-audit-20261105/verification-37/run-candidate-v2-final/result.json`；旧兼容：`/Users/fu-121/.local/state/p003-mini003-contract-audit-20261105/verification-37/run-candidate-v2-compat/result.json`。冻结的安全结果、输入哈希和测试脚本见本目录`evidence-37/`，总索引见`REVIEW-37.json`。

## 失败记录与证据边界

- 原基线v2探针2过5失败，说明旧版不支持新合同；此记录不是旧激活漏洞的单独红灯证明。
- 首轮新增边界脚本插入到LOGIN之前，导致测试夹具顺序失败；已修脚本并完整复跑11/11，无业务修补。
- 13旧v1完整main第一次缺少`provision-device-identity.mjs`测试适配器，exit1保留；仅补固定候选同字节适配器后9组通过。没有把首次失败删除或说成一次全绿。
- 初始验收矩阵是计划；本回执只认实际断言。未声称全面畸形曲线/包长/限流模糊测试、APK全量审阅或物理Android签名通过。全仓typecheck仍有13报告的12个基线错误，不能写全仓通过。

## 交付口径与小程序接线

1. mini003走`device-enrollments` v2八字段/13行，不先调用`bind-sn`或pairing2 confirm。确认响应取`binding_id`、`device.public_id`；claim继续`ble-key-v1`，轮询`/api/parent/ble-bindings/{binding_id}`。
2. capabilities默认v2；旧v1能力发现必须加`?binding_protocol=ble-enroll-v1`，旧v1请求/14行/窗口仍保留。不能写“旧客户端能力发现完全零变化”。
3. 不增加工位JSON、声明、预录或固定开窗。120秒challenge、600秒首次claim、15分钟幂等恢复保持短TTL。
4. 无厂商签发材料的v2仅证明提交公钥的私钥持有，不证明SN厂家来源；这是用户已授权的简化策略语义，不追加工位或新PKI。已存在owner/key不静默覆盖。
5. 新token内部增加receipt关联，Android仍保存不解析；普通小程序不得把Wi-Fi已就绪、PROOF_READY或claim成功当activated。Brain三态独立显示。

最短接入步骤和失败对账见`MINIAPP-STEPS-37.md`。下一步由13部署与出正式交付；小程序按v2适配后，现场做QR→SMS→BLE→本机确认→confirm归属→Wi-Fi→claim保存→prefetch→设备重启→真实数据/A-B隔离。短信送达、iPhone HTTPS、APK与实际目标SN、微信体验版和C真机均未由本候选测试验收。

37仅写私有测试/审核文件，无生产、设备、owner变更。

署名：codex（OpenAI）| 2026-11-05 17:21:33 CST
