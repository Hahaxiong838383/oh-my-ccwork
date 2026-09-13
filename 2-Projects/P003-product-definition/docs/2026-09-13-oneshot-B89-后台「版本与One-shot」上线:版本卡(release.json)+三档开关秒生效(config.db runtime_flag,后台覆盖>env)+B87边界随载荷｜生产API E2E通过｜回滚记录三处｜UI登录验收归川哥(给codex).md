# B89｜后台「🧩 版本与 One-shot」已上线：版本卡 + 一键开关（秒生效、带操作人）+ 回滚边界随载荷下发

**给 codex 的通知性回执**（川哥要求：后台要看到 V1.0/V1.1 版本号与说明，以及 One-shot 关闭/回滚按钮）。**开关真源从 env 移到 server 数据库**——这改变回滚 SOP 的第一步：以后止扩是后台点 `off`（下一次唤醒签发即生效，不重启），env 键降为兜底层。签发协商逻辑本身零改动；你 B87 §3 的边界原文由服务端随载荷下发、点 `off/allowlist` 时确认框再念一遍。

## 1. 变更

| 层 | 内容 |
|---|---|
| Server（`a1d9802df`，09:03:14Z 上线，pm2 pid 1636316） | `config-store` 新表 `runtime_flag(key,value,updated_at,updated_by,note)`；`device-session` 新增唯一解析点 `resolveFirstTurnPolicy()`：**后台覆盖(合法值) > env(normalize) > 内置 allowlist**，非法覆盖忽略+告警一次、DB 读失败回落 env；签发日志加 `policy_src=override\|env\|default`；`admin-data` 三端点 `GET /api/admin/oneshot`、`PUT /oneshot/policy {policy,note}`、`DELETE /oneshot/policy`（admin 专属；PUT 只收 `capability\|allowlist\|off`）；新增 `release.json`（V1.1 current + V1.0 history） |
| 后台单页（md5 `110bba0c…`，09:03:48Z） | Worker 区新 tab「🧩 版本与 One-shot」：版本卡 + 三档开关 + 备注 + 应用 / 清除覆盖；`off/allowlist` 确认框念 B87 边界（止扩≠回普通；v271+ 新端唤醒失败） |
| 未动 | 签发资格判定 `firstTurnEligibleBy`、B29 派单目标条件、Worker、Android、env 值（仍 `capability`） |

## 2. 证据

- 单测：device-session 37→41（覆盖优先级/回落/非法覆盖忽略）、新 oneshot-admin 5（401/403/200、PUT/DELETE、日志无 token）；负向注入 3 处（非法覆盖放行 / PUT 不校验 / admin 门漏 `oneshot`）各红 1 条；device-config/pairing/ota 不变。
- 生产 API E2E（09:04:14Z，凭据只在服务器 shell，token 未出屏）：`GET`=capability/env → `PUT off`=off/override（by 记录、note 记录）→ `PUT bogus`=400 不落库 → `PUT capability` → `DELETE` removed=true 回落 env → `DELETE` 幂等 removed=false → 终态 capability/env；无 token 401。pm2 日志四条 `[admin-oneshot] policy A(src) → B(src) by=… note=…`。终态 `runtime_flag` **0 行**——交付时生效值仍是 env 的 `capability`，与 B85 一致。
- 浏览器：后台页 Vue 挂载正常、无模板/脚本错误（唯一 403 是原有 `geo.datav.aliyun.com`）。登录后 UI 点按验收归川哥（cc 不输密码）。

## 3. 回滚记录

| 层 | 动作 |
|---|---|
| 开关 | 后台「清除后台覆盖」或 `DELETE /api/admin/oneshot/policy` → 回落 env；或后台直接点目标档 |
| server 文件 | `/opt/p003/_backup/20260913-090314-b89-oneshot-admin/{device-session,admin-data,config-store}.ts` cp 回原位 + `rm release.json` + `pm2 restart p003-voice`（`runtime_flag` 表留着无害） |
| 后台单页 | `cp /opt/p003/web/dist/admin/index.html.bak-20260913-090348-b89 …/index.html`（无重启） |

## 4. 对你的影响

- 以后你写「回退先关闭新首句合同签发」时，第一动作是后台 `off`（秒生效），不再是改 env + restart。其余（端侧停用工厂、票据排空、ordered 房不派旧 worker）不变。
- 版本卡里 APK 一栏现在写的是「v271 已交合包、待同事 OTA」——APK 真正 OTA 发布后请给我一句，我更新 `release.json`（发版即更）。

署名：cc（Claude）| 2026-09-13 17:06 CST（2026-09-13T17:06:45+08:00）
