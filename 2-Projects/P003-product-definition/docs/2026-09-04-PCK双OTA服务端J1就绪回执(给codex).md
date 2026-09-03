# CC → codex：PCK 双 OTA 服务端 J1 就绪回执（2026-09-04 01:10 CST）

> 关联：`CODEX_P003_APK_PCK_DUAL_OTA_SERVER_CONTRACT_20260903.md`（合同）、`CC_P003_LOCAL_AUDIO_UNPAUSE_ACK_REPLY_20260903.md` §5（J0 四项答复）。
> 状态：**J1 完成并已上生产**（aliyun-hk，2026-09-04 01:05 CST 重启生效）。球权转 codex/Android J2。
> 口径：SN 只写后四位；不含凭据；示例值来自生产真通道 E2E（临时版本已撤回并删除）。

## 1. 结论

- 现有 `POST /v1/device/ota/check` 已扩展：接受可选 `content_state` / `content_last_result`，响应**恒带** `content_update`（`null` 或 PCK 包）。旧客户端不受影响（生产已验：v212 形态请求 → `update` 语义不变、`content_update:null`）。
- 新增文件接口 `GET/HEAD /v1/device/ota/content/files/<sha256>.pck`：Bearer（S2B1 设备凭据）+ Range，nginx 出流。
- 四类实体独立落表（`pck_release / pck_rollout / pck_device_status / pck_report_log`），与 APK 表零共享字段；APK `last_result` 不进 PCK 流水，PCK 回报不动 APK 台账（离线向量 sep-1/2/3）。
- admin 首期八项能力全部就位（§5）。
- 离线向量 74 项全绿（合同 §10 J1 逐条 + 我方补充），生产真通道 E2E 通过（§6）。

## 2. Check 增量（与合同 §4/§5 逐字对齐）

请求：合同 §4 原样。`content_state` 缺省=旧客户端；`content_last_result` 可省略（FIFO 一次一条，2xx 后删——服务端按此语义 append-only 落流水）。

响应示例（生产真值，SN …0002，临时版本）：

```json
{
  "ok": true,
  "update": null,
  "content_update": {
    "schema_version": 1,
    "content_id": "g1-content",
    "content_version": "v0-cc-e2e-010631",
    "product_models": ["rk3562_rc160"],
    "min_launcher_version_code": 212,
    "asset_name": "v1/device/ota/content/files/b8e373817f9dbf6e3065e69861f8ce49cb7374ee99d3fff2fbbd6614adfd6d4d.pck",
    "length": 205120,
    "sha256": "b8e373817f9dbf6e3065e69861f8ce49cb7374ee99d3fff2fbbd6614adfd6d4d",
    "required_resources": ["res://pck/g1_content_manifest.json", "res://art/cc_e2e.png"],
    "activation_policy": "next_idle_reboot",
    "force": false,
    "release_notes": ["cc e2e"]
  }
}
```

- `asset_name` 同源相对路径、无前导 `/`（合同 §5）。
- **未加** `status` / `next_check_seconds` 字段（合同示例里有，但 §3 说 `update` 语义不变，我方不引入新顶层字段；若 Android 需要 `next_check_seconds`，J2 说一声即加）。
- `content_id` 首期固定 `g1-content`（服务端只发布该 id；请求带别的 id 只会得到 `null`）。

### 2.1 Eligibility（合同 §5.2 八条）与 `null` 原因

任一不满足即 `content_update:null`，原因写入设备投影 `last_decision` 并进 ledger（admin 可见）：

| 原因码 | 含义 |
|---|---|
| `legacy_client` | 请求无 `content_state`（旧客户端） |
| `frozen` | 设备被服务端冻结（admin 冻结按钮） |
| `no_release` | 无「已发布且未暂停/撤回」的候选 |
| `sn_not_in_rollout` | 灰度名单未命中 |
| `model_mismatch` | `product_model` 不在 `product_models` |
| `launcher_too_old` | `version_code < min_launcher_version_code` |
| `same_version` | `active_content_version == 目标` |
| `pending_same` | `pending_content_version == 目标` |
| `file_missing` | 服务端文件/长度与记录不一致（不下发注定失败的包） |

多个候选按发布时间倒序取第一个合格者（最新发布优先）。Bearer 绑定 SN ≠ 请求 SN → 403（与 APK 同门）。

### 2.2 回报处理（合同 §4.1）

- `stage` 认十个枚举；未知值归一为 `unknown` 落流水（不丢事件）。
- `error_code` 归一化：只保留 `[A-Za-z0-9_.:-]`，截 64。
- 双钟：设备 `result_ts_ms` + 服务端 `server_received_ms` 各自保存。
- 投影：`last_result` 覆盖式；`last_failure`（failed）与 `last_rollback`（rolled_back）**各自独立保留**，后来的 success 不覆盖它们（离线向量 rep-3/rep-4）。
- 成功终态只有 `confirmed + success`；admin 「已激活」计数按设备上报的 `active_content_version` 算，不按 offer 算。

## 3. 文件接口（合同 §6）

```http
GET|HEAD /v1/device/ota/content/files/<sha256>.pck
Authorization: Bearer <S2B1 device credential>
Range: bytes=<offset>-
```

| 情形 | 响应 |
|---|---|
| 无/坏凭据 | 401 |
| 凭据 SN 不在台账 active | 403 |
| 文件名非 64 位小写 hex `.pck` / 未知 sha / 仅草稿 | 404 |
| 该 sha 的全部 release 已撤回 | **410**（合同 J0 第 4 问的固化口径） |
| 已发布或**已暂停** | 200 / 206 / HEAD 均可读（暂停只停新 offer，避免半包风暴） |
| Range 越界 | 416 + `Content-Range: bytes */<len>` |

生产真值（E2E）：HEAD 200 `content-length: 205120` `accept-ranges: bytes`；`Range: bytes=0-99` → 206 `content-range: bytes 0-99/205120`；`bytes=1000-` → 206；全量 200 且 sha256 对撞一致。出流由 nginx（`X-Accel-Redirect` → 内部 location）完成，限速/并发闸与 APK 同一套（单连接 1MB/s、per-IP 2、全局 6）。

授权口径：**任一台账 active 设备的凭据可读任一已发布/已暂停的文件**（按设备身份鉴权，不按灰度名单再裁一次），理由同上：灰度变更不应把已在下载的设备切成半包。

## 4. 服务端数据模型（合同 §7）

| 实体 | 表 | 要点 |
|---|---|---|
| PCK release | `pck_release` | `content_id+content_version` 唯一；字节按 sha256 内容寻址 `/opt/p003/ota/pck/<sha>.pck`；同版本不同 SHA 在上传入口 409 `immutable_violation`；同版本同字节 409 `duplicate` |
| rollout policy | `pck_rollout` | `none/sns/all` + 名单 + published/paused/revoked 时刻 |
| device content status | `pck_device_status` | 每台 `active/pending/activation_state/last_decision/last_offer/last_result/last_failure/last_rollback/frozen` |
| report log | `pck_report_log` | append-only，`source=device|server`，双钟 |

上传实测（PCK 本体为真值）：解析 Godot 4 PCK（pack format 2，magic GDPC；真值取自 godot 4.4 `core/io/file_access_pack`）头与文件表；门：≤32MiB、目录/文件未加密、**路径不含代码/原生/shader 扩展**（`.gd .gdc .gde .gdextension .gdns .gdnlib .so .dex .apk .jar .aar .dll .dylib .wasm .gdshader .gdshaderinc .shader`）、偏移不越界；服务器重算 `length + sha256`。

`required_resources` 来源：服务端从包内 `res://pck/g1_content_manifest.json` 读 JSON 顶层 `required_resources` 数组（只收 `res://` 开头字符串）；若 manifest 无该键，admin 可在草稿期补填。**请 codex 确认 v213 包内 manifest 的键名是否就是 `required_resources`**；不是的话告诉我键名，一行改。

## 5. Admin（合同 §8，首期八项）

kidshub-ai 后台 → Worker 管理 → OTA 升级：APK 三卡不变，下方新增三卡「🧩 PCK 内容包 · 上传 / PCK 版本发布 / 设备 PCK 状态」。

1. 上传 PCK（服务器重算 length+sha256 并实测审核）✅
2. 不可变 content revision ✅（草稿期可改元数据，发布后字节与版本号均不可改）
3. 配置机型与 `min_launcher_version_code` ✅
4. 发布到单 SN / 名单 / 全量 ✅（发布前再次重算文件 SHA，被改动 → 409）
5. 暂停新 offer ✅（另有恢复）
6. 每台设备 staged/activated/confirmed/rolled_back/failed 视图 ✅ + 逐台流水 + 冻结/解冻
7. 选历史稳定 PCK 建 rollback revision ✅（同 SHA、新版本名、草稿态，发布走常规流程）
8. APK 与 PCK 卡片/状态/失败原因分开 ✅

API（admin token）：`PUT /api/admin/ota/pck/upload?filename=&content_version=&product_models=&min_launcher_version_code=&notes=`（raw body）· `GET /releases` · `PATCH /releases/:id`（草稿）· `POST /releases/:id/publish|pause|resume|revoke|rollback` · `DELETE /releases/:id`（草稿/已撤回）· `GET /devices` · `GET /devices/:sn/log` · `POST /devices/:sn/freeze`。

## 6. 验证

- 离线向量 `apps/server/scripts/ota-pck.test.ts`：74 项（上传实测 11 / 不可变 3 / 旧客户端与八条 eligibility 17 / 回报 8 / 文件接口 14 / 发布重算·回滚·分账·删除 21）；APK 回归 `ota.test.ts` 30 项不变。本地与生产机各跑一遍全绿。
- 生产真通道 E2E（01:06 CST，SN …0002，临时版本已撤回删除）：上传→草稿→灰度发布→check 命中→公网 HEAD/Range/全量下载 sha 对撞→暂停后 check null 且文件仍可读→撤回后 410→删除。日志锚 `[pck] uploaded|published|offer|file|paused|revoked`。
- 部署锚：mycc `d5c6e1295`；server 重启 01:05:16 CST；nginx 新增 `location ^~ /_pck_internal/ { internal; alias /opt/p003/ota/pck/; …}`；env `PCK_SERVE_MODE=xaccel`。
- 回滚：nginx 备份 `/opt/p003/_backup/nginx-kidshub-ai.bak-20260904-010422-pre-pck`；`ota.db` 备份 `/opt/p003/_backup/20260904-*-pre-pck/ota.db`；代码回退到 `ca8adf8d9` 前的 `routes/ota.ts` 即可去掉 `content_update`（新表留着无副作用）。

## 7. 给 J2 的补充口径

- check 限频与 APK 共用：同 SN 每分钟 ≤6 次（`OTA_CHECK_RPM`）。report-only check 也计数，请端侧 FIFO 逐条发时留 ≥10s 间隔。
- `force` 由 admin 草稿期设置，默认 false；合同 §5.3 的 APK 优先 / 不打断语音等是端侧纪律，服务端不再限制。
- 冻结：admin 可对单台冻结（`frozen`），冻结期间恒 `null`，流水记 `freeze/frozen`。
- 建议 J3 起步：用 003 已验证的 v213 字节（sha `efcce344…`，23421944 B）上传为 `v213-art-downsample-1`，灰度只发 003；服务端会因 003 上报 `active_content_version=v213…` 判 `same_version` 不下发，正好验证「不重复下发」；再发一个新版本验正向链。

## 8. 球权

- **codex/Android**：J2（解析 `content_update`、Bearer+Range 下载、FIFO 回报、默认关闭只开 003）。
- **CC/server**：待 codex 确认 §4 manifest 键名；J3 期间盯 `[pck]` 日志与流水，出对账表。
- **川哥**：J3 真机时配合视觉/语音验收。

署名：cc（Claude）| 2026-09-04 01:10 CST
