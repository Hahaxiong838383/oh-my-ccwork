# v376 方舟钱包独立排查回执（会话45）

结论：**已定位客户端源码的零值/未知语义不一致；服务端隔离验收通过，真机功能未收口。** 未发现本问题需要修改云端 `null` 处理的证据；不发布“null 转 0”的服务端补丁。安卓按 [最小修复合同](ANDROID_HANDOFF.md) 修复权威钱包投影，再由会话13统一安排真机验收。

## 已确证的链路

| 层 | 证据及结论 | 边界 |
|---|---|---|
| 测试身份 | 11月2日19:57，附件 trace 经 `device_session_log` 唯一匹配，pm2日志交叉核同，设备尾号03800006；实际选中倾听+搜索灰度 agent | 完整身份和房间只保留私有证据 |
| 历史问答 | 灰度 Brain journal 19:57:36 `[ark-direct] typed_facts=true`；独立 conversation.db 保存“我有多少家族币”及附件同文回复，双方 `memory_excluded=1` | 主 conversation.db 没有这轮记录是隔离库分流，不是丢数据 |
| 历史快照接收 | Nginx 19:52–20:01端点窗口有48条 `/v1/device/ark/state` HTTP 200 | 日志未记录SN/请求正文/accepted与duplicate区别，不能把48全部归给目标或证明各字段 |
| 历史普通快照内容 | 客户端回执报告 normal、双钱包null、补勤卡1、paused/宝箱300秒 | 服务端仅保留最新快照，历史body已被后续覆盖；本轮无法独立重建当时这四项完整正文 |
| 当前库 | `ark_current` 在排查时已是后续时间的GM快照；当前授权水位早于测试 | 当前状态不能冒充昨晚normal或解释其后实际操作；不修改GM、余额或epoch |
| 权威源码 | 正式v376构建记录指向 `3c653b5d3d28940fe6be275ba0382a6956d27234`；exact-ref取回10文件，9份运行源码逐字同v375，VERSION.lock有版本差异 | 已安装APK/PCK实际hash本轮未取，不能宣称包体再次验真 |

问答是有限事实直答，不是这轮模型凭空猜测余额。`typed_facts=true`说明取得有效类型的权威事实结果；它不记录每个字段，不能单凭此日志反推补勤卡和暂停进度当时的值。

附件测试时间为 **2026-11-02 19:52–20:01 CST**，早于v375服务端21:56发布和22:00配置。不能把后续Analytics新开关或诊断窗口当成这轮问题原因。Ark快照通道也不依赖夜批上传总闸。

## 源码根因

精确客户端文件与SHA见 [CLIENT_SOURCE.json](CLIENT_SOURCE.json)：

1. `rust_runtime/src/g1/model.rs`：`G1FormalState::default()` 的钱包为 `BTreeMap::new()`。合法新档可以没有两个币种的键。
2. `rust_runtime/src/g1_ark_state.rs:48`：双钱包用 `.get(...).copied()`，缺键得到 `None`，JSON输出 `null`。
3. `godot/g1/formal/views/scene_chrome.gd:51`：UI读取钱包时，非字典或缺键均显示 `0`。因此UI的0不能单独证明权威钱包已知为0。
4. `godot/scripts/ark_state_snapshot_client.gd`仅转发Rust语义；Launcher `P003ArkStateContracts.kt`保持null，并不会把真实0变null。
5. `rust_runtime/src/lib.rs:2005` 的 `g1_formal_state()` 对缺失或反序列化失败也会默认化。这意味着直接给Ark投影加无条件 `unwrap_or(0)`，会把存档错误一起伪装成零余额，不能这样修。

上述源码机制与附件现象一致；未取得当轮原始存档及完整请求body，故不声称已独立证明该实机当时的具体缺键路径。最小修复在客户端权威投影处，云端继续分别处理真实0、null和GM。

## 服务端验证

当前普通Brain的13份Ark/问答文件，逐文件SHA同时匹配发布前 `9e7aab980114b796e22cc5286a1edf5c44f3b35a` 和发布后 `856552b942f5f8c2feb08db5949ebe7080eff77f`。目标倾听Brain的answer/proxy/http/contracts/memory-policy五份文件也匹配；其独立 `canary-context.ts` 匹配 `cf6ef97a35b8e1c94fb7892316a56d9243684f46`。没有将普通Brain整树当作P2运行版本。

测试在私有固定856源码归档执行，216份源码/Ark测试/依赖清单逐字核同，Node v24.19.0，复用已验证依赖，无安装。测试均为合成身份、独立SQLite和回环HTTP，不调用外部模型，不向生产写事件。

- 新增真实本地HTTP链路：设备凭据 → schema → SQLite → authority → authenticated proxy → 同源preview/answer，**7/7通过（1父用例、6子用例）**。
- 既有 `npm run test:ark`：**51/51通过**，含实际HTTP/SSE、普通闲聊零查询、越权/epoch/GM、历史资产来源、动态问答不进长期记忆。
- 测试代码见 [wallet-contract.test.ts](wallet-contract.test.ts)，具体执行与日志hash见 [TEST_RESULTS.json](TEST_RESULTS.json)。本轮未运行全仓typecheck，不声明其通过。

本轮验证证明：上报null时余额未知，但补勤卡1及新鲜paused宝箱可以独立解释；上报真实0时可正确回答0；非零精确保留；不把余额当今日收益；GM→normal不泄漏GM值；重启保留值/收到时间；重复不续期；缺字段、字符串null、负数不被兜底。

## 交付与剩余边界

- 本分支只新增审计文档和独立测试，没有修改服务端运行源码、生产、48树、真机安装包或任何开关。
- 安卓负责实现并运行Rust/Godot/Launcher合同矩阵；本轮没有替安卓修改或执行其Rust工程。
- 真机要核固定修复SHA、实际APK/PCK、清档/恢复/正常资产变化，再对同一snapshot_id、boot/seq、服务器回执、preview和语音进行逐项对账。不要为测试随意清用户档。
- 普通快照的历史body、补勤卡/暂停进度的昨晚实际云端值仍为未独立取证；本轮孤立HTTP行为通过不等于真机通过。倾听A01–A06由38/39负责。

署名：codex（OpenAI）| 2026-11-03
