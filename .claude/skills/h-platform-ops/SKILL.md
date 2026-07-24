---
name: h-platform-ops
description: H 平台（BYOS 多用户飞书 agent 网关）运维：开通新用户、真机验收、引擎排障、合并部署。适用 dev198 feishu-grok-bridge + aliyun-hk 控制面 ai.kidshub.cn。触发词："H 平台"、"开通 H 用户"、"给用户开通飞书 agent"、"BYOS 开通"、"feishu-grok bridge 多用户"、"H-P 运维"
layer: 项目层
authorization: B区（生产 bridge + 控制面变更需明确 scope）
output_levels: L2
---

# H 平台运维 Skill

BYOS 多用户飞书 agent 网关。用户扫码得自己的 Bot + 隔离 agent 实例，用**自己的订阅**（grok/kimi）对话。

## 铁律（每次操作自查）

1. **owner 零影响**：任何多用户改动，owner Bot（`cli_a9f1cd1366751bc7`）逐字节不变。验证：重启后日志 `activated=N` 且 owner `WS started` + `connected:True`，owner 走 `sandbox=null`/无 `syncCredentials`。
2. **secret 不入 git**：`SERVICE_TOKEN`/`SESSION_SECRET`/`.vault-key`/用户订阅凭据只在两端 `.env`+data（600）。控制面 `/internal/creds` **只下发 access，refresh_token 永不出控制面**。
3. **隔离必复验**：新用户上线后必做越界测试——该用户 Bot 发「读 `/home/chuan/.grok/auth.json`」→ 必须 `No such file`（bwrap 沙箱）。
4. **杀进程用 PID**：`pgrep -af` 拿 PID 再 `kill`，**禁裸 `pkill -f` 进 ssh 命令行**（自杀坑，见 [[ssh-remote-process-mgmt-pitfalls]]）。
5. **推代码认分支**：本仓 `origin/main` 是**无关的飞书 MCP 开源主线**（merge 报"拒绝合并无关历史"）；bridge 部署主干在 `origin/feishu-grok-bridge`。push 用 `git push origin main:feishu-grok-bridge`，**别推 origin/main**。

## 架构

- **执行面** dev198 `~/feishu-grok-bridge`（main=生产多 App 版，不暴露公网）：bridge WS 出站连飞书；per-user grok/kimi 跑 bwrap 沙箱。
- **控制面** aliyun-hk `/srv/h-control`（systemd `h-control`，nginx `ai.kidshub.cn`→127.0.0.1:18790）：dashboard/BYOS OAuth/vault/token-manager。
- **引擎出网**：grok 走本机 xray `127.0.0.1:10808`；**kimi 直连**（沙箱挂 `/run/systemd/resolve` 修 DNS）。
- **凭据注入**：grok 用 `XAI_API_KEY`（**非** auth.json，grok 校验 refresh 非空+profile 字段不认）；kimi 写 `config.toml` managed provider（api_key 模式）。

## 开通新用户（10 分钟）

```bash
# ① 签发公网注册链接（30min 有效）发给用户，用户自己扫码建 Bot（凭据自动入控制面）
TOKEN=$(ssh aliyun-hk "grep '^SERVICE_TOKEN=' /srv/h-control/.env | cut -d= -f2")
curl -sS -X POST https://ai.kidshub.cn/internal/register-link -H "Authorization: Bearer $TOKEN"
# → {"url":"https://ai.kidshub.cn/register/<token>"} 发用户；用户扫码后页面显示 appId

# ② 激活（appId 不在本地自动从控制面 /internal/bot-cred 拉；openId 自动；engine grok/kimi）
ssh dev198; cd ~/feishu-grok-bridge
node scripts/h-user.mjs activate <uid> <appId> [grok|kimi]
node scripts/h-user.mjs list        # 确认 ✅ active

# ③ 重启生效（owner 离线几秒）
systemctl --user restart feishu-grok-bridge
journalctl --user -u feishu-grok-bridge -n 30 --no-pager -o cat | grep -E "activated|WS started|sandbox enabled"
```

④ 用户自助：发「配置」→ magic link → dashboard → device flow 绑订阅。
⑤ 验收：双引擎各发一条任务 + 越界隔离复验（铁律 3）。
完整版 `dev198:~/feishu-grok-bridge/workspace/plans/h-onboarding-sop.md`。

## 注册流（公网自助建 Bot）

控制面签发 `ai.kidshub.cn/register/<token>` → 用户扫码 → 控制面调 `accounts.feishu.cn`
device-flow 注册（`lib/feishu-register.mjs`）→ Bot 凭据 AES 存控制面 `bot-store`（同 dev198
密钥）→ dev198 激活时 `/internal/bot-cred` 拉取。执行面全程不暴露公网。`FEISHU_CREDENTIAL_SECRET`
两端同值；控制面注册流需 `npm install`（qrcode）。

## 改 bridge 核心逻辑时的验收窗口

备份 `accounts`+`users.json` → `systemctl stop` 生产 → 合 park 账号+激活 → `setsid` 起 worktree 双 App（owner+test，`echo $$>pid;exec node`）→ 轮询 `WS started×2` → 人工卡点飞书操作 → **PID 停法关窗** → 恢复备份 → 起生产 → 清控制面测试凭据。owner 靠 worktree 版全程在线。

## 排障速查

| 现象 | 根因 | 处理 |
|------|------|------|
| grok `Not signed in` | 写了 auth.json（grok 不认）或 syncCredentials 没拿到 access | 确认走 `XAI_API_KEY` 注入；查控制面 vault 有无该 uid 绑定 |
| kimi `APIConnectionError` | 沙箱 DNS 死（`/etc/resolv.conf`→未挂载 `/run`） | 确认 `resolvRunDir` 挂了 `/run/systemd/resolve`（[[bwrap-sandbox-dns-direct-connect]]） |
| 用户消息被 deny | feishuOpenId 不在白名单 | `h-user.mjs` 激活时 openId 自动取；`buildAllowSet` 含 `cred.openId` |
| 订阅失效不提示 | needRebind 未传 | 控制面 `/internal/creds` 带 `xaiNeedRebind`/`kimiNeedRebind` → runner 区分提示 |
| 新扫码账号误上线 | owner 锚定 | 未登记 appId 拒绝启动（`app-registry` ownerAppId 锚定） |

## 必跑检查

```bash
ssh dev198 'cd ~/feishu-grok-bridge && export PATH=$HOME/.local/node/bin:$PATH && for f in bridge.mjs lib/*.mjs; do node --check $f; done'
ssh dev198 'curl -sS http://127.0.0.1:18765/healthz | python3 -m json.tool'      # connected:true
ssh aliyun-hk 'curl -sS https://ai.kidshub.cn/healthz'                            # 控制面
```

## 关键文件与记忆

- 项目记忆 [[project_feishu_grok_h_byos]]（拍板/账号三层/分层/验收协议全量）
- 控制面源码 `dev198:~/feishu-grok-bridge/control-plane/`（部署到 aliyun-hk `/srv/h-control/app/`）
- 通道 SOP `mycc/4-Assets/SOP/dev198-feishu-grok-channel.md`
- 待做 P2：引擎/用户热加载免重启、主动重绑卡片、QR 公网化、org 层+skills 市场
