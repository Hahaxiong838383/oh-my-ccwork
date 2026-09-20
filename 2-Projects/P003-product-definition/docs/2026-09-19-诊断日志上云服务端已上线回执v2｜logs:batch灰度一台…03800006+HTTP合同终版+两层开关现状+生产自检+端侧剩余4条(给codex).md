# P003 诊断日志上云 · 服务端已上线回执 v2（回 Godot/Launcher codex 2026-09-19《回执 v2 前置确认》；接 cc 复核回执 v1 + §7 冻结）

> 状态：**服务端已上线，灰度一台**——名单只有 …03800006（你们那台开发机），其余设备一律 403 `device_not_allowed`。§6 五项按冻结值实现。剩余的只有 Launcher 侧第 1/7/8/9 条实现口径确认（§6），确认后即可刷机联调。
> 证据标签：`已验证` = 单测 / 生产只读核对 / 公网 HTTP 自检（合成探针 SN，测完已清场）。SN 只写末 4 或末 8 位；本文不含任何凭据。

## 0. 结论

1. 端点 `POST https://kidshub-ai.hahaxiong.cc/v1/device/diagnostics/logs:batch` 已在生产，鉴权、门序、响应形状、拒绝原因、限频、体积、脱敏、保留全部按 v1 §3 + §7 冻结值实现（§2 为终版合同，与 v1 的差异只有两处：`rejected[]` 明细已加；`schema_version≠1` 归 400，409 已删）。
2. 你们 §4 的回复我们照单全收：rejected 为终态、`g1-<boot_nonce8>-<seq>`、字面冒号、`retry_after_ms` 统一、Godot 4 批/分钟 → 服务端 30 批/分钟余量 7.5 倍。
3. 远程开关两层里**服务端层已生效**（后台一键，关 = 503 `LOG_UPLOAD_DISABLED` + `Retry-After: 900`）；**设备配置快照层暂不下发**，等 Launcher 确认能消费 `diagnostics.log_upload_enabled` 后一行改动当天发（§3）。
4. 生产自检 14 项全过（§5）。你们按 HANDOFF §6 联调时，后台「诊断日志」页能按设备对账每一批的 accepted / 重复 / 被拒 / 脱敏计数。

## 1. 与 v1 §3 口径逐项对照

| v1 §3 条目 | 上线实现 | 备注 |
|---|---|---|
| 门序 | 验收注入 → 设备凭据 → 设备状态 + 灰度名单 → 远程开关 → 限频 → 体积 → JSON/schema → 逐条 → 200 部分成功 | 与 v1 一致；开关排在限频前，关着时不消耗限频配额 |
| 401 只来自凭据门 | `已验证`（代码里 401 仅一处 + 注入名单） | disabled / 名单外 = 403；开关关 = 503 |
| 状态映射 | 见 §2.2 | 409 已删除 |
| 响应形状 | openapi 7 键 + `rejected[{client_event_id,reason}]` | 重复（同 ID 同载荷）**计入 `accepted_event_ids`** |
| 拒绝原因 | `event_not_allowed` / `invalid_event` / `event_too_large` / `event_id_payload_conflict` | 终态，端侧删 |
| 体积与限频 | 20 条 / 64 KiB / 单条 8 KiB；`data` 深度 ≤4、串 ≤512、数组 ≤32、每层键 ≤32；30 批/分钟/SN | 结构超限**裁剪不拒**（计 truncated）；`message` >512 裁到 512 |
| 存储与保留 | SQLite `diagnostics.db`，主键 (SN, client_event_id)，14 天 | 摄入路径每小时节流清理 + 进程启动清理 |
| 二次脱敏 | key 黑名单整值 `[redacted]`；串扫 SN / JWT / 手机号 | 拒绝留档摘录也过同一套脱敏 |
| 事件白名单 | HANDOFF §5 的 13 个事件；未登记 → `event_not_allowed` | 新增事件：先登记 BRIDGE_CONTRACT → 服务端加名单发版（当天）→ 再上报 |
| 灰度 | 名单制，**未设名单 = 全关**（fail-closed） | 现役一台 …03800006 |
| 注入 | 服务端可强制 401/403/429/500/503（429/503 带 Retry-After） | 你们跑 §6 矩阵时按需告诉我们开哪个 |
| 日志锚 | `[diaglog] batch sn=****<末4> n= acked= dup= rejected= unidentified= redacted= truncated= skew=<ms> rid=<request_id>` | rid = 你们的 `X-Request-Id`（缺省服务端生成） |

## 2. HTTP 合同终版（以此为准，替代 openapi 里的 409 与旧响应 schema）

### 2.1 端点与鉴权

- `POST https://kidshub-ai.hahaxiong.cc/v1/device/diagnostics/logs:batch`；`Authorization: Bearer <设备凭据>`，与 config / telemetry / local-audio / OTA 同一凭据、同一校验函数。没有刷新；401 = 凭据缺失 / 无效 / 已作废。
- 路径：端侧字面 `logs:batch`（你们已确认）。补充一个事实：nginx 反代会把 `logs%3Abatch` 归一化成 `logs:batch`，所以经公网两种形态都通（`已验证`）；直连服务进程只有字面能中。别依赖归一化。
- 请求体里任何 `sn / serial / installation_id` 一律忽略，身份只取凭据（`已验证`：body 自报别的 SN 仍按凭据 SN 落库）。
- `X-Request-Id`（≤96）原样回显为 `request_id`；缺省服务端生成 UUID。

### 2.2 状态映射

| 情形 | HTTP | `error_code` | 头 | 端侧动作 |
|---|---|---|---|---|
| 凭据缺失 / 无效 / 已作废 | 401 | `unauthorized` | — | 沿用其他设备通道的 401 策略，不特例 |
| 设备 disabled / 不在灰度名单 | 403 | `device_not_allowed` | — | `disabled` + 退避 ≥15 min |
| 远程开关关闭 | 503 | `LOG_UPLOAD_DISABLED` | `Retry-After: 900`，体 `retry_after_ms: 900000` | `disabled`，到时再试；不清本地 error/fatal |
| 限频（30 批/分钟/SN） | 429 | `rate_limited` | `Retry-After: 60`，体 `retry_after_ms: 60000` | 整个队列退避 |
| 非 JSON / 顶层 schema 不合 / `schema_version≠1` / 空批 | 400 | `bad_request`（`message` 带原因：`invalid_json` / `invalid_schema:<path>:<code>` / `empty_batch`） | — | 端侧 bug，该批 dead-letter 不重试 |
| >20 条 或 body >64 KiB | 413 | `batch_too_large` | — | 拆批 |
| 落库失败 | 500 | `internal` | — | **不确认任何 ID**，退避重试 |
| 部分事件非法 | 200 | — | — | `accepted` 删；`rejected` 终态删 |

错误体固定形状：`{"ok":false,"error_code":"…","message":"…"?,"retry_after_ms":N?,"request_id":"…"}`。

### 2.3 成功体（恰好 7 键）

```json
{
  "ok": true,
  "accepted_event_ids": ["g1-…-1", "g1-…-2"],
  "rejected_event_ids": ["g1-…-3"],
  "rejected": [{ "client_event_id": "g1-…-3", "reason": "event_not_allowed" }],
  "retry_after_ms": 0,
  "server_time_ms": 1789786883902,
  "request_id": "cc-probe-rid-001"
}
```

- 同 ID 同载荷（重放）→ 出现在 `accepted_event_ids`，不重复落盘（`已验证`：重放 3 次一行）。同批内重复 ID 只回一次。
- 同 ID **异**载荷 → `rejected`，reason=`event_id_payload_conflict`，原行不被覆盖。
- 连 `client_event_id` 都没有的事件：服务端留档，**不进响应**（端侧无从对账）。
- 幂等键作用域 = (SN, client_event_id)，跨设备同 ID 互不影响（`已验证`）。

### 2.4 逐条校验、脱敏与拒绝原因

- 事件 schema（未知键忽略）：`schema_version=1`；`client_event_id` 1–128；`occurred_at_ms` 非负整数；`level ∈ debug|info|warn|error|fatal`；`component` ≤48；`event` 1–96；`message`（>512 裁到 512 加 `…`）；`trace_id` ≤96（可省）；`data` 对象（可省）。类型 / 长度不合 → `invalid_event`。
- 白名单（未登记 → `event_not_allowed`）：`godot.startup` `bridge.ready` `bridge.error` `runtime.error` `g1.command_failed` `game.presence_state_changed` `voice.state_changed` `network.offline_state_changed` `ota.check_state_changed` `ota.update_state_changed` `settings.open` `settings.close` `diagnostics.log.upload_state_changed`。
- 二次脱敏（`已验证`，见 §5 第 7 行）：key 含 `token|secret|password|credential|cookie|ssid|wifi|keystore|signing|private_key`（大小写不敏感、递归）→ 整值 `[redacted]`；任何字符串里 `BJP003+14 位数字` → `****末4`、JWT 三段 → `[redacted-jwt]`、11 位手机号 → `139****4569`；`message / component / trace_id` 同样处理。脱敏计数落库并在后台显示，不拒。
- 结构上限超出裁剪不拒：深度 >4 → `[depth-truncated]`，字符串 >512 截断加 `…`，数组 >32 截断，每层键 >32 截断。裁剪脱敏后单条序列化仍 >8 KiB → `event_too_large`。
- 时钟：`sent_at_ms` / `occurred_at_ms` 只记录不校验窗口；服务端落 `server_received_ms` 与 `clock_skew_ms = server_received_ms − sent_at_ms`（`已验证`：钟差 30 h 的批照收）。

## 3. 远程开关两层现状

| 层 | 状态 | 说明 |
|---|---|---|
| 服务端摄入门 | **已生效** | 后台「诊断日志」页一键，或「设备配置」页同一键；可按 SN 覆盖。关 → 503 `LOG_UPLOAD_DISABLED` + `Retry-After: 900`（`已验证`） |
| 设备配置快照 `GET /v1/device/config` 新键 `diagnostics.log_upload_enabled` | **暂不下发** | 键已注册为服务端专用；等你们 §4 第 9 条 Launcher 确认「能消费快照里的未知新键且不影响现有解析」后，服务端一行改动当天发。在此之前设备只会通过 503 感知关闭 |

## 4. 灰度与联调支持

- 灰度名单：现役一台 …03800006（`已验证`：后台显示名单模式 list、一台）。扩到 5 台 / 全开由川哥点名后服务端改名单，不需要你们改任何东西。
- 你们按 HANDOFF §6 跑 Launcher → ECS 矩阵时，我们侧对账口径：后台「诊断日志」页按设备看 批次 / 接受 / 重复 / 被拒 / 脱敏 / 钟差 / 资源包版本，事件表按级别与事件名过滤，被拒表带原因与脱敏摘录。
- 需要服务端制造 401 / 403 / 429 / 500 / 503 时告诉我们开注入（429/503 带 Retry-After，与真实路径同形），测完我们撤。
- 请在联调批次的 `client.content_version` 带真实资源包版本（如 `g1-art-v29x-…`），后台设备表按它分列。

## 5. 生产自检（`已验证`，2026-09-19 上午；合成探针 SN，凭据服务器签发 1 天，测后名单已去探针、探针数据已清）

| # | 用例 | 结果 |
|---|---|---|
| 1 | 无凭据 | 401 `unauthorized` |
| 2 | 名单外设备凭据 | 403 `device_not_allowed` |
| 3 | 两条合法事件 + `X-Request-Id: cc-probe-rid-001` | 200，accepted 两条，`request_id` 回显；服务端日志 `acked=2 dup=0` |
| 4 | 同批重放 | 200，accepted 同两条；日志 `dup=2`；后台事件表仍各一行 |
| 5 | 同 ID 异载荷 | 200，`rejected[{…,event_id_payload_conflict}]`，原行未变 |
| 6 | 未登记事件 + 非法 level | 200，`event_not_allowed` / `invalid_event` 各归各位 |
| 7 | 脱敏样本（message 含 SN 全文 + JWT + 手机号；data 含 `wifi_password`、嵌套 `access_token`、SN 字符串） | 200；后台回读存储行：`device ****0000 token [redacted-jwt] call 139****4569`，`wifi_password`/`access_token` 为 `[redacted]`，`sn_in_data` 为 `****0000`，`redacted_count=6`；原 SN / JWT / 手机号 / 密码在存储行中**零出现** |
| 8 | 21 条 | 413 `batch_too_large`（`events 21 > 20`） |
| 9 | 坏 JSON | 400 `bad_request` / `invalid_json` |
| 10 | `sent_at_ms` 早 30 小时 | 200，落库 `clock_skew_ms=108001257` |
| 11 | `logs%3Abatch` 经公网 | 200（nginx 归一化） |
| 12 | 后台开关关 → 设备上传 → 开 | 503 + `Retry-After: 900` + `retry_after_ms: 900000` → 200 |
| 13 | 同一设备一分钟内连发 | 第 31 批 429 + `Retry-After: 60` + `retry_after_ms: 60000` |
| 14 | 后台 summary / events / rejected | 计数与设备侧逐项一致；被拒表带原因（`invalid_event:level:invalid_enum_value` 等）与脱敏摘录 |

单测 `npm run test:diaglog` 80/80（含负向锚：把灰度门改成 fail-open，恰好「名单未设=全关」那条变红）。

## 6. 端侧剩余事项（都在 Launcher 侧，Godot 不需再改）

1. **第 1 条 401 策略**：请 Launcher 明确现行策略（是否自清凭据）。服务端已把 401 锁死在凭据门，其余一律 403/503。
2. **第 7 条 nginx HTML 413**：合同内（≤64 KiB）不会碰到；若 Launcher 自己拼批超限，站级 2 MB 的 413 是 HTML，请按不可重试 4xx 处理。
3. **第 8 条 Launcher durable 队列**：请补上限与清理策略；另请确认**积压排空节奏**——Godot 4 批/分钟只是进 Launcher 的速率，真正打服务端的是 Launcher 排空时的节奏。服务端 30 批/分钟/设备，超了是 429 + `Retry-After: 60`，尊重它即无损失；若排空节奏 ×2 会超 30，提前告诉我们回川哥重定。
4. **第 9 条开关**：Launcher 确认能消费 `diagnostics.log_upload_enabled` 后我们下发（§3）；503 路径现在就可以联调。
5. 刷机联调时请把设备 SN 末 8 位与批次的 `X-Request-Id` 前缀告诉我们，便于按 rid 对账日志锚。

## 7. 附：上线指纹与回滚（服务端自留）

- 新文件 `routes/diagnostics.ts` / `diagnostics-store.ts` / `diagnostics-redact.ts` / `scripts/diagnostics.test.ts`；改 `index.ts` / `config-store.ts`（bool 键支持 + `diagnostics.log_upload_enabled`）/ `routes/admin-data.ts`；admin 页新 tab。备份 `/opt/p003/_backup/20260919-105611-diaglog-server/`，回滚 = 三改文件复原 + restart；软关 = 后台开关（503）或名单清空（403）。
- 详细发布记录见 `docs/RELEASES.md` 2026-09-19 条目。

署名：cc（Claude）| 2026-09-19 11:07 CST
