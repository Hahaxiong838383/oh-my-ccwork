# 0003 凭据丢失 · 联调修复交接（给 codex）

**结论：服务端这半边已经就位——后台删除设备现在会作废旧凭据（10:50 上线），…00200003 的预授权和家长绑定已挂好（11:01，有效到 09-23 11:01）。剩下的全在端侧：设备要发一次 announce 就能自动拿到新凭据；更重要的是查清 09-15 01:24:30 CST 是什么把本地凭据清掉的，以及让「未绑定 + 在线」的设备自己去 announce，而不是靠恢复出厂。**

署名：cc（Claude）| 2026-09-16 11:17 CST。证据标签：`已验证` = 服务端库/日志/nginx 亲读；`转述` = codex 端侧回执；`推断` 单独标。SN 只写末 8 位；手机号、token 不出现。

---

## 1. 现象与时间线

| 时间（CST） | 事件 | 来源 | 标签 |
|---|---|---|---|
| 09-11 16:01 | …00200003 v259→v263 OTA 装成功，自报 `success` | ota.db last_result | 已验证 |
| 09-13 22:01 | 最后一次语音会话签发 ok | device_session_log | 已验证 |
| 09-15 00:43:24 | 最后一次 OTA check（200，无更新） | nginx + ota_device_status | 已验证 |
| 09-15 01:24:30 | 最后一条遥测；此前每 30 s 一条（120/h）、盖子关、无人、WiFi 信号 3 格、钟差 300 ms，**无任何劣化前兆，戛然而止** | telemetry.db | 已验证 |
| 09-15 01:25 → 09-16 11:14 | 服务端零遥测、零 check、零会话，**nginx 上也没有这台的 401**——不是被拒，是根本没再调 | nginx 4 天全量 | 已验证 |
| 09-16 10:14 | 川哥后台删除→重加→开通 brain（改动前，旧机制：只删台账行，旧凭据仍有效） | nginx + registry | 已验证 |
| 09-16 10:50 | 服务端上线「删除 = 作废旧凭据」（见 §2.1） | RELEASES.md | 已验证 |
| 09-16 10:58:16 | 川哥再删：**作废水位写入**（`credentials revoked before=10:58:17`），08-17 签的旧凭据从此 401 | device_credential_revocation | 已验证 |
| 09-16 10:58:48 | 重加台账（无家长手机号 → 无预授权、无绑定、无凭据） | registry | 已验证 |
| 09-16 11:01:12 | 川哥点「预授权」填家长手机号：预授权 7 天（到 09-23 11:01）+ 家长绑定 acct-16；`late_announce=no` | pairing.db + 日志 | 已验证 |
| 09-16 11:14 | 端侧状态：v263；`p003_mini_program_binding_status=0`；凭据导入开关 0；OTA `check_failed`；无新 ANR；仍保有 v259→v263 升级记录 | codex 回执 | 转述 |

**对得上的解释（推断）**：09-15 01:24:30 本地凭据被清掉后，launcher 所有鉴权请求都不再发出（遥测、check、会话一起停），所以服务端只看到「消失」而不是 401。应用数据没丢（升级记录还在），只有凭据没了——这是端侧要查的根因。

⚠️ 一处口径纠正：端侧回执说「后台重新生成了凭据」——**没有**。后台这两轮做的是台账重建 + 预授权 + 家长绑定，凭据列至今为空（`credential_issued_at=null`，pairing 库无 claim 会话）。所以设备端没有可「导入」的东西；拿凭据只有两条路：设备 announce 走自动认领，或后台点「签发凭据」出 token 再手工导入。

---

## 2. 服务端机制真值（今天起生效）

### 2.1 后台删除 = 作废旧凭据（2026-09-16 10:50 上线，commit fac8ff7e0）
- devices.db 新表 `device_credential_revocation(sn PRIMARY KEY, not_before_sec, revoked_by, reason, …)`。`DELETE /api/admin/devices/:sn` 删台账行后写水位 = 删除那一秒（单调不回退，**重加台账不清**）。
- `verifyDeviceCredential`（session / session/prefetch / ota check / pck / telemetry / config / local-audio 七处共用入口）：该 SN 有水位时，要求 JWT `iat` **严格晚于**水位秒；无 `iat` 的老 token 视为 0，一并作废。没有水位的 SN 行为与以前完全一致。
- 端侧含义：**被删过的设备，回网后所有鉴权接口 401**，直到拿到新签的凭据。这是设计意图（川哥拍板「删了就是新设备」），不是故障，端侧不要用「重试旧 token」去绕。

### 2.2 预授权自动认领链（v3，2026-09-06 上产，0006 真机已验）
1. 后台预授权：`PUT /api/admin/devices/:sn/preauth {phone}` → pairing.db `device_preauth`（默认 7 天）+ 台账 `parent_account_id`。…00200003 已完成这步。
2. 设备 announce：`POST /v1/device/pairing/announce`（SN + 设备 pk + nonce）。服务端存 announce，命中有效预授权即 `tryAutoConfirm(trigger='announce')` 代确认。
3. 设备 claim：`POST /v1/device/pairing/claim` → 签发凭据（`SignJWT kind=p003-device, sub=SN, setIssuedAt`），`iat` 自然晚于水位，通过 §2.1 校验。
4. ~~状态查询：`GET /v1/device/pairing/status`~~ —— **勘误（cc 2026-09-17）：此接口从未存在**，设备侧只有 `announce` / `claim`（`routes/pairing.ts` 全文核对）；codex 09-17 探测 404 属实，是本行笔误。
- 限频（代码真值）：announce 每 SN 6/min、每 IP 20/min；claim 每 SN 6/min、每 IP 20/min。退避别低于 10 s。
- 服务端日志（cc 用来对账的三行）：`[pairing] announce sn=… outcome=… auto=… state=…` → `[pairing] preauth-confirm sn=… trigger=announce` → `[pairing] v2 claim ok sn=… source=…`。claim 成功后后台设备行凭据列由 claim 会话回填（`credential_source=pairing_claim`），「待认领」列表同步变化。

### 2.3 当前这台的服务端状态（11:01:55 读库）
- registry：active，家长 acct-16，凭据列空，brain 未开通（这次重加没点开通；账号 device-…00200003 仍在，记忆保留）。
- pairing.db：预授权 1 行（until 09-23 11:01，used_at null）；announce 0 行；claim 会话 0 行。
- 作废水位：10:58:16。
- OTA：不在 275/277 灰度名单，恢复后只会拿到「无更新」；`check_failed` 是没凭据的自然结果，凭据回来即消失。

---

## 3. 请 codex 做的（按优先级）

**R1 根因（最重要，决定机队风险）**：09-15 01:24:30 CST 是什么清掉了本地凭据？设备当时空闲、盖子关、无人、40 分钟前刚正常 check 过。请查该时刻附近的 logcat / 持久化写入 / v263 启动迁移逻辑 / 凭据存储位置是否随某个清理动作被清。要回答：是否可复现；已升到 263 及以上的其他设备是否同样可能掉；v275/277/280 是否带同样代码。

**R2 端侧自愈（产品行为，替代「恢复出厂」）**
- 未绑定（`binding_status=0`）且在线 → 自动进入 announce 循环（带退避，遵守 §2.2 限频）。现在这台正处于这个状态却不 announce，说明当前只在首次开机/出厂后才 announce（请确认）。
- 任一鉴权接口收到 **401** → 清本地凭据 → 进入 announce 循环。这条同时覆盖 §2.1：运营在后台删了设备，设备回网自己重新认领，不用碰设备。
- 「重新认领」窄动作：只清凭据与绑定状态并重新 announce，**保留 WiFi、本地音频、内容包**。恢复出厂（清 WiFi、要重新 SoftAP 配网）只留作兜底，不做主路径。

**R3 今天就能验的联调**：任何调试入口（adb 广播 / 隐藏菜单）让 …00200003 发一次 announce。预授权 7 天内有效，服务端会自动代确认；cc 盯 §2.2 三行日志和后台凭据列即可闭环。请给出触发方式与时间，cc 现场查。

**R4 确认 v263 现有行为**：拿到 401 现在会怎样（重试？静默？）；announce 在什么状态下发；凭据存哪里、谁有权清。这三个答案决定 R2 怎么改。

**R5 OTA**：R3 通过后 check 应回到 200；如需把这台升到 27x/280，告诉川哥加进灰度名单。

---

## 4. 联调步骤与判据（R3）

| 步骤 | 动作方 | 服务端可观测判据（cc 查） |
|---|---|---|
| 1 | 设备上线，发 announce | nginx `POST /v1/device/pairing/announce 200`；日志 `[pairing] announce sn=…00200003 outcome=… auto=confirmed…` |
| 2 | 服务端代确认 | 日志 `[pairing] preauth-confirm sn=…00200003 trigger=announce`；pairing.db `device_preauth.used_at` 非空 |
| 3 | 设备 claim | 日志 `[pairing] v2 claim ok sn=…00200003`；后台设备行凭据列出现（source=pairing_claim）；「待认领」列表消失 |
| 4 | 设备用新凭据 | 遥测恢复每 30 s 一条；`/v1/device/ota/check 200`（无更新）；语音会话 `[device-session] ok` |
| 失败分支 | announce 429 | 退避过密，看 §2.2 限频 |
| 失败分支 | announce `pk_mismatch` | 设备 pk 与之前 announce 存的不一致（本次是零行，不会命中；若命中说明设备端 pk 轮换） |
| 失败分支 | claim 后仍 401 | 把 claim 时间和 401 时间给 cc，对水位 10:58:16 核 `iat` |

---

## 5. 纪律与边界
- 不得把其他设备的 token / Keystore / SN 拷进这台（B29 §2 红线）；不得用「导入旧 token」绕过作废。
- 预授权只对这台 SN 有效；不扩其他设备、不改服务端策略。
- 回执里 SN 只写末 8 位、不贴 token、不贴家长手机号。
- 服务端本轮**不再改代码**；若 R4 的答案表明必须改服务端合同（例如 401 响应要带「请重新认领」提示码），先提案再改。

## 6. 回执格式（最少）
1. R1：清凭据的时刻与调用栈/日志锚；是否版本回归；影响版本范围。
2. R4：401 现行为、announce 触发条件、凭据存储位置。
3. R3：触发 announce 的方式与时间戳（设备钟 + 你看到的服务端响应码）。
4. R2：改法与落到哪个版本；是否保留恢复出厂兜底。

## 7. 附：服务端文件与备份（只读参考）
- 作废机制：`apps/server/src/device-registry-store.ts`（表 + `revokeCredentials/credentialNotBeforeSec`）、`routes/device-session.ts`（`verifyDeviceCredential`）、`routes/admin-data.ts`（DELETE 路由）；测试 `scripts/device-registry.test.ts` G1–G5。
- 预授权/announce/claim：`routes/pairing.ts`、`routes/admin-data.ts`（`applyPreauth`、`PUT /devices/:sn/preauth`）、`pairing-store.ts`。
- 备份：`/opt/p003/_backup/20260916-105036-delete-revokes-credentials/`；回滚命令在 `docs/RELEASES.md` 2026-09-16 节。

---

## 8. 收口（2026-09-16 17:09 CST 服务端复核）

**结论：R3 已达成——设备恢复出厂 + v281 后，16:44:48 自主发出 announce，服务端代确认、claim 签发、鉴权全部恢复；服务端这半边闭环。R1 / R2 / R4 仍等端侧回执。** 下表全部 `已验证`（nginx + pm2 日志 + 四个库 + 后台接口亲读）。

| 时间（CST） | 服务端可观测事实 |
|---|---|
| 15:03:36 → 15:04:01 | 后台删除（作废水位 15:03:36）→ 重加（家长手机号 → 预授权到 09-23 15:03:51 + 家长 acct-16）→ 开通 brain |
| 16:44:48 | `POST /v1/device/pairing/announce 200`（UA okhttp/4.12.0）→ `[pairing] announce … outcome=new auto=confirmed state=confirmed ttl=600` + `[pairing] preauth-confirm … trigger=announce` |
| 16:44:48 | `POST /v1/device/pairing/claim 404`（UA Dalvik/2.1.0）——与 announce 同一秒到达，会话尚未建立，按合同返回 `pairing_pending`（pairing.ts 判定序：无行 = 404） |
| 16:44:50 | `POST /v1/device/pairing/claim 200` → `[pairing] v2 claim ok … source=preauth brain=ready alg=ECIES-P256-HKDF-SHA256-A256GCM`，`preauth consumed ok=true`；`device_preauth.used_at` 与 `pairing_session.claimed_at` 均为 16:44:50 |
| 16:44:51 起 | 语音会话签发 ok ×4（至 16:56:56）+ prefetch ×4；新凭据 `iat` 晚于作废水位，验签通过；`/v1/device/*` 自 15:00 起 401 = 0（设备没带旧 token 回来） |
| 16:45:20 起 | 遥测恢复 30 s 一条（至 16:58:52 共 26 条） |
| 16:49:58 | OTA check 200，上报 vc=281（1.2.2-canary.269）；无 offer（281 高于全量 280），端侧 `check_failed` 应已消失 |
| 16:51 | 该 SN 的 LLM 调用 4×200 + 1×499（客户端提前关闭，打断类），真实对话已发生 |
| 后台 | 设备行凭据列：签发 16:44:50 / 到期 2027-09-16 16:44:50 / `credential_source=pairing_claim`；「待认领」列表为空 |

pm2 error log 16:44 起 0 行；`/health` 200。

### 8.1 遗留（不影响本次闭环）
- **claim 抢跑**：首个 claim 与 announce 同秒到达拿到 404 `pairing_pending`，2 s 后重试成功。无害；建议端侧在 announce 响应 `state=confirmed` 之后再发 claim（或明确把 404 当轮询信号，现状看已是如此）。另外 announce 与 claim 的 UA 不同（okhttp vs Dalvik），请确认是同一进程的两个 HTTP 客户端还是两个组件。
- **OTA 页「最近升级结果」仍显示 09-11 的 259→263 success**：`ota_device_status` 行不随后台删除清除，且 `last_result_json` 只在设备捎带新 `last_result` 时才覆盖（ota-store 用 COALESCE）。纯展示层遗留；若要「删除即新设备」在 OTA 页也成立，需在 DELETE 时顺带清该 SN 的 ota/pck 状态行——待川哥点头再改，服务端本轮不动。
- **本次 announce 的触发源请在回执里写明**（自动循环 / 调试入口 / 用户操作）：这决定 R2 是否已经落在 v281。R1（09-15 01:24:30 清凭据根因与影响版本范围）、R4（v263 现行为）仍开放。
- **One-shot 顺带观测**：4 次签发里 1 次声明 `supports=oneshot_first_turn_v1|local_receipt_v1` 拿到 `contract=first_turn_v1`，3 次未声明，与 D-day 首批观测同型；按川哥决定，等 OTA 设备多了再看。
