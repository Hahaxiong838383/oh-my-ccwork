# P003 APK + Godot PCK 双 OTA 服务端联调合同

> 状态：`CODEX_PROPOSED / WAITING_CC_ACK`
>
> 日期：2026-09-03
>
> 范围：在保留现有 Launcher APK OTA 的前提下，为 Godot 非执行内容 PCK 增加独立发布、灰度、下载、状态回传和回滚链。

## 1. 结论

**需要 CC/server 配合改造。** 当前生产服务器只会发布 APK；Android v212 虽已具备 PCK 下载、SHA256 校验、原子 stage、跨重启激活、Godot ready 确认和未确认自动回滚能力，但生产调度仍是本地 Global Settings 一次性 Canary，不会自动从正式 OTA 服务拉取 PCK。

推荐最小方案不是新造第二套 OTA 认证系统，而是扩展现有：

```http
POST /v1/device/ota/check
Authorization: Bearer <S2B1 device credential>
Content-Type: application/json
```

响应中保留现有 `update` 作为 APK OTA，新增可选 `content_update` 作为 PCK OTA。两个通道共享设备身份和检查调度，但**发布、执行、状态、成功判定和回滚完全分账**。

## 2. 已验证 Android 真值

| 项目 | 当前真值 |
|---|---|
| Launcher | exact v212 `1.2.2-canary.200 (212)` |
| APK bytes | `155760389` |
| APK SHA256 | `eaa9b92d5231d3bf05e06ef9aa8ca872fde1b4739496e2d28b4e953de2c5efab` |
| 已接受 PCK | `v213-art-downsample-1` |
| PCK bytes | `23421944` |
| PCK SHA256 | `efcce34489c245f19ec96d26286aa6caee5d34b3cb9d50e556e80b6736a55c9f` |
| 适配机型 | `rk3562_rc160` |
| PCK 硬上限 | `32MiB` |
| 人工画质 | 2026-09-03 19:42 CST，003 PASS |

003 已完成：gate-off、304、错误机型、截断、错误 SHA、同 boot 只 stage、整机重启激活、Godot ready、三次稳定重启、ready suppression、自动 rollback、恢复候选。当前 active=v213，更新门=`0/0`，APK fallback 保留。

### 2.1 当前仅用于 Canary 的接口

```http
GET /v1/device/resource-pack/manifest?content_id=g1-content&applied_content_version=...
```

当前实现的限制：

- 无 Bearer；
- 无 SN；
- 无 Launcher versionCode；
- 无设备状态回传；
- 依赖端侧显式写入 `enable=1 + sync_requested=1 + base_url`；
- 只执行一次，不是生产自动 OTA。

因此该 GET 接口可保留为本地/诊断 Canary，但**不作为正式生产控制面**。

## 3. 兼容原则

1. `update` 字段语义不变，旧 Android 客户端继续正常解析 APK OTA。
2. `content_update` 是可选字段；旧版本会忽略，不得因此报错。
3. APK `last_result` 语义不变；PCK 使用独立 `content_state` 和 `content_last_result`。
4. 服务端可同时计算 APK 与 PCK eligibility，但 Android 必须先满足 `min_launcher_version_code`。
5. APK 成功不代表 PCK 成功；PCK `staged/activated` 也不代表最终成功，只有 Godot `resource.pack.ready` 后的 `confirmed` 才是成功。
6. PCK revision 不可变：同 `content_id + content_version` 禁止出现不同 SHA256。
7. 首期保留完整 APK fallback；不得因 PCK OTA 上线删除 APK 内已验证资源。
8. 首期 PCK 只允许已审核的 Godot 非执行内容，不允许 DEX、SO、APK、GDScript、GDC、shader/native 扩展或其他代码热更新。

## 4. Check 请求增量

现有字段继续保留：

```json
{
  "sn": "BJP003...",
  "version_code": 212,
  "version_name": "1.2.2-canary.200",
  "channel": "stable",
  "last_result": null
}
```

新客户端增加：

```json
{
  "sn": "BJP003...",
  "version_code": 212,
  "version_name": "1.2.2-canary.200",
  "channel": "stable",
  "last_result": null,
  "content_state": {
    "schema_version": 1,
    "content_id": "g1-content",
    "product_model": "rk3562_rc160",
    "active_content_version": "v213-art-downsample-1",
    "pending_content_version": null,
    "activation_state": "confirmed",
    "active_sha256": "efcce34489c245f19ec96d26286aa6caee5d34b3cb9d50e556e80b6736a55c9f"
  },
  "content_last_result": {
    "from_content_version": "v211-art-dedup-1",
    "to_content_version": "v213-art-downsample-1",
    "stage": "confirmed",
    "status": "success",
    "error_code": "",
    "result_ts_ms": 1788435720000
  }
}
```

字段纪律：

- `content_state` 每次检查都发当前快照；没有 active PCK 时 `active_content_version/active_sha256=null`，APK fallback 仍可工作。
- `content_last_result` 可省略；端侧按 FIFO 持久化事件，每次只发送最旧一条，收到本次 check 的 2xx 后删除，再立即安排 report-only check 发送下一条，禁止新状态覆盖旧状态。
- `error_code` 只传归一化错误，不传文件路径、Token、堆栈、Wi-Fi、用户内容或转写正文。
- 设备端事件时间使用 `result_ts_ms`；服务端另记接收时间，禁止用单钟覆盖双钟证据。

### 4.1 PCK 状态枚举

建议服务端接受以下 `stage`：

```text
offered
downloading
downloaded
verified
staged
waiting_reboot
activated
confirmed
rolled_back
failed
```

终态规则：

- `confirmed + success`：唯一成功终态；
- `rolled_back + success`：回滚成功，不等于候选发布成功；
- `failed + failed`：失败终态；
- 其余均为中间态。

## 5. Check 响应增量

```json
{
  "ok": true,
  "status": "ok",
  "next_check_seconds": 14400,
  "update": null,
  "content_update": {
    "schema_version": 1,
    "content_id": "g1-content",
    "content_version": "v213-art-downsample-1",
    "product_models": ["rk3562_rc160"],
    "min_launcher_version_code": 212,
    "asset_name": "v1/device/ota/content/files/efcce34489c245f19ec96d26286aa6caee5d34b3cb9d50e556e80b6736a55c9f.pck",
    "length": 23421944,
    "sha256": "efcce34489c245f19ec96d26286aa6caee5d34b3cb9d50e556e80b6736a55c9f",
    "required_resources": [
      "res://pck/g1_content_manifest.json",
      "res://pck/g1_art_inventory.json"
    ],
    "activation_policy": "next_idle_reboot",
    "force": false,
    "release_notes": ["更新 G1 美术资源"]
  }
}
```

示例中的 `required_resources` 仅节选；生产响应必须返回该不可变 manifest 中的完整数组。`asset_name` 必须是同源相对路径且**不得带前导 `/`**，以兼容 Android 当前的安全正则和 URL 拼接逻辑。

### 5.1 必填字段

`content_update` 非空时，以下字段必须存在：

- `schema_version=1`
- `content_id=g1-content`
- `content_version`
- `product_models[]`
- `min_launcher_version_code`
- `asset_name`
- `length`
- `sha256`
- `required_resources[]`
- `activation_policy=next_idle_reboot`

### 5.2 Server eligibility

服务端只有同时满足以下条件才返回 `content_update`：

1. Bearer 绑定的设备身份与请求 `sn` 一致；
2. release 为已发布且未暂停；
3. SN 命中 rollout/allowlist；
4. `product_model` 命中 `product_models`；
5. `version_code >= min_launcher_version_code`；
6. 当前 active/pending 未等于目标版本；
7. 目标 PCK 文件、长度、SHA256 与发布记录一致；
8. 设备没有处于服务端明确冻结状态。

任一不满足时返回 `content_update:null`，在 server ledger 记录原因；不要向不兼容客户端下发一个注定失败的包。

### 5.3 APK 与 PCK 同时可用

- 服务端允许同时返回 `update` 和 `content_update`，但 Android 优先 APK。
- Android 在 APK 有更新时先处理 APK，PCK 只记录 `client_deferred_for_apk`，不并行下载或 stage。
- APK 安装、重启和健康窗成功后立即再 check；新 Launcher 再处理 PCK。
- `force=true` 也不得打断语音、设备命令、MCU OTA、本地播报或前台关键交互。

## 6. PCK 文件接口

```http
GET /v1/device/ota/content/files/<sha256>.pck
Authorization: Bearer <S2B1 device credential>
Range: bytes=<offset>-
```

服务端要求：

- 文件按 SHA256 不可变存储；
- 支持 `HEAD`、完整 `200` 和 Range `206`；
- `Content-Length`、`Content-Range`、`Accept-Ranges: bytes` 正确；
- 不允许路径穿越，不接受客户端任意文件名；
- Bearer 必须能访问其被授权的 release；
- 已暂停 release 可停止新的 manifest offer，但已开始下载的不可变文件是否继续可读，由 CC 固化口径；推荐继续可读以避免半包风暴，端侧在下次 check 接收暂停状态。

## 7. 服务端最小数据模型

不强制表名，但至少需要四类独立实体：

1. **PCK release**：`content_id/content_version/product_models/min_launcher_version_code/length/sha256/required_resources/status/created_at`；
2. **rollout policy**：`none/canary/all`、SN allowlist、发布时间、暂停/撤回状态；
3. **device content status**：每台设备当前 `offered/pending/active/stage/error/last_seen` 投影；
4. **append-only report log**：保留每次设备事件、设备时间、服务端时间，禁止 success 覆盖失败或 rollback 证据。

APK 继续使用现有 release/status；PCK 不得借用 APK `version_code`、`ota_device_status` 或安装成功字段伪装。

## 8. Admin 最小能力

首期只需要：

- 上传 PCK 并由服务器重新计算 `length + sha256`；
- 创建不可变 content revision；
- 配置产品型号和 `min_launcher_version_code`；
- 发布到单 SN、SN 列表或全量；
- 暂停新的 offer；
- 查看每台设备的 staged/activated/confirmed/rolled_back/failed；
- 选择历史稳定 PCK 创建新的 rollback revision；
- APK 与 PCK 发布卡片、状态和失败原因分开展示。

首期不做：差分 PCK、多 content_id、动态脚本、APK fallback 删除、复杂批次编排。

## 9. 回滚口径

1. 已发布 `content_version` 字节不可改写；修复必须新建更高/不同 revision。
2. 服务端暂停 release 只阻止新 offer，不等于已激活设备自动回滚。
3. 主动回滚时，用已验证旧 PCK 字节创建新的 rollback revision，例如 `v214-rollback-v211-1`，避免同 version 改 SHA。
4. 端侧仍走下载、SHA、stage、跨重启、ready；失败自动回到上一 active，最终还有 APK fallback。
5. 未 `confirmed` 的候选不得在后台标记成功或扩大灰度。

## 10. 联调顺序

### J0 · 合同确认

CC 回执以下四点：

1. 是否接受扩展 `/v1/device/ota/check`，而非新建第二套 manifest 鉴权；
2. 是否接受 `content_state + content_last_result + content_update` 字段名；
3. 文件接口是否按 Bearer + Range 实现；
4. pause 后已开始下载的不可变文件是否继续可读。

### J1 · Server 实现与离线向量

- 旧客户端请求：响应不带或带 `content_update` 均不得影响 APK 解析；
- no-update、wrong SN、wrong model、min Launcher、same version；
- 文件 200/206、截断、错误 SHA、未授权；
- 同 `content_version` 不同 SHA 发布必须被 server 拒绝；
- PCK 与 APK 状态表完全分账。

### J2 · Android 生产客户端

合同冻结后由 codex 实现：

- OTA check 解析 `content_update`；
- 复用 S2B1 Bearer；
- 传 SN/机型/Launcher/PCK state；
- Range 续传、SHA、32MiB 硬门；
- 独立展示 PCK 真实下载百分比；校验、等待重启、激活和 ready 只显示阶段，不伪造百分比；
- idle 安全门、一次执行、退避、无风暴；
- durable content result FIFO；
- stage 后受控重启、ready 后确认和立即回报；
- APK 优先、PCK 延后；
- 默认关闭并只开 003 Canary。

### J3 · 003 真机 Canary

1. gate-off / no-update；
2. 正向 offer → Range 下载 → SHA → stage；
3. 同 boot 不激活；
4. idle reboot → activated → Godot load → ready → confirmed；
5. server 四类账本对齐；
6. 三次稳定重启；
7. 截断/错误 SHA/错误机型/401/403/429/500；
8. ready suppression → 自动 rollback → server 见 rollback；
9. 恢复 v213，六服务、语音、人在、设置、触摸与 Formal G1 无回归。

### J4 · 扩面

- 003 PASS 后才开 0010；
- 双机 PASS 后再讨论 0002/全量；
- APK fallback 删除另开项目，不与双 OTA 首发合批。

## 11. 当前球权

- **CC/server**：回复 J0 四项并给出可联调的 server 分支/部署锚。
- **codex/Android**：等待字段冻结；不提前把本地 Canary 接口硬接成生产协议。
- **川哥**：无需立即操作设备；J3 真人视觉/语音验收时再配合。

署名：codex（OpenAI）| 2026-09-03
