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
7. **推代码前查实时分支**：历史上部署主干曾在 `origin/feishu-grok-bridge`，但 2026-07-27 已确认 GitHub 当前生产主干是 `origin/main`，旧分支落后。每次先跑 `git fetch origin && git rev-list --left-right --count HEAD...origin/main`，不要把历史记忆当现状。
8. **健康读数认实例**：bridge `/health` 的**顶层字段是 owner Bot 的**，用户 Bot 在 `apps.<appId>` 里。查「某用户的消息到没到」必须看 `apps` 分解——2026-07-25 我拿顶层 `lastInboundAt:null` 断言「一条没收到」，实际用户 Bot 那条准时到了（[[feedback_selfcheck_false_signal]]）。
9. **远程语法检查用绝对路径**：dev198 非交互 ssh 的 PATH 没有 node，`node --check` 会「命令未找到」而静默略过；结论行必须由累计变量驱动，绝不无条件 `echo 全过`。
10. **Kimi 通道名不能混**：开放平台模型是 `kimi-k3`；Kimi Code 订阅的 CLI alias 是 `kimi-code/k3`，其 provider model 是 `k3`。桥接层必须使用订阅命名，不能把开放平台名字直接塞进 managed provider。
11. **锁模型而非信默认值**：Kimi 配置生成和 Runner 必须共用 `lib/kimi-model.mjs`；Runner 每次显式传 `--model kimi-code/k3`。只改 `default_model` 不算完成。
12. **真任务归因到真引擎**：用户要求“由 Kimi 完成”时，Codex/cc 只做编排、权限、送达和验收；业务结论必须来自真实 `createKimiRunner`。验收证据同时看 trace 的 `engine/model/providerModel`、真实回复和飞书 message_id。
13. **验收必须由 Bot 主动闭环**：修复、补权限、换模型或恢复凭据后，运维方必须直接用目标用户的真实 Runner 发起任务，并由目标 Bot 主动把结果送到目标 open_id；禁止把“请用户再发一次测试”当验收步骤。若权限不足，禁止只发文字报错，必须主动发送带“去开通权限”按钮的权限申请卡；只有外部平台明确要求用户本人确认、扫码或不可代理授权时，才让用户完成该动作。授权完成后仍由 Bot 自动续跑、主动汇报，不要求用户再发消息。验收证据至少包含真实 trace 与飞书 message_id。
14. **macOS 部署禁 AppleDouble**：从 Mac 用 tar 向 Linux 发文件会夹带 `._*`；优先 `COPYFILE_DISABLE=1 tar`、`rsync` 或部署后精确清理 `._*`，禁止把这些杂物留进生产 Git 状态。
15. **飞书接口先查官方文档**：管理台常驻 `https://open.feishu.cn/document/home/index`。Bot 对接口、字段、scope 或参数不确定时，优先用用户身份执行 `lark-cli schema <service.resource.method> --as user`；无 typed command 再查官方文档对应板块，并用 `lark-cli api ... --as user --dry-run` 核对。遇到缺权必须保留官方 scope/link，由网关主动发权限申请卡；授权后自动续跑，禁止要求用户重发。
16. **授权链接只认官方精确地址**：`lark-cli` device-flow 需同时兼容旧 `https://open.feishu.cn/page/cli` 与新版 `https://accounts.feishu.cn/oauth/v1/device/verify`，以及对应 Lark 域名；校验必须限定 HTTPS、官方 hostname 和精确 pathname，禁止用宽泛正则放行任意相似域名。
17. **短效授权要在用户活跃时现开**：device-flow 实测约 600 秒，无人时提前生成只会留下过期卡。延迟补发的真实语义是“到达 notBefore **并且** 用户下一次单聊入站”，不是“到点立即执行”；现有 F3 调度器只有时间条件，不能冒充事件门。一次性运维可用持久 timer 在 notBefore 后挂只读入站监听，命中目标用户后再创建新授权流；用户标识只留生产机，不入 Git、共享记忆或通用 Skill。

## 架构

- **执行面** dev198 `~/feishu-grok-bridge`（main=生产多 App 版，不暴露公网）：bridge WS 出站连飞书；per-user grok/kimi 跑 bwrap 沙箱。
- **控制面** aliyun-hk `/srv/h-control`（systemd `h-control`，nginx `ai.kidshub.cn`→127.0.0.1:18790）：dashboard/BYOS OAuth/vault/token-manager。
- **引擎出网**：grok 走本机 xray `127.0.0.1:10808`；**kimi 直连**（沙箱挂 `/run/systemd/resolve` 修 DNS）。
- **凭据注入**：grok 用 `XAI_API_KEY`（**非** auth.json，grok 校验 refresh 非空+profile 字段不认）；kimi 每次任务前同步最新 access token，并重写 `config.toml` managed provider（api_key 模式）。

## Kimi Code K3 契约与验收（2026-07-27）

| 层 | 正确值 | 常见误用 |
|---|---|---|
| Kimi 开放平台 API | `kimi-k3` | 把它直接用于订阅 endpoint |
| Kimi Code CLI alias | `kimi-code/k3` | 继续沿用 `kimi-code/kimi-for-coding` |
| managed provider model | `k3` | `kimi-for-coding` |
| endpoint | `https://api.kimi.com/coding/v1` | 与开放平台 endpoint 混用 |
| context | `1048576` | 沿用旧 `262144` |

排障顺序固定：

1. 查官方文档当天状态，再查生产 `kimi --version` / `kimi --help` 是否支持 `--model`。
2. 查 `<userRoot>/.kimi-code/config.toml`，只输出模型/endpoint 字段，禁止输出 `api_key`。
3. 真实任务前必须走 `syncCredentials`；手工拿磁盘旧 token 直打出现 401，只能说明“这份 token 不可用”，不能说明 K3 不可用。
4. 用真实 sandbox `createKimiRunner` 发无工具短请求；日志必须出现 `model=kimi-code/k3 provider_model=k3`。
5. 查用户 trace：`task_begin.engine=kimi`、`model=kimi-code/k3`、`providerModel=k3`，且 `task_end.ok=true`。
6. 最后一跳用目标 Bot 主动发给目标 open_id，拿真实 message_id；只看到 Kimi stdout 不算飞书可用。禁止让用户重发消息代替这一步。

### Kimi 15 分钟 access token 陷阱（2026-07-27 真机）

- Kimi OAuth 实测 `expires_in=900`（15 分钟），控制面又按客户端语义预扣 5 分钟；旧版默认每 20 分钟 sweep 一次，**刷新周期长于 token 生命周期，必然出现 401 空窗**。
- `/internal/creds/<uid>` 在每次 Kimi 任务启动前按需保鲜：token 年龄超过 2 分钟或已过期就刷新；同一 person 的并发刷新必须用单飞锁合并，避免重复 rotation。
- Kimi Runner 不持有 refresh token，无法在进程内续期；单次墙钟预算必须封顶 12 分钟，为 15 分钟 access token 留出网络与收尾余量。Grok 不受这个上限影响。
- refresh 被撤销时立刻标 `needRebind`，不得继续把 vault 里的旧 access 下发；普通刷新故障返回 503，不用旧 token 冒充可用。
- `health.apps.<appId>.lastError` 是“最近未恢复错误”，成功送达后必须清零；只更新 `lastOutboundOkAt` 会让控制台永久挂着历史 401。
- 验收至少含：①控制面日志出现 `token-manager kimi refreshed <person> on-demand`；②真实 Runner 的 K3 trace 成功；③目标 App `lastOutboundOkAt` 更新且 `lastError=null`。

健康端口以生产日志为真，当前是 `127.0.0.1:18765`。不要猜 `3000/18080`；先查 `journalctl` 的 `health server` 行。

部署 bridge 代码时只传明确文件，并先备份；生产 `workspace/PROMPT.md`、`workspace/evolve/*` 等运行态脏文件必须保留。Mac → Linux 示例：

```bash
COPYFILE_DISABLE=1 tar -cf - lib/control-client.mjs lib/kimi-runner.mjs lib/kimi-model.mjs lib/trace.mjs test/kimi-k3.test.mjs package.json README.md \
  | ssh dev198 'cd ~/feishu-grok-bridge && tar -xf -'
ssh dev198 'find ~/feishu-grok-bridge -maxdepth 3 -type f -name "._*" -print -delete'
```

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

## 账号唯一键是 appId，不是 uid（v1.13.4）

同一个 Bot 重扫（补授权 / 再走一次开通）**必须合并进既有账号**，不能新增。

- `uid` 可能是管理员当初在链接里**预分配**的（如 `rayman.chen`），也可能是通用
  链接按飞书身份**派生**的（`u-<hash>`）—— 对同一个 App 这两者**不相等**。
  只按 uid 判重，就会凭空多出一个空账号（同 appId、同 openId、无用量无绑定）。
- `onProvision` 先 `store.list().find(x => x.appId === appId)`，找到就复用它的 uid。
- **合并写回不许降级**：`upsert` 跳过 `undefined` 但**会写入 `null`**。本轮通讯录
  没读到时给 `null` 会把已有部门清掉 —— 降级项一律给 `undefined`。
  已是真名的记录也不许被 Bot 名 / `nameSource='bot'` 覆盖回去。
- 清重复账号前先校验「appId + openId 同源，且无用量、无订阅绑定」，并备份
  `users.json`。删账号不可逆。
- 改这块必跑 `node --test test/provision-merge.test.mjs`。

⚠️ **放宽入口时的通用检查**：v1.13.1 放开「选择已有应用」后才撞出这个洞——
旧路径下 uid 与 appId 恒同源，反向校验永远用不上。**放宽任何入口，都要把它
现在能到达的状态列一遍，逐条问「原来是靠什么拦住的」**；被绕过的常常不是显式
校验，而是「旧路径下这种情况不可能发生」这个隐含前提。

## 新 Bot 预置了哪些权限与事件（addons，v1.13.3）

`control-plane/lib/feishu-register.mjs` 的 `H_ADDONS` —— **用户扫码确认那一下**
就把这些给了，不用事后补：

```js
scopes: { tenant/user: ['contact:user.base:readonly'] }   // 姓名 + 部门字段
events: { items: { tenant: ['im.chat.access_event.bot_p2p_chat_entered_v1'] } }
```

- **只放已被飞书官方报文验证过的标识串。** `contact:user.base:readonly` 是飞书
  自己在权限错误里给出的（`buildApplyUrl` 用的同一个）。猜错一个串可能让整个
  addons blob 被落地页拒掉，坏的是**整条开通流程** —— 代价远大于少要一个权限。
- **改了 addons 就不用管"谁要重扫"**：`addonsRev` 是内容哈希，一变，存量用户
  自动在管理台标「待补授权」、bot 也会主动推卡片。
- ⚠️ **部门不在 addons 覆盖范围**：它要「通讯录数据范围」（数据权限，不是 API
  scope，管的是应用能看见哪些部门），得去开发者后台放开。实测新 Bot 能读姓名、
  读不到部门（`reason=no_dept`）。
- 改前先跑 `node --test test/pages.test.mjs`（有一条断言盯着 scopes 不许被删回去），
  改后离线验证编码往返：`encodeAddons` → gunzip → JSON 应与原对象全等。
- **别假设"老 Bot 权限更全"**：实测第一个 Bot 反而 `no_field` 读不到，后建的能读。
  要知道某个 Bot 的实际能力，拿它的凭据真调一次 `readIdentityViaTenant`。

## 用户姓名 / 部门为什么是错的（v1.13.2，排障先读这段）

**大概率不是坏了，是中间态。** 开通那一刻新 App 通常还没有通讯录权限
（`readIdentityViaTenant` 返回 `reason: 'no_field'`），所以：

1. `name` 先用 **Bot 名**兜底，`org` 为 null，写下 `permHint`
2. 执行面的**目录机器人**靠 `union_id` 查到真名 → POST `/internal/identity` →
   姓名与部门自动补上。**真机实测约 16 分钟。**

判断是谁写的：`realName` 字段**只有** `/internal/identity` 会写。
`nameSource==='directory'` 是 v1.13.2 起的新标记。两者任一为真 = 已是真人姓名。

⚠️ 别误判成用户 OAuth 那条路：`/feishu/authz` 需要 `H_FEISHU_AUTHZ=1`，
生产 `.env` **没配**，那条是关着的。

**先分清是"数据错"还是"没展示"：** 用户报「没识别出我的信息」时，先看记录里
`name`/`orgLabel` 是不是已经对了。v1.13.3 之前用户后台侧栏只有 uid + appId 两串
哈希、从不显示姓名 —— 数据全对，用户照样觉得系统没认出他。

**什么时候才是真出问题：**

- 超过半小时还是 Bot 名（管理台会标「· 待识别」）→ 查目录机器人；
  再不行点管理台的「待认领 · 去开权限」开 `contact:user.base:readonly`
- `uid` 是 `u-<hash>` 形态**不是问题**：通用开通链接就是按飞书身份确定性派生的，
  只有管理员在链接里预分配过 uid 才会是可读账号名

**改这块判定时的雷：** 存量记录只有 `realName`、没有 `nameSource`，
判定漏了它就会把**已经正确**的姓名重新标成"机器人名"（v1.13.2 第一版就这么错的，
`test/identity-name.test.mjs` 锁住了）。改判定前先列全"真值可能从哪些历史路径写进来"。

## 开通链接：能不能选存量飞书 App（v1.13.1）

二维码上的 `createOnly=true` 会让飞书落地页**隐藏「选择已有应用」**（v1.9.0
`d449d45` 加的防护：防用户误选自己别的 App 被本流程 addons 覆盖）。

- **默认只能新建。** 要把一个平台还不认识的存量 Bot 接进来 → 管理台「开通新用户」
  弹层勾「允许选择已有的飞书应用」。代价要讲给用户：**被选中应用的权限与事件订阅
  会被平台配置覆盖**，别选到他在用的其它应用上。
- 开关**签在 register token 里**（`x=1`），不是前端字段——改请求体绕不过。
- `register-upgrade`（带 appId）**不能**用来接入新 App：它要求 appId 已在
  botStore 托管，只用于给已托管 Bot 补权限/事件。
- 三条路的落地页行为：默认开通 `createOnly=true` 只能新建 / 勾选后无该参数可选已有 /
  补授权带 `clientID=cli_xxx` 强制 `createOnly=false`。createOnly 与 appId 互斥，
  同时传会抛错（别指望落地页兜）。
- **离线复现链接参数**（不用真调飞书）：`buildQrUrl` 是纯函数，但必须连同
  `registerBegin` 里 `createOnly: wantAppId ? false : opts.createOnly !== false`
  一起复刻——直接喂 `buildQrUrl` 会跳过这层默认值计算，得出反向结论。
- **验收分层，别笼统说"已验证"**：① 参数计算 → 纯函数离线验；② 飞书真实返回的
  二维码 URL 有没有 `createOnly` → 真起一条 `/register/api/start` 流验；
  ③ 落地页真渲染出「选择已有应用」且能选到 → **必须真人扫码，cc 够不到**，
  交棒时说清"看到什么算过"。2026-07-26 三层已全部通过（③ 由川哥真机确认）。

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

> 涉及真人操作的功能（扫码 / 手机点卡片 / 落地页渲染），cc 验到**服务端产出**为止
> （参数、URL、日志、DB 状态），最后一厘米交给川哥真机确认——交棒时写明"看到什么
> 现象算过"。别笼统写"已验证"，那会在将来排障时把人带偏。

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
# 改注册流 / session token 必跑：默认只能新建 + 开关签在 token 里 + 伪造 token 被拒
ssh dev198 'cd ~/feishu-grok-bridge/control-plane && export PATH=$HOME/.local/node/bin:$PATH && node --test test/register-link.test.mjs'
# 改显示名/身份回填判定必跑：兜底名要判成待补 + 存量 realName 不能被误标
ssh dev198 'cd ~/feishu-grok-bridge/control-plane && export PATH=$HOME/.local/node/bin:$PATH && node --test test/identity-name.test.mjs'
# 改开通/合并逻辑必跑：同 appId 要合并、合并不许把真名部门用量覆盖没
ssh dev198 'cd ~/feishu-grok-bridge/control-plane && export PATH=$HOME/.local/node/bin:$PATH && node --test test/provision-merge.test.mjs'
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

## 记忆的语义索引：向量只对新建页算（v1.13.5-6，排障必读）

**症状**：用户说「它没记住我说的话」，但记忆条目在后台看得见、内容也对。
**根因**：ai-memory 只在**新建页**时算向量。页面被重写时它新插一行
`is_latest=1`，向量仍挂在被 `supersedes` 的旧行上、**不重算**。而 memory-sync
是整页覆盖写入 —— 同步越勤，能被语义检索到的记忆越少。
中文 FTS 走 unicode61 会把整段中文压成一个 token，**向量是中文唯一可靠的
检索腿**，所以这等于核心功能静默失效，且界面上看不出来。

**查真值**（别看 `page_embeddings` 总条数，那是假象；要按 `is_latest=1` 算）：

```bash
ssh dev198 'python3 -c "
import sqlite3
db=\"/srv/h-platform/memory/<uid>/db/memory.sqlite\"
c=sqlite3.connect(\"file:%s?mode=ro\"%db, uri=True)
t=c.execute(\"select count(*) from pages where is_latest=1\").fetchone()[0]
w=c.execute(\"select count(*) from pages p where p.is_latest=1 and exists(select 1 from page_embeddings e where e.page_id=p.id)\").fetchone()[0]
print(\"有效页\",t,\"有向量\",w,\"缺\",t-w)"'
```

**手动补**（memory-sync 现在每次同步收尾会自动跑；手动补用这条）：

```bash
ssh dev198 'bash -lc "D=/srv/h-platform/memory/<uid>
export AI_MEMORY_SERVER_URL=http://127.0.0.1:\$(grep -oE \"127.0.0.1:[0-9]+\" \$D/config.toml | head -1 | cut -d: -f2)
export AI_MEMORY_SERVER_URL=http://\$(grep -oE \"127.0.0.1:[0-9]+\" \$D/config.toml | head -1)
export AI_MEMORY_AUTH_TOKEN=\$(cat \$D/auth.token)
~/.local/bin/ai-memory embed --data-dir \$D --workspace default --project main"'
```

⚠️ **三个条件缺一必失败**：
1. `AI_MEMORY_SERVER_URL` —— **不在 `--help` 里**，缺了必 401。CLI 永远代理到
   一个 HTTP 地址，客户端那半不从 `--data-dir`/config 推导服务地址。
   （曾为此试错五轮：设 AUTH_TOKEN / 停服务 / 不设变量 / config 加 auth_token /
   起临时无认证实例，全部 401，连只读的 `status` 子命令都一样。）
2. `AI_MEMORY_AUTH_TOKEN` —— `<data-dir>/auth.token`
3. 显式 `--workspace default --project main` —— 省略时它从 **cwd / git 仓名**
   推导，与钉死的作用域对不上（历史上因此 404）

**验收别只看表里有行**：拿一个与原文零逐字重合的中文问法跑 `memory_query`，
返回里 `rank` 是 RRF 签名（如 -0.0164）才说明走的是向量腿。

## 反向隧道探针（v1.13.7）

dev198 的 frpc 曾**静默失联两天**：`systemctl is-active` 是 active、进程在跑、
日志停在「start proxy success」后一片空白 —— 没有断连记录、没报错、没重连。
只影响运维通道（bridge 是出站连接，Bot 照常工作）→ **永远不会有人报障**。

- 现状：控制面每 5 分钟探一次 `127.0.0.1:22198`，`healthz` 与
  `/internal/tunnel-status` 都暴露。连续 3 次失败才翻状态（防抖动误报）。
- **判活必须等到 `SSH-` banner**：frps 后端没客户端时照样 accept 再立刻关，
  只看 connect 成功会一路报绿 —— 那正是这次能藏两天的形态。
- 隧道断了怎么办：`ssh -t dev198-jump 'sudo systemctl restart frpc'`
  （`-t` 分配伪终端，否则 sudo 报 "a terminal is required"；密码是 dev198 上
  chuan 的密码，cc 不碰）。
- **备用路由**：`dev198-jump` 经 mini-pub 走内网，隧道断时功能等价，
  排查隧道本身要用它。

## 白盒三件套（v1.13.8 → v1.14.0）

定位是川哥定的：**「白盒是为了你出 bug 的时候我能发现」** —— 受众是运维者
与用户本人，不是教育租户。所以**静态机制说明书不做**（它出 bug 时不会变，
还会随引擎升级静默过期）。

| 入口 | 看什么 |
|---|---|
| 管理台用户表「上下文」按钮 | 引擎版本 / 各配置文件字符数 / 四个托管块在不在 / skills 三层真读结果 / 记忆通道 / 最近 8 次任务原始数值 |
| 用户后台「它怎么工作」tab | 同上但说人话，且**服务端剥掉** `engine.bin` 等内部路径 |

- 数据链路：执行面 `buildContextReport` → `POST /internal/context-report`
  → 控制面按 uid 落盘 → `/admin/api/context`（admin 会话）与 `/api/context`
  （用户会话，**无 uid 参数位**）。
- 任务轨迹是**只读**的：读引擎自己写的 `<沙箱>/.grok/logs/unified.jsonl`，
  不在执行路径埋点。引擎不写了就退化成「没有数据」，主流程零影响。
- ⚠️ 该日志的 `ctx.output_preview` **带最长 200 字符的模型输出正文** ——
  取字段必须白名单，不能黑名单排除。

## 引擎行为：三处「我们一直说错的话」（v1.13.5 对着源码核出来）

开源仓 `xai-org/grok-build`，harness 主体在 `crates/codegen/xai-grok-agent/`
（目录名是「代码生成 agent」，不是「自动生成的代码」）：

1. **AGENTS.md 不进 system prompt** —— 包成 `<system-reminder>` 的合成 user
   消息插在对话首部。
2. **「每文件 10000 字符硬上限」源码里找不到** —— 收集路径上没有任何截断
   逻辑，反有回归测试断言正文不得被截断；全仓唯一的 10_000 是 git status 的
   上限。该说法出自 README。我们的体积纪律保留但已降级为**自定预算**。
3. **「更深的文件优先」只有排序，没有覆盖逻辑** —— 真正的「谁压过谁」是提示词
   里的一句话，**是给模型的建议不是系统保证**。对外文案禁用「以这份为准」
   这类确定性措辞。
4. skills 优先级：`config.paths` 的档位**低于** `~/.grok/skills`（User 档），
   而 L2 目录正是它 —— sandbox.mjs 老注释写的「paths 里排第一」结论对但理由错。

⚠️ **边界**：开源仓 `SOURCE_REV` 与线上二进制 rev **不同**（线上 0.2.112）。
源码解释得了机制，保证不了「线上这个二进制逐行如此」。

## 部署前必做：验「远端 ↔ 线上」同源（血的教训）

**git 远端不是线上真相**，两个漂移方向都存在且都不报错。曾出现
**仓库 v1.13.0 / 线上 v1.13.4** —— 四个提交在 dev198 本地 commit 了从没 push，
照仓库部署会静默回滚生产改动，而且测试还会全绿。

```bash
# 三行核对，缺一不可
ssh aliyun-hk 'grep -oE "v[0-9.]+" /srv/h-control/app/lib/version.mjs | head -1'   # 线上控制面
grep -oE 'v[0-9.]+' control-plane/lib/version.mjs | head -1                        # 仓库
ssh dev198 'bash -lc "cd ~/feishu-grok-bridge && git log --oneline origin/feishu-grok-bridge..HEAD; git log --oneline HEAD..origin/feishu-grok-bridge"'
```

⚠️ **未推判定必须 `git ls-remote origin feishu-grok-bridge` 问真远端** ——
本地 `origin/*` ref 不 fetch 就是旧的。2026-07-26 实锤：据本地 ref 报了
「0 未推」，ls-remote 一问远端 tip 差两个提交（从未 push 成功过）。

不一致时顺序固定：**先 push 部署机的提交让远端追上线上，再 rebase 自己的改动。**
反过来做就是覆盖。

## 控制面部署手法（rsync + 时间戳备份）

`/srv/h-control/app` **不是 git checkout**，是 rsync 部署。`.env` 在 app 外层
（`/srv/h-control/.env`），不会被覆盖；`node_modules` 不同步。

⚠️ **dev198 没有 aliyun-hk 的 ssh 别名**（2026-07-26 实测 name resolution 失败）
——下面的 rsync 要在**有别名的机器（Air）**上跑：先
`rsync dev198:feishu-grok-bridge/control-plane/{server.mjs,lib,test} <staging>/`
（排除 node_modules，md5 抽一个文件对撞确认同源），再从 staging 按下述参数推
aliyun-hk。

```bash
TS=$(date +%m%d%H%M)
ssh aliyun-hk "cp -a /srv/h-control/app /srv/h-control/app.bak-$TS"
rsync -az --no-owner --no-group control-plane/server.mjs aliyun-hk:/srv/h-control/app/server.mjs
rsync -az --no-owner --no-group --delete control-plane/lib/  aliyun-hk:/srv/h-control/app/lib/
rsync -az --no-owner --no-group --delete control-plane/test/ aliyun-hk:/srv/h-control/app/test/
ssh aliyun-hk 'chown -R h-control:h-control /srv/h-control/app && cd /srv/h-control/app \
  && node --test test/*.test.mjs && systemctl restart h-control'
```

⚠️ **chown 不能省** —— root 写出的文件服务自己改不动。

## 验收：拿真凭据打那个 URL，别只看代码

- **管理员端点**：服务端登录取 cookie（密码不出服务器），再从公网打：
  `POST http://127.0.0.1:18790/admin/login`，body 是 **JSON** `{"password":...}`。
- **越权负例必须用「真实存在但不该看见」的探针** —— 拿一个**有效的用户会话
  cookie** 去打 admin 端点。用不存在的 id 只会走 404 早退，测了等于没测。
  正确结果：同一 cookie 打 `/api/memory` 是 200、打 `/admin/api/*` 是 401。
- **cookie domain 别混** —— 全程锁 `https://ai.kidshub.cn`，混 127.0.0.1 会
  给出假阴性。
- **页面 script 块逐块 `node --check`** —— 模板字符串吞 `\n` 会让整块静默不执行。

## 隧道告警：判定在控制面，投递在执行面（v1.15.0）

分工是被物理位置逼出来的：控制面**能探**（frps 与它同机）但没有飞书身份；
执行面**有身份**（owner Bot）却探不到自己那条入站隧道。

- 判定：`control-plane/lib/tunnel-probe.mjs`，连续 3 次失败才翻状态。
  **必须读到 `SSH-` banner 才算通** —— frps 无客户端时照样 accept 再立刻关。
- 投递：`lib/tunnel-alert.mjs` + `lib/alert-target.mjs`，bridge 每 5 分钟拉一次
  `/internal/tunnel-status`。隧道断时这条路照样通（两跳都是出站 HTTPS）。
- 送达目标优先级：`H_ALERT_CHAT_ID` > 观察到的 owner 单聊 > **owner 凭据里的
  `openId`**（= 当初扫码那个人，用 `receive_id_type=open_id` 直发）。
  最后那条是兜底，缺了它**从装机到管理员第一次开口那段时间告警是哑的**。
- 三条防打扰：同一次故障只报一次（认 `since`）／不修就按 6h 重复提醒
  （**不能报一次就闭嘴**）／恢复补一张。「状态未知」不算故障。
- 关：`H_TUNNEL_ALERT=0`。

**验收必须真发一次**，走与真实告警完全相同的那条路（同一 client、同一段目标
解析、同一个 `sendCard` 调用），内容写明是自检。只跑单测等于没验投递。

## 用户任务摩擦：只记形状，不记正文（v1.15.0）

`lib/evolve-log.mjs` 的 `appendFriction` 记原话（`summary`=提问 / `detail`=回复），
那是 **owner 专用**，因为记的是管理员自己的数据、且要喂自进化顾问。

BYOS 用户走 `lib/user-friction.mjs`：只有 `ts/kind/ok/sec/promptChars/replyChars`
六个字段，**连错误文本都不留**（引擎报错可能回显提示词片段）。
落在 `workspace/evolve/users/<uid>.jsonl`（bridge 侧，**不在用户沙箱里**）。

- 改这块前先读 `lib/user-friction.mjs` 开头 —— 那里写了为什么不能复用上面那份。
- 失败归类梯子 `classifyFailure()` **两边共用**，别再各抄一份。
- 展示在用户后台「它怎么工作」与管理台上下文查看器，两处都必须写明
  「不保存对话内容」。
- 测试里故意按老写法把正文塞进事件对象，断言落盘一个字都搜不到。
- ⚠️ **`workspace/evolve/users/` 必须留在 `.gitignore` 里**（`b81e472` 补的）。
  当初只想了"文件里写哪些字段"，漏了"这文件最后会去哪"——
  它落在一个被 git 跟踪的目录下，同目录的 `friction.jsonl` 早就因为
  「含原始对话摩擦文本」被 ignore，**隔壁就是答案却没继承**。
  **无正文 ≠ 无隐私**：「谁在什么时候用了多久、问题多长」是租户行为数据。
  **通则：在这个仓里新建任何落盘目录，都要同步过一遍 `.gitignore`**，
  并且先 `git log --all -- <路径>` 确认没已经泄出去。

## 租户维度：tenant_key 怎么来（v1.15.0）

- 飞书 **v2 事件的 header 自带 `tenant_key`**，SDK 的 `parse()` 会把 header
  展开进 handler 的 `data`（`node-sdk/lib/index.js:93603`）——
  所以 `data.tenant_key` 直接可取，**零额外权限点**。
  验法：造一条合成 v2 事件喂 `EventDispatcher.invoke`，看 handler 收到什么。
  （脚本要放在**仓库目录内**，ESM 按文件位置找 node_modules，放 /tmp 会 404。）
- 采集端点 `/internal/tenant-key`，**只在变化时写盘**。
- ⚠️ **别把 union_id 相同当成跨租户证据**：2026-07-26 现网两条记录 appId 不同、
  union_id 相同 —— 那是同一个人开了两个 App。union_id 只在**同一开发者**下跨
  App 通用，不同租户的值不可比，所以身份合并主键必须 `(tenantKey, unionId)` 复合。
- ⚠️ `readUnionId` 依赖哪个 scope 目前**存疑**：注释写 `contact:contact.base:readonly`，
  addons 预置的是 `contact:user.base:readonly`，两者对不上。
  可确证的只有结果（走现行流程的用户 2/2 都拿到了 union_id）。

## 白盒数据的更新链路与新鲜度（v1.15.1）

一条完整的路：用户任务收尾 → `scheduleMemorySync(uid, org)`（debounce 90s）
→ `runMemorySync` → `pushMirror(uid, org)` → **`pushContext`**
→ 控制面 `/internal/context-report` → 后台页面。
另有 30 分钟定时器兜底。**所以正常时延约 1.5 分钟，不是半小时。**

2026-07-26 真实流量实测（川哥发消息 → 后台）：

```
16:42:58  outbound ok            ← 任务收尾
16:44:28  context report pushed  ← 正好 +90s，debounce
17:07:41  context report pushed  ← 16:37:41 起的 30 分钟定时器
```

两条路都在跑。**川哥反馈"白盒更新了、时间正常了"= 全链路闭环。**

排查「后台数据不更新」时按这条链顺着看，三个真踩过的坑：

- ⚠️ **`pushMirror` 里的 hash 去重曾把尾部的 `pushContext` 一起 return 掉**
  （v1.15.1 修）。稳态下记忆内容不变 = 去重必命中 = 白盒永远停在旧快照。
  往这个函数尾部加东西前，先数一遍上面有几个 `return`。
- ⚠️ **`org` 要一路带下来**（**四个调用点**：debounce、bootPush、30 分钟兜底
  定时器、memory-ops 轮询）。漏任何一个，那条路推的报告里「部门共享
  skills」（l1）就恒 null，与带了 org 的那条**互相打架**，表现为数据反复横跳。
  v1.15.1 只改对一个、注释还写反了，16:37 才补齐（`1900509`）。
  现在有 `test/context-org-passing.test.mjs` 源码扫描钉着 ——
  行为测试盖不到（要真起定时器 + 真建 `/srv/h-platform/orgs/<org>/skills`）。
  **暴露条件是 orgs 目录非空**，目录空着时两条路都是 null，看不出问题。
- ⚠️ **验「去重类修复」必须落在缓存命中那一次**：每次 restart 都会清空
  `mirrorSent`，重启后第一次推送新旧代码表现完全一样。
  要拿判别性证据，就得**不重启**地等下一个周期。
  最硬的看法是直接比 `/srv/h-control/data/memory-manage/` 里两个文件的 mtime：

  ```bash
  ssh aliyun-hk "ls -la /srv/h-control/data/memory-manage/"
  ```

  `*.mirror.json` 冻着而 `*.context.json` 在动 = 去重命中了但尾调用照跑
  （旧代码下两者必然同时间）。再用
  `systemctl --user show feishu-grok-bridge -p ActiveEnterTimestamp,NRestarts`
  证明期间没重启，条件才闭合。
  ⚠️ **但 mtime 只是「最后一次写入」，不是「写了几次」**——
  想知道推了几次、什么时候推的，必须看 journalctl。
  用 mtime 判过「debounce 没走」，其实走了，只是被半小时后那次覆盖了。

### 时间显示

页面上**禁止裸切 ISO 串**（`slice(5,19)` / `replace('T',' ')`）——
服务端存 UTC，川哥在 UTC+8，北京 16:01 会显示成「08:01」，
真的因此收到过一个"数据不更新"的误报。

统一走 `TIME_JS` 里的三个助手（管理台与用户后台共用）：
`hAgo()` 相对时间（主显，时区无关）／`hCn()` 北京时间／`hWhen()` 两者拼接。
用户侧标签列只有 150px，**相对时间放标签、绝对时间放副行**，否则挤成两行。
快照类页面还要写明更新节奏，否则用户分不清"我看到的旧"还是"它真没动"。

`test/pages.test.mjs` 有断言盯着：页面里不许再出现裸切写法，
且会把时间助手从渲染结果里抠出来真跑（UTC 08:01→16:01、跨日进位、坏输入）。

## 多引擎（v1.17-1.19，grok/kimi/zhipu/minimax）：接入、排障、模型动态化

### 新接一家 apikey 型国产订阅 = 只改注册表
`control-plane/lib/providers.mjs` 加一条（keyUrl/validateBaseUrl/envVar/
ompProvider/fallbackModel），绑定 UI、验活、vault、creds 下发、模型动态发现、
引擎白名单**全部自动继承**。执行面 runner 是 omp 通用承载
（`lib/omp-runner.mjs`，bwrap 挂 `~/.bun`→`/opt/bun`，key 走 `--args FD`
不落盘不上 argv）。envVar 名以 omp 源码 `stream.ts` 映射表为准
（`ZHIPU_API_KEY` / `MINIMAX_CODE_CN_API_KEY`）。

### 「用户说引擎不对」三层排障（2026-07-26 三轮实锤，症状全一样）
1. **路由层**：`journalctl --user -u feishu-grok-bridge | grep -E "omp start|grok start|kimi start"`
   ——先定谁在跑。踩过：app-registry 两处 `kimi?kimi:grok` 三元把 minimax
   吞回 grok（枚举扩容必须灰 grep 扫全消费点；现有 `sanitizeEngine` 单点 +
   `test/omp-engine.test.mjs` 全仓扫描钉死）。
2. **身份层**：路由对但模型 cosplay 注入历史（自称/口癖/行为格式整体照抄，
   越问越强化）。防线=历史块**对话内双重框定**（system 追加会被压掉）。
   判别性证据源：**omp 会话落盘** `<用户树>/.omp/agent/sessions/<cwd>/*.jsonl`
   ——真实 prompt + 模型真实输出，一读定分。
3. **模型层**：`/internal/creds/<uid>` 看下发的 model/candidates。
   模型动态发现：绑定时 `GET <baseUrl>/models`（=验活，401 即 key 坏，零推理
   配额）→ `person.subs[p].models` 新→旧；存量懒发现、24h 后台刷；用户可在
   dashboard 固定某模型（服务端白名单校验）。**执行面与 omp catalog 求交集**
   （omp 拒跑 catalog 外模型），omp 升级要重启 bridge 刷 catalog 缓存。

### 订阅 Person 级（v1.18.0）
凭据 vault 落 `personId` 条目（绑一次全部助手共用；同 provider 物理一份防
rotation war）；状态真源 `persons[pid].subs`；孤账号回退 uid 级。改绑定/凭据
链路时走 `lib/person-subs.mjs` 的分派函数，**别直接 `store.upsert(vaultKey,…)`**
——vault.list() 的键可能是 personId，直写会造出幽灵用户。

### 文案纪律
身份声明/引导文案模型会**原样复述**给用户——别写 BYOS 这类黑话（川哥真机
问过「BYOS 是什么」），一律说人话（「使用用户自己绑定的订阅」）。

### omp 引擎的平台 harness（2026-07-26 补齐）
切 omp 引擎后 SOUL/方法论/记忆不生效的修法（引擎无关层，勿逐引擎重做）：
`lib/omp-harness.mjs` —— ①`workspace/AGENTS.md` 三个托管块（h-soul/h-method/
h-mem，幂等、保留用户内容、runner 每任务前 ensure 保鲜 SOUL）；
②`<用户树>/.omp/agent/mcp.json` 注入 ai-memory（标准 mcpServers）。
记忆**写入**侧本就引擎无关（网关 captureExchange）。
待办：kimi 认不认 workspace/AGENTS.md 未验；omp 三层 skills 走
`skills.customDirectories`（认标准 SKILL.md 非递归布局）待接。

### 「回复怪」双层排障 + M3 黑名单（2026-07-26 收尾）
- **内容层**：文件里有 ≠ prompt 里有。omp 何时注入 AGENTS.md 不可控（生产
  session 实锤读不到）→ SOUL/方法论/记忆指引走 runner `--append-system-prompt`
  确定性注入（`omp-harness.mjs::buildSystemAppend`，每任务现读 SOUL）。
- **传输层**：MiniMax M3 思考是**内联 `<think>`**（M2.x 是 reasoning_content
  字段，两代不同）；omp 流式剥离在 M3 长回复吞正文开头（上游
  stream-markup-healing 缺陷）→ `providers.mjs` `knownBadDefaults:['MiniMax-M3']`
  自动档降 M2.7、手选保留。**omp 升级后复查**：长回复开头齐了删黑名单。
- 排障链：chat-history 看表象 → `.omp/agent/sessions/` 看真 prompt/真输出 →
  厂商 API 直测响应结构 → omp 源码定位。

## F1 统一任务轨迹层（排障第一入口，2026-07-27 上线）

**排障先看这里，再看三方 agent 原生落盘。**每任务两行 JSONL：
`/srv/h-platform/users/<uid>/traces/<yyyy-mm-dd>/<chatId>.jsonl`
（task_begin=engine/model/prompt/history/systemAppend 全文；task_end=
ok/exitCode/durationMs/reply 全文/usage 三桶）。

```bash
# 四问一步答：谁在跑/注了什么/回复完整吗/花多少
jq -r 'select(.type=="task_begin") | "\(.ts) \(.engine)/\(.model) hist=\(.historyChars)ch"' <trace.jsonl>
jq -r 'select(.type=="task_end") | "ok=\(.ok) \(.durationMs)ms in=\(.usage.input) out=\(.usage.output)"' <trace.jsonl>
```

- 实现 `lib/trace.mjs`；**与 `lib/task-trace.mjs` 别混**（那是只读展示层，
  白名单防正文泄漏；未来管理员看他人轨迹必须走那边的白名单模式）。
- usage 口径：omp=会话落盘内嵌 / grok=unified.jsonl 增量窗口（带 sid）/
  kimi=**null 待补**（无真实会话，首会话后按实测口径补采集器）。
- E2E：`node scripts/f1-trace-smoke.mjs <uid> <engine>`（消耗该用户一条
  最小请求；生产同源装配，8 项断言）。改 runner/trace 后必跑 grok+omp 各一条。
- 保留 30 天（session-gc.sh，`H_TRACE_KEEP_DAYS` 调）；轨迹含对话全文，
  只在用户树，不进 git、禁外派。

## F2 skills 三引擎生效面（2026-07-27）

- 三层：L0 `/shared/skills`（29 个）/ L1 `/org/skills` / L2 `<userRoot>/.grok/skills`
  ——**L2 落盘点三引擎共用**（skills-sync user 层落这，装一次全引擎生效）。
- omp 接线：`~/.omp/h-skills.yml` overlay（bridge 每任务前重写，手改无效）+
  runner `--config`；「用户问技能答没有」先查 bridge 日志 `omp skills cfg fail`。
- kimi：runner 三个 `--skills-dir`（显式传入会替代 kimi 原生自动发现，by design）。
- 验收口令：给用户 L2 放探针技能（description 写触发条件+暗号）→ 问引擎
  「执行 XX 探针」→ 回暗号 = 元数据注入+正文阅读全链通。测完删探针。

## F3 定时任务运维（2026-07-27）

- 定义：控制面 store user.schedules（dashboard 定时任务 pane 编辑）；
  执行面状态 `~/feishu-grok-bridge/workspace/evolve/schedule-state.json`。
- 排障链：`journalctl --user -u feishu-grok-bridge | grep schedule` →
  fire/delivered 两行定位；任务本身的问题看 F1 轨迹 `sched_<name>.jsonl`。
- 语义要点：改任务（defHash 变）= 新实例，**当天已过时刻不补发**（用户报
  「改完没跑」先看这条）；拉控制面失败跳过整轮 tick（不用陈旧定义触发）。
- 开关：`H_SCHEDULES=0` 停调度器；`H_SCHEDULE_TICK_MS` 调 tick。
- E2E：写测试任务设 now+4min → 看 fire/delivered 日志 + 飞书卡片，
  **测完必删**（否则每天到点触发）。
- **边界**：F3 是纯时间触发，会在到点后执行 Runner 并主动推卡；“某时间后首次对话再做”是 `notBefore AND nextInbound`，禁止塞进 F3。一次性补授权应先终止旧 device-flow，再用持久 timer 到点挂监听，首次单聊命中后现开 600 秒授权流；验证 timer 的下一触发时间、到点前 service=inactive、旧授权进程为空、Bot 健康仍为全连接。长期产品化应做控制面声明式 deferred-action 队列，替代用户专属脚本。

## F4 配置快照运维（2026-07-27）

**用户侧**：单聊发「快照」→ 存一版（内容没变则不新建）+ 列表卡，点「⏪ 恢复 vN」
→ 确认卡 → 结果卡。owner 无此功能（这几个词在 owner 上不消费，照常进引擎）。

**落盘**：`/srv/h-platform/users/<uid>/snapshots/{meta.json, v<N>.tar.gz}`。
`meta.json` 是索引，**磁盘上的包才是真相**——meta 丢了也能被扫出来（合成条目，
trigger 显示「磁盘恢复」）。

排障四问一条命令解决：
```bash
ssh dev198 'bash -lc "u=<uid>; cat /srv/h-platform/users/$u/snapshots/meta.json; ls -la /srv/h-platform/users/$u/snapshots/"'
```

- **「用户说配置被改坏了」**：让他发「快照」看列表，选改坏之前的时间点恢复。
  恢复前系统自动存当前状态，所以恢复错版本也能再恢复回来（结果卡会告诉他撤销
  点的版本号）。
- **「恢复失败」**：看日志 `journalctl --user -u feishu-grok-bridge | grep snap`，
  错误带 code：`BUSY`(有恢复在跑) / `NOT_FOUND` / `EXTRACT`(包损坏) /
  `VERIFY`(包内容没过白名单校验，可能被手工替换过) / `SWAP`。
  **卡片文案里出现「配置可能处于不一致状态」= 回滚也失败了**，按卡片指示立刻
  恢复它给出的备份版本，别先派任务。
- **发现 `<文件>.old-*` 或 `snapshots/.restore-*` 残留**：说明进程在 swap 中途
  被 kill。不用手动收拾——下次装配/快照操作的 janitor 会自动回收（目标缺失就
  把 .old 移回位，目标在就删残留）。要立刻回收就让该用户发一句话触发装配。
- **验证凭据没进包**（安全巡检）：
  ```bash
  ssh dev198 'bash -lc "for f in /srv/h-platform/users/*/snapshots/v*.tar.gz; do tar -tzf $f | grep -qE \"auth.json|kimi-code/config.toml\" && echo \"LEAK: $f\"; done; echo scan-done"'
  ```
  应只输出 `scan-done`。

**改白名单时**（`lib/config-snapshot.mjs` 的 `SNAPSHOT_FILES`/`SNAPSHOT_DIRS`）：
按「引擎 × 配置载体」矩阵过一遍别凭印象——grok 用 `.grok/AGENTS.md`，omp 用
`workspace/AGENTS.md`，kimi 用 `.kimi-code/AGENTS.md`，三个不同位置。加目录项
时注意目录根会被 lstat 校验（软链目录整个跳过，这是安全防线不是 bug）。

## F6a 进化管线安全网（2026-07-27）

owner 在飞书点「应用提案」后的链路变了：**pre-apply 快照 → 追加补丁 → 跑
eval-skills → 不过就自动回滚**。快照落 `workspace/evolve/snapshots/`，与用户树
快照共用一套逻辑（`createSnapshotStore`，两套白名单）。

**看卡片就能分流处置**，别只看 OK/FAIL：

| 卡片文案 | 含义 | 该做什么 |
|---|---|---|
| `OK` | 应用成功且 eval 通过 | 无 |
| `FAIL（内容重复，已应用过 → 跳过）` | 去重拦下，提案已标 `status: duplicate` | 正常，无需处理 |
| `FAIL（回归检查未过，已自动回滚）` | 编辑面已复原，提案退回 pending | 看 eval 为什么挂 |
| `FAIL（已回滚，但记账未完全撤销…）` | 编辑面回滚了，提案状态/记录没对齐 | 手工对齐 status 与 applied 记录 |
| `⚠️ 回滚失败（补丁仍在生效…）` | **补丁还在 PROMPT 里** | 立刻处置，见下 |
| `FAIL（无可信回滚点，未改动任何配置）` | 快照失败或编辑面与最新快照不符 | 先手动跑一次快照 |

**回滚失败的人工处置**：`workspace/evolve/applied/` 下会有
`*.rollback-failed.txt` 说明现场。步骤：①用它记的 lineage bak 或快照恢复
PROMPT；②确认恢复后，**删掉对应的 applied 记录**才能解除内容去重、允许重试。
去重在此时是 fail-closed 的（补丁还在编辑面，放行重试就是二次叠加）。

**去重是双闸**：applied 记录的 contentHash + 活体校验（补丁正文是否已在目标
PROMPT 里）。后者覆盖旧版写的、没有 hash 行的历史记录。确需重复应用时加
`--allow-duplicate`（CLI 专用，飞书按钮走不到）。

**改 role 或新增角色时**：`apply.mjs` 的 `ROLES` 数组是唯一真源——白名单由
`editSurfaceFiles()` 枚举 promptPath/rulesPath/seed 推导，加了角色白名单自动
跟上。非白名单 role 的提案会被 `unknown_role` 拒绝（不静默折叠到 ai）。

**并发**：`workspace/evolve/snapshots/.apply-lock` 是跨进程锁（apply 全程持有，
pid 探活 + 10 分钟 TTL）。看到 `FAIL（另一个 apply 正在运行）` 就是它在起作用；
陈旧锁会被自动抢占，一般不用手删。

**清理重复补丁**（存量整理，不可逆，先问川哥）：脚本思路见 2026-07-27 那次——
按「去掉日期行与来源提案行后的实质内容」分组、每组留最早一遍，内容独特的块
全部保留。纪律：本地全量预演 → 验证「非补丁内容逐字节一致」→ 生产快照 +
lineage 备份 → 写入 → eval → 生产结果与本地预演逐字节比对。

## F6b 效果闸（真跑评估）运维（2026-07-27）

apply 现在有**两道闸**：结构闸 `eval-skills`（静态 lint，秒级）→ 过了才跑
效果闸 `eval-bench`（真拉起引擎答题，分钟级，花钱）。

**资产在仓外**：`dev198:~/.h-evolve/`（benchmarks/ + scoreboard.jsonl）。
放仓里会被被测引擎读到——它 cwd 是 `workspace/leader`、有 Read 权限，而
leader PROMPT 正文就写着「进化记录见 workspace/evolve/」。版本副本在 mycc
`4-Assets/h-platform-benchmarks/`，改完两边都要同步。

```bash
ssh dev198 'cd ~/feishu-grok-bridge && node scripts/evolve/eval-bench.mjs --runs 2'
```

- `--gate` 与基线比（退步 exit 1）｜`--record` 记入 scoreboard｜`--runs N`
- 退出码：**0=过或噪声，1=退步（已复测确认），2=评估无效**
- 效果闸只在结构闸通过后跑；`EVOLVE_BENCH=0` 或 `--no-bench` 停用

**⚠️ 它是弱闸，别高估**：实测抽掉 PROMPT 里的单条纪律，分数纹丝不动甚至更高
（工作区知识冗余 + 真实纪律本身是模型常识，详见记忆
`[[feedback_eval_probe_must_be_arbitrary]]`）。当前能挡的是引擎/装配级崩坏，
挡不住「改坏一条纪律」。看到 `effectGate: pass` 别理解成「补丁没问题」。

**排障看 failures 里的码**：
- `engine_max_turns` — bench.json 的 maxTurns 设小了。**这个码要盯**：某 case
  长期 max-turns 会让整轮恒 invalid，效果闸对它等于永久失效。
- `rubric_leak` — 输出里出现了只在 rubric 文件里的 canary，说明被测读到了
  评分标准。该轮判无效（不是判 0 分），检查 benchmark 是否被挪进引擎可达面。
- `bench_reachable` — benchmark 目录落在引擎 cwd 之下，直接拒绝评估。
- `engine_timeout` / `engine_error` / `empty_output` — 基础设施故障，**不回滚**。

**基线语义**（这几条都是对抗 review 抓出来的，别改坏）：
- 只有 `gate: pass` / `baseline_established` 的记录能当基线——退步分数对应的
  配置已被回滚，拿它当基线会让闸门每拦一次就下调一档（单向自我解除）。
- 基线必须**同 fingerprint**：增删 case 或改 rubric 分值即换口径，旧基线作废，
  要重建（`--record` 跑一轮）。
- 容差默认 1 分（bench.json 的 `regressTolerance`）；掉出容差带会**自动复测
  一次**，两次都低才判退步——模型非确定性会例行让分数波动。

**加 case 前先做两件事**（否则白做）：① grep 整个 `workspace/leader/` 确认
探针信息不在别处；② 确认它不是模型凭常识就能答对的东西。

## 用户报「发了消息没反应」怎么查（2026-07-27 路宁实录）

**别先猜并行度/历史大小**，这两个当时都被数据推翻了。按顺序查：

```bash
ssh dev198 'curl -s --noproxy "*" http://127.0.0.1:18765/healthz' | python3 -m json.tool | head -30
```

- `queueStats.activeGlobal` **远小于** `maxParallel` → 并行度不是瓶颈（同会话
  串行是 by design，调 maxParallel 一条都不会快）
- `depths` 全堆在一个 key → 该用户连发了多条，在排自己的队

**真正常见的根因是卡片发不出去**，日志里找：

```bash
ssh dev198 'journalctl --user -u feishu-grok-bridge --since "30 min ago" --no-pager | grep -B30 "sendCard retry\|give-up" | grep -iE "code:|msg:|ErrMsg"'
```

飞书卡片被拒 = **整条消息发不出去**（不只是某个元素显示异常），入队提示卡与
执行心跳卡会一并消失，用户端就是长时间死寂。已知触发源：回复里的 markdown
图片引用（`230099 / ErrCode 11310`，已在 normalizeForFeishuCard 修掉）。

**日志现在带业务码**（`http=400 code=230099 msg=...`），不再是光秃秃的
「status code 400」。看到 `give-up (not retryable)` 是正常行为——内容类 4xx
首次即降级，不再白等三轮退避。

**重启验证认 uptime 不认命令退出码**：
```bash
ssh dev198 'curl -s --noproxy "*" http://127.0.0.1:18765/healthz' | python3 -c "import sys,json;print('uptime', int(json.load(sys.stdin)['uptimeSec']))"
```
uptime 没归零就是没重启成。另：**别在 ssh 命令里写 `pkill -f <脚本名>`**——
pattern 会匹配到你自己那条 ssh 命令行，把连接杀掉（exit 255），重启看似执行
实则没跑。用 `pgrep -af` 查真 PID 再按 PID kill。

## kimi/omp 用户的记忆与人设（v1.22.0，2026-07-27 三引擎拉平）

三引擎能力对照（排障先对表，别拿 grok 的尺子量别人）：

| 能力 | grok | kimi | omp(zhipu/minimax) |
|---|---|---|---|
| SOUL 人设 | `--rules` | workspace/AGENTS.md 托管块（每任务保鲜） | 同 kimi + `--append-system-prompt` 双保险 |
| 记忆检索 | config.toml `[mcp_servers.ai-memory]` | `<userRoot>/.kimi-code/mcp.json` | `<userRoot>/.omp/agent/mcp.json` |
| 记忆写入 | 引擎原生 + memory-sync + 网关捕获 | 网关捕获（captureExchange） | 网关捕获 |
| wiki 记忆文件 | 同步腿自然长出 | **ensureMemoryScaffold 建**（MCP 写页） | 同 kimi |

排障口令（都在 dev198）：
- 面板显示「MCP 否/托管 0 字符」→ 先确认控制台版本 ≥v1.22.0 且报告是重启后推的
  （`journalctl --user -u feishu-grok-bridge | grep "context report pushed <uid>"` 看 engine= 对不对）。
- kimi 记忆恒空 → 三查：①`ls /srv/h-platform/memory/<uid>/`（实例在不在）
  ②`find /srv/h-platform/memory/<uid>/wiki -name MEMORY.md`（**没有=捕获 no-target 空转**，
  看启动日志有没有 `memory scaffold created`）③mcp.json 有没有 ai-memory 条目。
- MCP 通道活性：POST `http://127.0.0.1:<port>/mcp` JSON-RPC initialize，带 auth.token
  应回 `ai-memory x.y.z`，无 token 应 401（token 在 `/srv/h-platform/memory/<uid>/auth.token`，别回显）。
- kimi 配置合法性：`KIMI_CODE_HOME=<userRoot>/.kimi-code ~/.kimi-code/bin/kimi doctor`。
- ⚠️ kimi 的 mcp.json 条目**只写 url/headers**——加 schema 外字段（如 omp 版的 enabled）有整体拒收风险。
- ⚠️ wiki 路径段 `grok/` 是三引擎共用的历史布局名，**改名会破 findMemoryFiles 与镜像映射**。
- 最后一厘米：kimi 真实任务调 memory_query / 任务后 `memory captured` 日志——只能等用户真实消息验，
  测试别烧用户订阅额度。

## F5 长任务后台句柄（v1.24.0，2026-07-27）

- 语义：user 单聊任务跑超 `H_BG_YIELD_MS`（默认 120s）→ 发「已转后台 · #句柄」卡+释放会话；完成/失败自动推卡（标句柄）；「进度」网关代答（纯读）；「停 #句柄」精确停；重启推「已中断」卡。owner 默认关（`H_BG_YIELD_OWNER=1` 开）；群聊不启用。
- **红线**：轮询/新消息绝不杀后台任务（penguin 纪律）；停止判定是 **child 级** `hStopRequested`（key 级 flag 会误杀转后台任务——改 runner close 判定时别回退）。
- 落盘：`<userRoot>/tasks-bg.jsonl`（隐私域）；孤儿恢复幂等（register 没 end → orphaned）。
- 排障：`journalctl --user -u feishu-grok-bridge | grep "bg yield"` 看转后台；`grep "bg orphaned"` 看重启中断。

## kimi MCP 工具 schema 兼容（2026-07-27 生产事故）

- **症状**：kimi 任务全败 `400 tools.function.parameters is not a valid moonshot flavored json schema (anyOf...)`。
- **根因**：kimi 把 MCP 工具 schema 原样交 Moonshot API（严格校验）；ai-memory 1.14.0 的 `memory_read_page` root 层 anyOf+type 同级——**一个工具毒死整包 tools**。
- **修法**：mcp.json 条目带 `enabledTools` 白名单（现为 memory_query/write_page/recent/status 四个）。**给 kimi 挂任何新 MCP server 前**，先对每个工具跑 schema 体检（anyOf 与 type 同级即拒），脚本范式见 bridge 仓提交 7879a87 的描述。
- 止血口径：手工从用户 `.kimi-code/mcp.json` 删条目即刻恢复（重启会按白名单重注入）。

### F5 验收翻车三连的排障线索（2026-07-27 实录）

- 用户说「停没生效/入队了」→ 先查 F1 轨迹看**原文**（`grep task_begin traces/<日期>/*.jsonl`）：
  ①带「」书名号？→ 解析线剥壳问题（role-identity stripWrapChars 探针，2026-07-27 已修）
  ②36 位 UUID？→ **引擎自带 background 工具在抢协议**（grok 会自造任务 id 教用户停），
  平台侧「停 <像id的token>」已兜底停前台；根治靠方法论三投放面的长任务禁令
  （grok=memory-routing h-method / kimi·omp=omp-harness h-method / L0 agent-method skill，
  **三处同一套话，改一处同步三处**）。
- 停止类消息绝不入队是红线；「停」相关改动必须过 test/f5-stop-semantics.test.mjs。

### F5.1 按钮化 + 寒暄/脏会话排障（2026-07-27 下午）

- 加卡片按钮：动 `PANEL_COMMANDS`（feishu-card.mjs），**别动 COMMANDS**——跟随气泡
  平台上限 3 个，FOLLOW_UP_CONTENTS 测试锁死；回调三分支（bg_progress/bg_stop/bg_recall）
  在 bridge card.action.trigger，bg_stop fail-closed。
- 用户报「简单消息卡很久/被转后台」排查顺序：
  ① `journalctl | grep "grok start"` 看 mode——寒暄落 full = classifyMode 词表缺词
    （grok-session.mjs，改词表必配 classify-mode.test 回归锁，动作词底线不动）；
  ② mode 对但仍卡 → 看同行 `size=`——**resume 脏会话**（含引擎自身 background 任务
    残留的会话，resume 后零日志卡死）。处置：让用户点【新会话】轮换（或杀进程+查
    `.session-map.json`）。short 已免疫（一次性会话）；full 再现就上 resume 首轮
    活性看门狗（候选方案，见项目记忆）。
- 杀卡死引擎进程：`ps -eo pid,etime,args | grep bwrap` 找 pid 后 `kill -TERM <pid>`
  （**绝不 pkill -f**）；被杀的转后台任务会给用户发失败卡=正常收尾回执。

## F5.2 后台任务送达契约（v1.25.1，2026-07-27）

**契约（红线）**：转过后台（bgHandle 非空）的任务，完成/失败结果**必须发新卡到
会话底部**（sendReply/sendCard 新消息=有推送通知）；旧流式卡只封口指路「结果见
下方 ⬇️」。禁止把 streamCard.finish 的原地更新当送达——旧卡在 N 屏之上，改完
用户看不见（#86a6 kimi 901s 超时真机翻车「感觉没有结果输出」）。

- 面板状态：`ended` + `result.ok === false` → 「⚠️ 已结束（失败）」，不许顶绿勾。
- 非流式失败卡带 partialOutput（失败也别让用户白等；sendCard 自带 9000 字符分片）。
- 排「用户说没收到结果」：`grep <句柄> logs/bridge.log` 看有无 `outbound ok`/
  `handle error` 后的新消息发送；再查 `tasks-bg.jsonl` 的 bg_result（digest 在不在）。
  digest 在而聊天没新卡 = 送达通道断（本节 bug 的特征指纹）。
- 尉鸿轩类「查通讯录」任务挂 15 分钟到超时 = kimi 在等 lark-cli 设备码授权（digest
  里有 open.feishu.cn/page/cli 授权链接）。F5.2 后链接会送达，用户授权一次即通；
  再挂死考虑 lark-cli 预授权或缩短设备码等待（观察项 A4）。
