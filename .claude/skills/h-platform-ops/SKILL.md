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
- **部门当前读不到**（姓名可以）：owner Bot 的 `contact:user.department:readonly` /
  `contact:department.base:readonly` 都是 **user 档**（tenant_access_token 用不了），
  且通讯录范围只覆盖 4 个部门。给 owner **一次性**补 tenant 档权限 + 放开范围后，
  代码无需改动即自动生效。读不到时管理台标「**待认领**」，可手填。
  中文部门名进不了 skills 层名正则 → slug 走稳定哈希 `d-<hash6>`，展示用 `orgLabel`。
- **开通意图签进 token**（HMAC JSON payload），篡改/过期照旧拒；旧格式链接仍兼容。
- **显示名自动取**：注册验活后调 `bot/v3/info`（tenant_token 即可）拿 `app_name` = 用户建 Bot 时起的名字，写进 `user.name`，控制台主显示；拿不到回退账号名。
- 生成链接后弹层给**整段可转发说明**（链接+两步+隐私），双按钮复制。
- **显示名兜底**：注册那刻 Bot 可能未就绪取不到 app_name（真机遇到过）→ fetchBotProfile 内置重试 + **管理台每次加载后台补齐**「name 仍等于账号名」的用户（每 uid ≤3 次）。所以名字晚几分钟才出现是正常的。
- ⚠️ `bot/v3/info` 的 `open_id` 是 **Bot 自己的**，≠ 消息白名单用的**用户 open_id**（注册回调 `user_info.open_id`），别互相覆盖。
- 自动开通失败（uid 冲突等）→ 降级到「待关联 Bot」老路径，注册页提示联系管理员，Bot 不丢。
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

## 一键打开后台（卡片按钮，v1.4.0）

- `/go/<token>`：HMAC 签名、**7 天、可重复点**。magic link 是一次性 10 分钟的，
  卡片会长期躺在聊天记录里，用它点开就是「已失效」——所以另起一套。
- 固定落 `/dashboard`，**不接 `next` 参数**（省掉开放重定向一整类问题）。
- 「配置」命令已改为带按钮卡片；发卡失败自动降级为带链接纯文本（仍可点）。

## 管理台 + 热加载（P2，2026-07-24）

- **管理台** `ai.kidshub.cn/admin`（ADMIN_PASSWORD in 控制面 .env）：用户表(引擎/绑定/在线态)+激活/停用/切引擎+待关联 Bot 一键关联+签注册链接。**控制面 store = users 的 source of truth**。
- **B1 热加载**：bridge 5s 轮询 users.json mtime → 增删/切引擎 App 免重启（`hot-reload start/stop/restart engine` 日志）。owner 永不动。
- **A1 同步器**：bridge 15s 拉 `/internal/users` → 合并本地 users.json（控制面为准、保留本地独有 uid）→ B1 热加载。**管理台点一下 → ≤18s 自动生效**。
- 排障：切引擎/激活不生效 → 查 bridge `user-sync`/`hot-reload` 日志 + 控制面 store `active` 字段；`H_USER_SYNC=0` 退回 h-user 本地管理。
- **owner 零影响铁律**：热加载/同步器 `kind==='owner'` 全 skip，owner App 逐字节不变。

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
# 控制面改了 html.mjs 必跑：渲染出的每个 <script> 块做真实语法检查
# （模板字符串会吃掉 \n，导致 JS 字面量断行 → 整块静默不执行，console 无报错）
node --input-type=module -e "import('/srv/h-control/app/lib/html.mjs').then(m=>{
  const pages=[m.adminPage({users:[],unlinkedBots:[],skills:[],orgs:[]}),m.dashboardPage({uid:'u'},{}),m.registerPage('t',{}),m.adminLoginPage()]
  let bad=0; for(const h of pages) for(const b of h.matchAll(/<script>([\s\S]*?)<\/script>/g)){try{new Function(b[1])}catch(e){bad++;console.log('FAIL',e.message)}}
  console.log(bad?'有语法错误':'script 块全 PASS')})"
# ⚠️ dev198 非交互 ssh 的 PATH 里**没有 node**，不加绝对路径会「命令未找到」而静默跳过检查
ssh dev198 'cd ~/feishu-grok-bridge && export PATH=$HOME/.local/node/bin:$PATH && for f in bridge.mjs lib/*.mjs; do node --check $f; done'
ssh dev198 'curl -sS http://127.0.0.1:18765/healthz | python3 -m json.tool'      # connected:true
ssh aliyun-hk 'curl -sS https://ai.kidshub.cn/healthz'                            # 控制面
```

## 关键文件与记忆

- 项目记忆 [[project_feishu_grok_h_byos]]（拍板/账号三层/分层/验收协议全量）
- 控制面源码 `dev198:~/feishu-grok-bridge/control-plane/`（部署到 aliyun-hk `/srv/h-control/app/`）
- 通道 SOP `mycc/4-Assets/SOP/dev198-feishu-grok-channel.md`
- P2 全收 + 4567 全收（市场搜索/org UI/用户 dashboard/L1 双审批/UI 重设计）
- v1.4.0（2026-07-25）：通用开通链接（管理员零填写）+ union_id 身份接力（真名自动）+ 权限授权卡片 + 一键开后台按钮 + 版本号
- 余：**给 owner Bot 补通讯录 tenant 档权限**（补完部门自动生效，一次性）；Ryan 开通（等扫码）；ClawHub 暂缓（需扩白名单不值当）
