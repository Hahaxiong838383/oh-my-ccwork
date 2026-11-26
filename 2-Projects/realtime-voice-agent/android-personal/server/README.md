# 小可夜航 (night) OTA + 设备诊断后端

飞牛2 上的独立 sidecar 服务，给「小可」独立 Android 客户端（night 通道）提供两件事：

1. **真实 OTA**：`latest.json` 与 APK 静态 artifact；
2. **技术事件上报**：13 类白名单事件，只记技术事实，不存密钥、不存原话。

对外固定入口（Lucky 8666/TLS，`pa.hahaxiong.cc` 的 `/mobile/night` 子路径）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/mobile/night/latest.json` | 由磁盘上真实 APK 现算的清单；**没有 APK 就是 404** |
| GET | `/mobile/night/xiaoke-night-<versionCode>.apk` | 静态 APK，支持 `Range` 续传、`ETag`、`HEAD` |
| POST | `/mobile/night/diagnostics` | `Bearer <设备凭据>`，body `{schema:1,events:[{id,kind,ts,versionCode}]}` → `{acked:[...]}` |
| GET | `/mobile/night/healthz` | 容器健康检查（不对外宣传） |

范围声明：只服务用户本人飞牛上的这一个私有后端。不改 P003、不改 MyJavis、不改线上 provider、
不动私有 admin（`personal-voice-admin`）容器，也不动 8666 规则里其他任何域名。

---

## 1. 飞牛2 实机目录（部署后真实存在）

| 用途 | 实机路径 | 权限 / 说明 |
| --- | --- | --- |
| 服务代码 | `/vol1/1000/docker/personal-night-ota/app/` | `0755`，容器只读挂载 |
| 诊断库 | `/vol1/1000/docker/personal-night-ota/data/diagnostics.sqlite3` | `0600`，WAL |
| 允许表（私人） | `/vol1/1000/docker/personal-night-ota/private/allowlist.json` | **`0600`**，只读挂载 |
| 容器日志 | `docker logs night-ota`（json-file，10m×3） | 只含设备标识与状态码 |
| **APK 发布目录** | `/vol1/1000/mobile/night/` | 用户在「飞牛 文件管理 → 存储空间1 → mobile → night」直接可见 |

发布目录里只有三类东西有意义：

```
/vol1/1000/mobile/night/
├── xiaoke-night-<versionCode>.apk     # 必需，文件名即版本号（例：xiaoke-night-38.apk）
└── release.json                       # 可选，只放 versionName / notes，不能改版本与哈希
```

`release.json` 示例（可选）：

```json
{ "versionName": "0.1.38", "notes": "通话首句更快；修复弱网重连后无字幕" }
```

**manifest 里的 `versionCode`、`apkBytes`、`apkSha256`、`publishedAt` 一律由服务端从 APK 字节现算**，
`release.json` 无法伪造它们；不存在的 APK 直接 404。

---

## 2. 接口契约

### 2.1 `GET /mobile/night/latest.json`

没有匹配 APK → `404 {"error":"no_release"}`。
有 APK → 取 `versionCode` 最大者：

```json
{
  "schema": 1,
  "channel": "night",
  "packageName": "cc.hahaxiong.xiaoke.night",
  "size": 12345678,
  "sha256": "<64 hex>",
  "url": "https://pa.hahaxiong.cc:8666/mobile/night/xiaoke-night-38.apk",
  "versionCode": 38,
  "versionName": "0.1.38",
  "apkUrl": "/mobile/night/xiaoke-night-38.apk",
  "apkBytes": 12345678,
  "apkSha256": "<64 hex>",
  "publishedAt": "2026-11-26T13:51:01Z",
  "notes": "可选"
}
```

`Cache-Control: no-store`（每次检查都拿最新）；旧版本 APK 保留可下载，便于回滚。

### 2.2 `GET /mobile/night/xiaoke-night-<vc>.apk`

`200` / `206`（`Range: bytes=a-b`，断点续传与分块下载用）/ `304`（`If-None-Match`）/
`404 {"error":"no_such_apk"}` / `416`（Range 越界）。
`Content-Type: application/vnd.android.package-archive`。

### 2.3 `POST /mobile/night/diagnostics`

请求：

```
Authorization: Bearer <phone-01 设备凭据>      # 与签票同一个凭据，但不消耗通话签票限额
Content-Type: application/json
{"schema":1,"events":[{"id":"<1..64>","kind":"call_start","ts":1732600000,"versionCode":38}]}
```

成功：`200 {"acked":["<id1>","<id2>", …]}`。`acked` 含本次全部被接受的 id（含此前已存在、本次被判重的那条）。

失败码：

| 码 | 含义 |
| --- | --- |
| 401 | 无 `Authorization` / 凭据不在允许表 / 长度异常 |
| 405 | 方法不对（`GET` diagnostics、`POST` manifest 等） |
| 415 | `Content-Type` 既不是 `application/json` 也不是空 |
| 413 | body > 64 KB |
| 429 | 单设备限流（默认 60 次/分、突发 20），带 `Retry-After: 60` |
| 400 | 结构/枚举/时间/版本不合规，`detail` 指明第几个事件哪一项 |
| 500 | 落库失败（客户端可原样重试，幂等不会多记） |

**严格校验清单**（任一不合规整批 400，不半收）：

- 根对象字段必须恰为 `schema` + `events`，多一个字段就拒；
- `schema` 必须是整数 `1`（`true`/`"1"` 都不行）；
- `events` 是数组，长度 `1..200`；
- 每个事件字段必须恰为 `id` + `kind` + `ts` + `versionCode`；
- `id`：`^[A-Za-z0-9._:-]{1,64}$`；
- `kind`：13 类白名单之一；
- `ts`：整数秒，不早于 45 天前、不晚于 now+300s（容忍客户端时钟快 5 分钟）；
- `versionCode`：整数 `1..2100000000`。

**白名单 13 类**：
`call_start, connected, mic_on, mic_off, rx_audio, rx_caption, tx_caption,
spoken_interrupt, cancel_ack, transport_error, call_end, paired, ota_check`

一批内部重复的 `id` 只记一次；跨批次重复的 `(device, id)` 幂等忽略——**同一批合成数据发两次，
库里仍然只有一份**（`ingest` 表里 `repeats=2` 留痕，方便识别客户端重放）。

---

## 3. 认证：从 Vaultwarden 派生 SHA256 允许表

诊断接口不调用北京 ECS 的签票服务，因此**不消耗通话签票限额**，也天然解耦：签票服务挂了不影响日志。

允许表由「已有设备凭据」的 SHA256 派生，明文凭据只在管道里过一遍，从不落盘、从不回显：

```bash
VW=~/.local/bin/vw
"$VW" get password "小可个人语音 · phone-01 设备凭据" | \
  python3 allowlist_admin.py add --device phone-01 \
    --file /vol1/1000/docker/personal-night-ota/private/allowlist.json
```

- 文件 `0600`，容器只读挂载；`allowlist_admin.py` 写入用 `mkstemp + fsync + replace`，不留半截文件。
- 服务按 mtime **热加载**，改表不用重启容器。
- 比对走 `hmac.compare_digest`，且遍历整张表不提前短路。
- 只打印 `sha256:<前12位>` 作指纹核对。

### 撤销联动（必读）

两处独立，**撤销要做两次**：

1. 语音侧：北京 ECS `cd /opt/personal-edge && python3 -B ticket.py revoke owner phone-01`
   → 该设备再也拿不到通话票；
2. 日志侧：`python3 allowlist_admin.py revoke --device phone-01 --file …/allowlist.json`
   → 该设备的诊断上报立刻 401。

只做第一步时，设备仍能继续上报**技术事件**（没有原话、没有密钥），但属于未授权设备留痕，
所以两处要一起做。反过来，给原 id 重新发凭据后，也要重新 `add` 一行新的 SHA256。
两处都没有的旧凭据不会有任何读取路径。

---

## 4. 存储、幂等与裁剪

schema 见源码 `sql/schema.sql`（部署后落在 `/app/schema.sql`）。要点：

- 主键 `(device, id)` + `INSERT OR IGNORE` ⇒ 幂等；`WITHOUT ROWID` 省空间；
- 只落 `device / id / kind / ts / version_code / received_at`，**没有请求体、没有 Authorization**；
- `ingest` 只存批次签名（`sha256(device\0id列表)[:32]`）、条数、实际新增、`repeats`；
- 后台线程每 10 分钟裁剪：按 `received_at` 保留 45 天（`NIGHT_RETENTION_DAYS`），
  并保证总行数不超过 50 万（`NIGHT_MAX_ROWS`）；
- 库文件 `0600`，只在 data 目录（容器内唯一可写挂载点）。

---

## 5. 分析（SQL / CLI）

```bash
export NIGHT_DB=/vol1/1000/docker/personal-night-ota/data/diagnostics.sqlite3

python3 cli.py devices    --days 7   # 设备：去重事件数、首末时间、版本分布
python3 cli.py calls      --days 7   # 通话：总数、接通率、收尾率、平均时长、传输错、接通但无音频
python3 cli.py media      --days 7   # 媒体失败面：无 rx_audio / 无字幕 / 传输错 / 首音频延迟
python3 cli.py interrupts --days 7   # 打断：每通次数、cancel_ack 覆盖率
python3 cli.py pending    --days 7   # 待分析：未收尾 / 未接通 / 接通无音频 / 传输错后中断
python3 cli.py sql "SELECT kind, COUNT(*) n FROM events GROUP BY kind ORDER BY n DESC"
```

CLI 只用只读连接（`file:…?mode=ro`），`sql` 子命令只放行 `SELECT`/`WITH` 单条语句。
会话切分：同设备 `call_start` 起、`call_end` 止，超过 30 分钟无事件视为断开另起一通。

容器内也可以直接跑（挂载一致）：

```bash
docker exec night-ota python3 /app/cli.py pending --days 3
```

---

## 6. 部署与回滚

一键（等价于下面四步，幂等）：

```bash
HOST=hahaxiong83@192.168.1.115 bash deploy/install.sh
```

手工版：

```bash
# 1) 建目录
sudo install -d -o 1000 -g 1001 -m 755 /vol1/1000/docker/personal-night-ota/{app,data}
sudo install -d -o 1000 -g 1001 -m 700 /vol1/1000/docker/personal-night-ota/private
sudo install -d -o 1000 -g 1001 -m 755 /vol1/1000/mobile/night

# 2) 代码（rsync 自本仓）
rsync -a --delete night_server.py cli.py allowlist_admin.py sql/ tools/ \
  hahaxiong83@192.168.1.115:/vol1/1000/docker/personal-night-ota/app/

# 3) 起容器
sudo docker compose -f /vol1/1000/docker/personal-night-ota/compose.yaml up -d

# 4) 验收
curl -s http://127.0.0.1:18786/mobile/night/healthz
```

Lucky 侧只在 8666 规则（`RuleKey=AdMqS1jnVHj8YLVt`，「外网回家NAS」）的 `ProxyList` 里 **新增一条**
（2026-11-26 已落地，`Key=db2jBKxlyvWQ477T`，规则内共 36 条 proxy）：

```
Domains   = ["pa.hahaxiong.cc/mobile/night"]     ← 前端路径写在域名后面（Lucky 3.0.0 的路径前缀派发）
Locations = ["http://127.0.0.1:18786"]
```

原有的 `pa.hahaxiong.cc → https://192.168.1.115:18783`（私有 admin）**整条不动**。
Lucky 的列表接口字段残缺，改规则必须 `GET /api/webservice/rule/{key}` 取完整对象再 `PUT`，
否则 `LocationInsecureSkipVerify` 这类字段会被清零（见 `lucky-reverse-proxy` skill 的坑）。

回滚 = 从 `ProxyList` 删掉这一条再 `PUT`（或整条恢复备份 `GET` 下来的 JSON），
`docker compose down` 停服务。数据与 APK 都留在原目录，不删。

---

## 7. 发布 APK 的实际路径与传输方式

**目标目录（用户在文件管理里直接可见）**

```
飞牛 文件管理 → 存储空间1 → mobile → night
= /vol1/1000/mobile/night/
```

放进去的文件名必须是 `xiaoke-night-<versionCode>.apk`（例如 `xiaoke-night-38.apk`），
`versionCode` 与 APK 里实际的 versionCode 一致——服务端只认文件名里的数字。

**传输方式（任选，都不需要我登录你的手机）**

1. **飞牛 文件管理网页上传**（最直观）：浏览器打开 `http://192.168.1.115:5666` → 文件管理 →
   存储空间1 → mobile → night → 上传。大文件建议用下面两种。
2. **SMB 网络盘**：Windows 资源管理器 `\\192.168.1.115`，用飞牛账号登录，直接拖进
   `存储空间1/mobile/night`；macOS 访达 `smb://192.168.1.115`。
3. **rsync / scp（推荐给 30MB+ 的 APK，可续传）**：

```bash
rsync -avP --partial \
  ~/Downloads/xiaoke-night-38.apk \
  hahaxiong83@192.168.1.115:/vol1/1000/mobile/night/
```

公司/异地走 EasyTier：把 `192.168.1.115` 换成 `10.10.10.22`（同一台飞牛2）。

**上传后自检（不动文件）**

```bash
ssh hahaxiong83@192.168.1.115 \
  'python3 /vol1/1000/docker/personal-night-ota/app/release_info.py --publish /vol1/1000/mobile/night'
```

它会打印真实 sha256、会对外产出的 `latest.json`，以及命名不合规、web 侧不会认的文件。

我**不会**替你上传 APK、也不会手写 manifest——这两件事都由你放文件 + 服务端现算完成。

---

## 8. 已落地状态（2026-11-26）

| 项 | 值 |
| --- | --- |
| 容器 | `night-ota`，镜像 `docker.1ms.run/library/python:3.11-slim`，`restart=unless-stopped` |
| 监听 | `127.0.0.1:18786`（只回环，公网/局域网只能经 Lucky） |
| 加固 | `read_only` 根文件系统、`cap_drop: ALL`、`no-new-privileges`、`user 1000:1001` |
| Lucky 入口 | `pa.hahaxiong.cc/mobile/night → http://127.0.0.1:18786`（新增，`Key=db2jBKxlyvWQ477T`） |
| 私有 admin | `pa.hahaxiong.cc → https://192.168.1.115:18783` **未改动**，`/` 仍返回「小可 · 配置工作室」 |
| 允许表 | `/vol1/1000/docker/personal-night-ota/private/allowlist.json`，1 条 `phone-01`，`sha256:67a65152c970…` |
| 诊断库 | `/vol1/1000/docker/personal-night-ota/data/diagnostics.sqlite3`，`0600`，当前 0 行（自测行已清） |
| APK 发布目录 | `/vol1/1000/mobile/night/`，当前版本从实际 APK 计算，用完整下载回读验收 |
| 公网实测 | `https://pa.hahaxiong.cc:8666/mobile/night/healthz` → 200（证书 `*.hahaxiong.cc`，2027-02-21 到期） |

自测结论：本地 60+ 项负例/幂等/Range 全通过；线上经 Lucky 跑 20 项负例 + 同一合成批次发两次
（库内 3 行、`ingest.repeats=2`），验完按 id 删除并回读 `COUNT(*)=0`，真实数据零污染。

## 9. 边界与已知事实

- 公网可达性沿用既有家宽条件：`pa.hahaxiong.cc` 当前解析到 `120.244.92.198`（A 记录），
  8666 已在公网可达；TLS 证书沿用 Lucky 既有按域名管理，**没有放松任何 TLS 设置**。
- 服务只听 `127.0.0.1:18786`，局域网/公网都只能经 Lucky 的 `/mobile/night` 前缀进入。
- 不读取除 phone-01 设备凭据之外的任何密钥；不打印任何凭据；库与日志都不含凭据。
- 不改 P003、不改 MyJavis 上传链路、不改线上 provider、不动其他 Lucky 域名与私有 admin 容器。
- 事件里没有原话、没有音频、没有 URL、没有 IP：客户端只送 `id/kind/ts/versionCode`。

Android 日志的 `ts` 采用 Unix 毫秒，入库统一为 Unix 秒。现有秒级上报同样支持。应用校验 `packageName/versionCode/versionName/sha256/size/url`；兼容字段 `apkUrl/apkBytes/apkSha256` 供运维工具读取。更新返回同源绝对 HTTPS 地址。
