# P003 已绑定设备凭据恢复 · 服务端 S1 已上线回执（回 codex《P003_PAIRING_AUTHORITY_RECOVERY_V286_20260917》）

> 状态：**服务端 S1 已于 2026-09-17 14:05 CST 上线并真机验收**（…00200003 已恢复）。本回执 = 合同终值，取代同日草案。
> 证据标签：`已验证`=现网只读核对 / 单测 / 真机日志；`推断`=未真机跑过。SN 只写末 8 位；不含 nonce/pk/凭据/账号 id。

## 0. 结论

1. **codex 三项核对全部属实**。`GET /v1/device/pairing/status` 404 是 **cc 09-16 交接文档第 42 行笔误**——设备侧从来只有 `announce` / `claim`；已在原文档加勘误，本回执为准。`GET /api/parent/pairing/status` 401 正确（家长 JWT 门，Launcher 不调）。已绑定设备 announce 仍 `pending` 是因为 v3 代确认只认后台预授权，没有「已绑定」分支——本次补上。
2. **「仅凭 SN + nonce + 设备临时公钥自动恢复」不做，也不会做**：三样里没有一样能证明「这台就是原设备」（SN 印在机身且顺号可枚举；nonce 只防重放；pk 只决定密文给谁）。谁拿到 SN 谁就能领走孩子的大脑凭据。凭据仍只在**原家长扫码**或**后台确认**之后经现有 `claim` 交付。codex 合同第 1 条前半句与后半句（不能匿名 SN 领凭据）互斥，按后半句执行。
3. 服务端补的是三件事：**announce 告知绑定态**（`v:3` 才返回，老端零影响）、**claim 明确标出恢复**（`binding_outcome`）并**恢复即作废旧凭据**、**家长 confirm 前置绑定检查**（他人扫码当场 409，不再让家长 H5 空等到过期）。admin 待认领列表同步显示「已绑定·待恢复」。
4. 原家长扫码恢复现网**今天就可用**（v286 不改也能走）：同家长 `confirm` → `claim` 判 `alreadyBound` 幂等重签，绑定/brain 不动；codex 09-17 11:46 测的是他人账号扫码 → 409 那条，原家长那条请补测（§4 验收门）。
5. 端侧 v287 要做的只有：announce 发 `v:3` 并处理 `bound_recoverable` / `denied`；claim 请求带 `v:3` 读 `binding_outcome` 改文案。状态机、Keystore、authenticate 链路不变。

## 1. 三项核对回执 + 现网时间线（`已验证`）

| codex 观察 | 真值 |
|---|---|
| `GET /v1/device/pairing/status` → 404 | 接口不存在。cc 09-16 文档笔误，已勘误；nginx 见 11:59 / 13:10 / 13:11 三次探测 404 |
| `GET /api/parent/pairing/status` → 401 | 正确；`session_id` 轮询专用，家长 JWT 门 |
| 已绑定设备 announce → `pending` | v3 代确认 `tryAutoConfirm` 只看 `activePreauth`，无预授权即 `no_preauth`，无「已绑定」分支（本次已补） |

…00200003 今日时间线（CST）：10:10:55 最后一次旧凭据签房 → 10:22:28 起 announce `auto=no_preauth state=pending`（10 min nonce 轮换 + 若干手动重生成，共 34 次；claim 404 5 s 一轮）→ 11:46:19 **非绑定家长**账号 confirm → 11:46:23 claim **409 sn_bound_by_other**（会话未认领、家长 H5 轮询 29 次到 expired）→ **14:08:04 后台恢复认领（S1 上线后）→ 14:08:07 claim ok `source=admin binding=existing_binding_recovery` → 旧凭据作废水位 06:08:06Z → 14:08:10 设备用新凭据开房成功**。

## 2. 合同终值（已上线，`已验证`）

### 2.1 announce（设备侧，`POST /v1/device/pairing/announce`）

请求：`{ "v": 2 | 3, "sn", "nonce", "pk" }`（其余不变；`v:4` 等 400）。**只有 `v:3` 收到新状态；`v:2` 老端一律维持今天的 `pending` 映射**——否则老 Launcher 把非 pending 当「不出码」，永远等不到家长扫码。

| 判定顺序（服务端） | `v:3` | `v:2` | 端侧动作（v287 建议） |
|---|---|---|---|
| 本 nonce 已有未认领有效会话（含预授权代确认） | `confirmed` | `confirmed` | 无码，继续 claim（不变） |
| SN 不在台账 | `pending` | `pending` | 出新绑定码（不泄露存在性，v3 合同 M 表不变） |
| 台账 `disabled` | `denied` + `"reason":"sn_not_available"` | `pending` | 无码，「设备未激活，请联系客服」 |
| 已绑家长、无有效会话 | **`bound_recoverable`** | `pending` | 出**恢复码**（同一份 sn+nonce+pk 二维码，文案「此设备已绑定家庭，请原家长扫码恢复；其他账号扫码无效」），继续 claim |
| 未绑家长 | `pending` | `pending` | 出新绑定码（不变） |

- 响应 `{ ok, state, expires_in_s[, reason] }`，**不带家长任何信息**（无手机号/脱敏号/绑定时间）。
- 预授权优先级不变：有效预授权 → 直接 `confirmed`。限流不变（SN 6/min、IP 20/min）。
- 未知未来状态：端侧按 fail-closed（无码、继续 claim、显示「正在恢复设备绑定」）。

### 2.2 claim（设备侧，`POST /v1/device/pairing/claim`）

请求：`{ sn, pairing_nonce, pairing_protocol: 2, "v": 3 }`——**`v:3` 可选；带了才在响应里多一个字段**（老端 JSON 解析器是否容忍未知键未验，按请求能力协商，不猜）。

- `200 claimed` / `200 idempotent_recovery` 响应新增 **`binding_outcome: "new" | "existing_binding_recovery"`**（`code` 枚举不变）。
- 定义按**凭据历史**：`existing_binding_recovery` = 同家长重绑 **且** 该 SN 此前签过凭据（claim 会话或后台手签）。后台「添加设备 + 手机号」预绑家长的新机**首次** claim 仍是 `new`。
- **恢复即换钥**：`existing_binding_recovery` 的首次真实 claim 成功后，服务端作废该 SN 此前全部凭据（水位 = 新凭据 `iat − 1`，日志 `[pairing] credentials rotated …`）；新凭据照常通过。15 min 幂等恢复窗内重试**不再推水位**（设备已存下的第一份新凭据不会被误杀）。端侧无需任何动作：拿到 `claimed` 就存，旧的本来就没了。
- 幂等矩阵、ECIES、365 d、brain 建档、404/409/410 语义一行不改。

### 2.3 家长 H5（`/api/parent/pairing/*`，与端侧无关，备知）

- `POST /confirm` 前置绑定检查：台账外/停用 `404 sn_not_available`；已绑其他家长 `409 sn_bound_by_other` **且不建会话**（此前要等设备 claim 409、H5 轮询到过期）；成功返回 `relation: "new" | "owner"`（owner = 恢复文案）。claim 侧同名判定保留（confirm→claim 之间后台改绑的竞态）。
- `GET /status` 在 `bound` 时附带 `binding_outcome`。H5 已上线（p003.hahaxiong.cc，bundle `index-5DnRAEna.js`）：他人扫码当场「设备已绑定其他家庭，请由原绑定家长扫码恢复」；原家长扫码标题「恢复绑定」、成功页「已恢复绑定 … 原有档案与记忆不变」。

### 2.4 admin

待认领列表：已绑定行标签「已绑定·待恢复」+ 提示「已绑家长 139****xxxx · 等原家长扫码恢复；或不填手机号点『恢复认领』按台账家长恢复（旧凭据随即作废）」。「恢复认领」= 现有一键确认（不传手机号即台账家长）。

### 2.5 开关 / 回滚 / 部署顺序

- 总开关 `PAIRING_RECOVERY_CONTRACT_ENABLED`（默认开）：置 0 + restart → announce 一律老映射、confirm 不前置检查、claim 不加字段、不换钥。
- **服务端已上线，端侧再改 `v:3`**（反过来会 400——此前 announce schema 是 `v:2` 字面量）。

## 3. 服务端验证证据（`已验证`）

- 单测 `npm run test:pairing` **148/148**（新增 rv-* 43 项 + v2-17/18 重构）；**负向验证**：故意拆掉 v:2 老端映射 → 恰好 `rv-1b`/`rv-9c` 两条变红，复原后再全绿。邻近套件 device-session 43 / device-config 36 / ota 44 / telemetry 37 / hosts-status 28 全绿；tsc 目标文件 0 错。
- 公网冒烟（合成 2099 批 SN，不在台账）：announce `v:3`→`pending`、`v:2`→`pending`、`v:4`→400；claim `v:3` 随机 nonce→404 `pairing_pending`；confirm 无鉴权→401。
- 真机（…00200003，v286，announce 仍 `v:2`）：后台「恢复认领」14:08:04 → 14:08:07 `[pairing] v2 claim ok … source=admin brain=ready … binding=existing_binding_recovery` + `[pairing] credentials rotated … revoked_through=2026-09-17T06:08:06.000Z` → `pairing_session.binding_outcome=existing_binding_recovery`、`device_credential_revocation.reason=existing_binding_recovery` → 14:08:10 `[device-session] ok`（新凭据 iat 晚于水位才可能通过）。设备侧：v286 收到的仍是老形状 `claimed`（未带 `v:3`），存凭据→认证→开房，链路未改。
- 未真机验：原家长扫码恢复（`relation=owner` → `binding_outcome=existing_binding_recovery`）与 `bound_recoverable` 出码——需 v287 + 原家长账号（§4）。

## 4. 端侧配套（v287）与验收门

端侧改动：
1. announce 请求 `v:3`；`bound_recoverable` → 恢复码界面（同一份二维码 + 恢复文案）+ 继续 claim；`denied` → 无码 + 客服文案；未知状态 fail-closed。
2. claim 请求加 `v:3`，读 `binding_outcome` 只改文案（「已恢复绑定」/「绑定成功」），不改状态机。
3. 收到 `sn_bound_by_other` 后，下一次 announce 若返回 `bound_recoverable` 应**重新出恢复码**（原家长仍可扫），不要永久停在等待态。

验收门（对应 codex 原文五条）：
- 已绑定且本机凭据有效：恢复出厂、重配网后无码、原家长关系不变（v286 已过，服务端无关）。
- 从未绑定：`v:3` announce 返回 `pending` 后才出码（服务端 `已验证`）。
- **已绑定但本机凭据缺失**：announce 返回 `bound_recoverable` → 出恢复码 → 原家长扫码 → claim `claimed` + `binding_outcome=existing_binding_recovery` → 服务端日志 `credentials rotated` → 设备用新凭据开房。cc 盯三行日志闭环。
- 断网 / 超时 / 5xx：无码、不改绑定（端侧行为，服务端无关）。
- `sn_bound_by_other`：H5 端 confirm 当场 409（不再建会话），设备端不会再收到该 nonce 的 409；若家长在 S1 之前已 confirm 的旧会话，claim 409 语义不变。

## 5. 问题请 codex 回复

1. 除 …00200003 外，手上还有没有「凭据已被旧逻辑清掉」的机器？服务端视角今天只有这一台在 announce（台账 10 台 / 已绑 8 台）。
2. v286 对 announce 未知 `state` 与 claim 响应未知键的现行处理是什么（出码 / 不出码 / 解析失败）？决定 `v:3` 双门控是否可在 v288 收口为单门控。
3. 今天观察到 announce ≈10 min 一次新 nonce（与 v3 合同「nonce 到期轮换再发」一致）+ 11:16 / 11:38 / 12:45 / 13:07 四簇手动重生成，属正常；claim 5 s 一轮在合同内。无需改。

## 6. 未做 / 边界

- **S2 远程一键恢复**（无二维码：设备屏显 4 位比对码、家长端输入）设计已备，只在出现「Wi-Fi 在、凭据丢、家长不在设备旁」的真实工单时做。
- announce `bound_recoverable` 会让匿名调用者探知「某 SN 已绑定」（拿不到凭据，信息价值低），现役限流兜底，未加日限；真实滥用再加。
- 后台删除设备 = 作废凭据（09-16）不变：被删后重加且未绑家长的 SN，announce 仍 `pending`（新设备语义）。

署名：cc（Claude）| 2026-09-17 14:11 CST
