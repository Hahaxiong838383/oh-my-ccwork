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
6. **改 html.mjs 必跑 script 语法门**：模板字符串会把 `\n` 先解析成真实换行 → 输出的 JS 字符串字面量断行 → **整个 script 块静默不执行**（页面正常、console 无报错、按钮全失灵）。源码里写 `\\n`；改完跑「必跑检查」里的 script 块语法检查（[[feedback_template_string_swallows_js_escapes]]）。**加弹层/fixed 组件还有第二道**：`.pane.on` 这类祖先的动画 fill 若用 both/forwards 会固化恒等 transform，静默把 fixed 的包含块从视口劫持成 pane（v1.37.0 真机抓到，fill 已去掉别加回来）；弹层上线前在真实页面断言 `getBoundingClientRect≈视口`（[[feedback_fixed_position_hijacked_by_ancestor_transform]]）。
7. **推代码前查实时分支**：历史上部署主干曾在 `origin/feishu-grok-bridge`，但 2026-07-27 已确认 GitHub 当前生产主干是 `origin/main`，旧分支落后。每次先跑 `git fetch origin && git rev-list --left-right --count HEAD...origin/main`，不要把历史记忆当现状。
8. **健康读数认实例**：bridge `/health` 的**顶层字段是 owner Bot 的**，用户 Bot 在 `apps.<appId>` 里。查「某用户的消息到没到」必须看 `apps` 分解——2026-07-25 我拿顶层 `lastInboundAt:null` 断言「一条没收到」，实际用户 Bot 那条准时到了（[[feedback_selfcheck_false_signal]]）。
9. **远程语法检查用绝对路径**：dev198 非交互 ssh 的 PATH 没有 node，`node --check` 会「命令未找到」而静默略过；结论行必须由累计变量驱动，绝不无条件 `echo 全过`。
10. **Kimi 通道名不能混**：开放平台模型是 `kimi-k3`；Kimi Code 订阅的 CLI alias 是 `kimi-code/k3`，其 provider model 是 `k3`。桥接层必须使用订阅命名，不能把开放平台名字直接塞进 managed provider。
11. **锁模型而非信默认值**：Kimi 配置生成和 Runner 必须共用 `lib/kimi-model.mjs`；Runner 每次显式传 `--model kimi-code/k3`。只改 `default_model` 不算完成。
12. **真任务归因到真引擎**：用户要求“由 Kimi 完成”时，Codex/cc 只做编排、权限、送达和验收；业务结论必须来自真实 `createKimiRunner`。验收证据同时看 trace 的 `engine/model/providerModel`、真实回复和飞书 message_id。
13. **验收必须由每个 Bot 主动闭环**：任意用户 Bot 的功能修复或优化都视为全平台变更。发布后必须遍历所有登记用户及其全部 Bot，直接使用各 Bot 的真实 Runner 发起验收，并由每个 Bot 主动把完成结果送到其绑定 open_id；禁止把“请用户再发一次测试”、等待用户回复“继续”或另行触发当作验收步骤。若权限不足，禁止只发文字报错，必须主动发送带“去开通权限”按钮的权限申请卡；只有外部平台明确要求用户本人确认、扫码或不可代理授权时，才让用户完成该动作。授权完成后仍由 Bot 自动续跑、主动汇报，不要求用户再发消息。每个 Bot 都必须留下真实 trace 与飞书 ACK/message_id，漏掉任何 Bot 都不能宣称全量生效。
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

## 架构

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
而沙箱里**跑不了 hooks**——实测全租户 `observations` 表都是 0 条，所以默认作用域
永远解析不到任何东西。`lib/memory-routing.mjs` 的 `SCOPE_BLOCK` 就是为此存在。

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
| `u-aca292be3f`（AI 专家） | dev198 上没有 ai-memory 实例 | **设计如此**：B1 灰度已迁 Mini，Mini 侧 `H_USER_MEMORY=0`、ai-memory 未原生化。等 Mini 记忆 parity 做完才会有 |
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
2. **四份文档必须互相可导航**：每份文件都维护 `h-profile-index`，说明四类文件路径、
   内容归属和冲突处理。用户平台展示可编辑正文与索引，但必须剥离 `h-soul`、`h-global`、
   `h-rules`、`h-method`、`h-mem` 等运行镜像，避免用户编辑平台生成副本。
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
