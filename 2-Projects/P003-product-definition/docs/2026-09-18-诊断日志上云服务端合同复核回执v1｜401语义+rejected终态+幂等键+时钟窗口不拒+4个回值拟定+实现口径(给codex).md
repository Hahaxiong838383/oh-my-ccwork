# P003 诊断日志上云 · 服务端合同复核回执 v1（回 Godot/Launcher codex《DIAGNOSTIC_LOG_SERVER_HANDOFF》《DIAGNOSTIC_LOG_CLOUD》《BRIDGE_CONTRACT》+ `diagnostic-log-ingest.openapi.yaml`，2026-09-18）

> 状态：**服务端尚未开工。** 本回执 = 合同复核（§1 七条必须先改或先答）+ 对你们「4 个待回值」的拟定答复（§2）+ 服务端将采用的实现口径（§3）。§1 冻结后服务端一天内上线（含单测、注入开关、后台查询页），先灰度一台。
> 证据标签：`已验证` = 读生产代码 / 生产 nginx 与日志只读核对 / 本机实测；`推断` = 端侧细节文档未写，按常见实现推的；`未知` = 需要你们回答。SN 只写末 4 或末 8 位；本文不出现任何凭据、密钥、token。

## 0. 结论

1. 合同**可以落地**：请求形状、幂等、部分成功、429/503 退避与我们现役的 `POST /v1/device/telemetry` 摄入几乎同构，凭据门、限频、幂等写入、后台查询体系全部复用，不新造协议。
2. 但有 **4 处会静默丢日志、队列死锁或误伤机队**（§1.1–§1.4），**必须先改合同**；另 3 处小项（§1.5–§1.7）一并处理。
3. 你们要的 4 个值我们已拟定（§2），其中 base URL 与鉴权口径是确定的，保留天数 / 灰度首台 / 白名单策略是**拟定未冻结**（§6）。
4. 落盘方案我们**不照合同建议的 NDJSON 文件分桶做**，改走服务端现有 SQLite 模式（§3.6）；对你们零影响，只是查询入口不同。

## 1. 必须先改或先答的七条（按危害排序）

### 1.1 401 语义写错，且有机队级爆炸半径（最高优先）

- **合同原文**：openapi「Short-lived credential held and refreshed by Launcher only」；HANDOFF §6「令牌过期返回 401 时刷新设备会话后重试」。
- **事实（`已验证`）**：设备凭据是配网 `claim` 时签发的 **365 天** JWT（`kind=p003-device`，`sub=SN`），服务端**没有任何 refresh 端点**（全部路由 grep 零命中）。401 只有一种含义：凭据缺失、无效、或已被后台删除作废（作废水位机制，09-16 上线）。
- **风险**：09-16 我们向你们提过 R2「401 → 自清凭据 + 自动重新 announce」。若 Launcher 已按此实现，则**新端点任何一次误发 401 都会把一台正常设备踢出绑定**，且这是设备通道里第一个高频写接口。
- **服务端承诺**：本端点的 401 **只能**来自与其他七条设备通道共用的同一个凭据校验函数；disabled / 不在灰度名单 / 远程开关关闭一律用 403 或 503，**绝不复用 401**。
- **请你们回答（`未知`）**：Launcher 当前对设备通道 401 的策略是什么（是否自清凭据）？无论答案如何，本端点不做特例；§6 验收清单里「令牌过期刷新后重试」请改为「401 走既有策略」。

### 1.2 `rejected_event_ids` 没有定义终态，可能队头死锁

- **合同原文**：「没有确认的 ID 留在队列中」「无效事件放入 rejected_event_ids，不要让整批静默丢失」。两句合在一起，被拒 ID 到底是删还是重试没有写。
- **后果（`推断`，Launcher 队列细节文档未写）**：若 Launcher 队列先进先出取前 20 条且不淘汰被拒 ID，20 条永久非法事件堆在队头后，**后面所有日志永远传不上，而每次请求都是 HTTP 200**。
- **要求写进合同**：`rejected` 是**终态**，端侧收到即从上传队列删除（可另存本地错误记录），**不再重试**；服务端保证只在硬性违规时拒（见 §3.4 原因枚举），临时故障一律用 429/500/503 不 ack。

### 1.3 幂等键作用域 + `client_event_id` 的生成方式会静默丢事件

- **合同原文**：「以 client_event_id 建唯一索引，重复请求返回同一 accepted_event_ids，不重复落盘」；ID 形如 `g1-<毫秒墙钟>-<序号>`。
- **问题**：① 唯一索引若是**全局**的，跨设备撞 ID 时后来者会被当成「重复」而**成功 ack 后丢弃**；② 同一设备墙钟**不单调**（NTP 校时会回跳，见 §1.4 实测），回跳后序号重置也会撞；两种情况端侧都看到 accepted。
- **服务端做法**：主键 **(SN, client_event_id)**，SN 取凭据 `sub`；同 ID **同载荷** → 计入 `accepted_event_ids`（对端侧等价于已接受）；同 ID **异载荷** → `rejected`，reason=`event_id_payload_conflict`，让丢失**可见**而非静默（telemetry 现役同款逻辑）。
- **请你们改**：`client_event_id` 加**每次开机的随机 nonce**（如 `g1-<bootnonce8>-<seq>`），不要只靠墙钟；或说明现有生成方式的唯一性保证。

### 1.4 ±24 小时时钟窗口整批 409，会让时钟坏的设备恰好永远传不上日志

- **合同原文**：「校验请求时间窗口（建议服务器时间前后 24 小时）」，openapi 409「request clock outside the allowed window」。
- **真机实测（`已验证`，生产 telemetry 全量日志统计）**：

  | 统计项 | 值 |
  |---|---|
  | 遥测批次总数 | 80 708 |
  | 设备钟与服务器钟偏差 > 1 小时的批次 | 2 913 |
  | 偏差 > 24 小时 | 0 |
  | 当前最大偏差 | 设备 …0010，约 5.9 小时（此刻仍在） |

  今天还没撞到 24 小时，但 RTC 掉电开机停在 1970 年是常见形态，那种设备正是最需要日志的，整批 409 等于把它永久拒之门外。
- **服务端做法**：**不按时钟偏差拒收**。记录 `server_received_ms` 与 `clock_skew_ms = server_received_ms − sent_at_ms`，后台可见；`occurred_at_ms` 只要求正整数，不做窗口校验。**409 从合同里删除**；`schema_version ≠ 1` 归 400。

### 1.5 两份文档的 Bridge 回执字段名打架 + 响应缺拒绝原因

- CLOUD.md 的 Launcher 成功回执是 `next_retry_after_ms` 且**没有** `rejected_event_ids`；HANDOFF.md §3 是 `retry_after_ms` + `rejected_event_ids`。Godot 解析器到底认哪个，请统一（这是你们内部两层的事，服务端不参与，但回执里的这种漂移会直接变成「Godot 永不删队列」）。
- openapi `LogBatchResponse` 是 `additionalProperties: false`，却没有任何**拒绝原因**字段，端侧永远不知道为什么被拒。**请放宽响应 schema**，服务端将增加 `rejected: [{client_event_id, reason}]`（§3.3）；`rejected_event_ids` 保留不变。

### 1.6 限频没有算术

- 合同只写了失败退避（5 s 起、最长 15 min），**成功路径的节奏一个字没写**；「成功后继续发送剩余队列」意味着 200 条积压会 **10 批连发**。telemetry 上过一次当（限额按直觉定 60/h，真实节奏 120/h，恢复后半小时全 429）。
- **请你们给两个数**：稳态每分钟最多几批、积压清空时突发最多几批连发。服务端限额按 **2 倍余量**定终值并写成引用源常量的测试；在此之前拟定值见 §3.5。

### 1.7 小项三条（`已验证`）

- **路径冒号**：Hono 只匹配**字面** `logs:batch`，百分号编码 `logs%3Abatch` 直接 404（本机用项目内 hono 实测）。端侧发字面冒号；nginx 不会改写它。
- **413 有两层**：服务端对 > 64 KiB / > 20 条返回 JSON 413（§3.2）；外层 nginx 站级 2 MB 上限的 413 是 **HTML 不是 JSON**，端侧解析失败时按「不可重试的 4xx」处理即可（64 KiB 合同内不会撞到）。
- **「内部 installation/device hash」我们没有这个实体**：设备身份就是凭据 `sub` 里的 SN；存储按 SN，后台显示按铁律**掩码**（末 8 位）；对外零 SN 的 `public_id` 只用于家长侧，不进本合同。

## 2. 对「需要服务器负责人回复的 4 个值」的答复（拟定）

| # | 你们问的 | 答复 |
|---|---|---|
| 1 | ECS HTTPS base URL | **`https://kidshub-ai.hahaxiong.cc`**（`已验证`：线上 nginx 只有此站反代 `/v1/`，与你们现用的 telemetry / config / local-audio / OTA 同一入口；`p003.hahaxiong.cc` 等站没有 `/v1/`） |
| 2 | 鉴权方式与刷新错误码 | 与 `/v1/device/config`、`/v1/device/telemetry`、`/v1/device/local-audio/*`、`/v1/device/ota/*` **完全相同**的 `Authorization: Bearer <设备凭据>`。**没有刷新**。401 = 凭据无效或已作废，沿用端侧对其他通道的既有策略（§1.1）；403 = 设备 disabled 或不在灰度名单，端侧按 `disabled` + 退避 ≥ 15 min |
| 3 | 时间窗口 / 保留天数 / 内部查询入口 | **不按偏差拒收**，只记录（§1.4）。保留 **14 天**（拟定；error/fatal 是否延长到 30 天见 §6）。查询入口 = 现有管理后台新增 tab「诊断日志」（管理员登录，SN 掩码，按级别 / 事件名 / 时间过滤，各拒绝原因计数），不复用设备接口 |
| 4 | `upload_state_changed` 字段名 / disabled 开关来源 | 事件字段名归 Launcher 自定（服务端只定 HTTP）。**开关来源两层**：① 服务端 `runtime_flag`（后台一键可切，现役模式），关闭时本端点返回 **503 + `error_code=LOG_UPLOAD_DISABLED` + `Retry-After: 900`**；② 同一开关写进设备运行配置快照 `GET /v1/device/config` 的新键（键名待冻结，拟 `diagnostics.log_upload_enabled`，布尔），端侧 30 min 轮询后就不再发起请求。两层都关才算「关」，任一层看到关都不发请求 |

## 3. 服务端实现口径（冻结前预告，供你们对照）

### 3.1 端点与门序

`POST /v1/device/diagnostics/logs:batch`（与 openapi 一致）。门序与 telemetry 同：**验收注入开关 → 设备凭据（SN 取 sub）→ 设备状态 + 灰度名单 → 远程开关 → 限频 → 体积（Content-Length / 条数）→ JSON / schema → 逐条二次脱敏 + 事件白名单 → 幂等写入 → 200 部分成功**。请求体里任何 `sn / serial / installation_id` 字段一律忽略。

### 3.2 HTTP 状态映射（替代 openapi 里的 409）

| 情形 | HTTP | `error_code` | 端侧动作 |
|---|---|---|---|
| 凭据缺失 / 无效 / 已作废 | 401 | `unauthorized` | 与其他设备通道的 401 策略一致，不特例 |
| 设备 disabled / 不在灰度名单 | 403 | `device_not_allowed` | `disabled` + 退避 ≥ 15 min |
| 远程开关关闭 | 503 + `Retry-After: 900` | `LOG_UPLOAD_DISABLED` | `disabled`，到时再试 |
| 限频 | 429 + `Retry-After` | `rate_limited` | 整个队列退避，不是逐条 |
| 非 JSON / schema 不合 / `schema_version ≠ 1` | 400 | `bad_request`（body 带 `reason`） | 视为端侧 bug，该批 dead-letter 不重试 |
| > 20 条或 > 64 KiB | 413 | `batch_too_large` | 拆批 |
| 落库失败 | 500 | `internal` | **不确认任何 ID**，退避重试 |
| 批内部分事件非法 | 200 | — | `accepted` 删；`rejected` 为**终态**删（§1.2） |

### 3.3 响应形状（在 openapi 基础上增两个字段）

```json
{
  "ok": true,
  "accepted_event_ids": ["g1-…-1"],
  "rejected_event_ids": ["g1-…-2"],
  "rejected": [{ "client_event_id": "g1-…-2", "reason": "event_not_allowed" }],
  "retry_after_ms": 0,
  "server_time_ms": 1789700000123,
  "request_id": "…"
}
```

`request_id` 回显请求头 `X-Request-Id`（缺省时服务端生成）。同 ID 同载荷的重复事件**计入 `accepted_event_ids`**。响应正文不含日志正文、不含凭据。

### 3.4 逐条拒绝原因枚举（终态）

`event_not_allowed`（事件名不在白名单）/ `invalid_event`（字段缺失、类型或长度不合）/ `event_too_large`（单条序列化 > 8 KiB）/ `event_id_payload_conflict`（同 ID 异载荷）。**没有**「时钟超窗」这一项。

### 3.5 体积与限频（拟定值，§1.6 拿到你们的节奏后定终值）

| 项 | 值 |
|---|---|
| 单批 | ≤ 20 条，≤ 64 KiB（先看 Content-Length，无长度头则解析后量） |
| 单条 | 序列化 ≤ 8 KiB；`message` ≤ 512；`data` 深度 ≤ 4、字符串 ≤ 512、数组 ≤ 32、每层键 ≤ 32 |
| 未知顶层 / 事件级键 | 忽略不拒（向前兼容），`data` 只受上面的上限约束 |
| 限频（每 SN） | 拟 ≤ 30 批 / 分钟，10 批连发可过；429 带 `Retry-After: 60` |
| 外墙 | nginx 站级 2 MB、读超时 300 s（现役，不改） |

### 3.6 存储、保留与查询（与合同建议的差异声明）

- 落 SQLite `data/diagnostics.db`（与 telemetry 同模式），主键 (SN, client_event_id)，每条存：级别、component、event、message、trace_id、`data` JSON、载荷哈希、批级 `client` 上下文（product / component / protocol_version / content_version）、`sent_at_ms`、`server_received_ms`、`clock_skew_ms`、`request_id`、脱敏计数。
- 每日清理：保留 **14 天**（拟定）。**不做** `/var/lib/p003/diagnostics/…` NDJSON 分桶、64 MiB 滚动、gzip 那一套：我们的量级（内测机队，每批 ≤ 64 KiB）用 SQLite 更省事，也和现有后台一致；磁盘余量 19 GB（`已验证`）。
- 查询只走管理后台（管理员 token），不复用设备接口；响应永不回传给设备。

### 3.7 服务端二次脱敏 + 事件白名单

- **key 黑名单**与你们端侧同一份（`token / secret / password / credential / cookie / ssid / wifi / keystore / signing / private_key`，大小写不敏感、递归）：命中的值**替换为 `[redacted]`** 并计数，**不拒整条**（拒掉就丢了诊断价值）。
- **字符串值扫描**：SN 格式（`BJP003` + 14 位数字）→ 只留末 4 位；JWT 形态（`eyJ…` 三段）→ `[redacted-jwt]`；11 位手机号 → 中间打星。
- **事件白名单**：以 HANDOFF §5 列表为初版，写在服务端代码里；不在名单的事件名 → `rejected`，reason=`event_not_allowed`（拟定，§6 待冻结）。新增事件流程：先在 `BRIDGE_CONTRACT.md` 登记 → 服务端加名单发版（当天可完成）→ 端侧再上报。

### 3.8 灰度、注入、日志锚

- 灰度名单：环境变量白名单（同 telemetry 模式），空 = 全开；先 **1 台**（拟 …03800006，即你们那台开发机，§6 待冻结）→ 5 台内测机 → 全开。
- 验收注入：环境变量可强制本端点返回 401 / 403 / 429 / 500 / 503（429 / 503 带 `Retry-After` 头，与真实限流同形），供你们跑 §6 矩阵；测完即撤。
- 服务端日志锚：`[diaglog] batch sn=****<末4> acked=<n> dup=<n> rejected=<n> redacted=<n> skew=<ms>`，零 Bearer、零 SN 全文。

## 4. 请端侧确认或修改的清单

1. 回答 Launcher 对设备通道 401 的现行策略（§1.1）；§6 验收清单「令牌过期刷新」改为「401 走既有策略」。
2. 合同写明 `rejected` 为终态并实现队列淘汰（§1.2）。
3. `client_event_id` 加开机 nonce，或说明唯一性保证（§1.3）。
4. 删除 ±24 h 窗口与 409（§1.4），`schema_version` 错误归 400。
5. 统一 Bridge 回执字段名（`retry_after_ms` vs `next_retry_after_ms`，`rejected_event_ids` 有无），并放宽 HTTP 响应 schema 接受 `rejected[]`（§1.5）。
6. 给上传节奏两个数：稳态批/分钟、积压清空突发批数（§1.6）。
7. 发字面冒号 `logs:batch`；容忍非 JSON 的 nginx 413（§1.7）。
8. 补写 Launcher 本地队列上限与磁盘策略（服务端长期不可达时设备侧不能无限增长；文档未写）。
9. 确认端侧能消费 §3.2 的 503 `LOG_UPLOAD_DISABLED` 与设备配置快照新键两层开关（§2 第 4 条）。

## 5. 联调顺序（服务端侧）

1. §1 冻结 → 服务端实现 + 单测（含负向锚：注入一条 SN 全文与 token 形态的事件，断言脱敏真的变红）→ 上线，灰度名单只放 1 台。
2. 服务端用**合成探针 SN**（不占真机、不动真机任何记录）跑公网自检：200 / 401 / 403 / 413 / 429 / 503、幂等重放三次只落一条、异载荷冲突进 rejected、脱敏计数；结果与后台页截图进下一份回执。
3. 你们按 HANDOFF §6 跑 Launcher → ECS 矩阵（离线 25 条重启不丢、部分 ack、429/503 退避、重放三次）；服务端同步给出后台按 SN 掩码查到的事件清单对账。
4. PASS 后名单扩到 5 台，观察队列长度、成功率、429、脱敏计数一周，再全开。

## 6. 未冻结项（等川哥拍板，冻结后本回执升 v2）

| 项 | 拟定 | 备选 |
|---|---|---|
| 未登记事件名 | 拒收（`event_not_allowed`），让「先登记再上报」是真规则 | 收下打标 `unlisted=1` |
| 保留天数 | 全部 14 天 | error / fatal 延长到 30 天 |
| 灰度首台 | …03800006 | 其他内测机 |
| 限频终值 | 30 批 / 分钟 / SN | 按 §1.6 你们给的节奏 × 2 |
| 设备配置开关键名 | `diagnostics.log_upload_enabled` | — |

署名：cc（Claude）| 2026-09-18 19:56 CST
