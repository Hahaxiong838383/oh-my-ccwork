# 60485d45 自动接入候选独立评审回执（37）

**结论：本轮在指定SHA的独立归档上未发现发布阻断，支持13继续部署前核验与发布。不是生产通过、C真机通过或完整端到端验收通过。** 所有测试用隔离账号/SN/密钥/SQLite，未访问生产、未为C签发材料或制造owner。37未修改13实现树。

候选：`60485d45e566eba7b6e26277e925b8e68852a16b`；基线：`7ccd1f7cd3e9c23b148c4712686dc1a17cdc297a`。
从git archive固定导出服务器目录，归档SHA256：`585ebacd311a605bc9fce9fffdb2a638161006bf57604946c78a85cd98c27524`。运行Node `v24.19.0`。测试前后核13个变更服务器文件均与提交原字节一致。测试新增脚本仅在协调目录的归档副本中，未改候选源码。

## 已独立执行的证据

| 测试 | 结果与边界 |
|---|---|
| 候选17项边界 | 17/17，独立重跑成功 |
| 候选真实TCP HTTP完整链 | 签发→challenge→设备签名→自动建档绑定→ECIES claim解密→实际凭据鉴权/prefetch→activated；A/B回执隔离通过 |
| 原37树旧BLE核心 | 原字节带入，26项通过 |
| 原37树旧BLE HTTP | 原字节带入，绑定/Brain/列表隔离/旧入口门控/claim/激活/版本撤销通过；此脚本默认Hono内存HTTP（不是另一个TCP测试） |
| 原37树旧BLE guards | 原字节带入，19/19通过 |
| 原37树Analytics BLE auth | 原字节带入，实际HTTP鉴权/只读状态/版本隔离通过 |
| 新增37独立边界 | 8组通过，含5轮双进程真实竞争（不是同线程顺序调用两个连接） |
| 新增37 HTTP负向 | 缺配置、enabled=false、窗口已过期、配置0644、错角色JWT、超体积请求均按预期拒绝；随后整条真实TCP正向链再次通过 |

所有执行退出码0。旧测试原字节及hash见`evidence-37/candidate-60485d45/old-tests-origin.json`；四个文件与候选自带文件亦完全相同。未以13来信或旧测试结果代替本轮运行。

独立8组：①receipt插入末端故障，registry/key/binding_state/receipt/兼容BLE challenge全部回滚，enrollment challenge未消费，恢复后可重试；②两个不同SN预先携带同nonce，第二提交拒绝且无部分建档；③仅存在凭据撤销历史、无registry也拒绝再准入；④同账号两个竞争challenge不覆盖首次成功回执；⑤声明恰好到期但窗口仍开，未消费confirm拒绝；⑥缺配置无默认secret回退；⑦最大标识符与合成消息测长；⑧两独立Node进程、独立SQLite连接同步提交，5轮每轮恰一owner/一receipt胜出，另一方device_already_bound。

## 合同与源码核查

- 工位端点 `/v1/device/provisioning/identity` 只接受专用配置Bearer；家长JWT实测401。新增源码/工具没有生产secret字面量，提交未加入配置JSON或.env。实际生产秘密未读取；部署生成和0600落盘由13负责。
- 缺配置或配置错误默认503拒绝，窗口/启用开关分别检查；不存在默认放行。配置检验signing_secret与provisioning_token分离、权限、长度。默认关闭已经通过真实HTTP验证，不能推断生产已部署正确配置。
- 工位签发仅写声明表，不建registry；家长challenge只写pending，首次不需要设备业务JWT。设备PoP通过后，同一devices.db连接BEGIN IMMEDIATE中写registry/key/policy/version/owner/回执并消费挑战，末端故障回滚已测。
- 新签名用途域`P003-BLE-ENROLL-V1`，14行覆盖账号/SN/key_id/公钥hash/声明hash/BLE会话/领证材料/随机数/期限；不改变旧12行v1合同。新confirm复用原receipt格式，claim明确为`binding_protocol=ble-key-v1`，不是旧bind_token协议。
- owner/key冲突、停用、删除墓碑、nonce复用、挑战过期、声明撤销均受保护。已提交请求在窗口/声明过期后可幂等回读，但仍检查当前owner/key/version；未提交请求不能绕过关闭。
- Brain在归属事务后可重试，不声称跨数据库原子；真实HTTP首次Brain ready，旧HTTP原字节回归验证过Brain失败保持绑定、正确恢复。
- 新增业务改动之外只导出receipt/initializeBrain并挂载新路由。该提交没有改SMS文件；本轮未重复13的完整SMS/业务typecheck检查，也未独立核实生产SMS当前基线。不能将“与提供基线未改SMS”等同于生产漂移验收。

## 给13最终端侧合同的明确说明（非当前代码阻断）

1. 工位脚本是**stdin公共身份JSON→受控签发API→stdout公共声明**的适配器。它本身没有实现USB读取与设备落盘。设备初始化工具须自动读取当前设备SN/key_id/SPKI并把返回声明保存到同一设备；工位Bearer不能下发APK/小程序。不能把适配器测试成功称为真实工位已全自动接好。
2. 签发body的`model`只接受字面量`P003`，声明mdl也为P003。最终合同须说明它是产品域；现场硬件型号MAX不能直接代入，否则400。此处不是MAX设备不受支持。
3. 声明为服务端HS256签名的紧凑JWS，设备/小程序只保存和转发，不持有验签secret；其真实性由后台核验。不要把旧草案“一次配置厂商公钥”的建议当成本实现字段。
4. 配置轮换时signing_secret应与新issuer_key_id一起换；若仅换secret不换issuer，issue幂等分支可能返回旧声明，而verify使用新secret拒绝。当前无轮换任务，不是本次首发阻断；在运维合同写清组合更新即可。现有已登记BLE绑定不依赖声明有效期；新接入/尚未消费challenge会受新配置影响。
5. 实测最大64字符key_id/issuer/account的合成消息：待签原文593字节、READY样例1133字节、prove_binding样例846字节、声明594字节，满足当前1400/2024上限。只是所构造包络；真实固件最终READY额外字段和传输头须按冻结JSON再次测长，不能声称已验证371端实际消息。
6. 当前候选DESIGN.md仍是13:46方案说明，尚有“具体字段待冻结/未上线”等历史文字。13部署后需输出真实URL、请求/响应/错误、SPKI base64url格式、签名字节、秒/毫秒单位、365天声明/120秒挑战/600秒claim/900秒恢复及实际14天窗口的固定合同，不以旧草案替代。

## 证据与剩余验收

证据根：`evidence-37/candidate-60485d45/`。
- `candidate.tar`：指定SHA服务器源码归档。
- `candidate-verification.json`：hash前后、无新增配置、无SMS差异、secret字面量扫描摘要。
- `initial-test-results.json`、六个对应`.log`：独立重跑结果。
- `independent-boundaries.log`、`independent-http.log`：37反例与真实TCP结果。
- 归档副本`scripts/independent-enrollment-37.test.ts`、`independent-http-37.test.ts`：可复跑脚本，仅使用合成设备。

发布仍由13完成：生产基线漂移/配置密钥安全落地/14天窗口/部署后公共接口和回滚核验；37此次未测生产Node版本，不把Node24本地通过替代线上Node22验收。C现场仍需真实初始化工具→BLE本机确认→先bound后Wi-Fi→claim落盘→重启鉴权→真实数据A可读B不可读。iPhone HTTPS不在此次候选测试范围。

署名：codex（OpenAI）| 2026-11-04 15:21 CST
