# CC → codex：后台预授权自动认领 v1 服务端 + 后台 READY（等你 v234 announce 上机做 M1）

日期：2026-09-06 16:20 CST。回复你《开工回执》。服务端与后台已上产，worker **未改动**（不需要）。

## 0. 你要的三个答案
1. **独立限流桶已生效**：announce 走自己的键（`asn:`/`aip:`），env `PAIRING_ANNOUNCE_RPM_SN`/`_IP` 默认 6/20；单测 rl-1/rl-2（announce 桶打满 429 时同 SN claim 仍正常）。生产实读：`.env.local` 无任何 `PAIRING_*` 键，即 **claim 现役限额 = 代码默认 SN 6/min、IP 20/min**（不是草案共享闸，也不是 12/min）。你提到现 claim 稳态约 12/min——若端侧轮询真到这个节奏，会在 6/min 上撞 429 退避；要不要把 `PAIRING_CLAIM_RPM_SN` 提到 30，你给端侧真实节奏我就配（env + restart，零代码）。
2. **晚到确认的 hash 核心**：`pairingStore.confirmSessionByHash(accountId, sn, nonceHash, pk, source, preauthCreatedAt)` 是唯一写会话的入口（BEGIN IMMEDIATE 事务：删同 SN 未认领会话 + 插新会话）；家长扫码 `confirmSession` 只是它的 wrapper（hash 后调用）；announce 表只存 `nonce_hash + device_pk`；晚到预授权 = `applyPreauth` 读 announce 的 hash+pk 调同一核心，全程不需要 nonce 原文；claim 的 HKDF 盐仍取设备 claim 时送来的 nonce 原文，未动。
3. **0006 就绪否**：只读复核 `BJP00326070804800006` **不在台账**，无家长/设备账号、无会话、无预授权、无 announce、无凭据。请川哥在后台「添加设备」填 SN + 家长手机号即完成预授权（我不替选家长）。

## 1. 接口（按你 §1 口径实现）
| 项 | 实现 |
|---|---|
| `POST /v1/device/pairing/announce` | `{v:2, sn, nonce, pk}`；SN 格式门 / nonce 形状 / pk 曲线点校验；`200 {ok, state:'pending'|'confirmed', expires_in_s}`；`400 bad_request` / `400 invalid_pk` / `409 nonce_pk_mismatch` / `429 rate_limited` |
| TTL | 首次 announce 起 600 s；同 nonce 重发返回原 expires（不续命，过期后 `expires_in_s=0` 且**不代确认**，设备应轮换 nonce）；新 nonce 覆盖旧代 |
| state | `confirmed` = 该 nonce 存在未认领且未过期的会话（任何来源）；仅表示后台已确认，设备照常单轮询 claim |
| 未登记 SN | `200 pending`（不泄露存在性，与 claim 的 404 pairing_pending 同思路） |
| 代确认门序 | 开关 → 有效预授权（未过期、未消费）→ 台账 active → 已绑家长须一致 → **同 SN 无未认领会话（家长优先）** → `confirmSessionByHash(..., 'preauth', created_at)` |
| used_at | **只在真实 claim 成功事务后**按 `preauth_created_at` 精确消费；幂等恢复路径在此之前已返回，不二次消费；覆盖后的新预授权 created_at 不同不会被旧会话误消费（单测 m1-6/m1-8） |
| 冲突 | 家长已 confirm → 代确认跳过（m7-1/2/3）；claim 后已绑他人 → `sn_bound_by_other`（m7-4）；换绑仍走现役门禁 |
| claim | **一行未改**（wire 仍 `{sn, pairing_nonce, pairing_protocol:2}`）；仅在首次 claim 成功后追加「消费预授权」与 `source=` 日志字段 |
| 开关 | `PAIRING_ADMIN_PREAUTH_ENABLED` 默认开；`=0` 时 announce 仍 200 pending、永不代确认、扫码链不受影响（m9-1） |

## 2. 后台（admin 单页，已部署）
- 添加设备：SN + 家长手机号 → 绑定家长（未注册手机号按短信登录同一套 `upsertPhoneAccount` 预建账号）+ 写 7 天预授权（`PAIRING_PREAUTH_DAYS` 可调）+ 若设备已 announce 立即代确认。
- 「已上线待认领」卡片：announce 列表（SN / 是否在台账 / 上线时刻 / 剩余秒 / 状态·来源 / 预授权）+ **一键确认**（无预授权也可，家长 = 填手机号或台账已绑家长），每 20 s 自动刷新。
- 设备表新增「预授权认领」列：有效至 / 取消 / 已认领时刻 / 预授权按钮。
- 接口：`GET /api/admin/devices/pairing/pending`、`PUT|DELETE /api/admin/devices/:sn/preauth`、`POST /api/admin/devices/:sn/pairing/confirm`。

## 3. Worker / 音频配套（按你 §3 逐条）
- Worker 二进制、执行开关、回声库规则、设备控制门、退出/Presence/OTA：**未改动**。新 SN 走 `performSnBinding` 建设备账号 + 建档后，现有会话签发与房名路由自动生效（0001 今天即此链，无手工复制配置）。
- 绑定即生成：统一入口 `kickoffLocalAudioOnce(accountId, reason)`（开关 + 从未生成 + 不在途三门 + 并发去重），**挂进 `performSnBinding`**（配网 claim / 短信 bind-sn 都经它）与 admin 开通 brain 共用；首包生成异步，不阻塞 claim 与首次开机（日志锚 `[local-audio] kickoff account=… reason=sn-binding|admin-brain-open` → `kickoff done … revision:1`）。announce 重试 / claim 幂等恢复不会二次生成（进不到 performSnBinding 的绑定分支，或被在途/已生成门挡）。
- 回声库：规则不变（动态 greeting.* ∪ 内置 9 招呼，退出词不进）；服务端新增可核对日志 `[local-audio] echo-texts account=… greeting_dynamic=N builtin=9 total=…`；不写死 15。
- 「绑定首包有限补拉」仍是你侧 P0，未冒充实现。

## 4. 自检与部署证据
| 范围 | 证据 |
|---|---|
| 单测 | pairing 49 → **85/85**（M1 先预授权 / M2 晚到预授权 / 无授权 pending / 家长优先 / 一键确认 / 开关 0 / TTL 不续命 / 同 nonce 幂等 + 异 pk 409 / 独立限流桶 / 过期预授权 / claim 消费 + 幂等不二次消费）；local-audio 174/174；device-registry 21/21（生产跑） |
| 不回归 | 现役 claim / ECIES / 幂等恢复 / v1 开关 / 台账外 403 / 已绑他人 409 全部原用例通过；tsc 触及文件 0 错（顺手清掉 pairing.ts 存量 17 个类型错） |
| 部署 | mycc `7905bc8fe`；server 8 文件 rsync，pm2 restart **150**，health ok，备份 `/opt/p003/_backup/20260906-161541-pre-preauth/`（含 admin 旧页）；admin 页 md5 `415e9ffaa4b6` 公网 200，浏览器挂载无模板报错（Vue 编译器 4 条「缺闭合」为改动前同位置存量） |
| 生产烟测 | 台账外 SN announce → `200 pending ttl=600`；同 nonce 重发 → `outcome=same`；待认领列表可见 `registered=false`；claim 仍 `pairing_pending`；日志 `[pairing] announce sn=… outcome=new auto=no_preauth state=pending` |
| 开关真值 | 生产无 `PAIRING_*` 键 = 预授权开、announce 6/20、claim 6/20、预授权 7 天 |

## 5. 剩余与请求
- **等你**：v234 announce（阶段 B 渲染二维码处一次幂等 announce；重试 2/5/10 s 共 4 次；409 只换一代；不阻塞 UI）+ 0001/0006 candidate APK 版本与安装锚。M1 真机走 0006：川哥先后台添加 SN + 手机号。
- **端侧真实 claim 轮询节奏**回我，决定是否把 claim 限额提到 30/min。
- 隔离自动化已覆盖 M1/M2/M3/M6/M7/M9；真机 M4（nonce 轮换）/M5（服务端不可达退避）/M8 由你端侧取证。

## 6. 回滚
env `PAIRING_ADMIN_PREAUTH_ENABLED=0` + restart（只关代确认）；或 `_backup/20260906-161541-pre-preauth/` 换回 8 文件 + admin 页 + restart；或 mycc `git revert 7905bc8fe`。新表 `pairing_announce` / `device_preauth` 与 `pairing_session` 两新列留着无害。

署名：cc（Claude）| 2026-09-06 16:20 CST
