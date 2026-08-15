# P003 S2-B1 设备 Session API 交接（cc → codex）

> 回应 `CC_S2B1_MCU_SN_TOKEN_SESSION_API_PROMPT_20260815.md`。2026-08-15。
> 全文无 secret：token 一律 `<redacted>`，凭据只在 Studio 的 600 文件里。

---

## 0. 总状态：**READY**（一个子项 BLOCKED，见 §7）

| 项 | 状态 |
|---|---|
| P0-A 临时 MCU SN Token ×8 + 30 天设备凭据 | ✅ 签发验证完成；**落盘见 §2 的通道说明** |
| P0-B `/v1/device/session` + `/prefetch` | ✅ **已部署生产并公网 E2E** |
| P0-C 单测 + 敏感扫描 + 部署验收 | ✅ 16/16 绿 · 敏感扫描 0 泄露 · 可回滚 |
| 正式设备密钥链（出厂烧录级） | 🔴 BLOCKED（硬件侧）——当前用 30 天 device credential 过渡，见 §3 |

---

## 1. API 真值

| 项 | 值 |
|---|---|
| Base URL | `https://kidshub-ai.hahaxiong.cc` |
| 创建会话 | `POST /v1/device/session` |
| 预热 | `POST /v1/device/session/prefetch` |
| 部署位置 | aliyun-hk `/opt/p003/server`（pm2 `p003-voice`，hono 路由 `/v1/device`） |
| 代码仓 | `Hahaxiong838383/oh-my-ccwork` @ `main`，子目录 `2-Projects/P003GameDemo20260513` |
| 新增/改动文件 | `apps/server/src/device-sn.ts`（新）· `apps/server/src/routes/device-session.ts`（新）· `apps/server/src/index.ts`（+2 行挂载）· `apps/server/scripts/device-session.test.ts`（新）· `apps/server/scripts/sign-device-credential.ts`（新） |
| commit | 见本文件所在 commit（与代码同一提交） |
| 健康状态 | 公网 E2E 全过（2026-08-15）：401 探针 ✓ / 200+claims 十项 ✓ / prefetch ✓ / 老功能回归 `/admin/` `/api/*` `/v1/chat/completions` 均未受影响 |

## 2. 凭据文件（P0-A）——交付通道说明，先读

**目标路径**：`/Users/fu-121/Downloads/p003-mcu-sn-tokens-20260815.txt`（chmod 600）

**签发这批 token 时 Studio 离线**（22 端口有线/WiFi 双通道超时），token 是易腐品（TTL 1h），
所以交付改为：**后台守护每 60s 探测 Studio，上线即现签现推**（保证你拿到手时 TTL 满 1 小时），
守护窗口 4 小时。你开机后文件就在；若没在，说明超窗，喊 cc 重推一次即可。

文件格式（TSV）：

```
DEVICE_CREDENTIAL<TAB><30 天设备凭据 JWT>
TOKEN_1<TAB><room><TAB><expires_at_ms><TAB><jwt>
…共 8 张，room 互不相同
```

**重点：8 张 token 用完/过期都不要紧**——`DEVICE_CREDENTIAL` 有效 30 天，API 已上线，
你可以随时自己换新（这才是本次交付的主体，8 张预签只是首跑便利）：

```bash
curl -s -X POST https://kidshub-ai.hahaxiong.cc/v1/device/session \
  -H "Authorization: Bearer $DEVICE_CREDENTIAL" \
  -H "content-type: application/json" \
  -d '{"device_sn":"BJP00326060100200003","trace_id":"<本轮 trace>","app_version":"1.2.2-canary.2","firmware_version":"unknown"}'
```

## 3. 鉴权语义（当前形态 + BLOCKED 边界）

- **设备凭据 = 服务端现有 `AUTH_JWT_SECRET` 体系签的 device JWT**（claims：`sub=<MCU_SN>`、`kind=p003-device`）。
  没有发明固定密钥；MCU SN 只是身份，凭据才是钥匙。
- 凭据由服务端签发（`scripts/sign-device-credential.ts`，secret 不出机）。加新设备：SN 进
  `DEVICE_SN_ALLOW` 白名单 + 签新凭据——找 cc/川哥。
- 🔴 **BLOCKED**：出厂烧录级设备密钥链（硬件侧未就绪）。就位时只换 `verifyDeviceCredential()`
  一个函数的实现，接口面不动。

## 4. 行为契约（与你的 prompt 逐条对齐）

| 你的要求 | 实现 |
|---|---|
| SN 正则 `^BJP003[0-9]{14}$` | ✅ `device-sn.ts`，独立纯函数 |
| YYMMDD 真实日期 | ✅ Date 归一化回读三段比对（2 月 31 日这类拒绝） |
| 流水号 `00000000` 禁用 | ✅ |
| `BJ000000000000000000` 拒绝 | ✅（天然不过正则初筛） |
| ADB serial 拒绝 | ✅ 400 |
| `sub == identity == dev-<SN>` | ✅ 签发后自检强制 |
| `video.room == room_name == sn-<SN>-<unix_seconds>` | ✅；**同秒并发用逻辑秒递增保唯一**（格式不变仍是纯数字秒） |
| `roomConfig.agents[]` 含 `rust-worker` | ✅ 自检强制 |
| `exp == expires_at_ms`、TTL ≥5s | ✅ 自检强制；**自检任一失败 → 500 拒绝交付**（不发可疑 token） |
| 响应字段名与 Android 合同一致 | ✅ `status/server_url/room_name/identity/token/trace_id/session_id/expires_at_ms/expected_agent_name` |
| prefetch 不签 token | ✅ 返回 `{status:"warming", prefetch_id, expires_at_ms}`；session 带回 `prefetch_id` 仅做日志关联 |
| 错误码分明 | ✅ 400（SN/trace/JSON 格式）· 401（凭据缺失/无效）· 403（SN≠凭据 / 白名单外，fail-closed）· 429（>10 次/分钟/SN，session+prefetch 共享额度）· 503（签发配置缺失）——绝不统一 500 |
| 日志纪律 | ✅ 只记 `session_id / trace_id / SN / room / ttl / 耗时`；JWT/Authorization/密钥不进日志（被单测敏感扫描守着，含正锚） |
| 对账三元组 | ✅ `session_id + trace_id + MCU_SN` 三者都在响应与服务端日志里 |

## 5. 测试与验收证据

- **单测 16/16 绿**（`npx tsx scripts/device-session.test.ts`，Hono 内存请求零端口）：
  你 P0-C 的 11 项全覆盖 + 白名单 fail-closed + 坏 JSON + 503 + 自检函数负向注入
  （伪造错 room 的 token 必须 throw——判据先被证明有区分力再用）。
- **灰度先行**（本项目新上线门禁的第一次执行）：staging 实例（PORT=3005、同一份 env）
  → 401/400/200+claims 十项/prefetch 全过 → 停 staging → 才动生产。
- **生产公网 E2E**：见 §1。样例（脱敏）：

```
POST /v1/device/session   Authorization: Bearer <redacted>
{"device_sn":"BJP00326060100200003","trace_id":"prod-e2e-2","app_version":"1.2.2-canary.2","firmware_version":"unknown"}
→ 200
{"status":"ok","server_url":"wss://voice-hk.hahaxiong.cc",
 "room_name":"sn-BJP00326060100200003-1786808736","identity":"dev-BJP00326060100200003",
 "token":"<redacted>","trace_id":"prod-e2e-2","session_id":"266d6d68-…",
 "expires_at_ms":1786812336000,"expected_agent_name":"rust-worker"}
```

- **敏感扫描**：staging 日志 `eyJ` 0 行（正锚 device-session 2 行）；生产日志 `eyJ` 0 行（正锚 1 行）；
  单测输出扫描含「无 ok 日志则失败」的正锚。

## 6. Worker 状态

**未动。** `feat/rust-worker` 远端仍为 `24bcc3b3`；线上二进制未替换、未重启。
本次改动全部在 p003 server 侧。

## 7. 回滚（不含任何密钥）

```bash
# 代码回滚（备份是部署前打的）
ssh aliyun-hk 'cd /opt/p003/server && tar xzf /root/p003-server-src-bak-20260815-pre-device-session.tgz && pm2 restart p003-voice'
# env 回滚：删除 .env.local 尾部「S2B1 设备 Session API(2026-08-15)」注释起的 7 行
# 验证回滚生效：POST /v1/device/session 应回 404
```

## 8. 你侧的下一步（照你 prompt 的顺序）

1. Studio 开机 → 拿 `~/Downloads/p003-mcu-sn-tokens-20260815.txt` 重跑 v14 Mode 1/2/3
2. 正式 HTTP Session Provider 指 `https://kidshub-ai.hahaxiong.cc/v1/device/session`
   （ADB reverse Provider 留作回退）
3. 对账用 `session_id + trace_id + MCU_SN`——服务端日志已按此打
4. `canary.say` / ≥5s 长句 AEC 是 worker 侧下一批，与本 API 无耦合

---

署名：cc（Claude）| 2026-08-15
