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
5. **UI 改版先问取向**：改页面前确认**桌面优先还是移动优先**（管理/配置类页面默认桌面优先）；「按 X 的逻辑做」= 抽同一组件双端复用，不是各写一份长得像的（[[feedback_ui_parity_means_same_component]]）。
6. **改 html.mjs 必跑 script 语法门**：模板字符串会把 `\n` 先解析成真实换行 → 输出的 JS 字符串字面量断行 → **整个 script 块静默不执行**（页面正常、console 无报错、按钮全失灵）。源码里写 `\\n`；改完跑「必跑检查」里的 script 块语法检查（[[feedback_template_string_swallows_js_escapes]]）。
7. **推代码认分支**：本仓 `origin/main` 是**无关的飞书 MCP 开源主线**（merge 报"拒绝合并无关历史"）；bridge 部署主干在 `origin/feishu-grok-bridge`。push 用 `git push origin main:feishu-grok-bridge`，**别推 origin/main**。
8. **健康读数认实例**：bridge `/health` 的**顶层字段是 owner Bot 的**，用户 Bot 在 `apps.<appId>` 里。查「某用户的消息到没到」必须看 `apps` 分解——2026-07-25 我拿顶层 `lastInboundAt:null` 断言「一条没收到」，实际用户 Bot 那条准时到了（[[feedback_selfcheck_false_signal]]）。
9. **远程语法检查用绝对路径**：dev198 非交互 ssh 的 PATH 没有 node，`node --check` 会「命令未找到」而静默略过；结论行必须由累计变量驱动，绝不无条件 `echo 全过`。

## 架构

- **执行面** dev198 `~/feishu-grok-bridge`（main=生产多 App 版，不暴露公网）：bridge WS 出站连飞书；per-user grok/kimi 跑 bwrap 沙箱。
- **控制面** aliyun-hk `/srv/h-control`（systemd `h-control`，nginx `ai.kidshub.cn`→127.0.0.1:18790）：dashboard/BYOS OAuth/vault/token-manager。
- **引擎出网**：grok 走本机 xray `127.0.0.1:10808`；**kimi 直连**（沙箱挂 `/run/systemd/resolve` 修 DNS）。
- **凭据注入**：grok 用 `XAI_API_KEY`（**非** auth.json，grok 校验 refresh 非空+profile 字段不认）；kimi 写 `config.toml` managed provider（api_key 模式）。

## 开通新用户（管理员零填写，2026-07-25 v1.4.0 起）

**管理台 → 右上「开通用户」→ 只选引擎 → 生成链接 → 发给用户 → 完事。**
链接是**通用的**（可群发多人），账号名/显示名/部门全部扫码后自动识别。
用户扫码后控制面自动建号 + 关联 Bot + 激活，dev198 同步器 ≤15s 热加载起 App。

用户侧只剩两步：① 扫码授权 ② 在飞书里对自己的 Bot 发「**配置**」绑订阅。

```bash
# 脚本/自动化入口（等价于管理台弹层）；uid/org 留空即通用链接
TOKEN=$(ssh aliyun-hk "sudo grep '^SERVICE_TOKEN=' /srv/h-control/.env | cut -d= -f2")
curl -sS -X POST https://ai.kidshub.cn/internal/register-link \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"engine":"grok"}'
```

- **uid 由 openId 确定性派生**（`u-<sha256前10位>`）：同一飞书号重扫必落**同一账号**，
  不会凭空多出孤儿号。openId 缺失退到 appId。uid 只是内部句柄，界面一律显示飞书 Bot 名。
- **姓名/部门靠 union_id 接力**（2026-07-25 实测跑通）：
  ① 控制面用**用户自己的 Bot** 把 open_id 换成 `union_id`（小权限就够）；
  ② 执行面用 **owner Bot**（`cli_a9f1cd1366751bc7`，权限最全）按 union_id 查真名/部门，
  POST 回 `/internal/identity-resolved`。**新用户零配置**——只有 owner 一个 Bot 需要权限。
  ⚠️ **open_id 按 App 隔离**：拿 A 应用的 open_id 去问 B 应用 = `99992361 open_id cross app`。
  union_id 才跨 App 通用。这是整个方案成立的前提。
  ⚠️ 分工不能合并：控制面铁律「owner 凭据不进 vault、永不触碰」，所以查询必须留在执行面。
- **部门已打通**（2026-07-25 当天）：前提是 owner Bot 有 `contact:user.department:readonly` +
  `contact:department.base:readonly` 的 **tenant 档**（只有 user 档时 tenant_access_token
  读不出来，接口仍 `code=0` 但字段直接消失）+ 通讯录范围覆盖到人。新 Bot 若读不到部门，
  先查这两条。读不到时管理台标「**待认领**」，可手填。
- 中文部门名进不了 skills 层名正则 → `org` 存 slug（`d-<hash6>` 稳定哈希）、`orgLabel` 存
  飞书原名。界面显示 orgLabel，**装 L1 skills 时填的是 slug**（部门面板小字给出）。
- ⚠️ **手填与自动识别必须归一**：手填 `product` 与自动识别「产品」会分裂成两个部门层，
  同部门同事互相看不见共享 skills。故 identity-pending 会认领「org 存在但未经飞书确认」
  （orgLabel 空且非手填）的用户；管理员显式手填打 `orgManual` 标记让自动识别绕开
  ——**人的决定优先于机器**。org 变更触发热加载重启该 App 换 `/org` 挂载。
- **开通意图签进 token**（HMAC JSON payload），篡改/过期照旧拒；旧格式链接仍兼容。
- **显示名自动取**：注册验活后调 `bot/v3/info`（tenant_token 即可）拿 `app_name` = 用户建 Bot 时起的名字，写进 `user.name`，控制台主显示；拿不到回退账号名。
- 生成链接后弹层给**整段可转发说明**（链接+两步+隐私），双按钮复制。
- **显示名兜底**：注册那刻 Bot 可能未就绪取不到 app_name（真机遇到过）→ fetchBotProfile 内置重试 + **管理台每次加载后台补齐**「name 仍等于账号名」的用户（每 uid ≤3 次）。所以名字晚几分钟才出现是正常的。
- ⚠️ `bot/v3/info` 的 `open_id` 是 **Bot 自己的**，≠ 消息白名单用的**用户 open_id**（注册回调 `user_info.open_id`），别互相覆盖。
- 自动开通失败（uid 冲突等）→ 降级到「待关联 Bot」老路径，注册页提示联系管理员，Bot 不丢。
- **开通前预检「这人能不能自动识别」**（省一趟往返）：owner Bot 按 union_id 直读
  **不受**「通讯录范围」里那个部门列表限制——川哥的部门「产品」不在列表里照样读到，
  非创建者同事也 `code=0` 姓名部门齐全。所以预检就跑一次直读，能读到即可放心发链接：
  ```bash
  # dev198 上：取范围内任一同事 union_id → 直读 → 看 name/department_ids 在不在
  # 完整脚本见本次会话 scratchpad probe-ryan-ready.mjs 的思路
  ```
  读不到也不阻断：显示名回退 Bot 名 + 部门标「待认领」，功能完全不受影响。
- 验收：双引擎各发一条任务 + 越界隔离复验（铁律 3）。完整版
  `dev198:~/feishu-grok-bridge/workspace/plans/h-onboarding-sop.md`。

## 权限不足 → 自动推授权卡片（v1.4.0）

- **授权链接从飞书错误报文里提，不自拼**：权限不足时飞书自己在 `msg` 里给出带确切
  scope 的官方链接（`code 99991672` → `…点击链接申请并开通任一权限即可：https://open.feishu.cn/app/<id>/auth?q=<scopes>&op_from=openapi&token_type=tenant`）。
  ⚠️ 别拿「链接能打开」当验证：开放平台是 SPA，**真假 appId 都返回同一个 9248 字节壳**，
  服务端不校验（[[feedback_platform_error_carries_official_remedy_link]]）。
- 两个触发源：控制面开通时缺权限（`/internal/perm-pending` 队列，执行面 30min 轮询推卡片）
  + 执行面运行时撞错（消息处理器顶层 catch → `maybeSendPermissionCard`，同类 30min 去重）。
- 卡片按钮 URL 过**域名白名单**（`open.feishu.cn`/`open.larksuite.com`/`ai.kidshub.cn`），
  防伪造报文把用户导去钓鱼站；不可信按钮丢弃但卡片照发。
- ⚠️ **飞书对无权限字段是静默省略**：`code=0` + HTTP 200，但关心的字段（姓名/部门）
  凭空消失。判断有无权限不能只看 code，要看字段在不在；权限档位看 App 权限清单每条的
  `token_types`（`user` 档的 scope 用 tenant_access_token 调不出来）。

## 一键打开后台（卡片按钮，v1.4.0 → v1.9.0 直达版）

- `/go/<token>`：HMAC 签名、**7 天、可重复点**。magic link 是一次性 10 分钟的，
  卡片会长期躺在聊天记录里，用它点开就是「已失效」——所以另起一套。
- **不接 `next` 参数**（省掉开放重定向一整类问题）。v1.9.0 要深链到页面内某块时，
  用**封闭白名单** `GO_SECTIONS = {memory:'#memory', skills:'#skills'}`：`?to=` 查表
  得常量片段，用户输入永远不进 `Location`，表外值静默忽略落 `/dashboard`。
  验收必测三种：表内值 / `../evil` / `https://evil.com`（后两者必须落默认页）。
- 按钮走 `behaviors:[{type:'open_url'}]`，链接**发卡时**就嵌好 → 一次点击到位。
  `open_url` 与 `callback` **不能同时挂**（都会触发＝开链接还多发一张卡）。
  拿不到链接（控制面不可达 / owner 无用户后台）自动退回 callback 两跳路径。
- 🔴 **嵌了免登链接的卡必须 `enable_forward:false`**：`/go` 链接等价于登录凭据，
  转发一张回复卡 = 把后台登录态送人。

## 常用命令按钮与流式回复（v1.9.0）

- 三个命令 `配置 / 新会话 / 我的记忆` 单一真源在 `lib/feishu-card.mjs` 的 `COMMANDS`：
  `text`=按钮文案、`say`=纯文本命令词。**改 say 必须同步改三处落点**（配置正则 /
  role-identity `isNewTopic` / 记忆正则），否则点了会静默掉进 agent 当任务跑。
  `test/command-probe.test.mjs` 锁着这条不变式。
- **横排**靠分栏：`column_set → column{direction:"horizontal"} → button[]`。
  JSON 2.0 没有 1.0 的 `tag:"action"` 容器，button 平铺各占一行。
- **跟随气泡没有布局参数**（只有 content/i18n_contents），固定竖排，改不了；
  现只在流式降级路径当兜底用。
- 流式回复开关 `H_STREAM_REPLY=0` 关闭。**收尾必须显式关 streaming_mode**，
  不关则聊天栏卡在「[生成中...]」+ 卡片不能转发 + **卡片回调无法更新卡片（按钮变哑）**。
  完整约束见记忆 [[reference_feishu_card_streaming_and_layout]]。
- 客户端 <7.20 对 JSON 2.0 卡片显示兜底升级提示而 **API 仍返回 code=0**，
  服务端探测不到 → 只能真机观察 + 用开关兜底。

## 补授权自动化（v1.11.0）—— 机器人主动问，管理台只是兜底

**平台改了 `H_ADDONS`（加权限/加事件订阅）后不用再挨个点补授权**，机器人会自己问。

- **判定靠 `addonsRev`**：`H_ADDONS` 的内容哈希（`lib/feishu-register.mjs`）。
  授权成功时由 `onGranted` 写进用户记录，与当前 `H_ADDONS_REV` 不一致 = 待补。
  **用内容哈希不用手工版本号**——手工的一定会忘记升，而漏升的失败是静默的
  （新事件订阅不到就是"事件永远不来"，不报错不告警）。
  没有该字段的存量记录一律算待补，正是要找的那批人。
- **链路**：控制面 `/internal/upgrade-pending`（72h 冷却 + 同版最多 3 次，
  `UPGRADE_NOTIFY_COOLDOWN_MS` / `UPGRADE_NOTIFY_MAX`）→ bridge `pushUpgradeCards()`
  每小时 + 开机 30s 后一次（`H_UPGRADE_PUSH=0` 关）→ `upgrade-notified` 回报。
- ⚠️ **卡片按钮必须指向 `/au/<token>` 稳定入口，不能烤授权链接**：授权流是
  10 分钟的 device-grant，卡片会在聊天记录里躺几天。`/au` 在点击时现开流程再
  302；同 App 60 秒内复用（防连点堆出一串 5s 轮询循环）。token 就是 `/go` 那套
  免登 token，`/internal/autologin` 直接返回 `upgradeUrl`，**执行面别自己拼**。
- 管理台用户表有「待补授权」徽标 + 人数提示；补授权按钮保留作手动兜底。
- **真机已验（2026-07-26）**：手机飞书里**直接点卡片按钮即完成授权，不用扫码**。
- ⚠️ **验成功要认服务端状态，别只听用户说「点完了」**：该用户 `addonsRev` 应等于
  当前 rev、`upgradeConfirm`/`upgradeHint` 清空、pending 归零。写回失败时用户侧
  一样显示「授权成功」，但下一轮还会再打扰他一次。查
  `/srv/h-control/data/users.json` 这几个字段。
- ⚠️ 授权成功 ≠ 事件真的会来：`bot_p2p_chat_entered_v1` 要**真人打开一次会话**
  才触发。（2026-07-26 已验：授权后日志首次出现 `chat entered`，此前三天为零。）

## 授权类问答走网关代答（v1.12.0）—— 别让助手猜「授权」

**用户问「授权好了吗」不能交给助手**：它在 bwrap 沙箱里看不到控制面的用户记录，
而「授权」在本产品里被三方争用（平台补授权 / 订阅绑定 / lark-cli 登录），它只对
lark-cli 有工具 → 必然猜到那上面去。真机翻车过：跑 `lark-cli config init --new`，
甩出无关授权链接 + 挂两个等 stdin 的进程。

- `lib/command-probe.mjs` 的 `auth` 档：短命令词精确匹配（授权状态/补授权/…）
  **加**「整条消息 ≤20 字且含『授权』」；带 `lark|cli|skill|github` 字样的放行
  （那是真任务）。改这条必跑 `test/command-probe.test.mjs`。
- `handleAuthCommand()` 拿 `/internal/auth-status` 的真值出卡片，**不过 LLM**。
- 生效后 30s 内还会自动推一张「授权已生效」（`upgradeConfirm` → 推卡 → 清标记），
  只在"问过他/他本来是别的版本"时推，新用户不打扰。
- ⚠️ 交互式 CLI 在无人值守通道会挂死：`lark-cli config init --new` 等 stdin 永不
  退出。杀它记得用 `ps | grep '[l]ark-cli'` 括号法拿 PID，**禁 `pkill -f`**
  （pattern 会匹配到自己那条 ssh 命令行）。

## 沙箱凭据注入：token 不上命令行（v1.12.0 安全修复）

`--setenv XAI_API_KEY <token>` 会让令牌明文躺在 `/proc/<pid>/cmdline`，**本机任何
用户 `ps` 就能抄走**。已改走 bwrap `--args FD`（`lib/sandbox.mjs`
`buildSecretArgsPayload` + `SECRET_ARGS_FD=3`，grok-runner 用 stdio 第 4 槽喂）。

- 空载荷也**必须写并 `end()`**，否则 bwrap 读 fd 会一直阻塞。
- 改这块必跑 `node test/sandbox.test.mjs`（有回归闸：argv 与 env 白名单里都不许
  出现凭据形状的值）。
- 自检取证**只查值不查名**（查名会把 `$VAR` 引用算成命中，得出假结论）：
  ```bash
  ssh dev198 "ps -eo args | grep -c 'XAI_API_KEY '"   # 应为 0
  ```
- 上线前要验到「消费方认不认」：只证明 env 在沙箱里存在是不够的，必须用真实凭据
  跑一次真 grok（让它回两个字即可）。这一环没验就上线 = 全体用户 Not signed in。
- 自检：
  ```bash
  ssh aliyun-hk 'set -a; . /srv/h-control/.env; set +a; curl -s -H "Authorization: Bearer $SERVICE_TOKEN" http://127.0.0.1:18790/internal/upgrade-pending | python3 -m json.tool'
  ssh dev198 'journalctl --user -u feishu-grok-bridge --since "-2h" --no-pager | grep -i upgrade'
  ```
  `/au` 应 302 到 `open.feishu.cn/page/launcher?...&clientID=<用户App>&addons=...`
  —— **带 clientID 才是增量授权**（不新建 App）；没有 clientID 说明走成新建了，停下查。

## 存量用户补权限/事件（「补授权」，v1.9.0 手动入口，仍保留）

平台新增权限或事件订阅后，**存量用户不会自动获得**。管理台用户行「补授权」：
`POST /admin/api/register-upgrade {appId}` → 起 `clientID=<appId>` 模式的注册流 →
用户重扫确认权限 diff 即可，不用逐个进开发者后台发版审核。

- 只允许升级**本平台已托管**的 appId（否则成了给任意 App 索权的通用入口）。
- 升级流跳过 `onProvision`（账号已存在，重复开通是错的）；选错 App 直接拒；
  平台若不下发 secret 则沿用已存密文（**不能覆盖成空，那会把用户 Bot 弄哑**）。
- 新用户走注册链接的 `addons` 自动带上事件，无需此步。

## 管理台 + 热加载（P2，2026-07-24）

- **管理台** `ai.kidshub.cn/admin`（ADMIN_PASSWORD in 控制面 .env）：用户表(引擎/绑定/在线态)+激活/停用/切引擎+待关联 Bot 一键关联+签注册链接。**控制面 store = users 的 source of truth**。
- **B1 热加载**：bridge 5s 轮询 users.json mtime → 增删/切引擎 App 免重启（`hot-reload start/stop/restart engine` 日志）。owner 永不动。
- **A1 同步器**：bridge 15s 拉 `/internal/users` → 合并本地 users.json（控制面为准、保留本地独有 uid）→ B1 热加载。**管理台点一下 → ≤18s 自动生效**。
- 排障：切引擎/激活不生效 → 查 bridge `user-sync`/`hot-reload` 日志 + 控制面 store `active` 字段；`H_USER_SYNC=0` 退回 h-user 本地管理。
- **owner 零影响铁律**：热加载/同步器 `kind==='owner'` 全 skip，owner App 逐字节不变。

## 两个后台的界面结构（v1.10.0 起，改 html.mjs 前先读）

左栏 tab + 右侧内容（参照 multica dashboard 的 AppSidebar）。外壳组件在
`control-plane/lib/html.mjs`：`SHELL_CSS` / `shellTop` / `shellRail` / `shellPane` /
`shellTabJs`，`page(title, body, { shell: true })` 启用。

| 页面 | tab（顺序即默认） |
|------|------------------|
| `/admin` | overview 总览 / users 用户 / skills Skills / orgs 部门 |
| `/dashboard` | overview 总览（订阅+引擎） / memory 我的记忆 / profile 人格与规则 / skills Skills |

**硬约束（改之前必看）**：

1. **面板 id `pane-<tab>` 是对外契约**。飞书卡片深链 `/go/<token>?to=memory`
   → `/dashboard#memory`，`shellTabJs` 从 `location.hash` 点亮对应面板。
   服务端 `GO_SECTIONS = { memory:'#memory', skills:'#skills' }` 是**封闭白名单**，
   两边同时改才行。改名 = 线上按钮点了没反应。`test/pages.test.mjs` 锁住了这条。
2. **tab 状态必须留在 hash 上**（`history.replaceState`）。页面里大量操作走
   `location.reload()`，不留 hash 就会每次弹回第一个 tab。
3. **放表格的 grid 列一律 `minmax(0,1fr)`**（grid item 默认 `min-width:auto`，
   宽表格会把整页顶出横向滚动；移动端 override 最容易漏）。
4. **表格列宽别按 `nth-child` 配比**——插一列就错位，且 `display:none` 的列仍占宽。
   只给首列（名称，百分比）和末列（操作，px）定宽，中间自动平分；
   收窄用两档语义 class：`col-md-hide`（≤1180px）/ `col-sm-hide`（≤560px）。
5. **界面里不出现 emoji**，图标一律 `I.*` 内联 SVG（本文件开头的设计约定，
   记忆面板曾违反）。`test/pages.test.mjs` 有断言。
6. **Skills 归属**认 `createdBy`（skills-store 写入，`'admin'` 或 uid），
   **不能拿层级代替**——部门负责人也能往 org 层发布。存量记录无该字段时按层兜底。
   零计数的归属选项**保留并置灰**（`dim.keepEmpty`），隐藏会让人以为没这个筛选。

## 默认工作方法 / 方法论（v1.13.0）

**载体是两层，改一层要想另一层。**

| 层 | 位置 | 作用 |
|---|---|---|
| 正文 13KB | L0 skill `agent-method`，源码 `control-plane/builtin-skills/agent-method/SKILL.md` | 全套方法：目标→计划→切片→回读→自检 + 规则棘轮 + 记忆策略 + 预算熔断 |
| 摘要 787 字符 | `lib/memory-routing.mjs` 的 `<!-- h-method -->` 托管块 | 不可让渡的几条 + **指向 agent-method 的强制指针** |

- **为什么要摘要那层**：grok skill 是**按 description 匹配触发**的（README 原话
  "this is how Grok decides to invoke it"），不保证每轮加载；而工作方法要的是缺省
  行为。托管块进 AGENTS.md（全文入 system prompt）才每轮必生效。删了指针 = 正文
  可能永远不被加载。
- **AGENTS.md 每文件 10000 字符是静默截断**，超出吃掉的是**用户自己写在块外的规则**。
  `test/method-defaults.test.mjs` 锁死预算（<55%）与幂等，改摘要必跑。当前 1782/10000。
- 摘要与 skill 正文**是同一套话**，改一边要改另一边；界面上的方法卡（`methodCard()`
  in html.mjs）是第三处，一共三处要对齐。
- 托管块 marker 必须同时出现在两个地方：`memory-routing.mjs`（定义 + 自愈写入）
  和 `lib/profile-files.mjs` 的 `MANAGED_MARKERS`（「恢复默认」时保住它）。
- 用户覆盖路径：`SOUL.md` / `~/.grok/AGENTS.md` / `~/workspace/AGENTS.md`，
  **用户写的永远压过平台默认**——方法卡上这句话不能删，否则用户以为改不动。

## L0 平台层脱敏（v1.13.0，往共享层放东西前必读）

L0 是**所有租户都挂得到**的。往那儿放 owner 自己的 skill = 直接对全体租户开放。

- 迁移/清理工具：`control-plane/scripts/migrate-l0-desensitize.mjs`，**词表外置**
  `scrub-terms.local.json`（gitignore）——「要替换掉哪些真名和内部域名」这份清单
  本身就是敏感数据，进仓等于发布它。抄 `scrub-terms.example.json` 填。
- 三分法：骨架通用只是样例带内部信息 → 脱敏；**绑定特定表/字段/组织流程 → 下架**
  （泛化等于重写，泛化后没那张表对租户就是空指导）；**含他人姓名/open_id → 必须
  下架**，不是"脱敏"的选项。
- 验收扫描按**整类**内部标识（域名 / 人 / 部门 / 可写资源 id），不是按已知命中
  ——盯着已知命中会变成打地鼠。当前 7 类 × 29 个 skill 零残留。
- 改 L0 后必做：① 控制面 `systemctl restart h-control`（**跑着的进程内存里是旧的，
  下次写盘会把你的改动盖掉**）；② 等执行面 60s 同步（`SKILLS_SYNC_INTERVAL_MS`）；
  ③ 复扫 `/srv/h-platform/shared/skills/`；④ 核对 owner 的 `~/.grok/skills` 没被动
  （两套目录，owner 零影响是铁律）。
- 直接改 store 用 `sudo -u h-control node`，**别用 root**——root 写出来的文件
  服务自己改不动。

## Skills 正文白盒（v1.13.0）

- `GET /api/skill-content?key=`（用户面）/ `/admin/api/skill-content`（管理台）。
- 可见性**服务端判**：只放行 platform / 本部门 org / 自己 user 三层，越界 403。
  验这个分支必须造一条**真实存在但不该看见**的 skill —— 用不存在的 key 测只会走
  404 那条早退分支，等于没验授权。
- 正文用 `textContent` 渲染，不用 innerHTML（skill 正文是任意 markdown）。
- `workspace/BEHAVIORAL_RULES.md` 已进 `PROFILE_FILES`（共 4 项）：棘轮的**产物**
  也要可见，否则「方法可见、方法产生了什么不可见」白盒只做一半。加减注册表项
  会被 `method-defaults.test.mjs` 的数量断言拦住，提醒同步确认前端 tab。

## 分层 skills（L2 个人 / L1 org / L0 平台）

- 沙箱内 grok config skills paths 三层：`~/.grok/skills`(L2 个人) → `/shared/skills`(L0 平台) → `/org/skills`(L1 组织)。
- **org 层**：user 加 `org` 字段（users.json/store）→ 沙箱挂 `/srv/h-platform/orgs/<org>` → `/org`。org 目录由 admin 建：`mkdir -p /srv/h-platform/orgs/<org>/skills/<skill>`。`--ro-bind-try` 目录未建时跳过不崩。
- 同名 skill 优先级：L2 个人 > L0 平台 >（config paths 顺序，L1 org 追加在后）。

## Skills 市场（D2+4567+market-v2，2026-07-24/25）

- **入口（multica 模式，双端同构）**：管理台与用户 dashboard 均为「全宽表格 + 右上『添加』弹层」，弹层四 tab：**搜索市场**（多源：ClaudeSkills + Skills.sh）/ **链接导入**（贴 URL，来源卡实时高亮，name 自动取）/ **手动创建**（自己写 SKILL.md 正文，无 frontmatter 自动补）/ **本地导入**（选或拖 .md 文件，浏览器读文本后提交内容）。6 张来源卡**常驻所有 tab**：GitHub / Skills.sh / ClaudeSkills（可直接搜）/ ClawHub / LobeHub（仅浏览）/ 直链。管理台层选 L0/L1；用户侧固定装自己 L2（服务端强制）。
- **多源搜索**：ClaudeSkills.info `/api/skills`（每条带 repo_url=GitHub tree，**零扩展白名单**可直装 + stars 排序）+ skills.sh `/api/search`；`Promise.allSettled` 单源失败不拖垮另一源，结果交替排列，失败源前端提示。选型教训 → [[feedback_thirdparty_hub_integration_probe_first]]
- **中文功能简介**：`parseFrontmatter` 提 description；`summaryZh` 管理台「简介」按钮可编辑；显示优先级 summaryZh > description 截断 > 「暂无简介」。名称下常驻显示。
- **手动创建/本地导入**：与 URL 安装共用 `intake()` 单一安全门（危险扫描/大小/名称/配额/层校验一处不漏），前端内容直传不经网络。
- **URL 来源家族**：`github.com/o/r`（bare，**多 SKILL.md 报错列出不猜**）/ `…/tree/分支/目录` / `…/blob/…/SKILL.md` / `skills.sh/o/r/skill` / raw 直链——全部归一 raw URL 过安全门，白名单零扩展。origin 入库列表显示来源。
- **市场解析**：候选路径直探 → GitHub tree API fallback（非标准仓）。
- **层模型**（展示名 2026-07-25 定）：**系统全局层** L0 platform（全局 name 键）/ **公司部门层** L1 org:<org>（**双审批** pending→批准）/ **个人层** L2 user:<uid>（**复合键** `user:<uid>/<name>` 跨用户同名不冲突；越权删他层 403；上限 **50**；落 `<usersRoot>/<uid>/.grok/skills/`，grok 生效 kimi 无 skills 机制）。底层值仍是 platform/org:/user:，只改展示名。
- **共享 fork**：dashboard 共享列表「复制到我的」→ L2 副本（头部插来源注释），可见性校验只能复制系统全局层或本人部门层。
- **XSS 铁律**：市场搜索结果（skills.sh 外部数据）客户端渲染**必须 DOM API+textContent+dataset**，禁字符串拼 innerHTML/onclick（[[feedback_client_render_external_data_dom_xss]]）。UI 大改跑三视角对抗审查 workflow。
- **org 管理**：用户表 org 列行内编辑（正则 `[a-z0-9-]`，空=移出）；org 变更 → 同步 → **热加载重启该 App**（换 /org 挂载）；组织面板自动聚合。
- **双端页面结构**（桌面优先，2026-07-25 定）：顶栏 → 指标条 → 面板双栏 → **全宽 Skills 表**。用户页与管理台同构（宽版 1180px，≤820px 塌单列）；用户页把「我的」与「共享」合并成一张表，用「归属」列区分。
- **skillsTable 组件**（双端共用）：搜索（名称+简介）+ 多维筛选 chip（每维单选，**计数取自未筛选全集**）+「n / total」收窄提示 + 清空 + **10 条/页**分页。维度：管理台=层级/来源/状态；用户页=归属/层级/状态。窄屏隐藏来源·大小列（`col-sm-hide`）。
- **「已被覆盖」态**：用户有同名个人副本时，共享版标注已被覆盖并禁用复制（沙箱 L2 优先）。
- **安全门（控制面下载+扫描+存内容，执行面免出网）**：①来源白名单 `raw.githubusercontent.com`（https + **禁重定向** + 仅 .md）②大小 ≤100KB ③危险模式扫描 13 类（rm -rf、管道执行、fork 炸弹、`/etc/passwd`、`XAI_API_KEY`、`.ssh` 等），命中即拒并显示原因。**宁误杀勿放行**，误杀由 admin 人工判断换源。
- **同步**：bridge 60s 拉 `/internal/skills` 元数据 → sha 差异才拉正文（`/internal/skill/<name>` 单数前缀防路由冲突）→ **装前复扫**（纵深防御）→ 原子落 `shared/skills/<name>/SKILL.md`（L0）或 `orgs/<org>/skills/<name>/`（L1）→ 回报 → 管理台显示「✓已下发」。`H_SKILLS_SYNC=0` 可关。
- **manifest 隔离**：`/srv/h-platform/.skills-manifest.json` 只记同步器自己装的；删除只删 manifest 内目录，**admin 手放的 skill 永不误删**。
- 排障：待同步不变 ✓ → 查 bridge `skills-sync`/`skill installed` 日志；`install fail sha mismatch` = 控制面内容变更中，下轮自愈。

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
# 控制面改了 html.mjs 必跑：script 块语法 + 面板 id 契约 + 归属筛选，已固化成测试
# （模板字符串会吃掉 \n，导致 JS 字面量断行 → 整块静默不执行，console 无报错）
ssh dev198 'cd ~/feishu-grok-bridge/control-plane && export PATH=$HOME/.local/node/bin:$PATH && node --test test/pages.test.mjs'
# ⚠️ dev198 非交互 ssh 的 PATH 里**没有 node**，不加绝对路径会「命令未找到」而静默跳过检查
ssh dev198 'cd ~/feishu-grok-bridge && export PATH=$HOME/.local/node/bin:$PATH && for f in bridge.mjs lib/*.mjs; do node --check $f; done'
# 全量单测（改了命令词/卡片/流式/沙箱必跑；注意用 test/*.test.mjs，传目录 node 会报模块找不到）
ssh dev198 'cd ~/feishu-grok-bridge && export PATH=$HOME/.local/node/bin:$PATH && node --test test/*.test.mjs 2>&1 | tail -5'
ssh dev198 'cd ~/feishu-grok-bridge/control-plane && export PATH=$HOME/.local/node/bin:$PATH && node --test test/*.test.mjs 2>&1 | tail -5'
# 改了方法论摘要 / profile 注册表必跑：AGENTS.md 预算 + 托管块幂等 + 注册表项数
ssh dev198 'cd ~/feishu-grok-bridge && export PATH=$HOME/.local/node/bin:$PATH && node test/method-defaults.test.mjs'
ssh dev198 'curl -sS http://127.0.0.1:18765/healthz | python3 -m json.tool'      # connected:true
curl -s --noproxy '*' https://ai.kidshub.cn/healthz    # 公网即可核对线上 version（v1.9.0 起 healthz 带 version）
```

## 记忆通道（v1.9.x，2026-07-26）

用户后台「项目记忆/全局记忆」若是英文空壳 → 引擎脚手架模板没被真内容替换。三条链路：

1. **播种** `lib/memory-seed.mjs`：中文骨架 + 历史回填，接在沙箱开通流程里，幂等。
   `looksUnseeded` 是红线（判错即覆盖真实记忆且不可逆），改它必跑 `test/memory-seed.test.mjs`。
2. **助手主动写**：`.grok/AGENTS.md` 的 `ai-memory` 托管块（**我们自己的中文版**，
   不是上游那段）。上游英文块声称"hooks 已自动捕获、别手动写"，**沙箱里没有 hooks**，
   照抄等于命令助手别写记忆。改法：沿用上游 marker、正文换我们的（幂等替换仍成立）。
3. **网关兜底捕获** `lib/memory-capture.mjs`：每轮任务后网关自己判一次。
   指令是概率性的、hooks 是确定性的，两条并存互为冗余。

四道门的顺序不能乱（踩过）：
- **隐私门必须第一个判**，排在长度门之前 —— 20 字的他人 HR 请求曾被 `too-short`
  提前返回而绕过隐私判定，**短≠安全**。
- `classifyHr` 返回的是**命中词数组**不是 `{hit}`，写成 `.hit` 恒 undefined、门形同虚设。
- 中文字数阈值别用英文直觉：`MIN_CHARS=24` 曾把「以后都要…」(10字)、
  「这事就定成这样吧…」(20字) 全挡在判断之外。现为 8 + 信号词短路（以后/都要/
  就定/记住/约定/待办…命中则无视长度）。
- 去重按**输入**哈希，不能只按 LLM 产出（每次措辞有差异）。

排障：
```bash
# 记忆文件真实状态（英文模板 = 还没播种）
ssh dev198 'find /srv/h-platform/memory/<uid>/wiki -name MEMORY.md -exec ls -la {} \;'
# 捕获是否触发（看 memory captured / privacy gate / too-short）
ssh dev198 'journalctl --user -u feishu-grok-bridge --since "-30min" --no-pager | grep -i "memory captur\|privacy"'
# MCP 通道自检（注意 Accept 必须同时带 json 和 event-stream，否则 406）
ssh dev198 'T=$(cat /srv/h-platform/memory/<uid>/auth.token); curl -s -X POST http://127.0.0.1:<port>/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $T" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_recent\",\"arguments\":{\"workspace\":\"default\",\"project\":\"main\",\"limit\":5}}}"'
```

⚠️ **对生产数据做写入型自测前先想好回滚**：曾把测试用例编的内容写进川哥真实记忆，
事后清理。更好的做法是用独立测试 uid。

⚠️ 遗留：同义不同措辞仍会重复入库（相似度用精确包含）。

## 关键文件与记忆

- 项目记忆 [[project_feishu_grok_h_byos]]（拍板/账号三层/分层/验收协议全量）
- 控制面源码 `dev198:~/feishu-grok-bridge/control-plane/`（部署到 aliyun-hk `/srv/h-control/app/`）
- 通道 SOP `mycc/4-Assets/SOP/dev198-feishu-grok-channel.md`
- P2 全收 + 4567 全收（市场搜索/org UI/用户 dashboard/L1 双审批/UI 重设计）
- v1.4.0（2026-07-25）：通用开通链接（管理员零填写）+ union_id 身份接力（真名自动）+ 权限授权卡片 + 一键开后台按钮 + 版本号
- 余：Ryan 开通（等扫码，含 kimi 首次真订阅 E2E）；ClawHub 暂缓（需扩白名单不值当）
