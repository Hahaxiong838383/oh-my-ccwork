# multica 多用户飞书扫码授权 PoC（路径 A：user OAuth）

> 2026-05-27 落盘 | 状态：脚本就绪，待 mini keychain-downgrade unblock 后端到端验证

## 决策

**路径 A** — agent 用各团队成员的飞书身份操作（消息署名团队成员本人，符合企业审计）。
路径 B（bot 代发）排除：失去 per-user 审计追溯。

## 核心架构（HOME 目录隔离）

lark-cli 硬约束「每 profile 必须独立 app-id」打死了「同 app 多 profile」思路。
最终方案用 `HOME` 环境变量隔离 config 目录，每个 multica user 一个 fake HOME，
共享同一个飞书 app，各自登录各自飞书账号、各自 token 文件。

```
mini 上：
~/multica-user-homes/
  ├── mc-user-<id1>/           # 团队成员 A
  │   ├── .lark-cli/config.json
  │   └── Library/Application Support/lark-cli/
  │       ├── master.key.file
  │       ├── appsecret_<app>.enc       # 从默认 HOME copy
  │       └── <app>_<openid_A>.enc      # 各自扫码生成
  └── mc-user-<id2>/           # 团队成员 B
      └── ...

multica daemon spawn agent → spawn lark-cli 时：
HOME=~/multica-user-homes/mc-user-<id> lark-cli im send --chat ... --text ...
```

## 端到端时序

```
团队用户 (浏览器)         multica web              mini daemon
  │ 1. 点"飞书授权"          │                         │
  ├──────────────────────>│                         │
  │                       │ 2. POST start (user_id) │
  │                       ├────────────────────────>│ HOME=... lark-cli auth login --no-wait
  │                       │  device_code + url + qr │
  │                       │<────────────────────────│
  │ 3. 显示 QR             │                         │
  │<──────────────────────│                         │
  │ 4. 自己手机扫码 → 飞书   │                         │
  │                       │ 5. POST complete         │
  │                       ├────────────────────────>│ HOME=... lark-cli --device-code
  │                       │  user_open_id           │ token 落到 user HOME
  │                       │<────────────────────────│
  │ 6. 完成                │                         │
  │<──────────────────────│                         │
```

## 文件清单

| 文件 | 用途 |
|------|------|
| [RESEARCH-REPORT.md](./RESEARCH-REPORT.md) | codex round 1 调研：lark-cli token 持久化 / Device Flow / multica 多 runtime |
| [API-DESIGN.md](./API-DESIGN.md) | codex round 3 完整 multica 后端集成方案（391 行，20 章节） |
| [01_mini_init.sh](./01_mini_init.sh) | mini 一次性运维：检查 keychain-downgrade、创建 user-homes 目录 |
| [02_user_provision.sh](./02_user_provision.sh) | 为新 multica user 准备 HOME（copy master.key + appsecret） |
| [03_user_oauth_start.sh](./03_user_oauth_start.sh) | 模拟 start API：发起 Device Flow，返回 device_code + QR |
| [04_user_oauth_complete.sh](./04_user_oauth_complete.sh) | 模拟 complete API：polling，写入 user_mapping.json |
| [05_agent_spawn.sh](./05_agent_spawn.sh) | 模拟 agent spawn：按 user_id 找 HOME 透传 lark-cli 命令 |

## 当前进度

- ✅ 调研完成，方案定稿
- ✅ 5 个 PoC 脚本写好 + `bash -n` 通过 + 路径已 macOS 适配
- ✅ 推送到 mini `~/lark_multi_user/`
- ⏸️ **卡 mini keychain-downgrade**（必须 Mini 本机 Terminal 跑，不能 SSH）

## 川哥 unblock 步骤（2 分钟）

走到 Mini 跟前 / 屏幕共享 / VNC，在 Mini 的 **Terminal.app** 跑：

```bash
lark-cli config keychain-downgrade
```

期望输出：`{"ok":true,...}` 或 `already downgraded`。

完成后告诉 cc，cc 接手：
1. 跑 `01_mini_init.sh` 验证环境
2. 跑 `02_user_provision.sh test-user-001` 准备 test HOME
3. 跑 `03_user_oauth_start.sh test-user-001` 拿 device_code + 显示 QR
4. 川哥用手机飞书扫 QR
5. 跑 `04_user_oauth_complete.sh test-user-001 <device_code>` 完成
6. 跑 `05_agent_spawn.sh test-user-001 im send ...` 实测发消息

## 之后的工作（PoC 通过后）

| 阶段 | 工作 |
|------|------|
| 集成阶段 1 | multica 后端实现 3 个 HTTP endpoint（start/complete/status），DB schema 迁移 |
| 集成阶段 2 | multica web 前端：扫码授权页面（QR 渲染 + polling 状态） |
| 集成阶段 3 | multica daemon 改造：spawn agent 时按 task.user_id 注入 HOME 环境变量 |
| 集成阶段 4 | 内测团队 3-5 人灰度，验证多用户并发授权 + 端到端飞书操作 |

## 已知风险

| 风险 | 缓解 |
|------|------|
| `appsecret_*.enc` 复制后是否能跨 HOME 解密 | 测试时验证；如不行，每个 HOME 独立 init |
| keychain-downgrade 后的 master.key.file 复制到 fake HOME 后能否解密 | 测试时验证；可能需要每个 fake HOME 独立 downgrade |
| 多用户并发扫码竞态 | HOME 隔离天然规避，无共享状态 |
| 用户 token 7 天 refresh 过期 | lark-cli 自动 refresh；过期则触发重新扫码（前端检测 `auth status`） |
