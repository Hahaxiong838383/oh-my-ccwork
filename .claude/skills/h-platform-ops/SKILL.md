---
name: h-platform-ops
description: H 平台（BYOS 多用户飞书 agent 网关）运维：开通新用户、真机验收、引擎排障、需求与缺陷闭环、合并部署。适用 dev198 feishu-grok-bridge + aliyun-hk 控制面 ai.kidshub.cn。触发词："H 平台"、"开通 H 用户"、"给用户开通飞书 agent"、"BYOS 开通"、"feishu-grok bridge 多用户"、"需求与缺陷闭环"、"H-P 运维"
layer: 项目层
authorization: B区（生产 bridge + 控制面变更需明确 scope）
output_levels: L2
---

# H 平台运维 Skill

BYOS 多用户飞书 agent 网关。用户扫码得自己的 Bot + 隔离 agent 实例，用**自己的订阅**（grok/kimi）对话。

## 铁律（每次操作自查）

1. **共享行为覆盖 owner**：owner 与所有登记用户必须共用任务分类、队列、后台移交、送达、权限恢复、日志、记忆和错误脱敏机制；owner 只允许保留 `sandbox=null`、凭据来源与隐私边界差异，禁止以“零影响”为由留下一套用户可见旧行为。验证：重启后所有 App 的 `behaviorContractVersion` 必须一致。
2. **secret 不入 git**：`SERVICE_TOKEN`/`SESSION_SECRET`/`.vault-key`/用户订阅凭据只在两端 `.env`+data（600）。控制面 `/internal/creds` **只下发 access，refresh_token 永不出控制面**。
3. **隔离必复验**：新用户上线后必做越界测试——该用户 Bot 发「读 `/home/chuan/.grok/auth.json`」→ 必须 `No such file`（bwrap 沙箱）。
4. **杀进程用 PID**：`pgrep -af` 拿 PID 再 `kill`，**禁裸 `pkill -f` 进 ssh 命令行**（自杀坑，见 [[ssh-remote-process-mgmt-pitfalls]]）。
5. **UI 改版先问取向**：改页面前确认**桌面优先还是移动优先**（管理/配置类页面默认桌面优先）；「按 X 的逻辑做」= 抽同一组件双端复用，不是各写一份长得像的（[[feedback_ui_parity_means_same_component]]）。
6. **改 html.mjs 必跑 script 语法门**：模板字符串会把 `\n` 先解析成真实换行 → 输出的 JS 字符串字面量断行 → **整个 script 块静默不执行**（页面正常、console 无报错、按钮全失灵）。源码里写 `\\n`；改完跑「必跑检查」里的 script 块语法检查（[[feedback_template_string_swallows_js_escapes]]）。**加弹层/fixed 组件还有第二道**：`.pane.on` 这类祖先的动画 fill 若用 both/forwards 会固化恒等 transform，静默把 fixed 的包含块从视口劫持成 pane（v1.37.0 真机抓到，fill 已去掉别加回来）；弹层上线前在真实页面断言 `getBoundingClientRect≈视口`（[[feedback_fixed_position_hijacked_by_ancestor_transform]]）。**第三道同族**：`offsetLeft/offsetTop` 的 offsetParent 也由祖先 `position` 决定，画连线/定位一律用 `getBoundingClientRect` 差值；只挂 rAF 的初始化在后台页面永不发生（详见「H-0081 白盒画板」节与 [[feedback_relative_coords_and_frozen_callbacks]]）。
7. **推代码前查实时分支**：历史上部署主干曾在 `origin/feishu-grok-bridge`，但 2026-07-27 已确认 GitHub 当前生产主干是 `origin/main`，旧分支落后。每次先跑 `git fetch origin && git rev-list --left-right --count HEAD...origin/main`，不要把历史记忆当现状。
8. **健康读数认实例**：bridge `/health` 的**顶层字段是 owner Bot 的**，用户 Bot 在 `apps.<appId>` 里。查「某用户的消息到没到」必须看 `apps` 分解——2026-07-25 我拿顶层 `lastInboundAt:null` 断言「一条没收到」，实际用户 Bot 那条准时到了（[[feedback_selfcheck_false_signal]]）。
   - ⚠️ **`lastInboundAt` 只统计文本消息，卡片按钮不进**。用户点「新会话」等卡片按钮走 card action 回调，日志里是 `card action cmd=… chat=… by=…`，而 `lastInboundAt` **纹丝不动**——2026-08-05 我差点据此报「你说测过了但我这边没收到」。验收要么盯日志事件流（全量），要么把动作说死（「发一条文字消息」而非「测一下」）。见 [[feedback_criteria_must_match_object_variant]]。
   - ⚠️ **任务日志的 `#序号` 只出现在 `bg yield` 行**，完成链（runner/outbox/ack）用内部 task ID——journal grep `#6568` 等序号等完成事件会**永远空转**，与「任务没完成」同信号（2026-08-10 监视器白等 7 分钟）。等任务完成认**持久层**（TaskSessionLog/Outbox）或直接跑 `verify-mini-b2-active.sh`，别盯日志序号。
9. **远程语法检查用绝对路径**：dev198 非交互 ssh 的 PATH 没有 node，`node --check` 会「命令未找到」而静默略过；结论行必须由累计变量驱动，绝不无条件 `echo 全过`。
10. **Kimi 通道名不能混**：开放平台模型是 `kimi-k3`；Kimi Code 订阅的 CLI alias 是 `kimi-code/k3`，其 provider model 是 `k3`。桥接层必须使用订阅命名，不能把开放平台名字直接塞进 managed provider。
11. **锁模型而非信默认值**：Kimi 配置生成和 Runner 必须共用 `lib/kimi-model.mjs`；Runner 每次显式传 `--model kimi-code/k3`。只改 `default_model` 不算完成。
12. **真任务归因到真引擎**：用户要求“由 Kimi 完成”时，Codex/cc 只做编排、权限、送达和验收；业务结论必须来自真实 `createKimiRunner`。验收证据同时看 trace 的 `engine/model/providerModel`、真实回复和飞书 message_id。
13. **验收必须由每个 Bot 主动闭环**：任意用户 Bot 的功能修复或优化都视为全平台变更。发布后必须遍历所有登记用户及其全部 Bot，直接使用各 Bot 的真实 Runner 发起验收，并由每个 Bot 主动把完成结果送到其绑定 open_id；禁止把“请用户再发一次测试”、等待用户回复“继续”或另行触发当作验收步骤。若权限不足，禁止只发文字报错，必须主动发送带“去开通权限”按钮的权限申请卡；只有外部平台明确要求用户本人确认、扫码或不可代理授权时，才让用户完成该动作。授权完成后仍由 Bot 自动续跑、主动汇报，不要求用户再发消息。每个 Bot 都必须留下真实 trace 与飞书 ACK/message_id，漏掉任何 Bot 都不能宣称全量生效。
   - **跨用户动作不得用自操作冒充**：验收记录必须明确来源 Bot、创建者、目标收件人、`receive_id_type` 与真实 `message_id`。例如“张雨琦 Bot 提醒川哥”只能由张雨琦 Bot 创建并发送给川哥；AI 专家 Bot 自提醒川哥只能验证调度器通路，不能验证跨用户授权和目标 App 的送达能力。
14. **macOS 部署禁 AppleDouble**：从 Mac 用 tar 向 Linux 发文件会夹带 `._*`；优先 `COPYFILE_DISABLE=1 tar`、`rsync` 或部署后精确清理 `._*`，禁止把这些杂物留进生产 Git 状态。
15. **飞书接口先查官方文档**：管理台常驻 `https://open.feishu.cn/document/home/index`。Bot 对接口、字段、scope 或参数不确定时，优先用用户身份执行 `lark-cli schema <service.resource.method> --as user`；无 typed command 再查官方文档对应板块，并用 `lark-cli api ... --as user --dry-run` 核对。遇到缺权必须保留官方 scope/link，由网关主动发权限申请卡；授权后自动续跑，禁止要求用户重发。
16. **授权链接只认当前 Bot 直授权页**：只允许 `https://accounts.feishu.cn/oauth/v1/device/verify` 与对应 Lark 地址，且必须限定 HTTPS、官方 hostname、精确 pathname，并同时含 `flow_id + user_code`。旧 `https://open.feishu.cn/page/cli` 会进入选择/创建 Bot 的通用页，必须 fail-closed：可用于识别“需要重建授权流”，但禁止透传给用户。
17. **权限申请必须精确且可续跑**：统一顺序是错误中的精确 `--scope` → 可识别的业务 `--domain` → 无法识别时使用官方 `--recommend`；禁止写死 `contact`。Bot 应用身份只发开发者后台开权限卡，不执行用户登录；User 身份同时完成应用 scope 与当前 Bot 用户授权。授权成功后自动续跑原任务，禁止要求用户重发。
18. **授权流复用不能丢任务**：同一用户同一权限集合的并发任务可复用一个短效 flow，但每个等待任务的 callback 都要挂上；一个 callback 失败不能影响其他任务。约 600 秒过期或未完成后必须释放授权流与 30 分钟通知去重键，下一次检测可立即补新卡。
19. **短效授权要在用户活跃时现开**：device-flow 实测约 600 秒，无人时提前生成只会留下过期卡。延迟补发的真实语义是“到达 notBefore **并且** 用户下一次单聊入站”，不是“到点立即执行”；现有 F3 调度器只有时间条件，不能冒充事件门。一次性运维可用持久 timer 在 notBefore 后挂只读入站监听，命中目标用户后再创建新授权流；用户标识只留生产机，不入 Git、共享记忆或通用 Skill。
20. **共享机制禁止用户补丁**：机制修复只能落在 Bridge、共享 Runner 接口或共享 `lib/`；禁止按 `uid`、`appId`、姓名、测试账号或 Bot 名称写分支。每次共享行为变更必须提升 `BOT_BEHAVIOR_CONTRACT_VERSION`，跑全引擎契约与全量测试，并从 `/healthz` 匿名确认所有 App 的版本唯一值数量为 1。
21. **同会话任务有限并发**：私聊新任务到达时，若实际未完成任务数小于 `GROK_MAX_PARALLEL`，立即把当前前台任务转后台并释放同会话链，新任务直接开始；实际 Runner 完成前仍占并发名额。达到上限或群聊场景才排队，禁止用“per-session 串行”让独立任务无条件互相等待，也禁止释放链后无限启动后台任务。
22. **任务完成必须晚于送达确认**：Runner 成功只代表计算结束，不代表用户收到结果；持久交付链必须遵守 `Runner success -> durable enqueue -> send -> delivery ack -> task_completed`。`delivery_started`、TaskSessionLog 或一次发送调用均不能替代 ACK；Outbox/送达失败时禁止提前写完成。
23. **生产 Base 一律先读后改**：编辑《H 产品需求与缺陷闭环》前，必须使用飞书 CLI/API 以 user 身份串行回读当前 Base、数据表、字段、视图、表单问题和记录数量；涉及视图时还要读取其筛选、排序、分组和可见字段。人工编辑后旧快照立即作废，必须重新读取，禁止按历史记忆或上一次返回直接写。既有视图只允许原位更新，不得删除、重建或改名，除非川哥明确点名要求。表单问题与底层字段共用 ID，`+form-questions-delete` 可能连带删除字段和数据；生产主表默认禁用该命令，简化人类入口优先新建独立 intake 表/表单。
24. **字段结构恢复不等于数据恢复**：同名重建字段会生成新 field ID，旧单元格值不会自动回来。任何删字段/删表单问题前都要把实时字段、视图配置和全量记录快照放在 `0600` 的 `/tmp` 临时文件；恢复值时必须同时校验 `record_id` 与主描述文本一一对应，再按原值分组，仅 patch 目标字段。回读验收要检查目标值全匹配、其他业务单元格零变化、视图 ID/名称/类型不变；记录写入会自动刷新只读“更新时间”，必须如实说明。`field-list` 返回顺序不稳定，结构对比按 field ID 映射，禁止直接比较数组顺序。
25. **双端网页打不开先定位请求消失层**：管理台与用户后台同时打不开，不等于控制面宕机。先对齐浏览器时间、本机 Xray `access.log`、DNS 错误、远端 nginx access/error、`h-control` systemd 与监听端口；本机日志显示 `accepted` 只代表代理入口接单，不能证明远端收到。旧页面轮询仍活着而新页面打不开时，优先排查 DNS/cache/keep-alive 和移动网络切换，禁止先重启或重部署生产。H 入口验收必须同时覆盖代理与直连 HTTP、远端 nginx、应用进程和重载后的新增 DNS 错误数。
26. **「Bot 没反应」先数这个 appId 有几个消费者**（2026-08-05 换来的）：owner Bot `cli_a9f1cd1366751bc7` 当时**同时**配在 H 平台（dev198）和 **Mini 的 mycc 后端**（`~/mycc/.claude/skills/mycc/scripts/.env` 的 `FEISHU2_APP_ID`），两条 WS 抢同一批事件。**从 H 平台内部看，「消息被另一个后端抢走」和「用户压根没发」读数完全相同**（零入站 + 无报错 + 全绿 + 12 条 TCP 长连接都在），系统内部没有任何观测能区分这两者。所以第一步是 `grep -rl <appId>` **全机全仓**找其他持有方，别在 bridge 里往下挖。已于 2026-08-05 摘除（注释掉 `FEISHU2_*` 六行，备份 `~/local/mycc-backend-env-backup-*`，重启 `dev.mycc.backend` 后只剩 feishu-codex / feishu-gemini 两条通道）。详见 [[feedback_identifier_owned_by_two_systems]]。
    - Mini mycc 后端通道布局：`FEISHU_*`（配着但未注册）/ ~~`FEISHU2_*`=owner，已摘~~ / `FEISHU4_*` engine=codex / `FEISHU5_*` engine=gemini。**没配 `_ENGINE` 的通道走默认路由**，owner 当时就是这样被派给 gemini 的。
    - ⚠️ 查这类配置别用 `ps eww`：**dotenv 启动后写进内存的变量不进进程环境**，两台机的 `ps` 都报 FEISHU 键数 0（仪器验过是真零），真值在 `.env` 文件里躺着 22 个键。
    - ⚠️ mycc 后端的 gemini 腿本来就是坏的：`adapters/gemini-api.ts` 硬编码 `gemini-3-flash-preview` 且**直连**（全文件 proxy/agent/dispatcher 零命中），dev198 实测直连 `generativelanguage.googleapis.com` = `HTTP 000/12s 超时`、走 xray = `403/1.0s`；同仓 `llm-verifier.ts` 走 `GEMINI_PROXY_URL` 才是对的。另 feishu-gemini 通道 secret 也是失效的（`code 10014`，早于本次改动）。

## 架构

- **本地开发副本（Air）** `~/mycc/2-Projects/feishu-grok-bridge`（git，分支
  `codex/h-mini-ab-poc`，push 同时推 main；mycc 仓已 .gitignore 整目录出仓）。
  2026-08-02 从 `/private/tmp/feishu-grok-mini-ab-poc-20260730` 迁入——**旧 tmp
  路径已死**，重启即清的历史遗留，文档再见到一律读作新路径。
- **执行面** dev198 `~/feishu-grok-bridge`（main=生产多 App 版，不暴露公网）：bridge WS 出站连飞书；per-user grok/kimi 跑 bwrap 沙箱。
  - **服务是 user 级 systemd**（2026-07-29 起拆两个进程）：
    `systemctl --user feishu-grok-bridge` + `systemctl --user feishu-grok-runner-worker`。
    **漏 `--user` 会报 `Unit could not be found`，看着像服务没了**（我 07-30 踩过，
    自己 skill 里本来就写着 `--user`）。日志同理 `journalctl --user -u ...`。
  - **bridge healthz = `http://127.0.0.1:18765/healthz`**（不是 8788）。`version` 字段
    恒为 null（版本只在控制面），要看版本别在这儿找；契约版本看
    `behaviorContractVersion`（顶层与每个 App 必须唯一值 1 个）。
- **控制面** aliyun-hk（systemd `h-control`，nginx `ai.kidshub.cn`→127.0.0.1:18790）：
  dashboard/BYOS OAuth/vault/token-manager。**代码在 `/srv/h-control/app`**，
  `.env` 才在 `/srv/h-control`（`WorkingDirectory=/srv/h-control/app`，
  `ExecStart=/usr/bin/node /srv/h-control/app/server.mjs`）——直接 `md5sum
  /srv/h-control/lib/version.mjs` 会 No such file。同目录还堆着几十个
  `app.bak-*` 历史备份，别把备份当现役对撞。
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
- 🔴 **开通不算完成，直到权限门过**——见下一节。

## 🔴 能力对等的四层（2026-08-01 实测立）

问「租户怎样才能和 owner Bot 一个效果」时，按这四层查，**别只看权限**：

| 层 | 决定什么 | 怎么查 | 2026-08-01 实测 |
|---|---|---|---|
| 权限 | 能不能调这个 API | `verify-lark-scopes --profile tenant-standard` | 对标 owner 实测 512；租户 2–588 曾无标准 |
| 知识 | 知不知道怎么做 | 比 L0 与 owner 私有 skill 的**行数与章节** | 39:39 已对齐 ✅ |
| **行为规则** | **做得对不对** | 比 `BEHAVIORAL_RULES.md` 的**规则条数** | **owner 28 条 vs 租户 0 条** |
| 记忆 | 记不记得住 | 服务 active + **`pages` 表行数**（见下） | 9 个实例均有数据 ✅ |

**能不能做 ≠ 做得对不对。** 最典型：租户缺 `calendar:room:readonly` 订不了会议室，
但把 scope 补上它**依然不会去订**——没有规则告诉它「线下会必须挂会议室」（现 P18）。
只补权限会得到一个「有能力但不会用」的助手。

⚠️ 规则层最容易漏，因为租户**确实有** `BEHAVIORAL_RULES.md`（35 行、有标题有格式），
但那是空模板，`R01 — 一句话说清约束` 是示例占位。**只看文件存不存在会判成通过。**

### 预置规则基线与编号分段

`lib/data/default-behavioral-rules.md` 预置 24 条：

- **P01–P24 平台段**，平台可升级；**R01 起用户段**，平台永不触碰。
  合用一套编号的话，平台升级迟早覆盖用户纠正换来的规则——那才是最不能丢的。
- **P07「纠正必须晋升为规则」是发动机**，不给它规则库永远停在交付那天。
- 迁移只认「一字未改的旧空模板」，用户写过的正文绝不覆盖。
- 生效链路：真源 → `workspace/AGENTS.md` 运行镜像（每任务保鲜）→ 注入对话首部。

下放边界判据：**这条规则换个人、换个部门还成立吗？** 不成立就别下放
（绑死具体业务表的字段名/标题前缀已剔除；「所有者必须是川哥」改写成「用户本人」）。

## 🔴 记忆链路：故障不得伪装成「没什么可记」

`memory-capture` 的 `extract()` 返回值有语义区分，**改这块务必保持**：

- `''` → LLM 正常应答、判定没价值 → `skipped: nothing-worth`
- `null` → 调用失败（502/超时/网络）→ `skipped: llm-unavailable`

2026-07-31 代价：两者都返回 `''`，抽取 LLM 连续 502 共 54 次全被记成
「没什么值得记的」。某租户 161 次会话只捕获 4 条，日志里 19 次 nothing-worth
其中 16 次其实是上游挂了——**故障被伪装成正常判定，既没人查也无从补偿**。

排查记忆没积累时，先分清三件事（它们各自的证据不同）：
1. `memory-capture` 写的是 **markdown**（`memory/<uid>/wiki/**/MEMORY.md`）
2. `ai-memory` 服务管的是 **sqlite**（`memory/<uid>/db/memory.sqlite`）
3. 二者是**独立链路**，sqlite 看着空不能推出 capture 断了
   （实测 capture 全平台成功 120 次，日志关键词是 `memory captured`，不是 wrote/ok）

### ⚠️ 判断记忆有没有积累，绝不能看 db 文件大小

这些库是 **WAL 模式**，主库文件可以长期停在 **4096 字节（一个 page）** 而数据
全在 `-wal` 里。2026-08-01 我据此误判「半数租户记忆为空」并报了两次，实际
每个实例都有数据（张雨琦那个主库 4096、WAL 3.3MB、23 条 pages）。

```bash
# 对：数行数
python3 -c "import sqlite3;c=sqlite3.connect('file:/srv/h-platform/memory/<uid>/db/memory.sqlite?mode=ro',uri=True);\
print(c.execute('select count(*) from pages').fetchone()[0])"
# 也可以：把 -wal 一起算进去
du -ch /srv/h-platform/memory/<uid>/db/memory.sqlite* | tail -1
```

**文件大小从来不是数据量的可靠指标**，WAL / 稀疏文件 / 预分配都会让它说谎。

### ⚠️ 第二个判空陷阱：不传作用域时 `memory_status`/`memory_query` 恒返回 0

比 WAL 那条更隐蔽，因为它是**服务自己**报的 0，看起来权威。

```
不传参数：  memory_status → pages_all:0, pages_latest:0   ← 假的
显式传参：  workspace:"default" + project:"main"
            → pages_all:40, pages_latest:5               ← 与直读 sqlite 一致
```

根因：作用域靠「近期 hook 活动」解析（见 `memory_query` 的 inputSchema 原文），
而全租户 `observations` 表都是 0 条，所以默认作用域永远解析不到任何东西。
`lib/memory-routing.mjs` 的 `SCOPE_BLOCK` 就是为此存在。
⚠️ **归因勘误（2026-08-03 P3 实验）**：observations 全 0 的真因是 **hooks 配置
从未下发给租户**（owner 宿主装 ai-memory 时自动生成 `~/.grok/hooks/ai-memory.json`
九事件采集，平台起租户实例只写了 MCP 段）——**不是**「沙箱跑不了 hooks」。真实
生产链路实验证明 SessionStart/PostToolUse/Stop 在 bwrap 沙箱内全部正常触发
（[[feedback_unverified_attribution_becomes_lore]]）。给租户下发 HTTP 型 hooks
后 observations 可修，SCOPE_BLOCK 届时可退役（列 P3 后续）。

### 🔴 第三个陷阱：显式传 main 会漏掉 `_global`（2026-08-01 川哥真机反馈换来的）

显式作用域修好了「恒返回 0」，却挖开另一个盲区：**用户常驻偏好按 ai-memory 的
设计写在保留 project `_global`**（`memory_write_page` 的 `scope:"global"`，工具
description 自己教模型这么写，拦不住），而 `_global` 只在「省略参数的默认查询」里
被 union 进来——显式传 project **不做 union**。后果：偏好写得进、读不出，
「界面看得见、bot 不记得」（川哥的时间偏好就是这么丢的）。

**现行姿势（v2026-08-02.2 契约）**：
- **教 bot 的（SCOPE_BLOCK / h-mem / task-hint）**：`memory_query` **分两次查**
  ——第 1 次 `workspace:"default"`+`project:"main"`，第 2 次同 workspace +
  `project:"_global"`，两次都空才许说「记忆里没有」。
  ⚠️ 不教 scopes 一次搞定：嵌套对象数组模型**照着原文也抄不对**（真机取证：
  hint 里参数贴脸，grok 连试两种错误形状被 -32602 秒拒，然后**静默退回
  main-only** 查空报"未找到"——availability 页 last_accessed_at 全程未动坐实）。
  给模型的接口要用它天天在用的平铺形状。
- **代码里的（巡检/镜像探针）**：scopes 对象数组一次调用（代码不会写错），
  `global:true` 别用（实测连英文词都 0 命中）。
- 其余工具：仍显式 `workspace:"default"` + `project:"main"`。
- 页数口径：main+_global 之和（`lib/memory-health.mjs` 的 GLOBAL_PROJECT）。

⚠️ **scopes/查询里带不存在的 project 直接 RPC 报错**（不是跳过）——没写过偏好的
用户没有 `_global`，上线当晚 9/10 租户全红。现由 `ensureGlobalScope`（memory-seed，
挂 syncUserGrokMemory 必经路径）写一页「常驻个人偏好」说明预建；health 侧对
not found 容错计 0。**教训**：只在状态最富的用户（有 _global 的自己号）上验过
就发全量 → 详见 [[fix-verified-on-richest-variant-only]]。

💡 **验「bot 有没有真查到某页」认 access_count，不认它自述**：ai-memory 命中页
会 `access_count++` + 更新 `last_accessed_at`——探活污染读数的那个副作用，反过来
就是最硬的取证（自述"查了没找到"可能是范围错了，计数器不说谎）。取证窗口内
别自己跑重放查询，会污染基线。

**推论**：任何读记忆状态的代码（巡检脚本、控制面用户管理界面）**必须显式传作用域**，
否则会一直显示"记忆是空的"。查托管块也别用 `find <用户目录> -name AGENTS.md | head -1`
——租户名下有两个，`~/workspace/AGENTS.md` 是用户自己的、`~/.grok/AGENTS.md`
才是托管的，取错必然报"块全丢"。

### 🔴 查托管块必须按引擎分派判据，否则必然误报

三套 harness 的落点与 marker 完全不同。**拿 grok 判据查 kimi 用户，会一次造出
三个假故障**（2026-08-01 我就是这么误报的）：

| 引擎 | 托管块文件 | marker | 块名 |
|---|---|---|---|
| grok | `~/.grok/AGENTS.md` | `:start` | `h-mem-scope` `h-method` `h-identity` `ai-memory` |
| kimi | `~/workspace/AGENTS.md` | `:begin` | `h-soul` `h-global` `h-rules` `h-method` `h-mem` `h-feishu-docs` |
| omp（智谱/MiniMax） | `~/workspace/AGENTS.md` | `:begin` | 同 kimi（`lib/omp-harness.mjs`） |

对应的三条安装腿（`bridge.mjs`，改记忆链路前先读）：

```
kimi : ensureUserMemory → ensureKimiMemoryMcp → ensureMemoryScaffold → ensureAgentsBlocks
omp  : ensureUserMemory → …                                          → ensureAgentsBlocks
grok : ensureUserMemory → ensureUserMemoryMcp                        → ensureMemoryRouting
```

**三条腿都完整，不存在"某引擎没有记忆"。** 所以下面这三个现象出现在 kimi/omp
用户身上时**全是正常的**，别当故障：`.grok/AGENTS.md` 里没有 grok 块（它不读该
文件）、`grok-sync-state.json` 为 `{}`（kimi **无 grok 同步腿**，wiki 文件自己建）、
`memory routing` 日志 0 条（它压根不走 `ensureMemoryRouting`）。

### 🔴 grok 原生记忆四坑（2026-08-02 源码 0.2.117×生产 0.2.118 真机探针，动导出腿/查原生检索前必读）

外部直改 `.grok/memory/*.md` 是**官方接口**（watcher + session 启动全量重扫，探针 PASS：写入→新进程→memory_search score 1.00）。但有四个坑：

1. **memory_search 查询词含连字符 = 静默空结果**（FTS5 把 `-` 解析成列过滤 → 语法错被 `unwrap_or_default` 吞）。教模型用空格分隔。
2. **脚手架连坐过滤**：chunk trimmed <500B 且含 `Add any cross-project preferences here` 等标记 → 搜索时整 chunk 被 `is_scaffold_template` 滤掉。**往 MEMORY.md 写内容必须整文件重写并剔除脚手架行，追加式不可用**。
3. **中文纯词查询废**：FTS5 默认 unicode61 把整段 CJK 压成单 token（真机：同份内容 ASCII 查得到、「听雨轩」查不到）。向量腿 0.2.118 有实现但 **embedding 默认 `model=None`=出厂关闭**，生产 `chunks_vec` 恒 0 行 = FTS-only。
4. **chunks 行数不是索引更新指标**（小文件同 chunk 原地 UPDATE）；验收认 `updated_at`/`access_count`/FTS 直查。⚠️ python `immutable=1` 不读 WAL。

另：原生写侧 session 归档门槛 **≥3 条真实用户消息**——一发式 bot 任务永远触发不了（租户原生 MEMORY.md 全空是 by design 的休眠，不是故障）；dream 只重写 workspace MEMORY.md 不碰 global；`list_memory_files` 只认 global/workspace MEMORY.md + sessions/*.md 三类（独立文件名进不了启动重扫）。完整地图：bridge 仓 `docs/architecture/2026-08-02-memory-reverse-flow-and-truth-reconciliation.md`。

### 两个已知非故障（巡检遇到直接跳过）

| 租户 | 现象 | 定性 |
|---|---|---|
| `u-aca292be3f`（AI 专家） | dev198 上没有 ai-memory 实例 | **设计如此**：B1 灰度已迁 Mini。Mini 记忆 parity 已于 2026-08-01 收口，巡检必须查 Mini 当前实例，不能继续拿 dev198 的缺失当故障 |
| `u-dec457e69d`（kimi 订阅） | 用 grok 判据查会显示"托管块全无" | **记忆本身是好的**（六个 kimi 块全齐、mcp.json 在、实例 running、latest 页向量 100%）。川哥 2026-08-01 拍板挂起是因为 **kimi 整体适配优化没做透**，属产品优先级，**不是它坏了** |

### ✅ 巡检工具：`ops/memory-health-audit.mjs`（别再手工查）

上面这些判据全部固化在里面了，按 engine 自动分派，不用再记哪套对哪套。

```bash
# dev198 上跑（非交互 SSH 必须先导 PATH）
export PATH=/home/chuan/.local/node/bin:$PATH
cd ~/feishu-grok-bridge
node ops/memory-health-audit.mjs             # 人类可读
node ops/memory-health-audit.mjs --json      # 给控制面/CI 消费
node ops/memory-health-audit.mjs --uid u-x   # 只查一个
node ops/memory-embed-probe.mjs [--uid u-x]  # 端到端探针（写→向量→语义检索→删净，会写库）
# ⚠️ audit 没有 --probe 参数（2026-08-02 实测：未知参数被静默忽略、照跑普通巡检
# ——「通过」和「没执行」长一样）。端到端探针是上面这个独立脚本。
```

退出码：`0` 全绿 / `1` 有租户不达标 / `2` 巡检自身失败。
⚠️ 别用 `node … | grep` 之后取 `$?` —— 那是 grep 的退出码，我就这么误读过一次。

每行输出的含义（`页87/latest7=磁盘 向量7/7 检索5(RRF)`）：
- `=磁盘` 表示**服务读数与直读 sqlite 同口径对撞一致**。两条独立路径读出同一个数
  才算证据；不一致会显式报「服务视图与磁盘脱节」。
- `向量 a/b` 是**作用域内** latest 页的向量覆盖，b−a>0 才是真故障（旧版本行没向量
  是 by design）。
- `检索 N(RRF)` 带 RRF 标记说明 FTS + 向量两条腿都在参与融合排序。

**写这类工具时最该防的坑：空值不许当通过。** 第一版 `mcpCall` 返回的是 MCP result
信封（真数据在 `content[0].text` 里**还套一层 JSON，不解包**），我直接读 `.counts`
恒为 undefined，页数渲染成 `?`，而 `ok` 判定没算这项 —— **报告 10/10 全绿，两个核心
指标其实是空的**。现在判定里每个展示指标都有形状断言，缺值即失败。

改完必须双向验收：负向用假环境（脚本认 `H_MEMORY_ROOT`/`H_USERS_ROOT`/`H_USERS_JSON`
三个 env，不碰生产）确认退出码 1 且精确点名缺失项；正向锚补齐后确认对应项转绿而
其余仍红。只做正向的话，"全过"和"没执行"分不清。

## 🔴 LLM 抽取链路与代理陷阱

```
bridge memory-capture → 127.0.0.1:18241 (ai-memory-llm-proxy)
                          ├ PRIMARY : Studio Ollama  192.168.61.66:11436（有线+雷电）
                          └ FALLBACK: 火山方舟
```

- **PRIMARY 必须走有线**：`dev198 →(有线)→ Mini 192.168.61.66 →(雷电)→ Studio`。
  Mini 上由 `com.cc.studio-ollama-lan` LaunchAgent 维持转发；连接 0.001s vs WiFi 0.045s。
  **不要用 `10.9.1.x`**（WiFi 浮动段）。
- **`no_proxy` 必须写具体 IP，不能写 CIDR**：Python 的 urllib 与 httpx **都**只做
  字符串后缀匹配，`192.168.0.0/16` 对它们完全无效，内网请求照样被 Xray 接走并回
  **空 body 的 503**。详见 [[feedback_no_proxy_cidr_not_honored_by_urllib]]。
- **超时预算要放得进调用方的耐心**：proxy 启动会自检并打
  `timeout budget ok: worst-case 42s < caller 45s`。现为 PRIMARY 12s×(1+1 重试)
  + FALLBACK 18s；bridge 侧是 `AbortSignal.timeout(45s)`。改任一个数都要重算这道不等式。
- 判断 primary 是否真在用：`journalctl --user -u ai-memory-llm-proxy | grep -c 'primary ok'`。
  **计数为 0 = 从来没通过**，那是配置/路由问题，别往「掉线/抖动」方向查。
- **「primary ok」也可能是空壳**（2026-08-02 实锤）：Ollama 对坏死模型返回
  HTTP 200 + 信封完整 + `content:""` + 0 token + created=Go zero time 的空壳应答。
  proxy 已修（33c0f74 起 content 空即判失败走 fallback），但排障判据要记住：
  **探针必须断言返回内容本身**，「服务 active + 模型 loaded + 200」三样都真不代表
  模型能吐字。同症状跨机出现先做**换模型对照**（冷启动第一发就空 = 模型 blob 与
  Ollama 版本不兼容，重启不救、换模型立好；qwen2.5:3b/qwen3:4b 在 0.31.2 都中过，
  qwen2.5:7b 正常）。详见 [[feedback_hollow_200_needs_payload_check]]。
- **D3 冲突检测（memory-conflict.mjs）也吃这条 LLM 链路**：挂在 pushMirror，
  指纹门控（内容没变零调用）+ 失败 10 分钟退避。它的 lastError 会显示在用户后台
  「记忆校准」区块——看到「检测暂不可用」先查本节的 proxy/Ollama，不是 D3 坏了。
  - 查某租户检测状态：`cat /srv/h-platform/memory/<uid>/conflict-state.json`
    （open/dismissed 在 `conflicts`，已判决历史在 `resolved`，`lastError` 非空=LLM 挂）。
  - 手动触发一轮检测+推送（不等 debounce/30min）：buildMirror → detectMemoryConflicts
    →（清 `lastError`+`lastScanAt` 可绕退避）→ conflictsForMirror 塞 `m.conflicts`
    → pushMemoryMirror。样例脚本思路见 2c30fa0b 会话 scratchpad `accept-d3-detect.mjs`。
  - 后台「记忆校准」区块**只在有 open 冲突或有历史时出现**——用户说「没看到入口」
    先查 conflict-state 是不是本来就空，别当渲染故障排。
  - 判决执行由 memory-ops 队列下发（10s 轮询），日志关键词 `memory conflict resolved`；
    excerpt 乐观锁失败（用户手改过）会回报「内容已变化」并自动重扫，属正常防御。
  - **v1.37.0 起记忆页是混合版**（A 分组清单 + B 常驻编辑窗/仪表带 + C 软视觉）：
    校准收件箱在仪表带下方首屏内；仪表「待校准」有待办变暖色、点击滚到卡。四格口径
    ＝ mirror.pages 拆分（含 /sessions/ 的算存档）+ vectors + conflicts.open；侧导航
    数字是 bridge digest 的**库全量页数**（含非镜像页），与 tab 内不同口径是 by design。
    旧 DOM id（memCnt/memVec/memLifecycle/memCognitive/memKind/memPinned）已死，
    巡检脚本别再引用；meta 编辑改圆片（状态在 MEM_META，memSave 读它发 op）。
  - **v1.37.1 判决有进度三件套**（点击即在途 spinner／在途期他卡禁用／完成 5 秒绿横幅）。
    语法门脚本已固化 `ops/memory-pane-gate.mjs`（改 html.mjs 记忆页后必跑：script 块
    编译＋DOM 锚＋「先渲染在途态再发请求」顺序断言）。
  - **给用户造演示冲突的安全流程**（v1.37.1 验收实证）：直改 conflict-state.json 加
    `conflicts[<纯hex id>]={status:'open',...}`（id 必须匹配控制面 `/^[0-9a-f]{6,16}$/`），
    然后**绕过 detect** 手动 buildMirror + conflictsForMirror 塞 conflicts 推
    `/internal/memory-mirror`（跑 detect 会按指纹重扫把手工条目洗掉）。假 excerpt 四个
    按钮都安全——替换路径会被逐字乐观锁拦下。收尾删记录再推干净 mirror；等用户判决
    可挂 Monitor 轮询 status 自动清场。
  - **模拟租户会话做验收**：`document.cookie` 写不掉已有的 HttpOnly hsid（同名新值
    排后，服务器正则取第一个）——首次登录能骗过是因为当时还没有 HttpOnly 旧值。
    正路：服务器侧铸 `/go/<autoLogin token>`（`base64url(JSON{t:'go',uid,exp})+HMAC`，
    SESSION_SECRET 不出服务器），访问后由服务器 Set-Cookie 覆盖。抽验他人租户时
    只读结构状态（元素/数字/健康级），不截图不记录记忆正文（隐私墙）。

### 权限现状已进 context-report（2026-08-01）

`buildContextReport(uid)` 返回里新增 `larkScopes`，随每任务的上下文报告推给控制面：

```js
larkScopes: { appId, reachable, ok, appScopeCount, tokenScopeCount, requiredCount,
              missingByDomain,            // 按域汇总，不平铺几百个 scope 名
              needsConsole,               // 只能去开发者后台勾
              needsReauth,                // 用户重新点授权卡即可
              forbidden }                 // 持有人事/薪酬等不该给 agent 的域
```

⚠️ **为什么不是加在 `/internal/auth-status`**：那个端点的数据全部来自控制面自己的
store，而 scope 是 dev198 上 lark-cli 的本地状态；控制面在公网、bridge 在内网，
**只能 bridge 往外推**。context-report 本来就是 per-uid 的能力报告（已含
skills/memory/trace/friction），权限属于同一个问题，不该另开上报通道。

带 15 分钟缓存（`H_SCOPE_CACHE_MS`）——探一次要起两个 lark-cli 子进程，而 scope
只有人去后台改才会变；失败单独用 60 秒短 TTL（`H_SCOPE_CACHE_ERR_MS`），
避免 lark-cli 挂掉时每次报告都卡在超时上。

**给川哥的后台操作清单**：[`tasks/飞书权限开通.md`](../../../tasks/飞书权限开通.md)
（mycc 仓，含最小必做集 + 每个 App 的姓名部门 + 按域折叠的 scope 标识符）。
⚠️ 飞书**未在 API 暴露权限的中文名**，lark-cli 也没有 scope→中文名映射，
清单里的中文是按语义写的说明，权威标识始终是 scope 字符串本身。

## 🔴 开通权限门：标准包对标（2026-08-01 立）

**开通流程的最后一步必须是权限巡检，缺必备域不算开通完成。**

```bash
# dev198 上，或把 ops/ 拷到临时目录跑（纯只读，不动生产）
node ops/verify-lark-scopes.mjs --profile tenant-standard --uid <uid>
```

### 为什么要有这道门

2026-08-01 全量导出 owner 与 10 个租户的应用侧 scope，分布是：
**owner 334；租户 2 / 97 / 146 / 156 / 168 / 170 / 198 / 481 / 588 / 588。**
（这是 2026-08-01 上午的观测值；当天下午 owner 已批量开通到 512，见下方「口径演进」）

不是「租户比 owner 少」，是**根本没有标准**：有人开通时全勾（两个 588 的超出项
完全一致，同一份全选模板），有人手挑十几个，还有人只剩 2 个就算「开通完成」了。

后果是能力随机缺失且不可预期。张雨琦 Bot 约日程连续失败三轮授权卡，根因就是
应用侧压根没配 calendar——**用户点多少次授权卡都不会好**。而平台侧当时答不出
「这个租户现在到底有哪些权限」，排查绕了一大圈。

### 标准包边界（2026-08-01 定稿，口径已换过一次）

**`tenant-standard` = 与 owner 完全一致**（实测 **512 项 / 43 个域**）。

不再由平台划「标准域/按需域」两档——owner 那 512 项已由川哥对着飞书全量
62 个域逐条审定，平台再切一刀只会引入第二套标准，而目标恰恰是**能力对等**。

> 口径演进：初版是「平台自划 20 域 274 项，以 owner 334 为基线切分」。
> 2026-08-01 川哥导出全量权限、审定后批量开通 owner（334→512），基线随即
> 替换为 owner 实测值。**看到 274 / 334 这两个数字的文档都是旧的。**

**🚨 禁止域 11 个**（`FORBIDDEN_DOMAINS`）：

| 域 | 说明 |
|---|---|
| `corehr` | 人事核心（薪酬档案**写**、调薪、离职、员工全量档案） |
| `payroll` | 薪酬发放 |
| `security_and_compliance` | 组织级审计日志 |
| `mdm` | 企业设备、法人银行账户 |
| `attendance` / `attendance_machine` | 考勤（含加班审批**写**）、打卡记录写入 |
| `acs` | 门禁出入记录，**可写** |
| `passport` | 登录凭据，含 `password:full` |
| `ehr` | 人力资源档案 |
| `financial_access_platform` | 财务数据，**可写** |
| `verification` | 企业认证信息 |

⚠️ **`hire` / `performance` / `okr` / `admin` / `trust_party` 曾在此清单里，
被川哥否决并给出业务理由（H 平台要协助招聘、绩效评价、目标制定），不要再加回来。**
它们属人事域，但**权限给了不等于使用边界也开了**——代人查看他人绩效仍受隐私墙
约束，那是行为规则该管的事，不在权限清单里解决。

这些 Bot 会把上下文送进外部引擎（Grok），进去就收不回来——撞隐私墙铁律。

### 三种判定，处理方式完全不同（别搞混）

| 判定 | 含义 | 怎么办 |
|---|---|---|
| ❌ 应用未配置 | 应用侧就没勾 | **只能去开发者后台勾 + 管理员审批**；催用户点授权卡是无效的 |
| 🔸 待重新授权 | 应用侧有、token 没拿到 | 让用户重新点一次授权卡即可，不用动后台 |
| 🚨 越权域 | 持有禁止域 | 去后台取消勾选；确有业务需要则单独记录例外 |

⚠️ **权限无法通过 API 申请**（三方查证：lark-cli 全命令树无 apply/grant/authorize；
它调的 application v6 端点源码写死 `http.MethodGet`；飞书官方文档要求后台配置 +
企业管理员审批）。所以这套工具只能**发现**缺口，修复必须人去后台。

### 相关文件

- `ops/lark-scope-profiles.mjs` —— 标准包/禁止域定义，三个 profile
  （`tenant-standard` / `calendar-min` 约日程 / `meeting-room` 订会议室）
- `ops/data/lark-scope-baseline.json` —— owner 基线快照（只有 scope 名，无 appId/token）
- `ops/verify-lark-scopes.mjs` —— 巡检入口，`--json` 出结构化结果
- `tasks/飞书权限开通.md`（mycc 仓）—— 全员行动清单，含最小必做集与姓名部门
- `4-Assets/SOP/lark-scopes/`（mycc 仓）—— 批量导入 JSON + 用法说明

### 基线的两档：证据等级不同，别混着用

`lark-scope-baseline.json` 里有两份数据，**不是一回事**：

| 档 | 项数 | 证据 |
|---|---|---|
| `user`（= 顶层 `scopes`） | 512 | **已验证** · lark-cli 实测 |
| `tenant` | 668 | **未验证** · 来自批量导入配置 |

`lark-cli auth scopes` **只能查 user 档**（返回 `tokenType: user`，命令无任何指定
token 类型的参数），所以 tenant 档实际开通与否，**平台没有任何手段能读到**。
数据里各带一个 `evidence` 字段说明这件事，测试也钉住了「顶层 scopes 必须等于
user 档」，防止将来被悄悄改成两档合并。

这不是学究气——踩过的坑是读部门时缺 `contact:user.department:readonly` 的
tenant 档，接口仍返回 `code=0`，字段却**静默消失、不报错**。

### 基线会过期，怎么刷新

owner 的 512 是**快照**。刷新流程：

1. 川哥从后台「批量导入/导出权限 → 导出」拿全量（那份带 tenant 档）
2. 剔除 11 个禁止域 → `4-Assets/SOP/lark-scopes/lark-import-full-safe.json`
3. 按它批量开通 owner，管理员审批
4. `lark-cli auth scopes --json` 实测导出，**与预期做集合双向差集**
   （数量相同不等于内容相同，必须比交集与两侧差集）
5. 写回 baseline 的 `scopes` / `byDomain`，tenant 档另存并标 `未验证`

**不要手工往 baseline 里加条目**——那样就分不清是飞书新增还是有人放宽了边界。

⚠️ **换基线会让所有租户的「缺口数」变大，那是尺子换了不是问题恶化。**
2026-08-01 从 274 换到 512，缺口从 120–272 变成 342–510，要跟川哥说清楚。

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

### owner 私有 Skill 升 L0 的可信发布链（2026-07-28）

- `workspace/.grok/skills`、`workspace/leader/skills` 只属于 owner 私有层；在那里创建文件，
  **不等于**用户平台已有 L0。Bot 未拿到控制面证据时禁止说“已同步用户后台”。
- L0 唯一真源是控制面 `/srv/h-control/data/skills.json`。owner 私有 Skill 必须先泛化：
  删除姓名、邮箱、飞书标识符、内部域名/路径、组织专属会议室与案例；人员和会议室改为
  运行时查询；依赖只保留平台真实存在的 Skill。
- 发布固定走 `POST /internal/skills-publish`，只能写 `platform`、`createdBy=admin`，复用
  `skillsStore.upsertContent()`；同名跨层禁止覆盖。L0/L1 过危险扫描与共享隐私扫描，L2
  个人层不受共享隐私规则误伤；控制面本地 `scrub-terms.local.json` 追加环境特有词条。
- 执行面命令：`scripts/publish-l0-skill.mjs --file <SKILL.md> --summary <简介>`。它必须等到
  控制面记录、`.skills-manifest.json`、`shared/skills/<name>/SKILL.md` 三方 sha256 一致；
  再用至少一个 Grok 用户和一个 Kimi 用户的真实 dashboard 验证 `sharedSkills` 可见。
- 完成证据缺一不可：控制面 `platform/active/installedSha`、执行面 manifest、共享文件哈希、
  两类真实用户后台。只检查目录、只跑静态扫描或只看 Bot 自述都不是验收。
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

## 🔴 判「这条记录是不是 owner」只认 appId 锚，不认 uid 长相（2026-08-08 栽过）

**owner 根本不在控制面 users.json 里。** 判别一条命令：

```bash
# owner 真值：bridge healthz 里 kind=owner 那条（它的 uid 是 null，因为不在注册表）
ssh dev198 "curl -s --noproxy '*' http://127.0.0.1:18765/healthz" | python3 -c "
import sys,json
for appId,a in json.load(sys.stdin).get('apps',{}).items():
    if a.get('kind')=='owner': print('owner appId=', appId, 'uid=', a.get('uid'))"
```

2026-08-08 我在同一轮里从字符串长相认错两次，第二次是川哥当场拦下的：

| 我看到的 | 我的结论 | 真值 |
|---|---|---|
| `botName=智能助手_产品专家` | 这条是「产品专家」角色 | botName 只是 Bot 名，与角色归属无关 |
| `uid=rayman.chen`（可读账号名，不是 `u-<hash>`） | 这条是 **owner** | 可读 uid 只说明**开通时管理员预分配过**；它的 appId 是 `cli_a970…1bb3`，而 owner 是 `cli_a9f1…1bc7` —— 它是**普通租户** |

⚠️ **最危险的不是认错，是据此推翻既有记录**：我当时写下「skill 说 owner 不参与
placement、lease 恒 null，那条已过期」——其实没过期，是我把**租户的租约**认成了
owner 的。错误从一次操作固化成了知识库里的公论。拿新观察推翻既有记录前，先自问
「会不会是我认错了对象」。详见 [[feedback_identifier_shape_is_not_identity]]。

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
- 🔴 **改了 L0 但沙箱里没变 → 一定要看 `install fail` 而不是"再等等"**：装前复扫
  会**永久**拒收命中脏词的正文，每分钟重试每分钟失败，控制面侧看起来一切正常
  （store 已更新、`/internal/skills` 也吐新 sha），只有 bridge 日志在报。
  实证：`lark-shared` 因正文里一句 owner 专属文案含 `127.0.0.1:10808`（命中
  「内网地址」类），**自 07-25 起任何更新都装不上，卡了 5 天没人发现**——
  是我给它加新章节时才暴露。核对一行：
  `journalctl --user -u feishu-grok-bridge --since -10min | grep "install fail"`。
  意味着：**共享层正文里不许留任何本机/owner 环境细节**（路径、代理端口、zshrc），
  它们既是错误指引，又会把这个 skill 永久钉在旧版本上。

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

### 全用户历史补偿与向量一致性（2026-07-27 生产事故）

- **控制面“几分钟前更新”只证明镜像刚推，不证明源记忆刚写**。排障必须分别核对：
  聊天历史最后完整 `user → assistant`、源 `wiki/**/MEMORY.md`、SQLite 最新页、
  `page_embeddings`、控制面 `*.mirror.json`；不能拿任一层的时间戳替代整条链路。
- 历史补偿的 `limit` 必须作用在“**全历史中过滤出的未处理交换**”上，不能先截
  最近 N 轮再查 ledger。否则积压超过 N 时，更早记录会永久落在扫描窗口之外。
  ledger 只保存交换哈希、权限 `600`，不保存 uid/open_id 映射或聊天正文；临时
  `error/no-target` 不记账，下一轮继续重试。
- `captureExchange` 可把助手回复当作“任务完成结果”的证据，但偏好、决定和待办
  仍必须来自用户明确表达，禁止把助手建议反写成用户事实。
- **Kimi 没有 `.grok/memory` 不等于没有 ai-memory**。`syncUserGrokMemory` 即使无
  Grok 原生目录，也必须确保用户实例存在并执行最新页向量补算；禁止在源目录检查处
  提前 return。
- 网关捕获直接更新 wiki 文件后，ai-memory 文件监听器还需要短暂落库时间。立即
  embed 会抢在新 `is_latest=1` 版本产生前，表面成功、重启后却重新显示缺向量。
  历史补偿和实时捕获统一走短 debounce，再执行同步、向量、镜像和摘要刷新。
- **全用户验收矩阵**：每个活跃 uid 的 `历史交换数 = ledger 已处理数`、pending=0；
  SQLite 所有 `is_latest=1` 页均有向量；控制面镜像 `missing=0`；Bridge 所有 App
  connected 且 `lastError=null`。最后必须重启后再查一次，避免把 WAL/监听竞态当成功。

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

### 🔴 控制面是【子树部署】——它不能引用仓根 `lib/`

两个子系统的部署形态不对称，这是最容易漏、且本地全绿的一类缺陷：

| 子系统 | 搬运方式 | 后果 |
|---|---|---|
| Bridge（dev198 / Mini） | **整棵仓库树** | `lib/` 引 `../control-plane/lib/` 安全（多处在用） |
| 控制面（aliyun-hk） | **只 rsync `control-plane/` 子树** | 仓根 `lib/` 从不发；`control-plane/` 引 `../lib/` = 生产 `ERR_MODULE_NOT_FOUND`，服务直接起不来 |

2026-08-06 真实拦截：`84cbf80` 给 `control-plane/server.mjs` 加了
`'../lib/schedule-contract.mjs'`。**`npm test` 953 全过、`node --check` 全过**——因为开发机上
那个路径真实存在。隔离实例第一次启动就崩，才暴露出来。修法是把该模块挪进
`control-plane/lib/`（跨界方向回到既有约定），并加守卫
`control-plane/test/deploy-boundary.test.mjs`：`control-plane/` 内任何 import 解析到子树之外
即红并点名文件，已接进 `npm test`。

⚠️ **起隔离实例时不要给它补一个仓根 `lib/` 让它跑起来**——那等于把缺陷掩盖掉。
正确姿势是**只发 `control-plane/` 子树、根下不建 `lib/`**（用 `ls <隔离根> | grep -c '^lib$'` = 0
留证），它能自己起来才算自包含。**隔离实例的价值取决于它复刻生产形态的程度。**

顺带：控制面**没有部署脚本**（`ops/*.sh` 里 h-control 零命中），全靠本节这几行手敲 rsync。
所以任何「还要额外发某个文件」的前提，写在交接文档里一定会丢——必须变成代码守卫。

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
rsync -az --no-owner --no-group control-plane/announcement-templates/ aliyun-hk:/srv/h-control/app/announcement-templates/
ssh aliyun-hk 'chown -R h-control:h-control /srv/h-control/app && cd /srv/h-control/app \
  && node --test test/*.test.mjs && systemctl restart h-control'
```

⚠️ **chown 不能省** —— root 写出的文件服务自己改不动。

⚠️ **新增顶层目录必须自己加进这张清单**（2026-08-08 差点漏）：这几行 rsync 是**逐项
枚举**的，`announcement-templates/` 这类新目录不会自动跟着走。漏了的后果是运行时
`ENOENT`——而且**只在那条代码路径真被执行时才爆**（模板只在事故发生时才读），
本地全绿、部署全绿、healthz 全绿，可能几周后才炸。加新目录时同步改这里。

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

### F3.1 跨用户一次性提醒（2026-08-05）

- 身份边界：`open_id` 按 App 隔离，不能把 A 应用拿到的 `open_id` 交给 B 应用直发；同一开发者体系内跨 App 收件人使用 `union_id`，但**发送 Bot 的应用可用范围必须覆盖目标用户**。
- 授权边界：跨用户提醒必须有显式收件人授权记录；执行时固定使用创建者 Bot 的应用身份发送，禁止静默改由 owner Bot 或其他 Bot 代发。
- 飞书错误 `230013`（目标用户不在应用可用范围）属于**永久阻断**，不得重试风暴或假报“提醒已创建/已送达”。用户提示必须明确：先在飞书开发者后台发布应用新版本，并把目标用户加入应用可用范围，随后再重新创建或重试。
- 真机验收必须留下五元证据：来源 Bot、创建者、目标收件人、`receive_id_type=union_id`、飞书 `message_id`。只看到 timer 到点、Runner 完成或本 Bot 自提醒成功，都不能证明跨用户提醒成功。
- 直发探针必须捕获 SDK/Axios 异常，只打印 HTTP 状态、飞书业务码和脱敏后的短消息；严禁把原始错误对象交给 `console.error`、未捕获异常或 Node 默认打印器，否则 `err.config.data` 可能展开临时 token 或应用凭据。

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

### B3 长任务闭环验收（2026-07-31）

`proactive-acceptance` 只能证明 Runner、主动送达和飞书 ACK，**不能替代**真实用户消息
触发的「前台约 120 秒后转后台、会话底部出现新完成卡」视觉验收。

开发侧用 `scripts/verify-b3-long-task.mjs` 读取 TaskSessionLog 与 Delivery Outbox，必须同时满足：

- `task_accepted.source=feishu`；
- `background_yielded.elapsedMs >= 120000`；
- `task_completed.background=true`；
- `delivery_started.background=true`；
- `delivery_acked.inline=false` 且存在飞书 messageId；
- 对应 Outbox 已 ACK，且 Outbox messageId 与 TaskSessionLog messageId 完全一致；
- 当前 scope pending/retrying 为 0；
- 事件顺序为 accepted → yielded → delivery_started → delivery_acked → completed。

脚本输出只含脱敏 task/uid/message 指纹，不输出 prompt、reply、open_id、appId、token 或租户路径。
脚本全绿仍只代表后端闭环；最终必须由用户截图确认**新卡位于会话底部，而不是旧卡原地更新**。
- 尉鸿轩类「查通讯录」任务挂 15 分钟到超时 = kimi 在等 lark-cli 设备码授权（digest
  里有 open.feishu.cn/page/cli 授权链接）。F5.2 后链接会送达，用户授权一次即通；
  再挂死考虑 lark-cli 预授权或缩短设备码等待（观察项 A4）。

## 全用户配置与任务模式契约（2026-07-28）

这套契约属于平台能力，**必须覆盖 owner 与每个登记用户**，禁止只在当前测试账号或
单一引擎上打补丁。

1. **任务模式只有一个分类真源**：Bridge 完成 `short/full` 分类后把 `taskMode`
   传给 Runner；Grok、Kimi、OMP 必须消费同一结果，禁止任一 Runner 再硬编码 `full`
   或自行重分类。纯寒暄可走 `short`；附件、长文本、代码路径、动作型任务强制
   `full`；不确定时保守 `full`。
2. **debounce 附件状态用 OR 合并**：同一批入站只要任一消息含附件，合并结果就必须
   保留 `hasAttachment=true`，不能被后到的纯文本覆盖，否则附件任务会误入 `short`。
3. **四份用户配置幂等补齐**：每个登记用户都必须具备 `SOUL.md`、`.grok/AGENTS.md`、
   `workspace/AGENTS.md`、`workspace/BEHAVIORAL_RULES.md`。只创建缺失文件，不覆盖人工
   编辑；托管块只更新自己的边界内容。生产迁移必须遍历全部登记用户，不只修 owner
   或当前在线账号。
4. **脚手架不能依赖某个引擎启动**：`readProfiles`、镜像刷新和用户加载路径都要先
   调用统一 scaffold，保证未启动 Grok 的 Kimi/OMP 用户也能在管理台看到并编辑完整
   配置。
5. **规则必须真实进入三引擎上下文**：Grok 直接读取行为规则；Kimi/OMP 通过
   `h-rules` 托管块与确定性 system prompt 注入。管理台“文件存在”不等于 Runner
   已消费，验收必须检查实际拼接路径或 Runner 测试。
6. **管理台保存按异步队列验收**：保存后先等待操作完成，再等待并读取新镜像；禁止
   保存后立刻加载旧快照并把新内容覆盖回去。失败要显示真实操作状态，不能假成功。
7. **Grok 记忆编辑双写且可回滚**：管理台编辑需同步原生记忆源与 ai-memory；任一侧
   失败就回滚，避免双真源分叉。ai-memory 自动生成的 `tier` 等元数据只属于索引层，
   写回原生源前必须剥离。
8. **全用户验收只报匿名矩阵**：至少输出登记目录完整度、在线 App 数、错误数、镜像
   完整度、pending 操作、测试总数与本地/生产源码哈希。禁止输出 uid/open_id、配置
   正文、Token、授权链接或对话内容。

最新基线（人格拓扑提交 `e766501`）：专项 `26/26`、Bridge 全量 `228/228`、控制面
`48/48`；6 个用户目录四项配置完整且索引 `24/24`，5 份在线用户镜像 `20/20`，
用户界面暴露运行托管块 `0`；5 个用户 Bot + 1 个 owner Bot 在线、错误 0，行为契约
唯一版本 `2026-07-28.7`。真实 Grok/Kimi 配置理解探针均 `8/8`，Kimi 轨迹必须为
`kimi-code/k3 → k3`。

### 人格与规则配置拓扑（2026-07-28 生产教训）

1. **按内容职责设真源，不按加载顺序抢优先级**：称呼、人设、语气和做事偏好只认
   `SOUL.md`；跨项目通用约定认 `~/.grok/AGENTS.md`；当前项目规则认
   `~/workspace/AGENTS.md`；纠错和事故沉淀认 `BEHAVIORAL_RULES.md`。禁止在其它文件
   重复称呼或人设。
2. **四份文档必须互相可导航，但索引不能进入编辑框**：每份真实文件都维护
   `h-profile-index`，说明四类文件路径、内容归属和冲突处理；用户平台 textarea 只展示
   可编辑正文，索引关系另用只读说明展示。必须同时剥离 `h-profile-index`、`h-soul`、
   `h-global`、`h-rules`、`h-method`、`h-mem` 等托管块，避免用户编辑平台生成副本。
3. **默认模板不能替用户决定称呼**：新用户默认直接称“你”，禁止硬编码“老板”“川哥”
   或任何姓名。存量迁移只替换与旧默认模板完全相等的正文；宽泛搜索替换会毁掉用户主动
   写入的业务语义和个性化内容。
4. **逻辑统一不等于正文强制相同**：所有用户共用同一拓扑、优先级、保存和 Runner 注入链；
   用户主动清空或自定义的可编辑正文仍是合法选择，禁止为追求矩阵一致而覆盖。
5. **保存闭环必须是写入 → 刷新镜像 → 回读新镜像**：保存时保留平台托管块，并把整个
   同文件 read-modify-write 放进 per-file mutation queue。只看到接口成功或磁盘文件存在，
   都不能证明下一轮模型会收到新配置。
6. **三引擎消费链分别验真**：Grok 每任务确定性拼入四源规则；OMP 使用
   `--append-system-prompt`；Kimi 每任务刷新 `workspace/AGENTS.md` 的四源运行镜像。验收提示
   必须带随机 nonce，并要求模型回答称呼、四份真源与冲突规则，防模型凭常识蒙对。
7. **验收同时查静态矩阵与真实消费**：静态侧查 `24/24` 索引、界面镜像 `20/20`、
   可编辑工作区称呼泄漏 `0`、旧默认称呼 `0`；动态侧至少各跑一次真实 Grok/Kimi Runner，
   查回复、`task_begin/task_end`、模型字段和 Bot 送达。用户明确设有静默窗口时，窗口内只做
   不送达 Runner 探针；主动送达必须遵守 `notBefore AND nextInbound`。
8. **“保存后被恢复”先分 UI 边界与真实写入**：先查 Bridge `memory op ok`、源文件
   修改时间/SHA256、控制面镜像哈希。真实文件和镜像一致时，不得宣称数据丢失；检查是否把
   服务端必然重建的托管块放进了 textarea。修复必须在共享 `profile-topology`，禁止按 uid
   特判；上线后由 Bot 主动通知用户，用户只做最终页面体验确认。

## 全用户运行机制契约（2026-07-28）

1. **共享层单一实现**：`short/full`、debounce、session queue、自行转后台纠偏、私聊
   120 秒后台移交、最终成功/失败卡、权限申请与自动续跑、TaskSessionLog、记忆触发、
   错误脱敏必须在 `startApp` 后的共享路径或共享 `lib/` 实现。
2. **owner/user 用户体验同约**：owner 与登记用户的凭据、沙箱、隐私边界允许不同；同一
   chat type 的用户可见行为不得不同。群聊可因多人语义禁用后台移交，但私聊不能再按
   owner/user 分叉。
3. **引擎差异只留适配层**：Grok 可处理 sticky session/冲突 mint，Kimi 可刷新短 Token/
   自动续跑，OMP 可适配 provider/model；Runner 返回后必须统一进入
   `runWithSelfBackgroundGuard`、`deliverFinalResult`、日志、记忆和失败处理链。
4. **禁止 per-user patch**：不得在产品代码中固化 `uid`、`appId`、姓名、测试账号或 Bot
   名称；一次性运维脚本不得演变为长期产品逻辑。
5. **版本化与匿名验收**：契约版本只在 `lib/bot-behavior-contract.mjs` 定义；`/healthz`
   顶层与每个 App 必须一致。发布前跑契约测试、全量测试、语法/凭据检查；发布后只报
   App 总数、引擎数量、在线/错误数、契约唯一版本数，不输出用户标识。
6. **主动真机闭环**：遍历所有登记用户的全部 Bot，逐个使用真实 Runner 验真；必须由每个
   Bot 主动向其绑定用户发送验收卡，不得要求用户重发、回复“继续”或另行触发。缺权时主动发
   权限卡，授权后自动续跑。若用户明确设置
   静默窗口，则先做不送达真实 Runner 探针，窗口满足后再按 `notBefore AND nextInbound`
   主动送达，禁止为了验收提前打扰。
7. **同会话有限并发**：私聊新任务到达且全局容量未满时，当前任务立即转后台，新任务
   直接执行；并发计数跟随真实 work 生命周期，不能在转后台时提前释放。达到
   `GROK_MAX_PARALLEL` 后才显示“已入队”。

### 同会话并发排障与验收（2026-07-28 owner 实录）

**症状**：同一私聊先发一个长任务，再发独立任务，第二条出现“已入队 #2”；此时
`queueStats.activeGlobal` 明明小于 `GROK_MAX_PARALLEL`。

**根因**：`sessionQueue` 是“同 key 串行、不同 key 并行”，把同一私聊的上下文顺序与
真实 work 并发混成了一个约束。只调大 `GROK_MAX_PARALLEL` 无效，因为两条任务仍命中同一
`sessionKey`。

**正确修法**：

1. 私聊新任务到达且 `workConcurrency.active < max` 时，请求当前前台 lease 立即 yield；
2. 旧任务注册后台句柄并释放 `sessionQueue` 链，但 lease 要等真实 Runner 完成才 `finish()`；
3. 新任务启动时若 sticky session 仍被旧任务占用，必须由 live-session preflight mint 新
   session，禁止并发 resume 同一个 session；
4. 达到真实 work 上限或群聊才显示“已入队”；禁止释放链后无限扩张后台任务。

**排障读数要同时看**：

```bash
ssh dev198 'curl -s --noproxy "*" http://127.0.0.1:18765/healthz' \
  | jq '{queueStats,workConcurrency,runtime,liveGrokSessions}'
```

- `queueStats`：Bridge 会话链占用，不等于真实 Runner 数；
- `workConcurrency`：转后台后仍未完成的真实 work 数，是并发上限的准绳；
- `runtime.children` / `liveGrokSessions`：查 child 移交与 session 冲突；
- 日志锚点：`foreground yield requested` → `bg yield ... reason=new_task` → 第二个
  `grok start` 必须早于第一个任务的 `outbound ok`。

**真机验收**：由运维方用目标 Bot 主动发起一慢一快两个真实任务；快任务必须先完成，
慢任务随后完成，两张结果卡都要在会话底部可见。只看单测、health=ok 或消息发送成功都
不算完整验收。

**远程测试坑**：dev198 非交互 SSH 的 PATH 不含 Node。即使用绝对路径启动主命令，测试或
子进程的 shebang 仍可能走 `/usr/bin/env node`。全测前必须：

```bash
export PATH=/home/chuan/.local/node/bin:$PATH
```

## F5.3 kimi 超时自动续跑（v1.27.0，2026-07-28）

**机制**：kimi 单轮墙钟 12min（token 15min 约束，`kimi-model.mjs KIMI_MAX_RUN_MS`）；
超时不再终局——刷新凭据后 `--session <id>` 带完整上下文接力，默认再续 2 轮
（`KIMI_CONTINUE_ROUNDS`，总墙钟 ≤36min）；群聊不续（不转后台会占队列 36min）。
成功回复带「（已自动续跑 N 轮）」角标；轮次耗尽把半成品当降级答复送达+「发继续」。

**关键事实（bundle 实证+探针，别靠猜）**：
- kimi CLI `appendSessionIndexEntry` 只在 create/fork 写 `session_index.jsonl`，
  **resume 不写**——session id 只在首轮超时后对撞一次（恰好一条新增才算数），
  之后各轮复用；逐轮对撞第 2 轮必扑空还可能领养并发任务的会话。
- `--session` 指向无效会话时 CLI 在 API 调用前 exit 1（`Session "x" not found`，
  零额度）→ runner 自动换 prompt 兜底重试，不占接力名额。
- `-p` 与 `--session` 可组合（2026-07-28 探针实测）。

**停止语义（红线，对抗审查修正）**：续跑轮**绝不读 session 级 stopRequested**
（裸「停」/「/new」会置它，读了=误杀后台任务，F5-2 同类病）。任务级停止走
bridge 传入的 `isStopped()` oracle（后台任务看句柄 status / 前台看键级旗标）+
`child.hStopRequested`；「停止 #句柄」后 `attachChild` 拒收新轮 → bridge 直接
标停+SIGTERM，绝不回落前台注册。

**授权墙**：撞过 `onUserActionRequired` 的超时不硬续（墙不会自己消失）——半成品
降级送达+「完成授权后自动续跑」；授权在主跑期间完成 → `pendingAuthRetry` 闩，
主跑失败收场时补触发重跑（带半成品衔接，挂原会话键可被「停」）。主跑成功且
没撞墙 → 授权回调不重跑（省额度）。

**排障关键词**：`kimi continue`（接力轮日志，含 round/session）、
`auth_wall_yield`/`continue_exhausted`/`rebind_needed`（trace note）、
`auth retry deferred|skipped`（门闸行为）。测试锁 `test/kimi-continue.test.mjs`（12 个）。

**仓库对账已闭环（2026-07-28，川哥拍板「线上为真相」）**：f6fa06d(F5.3)+bb7f241(快照)
+21ea7d4(merge -X ours) 已推 origin/main。**纪律（给所有引擎，含 codex）**：
① origin/main 从此就是唯一主干，dev198 改动**必须在 dev198 上 commit+push**，
禁止「Mac 侧推远端 + dev198 rsync 不入账」的双轨（本次三方漂移根因）；
② 判主干/推送前，关键文件三方 md5 对撞（线上 /srv/h-control/app/... ↔ dev198
工作区 ↔ origin/main），任何单一 git 视角都会骗人；③ 切忌 reset --hard 任一边。

## F5.4 登录保活（v1.28.0，2026-07-28）

**机制**：hsid（用户控制台）24h 硬过期 → **30 天滑动续期**；hadm（管理台）12h →
**7 天滑动**；`/go/` 卡片自动登录链接 7→30 天拉齐。滑动=带有效 cookie 的请求
每小时最多换发一张全额 TTL 新 cookie（`session.mjs renewCookie/renewAdminCookie`，
**先验签后换发**，过期/伪造绝不复活）。开着的 dashboard 标签靠每分钟轮询自动
续命=永不掉线；离开满一个 TTL 才需重新走入口。

- dashboard 未登录：不再 302 首页装死，直接 401 + 指引页（发「配置」/点 30 天
  内的「打开我的后台」按钮）。
- 排「登不上」：先看响应字节数分形态（登录壳 vs 全页），再浏览器真机测 console；
  cookie 语义都在 `control-plane/lib/session.mjs` 一个文件里。
- 测试锁 `control-plane/test/session-renewal.test.mjs`（4 个）；改 TTL/续期节流
  必过它。Set-Cookie 优先级：路径自带的（如切换助手）覆盖续期的——writeHead
  显式头覆盖 setHeader，语义正确勿"修复"。

## Pi 路线 durable 可靠性规则（2026-07-28）

这套能力属于全 Bot 平台契约，owner 与登记用户必须共用；只能在 Runner 适配层保留引擎差异。

1. **用户闭环时序固定**：`Runner success → durable enqueue → send → Feishu ACK → terminal event`。
   Runner 成功不等于用户收到；未 ACK 禁止写 completed。Outbox ACK 后的旁路回调失败只告警，
   禁止重发已 ACK 消息。
2. **稳定外发幂等键**：每个 `deliveryId` 派生稳定 request UUID；重启补发必须复用，不能每次
   生成新 UUID。后台最终结果仍发会话底部新卡，不能回写旧流式卡冒充送达。
3. **恢复分级**：pending delivery 与未开跑 follow-up 可自动恢复；已 applied follow-up、
   Runner RPC 已 ACK、后台 running orphan 只标记和告警，除非工具副作用有可靠幂等证明，
   禁止盲目重跑。
4. **SQLite 是单机事务真源**：Node 22+ 默认 `H_DURABLE_STORE=sqlite`，TaskSessionLog、
   Outbox、follow-up、RPC 共库并保留 `0600` JSONL 回滚镜像；`jsonl` 是降级开关，
   `sqlite-required` 用于要求不可回退的环境。SQLite 不代表跨主机一致性。
5. **RPC 边界不等于进程隔离**：当前 durable RPC 已有 request/ACK/result/error/cancel、超时、
   背压和 orphan 检测，但 worker 仍与 Bridge 同进程。对外宣称“Runner 卡死不影响 Bridge”前，
   必须拆独立 systemd worker 并完成 kill/重启验收。
6. **持久参数最小化**：RPC durable args 剥离 callback、runtime、mapStore、Token、cookie、
   credential；TaskSessionLog 不存 prompt/回复。Outbox/follow-up 为完成任务所需的用户私有
   运行态数据，只能在哈希 scope、`0700` 目录、`0600` 文件或 SQLite 中保存，禁止进入 Git、
   共享记忆、日志和健康页。
7. **影子流量绝不送达**：Native Kimi shadow 默认关闭，不得接任何飞书发送函数，只记录匿名
   延迟/Token/字符数/相似度。Native API 当前模型与 Kimi Code 订阅模型分开配置：
   `kimi-k2.6` 不能替换正式 `kimi-code/k3 → k3`。
8. **上线验收不能只看单测**：部署前精确备份并记录用户级服务 PID/启动时间/关键哈希；部署后
   必做 >120 秒新完成卡、一慢一快并发、权限卡自动续跑、enqueue/send/ACK 断点 kill、
   飞书 429 与重启补发。健康页只暴露匿名聚合，禁止 appId/uid/正文。

回滚入口：仓库 `docs/rollbacks/2026-07-28-pi-durability-roadmap.md`。SQLite 异常可先设
`H_DURABLE_STORE=jsonl`；Outbox 主链异常必须 Git revert，不能绕过 durable enqueue。

## 需求与缺陷闭环（2026-07-29）

H 平台使用飞书多维表格给人阅读、编辑、反馈和验收，但它不是任务执行真源。

1. **人类控制面与执行真源分离**：飞书 Base 保存需求、状态、验收结论和安全摘要；
   Bridge/SQLite/TaskSessionLog/Delivery Outbox 保存真实任务状态。Base 显示“成功”不能替代
   Runner、飞书 ACK 和终态事件证据，反过来也不能用执行日志替代用户验收。
2. **入口配置不入 Git**：控制台只读取 `H_ISSUE_TRACKER_URL`；真实 Base URL 仅放生产
   `/srv/h-control/.env`（`0600`）。代码仓只保留空的 `.env.example` 字段和页面能力。
3. **写入前先读结构和现有记录**：使用用户身份操作；先读取字段，再串行读取全部记录，
   建立“标题 → record_id”映射。禁止不查重直接创建，也禁止在同一 Base 并发执行 list/write。
4. **按语义去重，按标题 upsert**：标题已有就带 `record_id` 更新；没有才创建。重复描述
   合并成一条人话需求，例如多次出现的“我要吐槽”只保留一个闭环事项。
5. **状态语义固定**：用户明确标记 `✅` 或体验确认 OK，写成 `已关闭 + 通过`；ongoing
   只能是 `已排期`、`执行中` 或 `待确认`，并保持 `未验收`。同一事项不能同时存在开放版
   和关闭版；变更范围不清时宁可更新原记录，不新造近义标题。
6. **每次同步都写审计并回读**：执行表记录 Runner、结果摘要、请求 UUID、真实开始/完成时间
   和验收证据；写后重新读取主表，至少检查标题重复、已完成状态、ongoing 状态、重复反馈数、
   开放 P0 数量。时间字段必须来自当前真实时间，不能手填未来时间。
7. **内容给人看**：标题表达用户价值；“问题描述”说清为什么做；“预期结果”写完成定义；
   “实际结果”和“测试证据”只写安全摘要，禁止写 Token、授权链接、open_id、对话正文或
   用户隐私。技术文件名和提交号只放在确有排障价值的字段。
8. **自动 Intake 必须验主表与审计双终态**：`Base Intake Worker` 需完成稳定 UUID 防重、
   自动认领、真实 Runner、主动送达、Delivery Outbox ACK、主表回填和执行审计终态。主表成功
   不能替代审计的状态、message ID、已送达、真实开始/完成时间；任一侧未终态不得报完成。
9. **控制面健康要按真实暴露面判断**：公网 `https://ai.kidshub.cn/health` 当前返回 404，
   不能据此宣称服务故障；公网根页面 200、`h-control` 为 active、生产源文件版本与入口存在、
   受保护健康端点未授权返回 401，才是当前正确组合证据。探针路径会变化，操作时必须现场查路由，
   禁止沿用旧记忆里的 `/health`。
10. **客户端 DNS 故障不得写成服务恢复**：如果 `h-control`/nginx/TLS/监听始终正常，而 Xray
    DoH 出现 `context deadline exceeded`/`closed pipe`，应记录为本机访问链故障。移动网络下国内
    域名使用系统 resolver + 至少两路 UDP DNS，并开启 stale cache 与
    `disableFallbackIfMatch`；关键自有域名可在确认 IP 稳定且有精确备份时固定 hosts，并同步显式
    路由。修复后主动探测管理台、用户入口和两个无关国内站点，再统计重载后的新 DNS 错误。

控制台入口验收锁：管理员左栏同时保留“需求与缺陷闭环”和“飞书开发文档”，均使用
`target="_blank" rel="noopener noreferrer"`；未配置 URL 时不渲染需求入口，不能产生空链接。

### Base 增量同步实操（2026-08-02 走通，RUN-0018）

铁律 23 的可执行流程，本机 lark-cli（user 身份）直接跑：

1. **快照落盘**：裸调 `api GET .../records --page-all` 拉全量存 scratchpad（v1.0.22
   封装命令 `+record-list` 返回平铺数组无字段名，**不可用于结构化处理**；flag 是
   `--base-token`/`--table-id`）。字段结构 `+field-list` 先看单条原始输出再写 jq。
2. **定增量集**：只写有证据的（状态推进要能指到 commit/工具/文档）；**「已修复
   待验收」批次是川哥 07-30 拍板暂缓验收的，不许代动状态**；空标题快记条目
   补标题时状态给「新反馈」，无进展信息的只补标题不加戏。
3. **载荷防呆**：追加型字段（如 H-0050 实际结果）先 assert 原文形状在场再拼接，
   防止旧快照失效后盲写覆盖。
4. **串行写**（同 Base 禁并发 list/write），select 写字符串 / datetime 写毫秒 /
   link 写 `["recXXX"]`。⚠️ **create 确认字段在 `data.record.record_id`（不在顶层）**
   ——2026-08-02 判定读错层级把 4 条已成功 create 打成 FAIL，若按 FAIL 重跑就是
   重复记录事故。**写入判 FAIL 先打印原始响应分类：解析失败禁重试、回读查重为准**
   （[[feedback_parse_fail_is_not_write_fail]]）。
5. **回读验收**：总数差=操作数、标题零重复、空标题清零、开放 P0 数核对；执行
   记录表落审计（Runner/执行状态/真实起止时间戳/请求UUID/关联需求 link/结果摘要/
   测试证据），写完回读该条。
6. 主表**主字段当前是「需求 & 问题描述」列**，link 字段显示描述不显示标题——
   属结构现状非缺陷，改主字段归川哥拍板。

本次记录导航：H-0061 记忆页改版、H-0062 冲突校准（均已关闭+通过）；H-0063 Kimi
整体适配（待确认）；H-0064 Studio 有线直连（已排期）；审计 RUN-0018。

#### 第 3 步的禁写自检怎么写才不是摆设（2026-08-07 升级）

铁律 23 说「证据字段禁写 Token / 授权链接 / open_id / 对话正文」。要让它可执行，
**每条规则都得配一个能命中的阳性对照**，否则「载荷 0 命中」既可能是干净、
也可能是规则写错了永远匹配不到——两者同形。

再往下一层：**对照本身也可能对错目标**。我第一版给 app_token 手写了个臆想形状
`[A-Za-z0-9]{20,30}(Bitable|Base)Token`，自造的对照串差 2 位，规则静默永假。
改法是**真值型规则直接拿磁盘上的真 secret 当模式**：

```python
real = open(SP + '/app-token.txt').read().strip()
RULES = [('app_token 真值', re.escape(real), '前缀' + real + '后缀')]   # 锚就地嵌真值
```

这样「锚命中」直接证明模式对准的是真目标。另外两条纪律：
**只扫本轮新增的字**（老字段原文是 Base 既有内容，混进来会误报）；
**每条锚同批次现造**（复用上一轮的锚会静默归零，2026-08-06 已犯过）。
主机名/端口不是禁写项（表里既有记录普遍带），列为「参考」不阻断即可。
详见 [[feedback_truncated_output_negative_conclusion]]。

## P1 公告管道抽象（2026-08-07，H-0080 + H-0049 的共同底座）

### 受众模型不用改 —— 先别急着抽象

控制面 `matchesAudience` 本来就是在 `pending()` 时对**实时用户表**求值的，
不是冻结的收件人名单。事故通报的「中断期间该站点的租户」、新手引导的
「绑定 N 天未用的人」，都可以由触发器**先算出 uid 列表、再用现有的
`audience.uids` 静态过滤发布**——一行 store 代码都不用动。

对事故通报这甚至是更正确的语义：它的受众由**过去发生的事**定义，
本就该在发布时刻冻结，而不是发卡时再按当前状态算。

真实缺口只有一处：发布逻辑焊死在「读 healthz 契约版本 → 查清单文件」里。
已拆成 `lib/announcement-publisher.mjs`（`bfcfc3b`），触发逻辑留在原处。

### 文案模板的红线：参数是受限类型，不是字符串（`e5b3978`）

`lib/announcement-template.mjs` 只支持 `enum` / `timestamp` / `duration` / `integer`
四种参数，**自由文本一律拒绝**。理由不是洁癖：

> 这条路径是**平台主动推送、用户无法拒收**。一旦允许调用方塞任意字符串，
> 一条异常消息、一段用户输入就可能被拼进推给全平台的卡片里。

调用方给的是「哪个枚举值、哪个时刻、多少毫秒、第几个」，**不是「显示什么字」**。
将来要加自由文本参数——先想清楚它的值可能来自哪里，多半不该加。

另外三道闸：①文件名与 `templateId` 一致（防复制改名忘改内容）
②slot 与 `params` **双向匹配**（加了变量忘声明会渲染出 `{{foo}}` 推给用户）
③渲染后再验一次不含 `{{`。模板**不得自带 `audience`/`announcementId`**
——前者是触发器按当时实况算的，后者必须由事件身份推出才能保证重跑不重发。

`ID_RE` / `FORBIDDEN_URL_SHAPES` 从 `release-manifest.mjs` 导出复用，同一条禁令一处定义。

### ⚠️ 重构后要单独跑「部署时真正会走的那条路径」

本轮差点漏掉：新模块 9 项单测全绿、又用假 healthz 做了 dry-run 行为等价对比，
**但那次 dry-run 用的是「有清单」场景，而部署时走的是「无清单 → 静默退 0」**
——那是这个脚本 99% 的执行路径，我一次没跑过。自检时靠问一句
「部署时它会走哪条路」才补上。

冒烟写法（配锚区分「正常没发」与「因缺凭据提前退出」，两者同形）：

```bash
# 假 healthz 吐仓库契约版本；确认该版本的清单文件确实不存在
node ops/announce-release.mjs --health-url http://127.0.0.1:19912/healthz
# 断言：退出码 0、"published":0、且输出里**不含** H_CONTROL（含了＝走的是凭据缺失分支）
```

详见 [[feedback_refactor_test_the_production_path]]。

### 本轮部署形态：只上 dev198，Mini 刻意落差

`e5b3978` 对 bridge 运行时**零行为变化**——新模块只被 `ops/announce-release.mjs`
引用，`bridge.mjs` 那 8 行改动全在注释块内。为注释付 Lima 割接约 35 秒中断不划算。
两站 commit 不同**是判断不是疏漏**，已写进版本态表。

⚠️ **未真机执行**：`announcement-publisher.publish()` 要有清单才走得到、
`announcement-template` 尚无调用方——两者现在只有单测证据，
会在 H-0080 触发器落地时才拿到真机验证。**没触发过的分支＝没验证过。**

## H-0080 事故恢复主动通报（2026-08-08 上线 · 控制面 v1.45.0）

站点断了又回来、且中断超过阈值时，给**中断期间在该站点的租户**发一张恢复说明卡。
判定与取舍全在 `control-plane/lib/incident-watcher.mjs`（有 13 条测试钉着）。

### 判据：控制面侧的 app-placement 租约

站点每 20 秒续租、TTL 60 秒。控制面这边「某站点有效租约归零」= 它至少一个 TTL
没续上 = 用户 Bot 已掉线。选它不选站点自报的 healthz，是因为**观测者必须在被观测
系统之外**——站点真挂了它就报不出来了。而且它是 2026-08-07 那次 213 秒事故的因果链
上游（续租失败 → `lose()` → 拆 11 个租户 WS → 用户看到「目标回调服务当前未在线」）。

已知盲区（别当缺陷排查）：飞书侧挂了（WS 断但控制面连接正常）、runner-worker 死了
（租约照续但任务跑不了）——这两种租约都看不见。

### 🔴 两个会凭空造出「事故」的运维动作（都已挡掉，改判据前先读）

| 动作 | 为什么会误判 | 怎么挡的 |
|---|---|---|
| **站点部署重启** | `instanceId` 含 pid+随机片段（`bridge.mjs:5214`），重启即变 → 新进程 claim 冲突 → 等旧租约过期才接管 → 反推中断 **60–80 秒，正好越过 60 秒阈值** | instanceId 变 = 进程重启，不通报；但**超过 5 分钟仍通报**（机器宕机不能漏） |
| **控制面自己重启** | 控制面 down 期间所有站点续不上租、租约全过期，而站点进程好好的、`instanceId` **没变**，上一条挡不住 | `load()` 时把 `healthy` 降级为 `unknown`（必须重新观察到租约才回 healthy）；`degraded` 原样保留——那是重启前基于真实观察的判定，丢了就白漏一次事故 |

详见 [[feedback_new_criterion_vs_ops_actions]]。

### 其余防误报

最小时长 60 秒（川哥定）· 恢复防抖连续 2 轮 · 同一事故靠 `announcementId` 幂等
（`incident.<site>.<中断起点>`，**用中断起点不用发布时刻**，重跑不重发）·
24h 内超 3 次熔断 · 发布失败重试 3 次后放弃。

**中断起点用上一轮记的 `renewedAt`，不是「我发现归零的时刻」**——TTL 60 秒意味着
发现时已经断了最多一个 TTL，拿发现时刻当起点会系统性低估。而
`purgeExpiredUnlocked()` 会把过期租约**物理删除**，证据自己会消失，所以健康时每轮
都要记 `lastSeenAt` 与 `lastAppIds`，等归零那一刻已经来不及取了。

### 🔴 卡面这四件事由需求原文定死，改文案时四条都得继续过

需求原文：「讲清**什么时候断的、断了多久、影响了什么、现在是否已恢复**」。
首版模板只有恢复时刻 + 时长，**缺「什么时候断的」**——恢复时刻减去时长能算出起点，
但那是让用户做减法。v1.45.0 已补 `startedAt`，四个硬词各配一条断言
（`卡面覆盖需求原文的四件事`）＋一条反向锚（换个起点参数，卡面必须跟着变，
否则那句时间断言可能是被别处字符串碰巧匹配到的）。

这个缺口是**做 Base 更新时按原文逐词核对才发现的**，实现和自测全程没暴露——
和 H-0029 漏掉「主动」是同一个母题：验收基准只能是需求原文，
「修复方案」「预期结果」都是实现方自己写的（[[feedback_acceptance_baseline_must_be_the_requirement]]）。

⚠️ `purpose` 渲染后约 73 字，而 `normalizeAnnouncement` 在 100 字**静默截断**——
余量只剩二十几字，加字前按最长形态数一遍。别靠肉眼：
`test/announcement-template-loader.test.mjs` 那条「一个字都不许被静默截断」
拿真 store 跑最长形态逐字对撞，超一个字就红。

### 灰度：空名单 = 谁都不发（与 `H_SKILL_PROPOSALS` 系刻意相反）

```bash
# /srv/h-control/.env（0600）
H_INCIDENT_ANNOUNCE_UIDS=u-001422f6e5,rayman.chen   # 空=不发；逗号分隔=只发这些；all=全量
H_INCIDENT_ANNOUNCE=0                               # 熔断，优先于上面的名单
```

🔴 **川哥 2026-08-08 定：灰度何时结束必须他拍板**，代码里没有任何自动放开路径
（没有「连续成功 N 次自动扩大」「满 X 天转正」）。任何配不明白的情况都收敛到「不发」。

受众**照常真实计算**（从租约快照算全量），只在发布前取交集收窄——这样灰度期跑的
就是生产路径，放开只改 env、受众逻辑一行不改。反过来做（灰度期把受众写死成某个人）
会让「从租约快照算受众」在整个灰度期一次都没真跑过。

### 排查入口

```bash
# 灰度当前对谁开着：启动日志这行由 resolveGate() 返回值算出，不是无条件旁白
sudo grep 'incident watcher' /srv/h-control/logs/h-control.log | tail -1
#   → incident watcher 已启动 每 15s 灰度=list(allowlist) 受众上限=2 人
# watcher 观察到什么（真在跑才有这个文件；0600）
sudo cat /srv/h-control/data/incident-watcher-state.json
# 判定痕迹
sudo grep 'incident dev198' /srv/h-control/logs/h-control.log
```

⚠️ **healthz 里没有 incident 段**（我 2026-08-08 一度报成「已在 healthz 暴露」，
是错的）：`server.mjs` 里只有 `incidentWatcher.start()`，没有任何路由把它的
`snapshot()` 挂出去。可观测入口只有下面这两个——**状态文件 + 启动日志**。

⚠️ **控制面应用日志不在 journalctl**：unit 是
`StandardOutput=append:/srv/h-control/logs/h-control.log`，`journalctl -u h-control`
只有 systemd 自己那几行。拿 journalctl 查应用日志会得到 0 命中，**与「功能没跑」同信号**。

### 状态：卡还没真发过 —— 验收方式川哥已定（2026-08-08）

判定链在跑（状态文件与租约表交叉对上：dev198 healthy 11 App / mini healthy 1 App），
但**首次真实发卡要等一次真实中断**——那也是 `announcement-publisher` 与
`announcement-template` 从写出来到现在的第一次真机执行。在那之前「能发出去」属未验证。

**川哥定的验收链**：平台发卡 → 他看到 → 他通知 cc → cc 更新 Base 验收。
**在等的具体信号**：`/srv/h-control/logs/h-control.log` 出现 `incident <站点> 已发布`。
**届时按什么验**：对照需求原文四件事（何时断 / 断多久 / 影响什么 / 是否已恢复）逐条核。
Base 里 H-0080 会一直停在「已修复待验收」，这三条已写进它的「实际结果」——
挂起态条目不写清「等什么信号 / 谁通知谁 / 什么算过」就会静默腐烂
（[[feedback_verification_handoff_at_the_last_inch]]）。


## H-0081/H-0082 用户后台「它怎么工作」白盒画板（v1.45.0 画板已验收通过 · v1.46.0 补全到全链，待验收）

把用户侧 runtime tab 从平铺清单改成「节点 + SVG 连线 + 上下游高亮」，与管理台
架构 Tab 同一套视觉语言。11 个节点 = 一次任务真实经过的环节，16 条连线 = 谁喂给谁。
代码全在 `control-plane/lib/html.mjs` 的 `MEMORY_JS` 段（`rt*` 前缀），
测试 `control-plane/test/runtime-board.test.mjs`（10 条）。

**清单没删**——挪到画板下方按环节分组，点节点会同步点亮对应那组。数据源仍是
`/api/context`，没有新接口、没有新字段；服务端投影维持原样（内部路径本来就不下发）。

### 🔴 改这块前必读的三个坑（都真机踩过）

1. **连线坐标禁用 `offsetLeft/offsetTop`**。它相对 `offsetParent`，而 offsetParent
   由**任何一个祖先的 `position`** 决定——我给列加了 `position:relative` 放绝对定位的
   阶段标题，坐标系整个换掉，16 条线全缩成画板左边一束，**而 JS 一个字没动**。
   现在一律用 `getBoundingClientRect()` 相对画板的差值。
2. **重绘必须走 `rtSchedule()`＝先同步画一次再排一次 rAF**。只挂 rAF 会死两次：
   脚本里 `shellTabJs` 排在 `rtLoad` **之后**，所以首屏渲染那一刻面板还没 `on`（宽为 0）；
   而页面 `document.hidden` 时浏览器把 rAF 和 ResizeObserver **一起冻结**。
   症状是「节点全在、线一条没有、控制台干干净净」。另配 ResizeObserver + `visibilitychange` 兜底。
3. **详情卡不许做成浮在画板上的抽屉**。架构 Tab 能那么做是因为它的画布可缩放平移，
   被盖住可以拖开；这块是固定布局，浮层直接把「跑起来 / 结果」两列盖死（实测）。
   照搬交互形态前先问原设计靠什么条件成立。

详见 [[feedback_relative_coords_and_frozen_callbacks]]。

### 验这块的判据不能拿 svg 自己的尺寸当基准

我第一版写「路径坐标必须落在画板范围内」，范围取自 `svg` 元素自己的 width/height——
坐标系整个错位时**照样 0 越界**（列内坐标比画板小，当然在范围内）。
基准必须独立于被验对象：改成「**每条线的起点必须落在源节点自己的框里**，终点落在
目标框里」，节点框由 DOM 现量。并做负向验证：源节点框人为平移 400px，
不匹配数 0 → 16。同理 `runtime-board.test.mjs` 里那条完整性锚。见 [[feedback_criteria_must_match_object_variant]]。

**v1.46 又栽了两次，都是判据自己的病（负向验证才逼出来的）**：
①「注入通道取自服务端」写成 `DASH.includes('sp.via')` —— 把那处 value 改成写死字符串后
**照样全绿**，因为该字符串在 rows 里还出现。**全文包含式断言的作用域比缺陷大**，
必须先抠出该节点自己的字面量再匹配。
②节点 id 改小驼峰后，正则 `[a-z]+` 只抠到 19 个里的 14 个，而当时的正例锚是
`>= 10` —— **门槛比真实数量松，静默放过**。现改为与「数 `,band:` 键出现几次」
这套独立计数逐个 `assert.equal` 对撞。
**判据：负向验证没变红时，先怀疑断言，别急着庆祝实现是对的。**

### v1.46.0：五泳道与机制真值（改文案前先对这张表）

19 节点 27 连线，泳道＝你在哪儿改 / 怎么送到你的实例 / 你的实例上落了什么 /
开工时怎么装进去 / 跑起来回到你。写给用户看的节奏值**必须从代码常量取**，不许凭记忆：

| 腿 | 常量（`bridge.mjs`） | 值 |
|---|---|---|
| 记忆与配置操作队列 | `MEMORY_OPS_INTERVAL_MS` | 10 秒 |
| Skills 同步 | `SKILLS_SYNC_INTERVAL_MS` | 60 秒 |
| 运行时上报 | `H_RUNTIME_REPORT_INTERVAL_MS` | 30 秒 |
| users 热加载 | `HOT_RELOAD_INTERVAL_MS` | 5 秒 |
| 控制面 users 同步 | `USER_SYNC_INTERVAL_MS` | 15 秒 |
| 记忆同步 | `MEMORY_SYNC_INTERVAL_MS` | **30 分钟** |
| 记忆摘要 | `MEMORY_DIGEST_INTERVAL_MS` | 10 分钟 |

⚠️ **取这些值别用 `grep -oE`**：它把 `|| 30 * 60 * 1000` 截成 `30`，
而 `30` 是个看着完全正常的毫秒数——差点把「记忆同步每 30 毫秒」印到用户屏幕上。
要读值就取完整行或直接 Read（[[feedback_truncated_output_negative_conclusion]]）。

🔴 **注入通道的文字一律取服务端实测 via，不许前端写死**：
`systemPrompt.via` / `conversationHead.via` / `skills.via` 由 `lib/context-report.mjs`
按引擎算出（grok `--rules` 四源 / kimi workspace 运行镜像 / omp 双通道），
写死任何一条，换引擎的租户看到的就是假的。同理 `scopeNote` 那句源码注释写着
**「界面必须原样显示这句」**，别再用自己写的近义文案替代。
`larkScopes`（缺哪些域、是要管理员开通还是用户重新授权）也是服务端早就下发的，
v1.46 起才真正用上——**改这一屏前先通读 context-report 的返回，别重新发明字段**。

🔴 **机制常量必须与实测读数视觉可分**：轮询节奏那类节点带 `mech:true`（虚线边框 +
详情里明说「不是刚量出来的读数」）。混在一起显示，用户会把「每 10 秒」当成实时值。

### v1.47.0 走线：不遮挡是结构保证，不是调参

**竖直段只允许出现在三个地方**：列间沟道、列外右侧通道、同列上下紧邻两卡之间。
四种走法 `side` / `stack` / `outer` / `lane` 各覆盖一类拓扑，折点坐标可直接断言。
改这块前先读 `rtRoute` 的头注，别退回「两点一条贝塞尔」——那是被川哥打回的那版。

| 坑 | 症状 | 修法 |
|---|---|---|
| lane 从卡片下缘直接垂下 | 竖直段穿过同列下方所有卡 | 先横向走到相邻沟道再降 |
| 三种走法各算各的锚点 | 两条线落在同一张卡左缘同一点 | **每张卡每条边只有一个分配器** |
| 窄屏塌成单列 | 沟道落在卡片正中，必然穿卡（实测 84 次） | 判 `colL[k+1]-colR[k]<8` → 不画线并显式说明 |

**判据（改动前先跑出基准，否则说不清好了多少）**：基准取**卡片自己的 DOM rect**
（独立于连线生成逻辑），把路径采样成点，数「落在与该线无关的卡片矩形内」的次数。
本轮：穿过无关卡片 12 → 0、端点重叠 10 → 0、标题折行 10 → 0。
配一个必然命中的自检（卡片中心点在自己框内），证明判据不是恒零。

⚠️ **窄屏是刻意降级不是缺陷**：管理/配置类页面桌面优先（铁律 5），
246px 宽里 27 条线无论怎么画都读不了；上下游关系点开卡片照样看得到。

### v1.47.1 详情浮层：不许用 scrollIntoView 补救「看不见」

川哥原话：「点击卡片时，焦点不要切换移动，浏览器画面不要下移，像管理台的架构图
画板里一样，直接自适应从左或者右侧弹出。」

- **`rtOpen` 里禁止出现 `scrollIntoView`**（有测试钉着）。滚动补救的代价比它解决的
  问题大：整页被推走，用户失去对画板的空间感；焦点跳到详情后再点下一张卡，
  视野已经不在画板上了。
- 详情是**绝对定位在画板内的浮层**，落在**离所选卡片远的那一侧**：卡片中心在画板
  右半边就从左弹，反之从右弹——保证不盖住刚点的那张。左右两侧样式**都要有**。
- 窄屏（连线本来就不画那档）退回块级，浮层会盖满小屏。

⚠️ **验「左右两侧都实现了」别写 `at-left{left:`**：窄屏媒体查询里有条兜底
`at-right,.at-left{left:auto;right:auto}` 会把它匹配走，删掉主规则照样全绿。
要求带**具体偏移量**（`left:\d`）才拦得住。

### 浏览器验收清单（改完照跑）

初次加载 16 条连线全绘且 SVG 尺寸 == 画板尺寸 · 点节点后选中/上游/下游/压暗四态
与入边出边计数 · 上下游 chip 可跳转 · 再点同一节点收起 · 关闭按钮复位 ·
375 宽单列后 16 条全改走垂直分支且无横向滚动。
⚠️ 本地预览浏览器的页面是 `document.hidden` 的，rAF/ResizeObserver/resize 都不发；
看到「改了没生效」先 `dispatchEvent(new Event('resize'))` 打一发，
分辨「接线错了」还是「事件没发生」。

🔴 **断言的作用域必须正好等于要验的那一处**（2026-08-08 一天犯三次，都是恒绿）：
整文件 `includes` 和定长 `slice(0,N)` 几乎永远太宽——别处的注释、兜底规则、
同族函数会替它作证。用**结构化边界**替掉：大括号配平取函数体、抠出该节点自己的
字面量、正则里带具体值。最终裁判是负向验证；**负向验证没红时先怀疑断言**。

🔴 **读浏览器侧的数之前先断言环境本身正常**（`innerWidth > 0`、视口尺寸符合预期、
面板可见）。2026-08-08 被骗两次：①改完 CSS 量到旧值，是**浏览器缓存了页面**
（磁盘与渲染产物都已是新值——查的顺序应该是磁盘 → 渲染产物 → 浏览器）；
②视口一度塌成 `0x0`，量出 240 次遮挡、19 处折行全是废数据，而且那期间画的线
还残留一条，害我差点去改走线逻辑。**环境异常时的读数整轮作废，不能挑合理的那几个用。**

#### 2026-08-07 下午同步（RUN-0023 / RUN-0024）

76 → 78 条。更新 H-0029（触发器上线，**状态与验收结论不动**）；新建
**H-0078** 全平台掉线 213s（Bug/P0/已修复待验收——宽限分支尚未真机触发）、
**H-0079** 飞书改直连（川哥确认「快了 1-2 秒」→ 验收通过关闭）；
补 H-0070 空标题；H-0077 按川哥指示维持挂起、只加一行说明。
现状：开放 31 条，开放 P0 两条（H-0076、H-0078）。

## H-0083 grok 自定义端点绑定（URL + API key）· v1.50.x · 2026-08-08 上线

用户可把 grok 指向**任意 OpenAI 兼容网关**，从该网关真实模型表里选模型 + 设上下文窗口。
灰度开关 `H_GROK_ENDPOINT_BINDING_UIDS`（`/srv/h-control/.env`，默认谁都不开、
**代码里无自动放开路径**，放开必须川哥拍板改这一行并重启）。

### 机制真值（源码 xai-org/grok-build @afbc0fb × grok 1.0.0 真机双证）

只需两个环境变量：`GROK_MODELS_BASE_URL` + `XAI_API_KEY`，经已有的 bwrap `--args FD`
通道注入（key 不落盘）。**bwrap 腿和 native 腿必须传同一组变量**，漏一条那台机静默失效。

- `ModelFetchAuth::resolve()`：custom_endpoint **优先级高于 session**，设了 URL 就强制
  API key 鉴权，不需要 `grok login`，也不会被残留旧 session 抢回去。
- `resolve_model_list()`：custom endpoint 下**跳过内置模型表**，模型全来自网关 `/models`。
- 🔴 `EndpointsConfig::from_config_value`：config 的 `[endpoints]` **覆盖 env**。
  所以**绝不能**往用户 config.toml 写 `[endpoints]`——写了就把注入的
  `GROK_MODELS_BASE_URL` 废掉，整个端点静默退回官方端点。
- 上下文窗口只能经 `[model."<id>"] context_window` 覆盖块给（无 CLI/env 开关）。
  不写则落兜底 `DEFAULT_CONTEXT_WINDOW = 256_000`（`remote/client.rs:702`），
  而 grok-4.5 实际 500k → **白丢一半上下文且无任何提示**。合并语义已验：
  只写 `context_window` 一个字段安全，`model`/`base_url` 从网关那条继承。

### 三个实测坑（改这块前先看）

1. **不指定模型时 grok 按网关返回顺序取第一个** —— 抓到过它选中 `gpt-image-2`
   （图像模型）。对话助手落到图像模型上表现为**答非所问而不是报错**。
   故端点模式下模型**必选、无默认**，没选就不下发凭据（runner 报可读错误）。
2. **模型过滤判据只能看 `models_cache.json` 的 `origin`，不能看 `auth_method`** ——
   生产 11 个租户在普通 BYOS 模式下 `auth_method` 就已经是 `api_key`，按它分派会
   把全部现存租户误判成自定义端点。
3. **`-m` 的模型名正则要放开 `/` 与 `:`**（网关 id 常带路径前缀，如 `ccsub2/gpt-5.4`），
   老正则 `[A-Za-z0-9._-]+` 会静默丢弃 → 退回网关默认。

### 🔴 第三方网关会静默换模型

CPA 网关实测：请求 `grok-3-mini` 实际回 `grok-4.3`、`codex-auto-review` 回
`gpt-5.6-luna`、`grok-composer-2.5-fast` 回 `grok-4.5-build`——**不报错、不提示**。
**「我选了 X」≠「跑的是 X」**，验收必须看响应里的 `model` 字段。

### 「后台设什么 = bot 用什么」的三重保障（川哥 2026-08-08 立的验收标准）

1. runner **每任务**向控制面拉凭据取模型，不依赖任何缓存
2. 后台改模型 → user-sync 15s 内**热补丁**进运行中 App 的 ctx
   （`VOLATILE_CTX_FIELDS` + `patchVolatileCtx`），**不重启不掉线**。
   判据：这个字段有没有人在启动时把值抄走？没有 → 可热补丁。
3. 「什么模型」卡片并列「后台设置 ↔ 最近实际调用」，不一致自己告警；
   端点模式**不展示 config.toml 钉定值**——它不决定行为（CLI `-m` 压过 config）
   且必然滞后（命令代答不走任务路径），显示它只会制造假警报。

### 翻车记录：加字段要数清链上有几个白名单

端点四字段（`grokEndpointModel`/`endpointMode`/`endpointHost`/`endpointContextWindow`）
从控制面到运行时要穿过**四个逐字段硬编码白名单**：

```
控制面 /internal/users → mergeControlUsers(两个分支) → loadUserRegistry 归一化 → userCtx
```

**同一个 bug 修了两轮**（v1.50.3 / v1.50.4），因为补三个漏一个的症状与一个都没补
完全相同：控制面查得到、执行面永远空、全程零报错。以后动这条链：
先 `rg '<某个已有字段名>' lib/app-registry.mjs control-plane/server.mjs` **数一遍**，
测试写**端到端断言**（控制面下发 → 合并 → userCtx），别只测单跳。

### 排障必读的两条通道真值

- **bridge 的真日志在 `~/feishu-grok-bridge/logs/bridge.log`（十几 MB），不在
  journalctl** —— journald 只漏出启动/housekeeping。在 journalctl 里查消息处理会
  得出「一条消息都没处理」的假结论（2026-08-08 我就这么误判过）。
- **卡片按钮走 card action，`lastInboundAt` 纹丝不动**（只统计文本消息）。
  用户点「新会话」查不到入站记录是正常的。

## H-0084 Owner Bot 端点绑定（管理台版）· v1.51.0 · 2026-08-09 上线

owner（`sandbox=null`）此前从不调 `/internal/creds`（runner-worker 的
syncCredentials gate 在 `sandbox &&` 上），grok 钉死本机 device OAuth，订阅耗尽
即全瘫。v1.51.0 给 owner 开独立凭据链，**租户链（含 v1.50.4 那四个白名单）零接触**。

### 架构（与租户链的隔离面）

- 入口：管理台 overview「**Owner Bot 引擎**」面板（oep* JS）→
  `/admin/api/owner-endpoint(-model/-context/-clear)`，admin cookie 鉴权，
  **不走 ENDPOINT_GATE**。绑定改动**下一条消息生效**（每任务拉凭据），无需重启。
- 存储：元数据 `DATA_DIR/owner-endpoint.json`（`lib/owner-endpoint-store.mjs`）、
  key 进 vault 键 **`'owner'`**。**不进 users store**（进了会被同步器当租户 App 启动）；
  注册流拒绝 `uid='owner'` 保留字。
- 下发：`/internal/creds/owner` 分支在 `store.get` **之前**提前返回，形状与租户
  endpoint 模式同构；卡片 meta 走 `GET /internal/owner-endpoint`（无 key）。
- 执行面：bridge registerApp 传 `kind` → runner-worker `isOwnerGrok` →
  makeCredentialSync(`uid='owner'`, `spec=null`)。owner 未绑定 = `xai:null` 干净
  返回 → grok-runner **静默 fall through 走 auth.json** 并剜托管块（回退=上线前原状）。

### 🔴 grok 每请求鉴权序（本次最大的坑，官方 docs/user-guide/02-authentication.md）

**per-model `env_key` > session(`auth.json`) > 全局 `XAI_API_KEY`**。全局 env key
只在**无 session** 时兜底——owner 宿主有 auth.json，session 压过注入的 key，grok
拿 SuperGrok token 打 CPA → 401×4「Auth recovery succeeded but ... rejected」。
租户沙箱无 auth.json，所以 v1.48–v1.50 三版全绿从未暴露（**洁净沙箱验过 ≠ 脏宿主
验过**）。修法：端点托管块恒写 `env_key = "XAI_API_KEY"`（cw 行有值才写）。
⚠️ H-0083 记的「custom_endpoint 优先于 session」只覆盖**模型表拉取**
（`ModelFetchAuth::resolve()`），推理请求另有一套序——**优先级结论必须绑操作类型**。

### 排障

- owner 402 `usage balance exhausted` = 打的是**官方端点**（SuperGrok 余额耗尽原状）
  → 说明未绑定或凭据没注入；owner 401×N「Auth recovery succeeded」= 绑了但
  env_key 块缺失（session 压 key）→ 查 `~/.grok/config.toml` 托管块。
- 定界手法：`mv ~/.grok/auth.json{,.hold}` 再跑一发（通 = session 干扰），验完必还原。
- E2E 探针：dev198 上用生产同构件（createControlClient + makeCredentialSync('owner')
  + createGrokRunner(sandbox:null)）跑真任务，一发验凭据/注入/-m/CW/网关五层；用完删。
- 终态（2026-08-09）：CPA `api-direct.hahaxiong.top` · grok-4.5 · cw 500000；
  config 备份 `~/.grok/config.toml.bak-v1.50.6-202608091022`；owner config 的
  `[models] default` 仍是已下架的 grok-code-fast-1（端点模式下被 `-m` 压过无影响，
  device 回退时靠 CLI 静默 fallback——**要不要改由川哥拍板，别擅动**）。
- dev198 git 漂移（tar 直传致工作区超前 HEAD）已于 2026-08-09 追平：md5 对撞确认
  = 6671e57 后 `git stash push` 入库，之后一律走 `ops/deploy-sites.sh`，别再 tar 直传。

## H-0028 定向分享通道（v1.58.0/.1/.2 · 2026-08-10，川哥真机验收通过）

个人 L2 skill → 指定同事的受控分发。**分享=受控 fork 到目标 L2（origin.type='share'），
执行面零改动**——装载/跟随/清理全走既有 sync 链。运维要点：

- **数据**：分享关系与 skills 同存控制面 `skills.json` 顶层 `shares`（单文件原子），
  记录终态不删 + `events` 时间线即审计。id=`<fromUid>:<toUid>:<name>` 确定性。
- **动作**：`/api/skill` action=`share`/`share-decide`/`share-revoke`；
  `GET /api/skill-shares`（双视角）、`GET /api/share-targets`（**全员**已激活，
  v1.58.1 川哥拍板从同部门放开；不许再加部门收窄，pages wiring 测试反向锁死）。
- **v1.58.2 语义收口**：分享按钮和架构白盒统一显示“公司同事 / 全员已激活用户”；
  只修正文案与架构登记，不改变接收确认、隐私门、同名拒绝、跟随或撤回规则。
- **三道门**：离开本人沙箱前过共享隐私门（user 层入库时刻意不过，分享时必须过）；
  同名 fail-closed 绝不遮蔽（H-0083 教训）；撤回只删 pristine 副本、改过的保留断跟随。
- **跟随**：user 层源有存活 share 时记 shaHistory（平时不记），refreshPristineForks
  认 `['fork','share']` 两种 origin。share 注释文案「来自 H 平台同事分享」，
  stripForkNote 正则同时兼容 fork/share 两种——**改注释文案必须同步改正则**，
  否则 pristine 判定全断（跟随与撤回双失灵）。
- **UI 入口在网页后台 Skills 面板**，且只有「我创建的」条目有分享按钮——用户报
  「找不到入口」先查这两点（2026-08-10 川哥第一反应在飞书卡片里找）。真机验收前
  给验收账号预置 demo skill；历史两轮预置（`demo-share-test`、`share-card-demo`）
  均已随验收通过清理零残留，share 记录按审计原则保留终态。
- 排障：分享记录 `sudo cat /srv/h-control/data/skills.json | python3 -c "...shares..."`；
  E2E 会话构造=用生产 SESSION_SECRET 按 session.mjs 格式签 hsid cookie（服务器上签，
  不出机）。⚠️ **cookie 的 exp 是毫秒**（`Date.now()+ttl`）——python 签的时候写秒级
  时间戳会被当 1970 年判过期，报 unauthorized（2026-08-10 踩过）。
  测试 14 个在 `control-plane/test/skill-shares.test.mjs`。

### H-0086 接收方 Bot 提醒腿（v1.59.0 + 深链修复 · 2026-08-10）

分享创建后接收方 Bot 主动发提醒卡（此前唯一可见面是网页后台，pending 会静默躺——
川哥那条实测躺了 5 小时）。B2 重绑推送同款「控制面清单 + 执行面发卡」模式：

- **控制面**：`GET /internal/share-pending`（pending 且无 `notifiedAt`，已过滤到
  active+appId+openId 可送达，带 `fromName`）+ `POST /internal/share-notified`
  （写 `notifiedAt` + events `notified`）。**被拒后重新 shareCreate 会清 notifiedAt**
  = 重新提醒一轮。已 accepted/revoked 的不进清单。
- **执行面 bridge**：`pushShareInviteCards` 60s 轮询 + **启动 15s kick（重启不吞
  在途提醒——上线当晚就是靠 kick 补发了川哥那条 5 小时前的分享）**；用**接收方
  自己的 Bot** sendActionCard；发失败不回报下轮重试。`H_SHARE_PUSH=0` 关，
  `H_SHARE_PUSH_INTERVAL_MS` 调周期。日志锚 `share invite card sent`。
- **按钮深链**：`/go/<token>?to=skills` → 302 `/dashboard#skills` 直落 Skills 面板
  （`GO_SECTIONS` 封闭白名单；裸 /go 落总览，川哥真机打回过一次）。
- **排障**：日志零命中有二义性（清单空 vs 腿没跑）——先打 `/internal/share-pending`
  看清单真值再判。⚠️ **dev198 用户 skills 目录里有 ≠ 控制面账本里有**（历史手放
  文件不入账本），分享报「skill 不存在」先查 `skills.json` 的 `user:<uid>/` 键。
  wiring 白盒锚在 `test/share-invite-wiring.test.mjs`（bridge 侧三件套/深链/开关）。

### H-0087 权限导入 JSON 投递三通道 + 一键复制助手页（v1.60.0 · 2026-08-11）

缺口引导 JSON 的投递按体积三分——**门槛必须盯 sendText 的 3500 切块线，不是
sendCard 的 9000**（曾设 8000：7174 字节判「装得下」走 sendText 被切 3 条，租户粘进
飞书后台报「格式错误」；owner/租户同一代码，「格式差异」纯由 JSON 尺寸触发切块）：

- **≤3400**：单条纯文本（长按整条复制）；**>3400**：文件投递（`buildGuidance
  maxJsonChars=3400`，改这两个值必须一起重估）；文件失败才落分批卡片。
- ⚠️ **SDK 双形态**：`im.file.create` 返回**已解包 data**（`{file_key}` 在顶层），
  `im.message.create` 返回完整响应（`{code,msg,data}`）。sendJsonFile 两种都认
  （`uploaded?.data?.file_key || uploaded?.file_key`）——只取 `.data` 时上传成功
  恒判失败，`file fail keys=[file_key]` 就是这个（文件腿曾因此从上线坏到 8/10）。
- **助手页（复制可靠性 100% 的兜底通道）**：bridge 发引导卡前
  `createScopeImportHelper` POST `/internal/scope-import`（Bearer SERVICE_TOKEN）
  把 importJson 暂存到控制面（`data/scope-imports/`，128-bit hex capability id，
  600 权限，TTL 7 天，sanitize 拒脏 scope/超 2000 项/非官方 consoleUrl），换回
  `https://ai.kidshub.cn/import-helper/<id>` 放进卡片按钮「打开导入助手」（primary）；
  **拿不到 URL 降级纯卡不吞引导**。页面免登录（不可猜 id 即 capability，内容只有
  scope 名清单）；`/import-helper/:id` 是参数路由，**与 /go /au 同例不进
  architecture registry**（drift 对账只认 `p === '...'` 精确形态，登记了反而恒 critical）。
- **日志锚**：`lark console guidance sent ... helper=1`（按钮卡）/`guidance json sent`
  （单条文本）/`guidance file sent`（文件）/`scope import helper fail`（暂存失败已降级）。
  验收对照组（修复前形态）：`asFile=0 json=7174` 后跟多条 sendText=被切；
  `file fail ... keys=[file_key]`=双形态坑。
- **灰度注入姿势**：`workspace/.state/proactive-acceptance-request.v1.json` 信箱
  （`H_PROACTIVE_ACCEPTANCE=1` 已开，≥2 probes，appId+openId+prompt，
  `receiveIdType='open_id'` 不需要 chat_id——DM 会话 bridge 按 open_id 组织，
  chat_id 不落盘别去找）。真实 Runner 跑任务撞墙触发全链，result 文件带 messageId。
- 白盒锚：`test/scope-import-helper-wiring.test.mjs`（门槛 3400/双形态/按钮/降级）+
  `control-plane/test/scope-import.test.mjs`（store/端点/页面/registry 反断言）。

## Task 6-R：Runtime Release Provenance（v1.58.2 · 2026-08-10）

- **当前生产锚点（2026-08-11 午更新）**：`v1.60.0`、Source Commit
  `256d6f500bee3606a282fcbdb6cf29ee3c77edcc`、Release ID
  `20260811-120048-h-control-1.60.0`、**51 个运行文件**（+scope-import-store.mjs）、
  `state=in_sync`、`mismatchCount=0`。同款手工流程（git archive 256d6f5 → build manifest →
  51 文件对照 → 落盘重启）。⚠️ **manifest 属主必须 `h-control:h-control`**——服务以
  h-control 用户跑，`chown root:root` 后 600 它读不了，healthz 恒 `unverified`（600 权限
  本身没错，错在属主；且 inspector 有 10s 缓存，修完等 11s 再查）。
  （历史锚：v1.59.0 `01da296`/`20260810-225534`；v1.58.2 codex `8f63fb9`/`20260810-175955`）
- **发布前重新取真值**：多 Agent 并发时，准备完成后 CC 可能已更新生产。正式发布前必须
  再次 `git fetch`、读取公网 `/healthz`、远端版本、启动时间和文件哈希；旧检查结果不继承。
- **同版本不重启**：运行文件已经与 Source Commit 一致但 Manifest 缺失时，用
  `ops/attest-current-h-control-release.sh` 补签。Runtime Source Commit 与 Tool Commit 分开校验，
  写入后对比 `MainPID`、`ActiveEnterTimestamp`、`NRestarts`，证明零重启。
- **新版本发布**：`ops/deploy-company-ontology-control-plane.sh` 动态发现完整运行时文件，
  在暂存目录全量测试、备份、生成 Manifest 后才覆盖生产；同版本会 fail-closed，正式发布只允许
  一次 `systemctl restart h-control`，并验证回环、公网、管理员登录、Source Commit 与文件集合哈希。
- **Shell 防坑**：EXIT trap 必须捕获真实临时目录路径，不能引用函数返回后失效的局部变量；
  zsh 包装器不要使用只读特殊变量 `status`，统一使用 `rc`。脚本退出异常时独立核验生产，
  不以外层退出码直接推断部署失败。
- **回滚锚点**：`/srv/h-control/backups/20260810-175955-h-control-1.58.2`。任何后续发布仍需
  川哥在当次窗口明确授权，历史授权和 Goal 状态不能继承。

## H-0083/H-0084 L0 skill 同步 SOP + 空壳 fork 劫持（v1.54.1 · 2026-08-09 晚）

> Base 表编号：H-0083=空壳 fork Bug、H-0084=约日程 L0 v1.3.0 同步。（本节曾误自编 H-0085，该编号已被后续记录占用，2026-08-10 修正。）

**做「把 owner/某版 skill 同步给租户」类任务时按这个来：**

1. **先双向 diff，别拿「新」当「超集」**：租户 L0 可能反向补齐过并各自演化（约日程
   skill 就是——L0 独有 rsvp accept/decline 换房重订等四块资产，owner 版没有）。
   产物是**合并版**。见 [[feedback_sync_needs_bidirectional_diff]]。
2. **同名 L2 遮蔽排查**（同步前必查，否则发了也有租户收不到）：
   ```bash
   # dev198：L2/L0 撞名 + 空壳指纹（行数悬殊 + h-skill-pattern 标记）
   for d in /srv/h-platform/users/*/.grok/skills/*/; do n=$(basename "$d"); \
     [ -d "/srv/h-platform/shared/skills/$n" ] && echo "$(dirname "$d"|xargs basename) $n $(wc -l < "$d/SKILL.md") $(grep -c h-skill-pattern "$d/SKILL.md")"; done
   ```
   pristine fork（正文=L0，仅多 fork 注释）会自动跟随不用管；`h-skill-pattern` 空壳
   =劫持产物，走控制面 remove 清除（**不直改磁盘**）。用户真改过的 fork 绝不动。
3. **脱敏 + 本地预扫带正例锚**：`node` 调仓内 `scanSharedSkillContent`/
   `scanSharedRefContent` 扫合并版（PASS）**并扫 owner 原版（必须 REJECT**——
   证明扫描器活着）；grep 人名/`ou_[0-9a-f]{8,}`/邮箱全 0，同一 grep 打原版非 0。
4. **发布链**（aliyun-hk 本机 127.0.0.1:18790，凭据 sudo grep 进进程不进 argv）：
   `POST /admin/login` 拿 cookie → `POST /admin/api/skill` `{action:'upsert-content',
   layer:'platform', expectedSha:<现版完整sha 乐观锁>}` → 附件 `POST
   /internal/skill-refs-put` `{key, files:[{path, contentBase64}]}`（Bearer
   SERVICE_TOKEN）→ 删除 `{action:'remove', key:'user:<uid>/<name>'}`。
   仓里另有 `npm run publish:l0`（scripts/publish-l0-skill.mjs）——下次先看它。
5. **验证（60s 同步周期后）**：dev198 全量 sha 核对（L0 自身=正例锚，零输出=命令
   错了不是全同步）；pristine fork 剥 `<!--…-->` 后正文 sha 必须=新 L0；空壳目录
   gone；manifest 无残留。新租户天然继承（挂载同一 shared 目录），零动作。

**空壳劫持机制**（详见 [[feedback_hollow_fork_shadows_source]]）：提炼引擎相似度
中间带（0.36–0.62）走 fork_update，v1.54.1 前 content 误用全新模板——空壳带共享
原名落 L2 盖 L0，`bot-assisted-fork` 不在 forkIsPristine 跟随白名单永不自愈，提案
卡文案却写「复制后更新」（批的是增强落的是降级）。真机 2 例已清（rayman.chen 约
日程 / u-01481f4a32 白板 lite）。修复：engine 走 buildUpdatedContent（source 正文+
追加段）+ 控制面 400 拒不含 source 正文的 fork content。**注意 store 入库改写
frontmatter name——防线/测试比对都用存储版 content，别拿原始文本重新生成**。

## 五项需求发布收口（2026-07-30）

本阶段发布版本 `v1.33.1`（E3 后 `v1.34.0`；grok 授权墙接线后 `v1.35.0`），全 Bot 行为契约 `2026-07-30.1`（→ `2026-07-30.2`，grok 撞授权墙自动推卡）。H-0027、H-0031、H-0011、
H-0037、H-0051 已开发、双端部署并写回 Base，当前统一为“已修复待验收 / 未验收”。

1. **公平调度验收必须制造真实竞争**：至少两只 Bot、总任务数大于全局容量，核对双方都有
   waiting、启动顺序交替且全部主动 ACK；单 Bot 连续成功不能证明公平。
2. **Owner 自进化只自动展示**：自动验收最多触发“查看详情”；接受、应用、忽略均有生产副作用，
   必须由授权用户明确点击。接受建议后可以生成提案，但不得自动应用。
3. **Base 适配器集中兼容返回结构**：lark-cli 1.0.x 新建记录 ID 可能位于
   `data.record.record_id_list[0]`；业务层禁止直接猜路径，统一走 `lib/lark-base-adapter.mjs`，
   并以真实新建 + 审计终态回读验收。
4. **分层记忆是二维模型**：生命周期映射 ai-memory tier；语义/情景等认知类型独立进入用户
   私有 sidecar。保存、镜像回读、独立查询和同步删除都通过后，才算单用户闭环；再做多用户
   隔离验收，禁止跨用户共享原文或扩展元数据。
5. **性能 Tab 只显示安全运行指标**：管理台可展示 dev198 的匿名 CPU、内存、负载、磁盘、
   进程和队列指标；不得输出用户标识、凭据、正文或用户级运行数据。版本号唯一真源仍是
   `control-plane/lib/version.mjs`。
6. **远程运行环境显式化**：dev198 非交互 SSH 先执行
   `export PATH=/home/chuan/.local/node/bin:$PATH`；测试结论必须由实际退出码累计，禁止无条件
   打印“全部通过”。
7. **远程配置禁复杂转义拼接**：`.env` 使用 heredoc 或结构化脚本写入；修改后用 `sed -n l`
   检查是否出现字面量 `\\n`，并从健康端点回读实际加载结果。
8. **外部额度与平台缺陷分开**：Kimi 403 额度不足只记为订阅阻塞；用户要求跳过后立即停止，
   不借用其他用户订阅。恢复后必须由原用户自己的 Kimi Runner 和 Bot 主动送达补验。

详细交接与回滚证据见：

- `docs/handoffs/2026-07-30-h-five-p0-p1-closure.md`
- `docs/retrospectives/2026-07-30-h-five-p0-p1-lessons.md`

## 发布收口必查「入账」（2026-07-30 立，cc 补）

上面第 8 条之外还缺一条，而它已经咬过两次（07-28 立纪律，07-30 同模式复现且危害
升级）：**"运行态不进 Git"只管住了不该进的，没管住该进的没进。**

**每次发布收口，除了测试/健康/契约版本，必须再断言一行**（dev198 上跑）：

```bash
cd ~/feishu-grok-bridge && git fetch origin main --quiet
echo "behind=$(git rev-list --count HEAD..origin/main) ahead=$(git rev-list --count origin/main..HEAD)"
echo "untracked=$(git status --short | grep -c '^??') modified=$(git status --short | grep -c '^ M')"
git status --short | grep '^??' | grep -E '^\?\? (lib|test|control-plane)/.*\.mjs$'   # 必须为空
```

最后那行是要害：**未跟踪清单里出现 `lib/*.mjs` 就是生产模块没入账**。
07-30 实测曾是 untracked=38 / modified=71，其中含 `base-intake-worker.mjs`
`memory-lifecycle.mjs` `evolve-card-acceptance.mjs` `system-metrics.mjs`
`lark-base-adapter.mjs` `proactive-acceptance.mjs`——磁盘内容 md5 == origin/main，
测试 369/369，服务 9/9，**一切正常，但一次 `git clean -fd` 就把它们全删了**。

**追账手法**（内容已等于远端、只是指针落后时）：

```bash
# 前置：ahead 必须为 0，否则本地独有提交会被摊成未提交改动 → 停手人工判断
md5sum bridge.mjs lib/<核心>.mjs runner-worker.mjs > /tmp/before.md5
git reset --mixed origin/main        # --mixed 移 HEAD+重置 index，不碰工作树
md5sum <同一批文件> > /tmp/after.md5
diff /tmp/before.md5 /tmp/after.md5  # 必须逐行一致 = 工作树零改动
systemctl --user show feishu-grok-bridge -p ActiveEnterTimestamp,NRestarts  # 证明没重启
```

⚠️ **别用 `--soft`**：它只移 HEAD 不重置 index，`git status` 会把目标提交的新增
文件显示成「staged 删除」，下一次 `commit` 真删生产模块。`--hard`/`clean -fd`/
`checkout .` 更是直接覆盖工作树，生产机上一律禁用。详见
[[feedback_git_ledger_lags_disk_content]]。

**顺带**：dev198 那份 `control-plane/lib/version.mjs` 属于"在场但不参与运行"
（控制面跑在 aliyun-hk），最容易漂。它漂了不影响线上，但**日后从 dev198 rsync
控制面会把线上版本号降级**，所以也要跟着对齐。改前先 grep 确认引用面
（只应被 `control-plane/server.mjs` 与 `control-plane/lib/html.mjs` 引用）。

## ⚠️ 重启矩阵：改哪些代码要重启哪些进程（2026-07-30 血泪）

Codex 07-29 把真实 Runner 拆进了独立进程，**只重启 bridge 已经不够了**：

| 改了什么 | 必须重启 |
|---|---|
| `lib/sandbox.mjs` / `lib/grok-runner.mjs` / `lib/kimi-runner.mjs` / `lib/omp-*` / 任何 Runner 侧共享 lib | **bridge + runner-worker 两个都要**（真实 Runner 在 `runner-worker.mjs:84` 的 `createGrokRunner`） |
| `bridge.mjs` / WS / 送达 / 卡片 / 编排 | bridge |
| 控制面 `server.mjs` / `lib/*` / `data/*.json` | `sudo systemctl restart h-control`（内存缓存，不重启等于没改） |

```bash
# 判据不是"我重启了"，而是每个进程的启动时间都晚于代码 mtime
systemctl --user show feishu-grok-bridge -p ActiveEnterTimestamp --value
systemctl --user show feishu-grok-runner-worker -p ActiveEnterTimestamp --value
stat -c %y lib/sandbox.mjs
```

漏重启 runner-worker 的后果是**静默失效 + 零报错**：我 07-30 因此看到"审计日志空"，
差点把它当成"Bot 没调用 lark-cli"的证据，已经写出错误结论才发现。
详见 [[feedback_verification_path_vs_production_path]]。
**找齐进程的方法**：`grep -rn "from '.*<模块名>'" *.mjs` —— 每个 import 方都是一个入口。

## lark-cli 调用审计（A 方案，2026-07-30 上线）

**它解决什么**：Bot 声称"已更新表格/已标红"而实际一次写命令都没发。L0 方法论早有
"写完回读拿证据"铁律仍被违反（13:07 上线修复、15:16 同一 Bot 照犯）→ 需要不依赖
Bot 自述的事实。

- **原理**：ro-bind 覆盖 lark-cli 的 **Go 二进制**（`run.js` 用
  `path.join(__dirname,"..","bin","lark-cli")` 调它，绕过 PATH 直接调也拦得住），
  真二进制换挂 `/opt/lark-cli-real`。wrapper 只记命令结构，**flag 值一律不记**
  （载荷里有人事数据）。
- **灰度开关**：`.env` 的 `H_LARK_AUDIT`（空/`0`/`off`=关；`all`/`1`=全开；
  否则逗号分隔 uid 白名单）。**owner Bot 不进沙箱，天然不受影响。**
- **日志**：`/srv/h-platform/audit/lark-cli/<uid>.log`。**缺文件会自动补建**
  （`resolveSandboxSpec` 里，排在降级门之前；补建失败照旧降级，绝不让 bwrap 起不来）。
  所以加灰度用户不再需要手工 `touch` —— 但**这段代码被 revert 误伤过一次**，
  改这块前先确认它还在（`grep -n "自动补建\|fs.open(spec.larkAuditLogHost" lib/sandbox.mjs`）。
- **现状（2026-07-31 09:0x）**：`H_LARK_AUDIT=all`，`ops/verify-audit-tenants.mjs`
  实测 **9/9 已登记租户覆盖**。
- ⚠️ **判"某租户没调用过"之前先看开关**：空日志既可能是真没调，也可能是审计没对他开。
  历史上出现过 8 个 0 字节残留文件（预建后开关被回滚），差点被读成"这些人没调过"。
- **验收链三层，别混用**（每层只回答它那一问）：

  | 脚本 | 回答什么 |
  |---|---|
  | `test/lark-audit.test.mjs` | 补建/降级/不截断的单元语义（11 条） |
  | `ops/verify-audit-coverage.mjs` | 机制能不能工作（一次性 uid，自清理） |
  | `ops/verify-audit-tenants.mjs` | **开关真开着吗、每个真实租户真覆盖吗** |
  | 同上 `--live <uid>` | 真实 uid 跑一次 lark-cli，断言它自己的日志真增长 |

  ⚠️ `verify-audit-coverage.mjs` **自己注入 `H_LARK_AUDIT: 'all'`**，
  所以它永远绿，**不能拿它当"覆盖证明"**——探针把答案写进了自己的输入。
  这跟验收 prompt 自带答案是同一个毛病（[[feedback_acceptance_prompt_carried_the_answer]]）。
- ⚠️ **`test/lark-audit.test.mjs` 曾经根本不在 `npm test` 里**（从建立起就没接线，
  `git log -S"lark-audit.test.mjs" -- package.json` 空）。文件在 ≠ 套件跑它。
  **判"某测试在守着"要去 `package.json` 的 test 脚本里 grep 文件名**，别看目录。
- **回滚**：`H_LARK_AUDIT=0` + 重启 bridge **和 runner-worker**，挂载即摘。
- **判读**：`cmd=` 后面是「域 子命令 flag名」。写类看 `+cells-set` / `+cells-set-style`
  / `+workbook-create` / `docs +update` 等；只有 `+cells-get` / `--help` / `get_node`
  这类 = 没写过。
- **诚实边界（别当铁证用）**：日志证明「发生过调用」，**不证明「没发生过」**——
  Bot 能追加伪造行（删改历史做不到：bind-mount 文件内核禁 unlink，truncate 被
  字节偏移检测抓到）。所以对外只说"本次实际执行的调用"，**绝不说"已验证写入"**。
- 部署源在仓库 `ops/lark-cli-audit`，与 `/srv/h-platform/shared/bin/lark-cli-audit`
  必须 md5 一致（别只改生产不入库）。
- **wrapper 同时负责给 `auth login` 注入 `--no-wait`**（2026-07-31 起，`NOWAIT_UIDS="all"`）。
  为什么：阻塞式 `auth login` 把授权 URL 困在没返回的工具调用里，检测器
  （`lib/interactive-wait.mjs:78`）要求输出里有 URL 才触发 → 撞墙 = 620s 打满 +
  不发卡 + 堵住 proactive 串行队列。注入后实测**撞墙到发卡 1 秒**。
  `NOWAIT_UIDS` 语义与 `H_LARK_AUDIT` 一致（`all`/空/uid 白名单），改它即时生效、
  **不用重启不用发版**（wrapper 每次 exec 重新读）。owner 不进沙箱，碰不到。
- ⚠️ **改 wrapper 必须用原子 rename，不能原地截断写**：正在跑的沙箱 ro-bind 着这个
  文件，`cat >` 会破坏它正在 exec 的脚本，违反 fail-open 铁律。
  `cp 新文件 .tmp && chmod 755 && mv -f .tmp 目标` —— 旧 inode 被 mount 钉住，
  在跑的任务不受影响，新沙箱绑新文件。
- ⚠️ **`inferLarkAuthorization` 是从 Bot 的自然语言正文里正则抠 `--domain` 值的**，
  措辞带 markdown 反引号或中文标点就会抠出脏值 → broker 调 CLI 判非法 →
  **卡片发不出来，只降级成一张没按钮的通用提示**。已加合法域白名单
  （`6d33ad4`，+3 回归测试）。日后扩域名要同步改那个白名单，否则新域会被静默丢弃。
  详见 [[feedback_parsing_agent_prose_for_machine_params]]。

## 改 L0 共享 skill 的正确路径（2026-07-30 踩过）

**控制面才是 skills 的 source of truth**，dev198 的 `/srv/h-platform/shared/skills/`
只是 bridge 每 60 秒同步下来的落盘——**直接改 dev198 会在一分钟内被盖回去**。

正确入口：管理台 / `POST /admin/api/skill`（`action: add-content`，内部走 `intake()`）。
**别直接改控制面的 `data/skills.json`**：那会绕过 `intake()` 的全部副作用 ——
① 属主/权限（我用 sudo 写成 `root:root` → h-control 读不到 → **crashloop 73 秒**）
② 内存缓存（不重启不生效，而重启正是踩到权限坑的那一刻）
③ `refreshPristineForks()` 级联刷新（有用户是 fork 副本，**沙箱 L2 优先于 L0**，
不刷新他就永远吃旧版）④ 安全/隐私扫描。
迫不得已直改时，逐条把副作用补回：`chown` 到服务用户 + `chmod 600` 对齐邻居文件 +
重启 h-control + 手工同步 fork（连 fork 头部的「原版 sha / 最近同步」注释一起改，
否则注释在说谎）。详见 [[feedback_bypassing_app_write_path]]。

## lark 用户授权墙：auth login = device-flow 轮询，不是 stdin 交互（2026-07-30 晚）

- **表象是「挂住」，本质是在轮询等用户授权**：沙箱 agent 跑 `lark-cli auth login`
  会打印授权链接后轮询等待；有人点授权卡完成授权，命令即自行解除阻塞继续任务。
  挂死 628s 的真机事故根因不是「跑了 auth login」，是**卡片没发出去**没人授权。
- 检测链：runner 输出过 `lib/interactive-wait.mjs` 的 `createOutputPublisher`
  （**必须见到真实授权 URL 才触发**，纯报错文本 fail-closed）→ IPC
  `runner-worker-ipc` 转发 `onUserActionRequired` → bridge 起 auth broker 发
  「授权当前机器人」卡 → 授权完成 `retryAfterAuth` 自动续跑。**kimi/grok 两个
  runner 都已接线**（grok 2026-07-30 晚补齐，此前只有 kimi——grok Bot 撞墙
  平台无感知是 AI 专家事故的根因）。撞墙不硬续：超时降级送达等自动续跑。
- 排障顺序：journal 搜 `user action required feishu_cli_auth`（消息路径）或
  `user action delivered (proactive)`（探针路径）→
  没有=检测没触发（看 runner 输出里有没有授权 URL）→ 有但没卡=broker/发卡段。
- ⚠️ **三条路径都要带 `onUserActionRequired`**：权限卡路径 / 真实消息路径 /
  proactive 探针路径（第三条 2026-07-30 晚补齐——此前探针通道不带回调，
  检测器整个跳过，授权卡在验收通道**结构性不可能出现**，正是「验证路径≠
  生产路径」；契约测试锁 broker 触发点=3 处）。
- L0 `lark-shared` 教 agent 三步法：`auth login --no-wait --json` 拿
  verification_url → **写进回复正文**（阻塞式写法会把 URL 困在未返回的
  工具里，检测器看不到）→ 平台发卡+授权后续跑。禁 `config init`。
  真机对比：修复前挂死 628s 只回文本链接；修复后 12s 完成、授权卡 13s 送达。

## 🔴 验收四层对齐（2026-07-30 同一天栽四次归纳出来的）

同一条经验一天内以四种形态咬了我四次，单看每次都像新问题，排一起才是同一件事：
**我验的那条路，和用户走的那条路不是同一条。**

| # | 形态 | 差在哪 |
|---|---|---|
| 1 | 改共享 lib 只重启一个进程 | **进程**：另一个加载的是旧代码 |
| 2 | 探针通道没传 `onUserActionRequired` | **接线**：该能力在验收通道里结构上不可能出现 |
| 3 | 探针走干净会话、生产注入 chat-history | **上下文**：近因压过每轮必进的托管块 |
| 4 | 只比 SKILL.md，没比 references | **数据面**：144 个附件里 1 个是旧的 |

**四层对齐**：代码（版本/md5）→ 进程（每个加载方都重启且晚于 mtime）→
上下文（history/记忆/角色文件同源同量）→ 数据面（每类产物都比到，per-tenant 副本单独比）。

配套两条铁律：
- **用户第二次说「还是不行」，不许复用上一轮验收结论**——那结论正是被证伪的对象。
  川哥三次追问各挖出更深一层；若第二次就说"我验过了"，等于把真实反馈驳回去。
- **验收断言不要与产物内容同形**：我让 Bot"自查描述里有没有字面 `\n`"，它把这句
  要求写进了产物正文，回读检出 7 处——全是内容引用，差点误判成没修好。
- 🔴 **考知识 ≠ 验行为**：巡检问"你会用什么命令写法？"，8 个 Bot 全答对（贴出
  heredoc+`$(cat)`+完整骨架）→ 判全绿；用户真实使用时同一台 Bot 写了一行流水账。
  问句里带了正确答案的提示，测的只是"能不能"，永远测不出"会不会"。**验收 prompt
  用用户的原始措辞，判据取真实产物的结构**（回读字段原文），不看 Bot 自述。
- **验收者够不到租户私有产物时，让创建者把验收者拉进可见范围**（川哥原话"邀上我
  我就能看见了"）：各 Bot 把日程建在各自用户私人日历，owner 通道搜不到——这是隔离
  设计不是故障。让 Bot 把验收者加为参会人，由人做最后一厘米确认，比提权去读干净。
- ⚠️ **proactive 队列串行，会被"注定超时"的探针堵死**：没授权的 Bot 跑满墙钟
  （实测 620s）卡住后面所有轮次。清障用**精确 PID**——`pgrep -f <关键词>` 会把
  自己这条命令行也匹配进去（`pkill -f` 自杀坑同款，2026-07-30 又实证一次）。

## 主动验收入口 proactive-acceptance（Codex 建，2026-07-30 实战）

铁律 13 要 Bot 主动闭环时用它，别手搓 runner（grok runner 还要 `mapStore`，
且它在 worker 进程里）。写请求文件即触发，完整过公平容量/TaskSessionLog/Outbox/飞书 ACK：

- 请求：`workspace/.state/proactive-acceptance-request.v1.json`（0600），
  `{version:1, requestId, probes:[{id,botLabel,appId,openId,prompt,expectText}]}`，
  **至少 2 个 probe**；结果落 `…-result.v1.json`；bridge 每 2 秒轮询。
- ⚠️ **`expectedMatched` 是字符串匹配，判据很脆弱**：实战中一个 Bot 明明全做对了，
  只因回复措辞没原文引用 `expectText` 就被判 `ok` 但 `expectedMatched=false`、
  整个 request `status=failed`。**可靠判据是审计日志与目标副作用，不是文本匹配。**
- 💡 **`expectText` 留空 = 不断言，只验送达**（2026-07-31 查证源码）：
  `expectedMatched: probe.expectText ? reply.includes(expectText) : null`，
  而 `status: every(p => p.ok && p.messageId && p.expectedMatched !== false)`
  —— `null !== false`，所以**空断言不会拖垮 `completed`**。
  只想验证「主动消息通道 + 飞书 ACK」时就该留空，别硬塞一个测模型能力的断言。
  我 2026-07-31 设 `expectText="147714"`（让 Bot 算 3517×42），Bot 两条消息
  都 `ok=true` 且拿到 messageId，却因这条精确子串没命中判成 `status=failed`
  —— **通道是好的，失败的是我的断言**。报告时要分清这两者。
- ⚠️ **`proactive acceptance runner started` 不等于"任务开始了"**，它只是
  `start()` 完成、**轮询器起来了**（每 2 秒扫 request 文件）。没有待处理请求时
  它就静默待命，**永远不会有对应的 `finished`**。我 2026-07-31 按字面理解，
  等了 400 秒没等到 finished，一度判成"卡住了"，直到读源码才发现是空转。
  判断卡住的正确依据：runner 日志有没有 `grok start skey=accept:<requestId>:<probeId>`，
  以及 healthz 的 `liveGrokSessions` / `activeSessions` / `queueDepthTotal`。
- ⚠️ 验收任务**一律让 Bot 自建带「可删」标记的新表/新文档**，绝不在用户既有的
  人事/业务文件上做写入测试。
- ⚠️ **清理要按"搜索"清，不能按 Bot 自述的 id 清**：2026-07-30 晚 AI 专家重试过，
  实际建了 3 条同名日程只报了 1 条；我删完它报的那条，`+search-event` 一搜还剩 2 条。
  收尾固定动作：按标记词搜一遍 → 逐条删 → **再搜一次确认命中 0**。
- ⚠️ **探针 prompt 的措辞会进入产物**：我让 Bot「自查描述里有没有字面 `\n`」，
  它就把这句要求**写进了日程描述正文**，回读时检出 7 处字面 `\n` —— 全是内容引用，
  不是排版失败，差点误判成"没修好"。**验收断言不要与产物内容同形**；真判据要能
  区分"格式失败"与"文本里提到了这个格式"（本次改看真实换行数与分段结构）。

## 🔴 沙箱内外能力对等（川哥 2026-07-30 定为开发与验收规则）

**沙箱内的用户 Bot 使用 skills 的效果，必须与 owner Bot 一致。** 允许存在差异的只有
凭据来源、沙箱边界、隐私脱敏；**不允许出现"owner 会做而用户 Bot 不会做"**。

### 已发现的两类系统性缺口

1. **共享版 SKILL.md 比 owner 私有版少内容**。实证：`lark-schedule-collab`
   owner 255 行 / L0 **116 行** —— 时间换算（禁心算用 `date -d`）、`events patch`
   改 location、邀人规则、写后回读清单、汇报口径、多日行程、反模式**整段全缺**。
   这就是"约日程效果差别很大"的一半原因。已补到 233 行（余下 22 行是个人 open_id
   列表/会议室楼层/业务案例，**本就不该进多租户共享层**）。
2. **`skills-sync` 只同步 SKILL.md，从不同步 `references/`** → **断链**。
   实证：L0 `lark-calendar/SKILL.md` 引用 4 个 references（suggestion 7.2KB /
   create 4.7KB / freebusy 3.9KB / agenda 2.3KB）**全部不存在**；`lark-base` owner
   有 **87 个** references，L0 零。Bot 顺着链接读不到文件**不会报错，只会凭猜** ——
   这是隐形的能力缺失，比报错难发现得多。已同步 157 个文件到 L0 + 各用户 fork。
   ✅ **E3 已治本（2026-07-30，v1.34.0）**：附件（references/templates/scripts
   整个子树）原生同步——控制面 `data/skill-refs/` 为真源（`/internal/skill-refs*`
   三端点），执行面按 `refsSha` 差异拉取 + **每轮本地自愈**（实测删文件 20s 补回，
   sha 一致），只删自己跟踪的、手放文件不动。发布/修订附件走
   `node ops/push-skill-refs.mjs --apply [--only skill]`（dev198，先 source .env；
   `>256KB` 的推送靠 nginx h-ai 里 `/internal/skill-refs-put` 专属 16m location，
   别改 `location /` 的 256k）。⚠️ **附件隐私门是真实 ID 门**（ou_32hex/omm_16hex+/
   租户根路径），与 SKILL.md 基础门刻意分层——官方参考文档的示例邮箱/示例 token
   是合法内容，拿基础门扫附件=整类误杀（实测 18 处全为假阳性）。

### 🔴 「改了共享层」到「每个租户都拿到」之间有六层会静默截断（2026-07-30 全景）

一个"把排版优化同步给所有人"的任务，逐层追出六个缺口，**每层都零报错**。
下次遇到"我改了但某个 Bot 没生效"，按这张表逐层排：

| 层 | 缺口形态 | 排查命令 |
|---|---|---|
| 1 内容 | 共享版丢了私有版的**命令手法**（把"怎么做"当业务细节泛化掉） | `diff <(owner 版) <(L0 版)` 看命令块 |
| 2 载体 | skill 按 description 匹配触发，**不保证每轮加载** | 铁律该进托管块而非 skill |
| 3 上下文 | chat-history 的旧"成功先例"压过托管块（老用户中招、新用户没事） | 比两个用户的 history 体量 |
| 4 副本 | L2 fork 因记账落后被判"用户改过"而**冻结** | `forkIsPristine` / 见下节 |
| 5 分流 | kimi/omp 走另一条 harness 腿（写不同的 AGENTS.md） | 按引擎分别查托管块文件 |
| 6 附件 | fork **只复制正文**，`references/` 不跟随 | 逐文件比 sha，别只比主文件 |
| 7 缺省行为 | 规范只以"知识"存在：Bot **答得出**骨架，真实任务却写一行流水账 | 把缺省行为写死进托管块（"用户只说要 X 时，要的就是这套完整结构"）|

**共性**：都不是"代码写错了"，而是**改动没有到达每一个消费点**。多租户平台里，
投放链上任何一环有 per-tenant 副本、有引擎分流、有触发概率，改动就会在那里静默截断。

### 🔴 新用户/新变更自动生效的三层机制（2026-07-30 立，川哥要求）

今天三个缺口全靠人工 grep 才发现，共同点是**零报错、纯静默**：某用户 fork 冻在旧版、
kimi 用户走另一条 harness 腿少一条铁律、某 skill 被装前复扫永久拒收卡 5 天。

| 层 | 机制 | 位置 |
|---|---|---|
| 自动生效 | L0 共享目录 + 托管块（App 启动时写）+ runner 代码 → 新用户天然继承 | 无需动作 |
| 自动跟随 | 共享层记 `shaHistory`（上限 30）；`forkIsPristine` 判「正文命中当前/任一历史/记账 sha」→ 未修改就继续跟随 | `control-plane/lib/skills-store.mjs` |
| 自动发现 | 逐用户断言托管块/L0 落盘/附件 refsSha/fork 跟随，有落后 exit 1；user 级 timer 每小时跑 | `ops/tenant-parity-audit.mjs`、`ops/parity-timer.sh` |

```bash
set -a; . ./.env; set +a
node ops/tenant-parity-audit.mjs            # 人读版（有落后项退出码 1）
node ops/tenant-parity-audit.mjs --json     # 机读版；timer 落 /srv/h-platform/audit/tenant-parity.json
systemctl --user list-timers h-tenant-parity.timer
```

- **fork 冻结的原理**（务必记住）：旧判定只比 `origin.sourceSha`，一旦 fork 正文与
  记账不同步（**历史上绕过 store 直改 skills.json 就会**）→ 永久判成"用户改过" →
  停止跟随、能力冻结、**零报错**。所以「绕过 API 直写」的代价会在几天后以
  "某个用户的 Bot 跟别人不一样"的形式回来。
- 🔴 **直写 skills.json 后必须紧跟 `align-forks.mjs`**（否则 fork 立刻落后一版）：
  直写绕过 `upsertContent` → 不触发 `refreshPristineForks` → 有 fork 的用户当场
  掉队。2026-07-30 我一天内犯了两次，**第二次是巡检替我抓到的**
  （`parity=LAG items=1`，fork 停在上一版 sha）。固定动作：
  `直写 → restart h-control → align-forks --dry-run 看有无落后 → --apply → 复跑巡检`。
- ⚠️ **门控必须证伪**：交付巡检前**人为造一个落后**（删掉某用户托管块的 marker）
  确认它报得出来 + exit 1，再恢复并 diff 逐字节一致。永远返回绿的门比没有门更危险。
- 巡检认 `users.json` 遍历，所以**新用户加入后下一轮自动纳入**；kimi/omp 与 grok
  的托管块文件位置不同，脚本已按引擎分流（改引擎归属时注意）。
- ⚠️ **fork 只复制 SKILL.md 正文，附件属共享资源**：L2 fork 的 `references/`
  必须跟随同名共享版（`syncRefsOne` 的 `refsSource`：user 层取同名 platform meta；
  用户自装且无同名共享版时不动其目录）。此前拿 fork 自己的 key 取 → `refsSha`
  恒 null → 附件永远停在人工铺过的那版：实测某用户 144 个附件里 1 个是旧模板，
  Bot 顺着链接读旧版、**不报错只照旧做**，只查正文的巡检发现不了。巡检 E 项已补。
- **新用户自动生效已实证**（2026-07-30 21:14）：机制建完后一个真实新注册用户
  `u-9a037b10f7` 无任何人工干预即托管块含最新铁律、挂到 39 个最新共享 skill、
  巡检直接全绿。这是"新用户天然继承"的活体证据，比模拟可信。

### 两个例行工具（都在 bridge 仓 `ops/`）

```bash
bash ops/skill-parity-audit.sh            # 对账：owner 独有 / L0 独有 / 同名内容差（按行数差排序）+ references 缺失
bash ops/sync-skill-references.sh         # dry-run 看哪些 references 可安全同步
bash ops/sync-skill-references.sh --apply # 真同步到 L0 + 所有用户 fork
```

**触发时机**：owner 侧装了新 skill / 改了 skill、给平台加 L0 skill、用户报"Bot 不会做某事"。
**读法**：行数差 ≥10 优先审（很可能整段能力缺失）；差 1~2 行多为 frontmatter，但别默认无碍。

### 🔴 搬 skill 时最容易丢的是「怎么做」，不是「做什么」（2026-07-30 晚实证）

川哥拿三张截图对比：owner Bot 的日程描述是漂亮的分段结构，两个用户 Bot 的描述里
全是字面 `\n\n` 挤成一坨。根因不在 Bot，在我：owner 私有版写的是
`--description "$(cat /tmp/event_desc.txt)"`（**多行文本先落文件、再命令替换传入**），
我搬 L0 时把它"泛化"成 `--description "<目标、议程…>"` —— 手法没了，Bot 只能内联
单行，想分段就塞 `\n`，而 **shell 双引号不解析 `\n`**，字面量被原样存进飞书。

- **脱敏该删的是"哪张表、谁、哪个域名"；命令写法/参数形态/避坑顺序一个字都不能省。**
  搬完自问「照这份文档能把活干成吗」，而不是只问「敏感信息清了吗」。
- **模板骨架也要照抄**：我把 `【MODE】…／B 背景／R 诉求…` 分段式改成紧凑单行式，
  产出的排版就与 owner 不一样——**格式是交付质量的一部分**。
- 该类问题的通用自查（写进了 L0）：回读时 `grep -c '\\n'` 必须为 0；
  命中即写成了字面量。`events.patch --data @file.json` 里的 `\n` 是合法 JSON 转义、
  会被解析成真换行，那条路可用；**纯文本 flag 上写 `\n` 永远是错的**。

**🔴 改完 skill 还不够：skill 是概率性载体，铁律要进托管块**
补完 L0 后川哥真实使用（原话说了「用最新的技能」「注意议程排版」）依旧内联 `\n`
——会议室那段读到了、传参那段没执行。grok skill **按 description 匹配触发、不保证
每轮加载**；而 `lib/memory-routing.mjs` 的 `h-method` 托管块**全文进 system prompt、
每轮必生效**。所以：「一句话就能说清、且不可让渡」的铁律放托管块，详版留 skill。
- 块体积纪律：当前 1002 字符，`test/method-defaults.test.mjs` 锁着体积与幂等（预算
  5500；AGENTS.md 每文件 10000 字符是**静默截断**，超了挤掉的是用户自己写的规则）。
- 改完必须**重启 bridge**：`ensureMemoryRouting` 在 `bridge.mjs:1632` 启沙箱时写入；
  内容没变则幂等不写盘（用户 AGENTS.md 的 mtime 不动是正常的，别当没生效）。
  判据看 mtime + 真实渲染文本：`grep -A2 '<关键词>' /srv/h-platform/users/<uid>/.grok/AGENTS.md`。
- ⚠️ **验收必须用用户的原始措辞**：prompt 里凡提示了正确做法（"先读最新 skill"、
  "注意排版"），就只验证了"能不能"，没验证"会不会"。要证明确定性，用纯自然措辞复验。
- ⚠️ **不要在 wrapper 层自动把 `\n` 转成换行**（我评估过并否掉）：实测
  `sed 's/\\n/换行/g'` 会把 `C:\new_folder` 一起转坏——静默改用户数据 + 有损坏风险，
  违反不可变红线。机制层要做的是**给信息**（托管块）而不是**改数据**。

**🔴 托管块还会被 chat-history 的"成功先例"压过（2026-07-30 第三层）**
托管块每轮必进 system prompt，但**私聊路径还会注入用户近期对话**。老用户的 Bot
跟他聊了一整天，历史里全是自己旧写法的成功先例 → 近因压过托管块，照旧犯错；
当天新开通的 Bot 历史干净，同一改动就生效了。**「同一改动 A Bot 生效 B Bot 不生效」
先比两者的上下文体量，再怀疑机制。**
- 修法在上下文层：`lib/grok-runner.mjs`（及 `kimi-runner.mjs`）注入历史时的免责声明，
  从只框「身份自称」扩到同时框「输出格式/排版/命令写法」，并写明"即使那几次看起来
  成功了也不作数"。`test/history-format-scope.test.mjs` 锁着这三项。
  **不要去清理历史**——清一次不解决，历史会不断产生（原注释 H-P0.3 已论证过）。
- ⚠️ **proactive 探针验收不了这一层**：它走干净会话、**不注入 historyText**，
  每个 probe 还是独立 sessionKey。所以涉及"历史影响"的修复，**最终确认必须在真实
  私聊里做**（或让用户测一句，同时 `ps -eo args | grep '近期对话上下文'` 抓真实
  拼装的 prompt 自证新声明已在里面）。验收通道要对齐的第三层是**上下文构成**。

### 脱敏判定要"准"，不能一味从严

同步脚本的脏词判定初版用 `ou_[a-zA-Z0-9]{10}`，把官方示例占位符 `omm_xxx` / `ou_…`
也当成真实 ID 拦掉了 —— **连约日程最需要的 `lark-calendar-create.md` 都被跳过**。
收紧为真实 ID 模式后只剩 1 个真需要拦的（含 `mycc/` 本地项目路径）：

- **拦**：真实 open_id `ou_[0-9a-f]{32}`、真实会议室 `omm_[0-9a-f]{16,}`、真实人名、
  业务代号、本地绝对路径（`mycc/…`）
- **放**：官方占位符（`ou_xxx` / `omm_xxx` / `ou_…`）、内部规则编号（对用户 Bot 只是
  噪音不是隐私）

**过严的脱敏会以"保护隐私"的名义造成能力缺失**，和过松一样有害，方向相反。

### owner 独有 skill 的处理

owner 有 10 个 L0 没有的 skill。按含专属标记数量分：零标记的（`agent-self-improve`
125 行 / `lark-whiteboard-lite` 256 行 / `feishu-whiteboard-to-bitable` 207 行 /
`h2-sop-onboarding` 98 行）**可脱敏后进 L0**；有标记的（`ai-collab-method` 5 处 /
`bitable-status-sync-remind` 7 处 / `org-capability-gap-diagnosis` 7 处 /
`feishu-doc-collab-review` 6 处）需人工判断。~~待川哥拍板范围~~
✅ **已全量搬完（2026-07-30，川哥拍板「10 个都脱敏之后都搬过去」）**：实测清单
9 个（「第 10 个」是 owner 目录里名字含 ANSI 色码的垃圾目录）；3 个走
`scripts/publish-l0-skill.mjs`，6 个被控制面 extraPatterns（scrub-terms 词表仍执行
旧策略：企业域名/部门代号/wiki token 全拦）拦下、按预案走 `ops/l0-skill-patches`
直写（模板：`ops/l0-skill-patches/e1-e2-migration/e1-direct-write.mjs`，内置与
bridge 装前复扫同门的基础扫描）。脱敏口径：人名/open_id/appId/真实资源 token →
占位+现查命令；公司 wiki 链接/部门名/编码/业务案例/会议室名单照搬；owner 专属
基础设施（evolve 管线/proactive 通道/systemd 定时）在正文里**如实标注**，防租户
Bot 照做挂死。

⚠️ 反向也要看：`lark-sheets` 现在 L0 **比 owner 多 93 行**（写入/标红配方是 L0 先加的），
owner 侧反而缺 —— **一致是双向的**。

## 远程侦察脚本：先"发现"再"正式"（2026-07-30）

给 dev198/aliyun-hk 写侦察脚本，第一版凭记忆写路径/端口/服务名**必踩**（我 07-30
一次踩了三个：系统级 `systemctl` 而非 `--user`、healthz 用 8788 而非 18765、
控制面 `/srv/h-control` 而非 `/srv/h-control/app`），而且失败长得像"服务挂了"
（`Unit could not be found` + healthz 空响应），差点误判成生产故障。

**顺序固定**：先跑一轮**发现型**探测拿真值 —— `systemctl --user list-units | grep`、
`ss -ltnp`、`ps -eo pid,lstart,etime,args`、`systemctl cat <svc> | grep
ExecStart\|WorkingDirectory`、`find <root> -name <file> -maxdepth 4` —— **再**写
正式脚本。另：ssh 内联一旦出现嵌套引号/中文括号/`$()` 就写脚本文件 scp 过去跑
（这条已是老账，07-30 又被中文括号咬了一次：`未预期的记号 "(" 附近有语法错误`）。

## 🔴 规矩不生效时先看载体，不要再加一层规则（2026-07-31 一整夜换来的）

「日程描述要写完整骨架」这条规矩，为它堆过四层——补 skill 手法 → 进 AGENTS.md
托管块 → 历史免责声明扩到格式 → 把「缺省行为」写死进托管块。**每层验收都通过，
川哥一测就是一行流水账。**

### 载体优先级（越靠近当前指令越不容易被稀释）

> **任务 prompt > 托管块 > skill 正文 > 历史先例**

最后有效的不是第五层规则，是**换载体**：把要求追加进任务 prompt 本身
（`lib/task-hints.mjs`，接在 `runner-adapter.run()` —— grok/kimi/omp 与 owner 的
唯一必经路径，零 uid 分支）。识别「创建/修改日程」类任务后，在**用户指令之后**
追加：先加载 skill → 骨架七段 → 两步法命令原文 → 回读自查。

要求必须**可直接照抄**。只说「需要什么结构」而不给写法，Bot 会卡在「多行怎么传」
上，然后退回一行流水账。

关掉：`H_TASK_HINTS=0`。覆盖自检：`node ops/verify-hints-coverage.mjs`。

### 反证：owner 没有托管块，却一直写得对

owner 的 `workspace/AGENTS.md` 里**没有 h-method 块**，用户有。
「写进托管块 = 建立了缺省行为」这个判断被自己的对照实验推翻——
托管块只是提高概率的一层，不是开关。

## 🔴 验「缺省行为」只能用用户原话（同一夜的根因）

四层修复之所以全是假验收，是因为我的验收 prompt 长这样：

> …描述**必须是完整的 MODE/B/R/O1/O2/P2/C 分段结构**、段落之间空行…
> 给我约一个…测试日程…**要有详细议程**…

而真实用户说的是「帮我建一个明天晚上的日程，标题 xxx。不要约会议室，不要邀请任何人」。

**带着答案的卷子考不出「它自己记不记得」。** 注意第二条我当时标的是「自然措辞验收」
——读起来像人话，但「要有详细议程」**仍然是一个要求**。**自然 ≠ 不提要求。**

规矩：
- 验「能力」用带要求的 prompt；验「缺省行为」**只能**逐字用用户原话，一个字不许加。
- 手上没有原话就等他下次真实使用，别自己编「差不多的」——编出来的必然携带我对问题的
  理解，而那正是要被检验的东西。
- **用户说「还是不行」而我这边全绿 → 第一个怀疑验收方式，不是再加一层修复。**

## 动作门（PreToolUse 拦截）：试过，回滚了，别再走一遍（2026-07-31）

grok hooks 确实能用，但**这条路对「产物形态」问题不成立**，当晚整体回滚（`e6a01ff`）。

**为什么不成立**：判定准确 ≠ 问题解决。真机日志显示门连拦两次，Bot 内容一字未改，
撞到保险丝后放行——拦截没有转化成正确产物，只是把「排版难看」变成「多绕两圈」。

**三个具体的坑**（都实测过）：
1. **兜底机制对被约束方可见就变成绕过路径**：我把「最多 2 次后放行」写进拒绝消息，
   等于教它「再试两次就放行」，它就机械重试等放行。
2. **门只能判它看得见的东西**：判据建在整个命令行上时，标题里的「【可删】」会污染
   骨架检测；描述按规范用 `$(cat 文件)` 传入时命令行里根本没有正文 ——
   **越照做越被误判**，那也就成了绕过路径。
3. **一晚四次栽在转义层数**：sed 里的 `\x27` 不是转义、JS 模板吃掉 `${}`、
   case 模式反斜杠多写一倍、生成器把真换行直接写进单引号串。
   生成代码时「目标语言要看到什么」和「我在生成语言里写什么」永远差一层；
   sh 里做字符串提取优先用**纯 POSIX 参数展开**（没有转义层）。

**留下的实测结论**（省得再验一次）：
- hooks 在 `--permission-mode bypassPermissions --always-approve` 下**照样求值**，
  `exit 2` 真能拦住命令；payload 里中文**原样不转义**，整段 grep 即可。
- **hooks fail-open**（脚本崩溃/超时/缺失 → 放行）→「没有 deny 日志」≠「没有违规」。
- matcher 的工具名是 **`run_terminal_command`**（不是 `Bash`，也不是 `run_terminal_cmd`）。
- `config.toml` 可以 `--ro-bind` **绑它自己**：沙箱内只读、host 侧照常写（同一 inode；
  前提是平台用 in-place writeFile 而非原子 rename）。
- 门脚本用 `sh` 不用 node/python：dev198 实测冷启动 sh 0.9ms / python3 9ms，
  而 grok 一个任务几十次 shell 调用。

**通则：能用「给信息」解决的，不要用「拦动作」。** 拦截的正确用武之地是
**不可逆副作用**（删除、外发、花钱），不是产物形态。

## 🔴 数据边界：内部使用，别过度脱敏（川哥 2026-07-31 拍板）

**H 平台就是在公司内部使用，用户全是内部员工。**

以下**不算隐私**，写进 L0 共享 skill 没问题，**看到了不要清、不要再花时间纠结**：
- 会议室名与楼层（`F5：503 海森堡 / 504 普朗克 / 505 狄拉克 …`）
- 部门名、内部工具名、内部流程名
- 业务场景词（如「异地融资落地」这类描述任务类型的词）

真正要处理的只有两类：
1. **凭据与技术标识**：token、`ou_` / `omm_` 真实 ID、租户绝对路径 —— 安全问题，不是隐私问题。
2. **具体人名**：目前仍泛化（共享层给所有同事读，写死某人名字对别人没意义），
   不是因为敏感；要改按川哥明确指示。

### 代价是实打实的

E1 搬 owner skill 到 L0 时按「一律脱敏」处理，把 frontmatter 里整行
`Triggers: 约日程, 邀某人, 出差日程, 补会议室, …` **整行删掉**（因为混着人名地名），
连带删掉了触发机制——用户 Bot 在自然措辞下压根不加载该 skill，排版问题追了一整天。

**过度脱敏造成的能力缺失，比它防住的那点信息值钱得多。**
真要处理时：**换占位符，不整段删**——换掉敏感的值，保留承载功能的结构。

### 现状（2026-07-31 已补回）

`lark-schedule-collab` L0 版 v1.2.0 已带 28 个脱敏触发词，
description 里另加一句「凡创建或修改日程，描述都要写完整分段骨架，
即使用户没明说『要议程』也照此执行」。
发布走 `scripts/publish-l0-skill.mjs`（控制面 API，自带 control/local 双向 sha 验收）。
盘点结论：39 个 L0 skill 里**只有这一个**丢过触发词，其余都完好。


## 多站点执行（Mini A/B）· 运维要点（2026-07-31 起）

**分支**：`codex/h-mini-ab-poc`（**尚未合 main**，codex 还在做 Mini 线）。
dev198 已切到该分支运行。合并前先跑 `npm test` 全量 + 两端 healthz + 控制面唯一租约。

**站点归属真源是 `users.json` 的 `executionSite`**，不是任何健康页读数：

```bash
python3 -c "import json;d=json.load(open('/srv/h-platform/users.json'));
[print(u['uid'],u.get('botName'),u.get('executionSite','dev198')) for u in d['users']]"
```

- dev198 的 user-sync 会**把非本站用户从本地 users.json 过滤掉并写回**。
  所以两端各自只看得见本站用户（2026-07-31 实测 dev198 = 10 个 App / 9 个用户 + owner，
  Mini = 1 个），是设计如此，**不是掉了用户**。数字会随开通漂移，别记死——
  全量真值在控制面，本地只是本站视图。
- owner **不参与 placement**：`shouldUseAppPlacement` 要求 `ctx.kind==='user'`，
  且控制面 claim 只在用户注册表里找 appId，owner 不在其中直接 404。健康页里
  owner 那条 `lease` 恒为 null，正常。

**唯一长连接怎么保证的**（改这块前先看懂）：控制面冲突返 409 → `control-client.mjs`
的 `call()` 对 `!res.ok || !data.ok` **两者都抛** → `start()` 抛 → bridge 不建连。
另有一道 `body.site === user.executionSite` 校验，没租约也抢不走别站的 App。

**租约丢失会自愈**（`08074df` 起）：`lose()` → 断 WS → 指数退避重新申领
（5s 起、×2、封顶 60s）→ claim 成功才 `onRegained` 重建 WS。
`lease.status()` 能看出「正在重试 / 已掉线多久」。
⚠️ 改自愈逻辑时**必须保住**「claim 成功才重连」——否则会出现双长连接。
测试 `test/app-placement-reclaim.test.mjs` 第②条就是钉这条的。

**真机验证租约自愈**（比读代码有用）：

```bash
# 强制释放某 App 的租约，看它能不能自己回来（选川哥的测试 Bot，别碰同事的）
curl -s -X POST -H "Authorization: Bearer $H_CONTROL_TOKEN" -H 'Content-Type: application/json' \
  -d '{"appId":"<appId>","leaseId":"<leaseId>"}' "$H_CONTROL_URL/internal/app-placement/release"
# 然后看日志：lease lost → reacquired attempts=N down=Nms → 重建 WS 长连接
```

### Mini 站点的部署形态（与 dev198 处处不同，别套用）

两端的部署路径、守护和日志入口不同，不能照搬命令；但 `/healthz` 已统一使用
`apps{}` envelope，巡检读取逻辑应共用：

| 项 | dev198 | Mini |
|---|---|---|
| 路径 | `~/feishu-grok-bridge`（git 仓库） | `~/local/h-platform-mini-bot`（**非 git**） |
| healthz | `127.0.0.1:18765` | `127.0.0.1:18775` |
| 进程管理 | `systemctl --user feishu-grok-{bridge,runner-worker}` | launchd `com.hplatform.mini-bot.{bridge,runner}` |
| 日志 | `journalctl --user -u …` | `workspace/.logs/bridge.{out,err}.log` |
| healthz 结构 | 统一 `apps{}`，`appCount` 为多 App | 统一 `apps{}`，`appCount=1` |
| node 路径 | `~/.local/node/bin`（非交互 ssh 必先 export PATH） | `~/.hermes/node/bin`（**同样不在非交互 PATH**；真值取自 launchd plist 的 ProgramArguments，2026-08-03 实测 which/homebrew/usr-local 全无） |

- 单文件热修同步 Mini 的实操（2026-08-03 走通）：dev198 `git diff --name-only
  <mini基线>..<目标>` 定差异集 → 逐文件 md5 对撞 → scp 经 Air 中转（家网走
  `mini-pub` 公网别名）→ `write-deploy-meta --commit <目标全sha>`（差异集全拷齐
  才许不带 dirty）→ **先拷完再 kickstart**（先 runner 后 bridge）→ healthz 验
  version=目标 commit。

### 🔴 Mini 连接 GitHub：只能走本机 Xray，禁止直连

这是 Mini 的硬性出站规则，不是可选优化：所有 `git clone/fetch/pull/ls-remote`、GitHub
Release 下载、Raw/API/Codeload/Objects 请求，都必须经 Mini 本机 Xray
`socks5h://127.0.0.1:10808`。**Xray 不在线就让操作失败，禁止直连、禁止静默回退、禁止临时
清空代理“先把活干完”。**

- Git 操作只走 `scripts/mini-github-git.sh`；它强制注入 `http.proxy` 和空 `NO_PROXY`，并拒绝
  调用方覆盖代理配置。
- 下载只走 `scripts/mini-github-fetch.sh`；只接受 GitHub 官方域名，并显式使用
  `--proxy ... --noproxy ''`。
- Mini 初始化或规则更新后执行 `scripts/configure-mini-github-proxy.sh`，把 GitHub 官方域名的
  Git 全局配置锁到本机 Xray；该脚本先验代理、再写配置、最后用 `git ls-remote` 闭环。
- 禁止在 Mini 上直接运行裸 `git ...github...`、`curl https://github...` 或
  `wget https://github...`。发现旧脚本存在这些路径，先改为统一入口再执行。
- 验收至少包含：10808 单一 Xray 监听、代理请求 HTTP 200、Git 全局配置值为 loopback Xray、
  `mini-github-git.sh ls-remote` 成功；不得通过任何关闭代理后的直连成功来“验收”。

边界：这是应用/运维入口的 fail-closed 约束；macOS 原生 POC 尚未用 PF/netns 做网络层物理封锁。
若未来要求“任何进程都无法绕过”，必须把 GitHub 出站也纳入 Mandatory Action Gateway 或
Linux 网络命名空间/防火墙白名单，不能把当前规则误报成物理不可绕过。

`apps{}` 是当前真值，顶层单 App 字段只作兼容。不要再维护两套结构解析器；站点差异只在
端口、进程管理和日志读取方式。

⚠️ **找 Mini 的守护别 grep `feishu` / `grok` / `h-mini`** —— 标签是 `com.hplatform.*`，
三个词一个都不匹配，`launchctl list | grep -i feishu` 会返回空，让你误判成「没有守护、
进程是孤儿」。用 `launchctl list | grep -i hplatform`。我 2026-07-31 就这么误判过，
还把错误结论写进了交接文档。

⚠️ **KeepAlive=true 会抢跑你的部署**：kill 掉进程后 launchd **4 秒内**就拉起来。
若流程是「停 → 拷文件 → 起」，launchd 会在拷贝完成前用**旧代码**把服务拉起来，
healthz 一切正常，你以为部署成功了其实跑的是旧的。
**正确顺序：先拷文件，再 `launchctl kickstart -k gui/$(id -u)/com.hplatform.mini-bot.bridge`**
（runner 同理，先 runner 后 bridge）。别用 nohup 手工起——会被下面的 app lock 挡下。

⚠️ 本机还有一道应用层互斥：bridge 启动抢 `logs/bridge-<appId>.lock`，抢不到直接
`[fatal] Another feishu-grok-bridge holds app lock (pid=…)` 退出。这是好事（双实例在
代码层就走不通），但意味着手工起的进程会**静默失败**，得去 `err.log` 才看得到原因。

**Mini 在跑哪个版本？先看 healthz，别再手工对撞**（`022618c` 起）：

```bash
ssh rayman.chen@192.168.61.66 'curl -fsS --noproxy 127.0.0.1 http://127.0.0.1:18775/healthz' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["version"]);print(json.dumps(d["deploy"],indent=2))'
# version = <commit 前12位>，代码与该 commit 不完全一致时带 +dirty 后缀
```

真源是部署根目录的 `.deploy-meta.json`（`lib/deploy-meta.mjs` 读，白名单构造，
非法内容 fail closed 成 `{available:false}`，绝不回显原文）。生成/校验：

```bash
node scripts/write-deploy-meta.mjs --root <PROJECT_ROOT> \
  --commit <40位sha> --branch <分支> --source-host <主机名>   # 省略 --dirty 即 dirty=false
node scripts/write-deploy-meta.mjs --root <PROJECT_ROOT> --check   # 只校验
```

⚠️ **`dirty=false` 是一句承诺，别随手给**：置 false 前必须用该 commit 的 git 清单
核对到「tracked 0 不一致 0 缺失」，且额外文件逐一分类到位。分不清的就留 `+dirty`
—— 虚报干净版本比没有版本更糟。
⚠️ `manifestSha256` 覆盖整个部署目录（只排顶层 `.git/.env/.deploy-meta.json/
data/node_modules/workspace`），所以 `logs/` 一变它就变，**只能用于自我一致性
校验，不能跨机比对**。`fileCount` 同理。
⚠️ **别在部署根目录留备份文件**：`.deploy-meta.json.bak.*` 这种会被算进 manifest，
`fileCount` 直接 +1（我 2026-07-31 就这么把 521 弄成了 522），而且每次部署累积。
详见 [[feedback_verification_artifact_pollutes_measurement]]。

`.git` 仍是悬空指针（`gitdir: /private/tmp/feishu-grok-bridge-codex.0RIHus/...`，
路径已不存在），所以 `git` 命令在 Mini 上依然不可用。**md5 逐文件对撞仍是
dev198/工作树 → Mini 的拉平与核对方法**（2026-07-31 两次实操）：

```bash
# ① dev198：从 git 对象取（不取工作树，避免夹带未提交改动），排除 owner 的 workspace/
ssh dev198 'cd ~/feishu-grok-bridge && git ls-tree -r <sha> --name-only | grep -v "^workspace/" \
  | while IFS= read -r f; do printf "%s  %s\n" "$(git show "<sha>:$f" | md5sum | cut -d" " -f1)" "$f"; done > /tmp/manifest.txt'
# ② Mini 侧比对（macOS 用 md5 不是 md5sum，所以用 python3 跨平台算）→ 得到差异集
# ③ git archive <sha> -- <差异文件> 打 tar 过去解开（保留可执行位，ops/lark-cli-audit 需要）
# ④ 复跑 ② 应得「0 不一致 0 缺失」，再 kickstart -k
```

⚠️ **绝不整目录 rsync**：dev198 是 Linux、Mini 是 macOS，`node_modules` 里有平台相关的
原生模块；`workspace/` 是 owner 的活文件（硬边界禁止同步）；`.env` / `data/` 是站点私有。

### 清部署根遗留文件：删之前先证明能删

部署根会攒下暂存目录、`.env` 备份这类东西，它们**都会被算进 `fileCount` 和
`manifestSha256`**，留着既污染指纹又误导排查。但删是不可逆的，按类型选证法：

**代码类副本（如 `.deploy-stage/`）—— 证「无人用 + 是旧副本」**：

```bash
lsof +D "$D/.deploy-stage"                                  # 有无进程打开
grep -rn "deploy-stage" "$D"/*.mjs "$D"/lib "$D"/scripts "$D"/deploy   # 代码有无引用
md5 -q "$D/.deploy-stage/bridge.mjs"; md5 -q "$D/bridge.mjs"           # 逐个与运行版对
```
三项都过才删——**尤其第三项**：要确认它是「陈旧副本」而不是「唯一副本」。
2026-07-31 实测三个文件分别是 2fbd4ef 版 bridge、租约自愈前的 app-placement、
旧版 install 脚本，全是残留。

**`.env` 备份 —— 证「是当前配置的真子集」，只比键名绝不看值**（含凭据，隐私墙）：

```python
# 解析成 {key: value} 后只输出键名集合的差集；值只判等，永不打印
只在备份里有的键 = set(bak) - set(cur)   # ← 必须为空，否则删掉会丢配置
只在当前里有的键 = set(cur) - set(bak)   # ← 正常，说明备份更旧
值不同的共同键   = [k for k in cur&bak if cur[k]!=bak[k]]   # 只列键名
```
2026-07-31 实测：当前 53 键 / 备份 47 键，**只在备份里有的键 = 无**，
差的正好是 6 个代理键 —— 备份 ⊂ 当前，删除零信息损失，也反证了它就是
改代理那次的快照。

⚠️ **回滚副本一律放到部署根之外**（如 `~/local/h-mini-cleanup-<ts>/`，700，
`.env` 类保持 600）。放在部署根下等于白清——又会被 manifest 扫进去。
见 [[feedback_verification_artifact_pollutes_measurement]]。

清完记得重生成元数据 + `kickstart -k` bridge，并复验「tracked 0 不一致 0 缺失 +
tracked 数 + 额外数 = fileCount」闭合。

## 🔴 dev198 出站代理（2026-07-31 事故后重构）

**曾经的坑**：`/etc/environment` 里写着 `HTTP_PROXY=http://10.9.1.57:10808`
（2026-07-17 配的，指向 **Mini 的 DHCP 地址**）。Mini 换手动 IP 后该目标失联，
xAI 只能走代理（直连超时）、飞书 token 刷新也走它，**9 个 Bot 全线不可用 12 分钟**。

现在三层都指向 dev198 自己的 Xray `127.0.0.1:10808`（`protocol=mixed`，HTTP/SOCKS 都支持）：

| 层 | 位置 |
|---|---|
| 两个 Bot 服务 | `~/.config/systemd/user/feishu-grok-{bridge,runner-worker}.service.d/10-proxy.conf` |
| 登录 shell | `~/.config/proxy-mini.env`（由 `.profile:36` 加载，**排在 source .bashrc 之后**，会覆盖 .bashrc） |
| 系统级 | `/etc/environment`（需 root，川哥手动改的） |

⚠️ **注入点有三个，改代理要三处都看**。当初我只修了 `/etc/environment` 就宣布收工，
结果登录 shell 仍是死地址——第二个注入点藏在 `.profile:36`。
⚠️ unit 级 `Environment=` **优先于**继承来的环境（实测证伪过：把管理器环境设成
死地址重启，进程内仍是 127.0.0.1）。

## 🔴 日志绝不 dump 第三方错误对象

`lib/safe-logger.mjs`（`e06858e` 起）：飞书 SDK 的默认 logger、Node 的
unhandledRejection 默认处理器、以及 `main().catch` 里的 `console.error(err)`，
三处都会 `util.inspect` 展开 `err.config.data` —— 那正是
`{app_id, app_secret}`，2026-07-31 真把某个 Bot 的凭据反复写进了 journald。

- 已注入 bridge 全部 4 处 Lark 客户端的 `logger:`，并接管进程级异常。
- **加新的 Lark 客户端时记得带 `logger: createSafeLarkLogger(log)`**，否则又走默认。
- 排查时用 `journalctl … | grep -v app_secret` 过滤，别为看上下文把凭据再复述一遍。
- 详见 [[feedback_never_dump_foreign_objects_to_logs]]。

## 双站升级与稳定性门（2026-08-01 实操）

**稳定性门要求两端 deploy commit 一致** —— `lib/mini-ab-observer.mjs:67`
`if (!dev.commit || dev.commit !== mini.commit) throw new Error('deploy commit mismatch')`。
只部署一端就跑这个门，会 1 秒内失败、`samples: []`，看起来像脚本坏了，其实是
它正确报出了真实的版本分叉。要么两端都升，要么明确跳过该门。

**升级 dev198 前的三个前提**（改的是共享 lib 时必查，别只读 diff 就说安全）：

```bash
# ① 平台分支依赖的脚本在不在（改动常是 darwin/else 分支，Linux 走 else）
ssh dev198 'ls -l ~/feishu-grok-bridge/scripts/ai-memory-provision.sh'
# ② 有没有环境变量把默认路径改掉（.env 与进程 environ 都要查）
ssh dev198 'grep -c "^H_MEMORY_PROVISION_SCRIPT=" ~/feishu-grok-bridge/.env;
  PID=$(systemctl --user show -p MainPID --value feishu-grok-bridge);
  tr "\0" "\n" < /proc/$PID/environ | grep -c "^H_MEMORY_PROVISION_SCRIPT="'
# ③ 确认它真走 else 分支
ssh dev198 '~/.local/node/bin/node -e "console.log(process.platform)"'   # linux
```

再加零交集核对（待部署改动 vs dev198 本地已改 tracked），全过才 `merge --ff-only`。
2026-08-01 实测：`lib/memory-provision.mjs` 的改动全是平台分支、Linux 路径逐字未变，
升级后 10 个 h-memory 实例一个没掉、owner 13 项活文件原封未动。

⚠️ **dev198 的 healthz 就绪要 ~57 秒，Mini 只要 ~4 秒**（10 个 App 的长连接 vs 1 个）。
这个差异要记住：**哪天 dev198 重启后 10 秒就"就绪"，反而要怀疑没连全**，
别把快当成好。

⚠️ `.deploy-meta.json` 是未跟踪文件，`git merge --ff-only` **不会更新它** ——
快进后会出现「代码已是新 commit、元数据仍写旧 commit」的脱节。升级流程必须包含
「重写元数据 + 再重启一次 Bridge（Runner 不读元数据）」。

## 清理已迁走用户的 ai-memory 残留

用户迁站后，原站的 per-user ai-memory 实例**不会自动回收**：systemd 服务仍
`active`、进程仍在写日志、`ports.json` 仍有条目、data-dir 仍在。它没有消费方，
但占资源，且将来若有人误连会造成记忆分叉。

清理前先证明它确实闲置（三项都要）：

```bash
# ① 站点归属真源里已无此 uid
python3 -c "import json;d=json.load(open('/srv/h-platform/users.json'));
print([u['uid'] for u in d['users']])" | grep -c <uid>
# ② 本站 healthz 的 apps{} 里没有它的 appId
# ③ data-dir 近期修改情况（注意：服务自己会写心跳日志，
#    「文件在被写」≠「有人在用」，别被这条吓住）
```

清理动作（顺序不能反）：

```bash
systemctl --user stop  h-memory@<uid>.service
systemctl --user disable h-memory@<uid>.service     # 不 disable 的话重启后自起
cp -p /srv/h-platform/memory/ports.json{,.bak.$(date +%Y%m%d-%H%M%S)}
# 从 ports.json 移除该 uid 条目
mv /srv/h-platform/memory/<uid> /srv/h-platform/memory/.archived-<ts>/<uid>
```

⚠️ **data-dir 归档不删** —— 那是用户的记忆数据，不可逆。停服务 + 移出注册已经
消除了资源占用与误连风险；删数据是另一个决定，必须单独请示。
恢复就是反向三步：移回原路径 → `ports.json` 补条目 → `systemctl --user enable --now`。

## 🔴 期望「零命中」的检查，必须配一个「期望非零」的锚

2026-08-01 提交前跑安全扫描，8 项全部「0 处」，看着完美——实际是
`cat $FILES`（zsh 不对未加引号变量分词）把整个字符串当成一个文件名，
**扫描面 0 行，一个字节都没扫**。而它正要给「能不能提交」背书。

同一轮还栽了两次同族的：用外层 `ALL_PROXY` 测 fail-closed 得 `exit=0`
（脚本 `exec` 时会覆盖它，真正注入点是 `H_MINI_XRAY_PROXY`），
用文件名 grep 验新测试是否执行得 0 次（`node --test` 根本不打印文件名）。

**三次都是「没找到」，成因却是没执行 / 没打到点 / 输出形态不匹配。**
补救很便宜，就一行：

- 安全扫描：先打印 `实际读入 N 个文件 / M 行`，M=0 直接判检查无效；
  再加一个必然出现的正向项（如「`127.0.0.1:10808` 应 ≥1 处」），非零才算真扫了。
- 防护探测：先读实现确认**防护的作用点在哪**，把注入打在那个点上。
  说"没防住"之前先自问"我这一击落在它身上没有"。
- 输出解析：先确认被验对象**会不会产出我要 grep 的那个东西**。

详见 [[feedback_truncated_output_negative_conclusion]]。

## 🔴 权限引导链路（2026-08-01 一整天真机打通）

用户缺权限时的完整自助闭环。**四个环节任一断了，用户就永远等不到那张卡。**

### 环节一：授权卡有三个发卡入口，引导必须三处都接

`feishu_cli_auth` 的 `onUserActionRequired` 在 bridge 里有 **3 处**：
权限申请卡 / proactive 探针 / **真实任务**。真实消息走的是第三处。

我最初只接了第一处 → 日志出现 `lark auth needs console missing=510`
（引导对象造出来了）却没有一条 `guidance sent`（没人发）。用户看到的就是
「点了授权卡直接完成，还是没有引导」。

抽 `deliverConsoleGuidance` 统一投递，契约测试锁「1 处定义 + N 处调用」总数。
**验收要认消费端日志（`guidance sent`），不能只认生产端（`needs console`）。**
详见 [[feedback_multi_entry_single_consumer]]。

### 环节二：域从**审计记录**推断，不要解析 grok 的 stdout

`extractUserActionRequest` 只看输出末尾 6000 字符，而授权墙那段里**只有
device code**——真正说明「这次要什么权限」的调用在更前面，被 tail 截掉了。
结果卡上永远 `mode=recommend`，引导甩出全部 374 项而不是日历那 24 项。

⚠️ 走过的弯路：试图用「累积上下文」补。但 grok-runner 传给 `publish` 的
**本来就是累积全量**——问题从来不在没累积，而在 stdout 里根本没有可靠的域字面。

正解：`lark-audit`。wrapper 落的 `cmd=<域 子命令 --flag…>` 是**平台自己的
观测**，`head` 取第一个 token 就是域。`collect` 是纯读、不推进 offset，
撞墙时中途调用安全。推出域后**不再退回 recommend**，否则引导重新覆盖全部缺口。

```
17:00:21  lark auth domains from audit  calendar
17:00:21  lark auth request domains=calendar mode=exact   ← 不再是 recommend
17:00:22  needs console missing=24                        ← 374 → 24
17:00:25  guidance sent domains=1 asFile=0 json=1899      ← 1.9KB，贴得进卡
```

### 环节三：JSON 一律送到用户手里，**绝不建议「后台全选」**

🔴 曾经的兜底是「缺口太大就去后台全选一次」。**那是错的**：全选会勾上
corehr / payroll / attendance / acs 等 **11 个禁止域**——正是标准包特意排除的。
照做等于先开一个隐私风险窗口，再让巡检去收拾。测试里有一条**安全断言**
锁死：任何情况下渲染文案都不许出现「全选」。

投递统一收口到 `deliverGuidanceJson`，**内容一字不减，只换通道**：

| 体积 | 通道 |
|---|---|
| ≤8KB | 单独发一条**纯文本**（长按整条即可复制；卡片代码块只能框选，手机上选不准） |
| >8KB | **文件**（`im.file.create` + `msg_type=file`） |
| 文件发不出 | 按域拆多份，**每份完整可单独导入** |

最后那层降级不是多余：**发文件本身要 im 权限，而最缺权限的用户恰恰最可能
发不出文件**。没有它，这类用户会收到一张说「文件在下一条」的卡然后什么都等不到。

⚠️ 上传必须落**真实临时文件**再 `createReadStream`。`Readable.from(buffer)`
没有 path，form-data 定不出 filename/长度，`im.file.create` 直接
`return res?.data || null`，表现是「code/msg 全 undefined」，看不出任何原因。

`tenant` 档按 user 缺口的域收窄——不收窄的话「缺 24 项 calendar」会生成
24.3KB（体积全是 tenant 那 668 项撑的），收窄后 1.9KB。

### 环节四：Bot 声称发了卡而平台没发 → 对账补发

grok 会照抄历史里自己上次的话，声称「已触发授权卡」而平台什么都没做
（见下一节）。任务成功收尾时：**本轮没发过卡 + 回复里声称发了** → 探测权限，
真缺才补发。**判据是平台自己的探测，不是 Bot 的措辞。** 探测拿不到时保守补发
（漏发＝永远等不到，多发＝一次轻打扰）。补发成功要置 `userActionSeen`，
否则授权完成时 `retryAfterAuth` 会因「主跑已成功且没撞过授权墙」skip 掉。

## 🔴 「新会话」必须真的断历史（2026-08-01）

新会话按钮原先只 `bumpGeneration` 换 sessionId + append 一条标记，
**从没截断过历史**，而 toast 写着「后续消息不再带旧上下文」。

后果：下一轮 prompt 仍带着上轮的 assistant 回复「我已触发飞书日历授权」，
grok 一字不差照抄——`turns 15→5`、**一次 lark-cli 都没调**。

`loadHistory` 现在截到最近一次重置之后；标记结构化落盘 `reset: true`
（靠文案识别一改文案就静默失效），并兼容线上已有的旧文案标记。
详见 [[feedback_reset_done_halfway]]。

## 🔴 巡检输出经管道会被腰斩（2026-08-01）

`ops/verify-lark-scopes.mjs --json | ...` 在 **65503 字节**处截断，
退出码却是正常的 1。根因是结尾 `process.exit(code)`——stdout 是管道时写入
异步，不等 flush 就走。**重定向到文件不触发**，所以只在脚本化调用时暴露。

已改 `process.exitCode`。⚠️ 中途的 `process.exit(1)` 是流程中止，**不能改**。
排查期间如果必须拿完整数据，先 `> /tmp/x.json` 再读。
详见 [[feedback_guard_itself_can_be_hollow]]。

## 权限现状快照（2026-08-01 17:20 实测，11 租户）

```
uid                app  token   缺app  待授权  越权
u-c7b6746691       588     91      0    422     7 ⚠️
u-f7870bc4b3       588    138      0    375     7 ⚠️
rayman.chen        512    171      0    342     0
u-e58e198624       481    151     79    283     7 ⚠️
u-001422f6e5       240    148    272     93     0   ← 测试 bot
u-01481f4a32       198    163    315     35     1 ⚠️
u-40a24632d0       168    159    344     10     0
u-aca292be3f       156    155    356      2     0
u-9a037b10f7       146    145    366      2     0
u-dec457e69d        97     53    415     45     0
u-93577af39a         2      0    510      2     0
```

🔴 **4 个租户持有禁止域**，其中 3 个含 `corehr`（人事 16–44 项）与
`payroll`（薪酬 10 项）——隐私红线，需本人去后台取消勾选。

**`token < app` 是普遍现象**：后台开通不会更新已签发的 user token，
必须重新点一次授权卡才追得上。**token 侧才是 Bot 的实际能力真值。**

## 部署收尾三查（2026-08-01 补，每条都踩过）

部署后**必须**核这三样，缺一样就可能「以为部署了其实没有」：

### ① 版本号对齐（healthz ≠ 磁盘是常态）

`healthz.version` 来自进程**启动时**读的 `.deploy-meta.json`。改了代码不更新
meta、或更新了 meta 不重启，两边都会不一致。今天两次踩到：

- 只 `git merge` 没重启 → healthz 停在旧 commit（这次是对的，因为改的是 ops
  脚本不影响 bridge；但版本号说谎会误导下一次判断）
- `write-deploy-meta ... >/dev/null 2>&1 && echo "meta ok"` **失败了**，
  而我盯着同批输出里别的结果，没发现少了 "meta ok" 那行

**写完 meta 立刻回读对撞**，别信「应该成功了」：
```bash
node scripts/write-deploy-meta.mjs --root . --commit "$(git rev-parse HEAD)" ...
python3 -c "import json;print(json.load(open('.deploy-meta.json'))['commit'])"   # 对撞
```
⚠️ **commit 必须 `git rev-parse HEAD` 取真值**，别手写——我伪造过一次 hash，
而稳定性门正是靠它比对双站。

### ② 重启后的「未连接」多半是中间态，别急着报故障

`systemctl restart` 后立刻查 healthz，常见 `ok:false` + 几个 App 未连接——
dev198 起 11 个 App 要 ~60s。**轮询到全连上再下结论**：

```bash
for i in $(seq 1 20); do sleep 10; n=$(curl -s .../healthz | jq '[.apps[]|select(.connected|not)]|length'); [ "$n" = 0 ] && break; done
```

今天第一次查显示 2 个未连接，10 秒后就全好了。急着诊断会浪费一轮。

### ③ 改了什么就重启什么

- 改 `bridge.mjs` / `lib/**` → **必须**双重启（bridge + runner-worker）
- 只改 `ops/**` 脚本 → **不用**重启（独立进程，直接读磁盘代码），但要更新 meta
- Mini 侧顺序固定：**先拷文件，再 kickstart runner，再 kickstart bridge**
  （KeepAlive 会在拷完前用旧代码拉起来）

## 权限对账卡（卡片 2.0）

真机验证于 2026-08-01，川哥客户端 7.73.9，**渲染正常、无版本提示**。
2.0 门槛 7.20，公司内全员已超过，可安全推广。

结构与坑：表格必须在**卡片根节点**（不可内嵌）、`width` 范围 `[80px,600px]`、
`padding` 多值必须写满四个。⚠️ 报错里的 `column idx` **会偏一位**，
别照着索引盲改。完整踩坑记录见 `feishu-docs` skill。

**第 4 条硬约束（2026-08-03 真机 400）**：2.0 **废弃 `tag:'action'` 交互模块**且
属性校验从「忽略」改「报错」——按钮直接放 `body.elements` 根层（`behaviors:
[{type:'callback',value:{…}}]`，回调数据到 `action.value`）；带回调按钮必须
`config.enable_forward:false`（转发出去按钮会被别人点）。
**验卡 harness 三坑**（当天连环踩，全红三轮后才发现是通道错）：
① `lark-cli api` 的 query 必须走 `--params '{"receive_id_type":"open_id"}'`，
塞进 path 会得到与卡片内容无关的恒定 99992402——先用**生产送达过的正例**钉通道；
② 发 interactive 卡必须 **bot 身份**（user 身份发卡受限，同码报错）；
③ 单发时错误在 stdout、批量 subprocess 里在 stderr，两个流都要读。

## 🔴 部署一律走 `ops/deploy-sites.sh`（2026-08-01 起）

**别再手敲 ssh 部署。** 上面「部署收尾三查」那几条我当天写进 skill、
一小时后照犯了三次——commit 手抄编错、merge 吞掉失败、meta 写失败没发现。
知道≠做到，所以固化成脚本：

```bash
ops/deploy-sites.sh both            # 双站部署
ops/deploy-sites.sh dev198 --check  # 只体检，不动任何东西
SKIP_RESTART=1 ops/deploy-sites.sh dev198   # 只改 ops/ 脚本时
```

脚本内建的硬约束（每条都对应一次真实事故）：
commit 只由 `git rev-parse` 取一次 · 失败即停不"部分成功" · meta 写完
**全量**回读对撞（比前缀等于没比）· healthz version 必须等于目标 commit ·
HEAD 未推送直接拦 · 工作区脏时只有内容与远端一致才敢丢弃、`workspace/**`
拒绝触碰 · Mini 先拷文件再 kickstart（KeepAlive 会 4 秒抢跑）· 重启后
轮询到全 App 连接才算成功。

⚠️ 脚本跑完仍会提醒：**新增命令/分支必须真机触发一次**——healthz 全绿
证明不了它能跑（当天权限对账命令上线即 ReferenceError，四道绿灯全没拦住）。

## 🔴 控制面“系统架构”Tab 发布与验收（2026-08-02 起）

### 五态必须分开报告

控制面功能有五个独立状态：**本地实现 → Git 提交 → 远端推送 → 生产部署 → 用户可见**。
任一环未完成都不能写“已上线”。尤其是页面本地测试全绿，但 aliyun-hk 仍是旧版本、
目标文件不存在、公网页面没有入口时，结论只能是“本地完成，待发布”；这不是浏览器缓存。

最小证据链：

```bash
# 本地：确认改动、版本和专项测试
git status --short --branch
grep H_VERSION control-plane/lib/version.mjs
node --test control-plane/test/architecture-snapshot.test.mjs \
  control-plane/test/pages.test.mjs \
  control-plane/test/runtime-endpoints.test.mjs
npm run test:runtime
npm test
git diff --check

# 线上：确认真正部署和用户入口，不能只看 systemd active
ssh aliyun-hk 'sudo systemctl is-active h-control'
ssh aliyun-hk 'grep H_VERSION /srv/h-control/app/lib/version.mjs'
ssh aliyun-hk 'test -f /srv/h-control/app/lib/architecture-registry.mjs'
curl -fsS https://ai.kidshub.cn/admin | grep -q 'data-tab="architecture"'
curl -fsS https://ai.kidshub.cn/admin/api/architecture
```

若公网需要登录，使用现有管理员会话做浏览器验收，不得把 cookie/token 写入命令历史、
文档、日志或 Git。线上验收必须再打开页面确认左侧“系统架构”Tab、画板交互、节点详情、
多租户链路筛选和原有 Tab 均可用。

### 架构图双真源与刷新机制

- `control-plane/lib/architecture-registry.mjs`：真实代码节点、链路、协议、功能分组和多租户阶段。
- `control-plane/lib/architecture-snapshot.mjs`：把 runtime reports、租约、用户/订阅、TaskSessionLog、
  Outbox 与恢复信息合成为匿名运行快照。
- `GET /admin/api/architecture`：轮询快照。
- `GET /admin/api/architecture/events`：SSE 被动推送；服务端每 5 秒检测变化。
- 页面可见时 30 秒轮询兜底，隐藏时 120 秒；SSE 断开必须明确显示并继续轮询。

展示边界固定：产品名只写“H 引擎”；允许真实代码文件名和通讯协议；禁止用户/App 标识、
凭据、内部地址、私有绝对路径和网络出口实现。没有运行报告的组件只能显示未知/待验证，
禁止用静态接线冒充健康。

### 多租户一致性的可视化验收

“所有租户 Bot 与 owner Bot 机制统一”不能只写一句说明，架构页必须展示并验证完整链路：

1. 租户开通与生命周期；
2. Person / Bot / 飞书租户身份归属；
3. BYOS 订阅与加密凭据保险库；
4. 全租户统一行为契约；
5. 多站点唯一租约；
6. 公平并发与容量调度；
7. 工作区与执行隔离；
8. TaskSessionLog、Delivery Outbox、恢复与主动送达。

一致性判据是各站点上报的 `behaviorContractVersion` 唯一且新鲜；只要 dev198/Mini 版本不同、
任一站点 stale 或缺报，就必须显示告警，禁止标记“统一正常”。功能修复还要经过真实 Runner
和 Bot 主动送达验收，架构图绿灯不能替代业务链路验收。

### 本轮发布边界

“系统架构”Tab 属于 aliyun-hk 控制面发布，只同步 `control-plane/server.mjs`、
`control-plane/lib/`、`control-plane/test/` 并重启 `h-control`。**不修改、不重启** dev198/Mini
Bridge 或 Runner Worker；远端 `.env`、`data/`、`node_modules` 必须保留。发布前备份
`/srv/h-control/app` 到部署根之外，回滚只恢复控制面代码并重启 `h-control`，禁止
`git reset --hard`，禁止覆盖用户数据和运行配置。

### v1.38.0 首发实录补充（2026-08-02，cc 收口实测）

- **计数口径在 snapshot 层**：「28 节点/38 链路」= 26 个 registry 代码组件 + `site:dev198`
  + `site:mini` 两个站点节点；34 条 registry 链路 + 4 条站点链路。registry 层数出 26/34
  不是缺数，别拿错层的数卡门。8 阶段在 `tenantManagement.stages`（`mechanisms=9` 是页面
  另一个机制区块，非阶段口径）。
- **远端预检若报「`引用了不存在的文件 bridge.mjs`」**：那是 2026-08-02 前的旧版
  `architecture-snapshot.test.mjs` 在子树布局下的假红（仓根假设）。新版已适配（仓根特征
  bridge.mjs/.git 在场才全量校验，子树部署跳过仓根侧文件并打 diagnostic「跳过 84 个」），
  生产预检应 52/52——还看到假红就把新版测试文件同步上去，纯测试文件不用重启。
- **带鉴权的新路由必须真机触发**：`/admin/api/architecture` 与 SSE 的既有测试全是源码
  字符串断言，handler 没真跑过。标准解法=生产机隔离实例真打
  （[[feedback_isolated_instance_live_probe]]）：同磁盘代码+独立端口+空 DATA_DIR+一次性
  env（`SERVICE_TOKEN` 有 ≥32 字符启动门），登录→API 验载荷 28/38/18/8→SSE 收帧→
  POST `/internal/runtime-report` 注入双站不同 `behaviorContractVersion`（形状抄
  `runtime-metrics-store.test.mjs`，顶层 `schemaVersion:1`+`site.executionSite`，猜错
  =400 `unsupported runtime metrics schema`）→ 验漂移进快照+SSE 推新帧 → PID 精确杀。
- **侧板浏览器验「30 秒轮询兜底」会假阴**：app 侧板 WebView `visibilityState` 恒为
  hidden，轮询走 120 秒档（`document.hidden?120000:30000`），36 秒零轮询是设计不是故障
  （[[feedback_visibility_gated_logic_needs_state_check]]）。SSE 断开兜底的验法：
  `architectureEvents.close()` + 手动调 `onerror` → 徽标转「SSE 断开，轮询兜底」→
  按当前档位等满周期看 performance resource 里轮询请求真实发出 → 刷新页面还原 SSE。
- **管理员会话拿不到时的分层验收**：公网 healthz 有版本（无鉴权）；`/admin/api/*` 的
  401 对存在/不存在路径长一样，证不了路由存在。密码红线不可代输、不自签 cookie 冒充
  「已有会话」；正路=侧板 Browser pane 停在登录页请川哥现场输一次，会话即归 cc 用。
  Chrome 扩展（claude-in-chrome）连不上时别死磕，它不是唯一入口。

## 公平调度当前版本验收与 Base 关闭（2026-08-02 实测）

历史上验过公平调度，不代表当前版本仍然成立。Runner 拆进独立进程、行为契约、容量策略或
送达链发生变化后，必须重新用当前生产版本制造真实竞争，不能引用旧 message ID 或旧测试结论。

### 验收前回滚门

在部署根和 Git 仓库之外建立受限目录，至少保存：

1. Base 表、字段、目标视图配置、主表记录和视图记录；
2. 待修改文档的原始副本；
3. Bridge、mycc、`.mycc-global` 三仓状态；
4. dev198/Mini/控制面健康快照；
5. 主动验收入口原始状态。

目录 `0700`、文件 `0600`，生成 SHA256 清单。Mini 当前不可达时如实记录，不得回退使用已废弃
的浮动地址，也不得因此跳过 dev198 单站验收。

### 真实竞争设计

- 只用川哥自己的测试 Bot，不把同事 Bot 当实验流量。
- 至少两个 App，每个 App 多个任务；总任务数必须明显超过 `workConcurrency.max`。
- 任务必须通过真实 Runner 和真实沙箱执行，不能用 sleep mock、直接调用调度器单测或 Bot 自述。
- 只验证通道和 ACK 时，主动验收的 `expectText` 留空；空值代表不做正文精确断言，不会拖垮
  `completed`。不要拿模型自由回答做精确字符串断言。
- 成功不仅要求结果文件 `status=completed`；每个 probe 必须 `ok=true` 且有唯一 `messageId`，
  两个 Bot 都至少有一个任务真实等待，容量释放后的获批顺序不能长期偏向单一 App。

### 终态与无残留判据

逐任务读取 TaskSessionLog，必须看到：

```
task_accepted → delivery_started → delivery_acked → task_completed
```

`delivery_acked` 必须早于 `task_completed`，每个任务只能有一个 terminal 事件。Bridge/worker 日志
不得出现本轮 request 的 timeout、failed、give-up。

⚠️ `runnerRpc.running/orphaned`、Recovery Planner 和 orphanRecovery 可能包含历史或累计值。
**非零绝对值不是本轮泄漏证据**。验收前后必须对同一字段做差值；只有增量大于 0，或当前
active/waiting/inflight/child/lease/Outbox 不收敛，才能判本轮留下残留。

最终健康门：所有 App connected、`lastError=0`、行为契约唯一值 1 个，active session、live
session、公平队列、Outbox pending/retrying、Runner inflight/active/children/leases 全为 0。

### Base 关闭流程

1. 按铁律重新串行读取 Base、表、字段、视图、表单、主表和目标视图；旧快照不能直接写。
2. 重新定位目标 record ID，再 `record-get` 读取完整当前记录。
3. 只增量更新状态、验收结论、实际结果、测试证据和运行版本；保留历史证据，不整段覆盖。
4. 写后再次 `record-get`，确认状态与证据落盘；再读人工开放视图，确认记录按筛选自然退出。
5. 禁止删除、重建、改名或改筛选来制造“已关闭”；没有用户授权，不处理空白/异常记录。
6. **关闭态统一口径 =「验收通过关闭」**（川哥 2026-08-02 拍板，已迁移 34 条历史记录）：
   新关记录一律写 `状态=验收通过关闭` + `验收结论=通过`。旧选项「已关闭」「验收通过」
   保留在字段与视图排除列表里（历史兼容），但**不再用于新写入**。
   衍生铁律——**统一 select 口径的三步顺序**：①字段加新选项（field-update 是 PUT
   全量语义，必须带上全部现有选项否则清空）→ ②视图筛选**先行**原位把新值加进
   disjoint 排除列表 → ③再批量改记录。②③反了记录会在改值瞬间涌回开放视图
   （本表筛选是 `状态 disjoint [...]` 枚举排除，不认识的新值=不排除）。
7. **record_id 每次按业务键（编号）重新定位，禁止沿用上文变量**：2026-08-02 我拿着
   H-0027 的 record_id 去读 H-0048，靠“写前按编号重定位”才没把补丁打到刚关的记录上。
   跨记录操作时旧 ID 就是错的 ID。
8. **改状态不能代替验收**：盘点发现状态落后时，「已修复待验收」只能由真机验收关闭，
   直接改成通过=伪造终态（同看板铁则“验收失败不自动改完成”的正向对偶）。

### 收口与部署边界

若本轮只改 Base、文档、Skill 和共享记忆，没有运行代码差异，则**不重启、不重新部署** Bridge、
Runner Worker 或控制面。cc 只需按仓库边界选择性提交和推送，并复核生产健康；把无代码重启
写进“部署步骤”反而会增加中断风险。

## H 入口监控：三层视角（2026-08-07 重构，取代原「只在本机跑」）

H-0048 故障形态是「生产端全绿、用户打不开」（本机移动出口漂移 + Xray 国内域名单路
DoH 不回退），所以监控**不能只靠服务器自测**——它永远 200。

⚠️ **但 2026-08-02 我把这条落地成了「只装在川哥的 MacBook Air 上」，是错的。**
Air 是移动办公本，通勤就没网。实测 6 天 1361 轮：83 轮异常里 **76 轮是本机网络**、
只有 7 轮是服务端，NETWORK 异常全堆在 09/18/19/20 点；**12 次告警 11 次是「你在路上」**。

根因不是选错机器，是**一个探测器同时回答了两个问题**：

| 问题 | 影响面 | 该告警？ |
|---|---|---|
| 平台真的挂了 | 所有人 | ✅ |
| 我这台机器连不上 | 一台 | ❌ 那是诊断信息 |

它没能力区分，而人会按最吓人的那个解读（"🔴 H 入口异常"读起来像平台事故）。
**分不开就说明视角不够，该加视角而不是加告警**（[[feedback_user_side_outage_needs_user_side_monitor]]）。

### 现行三层

| 层 | 位置 | 回答 | 告警 |
|---|---|---|---|
| **公网视角** | RackNerd `ops-uptime-kuma` 监控项 **id=16「H 平台控制面 HTTPS」** | 平台对外可用吗 | ✅ 飞书运维告警（通道 id=1，13 个监控项共用） |
| **站点视角** | dev198 `h-egress-probe`（`ops/egress-probe.mjs`） | 执行站点够不够得着控制面 | ✅ journal，2026-08-07 晚已两次抓到抖动 |
| **客户端视角** | Air `h-entry-watch` | 我这台机现在怎么回事 | ❌ **只记录不告警** |

**装监控前先过三问**，缺一条就别配告警：①这个点网络稳不稳（笔记本/手机/家里 WiFi 都不算）
②它在被监控系统之外吗 ③它回答的是哪一个问题。

### 公网层（Kuma id=16）

- 类型 **keyword**（不是普通 HTTP）：`url=https://ai.kidshub.cn/healthz`、`keyword="ok":true`、
  interval 60s、retries 2。**纯状态码检查会被空壳 200 骗过去**（[[feedback_hollow_200_needs_payload_check]]）。
- ⚠️ **Kuma 的关键词是字面匹配，不像 `h-entry-watch` 会先 `replace(" ","")`**。
  配之前必须先取原始字节确认形态——真值是 `{"ok":true,` 无空格；若线上改成 `{"ok": true}`
  这个监控会立刻判 DOWN 发假告警。**换控制面版本后重验这一条。**
- Kuma **没有创建监控项的 REST 接口**（`api_key` 表只对 `/metrics` 有效），
  官方路径是 socket.io + 登录态。所以本条是**直改 `/app/data/kuma.db` 建的**——
  做法：先备份（`kuma.db.bak-*`），**不从零构造行，而是从 pragma 动态取 76 个列名、
  克隆一条已知能跑的 http 监控**，再 UPDATE 需要改的字段 + 插 `monitor_notification`，
  最后 `docker compose restart uptime-kuma` 让它按正常路径加载。
  **验收看 `heartbeat` 表不看 UI 绿点**：`msg` 应为 `200 - OK, keyword is found`
  ——那句话证明关键词判定真的跑过，绿点证明不了。

### ⚠️ 告警投递仍未验证（2026-08-07 记，别当已验）

飞书通道（notification id=1）历史触发过 33 次、`type=Feishu`、`active=1`、webhook 已配。
**但 Kuma 的 heartbeat 表只记事件，不记投递结果**——「触发过」≠「送达过」。
真要确认只有两条路：①问川哥历史告警是否收到 ②造一次可控故障看真机送达。
在任一条完成前，这层的**告警能力**属未验证，只有**探测能力**是验过的。

### 客户端层（Air，已降级）

- 开关 `H_ENTRY_WATCH_ALERT`（**默认 0 = 不告警**）；抑制时写
  `~/.local/state/h-entry-watch/suppressed-alerts.jsonl` 留痕——**诊断价值不能因为闭嘴而消失**。
- `--test-alert` **绕过该开关**：否则「测告警」会静默成功，而静默成功与真发出去了长得一样。
- 抑制分支返回真值哨兵 `"suppressed"` 而非 `None`：**「决定不发」与「发失败」对状态机是两回事**
  ——前者照常置 `alerted`，后者保持未告警等下轮重试。混用会让 state 永不收敛。
- 保留它的理由：三层探测的**诊断**价值是真的。2026-08-07 那次就是靠
  **L3 代理绿而 L1/L2 红** 一眼判定「是本机解析，不是平台」。

### 原有实现细节（仍有效）

- 脚本：bridge 仓 `ops/h-entry-watch.py`；launchd `com.cc.h-entry-watch`
  （`~/Library/LaunchAgents/`，StartCalendarInterval 每 5 分钟——铁律禁 StartInterval）。
- 三层探测对应铁律 25 分层：L1 DNS@223.5.5.5 / L2 直连 healthz / L3 代理(10808) healthz，
  判成认 `200 + "ok":true` 载荷（防空壳 200）。判层：直连好代理坏=Xray 层（复发形态）；
  DNS 好直连坏=生产侧；双坏=本机出口。
- 告警通道显式 `LARK_CLI_NO_PROXY=1` 直连飞书 bot 私聊——**不依赖被监控的代理**；
  连续 ≥2 轮才告警（防抖），持续故障 6h 重提醒，恢复时通报期间失败轮数；
  发送判成认 `data.message_id` 非空，失败不置 alerted（下轮重试）。
- 状态/日志：`~/.local/state/h-entry-watch/`（state.json / probe-log.jsonl / launchd.*.log）。
- 验链路：`python3 ops/h-entry-watch.py --test-alert`；造可控失败：
  `--probe-url https://<不存在子域>.kidshub.cn/healthz` 连跑两轮（非默认 URL 的所有
  通知自动带 [TEST] 前缀，含后续恢复通报——标记记在 state.testAlert 里跟状态走）。
- 卸载：`launchctl bootout gui/$(id -u)/com.cc.h-entry-watch` + 删 plist。
- 已知边界：本机整体断网时告警发不出（监控无法自证），恢复后 probe-log 可回溯；
  Xray error log 未落盘（config `error:None`），DNS 错误无被动观测——行为级探测即替代。

## 新会话真实 CLI 执行（契约 2026-08-03.1 → .2 单卡状态机，双站已上线）

「新会话」按钮与纯文本 `/new`（无正文）共用 `queueNewSessionCommand` →
`lib/new-session-command.mjs`。语义：**先写新 sessionId 到 map → 真实 Runner 跑
CLI 初始化（short/2 turns，`replayable:false`）→ onChildSpawn 未触发即判失败 →
CLI 成功后才写 reset marker → 失败恢复旧 mapping**。`/new + 任务正文` 保持旧语义
（换 session 后直接执行任务）。机制项 `verified_new_session_command`。

- **面向用户文案统一「H 引擎」**（川哥 2026-08-03 拍板）：`engineCliLabel()` 恒返
  「H 引擎」，toast/成功卡/失败卡不得出现 Grok/Kimi 供应商品牌；内部日志仍分引擎。
  测试有反断言（`doesNotMatch /grok|kimi/i`），改文案先看它。
- **真机验收判据五件**（healthz 全绿证明不了它能跑）：①RPC 三态 `new-session-<uuid>`
  requested→acked→result；②runner 日志 `grok start mode=short
  mode_reason=new_session_cli_init sid=<uuid>`；③map entry `reason=card_new_cli`
  且 sessionId=同一 uuid；④reset marker（`role:system, reset:true`）时间戳晚于
  rpc_result；⑤后续任务日志 `sid=` 用新 uuid（切换真实生效）。
- ⚠️ **验 session map 按 sessionId 全 map 搜，别盯死历史 key**：租户 map key
  （`feishu:dm:<open_id>:<hash>`）的 hash 随 cwd/role 布局演进换代，同一用户会留
  多个代际 key。2026-08-03 我拿 7-30 的旧 key 当"主会话"做基线，写后读它当然没变
  ——全 map 按新 sessionId 反查才找到真实落点。同族教训：record_id 重定位（Base 节）。
- 观测点：租户 map `<usersRoot>/<uid>/.session-map.json`；RPC 事件
  `workspace/.runner-rpc/<sha256(appId:uid|owner)>`（**scope hash 对撞
  定位法**：`printf 'cli_xxx:owner' | shasum -a 256` 前 12 位=文件名前缀，可反查
  归属哪个 App）；历史 `<cwd>/.chat-history/<hash>.jsonl`。

### 单卡状态机（契约 2026-08-03.2，2026-08-03 双站上线）

点击后 10-20s 静默黑盒拆成单卡三段流：0s 发「⏳ 创建中」状态卡（`update_multi:true`）
→ `onStage('spawned')`（从 `onChildSpawn` 抛）原地 patch「🚀 已启动」→ CLI 成功
退出后同卡收敛「✅ 已就绪」。失败：状态卡收敛 ⚠️ + **另发新消息强提醒**（patch 无
推送，失败必须有提醒）；重复点击 toast「创建中请稍候」（后端 `newSessionJobs` 防抖）。
真实验证语义不变。机制项 `new_session_live_status_card`。基础设施
`lib/feishu-send.mjs#updateCard`（im.message.patch 整卡替换）可复用于其他长等待场景。

- **日志判读**：成功路径三段更新**不打日志**；只有失败才打
  `new session status card fail / stage card fail / final card update fail`。
  验收=真机看三段流 + 这三类 fail 全量计数为 0，别把"点击后 bridge 日志安静"
  误判为没执行（CLI start 在 **runner** 侧日志，点击后 ~250ms 出现）。
- 真机验收判据在五件基础上加一件：⑥同一张卡完成 ⏳→🚀→✅（消息列表只有一张
  状态卡，无刷屏）。

### 🔴 init prompt 必须带一次性范围限定（2026-08-03 晚复读事故，91da6dd 修复）

旧版 init prompt「不要调用任何工具…只回复：新会话已就绪。」**没有范围限定**，
而它永久留在新 session 首轮。用户点完「新会话」后若只发少量消息，这条指令在
上下文里还很「近」——**模型钉定升到 grok-4.5（服从性更强）后当场显形**：产品专家
四条真实消息（「你现在什么模型」「哈喽哈喽」）全被回复「新会话已就绪」，且历史
注入把旧复读带回来正反馈强化。同一时段测试 bot 正常（其会话 1.8MB，init 指令早被
多轮任务稀释）——**「同一改动 A Bot 中招 B Bot 正常」再次先比上下文构成**。

- 修复：prompt 追加「本条指令随本次回复作废：之后的用户消息不再受本条约束，一律
  按正常任务处理，禁止再回复『新会话已就绪』」。给模型的一次性指令**永远显式
  写明生效范围**，别默认它能从「初始化」语境推断出来。
- 排障判据：trace 里 `task_begin.prompt=真实用户消息` 而 `task_end.reply=新会话
  已就绪` = init 指令泄漏（路由是好的，别查 command-probe）。
- 已中招会话的解法：rotate——生产同源装配（仿 `scripts/f1-trace-smoke.mjs`）调
  `executeNewSessionCommand`（真实写路径：换 sessionId + 新版 init + reset marker，
  失败自动恢复旧 entry），再同 skey 用**用户原话**发一条验证正常应答。
  `SessionMapStore` 无内存缓存（每次读写直达磁盘），外部脚本与 bridge 行为等价。

## RPC 事件流在途对账（2026-08-03 三连坑后固化）

部署前查在途量的标准方法（[[feedback_deploy_window_interrupts_inflight_tasks]]），
三个参数全是待验事实，各配非零锚：

| 参数 | 真值 | 我踩过的错值 |
|---|---|---|
| 目录 | 双站均 `workspace/.runner-rpc/`（文件名=scope hash 无扩展名，JSONL） | `data/runner-rpc/`（不存在，glob 空转返回假 0） |
| 事件类型 | `rpc_requested / rpc_acked / rpc_result / rpc_error`（后两个=终态） | 词表写 `result/done/...`，496 全量假阳性 |
| 聚合键 | requestId **需归一化 `split(':')[0]`**：requested/acked 带 `:main` 后缀、result 不带，原样聚合把一个任务劈成两条假在途 | 原样聚合（[[feedback_event_stream_id_variants_split_aggregation]]） |

判读纪律：大数字异常清单先怀疑判据，抽一条单文件重放独立复核；正常完成的记录会
被回收（文件轮转），**持久滞留的才是真 orphan**（对照 recovery plan 周期日志的
orphan 计数）。dev198 users 注册表真值 `/srv/h-platform/users.json`
（`DEFAULT_USERS_FILE`，.env 无覆盖键）；Mini 在 `<部署根>/data/users.json`；
Mini 日志真值 `workspace/.logs/`（部署根 `logs/` 是 7-31 前的旧目录，别看错）。

## 部署窗口与在途任务（2026-08-03 实测教训）

**重启会把在途任务打断成 orphan**：10:02 部署 dev198 时，川哥 09:57 发给 owner Bot
的任务正在跑，重启后 runnerRpc orphaned 净增 1。判读与处置：

1. **部署前看一眼在途**：healthz `queueDepthTotal`/app 级 `activeTasks`，非零时
   要么等要么接受打断并事后对账。`--check` 体检不含这项，得自己看。
2. **orphan 增量=部署账**：orphan 绝对值含历史累计（7-30 起挂着 2 个），只有
   部署前后差值归本轮。定位归属：orphan 的 RPC 文件名→scope hash 对撞→appId:uid；
   事件里 `record.args.options.sessionKey` 含 open_id。
3. **orphan 恢复是管理台人工触发**（`/admin/api/orphan`，rerun 需 confirm=RERUN，
   cancel 不需），执行面 15s 拉一次 ops。`lastOpAt=null`=从来没人操作过，
   recovery planner 的周期日志只是报告不是执行。
4. `replayable:false` 的内部任务（新会话初始化）不会进 orphan 重放（replayRecord
   =null），用户任务才会——这是 2026-08-03.1 修复特意划的边界。
5. **在途授权流也是在途**（2026-08-03 真机：川哥点完授权卡的瞬间撞上重启，
   `flow failed exit null`×2）：broker 的 onComplete 监听与 `--device-code`
   轮询子进程都是**内存态**，重启即丢——用户浏览器里授权成功、token 却没写盘、
   链式下一批永不发。部署前 `journalctl` 查最近 10 分钟有无
   `lark auth flow started` 而无对应 `completed/failed`；有就等 600s 过期或
   让用户重点。恢复=让用户重新点按钮（流是点击时现开的，无状态可续）。

## 全员通知的最小合规路径（2026-08-03 实测，12/12）

共享机制变更后按铁律 13 全员主动通知。没有现成广播入口，标准做法：

- 一次性脚本复用 `lib/app-registry.mjs` 的 `loadAllCredentials`（需 env
  `FEISHU_CREDENTIAL_SECRET`+`FEISHU_ACCOUNTS_FILE`，仓根 `set -a && . ./.env`）
  + `loadUserRegistry` 过滤已激活 App + `buildStatusCard` 发 interactive 卡。
- 收件人=凭据 store 里各 App 的 `openId`（扫码人，即绑定用户）；owner 也发。
- **脚本必须放仓根跑**（/tmp 解析不到 node_modules），跑完立即删，不入 git。
- 纪律：`--dry-run` 先核对目标清单再真发；`uuid` 幂等键（`ns-upgrade-<日期>-<app后8>`）
  防重跑重复发；判成认 `data.message_id` 非空并逐条留存；两端（dev198+Mini）各跑。

## 架构画板路由与关系高亮（v1.38.1，2026-08-03 上线）

schemaVersion 3→4：每条边新增 `path`（正交圆角 M/L/Q 串）、`points`、`fromSide/toSide`；
组件新增 `h`（显式高度，站点 118 / 紧凑引擎 90）。路由在服务端
`control-plane/lib/architecture-routing.mjs`（直连候选 + 可见图 A*，两路都强制
`segmentClear` 不穿任何节点内部；`architectureRelations` 只算**直接**上下游，无传递闭包）。

### 验收判据（生产 API + 真机各一遍）

- API（`/admin/api/architecture`，注意**信封 `{ok, architecture}`**，顶层直读全 0
  是假读数）：schemaVersion=4、components=28、edges=38、protocols≥18、
  tenantManagement.stages=8；38 边全有 path 且 points≥2；快照全文扫
  uid/appId/openId/内网 IP/绝对路径必须零命中。
- 真机（JS 数值层，pane 隐藏也能做）：选中 `site:mini` → 摘要「mini · 上游 1 ·
  下游 1」；类名 is-upstream=app-placement / is-downstream=runner-worker；入边描边
  `rgb(47,111,237)` 蓝、出边 `rgb(124,92,231)` 紫；无关 25 节点/36 边 is-dim；
  关联边被 appendChild 到 SVG 末位（顶层渲染）；抽屉「直接关联」chip 可点导航。
- ⚠️ **验色读 longhand**（`borderTopColor`）：shorthand `borderColor` 序列化不可靠，
  会读出基色灰造成「规则没生效」假故障（[[feedback_computed_style_shorthand_unreliable]]）。
- 设计行为：选中节点期间链路筛选让位于关系高亮，关抽屉后筛选恢复（预览评审版一致）。

### 管理台带鉴权生产截图通道（侧板 pane 收起时）

pane `document.hidden=true` → 渲染冻结：截图白屏、click/scroll 超时，**javascript_tool
仍可用**——数值验收先行，截图殿后。截图走本地认证代理 + headless Chrome：

```bash
# jar 由 /admin/login 换取（密码经 stdin 传 curl，不进 argv；用完删 jar）
SHOT_MODE=fit  python3 .claude/skills/h-platform-ops/tools/admin-shot-proxy.py <cookie-jar> &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --window-size=1680,1000 --virtual-time-budget=13000 --screenshot=out.png \
  http://127.0.0.1:18999/admin
```

SHOT_MODE=fit（适配全局）/ mini（选中 mini 高亮）。四个坑（详见
[[feedback_headless_chrome_prod_screenshot_workflow]]）：jar 的 `#HttpOnly_` 行不是注释；
virtual-time 下禁用滚动截图（driver 把 `.arch-workbench` 临时 fixed 铺满代替）；交互全靠
注入 driver 模拟点击；**SSE 端点代理故意 502**——既防流式挂死代理，又让页面 EventSource
走真 onerror，顺手拿「SSE 断开，轮询兜底」真机 UI 证据（不扰动生产 SSE 的兜底验收法）。

## 控制面备份清理（app.bak-*，2026-08-03 起保留策略）

`/srv/h-control/app.bak-*` 每次部署新增一个（约 3.5M），保留策略：**只留最近 3 个**
（2026-08-03 已从 34 清到 3）。清理铁律：

- 命名四代混用（`MMDDHHMM`/`YYYYMMDD-HHMMSS`/`标签-epoch`/带文字后缀），
  **字典序 sort 不是时序**——曾把 epoch 命名的 7 月末老备份当成最新，差点删掉
  真正最近的两个。排序用 `stat -c %Z`（inode ctime，cp -a 伪造不了），并与
  名字语义对撞一致才执行（[[feedback_newest_n_by_ctime_not_lexical]]）。
- 删前先列保留/删除双清单 + `wc -l` 数量断言（不符中止），删后验
  `app` 本体在 + `h-control` active。

## 🔴 租户可靠性施工 P0-P3（2026-08-03 立项，P0/P1/P2 代码侧全部完成）

背景：租户 Bot「假完成/错交付/读表偷懒/忘指令」不是能力配置差距（四层全对等、
任务档位同款），两个真凶：①**会话累积超载**（同会话 17+ 轮滚到 5.2MB，CLI resume
截断历史，长上下文性能崩塌；owner 对照 0.45MB）②**交付前无机器验证**（说了≠做了）。
原则（川哥拍板）：**约束靠代码不靠提示词；飞书操作必须用户自己的权限**。

### 已完成

- **P3 根因定位（先行）**：grok CLI hooks 在租户 bwrap 沙箱内**完全可用**（真实
  生产链路探针实验，三类事件全触发）；「沙箱跑不了 hooks」系误诊，见上方勘误。
  修复路线拍板依据：Stop hook=官方「交付前验证门」（不满足条件不让收尾+理由喂回
  模型），PreToolUse=CLI 层拦截，租户 hooks 用 **HTTP 型**（宿主二进制沙箱内不可
  见，loopback 可达已被 MCP 通道实证）。
- **P0a 会话超载治理**：`GROK_SESSION_RESUME_MAX_BYTES` 双站 5MB→**2MB**（.env）。
  超线自动 `soft archive+rotate`（归档换新 sessionId）。验收=部署后真实流量日志
  `bytes=… soft=2097152`。诊断法：runner start 行的 `size=` 字段（per-sessionId
  目录 du），>1.5MB 即入灰区，症状=忘指令/幻觉交付/偷懒。
- **P0b 交付声明门禁**（契约 `2026-08-03.3`，机制项
  `delivery_claim_zero_call_disclosure`）：`lib/delivery-claim-gate.mjs` 的
  `resolveLarkFactLine` 三分支——有飞书调用→照旧附事实行；**零调用+回复含交付
  声明→披露「📋 本次未调用任何飞书命令」反证行**（原 A 方案零调用一律静默，纯
  嘴炮假完成正落在静默区）；tampered 无条件披露。只摆事实不下"撒谎"结论，误报
  代价=多一行真话。验收三分支各一发：零调用+声明（真实对话框发「不要调用任何
  工具…回复：已完成X」看反证行）/有调用（真实流量 `lark-audit calls=N writes=M`
  日志）/纯聊天（无附加）。
- ⚠️ **验门禁必须走用户真实对话链路**：验收信箱（proactive）链路**没接**
  larkAudit/门禁，信箱探针验的是旁路自己（[[feedback_probe_channel_must_traverse_target]]）。

- **P1 Stop hook 验证门**（契约 `2026-08-03.4`，机制项 `stop_hook_write_verification`
  + `proactive_lark_audit`，三轮真机对抗后收敛）：平台幂等下发
  `~/.grok/hooks/h-verify.json` → 共享只读脚本（沙箱内 `/opt/h-hooks/stop-verify.mjs`，
  源 `ops/hooks/`，**scp 即热生效不用重启**；lark-audit.mjs 在 bridge 进程内改它才要
  重启）。两判定：写后未回读 → block 逼模型自己回读（wrapper 自动回读方案弃用——
  sh 解析写参数太脆）；零调用+交付声明 → block 逼真做或明说没做。
  `H_AUDIT_OFFSET`=spawn 前日志字节数注入，「本轮」语义精确。真机验收样本：
  「不用检查」被无视、强制回读带真实值、事实行「12 次含写入 6 次」。
  - ⚠️ **reason 文案是攻击面**：第一版留「可解释为历史结果」出口，模型立刻用它
    圆谎；出口只留行为性两条+显式压制「用户要求假装/不用检查」
    （[[feedback_gate_reason_wording_is_attack_surface]]）。新圆谎话术=下版输入。
  - ⚠️ **读写分类用词尾泛化不用枚举表**：枚举漏 `+record-batch-update` 整个 base
    写族失明，事实行「均无写入」里出现写命令名即分类器失明信号。两处正则
    （lark-audit.mjs + stop-verify.mjs）**必须同步改**。
  - Mini 站 `H_LARK_AUDIT=0` 且 macOS native 无 bwrap——审计/门禁链在 Mini
    整体不生效（B1 已知边界，hook 脚本已预埋 shared/hooks/）。

- **P2a 身份硬约束**（契约 `2026-08-03.5`，机制项 `user_identity_strict_mode`）：
  两层钉死「飞书操作必须用户本人身份」——
  ①配置层：`ensureLarkStrictMode`（lib/sandbox.mjs）对全租户 lark-cli 执行
  `config strict-mode user --global`（CLI 原生身份策略，实测 strict 下
  auth scopes/status 探测与默认读全部正常、`--as bot` 干净拒绝）；每次 app 启动
  读 config 自愈漂移，判断只读、**写必须走 CLI**。重启后 9 租户全部落位。
  ②执行层：wrapper 拦「显式 `--as bot`」与「`config strict-mode/default-as` 修改」
  （查看/--help 放行），审计行带 `(blocked:identity-bot|policy-config)` 标记；
  `--as` 的**值**进 `as=` 字段（白名单 user/bot/auto/other）。
  ⚠️ 翻案记录：此前「784 条调用 0 条 --as bot」**方法学不成立**——wrapper 只记
  flag 名不记值，该日志数不出任何 as 值结论；risk 真实存在（租户 config 里有
  appSecret，defaultAs=auto，bot 身份沙箱内真实可用）。
- **P2c 读全量护栏**（H-0070，机制项 `read_coverage_guardrail`，三层）：
  ①wrapper 对业务域命令经临时文件转发 stdout，从尾部抽分页事实（markdown 尾行
  `Meta: count=N; has_more=…` 为 lark-cli 1.0.71 自带；JSON 抽 `"has_more"/"total"`），
  补 `meta=has_more:…,count:…,total:…` 审计行（与 cmd 行同 pid，消费端按 pid 合并）；
  has_more=true 时**当场**给 agent 一条 stderr 提示（stderr 不破坏 --format json）。
  ②Stop hook 第三判定：最后一条**列表族**读（`-list`/裸 `list`）停在 has_more=true
  → block，出口只有两条行为路（翻页读全 / 明写「仅基于前 N 条」）；search 命中
  即停不拦。③事实行披露「⚠️ 有列表读取未读到末尾…」+「🚫 拦截 N 次身份越权调用」。
  不捕获集合：auth/config/doctor/profile/update/help/schema/skills/**event**（长轮询
  缓冲会改变行为）；mktemp 失败直接 exec（fail-open）。
  - 🔴 **已知盲区（2026-08-03 双 bot 同题实测暴露）**：护栏只认「最后一次列表读
    has_more=false」，防不住**范围本身错误**——①offset 翻过头的空页（count=0）
    has_more 照样 false，「一串假 false」看起来像读全了；②读错视图/丢 URL 的
    `&view=` 参数/中途从视图漂到全表，每一步 has_more 都可以是 true→false 的
    「完整」序列。真机形态：产品专家 bot 分页翻车后换 JSON 姿势重拉，读到全表
    ~27% 碎片就自信收尾（报「主责 79 条逾期 2 条」，视图口径 32/0、全表口径
    297/14，**哪个口径都对不上**，还错误声称「按视图全量读取」）；同题测试 bot
    读全了全表（297/逾期14/将到期10 与独立仲裁逐编码全对）但无视了 URL 指定的
    view。升级方向（未做，待拍板）：结论必须披露「读取范围（表/视图 id）+累计
    条数」，Stop hook 校验披露在场；view 参数从 prompt URL 机制化透传。
  - **双 agent 同题输出分歧的仲裁法**：别对着两份自述比对（两份都可能错）——
    **自己独立读一次拿基准**（裸 api + `--page-all` 落盘，同口径统计），再逐编码
    对撞。取证顺序：trace 的 prompt 全文（URL 参数是指令的一部分）→ lark-audit
    调用序列（谁翻了几页、rc/meta）→ grok session 的 tool_result（有限：shell
    循环落临时文件统计时页面原文不进历史）→ 独立仲裁读数定案。usage input
    tokens 量级差（766K vs 1036K）是「读取完成度不同」的第一嗅探信号。
  - **范围三件套（契约 2026-08-03.8，双站已上线）**：①`lib/task-hints.mjs`
    `url-scope` hint——消息里飞书资源链接带 table/view/sheet 参数即把**参数原值**
    连同读取纪律注入任务尾部（注入点 runner-adapter，**直连 runGrok 的探针会
    绕过它**=假阴，验收必须穿 adapter）；②wrapper 对 `--table-id/--view-id` 的
    **值**入审计（`res=table:tblX,view:vewY` 字段，纯字母数字白名单）；③Stop hook
    判定⑤——≥3 次带 res= 的读 + 数量结论 + 回复无范围披露词（视图/全表/vew/tbl）
    → block 要求补披露。真机验收（测试 bot、川哥原话）：回复出现完整「读取范围」
    区块（表/视图 id + 累计条数 + has_more 状态 + 扩范围先请示），三判据 PASS。
  - 🔴 ~~「bot 条数≠用户 UI」先查 token 视角（高级权限按 App 过滤）~~
    **勘误（2026-08-03 深夜，三连判别实验推翻）**：token 权限不是原因——产品
    专家 token 裸 api 读同视图 **515 条与 owner 完全一致**。真正的机制：
    **飞书 bitable 两条读取路径语义不同**：
    ① 裸 api `GET /records?view_id=`：只按视图**排序**返回**全表投影**，
    **不应用视图筛选**（515 条假「视图数据」）；
    ② lark-cli 封装 `+record-list --view-id`：真视图内容
    （`record_scope=view_filtered_records`，120 条=UI 真值）。
    且视图 `filter_info` 会**省略部分条件**（`condition_omitted` 字段暗示；
    按 API 返回的两条件本地复算=514≠120），**封装命令的读数才贴 UI**。
    判据：拿封装命令的 record_id 集在裸 api 序里查位置分布——散布全范围=
    条件子集（视图真值），连续前段=截断。两轮「bot 读少了」（10 vs 121、
    120 vs 515）实测 bot 全对，假的是我裸 api 的「仲裁基准」。
  - 🔴 **A 读数 ≠ B 读数时，变量一次只切一个**（同晚三连归因错误的元教训）：
    嫌疑变量有四个——身份(token)/工具(封装vs裸api)/参数(filter/view)/时点。
    我先按「token 视角」下结论（没切工具变量）、再按「封装应用 filter」下
    结论（没验 filter 完整性），都错。正确顺序：同工具切身份 → 同身份切工具
    → 位置分布定子集/截断。每次只动一个变量，其余钉死。
- **P2b scope 对账+自助重授权**（机制项 `scope_reauth_self_serve`）：
  - 权限对账卡带「🔁 重新授权」回调按钮（`cmd:lark_reauth`）→ `startLarkReauthChain`
    分批设备流：**飞书设备流 scope 数上限实测 250 过/350 拒，取 200/批**；每批
    onComplete 自动发下一批卡，末批完成后 bust 探测缓存→重探→回发最新对账卡。
    只请求 `grantableByReauth`（**飞书授权按 user×app 累积**，实测 owner 164→500、
    rayman 171→513、测试 bot 148→241，老权限不丢）；禁止域不在 required 里，
    链式补权与越权域清理**正交**，不用互等。
  - 批量推送：`ops/push-scope-card.mjs`（仓根 `set -a && . ./.env` 后跑，凭据走
    bridge AES store——⚠️ **`.lark-cli/config.json` 的 appSecret 是 lark-cli 自己的
    加密 dict**，直拿换 token 必得 10003）。卡片不过期，授权流点按钮才现开，
    天然满足铁律 19。已推：rayman/测试 bot（已完成）+ 王宣凯(375 项/2 批)、
    南鸽(422 项/3 批)（待点）。
  - 排障时同名卡片会混淆归属：owner 对话框里的验卡测试卡与推送卡同款样式，
    用户报「发错 bot」时先发**定位标记文本**分辨，别急着查发送链路。

### 执行保真层（契约 `2026-08-03.7`，晚间第二轮；勿与上午 P0a/P0b 撞名）

触发现场：刘子贤 bot「8 条已批量更新为进行中」实际 2 次 record-list 零写入；
产品专家 bot okr 全 rc=3 权限失败仍编出 cycle_id。深挖出**第五层能力差距**
（权限/知识/规则/记忆之上）：执行保真 = 模型档位 + 机制门禁。

- **grok 模型体系真值（先记这个，排「租户效果差」第一嫌疑）**：
  - 用户问「你什么模型」答「我是 Grok 4」＝**正常自述非故障**（grok-4.5 的自我
    认知无小版本号）；判模型真值只认 trace `task_begin.model/providerModel`。
  - owner：**订阅 session 通道**（cli-chat-proxy），池={grok-4.5}，191 次全 4.5。
  - 租户：**API key 通道**（api.x.ai），池含 grok-4.5/4.3/4.20 系/imagine/build。
  - 事故：scaffold 模板写死 `grok-code-fast-1`（已下架）→ CLI **静默 fallback
    池子第一个** = `grok-4.20-0309-non-reasoning`（非推理档），四租户 6/22/29/70
    次实测全中，trace model 恒 null 零观测（[[feedback_pinned_default_rots_without_pool_check]]）。
  - 修复：`DEFAULT_GROK_MODEL`（env `H_GROK_MODEL_DEFAULT`，现 grok-4.5）+
    `ensureGrokModelPin`（sandbox.mjs，App 装配即自愈：写前查 models_cache 池，
    desired 不在池回退默认、默认也不在池**保持现状+告警绝不硬写**；幂等短路）。
    部署重启当场 9/9 grok 租户全量钉回 4.5（journal `grok model pinned`）。
    ~~trace task_begin 的 model/providerModel 记钉定值~~ ⚠️ **勘误（2026-08-03
    深夜）：钉定值是纸面账**——pin 写的 config default **只对新会话生效，resume
    旧 session 沿用会话创建时的模型**（grok session 持久化模型状态）。真机铁证：
    12:08 任务 trace 记 4.5、unified.jsonl 真实调用 grok-4.20-non-reasoning；
    8/10 租户在 4.20 上跑了大半天而观测全绿。**「配置已下发」永远证不了
    「运行时在用」，长生命周期载体（session/连接/进程）会把旧配置钉住。**
  - **模型锁定二件套（cb36829，双站已上线）**：①grok-runner 每任务显式
    `-m <钉定值>`（kimi 铁律 11 横搬——当时只立给 kimi 没横向到 grok；`-m` 是
    CLI 解析链第一优先级，**resume 也被覆盖**，真机反向实验 4.5 会话→4.3 实证；
    钉定值 spawn 前现读 config.toml，fail-open）②trace 的 `usage.actualModel`
    记**真实调用**（unified.jsonl 的 `model changed` 事件 ctx.model——CLI 每次
    进程启动都打含 resume，与配置意图分开记账）。存量旧会话下次任务自动矫正，
    无需轮换 session。
  - **验「租户真实在用什么模型」只认两处**：`unified.jsonl` 的 `model changed`
    事件（引擎侧真值）/ trace `task_end.usage.actualModel`（平台侧采集）。全租户
    扫描：遍历 `/srv/h-platform/users/*/.grok/logs/unified.jsonl` 取各自最后一条
    model changed。**bot 自述（「我是 Grok 4」）与 trace 的 model 字段（配置意图）
    都不是证据。** owner 能答「Grok 4.5」是订阅通道品牌展示，非自我认知。
  - **「什么模型」网关代答（契约 2026-08-03.9，双站已上线，川哥拍板）**：
    `command-probe.mjs` model 档（精确命令词 + ≤20 字含「模型」+问句特征；带
    训练/部署/生成等任务动词放行）→ `handleModelCommand`（bridge.mjs）拿真值
    出「🔎 引擎与模型」卡，不过 LLM：**配置模型（config.toml 钉定值）与最近
    实际调用（unified.jsonl 尾部 512KB 的 model changed）并示**，两值不一致时
    卡片自带 ⚠️ 提示——用户随口一问就是一次配置↔运行时对账，排障入口下沉到
    对话框。kimi 显示 kimi-code/k3（import kimi-model.mjs 单一真源）；omp 引导
    后台。owner 同答（共享行为铁律）。时间显示转北京时间（裸切 ISO 差 8 小时
    老坑）。测试 test/command-probe.test.mjs 19 条锁互抢边界。
  - **用户自选链**：租户后台「对话引擎」区模型下拉（xai 分支，html.mjs）→
    `POST /api/model`（形状+池双校验）→ store.grokModel → `/internal/users` →
    执行面 mergeControlUsers → ctx.grokModel → pin desired。可选列表 = bridge
    context-report 上报的 `grokModels`（读 models_cache，过滤 imagine/build，
    **CLI 每任务自刷新——grok-4.6 上线自动可选，平台零维护**）。列表未上报时
    页面显示占位文案；控制面 v1.39.0。
  - ⚠️ **下拉「没显示」先查时序再查代码**（2026-08-03 实录）：grokModels 随
    context-report 上报（任务收尾 +90s debounce），bridge 重启后要等该用户下一次
    任务才首次落库（server.mjs 收到后拆进 **user store** 的 `grokModelsAvailable`
    等字段，**不进** context.json——查数据别查错文件）。html.mjs 里变量名是
    `extras.grokModel`（单数），grep `grokModels` 零命中不等于没实现。
  - **grok-build 源码实证（2026-08-03 clone 通读，SOURCE_REV≠线上二进制仍适用）**：
    模型解析在 `xai-grok-shell/src/agent/models/resolution.rs::resolve_default_model`，
    优先级 **CLI `--model` > env `GROK_DEFAULT_MODEL` > config.toml `[models] default`
    > remote settings > 内嵌 default_models.json（开源版 baked=grok-4.5）**。
    preferred 不在可见 catalog = `tracing::warn` + **静默 fallback `visible.first()`
    （池第一个）**——「死模型静默降级」的机制本源，源码坐实；平台 pin 前查池的设计
    因此是必要的，不是防御性冗余。models_cache.json **TTL 300 秒**（非「每任务」），
    CLI 版本号/origin 不匹配即 cache miss 强制重拉；外部写该文件会被 config-watcher
    热加载。`GROK_DEFAULT_MODEL` env 档位高于 config.toml，是比改模板更强的备用钉法。
- **Stop hook 判定④**（写声明对账）：回复声称写入/修改 + 本轮审计**只读零写**
  → block。判定②只拦零调用——「2 次读+编造写入」正落在矩阵空格
  （[[feedback_gate_matrix_gaps_attract_behavior]]）。本地产物句
  （FEISHU_TASKLOG/.md/本地）按句剔除防误伤；CLAIM 正则补 `(?:批量|全部)?`
  前缀（「已批量更新」两档原先都漏，delivery-claim-gate 同步）。
- **rc 入审计**：wrapper 业务域命令补 `rc=<n>` 第三种行（管理类 exec 拿不到，
  权限失败恰好都在业务域）；lark-audit/Stop hook 按 pid 合并；事实行披露
  「其中 M 次调用失败（非零退出）」——**「调了」≠「调成了」，只数次数的披露
  给编造背书**。
- 验收读数：契约 .7 双站唯一；wrapper/hook md5 对撞；pin 真机 9/9 + 幂等复验
  changed:false + mcp 托管块无损；rc 行真机 cmd+rc 同 pid（host 手跑得 127 是
  ssh 非交互 PATH 无 node 的老坑=铁律 9，非 wrapper 缺陷）。
- 判「必撞墙」的正确判据是 **token 池里没有该 scope**，不是「应用侧缺口域计数
  非零」——应用侧 okr 全缺但 token 攥着旧授权照样能调（token=授权快照，双向
  都成立）；「后台开了≠能用」的反面是「后台没配≠不能用」。

## 🔴 多站点恢复收口（v1.39.1，2026-08-04 双站+控制面上线，commit f329560）

dev198 与 Mini 的 orphan 报告此前**互相覆盖**（谁后上报谁赢），管理台总数在
6 和 1 之间跳；操作也会跨站误领。现按执行站点分桶。

**站点真值只认控制面收到的 `site`**：`H_EXECUTION_SITE` → `createControlClient({site})`
→ 三个 `/internal/orphan-*` 全带 site；控制面 `sanitizeOrphan(item, site)` 用参数
**覆写** `item.site`——报告正文里的站点字段不可信（执行面可能被篡改或写错）。
旧 `state.report` 读时迁成 `reports.legacy`，首个显式站点上报后 `delete reports.legacy`。
同一 `orphanId` 在两站同时出现时 `enqueue` **fail closed 不建操作**。

### 处置 orphan 的三条硬约束

1. **入队只有管理员 cookie 一条路**。38 个 `/internal` 路由（全量枚举过）**没有**
   orphan 入队口，`POST /admin/api/orphan` 在 `isAdmin` 守卫内。cc **不铸造管理员
   会话**——那等于以川哥身份认证。要么川哥在管理台点，要么授权 cc 从旁进程调
   store API（见下）。
2. **store 没有跨进程锁**。`withFileMutationQueue` 是**进程内 Map**，
   `atomicWriteJson` 只保证不撕裂**不保证互斥**；而 h-control 每 ~15s 写一次报告。
   旁进程读-改-写会静默丢更新，**且可能丢的是我这条**（我报"已入队"、磁盘上没有）。
   所以：走 `import` 调 `enqueue()`（保留全部校验与副作用，别手改 JSON）+ **回读
   磁盘复验**，用磁盘态而非返回值下结论（[[feedback_inprocess_lock_is_not_crossprocess_lock]]）。
3. **probe / cancel 无对外副作用**（`resolve()` 只做 followUpQueue.cancel +
   runnerRpc.resolve + taskSessionLog 审计，**不发飞书**）；**rerun 会真跑任务并把
   结果推到用户 chat**。所以**他人 Bot 的恢复项一律不代决**——重跑等于替同事往他
   飞书发消息。2026-08-04 王宣凯那两条就是这么留着没动的。

### ⚠️ `probe` 的 `deliveryPending` 对 rpc 型 orphan 恒真

判据是 `outbox.pending 含该 taskId` **或** `runnerRpc.orphans() 含该 requestId/taskId`。
kind=rpc 的 orphan **按定义就在第二个集合里** → 永远 true，在最需要判别的场景
没有判别力（Mini 那条返回 false 只因它是 kind=compute、不在 rpc 列表）。
**判「真有没有卡住的投递」看 healthz 的 `deliveryOutbox.pending`**，别信这个字段。

### 部署顺序与脚本差异

执行面**先**发（向后兼容：旧控制面忽略新增 `site` 字段），双站都到位后**再**发控制面；
反过来会让 `legacy` 过渡态长期存在。控制面部署结构是 `/srv/h-control/app/{server.mjs,lib/**}`，
不是仓库里的 `control-plane/**` 路径。

⚠️ `ops/deploy-sites.sh` 的 **dev198 段重启是 `restart bridge runner-worker`（bridge 在前）**，
而规程要求 **runner-worker 先**。要按规程顺序就 `SKIP_RESTART=1 ops/deploy-sites.sh dev198`
拿它的 merge+meta 真值机制（防编 hash / 吞 merge 失败 / 漏看 meta 三错），重启自己按序做。
Mini 段本来就是 runner→bridge，可整段跑。

## 人格编辑边界与 orphan 终态（v1.39.2，2026-08-04 三处上线，commit 2467869）

### 「保存后被恢复」的验收要钉两头

`profileContentForUi` 现在剥掉**全部**托管块（含 `h-profile-index`）。验收判据必须
同时成立，只验一头会从「用户改动被吃」翻车成「托管块被用户抹掉」：

- 编辑面：`/<!--\s*h-[a-z-]+:(start|begin)\s*-->/` **零命中**
- 真实文件：**仍含** `h-profile-index`（`writeProfile` 落盘后 `ensureProfileIndexes`
  重建，该链路本轮未改动）

往返必须走**真实写入路径**（`writeProfile` → 重读 → 还原），内存模拟只能证明剥离
语义、证明不了写入链。⚠️ **往返测试只在川哥自己的租户账号上做**，绝不拿别人的
`SOUL.md` 当试验田；查他人文件时探针只输出布尔/长度/哈希，不打印正文。

### orphan 终态：验收看下一轮，不看回执

纯 compute 恢复项没有 replay/RPC 胶囊，原 taskId 只在 coordinator 的 `identity` 里。
修复前 `resolve()` 取不到就跳过写终态，于是**取消返回 ok=True、审计记
ORPHAN_CANCELLED，它下一轮照样回来**。所以这类问题的判据是「再等两个恢复上报周期
还在不在」，**回执和审计都不算数**。审计里同一 orphanId 被成功取消过多次 = 这个 bug
的指纹，别当用户手滑（[[feedback_identifier_fallback_chain_misses_a_variant]]）。

### 给租户发主动通知的范式

抄 `ops/push-scope-card.mjs`：`loadUserRegistry` 拿 uid→appId、`loadAllCredentials`
解密拿 appSecret/openId（需先 `set -a; . ./.env; set +a`）、换 tenant_access_token、
打 `im/v1/messages?receive_id_type=open_id`，卡片用 `schema:'2.0'`。
⚠️ 别打 `.lark-cli/config.json` 的主意（appSecret 是加密结构，直接用必得 10003）。

⚠️ **这样发的消息不走 bridge 送达链**，所以该 App 的 `lastOutboundOkAt` 不会更新。
证据是 `message_id` + 飞书 API 回执，**别拿 healthz 的出站计数当送达证明**，也别因为
它是 null 就判定没发出去。发前先 `--dry-run` 打印卡片全文留档。
2026-08-05 复验：发送时刻 06:54:29Z，事后 healthz 的 `lastOutboundOkAt` 仍是 06:08:27Z
——**回报时必须写清「这条不在平台的送达记账里」**，只贴 message_id 会让人以为它走了
正规链路（[[feedback_bypassing_app_write_path]] 的发送路径变体）。

三条实操补充（2026-08-05）：

- 加载 `.env` 用 `node --env-file=.env script.mjs`（Node ≥20.6），比 `set -a; . ./.env`
  干净，也不会把 secret 灌进 shell 历史与子进程。dev198 非交互 ssh 记得先
  `export PATH=/home/chuan/.local/node/bin:$PATH`。
- **发前做收件人双源对撞**：控制面 `data/users.json` 的 `openId` 与执行面凭据库的
  `cred.openId` 必须同一个，不一致就拒发。发错人不可撤销，值得为它单独立一道闸。
  脚本先 `--dry-run` 只打印前缀（`ou_xxxxx…` + 长度），确认后再 `--send`。
- **发完回读一次** `GET im/v1/messages/<message_id>`：确认存在、`deleted=false`、
  `sender.id` == 该 Bot appId、正文一字不差。发送 API 的 `code=0` 只是受理回执
  （[[feedback_hollow_200_needs_payload_check]]）。写探针时别在输出里塞写死的
  `xxx = true`——那不是校验结果，是我自己编的字面量。

## Base Intake 验收门与上下文运行真值（v1.39.3，2026-08-04 三处上线，commit 6fb65da）

### 上下文运行真值的判据

旧实现用**执行站宿主机 HOME** 拼引擎路径当租户上下文上报，管理台因此显示
`/home/chuan`、`/Users/<管理员>`——那些路径在 bwrap 租户沙箱里**物理不可达**。
现在按运行环境登记，验收认这三个值（`lib/sandbox.mjs` 常量真值，别手写）：

| 运行环境 | 应显示 |
|---|---|
| bwrap · grok | `/opt/grok/grok` |
| bwrap · kimi | `/opt/kimi/kimi` |
| bwrap · omp | `/opt/bun/bin/omp` |
| Mini native | `站点共享 H 引擎（native）` |

控制面 `runtimeEntry()` 对 `bin`/`entry` 双侧兜底：命中
`^/(home|Users|srv|root|private|tmp)/` 或 `^/var/folders/` 一律置 null，`/opt/…` 放行。
**验收扫全部 `data/memory-manage/*.context.json`**，不是只看一个用户。

### 验收门拦的四类（`lib/base-intake-policy.mjs`）

门在**成功卡送达之前**（`runProactiveTask` 里 `validateResult` 抛错 → 不发送 →
worker catch → Base 回填「被阻塞」）。四类判据全部依赖 `larkAudit` 的真实字段
（`writes`/`failed`/`unfinishedListRead`/`tampered`，由 `lib/lark-audit.mjs` 产出，
**不是空门**）：验收码缺失、必需事实缺失（版本/Bot 数/队列深度）、敏感串
（App ID / open_id / uid / 内网 10-8·127-8·192.168-16·172.16-12 / 凭据 / 绝对路径）、
lark-cli 越界（只读任务发生写入、非飞书任务调 lark-cli、失败调用、列表未翻页到底）。

需要平台运行状态的任务由控制面 `/internal/runtime-status` 下发可信真值，
禁止模型自己猜。该端点无 token 应返回 **401 而非 404**——用这个判端点在不在。

⚠️ **扫「模型有没有泄露」只能扫它写入的那两列**（实际结果 / 测试与验收证据）。
主表整行含 `创建人/负责人/验收人` 系统字段，渲染成 `[{"id":"ou_…"}]`，
**扫整行必然命中系统 open_id 而误判成泄露**（2026-08-04 我就这么误报过一次）。

### 真机验收 SOP

1. **先读后改**（铁律 23）：字段用 `+field-list`（返回在 `data.fields`）、
   视图条件用 `+view-get-filter`、视图内容用封装 `+record-list --view-id`。
   完整命令契约见记忆 [[reference_lark_cli_pitfalls]] §8——**别猜 flag 和格式**。
2. **新样本要落进 Worker 认领的视图**：需求看板筛选是
   `类型∈{需求,Bug,优化,运维}` AND `状态∉{已关闭,验收通过,验收通过关闭}`；
   Worker 只认 `状态=已排期`。建记录用 `+record-batch-create --json`
   （列序形式 `{"fields":[…],"rows":[[…]]}`），**先 `--dry-run` 验形状**。
3. **先确认目标 Bot 归属**：`H_BASE_INTAKE_TARGETS` 的 appId 映射到人。
   完成卡会主动发到那个人，别把验收样本的卡发到同事那里。
4. **证据五件套**：Base 状态转 `已修复待验收`、实际结果含验收码、证据含
   `TaskSessionLog task_id=…`、`Feishu message_id=om_…`、`Base Intake 验收门=通过`。

**H-0071 实录（2026-08-04）**：验收码 `H-ACCEPT-B-20260804-5EB7`，
`task_id=base-cvrhkWuzSh1C-3e6683af6f`、`message_id=om_x100b68265063c4a0c07e73059756121`，
五件套齐、Runner 输出敏感串零命中。对照组是同表的 H-0053 / H-0067——
两条历史**验收失败**，失败原因（没查控制面信息、调无关飞书命令、越权写日志、
回复暴露身份标识）正好是这道门的四类判据。

### 待办

- **执行保真层留给真实流量的验证**：①下一个租户任务 trace 出 `model=grok-4.5`
  ~~②context-report 上报后租户后台出现模型下拉~~（✅ 2026-08-03 E2E 验过，
  五选项下拉已渲染）③判定④首次真实拦截（自然发生时从审计+journal 对账）。
- **模型锁定次日复核（2026-08-04）**：7 个昨晚无流量租户首条消息后，扫
  `unified.jsonl` 各自最后一条 `model changed` 应全为 grok-4.5：
  `for f in /srv/h-platform/users/*/.grok/logs/unified.jsonl; do echo "$(echo $f|cut -d/ -f5): $(grep "model changed" $f | tail -1 | grep -o "grok-[a-z0-9.-]*")"; done`
- **L0 lark-base 补两条知识**（2026-08-03 漏读排查沉淀，走 publish-l0-skill/
  skill-content API + fork 对齐流程）：①读任务表优先用表内现成公式/状态字段当
  口径（「应结束未结束/应开始未开始」），禁自己发明「逾期」定义；②读**视图**
  内容必须用封装 `+record-list --view-id`（Meta 的 has_more 可靠），**禁用裸
  api GET+view_id 当视图数据**（那是只排序不筛选的全表投影=假全量）。
  ~~同步考虑 url-scope hint 措辞加限定~~（✅ 2026-08-03 `5d88dd1` 已修并双站上线：
  视图读用封装命令翻页，`--page-all` 限定全表）。
- **orphan `2d51ca81d4f6` 待定处置**（川哥 08-03 01:57 P2 表格批量状态更新）：
  probe 已回 `PROBE_OK`，`deliveryPending=true` 属 rpc 型恒真**不是**真卡投递
  （同刻 dev198 `deliveryOutbox.pending=0`）。cc 建议 **cancel 后由川哥重发**——
  该任务距今约一天、内容是对共享 Base 批量改状态，重跑会按过期口径写生产表格。
  未经川哥点头不动。
- **判定⑤范围披露的口径微调评估**：视图筛选后条数（封装真值）与裸 api total
  不同源，bot 披露「120 条读完」时用户按 UI 口径核对是一致的——现行为已对，
  仅当披露词表误伤时再调。
- **P2b 尾巴**：①王宣凯/南鸽点卡后复扫 `verify-lark-scopes` 出新对账
  ②越权域后台清理复验（川哥已联系持有人）③「应用未配置」户刷新
  `tasks/飞书权限开通.md` 后台批量导入清单（只能人去开发者后台勾）。
- **P3 后续**：租户 HTTP 型 ai-memory hooks 下发 → observations 修复 →
  SCOPE_BLOCK 提示词补丁退役。
- 小项：租户 config.toml 里 ai-memory 的 localhost Bearer 曾在排障终端明文展示
  过一次（2026-08-03，沙箱内 127.0.0.1 面，风险低）——下次动记忆链路时顺手轮转。
- 预期口径（对齐川哥）：施工完=「租户 Bot 在**其主人的飞书权限范围内**，具备与
  owner 同等的执行可靠性和平台能力」；身份差距（用户自己的权限面）by design 不抹。
- 部署在途检查硬化：**在途数与上次基线不同时必须展开明细定位新增项再决策**
  （2026-08-03 只看总数 5>4 未展开就部署，侥幸该任务已终态——流程违规记录在案）。
- 写测试禁用生产 Base；agent 改坏数据恢复第一站=其 session 里的改前读查询
  （[[feedback_agent_session_holds_prewrite_state]]，H-0070 标题 10 分钟恢复实证）。

## 可见能力二阶段（v1.40.0 → v1.40.1，2026-08-04 三处上线，commit 1c7a8f5 / eace771 / bfe24ac）

契约 `2026-08-04.1` → `.2`。控制面 `v1.40.1`，双站 `bfe24ac7c2fe`。

### 🔴 快照白名单必须覆盖「会被 restore 撤回」的文件

`workspace/BEHAVIORAL_RULES.md` 此前**不在** `SNAPSHOT_FILES` 里，而 H-0050 应用正是改它、
成功卡还对用户显示「快照版本 N」、失败走 `restoreSnapshot`。生产实证：真实 apply 产生的
v23 快照 restore 后规则文件原样不动——**「打了快照」和「包里有你要撤回的东西」是两件事**，
缺口在成功路径上全程静默。

⚠️ **加白名单会同时打开一条数据丢失路径**：`swapToVersion` 的语义是「包里没有=当时不存在=删掉」，
而所有**存量**快照里都没有新加的条目，用户点一次「恢复到旧版本」就丢掉自己的文件（恢复有卡片 UI）。
现由 `SNAPSHOT_REL_SINCE` 兜：条目记加入时间，快照时间早于它就只保留不删除，老快照轮换完自然失效。
**往 `SNAPSHOT_FILES`/`SNAPSHOT_DIRS` 加条目必须同时在 `SNAPSHOT_REL_SINCE` 加一行。**
详见 [[feedback_allowlist_addition_opens_deletion_path]]。

测试纪律：`test/tenant-evolve.test.mjs` 里那条「真快照端到端」**禁止改成 mock**。本缺口能活到
生产，就是因为既有四条测试全把 `maybeSnapshot`/`restoreSnapshot` 换成假的，`rolledBack:true`
年年绿而安全网从未被执行过（[[feedback_mocked_dependency_hides_hollow_safety_net]]）。

### H-0050 租户自进化：哪些能自动验、哪些只能人点

- `createEvolveCardAcceptanceRunner` 按设计是 **owner-only 且只允许 `evolve_detail`**
  （`validateRequest` 里硬拒其它 action）。**租户的 建议→详情→接受→应用 链自动化不了**，
  只能由本人在飞书点。cc 能做的是模块层验证 + 隔离假树端到端。
- 自动建议走 ready 门（`score>=3`）；**只有主动发「评估进化」才 force 绕过 ready 与冷却**。
  所以「score=0 也能一路应用」只发生在用户主动要求时，自动路径不会拿套话骚扰人。
- force 命令正则极严：`/^(评估进化|检查进化|要不要进化|进化评估)([\s!！.。]*)$/i`。
  **`评估进化？`（问号，全角半角都算）、`帮我评估进化`、`评估一下进化` 全不匹配**，
  会静默当普通任务跑且无任何「没听懂」反馈。排查「用户说他触发了但没弹卡」先看这个。
- 判断某次建议是 force 还是自动：**看入站到 `evolve advisor notified` 的间隔**。
  force 是同步立刻发；自动路径要等任务跑完（实测 64–76 秒）。
- 全租户化后**同事任务完成、score≥3 就会自动收到进化卡**（2026-08-04 王宣凯即如此）。
  要控铺开节奏只能提高 ready 门槛或加租户白名单——**别用 `EVOLVE_ADVISOR_ENABLE=0`**，
  它在 `maybeProactiveEvolveAdvise` 第一行，会把「评估进化」主动命令一起关掉。
- 覆盖 `state.pending` 会让旧卡按钮永久失效（decisionId 不匹配=已过期），旧提案文件却停在
  `pending`。现由 `supersedeTenantProposal` 标终态并在新卡上告知。

### 架构漂移门：造可回滚测试漂移的正确手法

- 生产控制面 `fullRepo=false`（`repoRoot` 下没有 bridge.mjs/.git），**只检查 `control-plane/*`
  文件**，其余跳过并给一条 by-design 的 info。健康态生产应为 `drift=healthy`，
  只有 `code:execution-source-unavailable` + `service:memory-observability-gap` 两条 info。
- ⚠️ **别靠移走已登记文件来造漂移**：`codeWatch` 里所有 `control-plane/*` 条目都是 server.mjs
  真 import 的，运行中的进程无感（模块已在内存），但**下次重启就起不来**。
- 正确手法：往副本 server.mjs 追加**一行注释**伪造未登记路由——`extractRoutes` 是逐行正则
  不是解析器，会扫到；Node 不执行注释，跨重启存活。路径要落在 `ROUTE_PREFIXES` 内
  （如 `/internal/skill-drift-probe`）才算 critical surface。
- 验收平台请用**生产机隔离实例**：`cp -a /srv/h-control/app /tmp/h-iso/app` + 独立
  `DATA_DIR`/`PORT`/一次性 `ADMIN_PASSWORD`。`SERVICE_TOKEN` 有 **≥32 字符**硬门，短了直接
  `exit 2`。跑的是逐字节相同的部署代码，生产数据与进程零影响。
- ⚠️ 停隔离实例**别用 `pkill -f`/`pgrep -f` 加进程特征串**——ssh 远端命令行本身含该串，
  会连自己的会话一起杀（exit 255）。用 `ss -ltnp` 按端口反查 PID。

### 架构历史 revision 噪声（已知，未修）

`revision = digest(完整快照)` 含站点 CPU/内存/上报时间，而**入历史的只是脱敏摘要**。
实测 9 对相邻历史条目里 **6 对内容逐字节相同、只有 revision 变了**，40 条环形缓冲约
**9.8 分钟**写满。验收门「revision 不变时历史不增长」字面成立，但「历史 / 与上一版本对比」
实际只覆盖最近几分钟。告警审计（maxAudit=120）独立于历史，不受影响。

### H-0069 新建记忆：接口真值

- 客户端**不能**指定路径；服务端生成 `grok/manual/YYYY-MM-DD/<随机8位>.md`，
  入队回执里带 `path` 字段。正文是 `# ${title}\n\n${content}\n`，落盘后 ai-memory 会
  再加 YAML frontmatter（`---\ntier: semantic\n---`）——**回读断言别写 `startsWith('# 标题')`**。
- ⚠️ `GET /api/memory` 的返回体是 `{ok, mirror:{uid,totals,pages[],vectors,...}, ops:{pending,done}}`。
  **不是** `{pages}` 也不是 `{memory:{pages}}`——猜错会把「解析不到」读成「一条都没有」
  （2026-08-04 我据此误报「4 分钟未回读」，实际执行面 40 秒就 `memory op ok` 了）。
- `GET /internal/app-placement` **必须带 `?appId=`**，不带返回 `{"ok":false,"error":"appId required"}`；
  owner Bot 查它会返回 `unknown app`，这是 by design（owner 不是租户、不进 placement store），
  不是「没有租约」。解析前先断言 `ok===true`（[[feedback_tool_contract_guess_chain]]）。
- 用户后台会话：`POST /internal/magic-link {uid}`（SERVICE_TOKEN 门）拿 URL，
  `curl -c jar -L` 换 cookie。`store.upsert` 对 `undefined` 字段 `continue`，不会覆盖既有档案。

## 上下文报告按引擎判定（v1.40.1+，2026-08-04 收口，commit 04b6942）

管理台「用户上下文」此前用**同一份 marker 全集**量所有引擎，于是 Grok 用户被报
缺 `h-soul/h-global/h-mem/h-rules/h-feishu-docs`（那是 kimi/omp 的块），假故障。
现改成按引擎投影：`splitManaged(text, expectedBlocks)` 只保留当前 harness 要求的
块名，额外检测到的进 `unexpectedBlocks`（展示但不判故障）。

### 各引擎 expectedBlocks 真值（改判据前先对这张表）

| 引擎 | 托管文件 | 必备块 | 数量 |
|---|---|---|---|
| grok | `.grok/AGENTS.md` | `ai-memory` `h-mem-scope` `h-identity` `h-method` + `h-profile-index` | **5** |
| kimi / omp | `workspace/AGENTS.md` | `h-soul` `h-global` `h-rules` `h-method` `h-mem` `h-feishu-docs` + `h-profile-index` | **7** |

代码是 `[...harnessFor(engine).blocks, 'h-profile-index']`。**`h-profile-index` 要单独
追加**，因为它不在任何 harness 的 blocks 里，而是 `ensureProfileIndexes` 写进
**`PROFILE_PATHS` 全部四个文件**（SOUL.md / .grok/AGENTS.md / workspace/AGENTS.md /
BEHAVIORAL_RULES.md）。⚠️ 追加前必须确认这一点——**若某引擎的托管文件里没有它，
这一行就会凭空造出一个假缺失**。它的 marker 是 `:start` 版式，与 kimi/omp 其余块的
`:begin` 不同，别按引擎版式去推。

四源（SOUL / 全局约定 / 工作区约定 / 积累规则）改为单列展示存在性+字符数+真实通道：
grok 标 `--rules 四源配置`，kimi 标 `workspace/AGENTS.md 运行镜像`，omp 标
`--append-system-prompt + workspace 运行镜像`。**`chars=0` 是「文件在但用户没填」，
不是故障**——页面要写明，否则管理员照样误读。

### 🔴 改这块必做的负向验证

「只检查当前引擎要求的块」和「把所有缺失都藏起来」在全绿时**输出完全一样**。
所以必须构造缺块树反证：三引擎各抠掉一个必备块，断言仍**精确**报出那一个且不牵连。
一次性脚本思路：造假树 → `buildContextReport(uid,{engine})` → 读
`conversationHead.agentsGlobal/agentsWorkspace.blocks`。跑在 dev198 **已部署字节**上
最有说服力（平台目前无 omp 租户，这是唯一能验 omp 分支的办法）。

### 上下文报告的存储与触发真值（排障前先读，别猜）

- **落盘**：`/srv/h-control/data/memory-manage/<uid>.context.json`（每 uid 一个文件）。
  **不在 `users.json` 里**——去那儿找会得到「带 context 的用户数: 0」这种
  合理但错误的结论。
- **时间字段是 `generatedAt`**（UTC），不是 `collectedAt`/`at`。
- **触发三条**：任务结束后 90s 去抖（`scheduleMemorySync`）/ memory-capture 后 2s /
  每 30 分钟全量 sweep（`MEMORY_SYNC_INTERVAL_MS`）。全部经 `runMemorySync` → `pushContext`。
- **怎么区分「真实任务触发」还是「定时 sweep」**：sweep 会在同一秒批量推一堆；
  真实任务是**单条**，且 `inbound 时间 + 90s ≈ push 时间`。验收要求「真实 Runner 触发」
  时必须按这个判，否则拿 sweep 冒充。
- **owner Bot `sandbox=null` 不产报告**：dev198 12 个 App 只会推 11 份，
  11+Mini 1 = 12 份落盘。数量对不上先想这个，别当故障。

### 控制面部署没有脚本，手工四步（`ops/deploy-sites.sh` 只管 dev198/Mini）

```bash
# 0) 先验仓库↔线上同源——线上若有仓库外改动，这一拷就是覆盖生产
git show <基线>:control-plane/server.mjs | shasum -a 256      # 对撞线上 sha256sum
# 1) scp 到 /tmp（不能直写 /srv，需 sudo）  2) sudo cp 落位并回读 sha 对撞
# 3) node --check 跑【线上实际文件】       4) sudo systemctl restart h-control
```

映射：`control-plane/server.mjs` → `/srv/h-control/app/server.mjs`；
`control-plane/lib/html.mjs` → `/srv/h-control/app/lib/html.mjs`。
⚠️ Mini 同步清单是 `bridge.mjs lib ops scripts test package.json`，**不含
control-plane/** —— 控制面改动到不了 Mini，这是 by design 不是漏传。

验页面别只看 HTTP 200（空壳 200 骗过三层）。用**线上实际字节**渲染再断言载荷：
`cd /srv/h-control/app && node -e "import('./lib/html.mjs').then(m => …)"`，
检查新标记在不在 + 所有 `<script>` 块 `new Function()` 可解析。

#### 补两步（2026-08-05 `95d948b` 实操，比上面四步稳）

- **备份放 `/srv/h-control-backups/app-<ts>`，别放 `/srv/h-control/app.bak-*`。** 后者与
  部署根同级、容易被当现役对撞（skill 前文已记「同目录堆着几十个备份」）。落完立刻
  `md5sum` 三个关键文件与**部署前线上**逐一对撞，不一致就别往下走。
- **重启前先在生产机上起一个隔离实例验新代码能跑**：临时 DATA_DIR + 合成 users.json +
  随机端口，`cd /srv/h-control/app && node server.mjs`，打一次目标接口。10 秒成本，换掉
  「重启进崩溃循环」的风险；顺带用**生产的 node 版本**验一遍（Air v22.14 / hk v22.22）。
  合成数据即可，**别把生产 users.json 拷进 /tmp**。
- 文件级同步用 `sudo rsync -rlpt --chown=h-control:h-control`，**不加 `--delete`**；加之前
  先用 `LC_ALL=C sort` 两端对清单确认线上无独有文件（locale 不一致会让 `comm` 给出
  同一文件同时出现在两侧的自相矛盾结果）。
- `node --check` 要跑**全部**线上 `.mjs` 且结论由累计变量驱动，并配一个坏语法负向锚证明
  它真会拦——这台机 PATH 里有 node，但 dev198 没有（前文铁律 9）。

#### 🔴 控制面测试大多是「源码文本断言」，别把它的绿数字当验收证据

`control-plane/test/*.test.mjs` 里相当一部分是 `readFile(server.mjs)` 后跑正则，例如
`assert.match(endpoint, /slice\(0, 20\)/)` 挂着「接口限制最多 20 项」的名字。
**这类断言在接口 100% HTTP 500 时照样全绿。** 2026-08-05 `/api/model-state` 因跨块引用
`cap`（`/internal/context-report` 块内的局部 const）恒 500，而 179/179 全绿——**没有任何
一条调用过它**。

- 收到「N/N 通过」先问：**哪一行真的调用了被测对象**（`readFile` 还是 `fetch`/`import`）。
- 新增/改动控制面路由，必须补一条**真起服务、真发请求**的测试。范式见
  `control-plane/test/providers.test.mjs` 末条：临时 DATA_DIR + `lib/session.mjs`
  签 cookie + `spawn(server.mjs)` + fetch，并用 loader 钩子存根 `qrcode`
  （control-plane 唯一外部依赖，只在二维码路由用）——移走整个 `control-plane/node_modules`
  仍须全绿，**不许写成 skip**。
- 模块级小工具（`cap` 这类）放模块作用域，别定义在某个路由处理块里。
  详见 [[feedback_acceptance_numbers_need_causal_link]]、[[feedback_syntax_check_is_not_a_smoke_test]]。

#### 新用户模型下拉自动同步（v1.40.2）

模型目录由 Grok CLI 首次任务时生成 → context report 回传 → `user.grokModelsAvailable`。
先开后台的新用户会停在空列表，故 `GET /api/model-state` 只返回**当前登录 uid** 的
`{engine,current,available(≤20),defaultModel,updatedAt}`；页面占位区 10s×30 轮询，
到达后 DOM 就地换真下拉（不整页刷新，不影响正在编辑的记忆/人格/规则）。
⚠️ 轮询里**接口异常必须与「列表还没到」分开提示**——否则服务端 500 会被渲染成
「首次对话后自动出现」，用户只会一直等（同 [[feedback_hollow_200_needs_payload_check]] 的
反向形态：这次是把失败说成进行中）。
判据一致性：`engine === 'xai'`（`ENGINES=['xai','kimi','zhipu','minimax']`，grok 的注册表
id 是 `xai`），服务端与 `dashboardPage` 都走同一个 `sanitizeEngine`。

### Mini 的用户根不是 `/srv/h-platform/users`

真值 `H_USERS_ROOT=$HOME/local/h-platform-mini-bot/data/users`（在部署目录内）。
拿 dev198 的路径去 Mini 上搜，会得到**假零命中**。判「Mini 上没有 X」必须配
必然非零的锚（如该租户自己的 uid），锚返回 0 说明我搜错地方了
（[[feedback_truncated_output_negative_conclusion]] 2026-08-04 补丁）。

### 需求 Base 两个状态字段的选项池**不同**（写前必读，别互抄）

| 字段 | 选项池 |
|---|---|
| `状态` | 新反馈 / 待确认 / 已排期 / 执行中 / 已修复待验收 / **验收通过** / 已关闭 / 验收失败 / 已重新打开 / 被阻塞 / **验收通过关闭** |
| `验收结论` | 未验收 / **通过** / 失败 / 部分通过 |

⚠️ **「验收通过」只存在于 `状态`**；`验收结论` 的对应值叫「通过」。川哥口头说
「验收结论是验收通过」时，要按字段真实选项池落成「通过」并说明，别硬塞不存在的枚举。
另：`+table-list` 返回的表 ID 键是 **`id`** 不是 `table_id`。

## Mini B2：Lima VM + bwrap 生产线（2026-08-05 已割接；运行时加固 commit `7d441b5`）

把 Mini 租户执行面从 macOS 原生搬进 Linux VM，为的是拿到真 bwrap 沙箱
（macOS 上没有）。当前状态：**AI 专家测试 Bot 已由 VM 接管，原生 launchd 已停用；owner 仍在 dev198**。

> ⚠️ **运行态与仓不同源（2026-08-05 10:3x 实测）**：VM 的 `.deploy-meta.json` 是
> **`3ba27a555478`**，而分支已到 `7d441b5` —— 割接后的两条 VM 根因是**现场改好 VM、
> 再补提交**，没有再次重新部署。所以 `7d441b5` 的修复**在仓里，也已生效在这台 VM 上，
> 但没有走过一次完整的"从该提交部署"的路径**。下次重装/新建 VM 才是它的首次真跑。
> 判「现在跑的是什么」认 VM 的 deploy meta，不认分支 HEAD（[[feedback_deployed_code_is_the_source_of_truth]]）。
> 实测口径：`limactl shell h-b2 -- cat /opt/h-platform/app/.deploy-meta.json`。

### 两条路径的真值表（判"现在谁在服务"先看这个）

| | 原生（回滚保留） | B2 VM（当前生产） |
|---|---|---|
| 位置 | `~/local/h-platform-mini-bot` | Lima 实例 `h-b2`，app 在 `/opt/h-platform/app` |
| 状态根 | `<部署根>/data/users` | `/srv/h-platform/{users,memory,workspace,config,shared,orgs}` |
| 进程 | launchd 已 disable/unloaded | systemd --user `h-mini-b2-{bridge,runner}.service` active |
| 健康 | 不持有 18775 | health 转发到 VM `127.0.0.1:18775` |
| node | `~/.hermes/node/bin/node` | VM 内 v22.22.1 |

**判进程在不在 VM 里，看命令行路径**：`/Users/...` = macOS 原生，`/opt/h-platform/app` = VM。
`limactl` 真值 `/opt/homebrew/bin/limactl`（非交互 ssh 的 PATH 里没有，写全路径）。

### 割接前影子态 = 三个同时成立，缺一就不是影子

```
h-mini-b2-bridge.service   enabled 但 inactive
h-mini-b2-runner.service   enabled 但 inactive
/srv/h-platform/config/mini-b2-enabled   不存在   ← 割接 marker
```

割接唯一入口 `cutover-mini-b2.sh --confirm-cutover`。**没跑它 = 没割接**，
原生 launchd 两个进程还在、18775 还是原生 PID 持有，就是铁证。
更硬的一条：**部署前后原生 PID 不变**（如 bridge=46926 / runner=46884）＝影子部署没碰原生。

### 影子态验收的两个取数陷阱（都会造假故障 / 假通过）

**① Mini healthz 没有 `queue`/`active` 这两个键。** 猜名字取到的是 `None`，
干净、不报错，看着像「查了，是空的」。真键名（`18775/healthz`，先 `list(d.keys())` 再取）：

| 要验的 | 真实路径 |
|---|---|
| queue | `queueDepthTotal`、`queueStats.totalDepth`、`queueStats.activeGlobal` |
| active | `workConcurrency.active` / `.waiting` |
| Runner pending/children | `runnerWorker.pending` / `.children` / `.remoteChildren` |
| Outbox pending | `deliveryOutbox.pending` / `.retrying` |
| 连接 | 顶层 `connected` + `runnerWorker.connected` |

**② 数 VM 里的进程别用 `pgrep -f <路径>`——会匹配到自己。**
`limactl shell h-b2 -- bash -lc 'pgrep -fc "h-platform/app/bridge.mjs"'` 返回 **1**，
真值是 0（那个 1 是这条 `bash -lc` 自身的命令行）。差点报出「割接前发现双长连接」的假故障。
改用 `ps -eo pid,ppid,etime,args` 交给外部 grep（观察者不在被观察集合里），或方括号
`pgrep -fc "[b]ridge[.]mjs"`；并留一个非零锚（如 ps 总行数）证明通道是活的。
⚠️ **我只因为期望值恰好是 0 才发现**——期望非零时这个 +1 会被静默吸收。
详见 [[feedback_ssh_pkill_pgrep_self_match]]。

### 🔴 影子态验收的固有天花板（写交接文档前必读）

服务 inactive ⇒ **VM 里的 `bridge → runner → 送达` 主链路一次都没执行过**。
所以哪怕 12 条硬验收全绿，正确措辞是「**就绪（未经真实流量）**」，不是「验收通过」。
`verify-mini-b2-grok.mjs` 只证明 grok 二进制 + bwrap + 凭据渲染这一段通
（输出 `{"ok":true,"model":"grok-4.5","replyChars":N}`，只给字符数不给正文）。
详见 [[feedback_shadow_deploy_verification_boundary]]。

**第二个固有属性：影子状态副本会漂移。** `sync-mini-b2-state.sh shadow` 是快照不是镜像，
同步后用户新产生的对话/记忆/规则只进原生。**割接前必须用 `quiesced` 模式重同步**
——该模式强制先停原生 launchd、确认 18775 下线，才做最终同步；直接在原生运行时拷会拿到撕裂状态。
同步是单向（原生 → VM），脚本里无反向路径，所以 VM 里怎么折腾都污染不了生产。

### 部署方式：Air 打包推送，Mini 全程不碰 GitHub

```bash
COMMIT=$(git rev-parse HEAD)
git archive --format=tar.gz --output=/tmp/a.tar.gz "$COMMIT"   # 干净归档，无工作区产物
scp /tmp/a.tar.gz mini-pub:/tmp/h-mini-b2-$COMMIT.tar.gz
# Mini 上解到【提交级】源目录，不覆盖旧证据：~/local/h-mini-b2-source-${COMMIT:0:12}
```

四步顺序固定：`install-mini-b2-shadow.sh`（含 VM 内 `npm ci`，最慢）→
`install-mini-b2-host.sh` → `sync-mini-b2-state.sh shadow` → `verify-mini-b2-shadow.sh`
（出 `shadow=ready …` 即通过）。
`install-mini-b2-shadow.sh` 自带守门：动手前先 curl 原生 healthz，不健康直接 fail；
rsync 排除 `/.env /data/ /memory/ /workspace/`，只读不写原生。
**App 切换本身已下沉到 Guest helper**（`e5a3d65`，见下节），Host 侧只负责打包与投递。

### ✅ 影子重装：build-then-swap，活动 App 不再被就地覆盖（`e5a3d65` 取代 `7d441b5` 形态）

**旧形态（已废，别再按它排障）**：两段 rsync，第二段
`rsync -a --delete "$APP_ROOT.stage/" "$APP_ROOT/"` 就地覆盖活动 App，而 `npm ci`、
`node --check`、env 渲染**全排在它后面**——任一失败，VM 上留下一个装了一半的 App，没有回头路。

**现形态**：Host 只到「解包进 `$APP_ROOT.stage`」为止，随后把控制权交给
`deploy/lima/install-mini-b2-shadow-guest.sh`。**所有构建与校验都在 stage 里做完**——
shadow 闸门 → unit enabled → node/npm 存在 → `npm ci` → 写 deploy meta（`--root $STAGE_ROOT`）
→ 渲染候选 env → 两入口 `node --check` → 候选 env 断言（不含原生根、三个 `H_*` 键齐）——
**第一个破坏动作是 `:83` 的 `mv "$APP_ROOT" "$APP_ROOT.pre-shadow.$$"`**，在这之前活动 App
一个字节没动。切换用两次 `mv`（app、env），任一步失败或事后 `assert …shadow-state.sh ready`
不过，都把备份 `mv` 回来并恢复旧 env。

于是「exclude 挡下的 meta 被 delete 清扫」那个坑**结构性消失**了：meta 是每次在 stage 里
重算的，旧的那份跟着备份目录一起走。源侧 rsync 的 `--exclude '/.deploy-meta.json'` 仍在
（`install-mini-b2-shadow.sh:39`），作用只剩「别把 Host 的 meta 混进包里」。
（rsync 语义本身没变，别忘：[[feedback_rsync_exclude_delete_pitfall]]。）

提交级归档没有 `.git`，调用时必须显式传：

```sh
PROJECT_ROOT=/Users/rayman.chen/local/h-mini-b2-source-<commit> \
H_DEPLOY_COMMIT=<40位提交> \
H_DEPLOY_BRANCH=codex/h-mini-ab-poc \
H_DEPLOY_SOURCE_HOST=<部署主机名> \
  "$PROJECT_ROOT/deploy/lima/install-mini-b2-shadow.sh"
```

缺 commit/branch 会在安装前 fail-fast；安装后必须 `--check` 回读，并与 healthz 的 deploy
对象对撞。**meta 必须由本次代码在 stage 内重新算，人工补写会把「部署机制缺失」伪装成验收通过。**

### 🔑 通用解法：闸门排在破坏之后，先问「能不能让破坏动作可回退」

这是 2026-08-05 那次 90 秒停服的**第二层**修法，比第一层（把闸门前移）更值钱：

| 层次 | 做法 | 局限 |
|---|---|---|
| 最弱 | 列一张前提清单逐条 `-x` 查 | 只覆盖「我想到的前提」——那次漏的正是 node |
| 中 | 给下游脚本加 `--check-only`，闸门里真跑一遍 | 覆盖确定性前提；瞬时故障仍会打在破坏之后 |
| **最强** | **改造破坏动作本身**：候选/临时目录里构建 → 校验 → 原子切换 → 失败即恢复 | 失败落在候选侧，活动态从未离开可用状态 |

`e5a3d65` 四处按这个顺序落地：影子安装（stage + 双 `mv` + 恢复）、正反向状态同步
（`--check-only` 解到 `mktemp` 而非 `STATE_ROOT`）、ai-memory 二进制（候选 `--version`
过了才替换现役）、LaunchAgent plist（候选先 `plutil -lint`）。

**dry-run 的正确形态是「真代码路径 + 真数据 + 假落点」**，不是「跑一段前置检查然后 exit」。
`sync-mini-b2-state.sh --check-only` 真打包、真 `limactl copy`、真解包、真做 config 转换，
只把目的地换成临时目录——所以它能抓到传输和解包故障；只查文件存在性的版本抓不到。

失败文案统一带 `no runtime state has been changed`，让读日志的人一眼知道要不要收拾现场。

**全量审计存档**：`docs/architecture/2026-08-05-window-script-gate-audit.md`——21 个脚本逐条列
「首个破坏点行号 / 破坏前校验 / 结论」，**含 9 个「无需修改」及其理由**。只列有问题的等于
没说覆盖了哪些；下次改窗口脚本先读这张表，别重新审一遍。

### ⚠️ 判"VM 有没有挂 Host HOME"别用 `[ -d /Users ]`

VM 里**确实存在** `/Users/rayman.chen`，但它是 Lima 默认配置留下的**空目录**
（与 `/` 同设备号、`mountpoint` 报 not a mountpoint、递归 0 文件、4.0K 仅 inode）。
正确判据是 `findmnt` / `/proc/mounts` 里有无对应条目，并配判别器（对照 `/` 应报 is a mountpoint）。
用目录存在性判会得到假阳性「Host HOME 被挂了」。

### 资源占用（新增的常驻成本）

`com.hplatform.mini-b2-lima` LaunchAgent `RunAtLoad=true` → Mini 登录即拉起 VM。
规格 4 CPU / 8GiB / 100GiB 上限，**实占约 4.0G 磁盘**；另有提交级源目录各约 5–10M 累积
（旧的按"不覆盖旧证据"保留，割接验收后可清）。临时停：`limactl stop h-b2` +
`launchctl disable gui/$(id -u)/com.hplatform.mini-b2-lima`。

### ⚠️ 运维文档里的路径：多机同名 home，别写 `~`

Air 与 Mini 的 home **都是** `/Users/rayman.chen`，dev198 是 `/home/chuan`。
所以回滚点写成 `~/local/h-mini-b2-rollback-…` 在 Air 上会解析成一个**语法合法但不存在**的路径
——而「不存在」与「回滚点真被删了」同信号，恰好在出事那一刻误导人。
本仓 `ops/deploy-sites.sh:33` 另有一条实测教训：`~` 进了引号不展开，ssh 过去是字面量。
**结论：运维文档用绝对路径 + 标明主机**（如「站外回滚点（Mini，`ssh mini-pub`）：`/Users/...`」），
不要为"可移植"改成 `~`。

## 🔴 Mini B2 首次割接事故与修复（2026-08-04；2026-08-05 已重新割接成功）

第一次跑 `cutover-mini-b2.sh --confirm-cutover` 失败，**且自动回滚也失败**，
最后靠人工恢复。两个根因都在 launchd 的语义上，写下来免得重演。

### 根因① macOS launchd：必须 `enable` 再 `bootstrap`，反了直接报错

```
launchctl bootstrap ... ; launchctl enable ...     ← 旧顺序
→ Bootstrap failed: 5: Input/output error
```

任务被 `disable` 过之后（割接第一步就会 disable 原生 bridge/runner），
再 `bootstrap` 会被 launchd 拒绝。**必须先 `enable` 解除禁用，再 `bootstrap` 装载，
最后 `kickstart -k` 拉起。** 三处已修：`deploy/launchd/install-mini-bot.sh`
的 runner 与 bridge、`scripts/ai-memory-provision-macos.sh`。
人工恢复用的也是这个顺序：`enable → bootstrap → kickstart`。

### 根因② `launchctl bootout` 返回 ≠ 任务已从 domain 消失

bootout 是**异步**的：命令返回后 Bridge 仍可能短暂存在于 launchd domain，
于是紧接着的静止态门（要求原生已停）正确地拒绝了同步——脚本"卡对了但流程断了"。
现修为 bootout 后轮询 `launchctl print` 直到查不到该 label（上限 40×0.25s=10s，超时 fail）：

```sh
wait_launchd_unloaded() {           # cutover-mini-b2.sh
  for attempt in $(seq 1 40); do
    launchctl print "gui/$UID_VALUE/$1" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  fail "launchd job did not unload: $1"
}
```

⚠️ 同一个坑的通用形态：**`stop`/`bootout`/`kill` 这类命令的返回只代表"请求已受理"**，
不代表状态已到达。下一步依赖"已停"时必须自己轮询确认。

### ✅ 割接与回滚的缺省活雷均已堵（rollback `3ba27a5`；cutover `7d441b5`）

曾经是 `SOURCE_ROOT=${PROJECT_ROOT:-"$HOME/local/h-platform-mini-bot"}` —— 缺省回退到
**原生部署根，而那份 `install-mini-bot.sh` 仍是旧顺序**（影子部署只更新影子源，不更新
原生根），忘传 `PROJECT_ROOT` 就原样复现事故。现改为 fail-fast 且在**任何服务动作前**：

```sh
SOURCE_ROOT=${PROJECT_ROOT:-}
[ -n "$SOURCE_ROOT" ] || { echo "Mini B2 rollback failed: PROJECT_ROOT is required" >&2; exit 1; }
[ -x "$SOURCE_ROOT/deploy/launchd/install-mini-bot.sh" ] || { …; exit 1; }
[ -x "$SOURCE_ROOT/scripts/ai-memory-provision-macos.sh" ] || { …; exit 1; }
# ↑ 全部在第一条 launchctl/systemctl 之前
```

实测 `env -u PROJECT_ROOT bash rollback-mini-b2.sh --confirm-rollback` → exit 1 且**零个
服务动作被触达**。**留这条是为了模式**：关键路径（回滚/恢复/灾备）的缺省一律 fail-fast，
别 fallback —— 人在事故里最容易漏传环境变量（[[feedback_fallback_default_points_at_unfixed_copy]]）。
`cutover-mini-b2.sh` 也采用同一规则，并预检 shadow verify 与 state sync 脚本存在；不能再依赖
“旧原生根刚好没有 deploy/lima”这种目录布局巧合来保证安全。

### 🔴 回滚必须先把 VM 状态反向回迁（`sync-mini-b2-state-back.sh`，commit `ba4fb4c`）

割接后 VM 里的会话、TaskSessionLog、Outbox、用户规则和记忆已经**比 macOS 原生副本新**。
只停 VM + 删 marker + 重启原生 = 让原生带着割接前的旧状态上线，任务历史/记忆/幂等送达
状态集体倒退。回滚的正确顺序是三段，缺一不可：

```
停 VM bridge+runner+ai-memory  →  反向回迁(fail-closed)  →  恢复原生 launchd
```

回迁范围与 `sync-mini-b2-state.sh` 精确互逆：`data/users`↔`users`、`data/{users,accounts}.json`
↔`config/*.json`、`memory`/`shared`/`orgs`/`workspace` 同名。VM 权威状态先归档进
`$H_B2_ROLLBACK_DIR/state/vm-state-pre-rollback.tar.gz`（700/600 + sha256 落 `evidence/`），
`H_B2_ROLLBACK_DIR` 必须存在、带 `evidence/`、且不在原生部署根内，否则 fail-closed。

⚠️ **`config.toml` 是 VM 的派生物，原生根本不读它。** `ai-memory-provision-macos.sh` 让
LaunchAgent 直接 `--config config.mini.toml`，`config.toml` 只在 Guest 侧由 `config.mini.toml`
经 `host.lima.internal` 替换生成。所以防 Guest 地址回流有双保险：回迁时从 `config.mini.toml`
重建，加上回滚末尾按 uid 重跑 provisioner 重写它。改这块别把两者搞反。

### 🔴 停止闸门禁止写成裸 `! cmd`（2026-08-05 复核抓到，差点带进演练）

`set -e` 对被 `!` 取反的命令**有豁免**（POSIX 明文）。所以下面这行拦不住任何东西：

```sh
! systemctl --user is-active --quiet h-mini-b2-bridge.service   # ← 服务在跑时照样往下走
```

服务仍在运行 → `is-active` 返 0 → `!` 反成 1 → **脚本不中止**，继续把一个正在写入的
VM 状态导出并覆盖原生。Lima Guest 实测（bash 5.3.9）：`! true` 后续语句照常执行、
退出码 0；同 shell 里裸 `false` 正常中止（对照锚，排除「`set -e` 没生效」）。
一律写 `if cmd; then echo …>&2; exit 1; fi`，或 `! cmd || fail "…"`（`sync-mini-b2-state.sh:21`
用的就是后者）。这条与 `|| true` 是**致命组合**——回滚里 `systemctl stop … || true` 吞掉
停止失败，下游闸门再空转，就没有任何一层会红。

⚠️ **配套的测试断言也不能只断言服务名出现在文件里**：`assert.match(script, /h-mini-b2-bridge\.service/)`
在把整行注释掉之后依然通过。正确做法是抽出 Guest 代码块、桩掉 `systemctl` 真跑——任一
服务 active 必须非零退出且**不产出归档**，全停时必须产出归档（正例锚防闸门恒失败）。
写完把原 bug 注入回去做负向验证，确认真的变红。详见 [[feedback_guard_itself_can_be_hollow]]
案例五、[[feedback_bash_short_circuit_pipefail_trap]]。

验 fail-closed 时别只看退出码非零：`env` 的选项必须写在赋值之前，否则拿到的 127 是 `env`
自己的、脚本压根没跑——**期望失败的用例更要核对失败原因**。用绊线桩替换
`launchctl`/`limactl` 证明零服务动作，再配一次真调用证明绊线本身有效
（[[feedback_exit_code_ownership]]）。

#### 🔴 验收清单里的 `bash -n deploy/lima/*.sh` 本身是空闸门（2026-08-05 实测）

**`bash -n` 只解析第一个文件，其余全变成位置参数**。这条写进 B2 验收清单已经多轮、
每轮 exit 0、每轮当"14 个脚本语法都 OK"用——实测把非首位的脚本换成语法错文件，
`bash -n deploy/lima/*.sh` **照样 exit 0**。改逐文件：

```bash
BAD=0; for f in deploy/lima/*.sh; do bash -n "$f" || { echo "SYNTAX $f"; BAD=$((BAD+1)); }; done
echo "语法错文件数=$BAD"
```

`node --check a.mjs b.mjs` 同坑（也只查第一个），而 `python3 -m py_compile a.py b.py`
**会全查**——同族三个工具两种行为，`cmd f1 f2` 的外形分辨不出来。本仓现有 `node --check`
用法全是一文件一调用（skill 940 行是 `for` 循环、`install-mini-b2-shadow.sh:70-71` 分两行），
**没有活的问题，别顺手"优化"成一行多文件**。判据见 [[feedback_guard_itself_can_be_hollow]] 案例八：
任何声称覆盖 N 个对象的检查，先往**非首位**塞一个必然失败的对象，确认它真的红。

#### ✅ 全仓空闸门已归零（`2eb827d`，2026-08-05 15:0x）

`ba4fb4c` 只修了 `sync-mini-b2-state-back.sh` 一处，同一惯用法在兄弟脚本里活了两轮。
扫描命令 `grep -rn '^[[:space:]]*![[:space:]]' --include='*.sh' .`——当时 9 处命中、5 处真空，
`2eb827d` 修完后 **4 处命中 / 0 处空闸门**：

| 文件:行 | 内容 | 判定 |
|---|---|---|
| ~~`install-mini-b2-shadow.sh:73,74`~~ | ~~`! systemctl --user is-active`~~ | ✅ `2eb827d` 已改 helper |
| ~~`verify-mini-b2-shadow.sh:17,18,23`~~ | ~~同上 + `! grep -q '<原生根>'`~~ | ✅ 同上 |
| `sync-mini-b2-state.sh:21,23` | `! … \|\| fail`（23 行的 `\|\|` 在 `\` 接续的下一行） | ✅ 安全 |
| `cutover-mini-b2.sh:60` | `! curl … && break` — 轮询循环退出条件，豁免即预期 | ✅ 合法 |
| `cutover-mini-b2.sh:63` | `! … \` + `\|\| fail` | ✅ 安全 |

**统一 helper：`deploy/lima/assert-mini-b2-shadow-state.sh <preflight|ready> STATE_ROOT NATIVE_ROOT`**
——显式 `if …; then fail; fi` 判 marker / Runner / Bridge，`ready` 另查 `mini-b2.env`
未泄漏原生部署根。install 与 verify 复用同一份，避免两套判定漂移。

**位置也修了**：preflight 现在紧跟 `limactl start`，早于 bootstrap、ai-memory 安装、
App 切换、`npm ci`、deploy meta 与 env 渲染。（当时被它挡在后面的那个
`rsync -a --delete "$APP_ROOT.stage/" "$APP_ROOT/"` 已在 `e5a3d65` 整个删掉，换成
stage 内构建 + 原子 `mv`——见上文 build-then-swap。）`limactl start` 留在闸门之前，
是因为必须先启 VM 才查得到 Guest systemd，且该动作不覆盖应用代码或持久状态。
（旧形态的教训保留：**闸门排在破坏之后＝文档不是保护**；当时唯一真会拦的是
L72 的 `test ! -e <marker>`——`test` 的 `!` 是参数不是 shell 取反——但那已在覆盖之后。）

回归守卫已进 `test/mini-ab-lima-b2.test.mjs`：桩 `systemctl` 真跑 helper + 哨兵文件验证
闸门后无副作用；断言 install 闸门位置早于全部覆盖动作；**`deploy/lima` 取反命中数锁死为 4**
（新增任何裸 `!` 即红）。

> 教训：**修完一个缺陷要当场用它的特征全仓扫描并贴出计数。** 我 `ba4fb4c` 时就把扫描命令
> 写进了本 skill，**写了没跑**，两轮后才撞见。写进文档 ≠ 本次已清扫。
> 另注：一行正则判不了多行语法，我第一版「行尾有 `\|\|` 才安全」产生 4 个假阳性，
> 必须逐条读上下文（[[feedback_guard_itself_can_be_hollow]] 案例六）。

### Mini launchd label 真值（别自己编，2026-08-06 编错过一次）

`launchctl list | grep -i hplatform` 实际列出来的才算数：

| label | 何时存在 | 作用 |
|---|---|---|
| `com.hplatform.mini-b2-health` | 已割接态 | ssh `-L 18775:18775` 把 VM healthz 转到主机 |
| `com.hplatform.mini-b2-lima` | 常驻 | Lima 实例自启 |
| `com.hplatform.mini-ab` | 常驻 | A/B 观察器 |
| `com.hplatform.mini-bot.bridge` / `.runner` / `memory.<uid>` | **仅原生承载期** | 回迁后由原生 launchd 提供服务 |

⚠️ **同一个名字在不同承载态下真假不同**：割接态查 `mini-bot.bridge` 会得到「未加载」——
那是**对的**（VM 在服务），不是故障。所以 unit 存在性结论必须**连承载态一起说**，
不能孤立地断言「这个 unit 不存在」。而不存在的 unit 与真挂了的 unit 返回同一信号
（[[feedback_probe_parameters_are_facts_too]]）。

判承载方最硬的一招：`lsof -nP -iTCP:18775 -sTCP:LISTEN` 看是 `ssh`（转发→VM 承载）
还是 `node`（原生承载）。

### 🔴 割接就绪判据里的契约版本必须动态取（`d47edb7`）

`cutover-mini-b2.sh` 原本钉着 `assert behaviorContractVersion=="2026-08-04.2"`。契约一升级
它就**永远 not ready**，40 次重试后报「Lima health did not become ready」——**症状看着像
VM 起不来，实际是判据过期了**。现改为从 `$SOURCE_ROOT/lib/bot-behavior-contract.mjs`
用 sed 抽 `BOT_BEHAVIOR_CONTRACT_VERSION`，抽不到即 fail-closed。
**换一个新字面量只是把同一颗雷往后挪一轮**（[[feedback_criteria_must_match_object_variant]]）。

### 🔴 健康端口闸门必须带 `SO_REUSEADDR`（commit `1d5ccc5`）

真实回滚演练暴露过 OpenSSH multiplex 孤儿转发：health LaunchAgent 已卸载，Lima 的 SSH
master 仍监听 18775，原生 Bridge 只能以 `health=off` 起来。修法是 forwarder 强制
`ControlMaster=no`/`ControlPath=none` + 回滚兼容 `-O cancel` + **以端口能否 bind 作独立闸门**。

⚠️ 但那个闸门的探针不能用裸 bind：

| 量 | 实测值 |
|---|---|
| macOS `net.inet.tcp.msl` | 15000ms → `TIME_WAIT` = 2×MSL = **30s** |
| 闸门重试窗口 | 40 × 0.25s = **10s** |

隧道关掉后，先前经它 accept 的连接会在本地端口留 `TIME_WAIT`，**窗口熬不过去**，
裸 bind 必然假报「端口仍被占用」并中断回滚。加 `SO_REUSEADDR` 后 TIME_WAIT 下可绑定，
但**仍被真实 LISTEN 拒绝**（macOS 实测 errno 48），所以不漏放。

**诊断必须同时打 `netstat`**：`TIME_WAIT` 的 socket 无属主，`lsof -iTCP:<port>` 与
`-sTCP:LISTEN` **都是 0 行**（实测）。只打 lsof 会在事故现场给出「端口被占用」+
空白进程列表的自相矛盾输出，操作者只能误判成工具坏了或脚本瞎报
（[[feedback_negative_result_needs_signal_capable_channel]] 例三）。

> **备用端口测试（新建 forwarder 持 18776、杀 PID 后立即释放）覆盖不到这个场景**——
> 那条链路从没 accept 过连接，结构上不可能有 TIME_WAIT。**通过是因为场景缺触发条件。**
> 验「释放/回收/清理」类逻辑一律**先把资源用脏再验**（[[feedback_fix_verified_on_richest_variant_only]]）。

⚠️ **文本断言这次又来了一遍**：闸门配的测试是 `assert.match(rollback, /still occupied/)`，
同样只证明这句话在文件里出现过。24 小时内同一文件第二次踩——现已改为抽出探针真跑
（活监听→占用 / TIME_WAIT→空闲），并用不带 `SO_REUSEADDR` 的裸探针做锚证明脏状态真形成。

### 🔴 VM 持久状态必须钉在 `/srv/h-platform/workspace`（commit `4947889`）

状态同步与回滚操作的是 `/srv/h-platform/workspace`，但 SQLite、Delivery Outbox、Runner RPC、
follow-up、会话映射、去重、开场白、角色粘滞、主动验收、进化状态**默认写在
`/opt/h-platform/app/workspace`**（`ROOT/workspace`）。空闲切换看不出问题，
处理过任务后回滚就会漏掉最新权威状态。现由 `render-mini-b2-env.mjs` 显式钉住 17 个键。

⚠️ **「钉住」有两条路径，健壮性不同——别只看线上读数**：

| 路径 | 前提 | 健壮性 |
|---|---|---|
| 显式 override 表 | 无 | 无条件 |
| 通用 `mapSourcePath` | 原生值**非空**且在 `<sourceRoot>/workspace/...` 下 | **条件** |

`GROK_CWD` 原先只有后一条兜着。生产 `.env` 恰好非空 → 线上 17 个键全显示 `/srv`，
**完全看不出差别**；而 `.env.example:7` 出厂即 `GROK_CWD=`，全新部署会回退到
`/opt/h-platform/app/workspace`，而 `ensureWorkspaceScaffold()` 正写在那儿。已加显式 override。

**复核手法（下次照做）**：完整性检查用**退化输入**而非生产输入——喂一份全部持久键为空的
`.env` 跑渲染器，断言输出全部落在 `/srv/h-platform/workspace` 下，并配一个未管理键保持空值
的锚（防"渲染器给所有键都填了值"的假通过）。枚举全集时先拿已知子集验证枚举器本身：
我第一版正则漏了 `GROK_SESSION_MAP` 等，是拿 override 表比对才发现的。

#### ✅ 已割接态验证器（`e0525b5`，割接后用它，别再手工翻 healthz）

影子态验证器只能证明「割接前是影子态」；割接**之后**的结构化验收现在有专用只读工具：

```bash
# Mini 上，验证器单独归档在 ~/local/h-mini-b2-verifier-<sha12>/（不进 VM app，不改 deploy meta）
"$OPS_ROOT/deploy/lima/verify-mini-b2-active.sh" \
  --expected-commit <完整40位SHA> --expected-contract <从源码取,别抄这里的字面量> \
  --uid <目标uid> --after "$(date -u +%FT%TZ)" [--task-id <id>]
# 契约真值：rg BOT_BEHAVIOR_CONTRACT_VERSION lib/bot-behavior-contract.mjs
# 2026-08-06 起 = 2026-08-05.3；钉死字面量必然腐烂，见下方「闸门的期望值必须从源码取」
```

⚠️ **顶层 `ok` 的语义**：带 `--skip-long-task` 时顶层恒为 `"ok": false, "status": "partial"`，
即使 16 项 healthChecks 全绿——那是**长任务层未验**，不是不合格。**「取不到」与「值不对」
必须分开报**，别把 partial 当失败、更别把它当通过。长任务层是**校验既有记录**
（`verify-b3-long-task.mjs` 查 `--after` 之后 ≥120s 的任务），不自己发起，
所以要先真机跑一条重任务才谈得上 `complete`。
```

三层依次 fail-closed，任一层挂掉下游不执行：
1. `assert-mini-b2-active-state.sh`（Guest 侧）：marker 存在 / Runner+Bridge active /
   env 0600 且不含原生根 / **17 个持久键全在 `/srv/h-platform/workspace`** /
   deploy meta 命中期望 SHA 且 dirty=false / manifest `--check` / Runner socket 存在。
2. healthz 全量：站点、契约版本、`deploy.commit`、队列、Outbox、Runner、Orphan、
   目标 App 唯一且 connected 且 lastError 为空。
3. `scripts/verify-b3-long-task.mjs`：TaskSessionLog 顺序、`background_yielded.elapsedMs ≥ 120000`、
   Outbox acked 与飞书 messageId 一致、拒绝 operator 探针冒充。

⚠️ **验证器比 `2eb827d` 晚**，不能从 `2eb827d` 归档，**更不能手工拷进部署目录后还宣称
deploy meta 是纯净的 `2eb827d`**——那就是虚报版本。单独归档到 `h-mini-b2-verifier-<sha>`。

**healthz 键真值（2026-08-05 生产实测，改判据前对这张表，别读源码猜）**：
顶层 `ok / connected / executionSite / behaviorContractVersion / queueDepthTotal /
activeSessions / liveGrokSessions / deploy.{commit,dirty} / deliveryOutbox.{pending,retrying} /
orphanRecovery.total / apps`；`runnerWorker.{connected,registeredApps,pending,active,children,leases,
workerPid,workerStartedAt,apps,lastHeartbeatAt,oldestLeaseMs,protocolVersion,remoteChildren}`；
`orphanRecovery.{total,compute,followUp,rpc,replayable,lastOpAt,lastReportAt}`；
每个 app 条目 `{uid,kind,engine,connected,lastError,executionSite,behaviorContractVersion,
botOpenId,larkCliReady,lastInboundAt,lastOutboundOkAt,placementLeaseExpiresAt,startedAt}`；
另有 `followUps.{pending,applied}` / `runnerRpc.{running,inflight}` /
`workConcurrency.{active,waiting}`（2026-08-05 补测，升级预检的第 10 条判据用它们）。
🔴 两个易踩的**值**语义：`lastError` 健康时是 **JSON `null` 不是 `''`**，所以判据可以
严格写 `is None`；`followUps.applied` 是**当前处于 applied 未 ack 的记录数（瞬时量）**，
不是累计计数器，要求它为 0 才成立——换成累计值就会在第一次 follow-up 后永久变红。
🔴 审这类核对时**每个 `.get(k, 期望值)` 都是待验**：键名写错 → 返回默认值 → 恒真，
与「状态正常」同信号。证伪只能靠**拉真实响应 JSON 逐键探**，读源码看不出来
（`runnerWorker: runnerWorkerClient.snapshot()` 不告诉你 snapshot 有哪些字段）。
详见 [[feedback_guard_itself_can_be_hollow]] 案例七。

#### ✅ 窗口环境预检已内建（`3606b7c`；起因是 2026-08-05 真机 90 秒停服）

**事故**：`ssh mini-pub "..."` 是非交互 shell、PATH 里没有 node（铁律 9 在 dev198 记过同一件
事），而 `install-mini-bot.sh` 用 `command -v node` 找它、找不到就 fail——**它排在回滚器
「停 VM 服务 + 删 marker」之后**，一失败就是 VM 已下线、原生没起来。19:12:48 停服 →
19:14:18 恢复，**90 秒**。

**现在的护栏**（`rollback-mini-b2.sh` / `cutover-mini-b2.sh` 在**动任何状态之前**调用）：
- `deploy/lima/assert-mini-b2-window-env.sh <SOURCE_ROOT> <NATIVE_ROOT>`：验 6 个必需可执行
  文件 + 解析 node + 验 `ai-memory` + **用 `install-mini-bot.sh --check-only` 无副作用地真跑
  一遍安装器前置**，通过则把解析出的 node 路径打到 stdout 供调用方复用。
  失败文案统一带 `no runtime state has been changed`。
- `deploy/lima/resolve-node-bin.sh`：三级解析 `H_B2_NODE_BIN/NODE_BIN` → 当前 PATH →
  登录 shell（`H_B2_LOGIN_SHELL`，默认 `/bin/bash`），每级都要求 `-f` 且 `-x`
  （**目录不能冒充可执行文件**），全落空则 fail-loud。
- 所以**不再需要手工 export `NODE_BIN`**；显式传仍然有效且优先级最高，出问题时可用它锁定。

🔴 **一般化（两条，比这个具体 bug 值钱）**：
1. **闸门后置的失败会把「回滚」本身变成事故。** 审运维脚本时逐点问：**它第一次可能失败
   的地方，前面已经破坏了什么？** 环境前提一律提到破坏动作之前。
2. **前置校验的最强形态不是"核对前提清单"，而是"用无副作用模式把那个会失败的步骤真跑
   一遍"。** 清单会漏项（这次漏的就是 node），dry-run 真跑漏不掉——`--check-only` 就是
   为此加的。给关键脚本加 dry-run 开关，比给它加一页前提文档有用。

**若仍在安装器处失败**（此时 VM 已停、marker 已删、reverse sync 已完成）：**别重跑整个
回滚器**（会重复 reverse sync），只补跑 `NODE_BIN=... PROJECT_ROOT=<原生根>
install-mini-bot.sh` 再验原生 healthz。取值去回滚包备份的
`launchd/com.hplatform.mini-bot.bridge.plist`，其 `PATH` 里 `dirname(NODE_BIN)` 就是上次
真跑起来过的那个（本机 `/Users/rayman.chen/.local/bin/node`）。

#### 📋 升级窗口方案：`docs/rollbacks/2026-08-05-mini-b2-upgrade-window.md`（`6bbcd51`，`c6cd408` 后含真机执行记录）

`1d5ccc5` → `2eb827d` 的完整执行顺序、十条静止判据、两个站外回滚包清单、割接后三通道
回读。回滚包 launchd 清单已在 `a2e93b9` 补齐两个 B2 专属 plist 及其期望状态：
`mini-b2-lima` 回迁与重割接期间**都**保持 enabled+loaded（VM 得能起，状态同步和影子
重建都依赖它）；`mini-b2-health` 回迁原生后 disabled+unloaded（否则健康隧道抢 `18775`），
重割接后再 enabled+loaded。状态要写进 `evidence/launchd-state-before.txt` 留证。

#### 🔎 升级预检 `preflight-mini-b2-upgrade.sh`（`1456803`，窗口当天先跑这个）

十条静止判据从"人工逐条翻"变成一次只读调用，输出结构化 JSON，非零退出即不满足：

```bash
export NODE_BIN=/Users/rayman.chen/.local/bin/node   # 非交互 ssh 无 node，见上方红框
"$OPS_ROOT/deploy/lima/preflight-mini-b2-upgrade.sh" \
  --expected-commit <当前部署的完整40位SHA> --target-app-id <AppID> --target-uid <uid> \
  --owner-app-id <ownerAppID> \
  --target-source-root "$HOME/local/h-mini-b2-source-<目标sha12>" \
  > "$EVIDENCE_DIR/preflight-before.json"
```

`criteria` 恰好 `criterion01`…`criterion10`，每项带 `ok/current/errors`；顶层
`snapshotExitCodes` 三项 **`miniHealth` / `guestAndControl` / `targetRenderer`** 必须全 0，
证明四路快照都真取到——**空快照会让所有判据"没红"，那不是通过**。健康计数每次重取，
不读历史日志或累计值。控制面 token 只在 VM 内用（`node --env-file` 读 `mini-b2.env`），
不打印不回传。只读性已验到整个调用图：`GET /internal/app-placement` 与 `GET /internal/users`
都是纯读（`store.list()` + `appPlacements.get` 只过滤过期、不落盘）。

🔴 **`--target-source-root` 必须指向【升级目标】的 commit 级源目录，不是活动 VM。**
持久键双源对撞比的是目标版本的 `render-mini-b2-env.mjs`。2026-08-05 首次真机 dry-run
就栽在这里：原实现读 `$APP_ROOT`（＝活动 VM，`1d5ccc5`，25 个 override、一个持久键都不钉），
于是 `rendererCount=0`、`checkerOnly` 是全部 17 个键，criterion09 **在升级前必然红**。
一般化：**一条用于"决定要不要升级"的闸门，若拿当前部署当参照系，它就只能在升级后变绿
——守不了它本该守的那次升级。** 升级前闸门的参照系必须是目标态。（`c6cd408` 修复；
目标 renderer 在 Mini 宿主执行，对 `/dev/null` 输入只做纯路径计算，不读 VM 文件系统。）

🔴 **阻断：`--dev198-health-url` today 无解，criterion07 必然 fail-closed（2026-08-05 实测）**
dev198 的 healthz **只绑 `127.0.0.1:18765`**（`ss -ltnp` 直读），Mini 上打它连接被拒。
三条独立证据排除了别的解释：dev198 本机自打 **http=200**（服务活着）、Mini→dev198
`ping` **0% 丢包 0.5ms**（三层通）、地址 `192.168.61.233` 对齐 memory `user_hardware`
真值锚。**不是服务挂了、不是网不通——是这个 URL 从来不存在**，文档里
`http://<dev198有线地址>:18765/healthz` 是没验过的前提。Mini 也没有 `Host dev198` 的
ssh 配置（`grep -c` = 0），走 SSH 取数同样不可行。
**正解**：dev198 那一侧改用控制面 `GET /internal/users`（已存在的只读端点，返回每个
user 的 `{uid, appId, active, executionSite}`，VM 内用同一个 token 就能调）。它比原设计更强
——原设计只能发现"两边都在跑"，用控制面能同时发现"跑的位置和登记的位置不一致"。

✅ **原先记的三处覆盖缺口已全部补掉**（`9308d32` / `8d59143` / `a7b2cea` / `c6cd408`）：
limactl 桩现在真把 stdin 交给 `bash -s`，guest 侧 python 与 `node --env-file` 控制面查询
真执行（负向注入实证：把 guest 的 env 权限读数改成恒报 `0600`，测试立刻红）；curl 桩可
注入非零退出，覆盖「快照取不到」分支；criterion09 改成与目标 renderer 逐键对撞，
并把「取不到目标 renderer」与「两源不一致」分开报错。

**第三层（真实长任务）只能靠真发一条 ≥130s 的飞书任务触发。** 已真机跑通两次：
2026-08-05 割接（`elapsedMs=120014`、`durationMs=428160`）与 2026-08-07 升级后复验
（`elapsedMs=120004`、`durationMs=201251`，10 项 checks 全真）——两次都是 Outbox 与
TaskSessionLog 同 messageId、`task_completed` 晚于 `delivery_acked`。
**每次升级都要重跑这一层**，理由与造任务的两个前置条件见下方「Mini B2 升级实战补充」。
想**只读复跑前两层**用 `3606b7c` 新增的
`--skip-long-task`：它会输出 `partial` 并标注跳过原因，**顶层不会伪装成 `ok=true`**
——跳过和通过在输出里必须长得不一样。不带该开关且窗口内没有长任务时，会以
`没有找到符合条件的飞书入站任务` 失败，那是预期不是故障。

#### ✅ 版本态（2026-08-10 15:45：dev198 与 Mini VM **同版 `f076e7642fab`**，双站契约 `2026-08-09.1` 唯一；Mini 完整验证器 `ok=true, status=complete`）

| 位置 | 版本 |
|---|---|
| 控制面 aliyun-hk | 线上 **`v1.60.0`**（H-0087 scope-import 端点+助手页；Source `256d6f5`、51 文件 `in_sync`、`mismatchCount=0`；公网 `/healthz` 取真值） |
| Mini 活动 VM 运行态 | **`f076e7642fab`**、`dirty=false`、581 文件、1 App（2026-08-10 三段割接零停服；真实长任务验证器 10/10 全绿，Base H-0085） |
| dev198 | **bridge.mjs/control-client/feishu-send/lark-scope-guidance 已到 `256d6f5`**（H-0087 投递修复+助手按钮，2026-08-11 双服务重启热更；git HEAD 仍 `f076e76` 属正常——按文件 sha 对撞判断，契约 2026-08-09.1 全 12 App 唯一） |

> 仓库 main 已到 `256d6f5`（H-0087 P0+P1 一体提交）；dev198 运行文件按需热更（四文件当前=256d6f5 内容），不要把控制面 Source Commit 当成 Bridge Runtime Commit，也不要拿 dev198 的 git HEAD 当运行态真值——认文件 sha 对撞。dev198 备份 `~/local/h160-bak-120500/`、控制面备份 `/srv/h-control/filebak-v1590-120100/`。

⚠️ **跨 bridge+控制面的字段/行为修复，部署顺序=先控制面后 bridge**（2026-08-10 实测）：
bridge 一重启 bootPush 立即推镜像，若控制面新代码还没起，数据被旧代码处理一次，
且 mirrorHash 门控让内容不变永不重推——旧结果被防重机制固化。顺序反了的补救=
两端就位后再重启一次 bridge 清门控。验收认**部署后新产生的数据**（其时间戳必须
晚于链上最后一个组件的 startedAt）。详见 [[feedback_multi_hop_field_whitelist]]。

**公告送达验收判据（2026-08-10 实测）**：送达成功是**静默的**（代码只在 ack fail 打日志），
`journalctl` 零命中 ≠ 没送达。真值两处：① dev198 healthz 的 `releaseAnnouncements` snapshot
（fetched=0 且发布过 = 多半已送完）② 控制面 `data/release-announcements.json` **顶层
`deliveries`** 的 `<announcementId>:<recipientKey>` 平铺 key（不在公告对象里——别在
announcement 里找 recipients 字段，那是判据套错形态）。`perBot:false` 按 person 去重，
同人多 Bot 只有**最近活跃的**收卡——「某 Bot 没收到」先查同 person 的其它 Bot。
| 安装源 | Mini 上 `~/local/h-mini-b2-source-<commit>`，**具体路径现场 `ls` 取**（随 commit 变，写死必腐烂） |
| 验证器 | 已随 `d47edb7` 起进入部署源码树，**不必再单独归档**（`$SRC/deploy/lima/verify-mini-b2-active.sh` 直接跑；`$SRC` ≠ VM app，不污染 deploy meta） |

> 历史：`1d5ccc5 → 2eb827d`（08-05）→ `d47edb7 → f3336bc → 615ce62`（08-06 上午，H-0076）
> → `29cfb3f → 65a4ff9`（08-06 下午，H-0032/H-0029，见下方专段）。
> **版本号一律现场取，别引用本表**——它每轮都会腐烂。

⚠️ **落差仍然是常态，别再"对齐"**：`2eb827d` 之后的提交全是 `deploy/lima/` 验证工具、
docs、test 和控制面（跑在 aliyun-hk），**对 VM 运行时零行为变化**——`1d5ccc5→2eb827d`
那次实测也只动了 8 个文件且无一是 `bridge.mjs`/`lib/`/`runner-worker.mjs`。判断要不要再开
窗口，看的是**目标 commit 有没有改到 VM 内真正运行的代码**，不是 SHA 看着不一样。

🔴 **禁止为了"看起来一致"手工改活动 VM 的 `.deploy-meta.json`——虚报新版本比不更新更危险。**
再开窗口时照 `docs/rollbacks/2026-08-05-mini-b2-upgrade-window.md` 走（该文档已含真机执行
记录与 `NODE_BIN` 红框）：低峰、先建站外回滚包、确认静止、回迁→影子安装→割接，
割接后回读 deploy meta、17 个持久键、健康状态和一条真实飞书长任务。

### 🔧 查 VM 运行时配置：`/proc/<pid>/environ` 看不到

这些变量由 `bridge.mjs` 启动后 `loadEnvFile()` 注入内存，**不进 OS 环境**——
查 17 个键全返回「未设置」，而同一份 environ 读得出 19 个变量含 `PATH`（仪器是好的）。
真载体查法：`systemctl --user cat h-mini-b2-bridge.service` → 当前是
`Environment=H_ENV_FILE=/srv/h-platform/config/mini-b2.env`（**不是** `app/.env`，那个文件不存在）。
再核对「该文件 mtime < 进程 `ActiveEnterTimestamp`」才算证明进程加载了它。
⚠️ 对不存在的 `.env` 路径 grep 会得到一堆「未出现」，与真缺失同信号，先 `stat` 确认文件在。

### ✅ 曾经的 flaky 已修（同 commit）

`test/runner-worker-ipc.test.mjs`「kill worker 后调用标 orphan」曾偶发
`runner worker app not registered`。机理是**等的信号不是下一步依赖的信号**：
断言 `snapshot().connected`（socket 层）却紧接着 `remote.execute`（需要 app 已重注册）。
现双向修好——生产侧 `isConnected() = ready && isSocketConnected()`，`ready` 只在
`await registerAll()` 之后置真（socket close / register 失败 / close 时清零）；
测试侧去掉固定 `sleep 350ms` 改等真实条件。**验收跑了 8×2 = 16/16**。

⚠️ **修竞态后"首跑绿"不是证据**——间歇缺陷修复前也经常首跑绿。必须重复 N 次
（N 覆盖原故障率），最好同时证伪机理。见 [[feedback_classify_test_failure_before_deciding]]。

### ⚠️ 别信 harness 通知里的退出码

后台跑 `npm test > log 2>&1; echo $?` 时，harness 的完成通知报的是**整条复合命令**
的退出码（末尾 `echo` 恒 0）。实测同一晚两次通知都写 "exit code 0"，
真实一次是 1 一次是 0。**认自己 echo 出来的值 + 日志侧 `not ok` 计数对撞**，
别拿通知给"测试通过"背书（[[feedback_exit_code_ownership]]）。

## Mini B2 正式割接后的两条 VM 专属根因（2026-08-05）

### ① `install -d` 只修叶子，不代表父目录可写

首次主链路启动时 Bridge 连续重启，日志为 skill manifest 临时文件原子写 `EACCES`。根因是
bootstrap 只对 `$STATE_ROOT/config` 等叶子目录指定运行用户，`/srv/h-platform` 与 `audit`
父目录仍可能由 root 创建。现在必须显式创建并改属主：

```sh
sudo install -d -o "$USER" -g "$USER" -m 0755 "$STATE_ROOT"
for directory in config users memory shared orgs workspace runtime audit audit/lark-cli rollback; do
  sudo install -d -o "$USER" -g "$USER" -m 0700 "$STATE_ROOT/$directory"
done
```

验收不能只看 service active；要看 `NRestarts=0`、目标原子写成功和目录逐级属主。

### ② 跨 VM 后 `127.0.0.1` 换了含义

Host 原生的记忆 URL 若直接复制到 Guest，`127.0.0.1:11434` 会指向 Guest 自己，不再是
Mini Host。`render-mini-b2-env.mjs` 现强制把 LLM 与 embedding 地址渲染为
`http://host.lima.internal:11434/v1`。验收必须从 VM 内发真实 chat/embedding 请求并取得 200，
不能用 Host 上 curl 成功代替。

### ③ B3 长任务必须验“新消息”，不是只看完成文字

正式验收实测：用户消息进入 VM Runner，120 秒出现 `background_yielded`，255 秒完成；
会话底部新增一张完成卡。证据必须同时包含不同的飞书 message ID、TaskSessionLog 的
`delivery_acked` 与 Outbox 清零。复用旧卡、只编辑流式卡或 Bot 自述“已完成”均不算通过。

## 🔴 H-0076 会话式 Skill L2 上生产（2026-08-06，两站已全开）

**终态**：Mini VM `615ce62`（AI 专家）/ dev198 `e2263af`（12 App），契约 `2026-08-05.3` 全站唯一。
灰度五变量 `H_SKILL_{PROPOSALS,PROPOSAL_UIDS,REPEAT_DAYS,REPEAT_MIN,SUGGEST_COOLDOWN_DAYS}`，
熔断=`H_SKILL_PROPOSALS=0`。**2026-08-06 川哥拍板 dev198 全量放开 11 租户**（`=1` 且不设名单）；
`H_ONCE_REMINDERS=0` 两站保持关闭（按字面不扩展）。

### 🔴 这两个开关是「空名单＝全量放开」语义（配错方向的经典陷阱）

```js
// lib/skill-proposal-engine.mjs parseSkillProposalUidAllowlist：空串 → return null
// bridge.mjs: process.env.H_SKILL_PROPOSALS !== '0' && (!uids || uids.has(ctx.uid))
```
- **什么都不配 ＝ 对所有租户默认开**（`undefined !== '0'` 为真、`!null` 为真）。
- 要关必须**显式写 `=0`**；「不放任何 UID」按字面理解成留空，恰恰是最危险的配置。
- 同型开关：`H_ONCE_REMINDERS` / `H_ONCE_REMINDER_UIDS`（reminders 腿，同一套写法）。
- owner 永远收不到：闸门含 `sandbox &&`，而 owner `sandbox=null`（结构性排除，不靠 env）。

### 灰度变量的落位链（VM 侧改 env 的唯一正确姿势）

`~/local/h-platform-mini-bot/.env`（原生）→ `install-mini-b2-shadow.sh:45` `limactl copy` →
`render-mini-b2-env.mjs` → `/srv/h-platform/config/mini-b2.env`（VM 内真值，**不在 app 目录**）。
非路径值原样透传（`mapSourcePath` 只对绝对路径重映射）。改完必查渲染产物那 5 行，
别只看原生 .env 就宣布生效。

### 真机灰度当天逼出的两个 bug（都只有真机能发现）

1. **`f3336bc`**：`fork_update` 的 `targetKey` 原样带共享层 key → 控制面正确 403
   `target skill is outside user layer` → 用户点确认必失败。四种 action 只有它会踩。
   **为什么测试没拦住**：①断言写成两可 `assert.ok(['use_existing','fork_update'].includes(x))`
   ——从没钉死走哪支，`targetKey` 一个断言都没有 ②mock 的 controlClient 恒返 ok，
   把跨系统 403 校验整个挡在测试外。见 [[feedback_disjunctive_assertion_never_tests_the_branch]]。
2. **`615ce62`**：确认后有最长 70s 空白（`waitForSkillInstalled` 轮询执行站点回读），
   toast 一闪即逝 → 用户以为没成功会再点 → 而重复点击拿到的「已经处理过或暂时无法应用」
   在刚成功场景下是**误导**。修法三件套：apply 受理即发**过程卡**（真实消息才保证送达，
   toast 不是送达）、handler 入口按 `proposal.status` 分流各回对症文案、
   gateway `not_pending` 带回当前 status 供调用方区分。

### 勘误：后台编辑正文**存在**（推翻 2026-08-05 的「未实现」结论）

`control-plane/lib/html.mjs` 有完整链路：查看既有 skill → `svEditBtn` → `svEdit()` 载入
`SV_CONTENT` → `svEditor` → `svSave()` 提交 `action:'upsert-content'` +
`expectedSha`（乐观锁，STALE→409）+ `summaryZh`（所以简介不会被清空）；
路由 `/api/skill`(2862) → `handleSkillMutation`(310)。
**当初查错的原因**：只看到 696/735 行那个 `add-content` textarea（那是**创建**面板），
漏了 `svEditor`。教训：`POST /api/skill` 的 action 不止路由块里显式列的那几个，
**还有兜底转发到 `handleSkillMutation` 的一整批**——只 grep 路由块会漏。

- **个人 Skill 编辑器只在「用户后台」**，管理台没有该入口（管理台是平台层市场管理）。
  入口：单聊发「配置」→「打开我的后台」，或结果卡上的「打开 Skills 后台」（magic link 按租户签发）。
- **revisions 存在独立目录**：`/srv/h-control/data/skill-revisions/<sha256(key)>/<id>.json`，
  **不在 `skills.json` 里**——在 skills.json 里数 revisions 恒为 0，会误判「版本历史没生成」。

### VM 更新＝完整循环，没有捷径

`assert-mini-b2-shadow-state.sh` 在 active 态直接 fail（marker 在/unit active 都拦），
所以每次改 VM 代码都必须：**rollback → 传新源 → install shadow → sync shadow → verify shadow
→ 建新回滚包 → 静止门 → cutover → 三通道对撞**。一轮约 10 分钟。
- rollback 内嵌 `sync-mini-b2-state-back.sh`，**用户状态（提案/冷却/skills）会被带回原生**，
  跨轮存活，不会丢。
- `install-mini-b2-shadow.sh` 对 `git archive` 传的源目录（**无 .git**）必须显式给
  `H_DEPLOY_COMMIT`（40 位）/`H_DEPLOY_BRANCH`/`H_DEPLOY_SOURCE_HOST`，否则前置校验直接 fail
  （fail 在任何 mutation 之前，安全）。

## 🔴 部署机 git 分叉手术（HEAD 精确对齐 + owner 工作区逐字节不动）

`ops/deploy-sites.sh` 要求 dev198 HEAD **精确等于**本地 COMMIT，且 dirty 检查对
`workspace/**` 是**硬拒**（`die "拒绝处理 workspace/ 下的改动"`，不是放行）。
当 dev198 有本地提交（owner Bot 在飞书对话产生的 skill/规则被 commit 了）就会死锁。

**`reset --mixed` 解决不了**：它只移指针不动工作区，落后版本新增的文件会全部变成 ` D`，
撞死在 dirty 检查上（本轮实测 41 个 D）。

**可行手术**（2026-08-06 实操，owner 内容零改动）：
```bash
cp -a workspace "$HOME/ws-copy-$TS"                 # 1. 物理备份(139M)，脱离 git
git switch -c h0076-owner-ws-backup-$TS             # 2. 备份分支
git add -u workspace/ && git commit                 #    连未提交漂移一起入袋
git add <其它脏文件> && git commit                   #    非 workspace 的也要收(否则第3步拒绝)
git checkout -B <branch> origin/<branch>            # 3. HEAD 精确到目标
git checkout <BK> -- workspace/ && git restore --staged workspace/   # 4. 复原 owner 内容
git checkout HEAD -- <上游新增的那些文件>             # 5. 目标版新增文件要显式检回
LC_ALL=C diff -rq workspace "$HOME/ws-copy-$TS"     # 6. 对撞:差异只允许运行态点文件
```
- 第 5 步易漏：备份分支里**没有**上游新增的文件，第 4 步会把它们删掉。
- 第 6 步判据：`Only in` 应恰好 = 上游新增数；`differ` 只允许 `.state/`、`.follow-ups/`、
  `.runner-rpc/`、`.msg-dedupe.json`、`.chat-history/` 这类活文件（cp 与 diff 之间服务仍在跑）。
- **owner 攒的通用规则（不含隐私）应经授权收编进仓**，否则每次部署都要重做这套手术
  （本轮把 `prompts/pm/PROMPT.md` 的 R32 收编为 `e2263af`，死结永久消除）。
- 拉平纯文档提交用 `SKIP_RESTART=1 ops/deploy-sites.sh dev198`（healthz 版本滞后是声明预期）。

### 🔴 跨机文本判据必须钉 locale

dev198 是中文 locale，`diff -rq` 输出「只在…中存在」「文件…不同」——
`grep -c "^Only in"` / `grep -c "differ$"` **全部零命中**，把一次完美复原连报两轮假 ABORT。
**跨机跑文本判据前 `LC_ALL=C`**，或改用 locale 无关通道（退出码、`--name-only`、计数）。
同日第二跳：改用 `git diff <commit>` 后又踩「它对 untracked 文件失明」，磁盘上好好存在的
9 个文件被报成差异。三连问：**什么语言？什么通道？该通道对哪类对象失明？**
见 [[feedback_criteria_must_match_object_variant]]。

---

## H-0032 / H-0029 上线（2026-08-06 下午 · 反馈入口 + 新功能公告卡）

**终态**：控制面 `v1.43.0`；dev198 与 Mini VM 同为 `65a4ff92afc6`，契约 `2026-08-06.1` 双站唯一。
三提交：`7db7800`（25 文件主体）→ `29cfb3f`（按钮文案改「吐槽」）→ `65a4ff9`（失败卡收窄）。

### 🔴 控制面子树部署下，生产机跑全套测试恒 5 红——那不是回归

`node --test test/*.test.mjs` 在 `/srv/h-control/app` 恒失败 5 条（v1.42.0 时代同环境红同样 4 条）。
根因：那几条「真跑」测试用 `repoRoot = new URL('../..')` 找仓根去 spawn `control-plane/server.mjs`，
而控制面**只 rsync `control-plane/` 子树**，`/srv/h-control/control-plane/server.mjs` 根本不存在。

⚠️ **本 skill 上文那条 `node --test test/*.test.mjs && systemctl restart h-control` 是坏配方**
——`&&` 永远等不到 0，照抄等于永不重启。正确做法：**跑之前先在旧版本（站外备份目录）跑一遍做对照组**，
失败集合相同即环境性失败，手动重启；新增的红必须逐条归因到"同族"才放行。

### 部署后唯一能证明新分支跑过的东西：healthz 新字段

`bridge.mjs` 里 `if (controlClient?.enabled && …)` 这类块**单测永远进不去**。
本轮判据是 healthz 的 `releaseAnnouncements` 从缺失变 `{enabled:true,…}`。
配套：dev198 的 `runnerWorker.workerPid` 变化才证明 **Runner Worker 真重启**（不是只重启 bridge）。
970 个测试全绿 + `node --check` 全过，这两样加起来仍证明不了新分支能跑。

### 灰度前必须先算 person 去重，否则验收标准自相矛盾

12 个 H 用户**全在同一飞书租户**（tenantKey 去重 =1；unionId 有 10 个不同值）。
`rayman.chen`(owner) / `u-001422f6e5`(陈川测试bot) / `u-aca292be3f`(Mini AI 专家)
**同属 person `p-b1d55450cc05`**。公告 `perBot:false` 时同一 person 只发最近活跃的那个
——所以"给两个 Bot 各发一张"和 `perBot:false` **不可能同时成立**。
拆两张公告解决：A 用 `perBot:true` 拿两个 message_id，B 用 `perBot:false` 专验去重
（发布**前**先锁死预测，本轮两者只差 565ms，命中才算数）。详见 [[feedback_acceptance_must_be_computable_before_you_run_it]]。

⚠️ `/internal/users` 的投影里**没有 personId 字段**，别据此说"生产没有 personId"；
去重用的是 `store.list()`，真值查 `/srv/h-control/data/users.json`。

### 反馈表单权限：不要开编辑权限

`/share/base/form/<token>` 分享页**匿名浏览器可直接渲染并提交** → 用户无需任何授权。
**给多维表格开编辑权限 = 11 个租户互相看见对方的反馈内容**，是隐私事故。
验证方法：用浏览器工具真渲染一次；**HTTP 200 不能作为结论**（飞书表单是 SPA，
空壳 200 骗过判断，见 [[feedback_hollow_200_needs_payload_check]]）。

### Delivery Outbox 的存储形态

`<sha256(scope)>.v1.jsonl` —— **JSONL 不是 JSON**，`find -name "*.json"` 查不到任何东西，
且那个 0 长得和"没有记录"一模一样。事件链形如
`delivery_enqueued → delivery_attempted(attempt:N) → delivery_acked(带 messageId)`。
根目录：dev198 `~/feishu-grok-bridge/workspace/.delivery-outbox`；Mini VM `/srv/h-platform/workspace/.delivery-outbox`。

### Mini renderer 对新 env 键是透传的（已实测）

`render-mini-b2-env.mjs` 遍历**所有**键，非 override 键走 `mapSourcePath`；
URL 这类非绝对路径值只做 `127.0.0.1:10808 → host.lima.internal:10808` 替换，**其余原样**。
**无白名单丢弃**。实测锚：URL 的 sha256 穿过渲染不变，同时 `GROK_CWD` 被正确重写
（证明 renderer 真跑了而不是原样复制）——只验前者会把"没跑"误判成"透传正确"。

### 跨嵌套层传命令一律用脚本文件

`ssh → limactl shell h-b2 -- bash -lc "…"` 三层嵌套会把引号吃掉，产出 `grep: action":`
这种**坏探针**，而它的输出（空/0）与真结论同形。本轮踩了两次。
做法：本地写 `.sh`/`.py` → `scp` 到 Mini → `limactl copy` 进 VM → 执行 → 清理。

### 时间窗口判据用相对时间

dev198 是 `Asia/Shanghai`，`journalctl --since "12:08:00"` 被当作**本地** 12:08（= 04:08 UTC）。
跨机一律 `--since "-8 min"`（时区无关）；必须用绝对时刻先 `date -u` 取该机基准。
同族的 locale 坑见 [[feedback_criteria_must_match_object_variant]]。

### 需求 Base 写入流程（本轮实走）

表：`需求与问题` `tblnA4nQjXNFiu8B` / `执行记录` `tblxkoFQKfJgA0oy`；app_token 在
`/srv/h-control/.env` 的 `H_ISSUE_TRACKER_URL`（**不进 Git**）。
`lark-cli --as user api PUT …/records/<rec> --data -` 走 stdin；写完必回读。
证据字段禁写 Token / 授权链接 / open_id / 对话正文 / 表单真实地址——**写之前跑一遍禁写自检并配可命中的锚**。

⚠️ **回读 link 字段别对返回值直接 `len()`**（2026-08-08 差点误判「写漏了一条」）：
双向关联回来的形状是 `[{record_ids:[recA,recB], table_id, text, text_arr}]`
——**外层是一个包装对象**，真正的 id 在 `record_ids` 里。`len(外层)` 恒等于 1，
看起来就像只关联上了一条。这是本文主题的老形态（判据套错返回值形态），
但它出现在**回读校验**环节——那时注意力全在结果上，没人再审判据一眼。
见 [[feedback_criteria_must_match_object_variant]] 末节。

#### 2026-08-08 同步（RUN-0025）

79 → 80 条。H-0080 执行中 → **已修复待验收**（验收结论仍「未验收」；实际结果里
显式写了两条未验事项：卡还没真发过、卡面不写站点名属取舍披露）；
新建 **H-0081**「它怎么工作」白盒画板（已修复待验收）；审计条 RUN-0025 双向关联两者。
回读核对：主表 +1 = create 数、审计 +1、标题零重复、空标题零、
开放 P0 仍是 H-0076 / H-0078 两条未被误动。

### 失败卡的按钮集（川哥 2026-08-06 拍板）

失败终态卡只挂 `FAILURE_COMMAND_KEYS = {new_session, feedback}`。
原因：改动前失败卡**零按钮**，挂整个面板既超范围，且「配置/我的记忆」在失败卡上
拿不到链接会退成两跳 callback，与成功卡的一步直达不一致——**同一控件跨上下文两种行为**。
守卫：`test/f5-completion-wiring.test.mjs` 断言两处调用必须带 `only: FAILURE_COMMAND_KEYS`；
`test/feedback-entry.test.mjs` 用 `deepEqual` 断言**整个标签数组**（只 `find` 到一个就算过，
会漏掉"多塞了三样进来"，见 [[feedback_disjunctive_assertion_never_tests_the_branch]]）。

### 熔断

两站 `H_RELEASE_ANNOUNCEMENTS=0` + 清空 `H_FEEDBACK_FORM_URL`。
公告持久文件与 Outbox **都不删**，已 ACK 不重放；失败卡熔断后只剩「新会话」。
回滚文档：`docs/rollbacks/2026-08-06-feedback-release-announcements.md`。

---

## 2026-08-07 收口（H-0029 缺口 + Mini B2 部署脚本 + 合 main）

### ⚠️ H-0029 没做完：交付的是「手动群发」不是「主动通知」

需求原文：「平台**每次有明确的新功能上线时**，由 Bot **主动**发送一张更新说明卡」。
交付物把真源/领取/person 去重/Outbox/ACK/幂等全做了，**唯独没有触发器**——
「何时发」仍是人肉手写 JSON + 跑 `--confirm-publish`。

**为什么验收没抓住**：需求记录三个字段里，「修复方案」和「预期结果」都是**实现方自己写的**，
两者都已把触发条件丢掉；我逐条核的是「预期结果」，六格表全对完也漏了核心动词「主动」。
触发条件**只保留在「需求 & 问题描述」里**。
→ 判据见 [[feedback_acceptance_baseline_must_be_the_requirement]]：
**验收前先圈出需求原文的动词与限定词**（主动 / 每次 / 自动 / 明确的 / 不再采用 X），
每一个都必须有对应检查项；方案相对需求的取舍必须显式披露，没写＝声称没取舍。

**补齐设计（已定，明日实施）**：触发信号 = `BOT_BEHAVIOR_CONTRACT_VERSION`
（行为变才动它，改错别字不动；用 deploy commit 会把每次修 bug 当新功能）；
文案来自仓库内 `release-announcements/<契约版本>.json`，随代码提交与 review，
**机器绝不从 commit message 生成文案**；触发点在部署流程健康检查通过之后；
**表里没有对应版本就静默不发（默认沉默，不是默认发）**；受众必须文件里显式写，
字段不合法由既有 `normalizeAnnouncement` 抛错拒绝发布；投递链路一个字不改。

### ⚠️ `ops/deploy-sites.sh` 的 Mini 分支曾整个失效（`d1db455` 已修）

B2 割接后部署目标是 Lima VM `/opt/h-platform/app`，脚本却仍指宿主
`local/h-platform-mini-bot`——那里的 launchd label `com.hplatform.mini-bot.{bridge,runner}`
**早已注销**，宿主零进程跑它。**别只把这当"体检读错目录"**：
真跑一次部署会**先把文件写进遗留目录、把 meta 改写成新 commit，才在重启步炸**；
下一次体检读那个目录会看到"版本对上了"，而 VM 里一字节没变——
**一次失败的部署反而把体检骗过去了**。而验证通道 healthz:18775 是 VM 的 ssh 转发，
**观测不到宿主目录**，所以它永远不会替你发现。

现状：`--check` 读 VM 内 meta，遗留目录降为提示并标注不参与判定；
部署分支 fail closed，指向 `deploy/lima/` 影子→割接流程（README.md 有完整步骤）。

**Mini B2 真值（别猜）**：VM 名 `h-b2`；unit 是 `h-mini-b2-bridge.service` /
`h-mini-b2-runner.service`（**不是** `h-bridge`/`h-runner-worker`）；
`limactl` 在 `/opt/homebrew/bin/limactl`，**非交互 ssh 的 PATH 里没有**，写脚本要给全路径；
宿主 launchd 实际注册的是 `com.hplatform.mini-b2-health` / `mini-ab` / `mini-b2-lima`
——grep 时注意是 `hplatform` 没有连字符，写成 `h-platform` 会零命中且看起来像"没有"。

### 合 main 完成

`origin/main` `9119311` → `d1db455`，**纯 fast-forward** 前进 71 个提交
（`HEAD..origin/main`=0，结构上不可能有冲突）。
合 main **不动线上**：两站跟的是 `codex/h-mini-ab-poc`，`deploy-sites.sh` 里
`BRANCH=codex/h-mini-ab-poc`；合完复检两站仍 `65a4ff92afc6`（验过，不是断言）。
⚠️ 分支名仍叫 `h-mini-ab-poc` 但早已是生产主线，建议改名；
其中 **6 个提交是 `chuan` 在 dev198 生产机上直接写的**（每任务 `-m` 钉模型那批），
此前从未进过 main。

### 写 Base 时的锚

禁写自检的锚**必须与本次载荷同批构造**。本轮我沿用上一轮的锚（载荷里的 message_id 前缀），
而这次载荷只含另外两个字段 → 锚归零、按设计拦下写入。
改法：给每条禁写正则各喂一个当场造的合成正例，**逐条自证能命中**，再跑真实载荷。

### 2026-08-07 深夜：H-0029 触发器已补齐（`ccbddd3`）

`release-announcements/<契约版本>.json` **存在与否就是开关**——
`ops/announce-release.mjs` 接在 `deploy-sites.sh` 部署成功之后跑一次，查不到就静默退 0。
格式与 fail-closed 全表见仓库 `release-announcements/README.md`（那是单一真源，别在这儿抄一份）。

**跑之前必须知道的三件**：
- 触发器在 **dev198** 上跑（它有全树 + `H_CONTROL_URL`/`H_CONTROL_TOKEN`；
  控制面只收 `control-plane/` 子树，清单到不了那儿；Air 的 secrets 里没有这两个键）。
- 它拿**线上 healthz** 的契约版本与仓库 `BOT_BEHAVIOR_CONTRACT_VERSION` 对撞，
  不一致直接退 2。**部署没生效却发公告 = 对用户宣布一个他还用不上的功能。**
- 清单坏了退 2 让部署红灯，**不是**静默跳过——坏清单静默跳过等于这次上线的公告永远丢了。
  代码此时已经上线，修完清单重跑 `deploy-sites.sh` 即可，publish 幂等不会重发。

**验收状态**：③无清单静默、④三种坏清单退 2，都真机验过（配合法清单 `--dry-run` 退 0 的正例锚，
证明那些 2 是校验拦的而非"什么都跑不通"）。**①新契约版本→用户真收到卡、②重跑零重复，
要等下一次真实契约版本变更才能验**——这是设计使然，别为了验它去假造版本号。

### 分支：统一走 `main`

`deploy-sites.sh` 的 `BRANCH` 已改 `main`，dev198 已切。
`origin/codex/h-mini-ab-poc` 是 main 祖先、零独有提交，可删（待执行）。

⚠️ **在任何机器上切分支前先问「这台机器上这个名字指向哪个 commit」**。
当时 dev198 的本地 `main` 停在 133 个提交之前、与 HEAD 差 **297 个文件**，
直接 `git checkout main` 会把生产代码倒回旧版本，而 healthz 还会绿一阵子
（进程没重启，磁盘却已经换了）。安全姿势：`git branch -f main HEAD`（零文件变化）
→ checkout（纯指针移动）→ 让部署流程正常 ff-merge 前进；用 `HEAD^{tree}` 对撞确认零内容变动。
力推分支指针前先查独有提交数（`git rev-list --count origin/X..X`），为 0 才安全——
dev198 以前真的自己写过代码。

### 加了测试 ≠ 测试被跑

仓库自带 `test/test-coverage-guard.test.mjs`：`test/` 与 `control-plane/test/` 下
每个文件都必须被 `npm test` 覆盖。本轮它当场抓到新增的 `release-manifest.test.mjs`
没挂进去。新增测试文件记得加到 `package.json` 的 `test:uncovered-batch`。
测试数与基线不同时**先解释增减**：980 = 967 基线 + `65a4ff9` 净增 3 + 本次 10。

---

## 2026-08-07 上午：213 秒中断归因 + Mini 升级 + 探针 + 飞书改直连

### 事故归因：不是 xray，是裸直连；放大机制在租约

dev198→控制面**直连**断 213 秒（09:55:54–09:59:27），**同期 xray→DMIT 隧道全程正常**。
放大在 `app-placement`：续租第一次失败（T+20s）就 `lose()` → 拆掉 11 个租户的飞书 WS，
用户看到「目标回调服务当前未在线」。已修（`6defe1d`，见上一节）。
**Mini 同期只挨 1 次 fetch failed、零 lease lost** —— 两站对照是把放大机制照出来的关键。

⚠️ **那 213 秒本身为什么断，至今未知。** 已排除 xray 进程重启、内核 link 事件、控制面重启、负载。
dev198 是双默认路由（有线 metric 100 / WiFi 600），上行不可达时内核不报事件、路由也不自动切——
这是最像的猜测但**没有证据**。靠 `h-egress-probe` 等下次。

### 读日志前先确认 unit 层级

**xray 在 dev198 是 user unit。** `journalctl -u xray`（系统级）只给 1 行、锚也是 1 行——
我据此正确地拒绝下结论，但**停在了「通道是死的」**。`journalctl --user -u xray` 有 5530 行，
关键证据就在里面。**锚归零之后必须再追一层：权限？unit 名？还是 user/system 层级？**

### 进程标识向服务管理器要，别用 pgrep 猜

验证 NO_PROXY 时我用 `pgrep -f "node .*bridge.mjs" | head -1` 取 PID，读出「改动没生效」，
**差点回滚一个成功的生产变更**。真值：

```bash
MAIN=$(systemctl --user show feishu-grok-bridge -p MainPID --value)
```

bridge + runner-worker + 正在退出的旧进程同时在，`pgrep | head -1` 返回哪个纯看运气。

### 出网路径：每个 HTTP 客户端各一条，不是每个服务一条

| 客户端 | 读 proxy 环境变量？ |
|---|---|
| node 内置 `fetch`（undici，Node 22.17 实测） | **不读** |
| `axios` / `ws`（lark-sdk 用） | 读 |
| `curl` | 读 |

所以**「用 curl 测出来快/慢」不代表 bridge 的行为**——那是两条不同的路径。
我先按旧记忆假定 bridge 走代理，提了「kidshub.cn 加进 NO_PROXY」的修复，
**那是纯空操作**，还拿 curl 的 0.16s vs 3.3s 给它背书。是死端口反证把它拦下来的：
全套 proxy 变量指向 `127.0.0.1:59999`，node fetch 仍 200，而同组变量下 curl 退 7（反向锚）。

### 飞书流量改直连（`f82cc50`）

dev198 的 `NO_PROXY` 加 `.feishu.cn`。**这不是新决策**——6/22 就拍板「飞书统一直连」，
只是六周没传到 dev198（7/31 那份 drop-in 是为修另一个故障写的，没回头问该不该走代理）。
收益实测 **15–25 倍**（直连 0.05–0.10s vs 经 xray 1.2–1.4s），飞书占该机代理流量 **56%**。

**验证判据用连接去向，不用环境变量字面值**：

```bash
MAIN=$(systemctl --user show feishu-grok-bridge -p MainPID --value)
ss -tnp | grep "pid=$MAIN,"        # 经 127.0.0.1:10808 的应为 0
```

实测：14 条 ESTABLISHED，经代理 **0**；xray 里 `open.feishu.cn`=0 而 grok/x.ai=7（锚）。

⚠️ **反直觉的一面**：两次事故各打一边——7/31 代理断→飞书挂；8/7 直连断→**飞书恰因走代理而幸存**。
飞书直连换掉了一条冗余路径，兜底靠 WS 自动重连 + 租约宽限 + Outbox + 探针。回退=删一行+重启。

**未覆盖**：grok CLI 子进程（含飞书 MCP）仍走代理，要收干净得改 xray 路由并重启 xray（挑无任务窗口）。

dev198 的 systemd drop-in 已纳入 `deploy/dev198/systemd/`——**真源仍是机器，只准回抄不准反推**
（线上修复常先落机器，反推会抹掉正在生效的修复）。

### Mini B2 升级实战补充（`65a4ff9 → c62485a`）

- preflight 首轮 **9 绿 1 红**：红在 AI 专家 `lastError` 残留。**成功送达会自动清零**——
  让川哥发一条消息即可，不必豁免判据。
- 中断：回迁 ~20s + 割接 ~14s（上次 90s 事故的 `NODE_BIN` 护栏这次生效，没重演）。
- `verify-mini-b2-active --skip-long-task` 得到 `status=partial`、`healthChecks 16/16`。
  **partial ＝未验，不是不合格**；longTask 层需真机 ≥130s 任务。
  **当日 13:40 已补验为 `status=complete`**（三层全真、健康 16/16、长任务 10/10；
  13:36:48 入站 → 120.004s 转后台 → 201.3s 完成）。
- ⚠️ marker 真路径是 `/srv/h-platform/config/mini-b2-enabled`（我一度猜成 `.mini-b2-active`，
  回迁那步碰巧结论正确、割接后才被验证器照出矛盾——**以验证器为权威**）。

#### 造一条能过 longTask 层的真机任务（2026-08-07 实走，两个前置条件在源码里）

两条都是**查源码定的，不是试出来的**——试错会得到「跑了 3 分钟却还是 false」这种无信息的失败：

| 前置 | 真值 | 出处 |
|---|---|---|
| 必须**单聊** | `chatType !== 'p2p'` → `yieldMs = 0`，群聊根本不进 yield 分支 | `bridge.mjs` 的 `bgYieldMsFor()` |
| 必须**明显跑过 120s** | 窗口 `H_BG_YIELD_MS` 默认 `120_000`；两站均未覆盖（查进程 env + env 文件双证） | 同上 + 验证器 `thresholdMs=120_000` |

⚠️ **发出去后不能再补消息**：转后台是 `120s 定时器` 和 `新任务信号` 的 `Promise.race`，
中途再说一句会以 `reason=new_task` 提前触发，`elapsedMs < 120000` → 该次作废。

可直接给川哥粘贴的任务（4 轮 × `sleep 45`，实测 201s，稳过）：

```
分 4 轮做一次只读的运行环境自检，每轮之间必须真实等待 45 秒，全程真实耗时不少于 180 秒。
不许把等待合并、不许模拟等待、不许提前收尾。
每一轮：① date '+%H:%M:%S'; uptime  ② sleep 45
四轮跑完后把时间戳与负载列表回报，并给出首轮/末轮时间与实际总耗时（秒）。
约束：全程只读，不创建/修改/删除任何文件（含任务日志），不调用 lark-cli，
不输出绝对路径、凭据、用户 ID 或 App ID。
```

⚠️ **升级后必须重验，别拿旧版本的验收当数**：8-05 割接时长任务层就绿过一次，
但 8-07 升级到 `c62485a` 后**到这条任务之前该版本零任务样本**——
「这个能力验过」与「**现在这个版本**验过」是两件事，`.deploy-meta.json` 的
`deployedAt` 与服务 `ActiveEnterTimestamp` 就是分界线。查一句
`--after <重启时刻>` 返回「没有找到符合条件的飞书入站任务」即可判定。

排查用法：`scripts/verify-b3-long-task.mjs` 的 stdout 是 JSON、stderr 也可能是 JSON，
**外层 `verify-mini-b2-active.sh` 把子验证器 stdout 重定向进临时文件**，
所以外层非零退出时你**看不到那份最有用的 checks 明细**——直接调子验证器看。
选任务的逻辑是「`--after` 之后、`source=feishu`、按 ts 倒序取第一条」，
所以它永远只看**最近一条**，把 `--after` 往前放并不会翻出更早的样本。

## 公司 AI Ontology 基座复用边界（2026-08-07）

当 H 平台被接入公司 AI Ontology 基座时，采用同一代码库的 `company-qnap-lite` 部署 profile，在 QNAP 同机运行 **公司级 Bot H-Lite + Company Agent Core**。现有员工私人 Bot 继续由当前 H 平台运行，不迁移、不切换 Consumer。H-Lite 只作为公司级 Bot 的 Bot / Subscription / Delivery Layer，不能被提升为业务真源或超级管理员 Agent。

H-Lite 可直接复用：飞书 WebSocket 订阅、Bot Bridge、精确 scope 授权卡片、device-flow 自动续跑、Company Front-door profile、Delivery Outbox、Feishu ACK/读回、Task Session Log、提醒、任务恢复和 Agent Core Adapter。必须使用现有 H 代码与统一 `behaviorContractVersion`，禁止复制形成长期 fork。

生产订阅约束：新建独立公司级飞书 App/Bot，由 QNAP H-Lite 作为其主消费者；Mini/dev198 等公司 Bot 备用实例只能通过 lease/fencing 作为 standby，禁止双消费、双回复和双写 Outbox。员工私人 Bot 的原 App 和原 Consumer 不受影响。

必须新增并强制经过：

- `Ontology Service`：目标、P2、任务、决策、ERP、社媒、成果、证据的公司语义真源。
- `Permissioned Retrieval Gateway`：先算用户/部门/项目/密级权限，再检索并组证据包。
- `Company Agent Core`：部署在 QNAP，通过 H 引擎执行，是全员 Agent 的唯一逻辑主实例。
- `Task Proposal Compiler`：只生成任务图和个人任务草案，经 DRI 批准后再交 H-Lite 投递。
- `Mandatory Action Gateway`：Runner 只能提交 Action Intent；写 ERP、飞书、Git、报表必须 dry-run、人审、执行、读回校验、审计和回滚。

集成红线：

- 全员 `Company Front-door Agent` 只做接待、澄清、意图分类、路由、证据摘要和任务状态解释，不直接持有全库权限。
- Runner 不直接查全量 Ontology、ERP、社媒或飞书文档。
- Runner 不直接写业务系统；stdout 成功、进程退出 0、Feishu ACK 任一单点都不等于业务完成。
- H-Lite durable store 只保存 append-only 投递/运行事件；公司任务状态从 P0 起由 Ontology/Postgres + `tenant_id` + RLS 单写。
- 不共享 H 引擎 HOME、memory root、MCP 凭据和日志给不同安全域；底层 Provider 实现不得成为跨域共享入口。

完整方案见 `company-ai-ontology` skill 与飞书文档《公司 AI Ontology 基座架构方案 V2.2》：
`https://futurus.feishu.cn/docx/Xd3qdCtmXogh0rxmEhDc8pL1nub`。

## Company H-Lite 通讯录同步运维（2026-08-08）

公司 Bot 使用独立飞书 App，由 QNAP `company-qnap-lite` 负责订阅和投递。通讯录同步是服务身份后台作业，不是员工对话能力；员工私人 Bot 和原 Consumer 不迁移、不切换。

运行入口：

```bash
node ops/sync-company-directory.mjs
```

运维与验收顺序：

1. 分别确认 API Scope、通讯录数据范围和应用可用范围，不能把三者混为一个授权状态。
2. 从飞书返回的授权入口递归展开部门，再同步可见人员；只看顶层部门会漏人。
3. 只允许 `company-directory-sync` 服务身份通过 HMAC 内部接口写入 Principal；普通员工身份必须返回 403。
4. 连续执行两次：第二次应只更新现有人员，不重复创建；当前策略不自动禁用本轮未出现人员。
5. 检查入库字段仅含姓名、飞书身份、部门和启用状态；邮箱、手机号、私聊正文与私人属性命中必须为 0。
6. 完成后复验 H-Lite 飞书 WebSocket 在线、Agent Core/H-Lite 版本、健康探针和 `restart_count=0`。

2026-08-08 生产锚点：4 个授权入口递归展开为 83 个可见部门，414 名可见人员首次新增 414；第二次新增 0、更新 414；普通员工同步负测为 403。该数字只代表当日权限快照，后续运维应以实时 API 结果为准。

知识检索红线：公司 App 能读到文档不代表当前员工能读。H-Lite 不直接把文档正文交给 Runner；必须由 Permissioned Retrieval Gateway 根据当前 Principal 和文档 ACL 生成 `Permissioned Evidence Package` 后再进入上下文。

## Company H Engine Worker 运维（2026-08-08）

公司 Agent Core 可通过 HMAC 调用独立 `company-h-engine-worker`，但该 Worker 不得成为员工私人 Bot Runtime 的别名或共享会话入口。

当前生产模式：

- `credentialMode=cpa-api-key`，Worker 继续运行 Grok Build CLI，通过独立自定义模型配置调用 CPA OpenAI 兼容入口。
- 使用 `H_ENGINE_WORKER_HOME=/srv/h-platform/company-agent-home`、独立 `GROK_HOME` 和 Workspace；CPA Key 只在 dev198 0600 环境文件中，禁止复制到 QNAP。
- Grok Build 本地模型别名与上游模型 ID 必须分离，例如 `cpa-grok-4-5 → grok-4.5`；同名会优先命中内置 xAI 模型。
- 必须使用独立 Workspace、最大并发、单轮执行、超时/输出上限，并禁用 Web Search、Memory 和 Subagent。
- Prompt 通过 0600 临时文件传递，完成、超时或失败后都要删除。
- `/readyz` 与推理结果必须同时报告 `provider`、`model`、`credentialMode` 和 Worker 版本，但不得报告 Key。
- 切换不迁移、不重启、不修改员工私人 Bot Consumer；回滚只恢复 Worker 的配置和备份。

知识链路验收补充：ACL 正确与召回正确分开验证。中文自然问句应证明 Evidence 实际命中；无权限 Principal 必须 Evidence 为零，且合成验收数据结束后删除。

## Company Ontology 公网看板运维（2026-08-09）

- 公司 Ontology 看板复用 `ai.kidshub.cn` 的 H 控制面管理员认证，路径为 `/admin/company-ontology`；不得单独新建无认证站点或把 QNAP 端口直接暴露公网。
- 控制面环境变量 `COMPANY_ONTOLOGY_STATUS_BASE_URL` 只允许指向回环地址。当前标准链路为 aliyun-hk `127.0.0.1:19180`，由 Mini LaunchAgent 维护反向 SSH 到 QNAP `192.168.61.18:19080`。
- 发布顺序：先更新并验证 QNAP Caddy 固定健康路径，再安装/重启 Mini 隧道并从 aliyun-hk 逐条读回，最后备份和发布 `/srv/h-control/app`、升 `H_VERSION`、重启 `h-control`。
- 控制面部署后按调试前置检查核对单进程、systemd 环境、Nginx 双侧配置、`18790/19180` 监听和真实服务日志；不要把发布脚本的一次瞬时 curl 失败直接当成服务故障。
- 真机验收使用管理员 Cookie 走真实公网 HTTPS；除 HTTP/API 断言外，还要检查页面标题、运行状态、控制台错误、横向溢出和绿色/灰色节点。favicon 等无业务影响的 404 也应清零，避免掩盖真实前端错误。
- H 控制面 `v1.53.0` 已增加 WorkCase 时间线、Evidence Map、Answer Basis、Decision Lineage 和三层结果，必须展示 Agent Core、Schema、Work / Practice Protocol、模型真值、最近 WorkCase 与 Goal Verified 数量。
- 管理员密码、Cookie、Key 和其他 secret 禁止进入 Playwright 命令参数、工具输出、截图、日志或仓库；浏览器自动化必须采用不回显的凭据输入路径。
- 当前页面生产验收基线为 9/9 组件就绪、P0-DEC 标绿、Practice active、Goal Verified 至少 1、失败 Lineage 显式 `retired`、浏览器控制台错误 0、失败请求 0、`scrollWidth == clientWidth`；任何一项失败都不能只凭 API 200 判定上线完成。
- 控制面不得把失败 Canary 长期显示为 `plan_pending` / `execution_pending`。失败 WorkCase 保留审计，但 Decision 已 superseded 时必须显示 `retired`，且不能计入业务待办或正式 P2 成功数。

### H v1.56.2 生产源码漂移修复（2026-08-10）

- **版本标识不是源码证明**：生产 `/healthz` 曾报告 `v1.56.1`，但 `company-ontology-dashboard.mjs` 与 `company-ontology-whitebox.mjs` 仍是 UAT 修复前文件。以后必须从已推送 Source Commit 打包，并在重启后对账版本、目标文件 SHA-256、API DTO 和真实 DOM。
- **禁止同版本静默覆盖**：发现版本标识与生产文件不一致时，升补丁版本形成新发布事件。本次从漂移的 `v1.56.1` 修复到 `v1.56.2`，回滚锚为 `/srv/h-control/backups/20260810-145600-goal6-v1562`。
- **重启授权不跨组件继承**：QNAP Domain/Agent 发布授权不包含 H 控制面。必须单独说明只重启 `h-control`、正常中断和异常回滚窗口，并取得当前明确授权后执行。
- **发布验收真值**：本次 systemd 停止与启动发生在同一秒，完整发布流程 29 秒，`NRestarts=0`；真实 Chrome `92/92`，34 条光晕位于彩线下层，运行真值、卡片点击、平移缩放、焦点、错误请求和横向溢出全部通过。
- **发布脚本门禁**：提交必须已推送且发布工作树与 Source Commit 一致；暂存子树测试、生产环境文件属主/权限、管理员登录、公网健康、服务稳定期和失败自动回滚缺一不可。
