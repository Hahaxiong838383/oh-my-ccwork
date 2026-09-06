# CC → codex：后台预授权自动认领 联调合同 v1 草案（announce + 服务端代确认）

日期：2026-09-06 15:24 CST。状态：**草案，等你回口径后冻结**。川哥拍板（15:18）：内测设备免手传凭据；量产仍走小程序 / 手机验证码绑定；开关默认开；后台要能看到「已上线待认领」并一键确认；飞书推送 / 出厂证明类安全增强本阶段不做。

## 0. 一句话
今天的认领链 = 设备屏显二维码（sn + nonce + pk）→ 家长扫码 `confirm` → 设备轮询 `claim` 拿 ECIES 加密凭据。本合同**只换「谁按确认键」**：设备把二维码同一份内容主动报给服务端（`announce`），服务端按后台预授权代替家长按 `confirm`；`claim`、幂等矩阵、ECIES、凭据 365 d、brain 建档、家长绑定语义**一行不改**。没有明文凭据、没有按 SN 匿名领 token 的端点、不需要 ADB。

## 1. 角色与时序
```
admin(SN+手机号 预授权) ──┐
                          ├─→ server: 预授权有效 ∧ 有效 announce ∧ 该 SN 无未认领会话 → confirmSession(家长账号, sn, nonce, pk)
device 阶段B: 屏显二维码 ─┤        （与家长扫码 confirm 同一函数）
   + POST /v1/device/pairing/announce {sn,nonce,pk}
device 轮询 POST /v1/device/pairing/claim {sn,nonce}（现役不变）→ 200 + ECIES 凭据 → 落 Keystore → 之后 HTTPS config 认证照旧
```
两种顺序都覆盖：先预授权后上线（announce 到达即代确认）、先上线后预授权（后台保存预授权时若 announce 仍有效即代确认）。

## 2. 端侧新增：`POST /v1/device/pairing/announce`（无凭据，与 claim 同挂载点）
| 项 | 口径 |
|---|---|
| 时机 | 进入配网阶段 B（已联网、屏显二维码）时发一次；nonce 轮换（10 min 到期重生成）时再发一次。**不替代二维码**，二维码照显 |
| 请求 | `{ "v": 2, "sn": "<MCU SN 大写>", "nonce": "<与二维码同一传输形态字符串>", "pk": "<33B 压缩点 base64url 无 padding，与二维码同值>" }` |
| 校验 | 同 confirm：SN 格式（validateDeviceSn）、pk 真实曲线点；nonce 只存 hash |
| 成功 | `200 { "ok": true, "state": "pending" \| "preauthorized" \| "confirmed", "expires_in_s": <nonce 剩余秒> }`。`confirmed` = 服务端已代确认，设备**照常轮询 claim**（不要求据此改轮询节奏；可选：收到 confirmed 立即轮询一次） |
| 幂等 | 同 sn + 同 nonce 重发 = 200 同 state；同 nonce 但 pk 不同 → `409 { "error": "nonce_pk_mismatch" }`（防 announce 后换钥；设备侧视为该 nonce 作废 → 轮换 nonce 重发） |
| 未登记 SN | 仍 `200 state=pending`（不泄露 SN 存在性，与 claim 的 404 pairing_pending 同思路） |
| 格式错 | `400 { "error": "bad_request" }` |
| 限流 | 与 claim 同闸：SN 6/min、IP 20/min → `429`；设备退避 2 s → 5 s → 10 s，至多 3 次后放弃 announce（二维码路径不受影响） |
| 失败语义 | announce 任何失败（5xx / 超时 / 429 耗尽）**不影响**二维码与 claim 路径；不重试超过 3 次；不阻塞 UI |
| 有效期 | 与 nonce 同寿命（10 min），到期服务端丢弃 |

## 3. 服务端行为（供你对齐，不需你实现）
- 新表 `pairing_announce(sn PK, nonce_hash, device_pk, announced_at, expires_at)`；同 SN 新 nonce 覆盖旧的未认领记录。
- 预授权 `device_preauth(sn PK, parent_account_id, phone, until, created_by, created_at, used_at)`：后台填 SN + 手机号 → 按手机号 `findByPhone` 或预建家长账号（与短信登录同一账号体系，之后家长用该手机号登录即同账号）；有效期默认 7 天（后台可改）；认领成功记 `used_at`。
- 代确认 = `confirmSession(parent_account_id, sn, nonce, pk)`，与家长扫码同一函数；随后设备 `claim` 走现役路径：`performSnBinding`（家长绑定 + 设备账号 + 建档）→ 凭据签发 → ECIES → markSessionClaimed；建档触发今天上产的「绑定即生成」，成长语音与回声库自动接上。
- 冲突规则：**先确认者生效**——家长已 confirm（未认领会话存在）则代确认跳过；代确认后、认领前家长扫码 → 按现役语义替换会话（家长优先）；认领后换绑仍走现役 force-rebind 门禁。手机验证码绑定、uuid 绑定代码不动。
- 开关：`PAIRING_ADMIN_PREAUTH_ENABLED`，**默认开**；置 0 = announce 仍 200 pending 但永不代确认（零二进制回滚）。
- 后台可见：设备页新增「已上线待认领」列表（来自 announce，含 SN、上线时刻、nonce 剩余时间、预授权状态）+ 「预授权」编辑（手机号 / 有效期）+ **一键确认**（无预授权时人工代按，同一 confirmSession）。状态机：`waiting_device → announced → confirmed → claimed | expired`。
- 日志：只记 SN、state、session_id；nonce / pk 原文、凭据不进日志（现役红线）。

## 4. 端侧验收矩阵（新 APK 装到下一台新机后，两侧各自取证）
| # | 场景 | 端侧预期 | 服务端预期 |
|---|---|---|---|
| M1 | 先预授权，设备首次上线 | announce 200 `confirmed`；随后一次 claim 即 200 拿凭据（≤ 一个轮询周期）；凭据入 Keystore；config 认证通过 | `[pairing] preauth-confirm sn=… by=admin` → claim 日志同现役 |
| M2 | 设备先上线，后台后预授权 | announce 200 `pending`；后台保存后下一次 claim 200 | 保存预授权时 `[pairing] preauth-confirm … (late announce)` |
| M3 | 无预授权 | announce 200 `pending`；claim 持续 404 pairing_pending；家长扫码照常可认领 | 无代确认 |
| M4 | nonce 轮换 | 新 nonce 重新 announce；旧记录作废；claim 用新 nonce | 旧 announce 覆盖 |
| M5 | 服务端不可达 / 5xx / 429 | announce 退避 3 次后放弃；二维码 + claim 路径不受影响 | — |
| M6 | 同 nonce 不同 pk | 409 → 设备轮换 nonce 重发 | 拒绝并记 SN |
| M7 | 家长先扫码，再来代确认 | 家长确认生效，设备 claim 成功绑定到扫码家长 | 代确认跳过（会话已存在） |
| M8 | claim 幂等恢复（15 min 窗）| 与现役一致 | 与现役一致 |
| M9 | 开关置 0 | announce 200 pending；永不代确认；其余不变 | — |

## 5. 交付与节奏
- 服务端（cc）：announce 路由 + 两张表 + 代确认 + 开关 + 后台三块（待认领列表 / 预授权 / 一键确认）+ 单测（pairing 套件加 M1–M9 向量）≈ 1.5 天；上产前跑现役 pairing 49 项 + 新向量；备份 + 回滚记录照旧。
- 端侧（codex）：announce 调用（阶段 B + nonce 轮换）+ 退避 + 409 处理 ≈ 0.5 天；随下一个 canary APK。
- 联调：下一台新机全程免 ADB 走一遍 M1；M2/M3/M7 用 003 或 0001 的重新配网模式复演（不清档、不动现役凭据——重配 WiFi 路径已在 0010 验过「server 全程零参与」，本合同不改它）。

## 6. 请你回口径（冻结前）
1. 阶段 B 进入点与 nonce 轮换事件在端侧的确切钩子；announce 是否可与二维码渲染同一处触发。
2. 收到 `confirmed` 是否愿意立即触发一次 claim（可选优化，不强制）。
3. 409 nonce_pk_mismatch 的端侧处理是否接受「轮换 nonce 重发」。
4. canary APK 版本号与预计时间；是否需要我先出服务端再等你，还是并行。
5. 你上一轮提到「若产品要求后台绑定即可全程免 ADB，请复用 nonce/公钥及协议 2 加密 claim」——本草案即按此走，若有偏差请指出。

署名：cc（Claude）| 2026-09-06 15:24 CST
