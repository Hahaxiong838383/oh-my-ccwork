# P003 已绑定设备凭据恢复 · 服务端联调合同 v1 草案（回 codex《P003_PAIRING_AUTHORITY_RECOVERY_V286_20260917》）

> **2026-09-17 14:11 CST 已实施上线，终值以回执为准**：[2026-09-17-pairing-已绑定设备凭据恢复S1服务端已上线回执｜announce v3绑定态+claim binding_outcome+confirm前置检查+恢复换钥+0003真机验收+status接口勘误(给codex).md](2026-09-17-pairing-已绑定设备凭据恢复S1服务端已上线回执｜announce v3绑定态+claim binding_outcome+confirm前置检查+恢复换钥+0003真机验收+status接口勘误(给codex).md)（差异：confirm 的 relation 值定为 `new|owner`；claim 响应字段只在请求带 `v:3` 时返回）。

> 状态：**草案，等川哥拍板后发 codex**。服务端零改动已上线的部分按「今天就有」标注；其余按 S1/S2 分期。
> 证据标签：`已验证`=现网只读核对或代码逐行读过；`本轮观察`=今天日志/库；`推断`=未真机跑过。
> 红线不变：SN 只写末 8 位；不打印 nonce/pk/凭据/账号 id；测试身份只用 POCTEST0001 / 后台已登记的测试机。

## 0. 结论先行

1. **codex 三项核对全部属实**，其中 `GET /v1/device/pairing/status` 404 的根因是 **cc 09-16 交接文档写错了**：设备侧从来只有 `announce` / `claim` 两个接口（`apps/server/src/routes/pairing.ts` 全文、`index.ts` 挂载点已验证）。已在 09-16 文档加勘误。
2. **「仅凭 SN + nonce + 设备临时公钥自动恢复」不能做**：三样里没有一样能证明「这台就是原设备」——nonce 只防重放，pk 只决定密文给谁，SN 印在机身上且顺号可枚举。谁拿到 SN 谁就能领走孩子的大脑凭据。可信锚只能是**原家长**（扫码 / 远程确认）或**后台**。codex 合同第 1 条与第 1 条后半句（不能匿名 SN 领凭据）互相矛盾，本草案按后半句执行。
3. **原家长扫码恢复现网今天就能走**（代码级已验证，真机未验）：同家长 `confirm` → 设备 `claim` → `performSnBinding` 判 `alreadyBound=true` → 重新签发凭据、`parent_account_id` 不变、brain 不动、响应 `code=claimed, idempotent=true`。codex 今天在 …00200003 上测的是**他人账号扫码 → 409 sn_bound_by_other** 那条（11:46:19 confirm 的账号 ≠ 绑定家长，11:46:23 claim 409，已验证），原家长那条没测。
4. 服务端要补的是**把「已绑定」这件事在 announce 阶段告诉设备**（让端侧不再按新设备渲染）+ **claim 明确标出「恢复」**+ **confirm 前置绑定检查**（他人扫码当场 409，不再让家长 H5 空等 10 分钟到过期）。这就是 S1，半天工作量，老端零影响（按 announce `v:3` 门控）。
5. 无二维码的「远程一键恢复」（S2，数字比对码）可做，但只在出现「Wi-Fi 还在、凭据丢了、家长不在场」的真实工单时再做。

## 1. 三项核对回执 + 今天现网时间线（…00200003，`本轮观察`）

| codex 观察 | 真值 | 说明 |
|---|---|---|
| `GET /v1/device/pairing/status` → 404 | 接口不存在 | cc 09-16 文档第 42 行笔误，已勘误。nginx 今天 11:59 / 13:10 / 13:11 三次探测 404 属实 |
| `GET /api/parent/pairing/status` → 401 | 正确 | 家长 JWT 门，`session_id` 轮询专用；Launcher 不该也不能调 |
| 已绑定设备 announce 仍 `pending` | 正确但不够 | v3 代确认只认**后台预授权**（`tryAutoConfirm` → `activePreauth` 为空即 `no_preauth`），没有「已绑定即可恢复」分支 |

时间线（CST）：10:10:55 最后一次凭据有效签房 → 10:22:28 起 announce（`auto=no_preauth state=pending`，之后按 10 min nonce 轮换持续到现在，34 次；claim 404 ≥2127 次，5 s 一轮）→ 11:46:19 某家长账号 confirm（非绑定家长）→ 11:46:23 claim **409 sn_bound_by_other** → 会话未认领到期 → 家长 H5 轮询 29 次到 `expired`。库侧：台账 active、已绑家长、brain 已开、09-16 07:03 有删除作废水位（新签 iat 晚于水位，不受影响）、昨日预授权已消费。

机队画像（`本轮观察`）：台账 10 台，8 台已绑家长，其中 6 台走过 v2 claim；**当前只有 …00200003 在 announce**，即「历史上凭据被清掉」的设备目前就它一台（测试机）。

## 2. 为什么不能自动（安全论证）

- 设备凭据 = `kind=p003-device, sub=SN` 的 365 天 JWT，八个设备通道（session/telemetry/config/ota/pck/local-audio）共用 `verifyDeviceCredential`。拿到它 = 以孩子身份对话、读走档案与情景记忆、污染遥测。
- 恢复请求里能用的输入只有 SN、nonce、ephemeral pk。**SN 可枚举**（BJP003+批次+顺号，机身标签可见）；**nonce 谁都能生成**；**pk 谁都能生成**。三者对「是不是原设备」的证明力为零。
- 端侧已无任何秘密：本机凭据被清即什么都不剩（app 级恢复出厂 v286 起已保留凭据；OS 级恢复出厂 Keystore 必清，任何「设备身份密钥」同样活不过它）。
- 因此**唯一可用的锚**：① 原家长（登录态 = 短信认证账号；扫码 = 账号 + 人在设备旁）② 后台（预授权 / 一键确认）。没有第三种。
- 结论：`bound_recoverable` 可以由服务端**告知**，但**凭据只能在原家长或后台按下确认之后**经现有 `confirmSessionByHash` → `claim` 交付。这正是 v3 合同「只换谁按确认键」的原则。

顺带：配网 v4 是 SoftAP 两阶段，家长手机本来就要连设备热点送 Wi-Fi，**人已经在设备旁**，多扫一次码的成本≈3 秒。

## 3. 今天就有的恢复路径（服务端零改动）

| 路径 | 谁按键 | 现状 | 验证等级 |
|---|---|---|---|
| A 原家长扫码 | 原家长 | `confirm` 同家长 → `claim` 200 `claimed idempotent=true`，凭据重签、绑定不变 | 代码级已验证（`pairing.ts` L269–291 + `profile.ts performSnBinding`），**真机未验**；v1 有 `idem-4` 同家长重绑用例，v2 没有 → S1 补 |
| B 后台预授权 | 后台 | `PUT /api/admin/devices/:sn/preauth {phone}` → 命中现役 announce 即 `late_preauth` 代确认 → 设备 claim | 09-16 真机已验（…00200003 就是这样回来的）|
| C 后台一键确认 | 后台 | `POST /api/admin/devices/:sn/pairing/confirm`（不传手机号即用台账已绑家长）| 代码级已验证 |
| 他人扫码 | — | `claim` 409 `sn_bound_by_other`，会话不落 claimed | 今天真机已验 |

## 4. S1 服务端合同（建议本周做）

### 4.1 announce：告知绑定态（按请求版本门控）

请求：`{ "v": 2 | 3, sn, nonce, pk }`。**`v:3` 才返回新状态；`v:2` 老端维持今天的 `pending` 映射**（否则老 Launcher 把非 pending 当「不出码」，永远等不到家长扫码 = 死锁）。服务端先上，端侧再改 `v:3`。

| 判定顺序（服务端） | `v:3` 返回 | `v:2` 返回 | 端侧动作（v287） |
|---|---|---|---|
| 本 nonce 已有未认领有效会话（含预授权代确认） | `confirmed` | `confirmed` | 无码，继续 claim（不变） |
| SN 不在台账 | `pending` | `pending` | 出新绑定码（**不泄露存在性**，与 v3 合同 M 表一致） |
| 台账 `disabled` | `denied` `{reason:"sn_not_available"}` | `pending` | 无码，「设备未激活，请联系客服」 |
| 已绑家长、无有效会话 | **`bound_recoverable`** | `pending` | 出**恢复码**（同一份 sn+nonce+pk 二维码，文案「此设备已绑定家庭，请原家长扫码恢复；其他账号扫码无效」），继续 claim |
| 未绑家长 | `pending` | `pending` | 出新绑定码（不变） |

- 响应不带家长任何信息（无手机号、无脱敏号、无绑定时间）。
- 预授权代确认优先级不变：有预授权 → 直接 `confirmed`，不经过 `bound_recoverable`。
- 泄露评估：匿名调用者可探知「某 SN 已绑定」。信息价值低（拿不到凭据），现役限流 SN 6/min、IP 20/min 兜底；可选加 `PAIRING_ANNOUNCE_RPD_IP`（日/IP）——**建议先不加**，看真实滥用再说。
- 未知未来状态：端侧按 fail-closed 处理（无码、继续 claim、显示「正在恢复设备绑定」）——与 v286 现行原则一致。

### 4.2 claim：明确标出「恢复」（只加字段，不改枚举）

`200 claimed` / `200 idempotent_recovery` 响应新增：

`binding_outcome: "new" | "existing_binding_recovery"`

- 定义按**凭据历史**而非家长关系：`existing_binding_recovery` = 同家长重绑 **且** 该 SN 此前签过凭据（`lastClaimedSessionBySn` 有行 或 台账 `credential_issued_at` 非空）。后台「添加设备 + 手机号」预绑家长后的**首次** claim 仍是 `new`（设备从未持有过凭据）。
- 落库：`pairing_session` 增列 `binding_outcome`，幂等恢复原样回显。
- 不改 `code` 枚举的原因：v286 对未知 `code` 的处理未知，加字段零风险；codex 合同第 3 条「claimed 或 existing_binding_recovery」由 `binding_outcome` 满足。

### 4.3 恢复即换钥（建议开，川哥定）

`binding_outcome=existing_binding_recovery` 的**首次**真实 claim 成功后，`revokeCredentials(sn, 'pairing_recovery', notBeforeSec = 新凭据 iat − 1)`：此前所有凭据立即失效（含万一泄露的旧 JWT），新凭据 `iat > 水位` 照常通过。幂等恢复（15 min 窗内重试）**不再推水位**，防止把设备已存下的第一份新凭据误杀。签发改为显式 `setIssuedAt(iatSec)`，水位与 iat 取同一变量（双载体同源，不各自派生）。

### 4.4 家长 confirm：前置绑定检查 + relation

今天：他人扫码 confirm 照常 200 建会话 → 设备 claim 409 → 家长 H5 轮询到 `expired` 才知道不行（今天 11:46 实证，29 次轮询）。改为在 confirm 时用同一套只读判定：

| 情况 | confirm 返回 | H5 文案 |
|---|---|---|
| SN 不在台账 / disabled | `404 {error:"sn_not_available"}` | 「设备不存在或未激活」 |
| 已绑其他家长 | `409 {error:"sn_bound_by_other"}`，**不建会话** | 「该设备已绑定其他家庭，请原家长扫码；换绑请联系客服」 |
| 绑的就是我 | `200 {ok, session_id, relation:"owner_recovery"}` | 标题「恢复绑定」，成功页「设备已恢复到你的账号」 |
| 未绑定 | `200 {ok, session_id, relation:"new"}` | 不变 |

claim 侧的同名判定保留（防 confirm→claim 之间后台改绑的竞态）。`GET /status` 在 `bound` 时附带 `binding_outcome`。

### 4.5 admin「待认领」列表

`state=pending` 且台账已绑家长的行，标签改「已绑定 · 等原家长扫码 / 一键恢复」（数据已有：`parent_phone`），一键确认按钮现有逻辑即恢复（不传手机号 = 台账家长）。只改标签文案，约 10 行。

### 4.6 开关与回滚

- `PAIRING_RECOVERY_CONTRACT_ENABLED`（默认 1）：置 0 → announce 一律老映射、confirm 不前置检查、claim 不加字段、不换钥。回滚 = env 0 + `pm2 restart p003-voice --update-env`，或回退 dist。
- 部署顺序：**服务端先上**（同时收 `v:2|3`），codex v287 再把 announce 改 `v:3`。反过来会 400（今天 schema 是 `z.literal(2)`）。

## 5. S2（可选）远程一键恢复：无二维码，数字比对

触发条件：出现「设备在线（Wi-Fi 在）、凭据丢、家长不在设备旁」的真实案例。设计：

- announce `v:3` 命中 `bound_recoverable` 时附 `pairing_code`（4 位，`sha256(nonce_hash|sn)` 派生，服务端算、设备只显示）。
- `GET /api/parent/pairing/recoverable`：我名下、有现役 announce、无未认领会话的设备列表（脱敏 SN + public_id + 剩余秒，**不含 code**）。
- `POST /api/parent/pairing/recover {sn, code}`：原家长 + code 匹配当前 announce → `confirmSessionByHash(owner, sn, hash, pk, 'parent_recovery')` → 设备 claim 照常。错码 403 `code_mismatch`，每账号+SN 5/min，连错 10 次锁定该 announce（设备重生成）。
- 安全性：攻击者伪造 announce 时，真设备屏幕上没有那个 code，家长无从确认；4 位 + 限流足够。
- 家长端：首页卡片「设备 …0003 正在等待恢复绑定，请输入设备屏幕上的 4 位数字」。

## 6. 端侧配套（codex，v287）与问题

1. announce 发 `v:3`；`bound_recoverable` → 恢复码界面 + 继续 claim；`denied` → 无码 + 客服文案；未知状态 fail-closed。
2. 读 `binding_outcome` 只改文案（「已恢复绑定」/「绑定成功」），不改状态机。
3. 收到 `sn_bound_by_other` 后，下一次 announce 若返回 `bound_recoverable` 应**重新出恢复码**（原家长仍可扫），不要永久停在等待态。
4. 今天观察到 announce 节奏 ≈10 min 一次新 nonce（与 v3 合同「nonce 到期轮换再发」一致）+ 若干手动重生成簇，属正常；claim 5 s 一轮也在合同内。
5. 问题：除 …00200003 外，codex 手上还有没有「凭据已被旧逻辑清掉」的机器？服务端视角目前只有这一台在 announce。
6. 问题：v286 对 announce 返回未知 `state` 的现行处理是什么（出码 / 不出码 / 继续 claim）？决定 `v:3` 门控是否还需要更保守。

## 7. 测试与验收门

服务端（`apps/server/scripts/pairing.test.ts` 新增 `rv-*` 段，含负向验证）：
- rv-1 同一已绑 SN：`v:3` announce → `bound_recoverable`；`v:2` → `pending`（通道独占锚；删掉 v:2 映射这条必须变红）。
- rv-2 `v:3`：未登记 → `pending`；disabled → `denied`；未绑 → `pending`；有预授权 → `confirmed`（优先级）。
- rv-3 原家长 confirm → `relation=owner_recovery`；claim → `claimed` + `binding_outcome=existing_binding_recovery`（先造一次历史 claim）；凭据 `verifyDeviceCredential` 通过；`parent_account_id`、brain 账号不变。
- rv-4 后台预绑家长的新机首次 claim → `binding_outcome=new`（钉住定义）。
- rv-5 他人 confirm → 409 且 `pairing_session` 无新行；未登记 → 404。
- rv-6 换钥：旧凭据 verify 失败、新凭据通过；15 min 内幂等重试不推水位（第一份新凭据仍通过）。
- rv-7 admin 待认领项带 `parent_phone`、标签数据齐。
- 全量：`npm run test:pairing` 现有 25 组 + 新增全绿；`npm run test:hosts-status` 等其它套件不动。

真机（用 …00200003，绑定家长为测试账号）：① 原家长扫码 → 日志 `[pairing] v2 claim ok … source=parent binding=existing_binding_recovery`，随后 `[device-session] ok` 恢复；② 他人扫码 → H5 当场 409 文案，设备继续出恢复码；③ 后台一键确认 → 同 ①；④ 断网/5xx → 端侧无码（codex 验收门已含）。

## 8. 待川哥拍板

1. 同意「不做自动恢复，锚只认原家长 / 后台」。
2. S1 本周做；S2 等真实工单。
3. 恢复即换钥（4.3）开不开——建议开。
4. announce 泄露「已绑定」接受否——建议接受，不加日限。
5. …00200003 现在还卡在 announce 循环，要不要立刻用后台预授权拉回（1 分钟，昨天同款）。
6. 本草案何时发 codex（发时同步镜像到 ~/Downloads）。

## 9. 工作量

S1 服务端约 150–250 行含测试（半天）+ H5 约 40 行 + admin 约 10 行；codex v287 端侧另计。S2 服务端约 200 行 + 家长端一张卡片。

署名：cc（Claude）| 2026-09-17 13:35 CST
