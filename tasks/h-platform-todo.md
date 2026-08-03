# H 平台后续 TODO（持续更新）

## 2026-08-03 19:1x 当前真值

> 本节覆盖下面的 17:1x 及更早快照；历史章节保留用于追溯，不能再当当前运行状态。

### 已确认上线

- **租户可靠性 P2 已双站上线**（契约 `2026-08-03.5`，bridge `e548228`，机制项
  `user_identity_strict_mode` + `read_coverage_guardrail` + `scope_reauth_self_serve`）：
  ①P2a 身份硬约束——全租户 lark-cli 钉 `strict-mode=user`（重启后 9 租户全部落位）
  + wrapper 拦 `--as bot`/策略修改 + `--as` 值入审计（翻案：旧「0 条 --as bot」
  方法学不成立，wrapper 原不记 flag 值）；②P2c 读全量护栏（H-0070）——wrapper
  捕获 has_more/count 补 meta 审计行 + stderr 当场提示 + 事实行披露 + Stop hook
  第三判定（列表读停在 has_more=true → block，search 不拦）；③P2b 自助重授权——
  对账卡「重新授权」按钮 + 200/批链式设备流（飞书上限实测 250 过/350 拒）+
  `ops/push-scope-card.mjs` 批量推送。**token 实测**：owner 164→500、产品专家
  171→513、测试 bot 148→241（授权累积不丢老权限）。真机验收：--as bot 拒绝、
  真读 stderr 提示+meta 行、部署版 Stop hook 拦截/放行、终形卡真发送达。
  卡片 400 修复：2.0 已废弃 `tag:'action'`，按钮直放 body.elements。
  **P2b 尾巴（川哥指示先等）**：王宣凯(2批)/南鸽(3批)卡已推待点 → 复扫出新对账
  → 越权域后台清理复验 → 「应用未配置」户刷新 tasks/飞书权限开通.md。
  ⚠️ 部署重启会杀在途授权流（17:57 真机撞过一次）——部署前在途清单必须含
  `lark auth flow started` 无终态的流。**H-0070 护栏已落地，可走验收关单流程。**
- **租户可靠性 P1 已双站上线**（契约 `2026-08-03.4`，bridge `b2d3249`）：Stop hook
  验证门全租户下发（写后未回读/零调用交付声明→CLI 收尾前 block 喂回自纠，三轮
  真机对抗收敛：诚实改口/主动要参数/强制回读带真实值）+ proactive 链路补审计
  事实行 + 读写分类词尾泛化（修 +record-batch-update 盲区）。真机测试误写生产表
  H-0070 标题已恢复原状（全表零残留）。**H-0070（读表没读全）对应读全量护栏
  排进 P2，勿提前关单。**
- **租户可靠性 P0 已双站上线**（契约 `2026-08-03.3`，bridge `fd08a1c`+勘误
  `6037f41`）：①softMax 5MB→2MB（真实流量已触发 `soft=2097152` 轮转）②交付
  声明门禁（零调用+「已完成」→披露「未调用任何飞书命令」反证行，三分支真机/
  流量验证全齐）。**P3 根因定位完成**：沙箱内 hooks 完全可用，「跑不了」系误诊
  （真因=配置从未下发），源码注释与 SKILL 已勘误。队列：P1（回读 wrapper+Stop
  hook 验证门+proactive 链路补门禁）→ P2（身份/scope 审计）→ P3 后续（租户
  HTTP hooks 下发+SCOPE_BLOCK 退役）。详见 SKILL「租户可靠性施工 P0-P3」节。
- **新会话单卡状态机已双站上线**（契约 `2026-08-03.2`，机制项
  `new_session_live_status_card`，bridge `508a623`）：点击 0s 出 ⏳ 状态卡 →
  CLI 真启动 patch 🚀 → 成功同卡收敛 ✅（`updateCard`=im.message.patch）；失败
  ⚠️+新消息强提醒。双站真机各一轮三段流（Mini sid=e45d1e80 / dev198
  sid=6e6d375a），三类 card fail 日志全零，部署零打断（在途对账前后恒 4）。
  川哥拍板：本次体验增强**不发全员通知**。
- 新会话真实 CLI 执行（契约 `2026-08-03.1`，机制项
  `verified_new_session_command`）：`fe8f0c1` 主修复 + `44b3ac2` H 引擎文案统一；
  `main` 保持 `9119311` 未合并。
- 真机验收四轮全过（Mini AI 专家 ×3 + dev198 川哥测试 Bot ×1）：RPC 三态、
  CLI child、map 切换（reason=card_new_cli）、reset marker 时序、旧上下文清空。
  全员升级通知 12/12 送达（逐条 message_id）。
- **面向用户文案统一「H 引擎」**（川哥拍板）：新会话交互不再出现 Grok/Kimi 字眼。
- **aliyun-hk 控制面 `v1.38.1`**（2026-08-03 12:0x 上线，bridge 仓 `5c89d49`）：架构画板
  连线四向端口+正交避障+圆角+halo，选中节点上游蓝/下游紫/无关降透明/关联线顶层，
  抽屉「直接关联」可导航；快照 schemaVersion 4（边带 path/points/fromSide/toSide）。
  生产验收全过：API 4/28/38/18/8、38 边零穿越（真机数值复核）、控制台 0 错误、
  「SSE 断开→轮询兜底」真机触发验证；备份 `/srv/h-control/app.bak-20260803-115324`
  验收通过后可清。系统架构 Tab 漂移告警链 v1.38.0 起已真机验证。
- dev198 11/11 + Mini 1/1 connected，deliveryOutbox 0/0；双端 bridge+runner-worker
  已于本轮部署同时重启（dev198 10:02:11 / Mini 两轮）。
- ⚠️ 遗留：dev198 10:02 部署打断一条在途任务（川哥本人 09:57 发 owner Bot 的
  任务管理指令，orphan `9cc13a22…`）——川哥拍板自己重发 + 自行通过 owner bot
  cancel 该 orphan；其余 2 个 orphan 为 7-30/31 历史累计。

### 飞书需求看板现状

2026-08-02 22:1x 用 user 身份全表盘点（64 条）并在写后回读；22:2x 按川哥拍板完成
口径统一与 v1.38.0 补录（全表变为 65 条）：

- **开放记录 30 条：P0=0、P1=8、P2=15、P3=7**（H-0048 于 22:00 关闭后 P0 清零）。
- **关闭态口径已统一为「验收通过关闭」**（川哥 2026-08-02 拍板）：旧 32 条「已关闭」
  + 2 条「验收通过」共 34 条已批量迁移，34/34 逐条 updated 判成 + 回读对撞。
  开放视图筛选已原位更新为 `状态 disjoint [已关闭, 验收通过, 验收通过关闭]`
  （旧值保留在排除列表防残留；**顺序铁律：先改视图筛选再改记录**，反了 34 条会
  涌回开放视图）。旧选项「已关闭」「验收通过」保留不删（历史兼容）。
- 状态分布（全表 65）：验收通过关闭=35（含 H-0066）、已修复待验收=5、
  已排期=12、待确认=4、执行中=4、新反馈=4、空状态=1。
- **H-0048 已关**：川哥真实设备视觉验收通过；防复发监控 `ops/h-entry-watch.py` 上线
  本机 launchd（`com.cc.h-entry-watch` 每 5 分钟三层探测+飞书分层告警），运维说明见
  h-platform-ops SKILL「H-0048 入口防复发监控」节。
- H-0027 已用当前行为契约 `2026-08-02.5` 完成双测试 Bot、8 个真实长任务公平调度复验，
  Base 已写为“验收通过 / 通过”并退出开放视图。
- **待验收 5 条已排进队列**（川哥 2026-08-02 确认；需逐项真机验收才能关，改状态
  不能代替验收）：H-0011/H-0053/H-0055（Base Intake Worker 系列）、H-0037
  （分层记忆体系）、H-0059（全租户 skills 与规则生效性对账）。
- **v1.38.0 已补录为 H-0066**（recvr9iwRDNWTW，2026-08-02 川哥拍板）：类型=需求、
  P1、来源=项目规划、状态=验收通过关闭、验收结论=通过；Commit=bridge ee53a55
  （主）+ 61483f3 + 65e14c4，版本真源 `control-plane/lib/version.mjs`。
- H-0065 只有编号与 P2，标题/状态为空；未获明确指令前不删除、不复用。
- H-0031、H-0051、H-0054 已验收关闭，不再列入开放视图。

### 当前推荐执行顺序

1. ~~H-0048 最终视觉验收与防复发闭环~~ **已完成（2026-08-02 22:00）**：视觉验收过，
   入口监控上线值守。
2. **系统架构 Tab 二阶段**：增加代码/路由/服务未登记漂移门、架构历史 Diff 和异常主动告警，
   防止静态 Registry 随代码演进变旧。
3. **H-0057 Mini B2 物理隔离割接**：Lima+bwrap POC 已通过，下一步完成执行面、数据面、
   开机自启、越界/资源竞争及 A/B 对等验收。
4. **签名 tenantContext + Mandatory Action Gateway 生产接线**：把 Mini B0 的签名、策略、
   短期凭据和动作门接入真实飞书工具链。
5. 待验收清库（**已排队**，川哥 2026-08-02 确认）：上面 5 条「已修复待验收」
   逐项真机验收后按新口径「验收通过关闭」关闭。

### 本批预期结果

- 项目 TODO、飞书需求看板、Git/线上运行态不再互相漂移。
- H-0027 已由当前 `2026-08-02.5` 行为契约和双进程架构重新产生真实 Runner、容量等待、
  TaskSessionLog、Outbox、飞书 ACK 与主动完成卡证据，不再依赖 7 月 30 日历史证据。
- 验收失败时不自动改 Base 为完成；保留失败结果和日志，先修复根因，再重新由 Bot 主动验收。
- 不触碰同事 Bot、owner 工作区、凭据、用户数据、Mini placement 或现有控制面功能。

## 2026-07-31 05:0x 历史快照（仅追溯）

> **线上终态**：控制面 **`v1.35.1`**（aliyun-hk `/srv/h-control/app`）/ 全 Bot 行为契约
> **`2026-07-30.3`** / bridge+runner-worker 双进程（dev198 user 级 systemd）/ dev198 git
> 已入账追平 `origin/main` = **`c1ee539`**（双向差 0/0）。全量测试 0 fail。
> 07-31 凌晨那一轮**只留下 `c1ee539` 一个改动**（任务级注入），动作门与审计全量
> 已整体 revert（`e6a01ff`）—— 详见 **H 章**。
> 当前登记用户 **9 人**（含 21:14 新注册的 `u-9a037b10f7`）；全租户对等巡检
> `ops/tenant-parity-audit.mjs` 每小时自动跑（user timer `h-tenant-parity.timer`），
> 最近一次 **9/9 用户 + 共享层全绿**。详见 G 章。
> （历史基线：`v1.33.1` / 契约 `2026-07-30.1` / `4e60dd7` / 测试 377/377）
> ⚠️ **重启矩阵**：改 `sandbox.mjs`/`grok-runner.mjs`/任何 Runner 侧共享 lib，
> **必须 bridge + runner-worker 两个都重启**（真实 Runner 在 `runner-worker.mjs:84`）；
> 只重启 bridge = 静默失效零报错。改控制面代码/`data/*.json` → `restart h-control`。
> **实测基线**（cc 07-30 11:2x–12:0x 亲验）：9/9 Bot 在线、契约唯一值 1 个、bridge
> 全量 369/369、Delivery Outbox pending 0、`grants` 持续增长（真实流量）、
> orphan compute=1（设计内保守标记，Recovery 实见两次成功重放）。
> **真值备忘**：healthz `127.0.0.1:18765`；`systemctl --user`；控制面代码在 `app/` 子目录。

## 📌 做记忆 / 自进化优化前必读

**[`h-platform-memory-write-gates.md`](h-platform-memory-write-gates.md)**（2026-07-31，方案未实施）
—— 记忆写入路径的五道提交门 + score-before-update，源自论文 arXiv 2607.26598
Living-Harness。**cc 与 codex 同看**，动 `memory-capture.mjs` / `captureExchange` /
自进化相关代码前先读，避免重复走一遍已经证伪的路。

其中两条已核实的代码事实值得先记住：
- `captureExchange` 全仓**唯一真实调用点** `bridge.mjs:3289`，在成功送达分支；
  **失败路径不写记忆**（走 `appendUserFriction`）。
- 写入路径把 `delivered`（送达成功）当成「任务成功」的代理，唯一"证据"是
  `replyText` = **Bot 自述**。`lib/lark-audit.mjs` 是现成的客观证据源，尚未接线。

## ⓪ 已闭环（本轮 cc 处理）

- ~~dev198 生产 git 零入账~~ **已修**：`git reset --mixed origin/main`，
  untracked 38→14 / modified 71→4，工作树 md5 指纹逐行一致、`NRestarts=0` 零中断。
  剩余未跟踪全是应当如此的（`.ops-backups/` + 3 个 `.ops-hx-*` 一次性脚本 + 运行态）。
- ~~dev198 `control-plane/lib/version.mjs` v1.33.0 滞后~~ **已修**：sed 对齐 v1.33.1，
  md5 与 aliyun-hk 线上、origin/main 三方一致（防日后 rsync 把线上版本号降级）。
- dev198 磁盘上缺的两份交接文档已补回（handoffs / retrospectives）。
- ~~Bot 谎报「已更新表格并标红」而实际零写入~~ **已根治**（下午批次）：
  ① 三处 L0 skill 补写入/标红配方 + 强制 `--include style` 回读 + 诚实条款（配方经真机
  实测，抓到 `--cells @绝对路径` 被拒须走 stdin）② **A 方案 lark-cli 调用审计上线**
  （wrapper ro-bind 覆盖 Go 二进制，只记命令结构不记 flag 值，fail-open + 降级门 +
  `H_LARK_AUDIT` 灰度）③ 真机验收：两个灰度 Bot 各自建新表→写入→标红→回读**全部真做成**，
  审计实录与自述逐条吻合。bridge `4e60dd7` 已推。
- ~~控制面 crashloop 73 秒（我直改 skills.json 漏 chown）~~ 已修并沉淀纪律：
  改 L0 skill 只走控制面 API，不直改 `data/skills.json`。

## A · 观察中（无需操作，触发即处理）

| # | 事项 | 触发条件 | 动作 |
|---|---|---|---|
| A1 | Base 展示层与本地账本漂移 | Base 上停在「执行中」但本地 durable 是 failed/interrupted | `base-intake-worker` 的展示层回填是 best-effort（吞错正确），但缺对账探针；周期比对本地终态 vs Base 状态，不一致告警 |
| A2 | full 模式脏会话 resume 卡死再现 | 任务莫名卡 ~2 分钟转后台 | 上 resume 首轮活性看门狗（N 秒无引擎日志弃 resume 换新会话） |
| A3 | grok 引擎抢协议复发 | 引擎又教用户自造停止口令 | 方法论三投放面禁令已下；复发则 prompt 更硬措辞或输出过滤 |
| A4 | kimi 挂 lark-cli 设备码授权到超时 | 「查通讯录」类任务跑满时限 | F5.2 后授权链接会落底送达；再挂死考虑 lark-cli 预授权或缩短设备码等待 |
| A5 | Kimi 订阅 403 额度墙 | 川哥拍板本轮跳过 | 恢复后必须由**该用户自己的** Kimi Runner + Bot 主动送达补验，禁止借用他人订阅 |

## B · 待川哥验收（功能已上线）

> **川哥 07-30 12:0x 拍板：五项需求验收暂缓**（他还有要排查调整的）。以下待他发话后再推。

| # | 事项 | 当前状态 |
|---|---|---|
| B1 | H-0027 Pi 本阶段能力 | **2026-08-02 当前版本复验通过并关闭**：双测试 Bot 8/8 主动送达，完整 ACK 终态，未新增 orphan |
| B2 | H-0031 Owner 自进化按钮卡 | 已修复待验收。**边界**：自动验收只允许打开详情，接受/应用/忽略必须人点 |
| B3 | H-0011 Base Intake Worker | 已修复待验收（healthz `baseIntake.claims.completed=2` = 真跑过两轮） |
| B4 | H-0037 分层记忆 | 已修复待验收（生命周期→ai-memory tier / 认知类型→用户私有 sidecar） |
| B5 | H-0051 dev198 性能 Tab | 已修复待验收（`/admin/runtime`、`/internal/runtime-metrics` 公网实测 401=存在且受保护） |
| B6 | F5.x 遗留：F5 完整剧本收尾 | 「停 #句柄」打字版 + 重启中断卡（叫我重启制造一次） |
| — | 微瑕（下批顺手）：kimi 续跑日志 `session=` 只显示 id 前缀 `session_`（sid 自带前缀，`slice(0,8)` 无区分度），改 `slice(8,16)` |

## C · 建议下一批（要拍板排期）

| # | 事项 | 一句话 | 预估 |
|---|---|---|---|
| C1 | **工具级审批**（penguin §5，队列下一项） | 四档模式 + pending 注册表 + 审批卡片（危险命令飞书卡确认，kill=deny），从「整任务放行+bwrap 兜底」升级到工具粒度 | 大 |
| C2 | Base ↔ 本地账本对账探针 | 见 A1，消除展示层静默漂移 | 小 |
| C3 | 新用户接入即时触发身份解析 | 消除部门「待认领」的 37 秒窗口 | 小 |
| C4 | kimi usage 采集落地 | F1 轨迹里 kimi usage=null；候选文件 `logs/kimi-code.log`，可实测抓取 | 中 |
| C5 | resume 首轮活性看门狗 | 不等 A2 再现，主动做掉 | 中 |
| C6 | F6b 增补任意性探针 | benchmark 目前只有 probe-receipt 一个真判别项 | 小 |

## D · 远期队列

跨主机事务层（多 Bridge/多 worker 水平扩展的一致 lease 与去重，PostgreSQL 或等价）→
AI 语义 compaction + 管理台 fork/merge → Native Kimi 影子看板与灰度闸门 →
跨引擎 handoff 注入演进 → F6c 评估中心 → F7 一句话建 bot → Phase O → Phase M。

（顺序据 `docs/pi-inspired-roadmap.md` §推荐顺序 + penguin 调研 §266）

## 已明确搁置

- 飞书扫码自动申请全部权限（川哥 2026-07-27 拍板搁置；重启需他提供具体报错抠 scope 串）
- aliyun-hk `/srv/h-control/` 下几十个 `app.bak-*` 历史备份目录待清（磁盘卫生，非紧急；
  清前必须确认哪个是现役——`systemctl cat h-control` 认 `WorkingDirectory`）

## E · 沙箱内外能力对等（2026-07-30 新增专章，川哥定为验收规则）

**规则**：沙箱内用户使用 skills 的效果必须与 owner Bot 一致。差异只允许存在于
凭据来源、沙箱边界、个人身份标识脱敏；**不允许"owner 会做而用户 Bot 不会做"**。

**脱敏边界（被纠正三次后确定）**：这是**公司内部平台、租户即同事**，公司共享信息
（公司名、会议室、业务案例、内部流程）**都该搬**，只拦个人身份标识与真实资源 token；
含真实 token 的段落**不要整段丢弃**，改成占位 + 补自查命令。

### 已完成

- `lark-schedule-collab` 116 → **279 行**（反超 owner 255）：时间换算/patch/邀人/
  回读清单/汇报口径/多日行程/反模式 + 会议室段（楼层优先级/会场名单/排除规则）+
  行程案例结构；references/description-bro-p2.md 已放（脱敏版）
- `lark-doc` +37 / `lark-whiteboard` +57 / `lark-wiki` +56（token 占位+自查命令）/
  `feishu-mcp` +7（含公司知识库归档闭环）/ `lark-im` +6 / `lark-drive` +6 /
  `feishu-channel-rules` +7
- **references 全线补齐**：157+1 个文件同步到 L0 与 6 个用户 fork（此前 17 个 skill
  的 references 在 L0 完全不存在 → SKILL.md 里的链接全是断的）
- **反向同步**：owner `lark-sheets` 196 → 289 行（写入/标红配方先在 L0 补的）
- 工具入库：`ops/skill-parity-audit.sh`（对账）、`ops/sync-skill-references.sh`
  （同步，带脏词扫描 + 补丁优先）、`ops/l0-skill-patches/`（脱敏补丁与执行脚本）
- 提交：`128e6c1` / `b803a15` / `27f6ec8` 均已推 origin/main

### 待办（川哥已拍板要做，本轮未完成 → **已移交专项 session，2026-07-30 17:xx**）

**E1 · 搬 10 个 owner 独有 skill（川哥：「10 个都脱敏之后都搬过去」）**

> ⚠️ 下表实录 9 个；标题「10」来自当时口径。**以重跑 `ops/skill-parity-audit.sh`
> 的输出为唯一真源**（清单必实测，不猜第 10 个）。

| skill | 行数 | 专属标记 | 备注 |
|---|---|---|---|
| ai-collab-method | 300 | 5 处 | 方法论，通用价值高 |
| lark-whiteboard-lite | 256 | 0 | 可直接搬 |
| feishu-whiteboard-to-bitable | 207 | 0 | 可直接搬 |
| bitable-status-sync-remind | 173 | 7 处 | 需脱敏 |
| org-capability-gap-diagnosis | 170 | 7 处 | 需脱敏 |
| feishu-doc-collab-review | 160 | 6 处 | 需脱敏 |
| agent-self-improve | 125 | 0 | 可直接搬 |
| h2-sop-onboarding | 98 | 0 | 可直接搬 |
| prompt-skill-evolve | 41 | 1 处 | 需脱敏 |

做法：owner 侧读全文 → 按上面的脱敏边界处理（只拦个人 ID 与真实资源 token，
后者改占位+自查命令）→ 用 `add-content` 或 `ops/l0-skill-patches/` 模式写入
skills.json → chown + restart h-control → 等同步 → 核验 privacy reject 归零。
⚠️ 平台装前复扫会拦 `(tbl|bascn|fld|docx|wikcn|shtcn|doxcn|boxcn|nodcn)+8位`
与 `(ou|oc|on|om|omm|cli)_+8位`，含**看起来像 token 的示例占位**也会被拦，
写之前先用 `ops/l0-skill-patches/fix-privacy-reject.mjs` 的模式自查。

✅ **E1 已收口（2026-07-30 18:0x，cc）——9 个全部进 L0（实测清单 9 个，
「第 10 个」是 owner 目录里一个名字含 ANSI 色码的垃圾目录，无 SKILL.md，未动）**：
- 3 个走官方 `scripts/publish-l0-skill.mjs`（lark-whiteboard-lite /
  feishu-doc-collab-review / prompt-skill-evolve）；6 个被控制面 extraPatterns
  （scrub-terms 词表：企业域名/部门代号/wiki token——川哥已推翻的旧策略）拦下，
  按本节预案走 `ops/l0-skill-patches` 直写模式（备份+原子写+600+h-control 身份
  +restart，脚本内置与 bridge 装前复扫同门的基础 6 类扫描）。
- 脱敏边界执行：人名/open_id/appId/真实 base/table/record/obj token 全部改
  占位+现查命令（+url-resolve / +record-search / contact +search-user /
  wiki get_node）；公司 wiki 链接、部门名、编码、业务案例、会议室名单照搬；
  owner 专属基础设施（evolve 管线/proactive 通道/systemd 定时）如实标注
  「平台管理员/owner 设施」防止租户 Bot 照做挂死。
- 附件同步：lark-whiteboard-lite 的 templates/+validate.py+out/（SKILL 硬依赖）、
  feishu-whiteboard-to-bitable 的 references/ ×3（template-sample 脱敏版）、
  bitable-status-sync-remind 的 references/+scripts/（脚本默认值去身份，py 语法过）。
- 证据：9/9 `skill installed` 零 privacy reject；控制面 store 9 条
  status=active 且 installedSha==sha256（含 bridge 回执）；shared/skills 文件
  sha 与发布稿逐一相等；无同名 L2 fork 遮蔽。

**E2 · lark-calendar 剩余 −2 行**（微小，疑似 frontmatter 差异，低优先）

✅ **E2 已收口（2026-07-30 18:2x，cc）——不是 frontmatter，是行为级矛盾**：
L0 版第 37 行写着「**目前不支持主动预定会议室**」（正是川哥 E4 拍板要消除的
文本源头），且缺 owner 版指向 lark-schedule-collab 的扩展指针。已改为
`+room-find` 运行时现查流程（保留 F5→F2 楼层偏好与排除名单=公司共享信息，
去掉内部规则编号与人名）+ 补共享层指针；经控制面 store 修改 + 正规同步通道
下发 dev198（旧行 grep 归零，新行 37 就位）。owner 侧未动。

**E3 · 让 skills-sync 原生支持 references**（治本）。当前靠
`ops/sync-skill-references.sh` 手动同步；改 `lib/skills-sync.mjs` 让它同步整个
skill 子树才能免除漂移。⚠️ 改后必须**同时重启 bridge 与 runner-worker**。

✅ **E3 已收口（2026-07-30 18:2x，cc）——v1.34.0，治本落地**：
- 控制面：新增 `lib/skill-refs-store.mjs`（附件存 `data/skill-refs/`，路径白名单/
  128 文件/512KB/6MB 上限/危险扫描/**附件专用真实 ID 隐私门**）+ 三端点
  `/internal/skill-refs|skill-ref|skill-refs-put`；`/internal/skills` 每条带 `refsSha`。
- 执行面：`lib/skills-sync.mjs` 按 refsSha 增量拉取 + **每轮本地自愈**（删/改都补），
  manifest 只跟踪自己装的（**手放文件永不删**）；老控制面无字段时零行为，双端可独立升级。
- 关键设计决策：附件门与 SKILL.md 基础门**分层**——官方参考文档的示例邮箱/示例
  token 是合法内容，基础门整类误杀（实测现网 18 处命中全为假阳性）；附件门只拦
  ou_32hex / omm_16hex+ / 租户根路径。
- 部署：先做「远端↔线上」对撞（**抓到线上 skills-store 的 pristine-fork 跟随功能
  未入仓，已按 deployed-first 追账回填** commit 44a5cb1）；控制面部署+restart；
  bridge+runner-worker 双重启（ActiveEnterTimestamp 均晚于 mtime）；nginx h-ai
  的 `location /` 有 256k body 上限（location 级覆盖 server 级），为
  `/internal/skill-refs-put` 单开 16m 精确 location。
- 种子：`ops/push-skill-refs.mjs` 把 dev198 现存已审计附件推成控制面真源，
  18 个 skill 全部入库（含 whiteboard-lite templates/validate.py/out）。
- 测试：+11 全过（store 安全/往返 + sync 装载/自愈/远端删除/手放保留/老端兼容），
  全量基线 npm test 整链 exit 0。
- **验收（铁项）**：删 `lark-calendar/references/lark-calendar-create.md` →
  **20 秒**自动补回，sha 前后一致（要求 ≤120s）。
- 提交：`44a5cb1` / `7e35572` / `fa7a71b` 已推 origin/main；发布收口四断言全过。

**E4 · 沙箱用户 Bot 必须能真订会议室（川哥 07-30 17:xx 新拍板）**

川哥原话：「我不希望阻止用户 Bot 去订会议室，我希望沙箱里用户的 bot 能去订会议室。」

现状与疑点（先取证，不预设根因）：
- L0 `lark-schedule-collab` 的会议室段已同步（楼层优先级/会场名单/`+room-find` 指引），
  但真实 `omm_` 会议室 ID 被脱敏成 `omm_<会议室>` 占位——装前复扫
  `(ou|oc|on|om|omm|cli)_+8位` 也拦着，真 ID 写不进 L0。
- 因此沙箱 Bot 订会议室的可行路径只有两条：
  ① **运行时现查**：Bot 用 `+room-find`（或会议室搜索 API）拿真 `omm_` 再作为
  resource 塞进 attendee-ids——零硬编码、隐私门不动，**首选**；前提是用户
  user token 有查会议室的 scope（用飞书开发文档查证 + 真机验证）。
  ② 若用户身份查会议室权限不足 → 调整装前复扫，对**会议室类 `omm_`** 单独放行
  （川哥已定性会议室为公司共享信息）。这是代码改动：version.mjs 必升 +
  重启矩阵 + 对抗测试（放行面只限会议室资源，别把个人标识一起放进来）。
- 验收（铁律 13，Bot 主动闭环）：产品专家 Bot 真订一间会议室——深夜短时段 +
  标题带「测试可删」+ 验完立即删日程；回读 attendees 含 resource 且 room 状态
  正常；与 owner Bot 同操作效果对齐。**绝不占用同事正常时段的会议室。**

✅ **E4 已收口（2026-07-30 17:40，cc）——路径①成立，零代码改动**：
- 真机验收（proactive-acceptance `e4-room-20260730a`）：产品专家 Bot 在沙箱内
  `+room-find`（真查回 4 间可选）→ `+create` 只带会议室资源 → 回读 attendees 含
  `type=resource` + `room_id=omm_bf7d6ce…` + **`rsvp_status=accept`**（会议室
  F5-505-狄拉克(8)，event_id `08ebbb17-…_0`，2026-07-31 02:00–02:20 深夜段，
  标题「【测试可删】沙箱会议室预订验收」，零同事邀请）。
- 独立复核：owner 通道 `+get` + `event.attendees list` 逐字段一致（Bot 未编造）；
  审计日志 09:30:54–09:31:31Z 完整调用链为证。验完即删：`status=cancelled` +
  「测试可删」搜索归零，会议室已释放。
- 用户 token scope 实证够用（`calendar:calendar.free_busy:read` 在授权集内）；
  装前复扫只拦共享层**文本**里的硬编码 omm_，不拦运行时查询——两者不冲突，
  **路径②不需要**。
- 附带发现 2 条：① AI 专家 Bot（u-aca292be3f）`token_missing`——川哥从未对它做
  「配置」用户授权，属开通流程未走完，非会议室专属缺口；② 工具级权限报错只由
  Bot 文字转述，**不触发**平台权限卡（卡片只挂消息处理器顶层 catch）——待川哥
  定夺是否要把 runner 内权限错也接进 `maybeSendPermissionCard`。
  → ✅ **②已修（川哥当晚拍板，v1.35.0 / 契约 2026-07-30.2）**，详见下方 F 章。

---

## F · 授权墙 → 授权卡全链路修通（2026-07-30 晚，川哥连续复测逼出三根因）

川哥两次复测「还是不一样」「还是发链接不是卡片」，逐层取证后修完三处：

1. **grok-runner 从未接 `interactive-wait` 检测**（机制只实现在 kimi 侧）→ 接入
   `createOutputPublisher`（跨轮单发 + 撞墙不硬续 + 授权后 `retryAfterAuth` 续跑）。
   `c330308`，测试 +4。
2. **阻塞式 `lark-cli auth login` 把授权 URL 困在未返回的工具调用里**，检测器挂对了
   流也看不见 → L0 `lark-shared` 改教 CLI 官方 agent 模式三步法：
   `auth login --no-wait --json` 拿 `verification_url` → **写进回复正文** → 平台发卡续跑。
3. **`runProactiveTask`（验收/探针通道）不带 `onUserActionRequired`** → 检测器遇空
   回调整个跳过，**授权卡在验收通道结构性不可能出现**（川哥截图那张文本链接正是
   这条通道发的；我因此连误判三轮、白改两版指引）。`c015263` 补齐三路径同构，
   契约测试锁 `larkAuthTarget && larkAuthBroker` 触发点 **必须=3 处**。

**真机对比**：修复前 628s 挂死 + 仅文本链接；修复后 **12s 完成、授权卡 13s 送达**
（`lark auth flow started uid=…` → `user action delivered (proactive) feishu_cli_auth`
→ probe `completed`），产品专家对照组 7s 正常回 4 条日程零回归。全量测试链两轮全绿。

**残留（未扩，等川哥要）**：agent 是否走 `--no-wait` 三步法是**概率性**的（v3 探针里
它照自己历史模式又跑了阻塞式命令）。要 100% 确定性需在 lark-cli wrapper 层注入
`--no-wait`（属 A 方案审计 wrapper 的同一挂载点，改动小但影响全体用户，需单独验收）。

---

## G · 排版一致性 → 全平台同步 → 新用户自动生效机制（2026-07-30 晚收官）

川哥三张截图（owner 分段漂亮 / 两个用户 Bot 一坨字面 `\n`）起头，追到最后修了**六层**，
每层都零报错、只有逐层取证才看得见：

| 层 | 缺口 | 修法 | 提交 |
|---|---|---|---|
| 1 内容 | 共享版 skill 丢了私有版的 `$(cat 文件)` 传参手法（把「怎么做」当业务细节泛化掉了） | 补两步法 + 模板骨架对齐 owner 分段式 | `a91896c` |
| 2 载体 | skill 按 description 匹配触发、**不保证每轮加载**（川哥说了"用最新技能"仍复现） | 铁律进 AGENTS.md 托管块（每轮必进 system prompt） | `2d197ca` |
| 3 上下文 | 托管块被 chat-history 里的旧「成功先例」压过（老用户中招、新用户没事） | 历史注入免责声明扩到「输出格式/排版/命令写法」 | `24be423` |
| 4 副本 | per-tenant fork 因记账落后被永久判「用户改过」而**冻结** | 共享层记 `shaHistory`，命中任一历史版本即判未修改 | `07298ea` |
| 5 分流 | kimi/omp 走另一条 harness 腿，托管块少一条铁律 | 两条腿都补，巡检按引擎分流 | `07298ea` |
| 6 附件 | fork **只复制正文**，`references/` 不跟随共享版（144 个里 1 个是旧模板） | 附件来源指向同名共享版；巡检逐文件比 sha | `edc7262` |

**新用户自动生效三层机制**（川哥点名要的）：自动生效（共享目录+启动写托管块+runner
代码，新用户天然继承）/ 自动跟随（`shaHistory` + `forkIsPristine`）/ 自动发现
（`ops/tenant-parity-audit.mjs` 逐用户断言五项 + user 级 timer 每小时，有落后 exit 1）。

**验收**：全平台 9/9 用户 + 共享层对等 ✓；8-bot 只读巡检 7/8 通过（含杨平的 Bot 答出
heredoc+`$(cat)`+F5→F2+排除名单+回读）；**巡检门已证伪**（人为删 marker → 准确指名
+ exit 1，恢复后 exit 0 且文件逐字节一致）；**新用户活体实证** `u-9a037b10f7` 零干预全绿。

### ⏸ 挂起（川哥 2026-07-30 21:2x 决定，非遗忘）

1. **Luxapex（kimi，`u-dec457e69d`）真机验收未跑通**：报 `provider.api_error`，日志显示
   runner 正常启动（`model=kimi-code/k3`），属 kimi provider 服务端/配额侧，非平台缺陷。
   **机制层已到位**（`workspace/AGENTS.md` 托管块含铁律、对等巡检绿），只差"真机跑一次
   成功"。复跑条件：provider 恢复，或让该用户发一句话触发。
2. ~~lark-cli wrapper 注入 `--no-wait`~~ ✅ **已做，灰度两台测试 Bot**（2026-07-31 09:3x，
   `cfb4329`）。详见下方 J 章。
3. ~~孤儿目录 `u-ad7292bc60`~~ ✅ **已清**（2026-07-31 09:2x）。
   **来历**：v1.13.1 开放「选择已有应用」后，同一个 App 再走一次开通流程会按飞书身份
   派生出**新 uid**，凭空多出一个空账号（同 appId/openId、无订阅无用量无部门）——
   它就是 `rayman.chen` 旁边多出来的那个幻影。**该 bug 早已修**：
   `control-plane/server.mjs` 按 appId 合并复用既有账号，`provision-merge.test.mjs`
   断言 `resolveUid(store,'u-ad7292bc60','cli_AAA') === 'rayman.chen'`。
   **删前守卫**（任一不成立即中止）：不在 users.json / 无 systemd unit / 无进程持有 /
   文件数 ≤8。内容只有 4 个平台脚手架模板（SOUL.md、两个 AGENTS.md、BEHAVIORAL_RULES.md），
   创建于 07-29 07:06:42 后从未改动，**零用户数据**。
   备份 `~/h-ops-rollback/20260731-orphan-cleanup/`（tar + md5 + 来历说明，本地不进 git）。
   删后：`users/` 9 个目录与 users.json 9 个注册用户**一一对应**；healthz ok /
   审计 9/9 / 对等巡检 0 落后 / err 日志空。
   ⚠️ 源码里 `ad7292bc60` 还有两处，**是注释和测试 fixture，别跟着删** ——
   它们记录的正是这个 bug 的历史案例。

### 第 7 层（同日 22:0x–23:1x 追加）：规范只以「知识」存在，没成为缺省行为

川哥第三张截图（南鸽 Bot 的日程议程是一行流水账）追出来的。这次**不是**字面 `\n`
问题——传参手法是对的，是**根本没用分段骨架**。

- **根因**：上一轮我只把"多行传参的技术手法"提进了托管块，**"描述必须用什么结构"
  仍留在概率性加载的 skill 里**。同一台 Bot 在 12:47 只读巡检里**完整答出**了
  heredoc+`$(cat)`+【MODE】/B/R/O1/O2/P2/C 骨架，21:49 用户只说"要有议程"时却写了
  一行流水账 —— **它知道，只是没把它当缺省行为**。
- **暴露我巡检的缺陷**：问的是"你会用什么写法"（**考知识**），答对就算过；没验
  "你实际会不会这么写"（**验行为**）。所以巡检 8/8 全绿、真实使用却不一致。
- **修**（三个投放面同步）：托管块写死「交付物正文一律结构化分段，禁止一行流水账，
  这是缺省行为；飞书日程 description 固定 `【MODE】→B→R→O1→O2→P2 计划卡→C` 骨架；
  **用户只说"要有议程"时，要的就是这套完整结构，不是一句话概括**」；`omp-harness`
  同款（kimi/omp 腿）；L0 skill 把"一行流水账"写成明确反模式并给反例。
  托管块 1002→1323 字符（预算 5500，`method-defaults` 锁着），全量测试 0 fail。
- **验收（这次验行为不是考知识）**：用川哥原话措辞让 Bot 自己建日程，判据取**回读
  的 description 原文**。NG（截图那台）回读结果为七段完整骨架、段间空行、零字面
  `\n`，它还在 `C 小检` 里自写"确认议程无字面 \n"——约束已进入自检习惯。
- **人工终检**：让三台 Bot（NG/Kathy/Alex）把日程**邀请川哥本人**（各自
  `contact +search-user` 现查 open_id，避免跨 App 串号），由川哥肉眼确认排版。
  **川哥 23:1x 确认排版正确。** 三条测试日程留他自行删除。
- **覆盖现状**：行为已验证 5 台（产品专家/AI 专家/NG/Kathy/Alex）；kimi 挂起。
  ⚠️ **原写「Ryan、宣凯 从未做过配置授权」与磁盘现状不符，2026-07-31 更正**：
  两人 `.lark-cli/` 下都有 07-27～07-30 的 `auth-*.log` 与凭据缓存文件，说明
  **至少走过授权流程**。真正没走过的是 `u-9a037b10f7`（目录里只有 `config.json`
  + `remote_meta`，无任何凭据文件）和孤儿 `u-ad7292bc60`（无 `.lark-cli`）。
  【本轮观察·未验证】只有产品专家与 AI 专家有 `refresh_<appId>_<ou_…>.lock`，
  疑似=当前持有可刷新的 user token，但我没有依据把文件名当判据。
  ❗**平台没有可查询的「已授权」状态**——`token_missing` 是 Bot 的文字输出，
  代码里没这个字段（`grep` 全仓只命中我自己的补丁脚本）。要判定只有两条路：
  等他们下次真实使用，或川哥授权我发一次只读探针（会打扰同事，需他点头）。
- **排障经验**：proactive 队列串行，没授权的 Bot 跑满 620s 墙钟会把后续轮次全堵住；
  清障必须用**精确 PID**（`pgrep -f` 会匹配到自己的命令行，`pkill -f` 自杀坑同款）。

---

## H · 动作门实验 → 整体回滚 → 任务级注入（2026-07-31 00:0x–05:0x）

起因是 Codex 的新架构方案（`docs/architecture/2026-07-30-mandatory-action-gateway-hooks.md`），
川哥要的是「在当前 dev198 上怎么让 agent **必须**遵守规则」。做了一轮，**结论是这条路
对「产物形态」问题不成立**，川哥当晚叫停并要求回滚。

### 净结果（唯一存活的改动）

| commit | 内容 | 状态 |
|---|---|---|
| `c1ee539` | **任务级平台要求注入**（`lib/task-hints.mjs` + `runner-adapter` 接线） | ✅ 存活，真机验证通过 |
| `e6a01ff` | revert：退掉今晚**全部**动作门改动 | ✅ 已回滚 |
| `1a47745`→`54ecc4d` | 三个门 audit→enforce + 管理台「动作门」tab | ❌ 已随 revert 删除 |
| `89862ec` | 审计日志缺失自动补建（`H_LARK_AUDIT=all` 的前提） | ❌ **也被同一次 revert 退掉了** |

⚠️ **`89862ec` 一起没了这件事容易漏看**——它不属于动作门，是第 0 层。回滚后：
- `.env` 的 `H_LARK_AUDIT` 被回滚点恢复成 **`rayman.chen,u-01481f4a32`**（2 户灰度）。
- ✅ **8 个 0 字节残留日志已删**（2026-07-31 08:2x，川哥指示）：7 个未授权租户 +
  `u-gate-probe.log`（门实验探针）。留档：全部 mtime `00:10:48`（预建）与 `00:49:17`
  （探针），删除带 size 守卫、无进程占用、删后 healthz `ok=true` / 契约 `2026-07-30.3`
  ×10 App 无变化。**保留 3 个有内容的**：`rayman.chen`(14441B)、`u-01481f4a32`(3475B)
  ——这两个在白名单内；`u-aca292be3f`(1655B) 不在白名单但有真实记录（门实验期间
  `all` 模式写的），属实测证据，留着。
- **删掉的原因不是"没用"，是它会说谎**：空文件不代表"这个租户没调过 lark-cli"，
  而是审计根本没对它开（[[feedback_truncated_output_negative_conclusion]] 同类陷阱）。
- **因此纪律未变，反而更要紧**：`89862ec`（缺失自动补建）已随 revert 消失，所以
  **往 `H_LARK_AUDIT` 白名单加人之前，必须先 `touch` 他的日志文件** ——
  降级门查不到文件会**静默关掉审计**，控制面一切正常，你以为在记其实没记。

### 存活方案：任务级注入怎么工作

`lib/runner-adapter.mjs`（grok/kimi/omp/owner 的唯一必经路径）在分发前调
`applyTaskHints(prompt)`：命中「写日程」类任务 → 把平台要求**追加进 prompt 正文**。

- 判据 `isCalendarWriteTask()`：写动作词 × 日程类宾语，且先剔除「日程**安排**」这类
  名词短语里的假动词。8 条单测 + `ops/verify-hints-coverage.mjs` 逐引擎覆盖反证。
- 开关 `H_TASK_HINTS=0` 可关（默认开；两个进程 02:06:18 重启，晚于代码 mtime 02:05:24）。
- 配套：L0 `lark-schedule-collab` 升 **v1.2.0**（sha `fcf228073257`），frontmatter 补回
  28 个脱敏触发词 + 一句「凡创建或修改日程，描述都要写完整分段骨架，即使用户没明说
  『要议程』也照此执行」。

### 为什么门这条路不成立（别再走一遍）

1. **判定准确 ≠ 问题解决**。四轮真机零漏报，但真实那轮是：`deny → deny → bypassed`，
   **两次拦截之间 Bot 内容一个字没改**。拦截拦得住动作，拦不出正确内容。
2. **兜底机制对被约束方可见就变成绕过路径**。我把「最多 2 次后放行」写进拒绝消息 =
   教它怎么绕，它就机械重试等放行。
3. **门只能判它看得见的东西**。判据建在整条命令行上时：标题「【可删】」污染骨架检测 →
   **写对了的 Bot 被判违规**；描述按规范用 `$(cat 文件)` 传参时命令行里根本没有正文 →
   **越照做越被误判**。
4. **一晚四次栽在转义层数**（sed 的 `\x27`／JS 模板吃 `${}`／case 反斜杠翻倍／
   生成器把真换行写进单引号串）。sh 里做字符串提取应优先用**纯 POSIX 参数展开**。

→ 沉淀在 [[feedback_blocking_is_not_correcting]]，实测边界（hooks fail-open /
matcher=`run_terminal_command` / config.toml 可 `--ro-bind` 绑自己 / sh 0.9ms vs
python3 9ms）也在那里，省得再验一次。

### 对 Codex 那份架构方案的结论（要评估时看这条）

**Tool Gateway 的价值在「不可逆副作用」（删除、外发、花钱），不在「产物形态」。**
今晚等于替它做了一次预演：形态约束用拦截来做，代价高、误伤多、且拦下之后没人负责改对。
真要上 Gateway，判据应该只写在副作用类命令上。

### 顺带修的两件事

- **对等巡检漏了标杆**：巡检只比用户之间，不比 owner。而 owner 根本没有 h-method
  托管块却一直写得对 —— 这直接推翻了「写进托管块 = 建立缺省行为」。
  **标杆在哪边，巡检就必须覆盖哪边**。
- **`Triggers:` 已补回并传播**：E1 脱敏时把整行删了（混着人名地名），连带删掉触发机制。
  盘点结论：39 个 L0 skill 里**只有 `lark-schedule-collab` 一个**丢过触发词，其余完好。

### 验收方式本身的教训（今晚最贵的一条）

连续四层修复全部「验收通过」，川哥一测就露。翻 trace 才发现两条「成功」的验收 prompt
里分别写着「描述必须是完整的 MODE/B/R/… 分段结构」和「要有详细议程」——
**我用带着答案的卷子，去考它自己记不记得**。

- 验「能力」用带要求的 prompt；验「缺省行为」**只能逐字用用户原话，一个字不许加**。
- 「要有详细议程」读起来像人话，但**自然 ≠ 不提要求**。
- **用户说「还是不行」而我这边全绿 → 第一个该怀疑验收方式，不是再加一层修复。**

→ [[feedback_acceptance_prompt_carried_the_answer]]

### ⏸ 本章挂起

1. ~~8 个空审计日志文件~~ ✅ **已删**（2026-07-31 08:2x）。
2. ~~是否重做第 0 层审计全量~~ ✅ **已重做**（2026-07-31 09:0x，见下节）。

---

## I · 第 0 层重做：审计全量覆盖（2026-07-31 09:0x，川哥拍板）

`89862ec` 是被动作门 revert 误伤退掉的，本身没问题。精确恢复三个文件
（与原提交**逐字节一致**，未夹带任何动作门代码），未用 `revert e6a01ff`
（那会把动作门一起带回来）。

| commit | 内容 |
|---|---|
| `42cf126` | 恢复 `89862ec` 三文件 + **把 `test/lark-audit.test.mjs` 接进 `npm test`** |
| `c752892` | 新增 `ops/verify-audit-tenants.mjs`（生产覆盖反证）+ 旧探针加诚实边界 |

### 重做时抓到的两个「假绿」

**① `test/lark-audit.test.mjs` 从来就不在 `npm test` 里**（`git log -S` 证实
package.json 从未引用过它）。文件在、11 条测试写了、套件根本不跑 ——
我此前说的"审计部分测试全绿"对这个文件是**假绿**。已接线，现在从套件输出里
能 grep 到 `ok 9/10/11 ⑨⑩⑪` 三行。

**② `verify-audit-coverage.mjs` 自己传了 `{ env: { …, H_LARK_AUDIT: 'all' } }`**
→ 它证明的是「开关打开时机制能工作」，**不能证明开关真开着、真实租户真被覆盖**。
探针把答案写进了自己的输入，和验收 prompt 自带答案是同一个毛病。
已在它头部写死这条边界，另建 `verify-audit-tenants.mjs` 专答覆盖问题。

### 现在的验收链（三层，各答各的）

| 脚本 | 回答什么 | 结果 |
|---|---|---|
| `test/lark-audit.test.mjs` ⑨⑩⑪ | 补建/降级/不截断的单元语义 | 11/11，且**在套件内真跑** |
| `ops/verify-audit-coverage.mjs` | 机制：日志不存在→自动补建→wrapper 挂上→lark-cli 正常 | ✓（一次性 uid，自清理） |
| `ops/verify-audit-tenants.mjs` | **生产**：`.env` 真值 + daemon 环境无覆盖 + 逐 uid 判定 | **9/9 覆盖** |
| 同上 `--live <uid>` | 端到端：真实 uid + 生产真值跑一次 lark-cli，断言日志真增长 | ✓ `u-aca292be3f` 1713→1771 B |

### 最强的一条证据是白捡的

我 08:51 删掉的 6 个租户日志，在服务 09:01:32 重启后的 **09:01:38–09:01:51
自己回来了**（全是真实租户 uid，不是探针）。删除 → 确认缺失 → 重启 → 补建，
前后干净，正是 `89862ec` 要解决的场景在生产路径上的活体实证。
孤儿 `u-ad7292bc60` 没被补建 —— 它不在 `users.json` 里，也对得上。

### 终态

`.env` `H_LARK_AUDIT=all`；双进程 09:01:32 重启（晚于代码 mtime 08:58:57）、
`NRestarts=0`、err 级日志 `No entries`；healthz `ok=true` / 契约 `2026-07-30.3`
/ 10 App / `lastError=null`；全量 `npm test` exit 0、0 not-ok；对等巡检
9 用户 / 平台落后 0 / 用户落后 0。回滚点 `~/h-ops-rollback/20260731-L0-redo/`
（**外科式回滚卡**：工作树里 12 个 modified 全是 owner Bot 活文件，
`git reset --hard` 会覆盖 owner 线上配置，卡里已写死只 checkout 三个文件）。

---

## J · wrapper 注入 `--no-wait` + L0 消歧（2026-07-31 09:3x，`cfb4329` / L0 sha `2766bd4f8f3a`）

### 先纠正一个理解偏差

**这条注入不参与授权本身。** 真正完成授权的一直是平台 broker
（`lib/lark-auth-broker.mjs`：自己跑 `--no-wait --json` 拿码 → 发卡 → 后台
`--device-code` 轮询 → `retryAfterAuth` 重跑）。

注入的唯一作用是**让 agent 的输出里出现一条 URL，好让检测器触发**——
`lib/interactive-wait.mjs:78` 的判据是「输出里必须匹配到 verification URL」，
匹配不到 `return null`。阻塞式把 URL 困在没返回的工具调用里 = 检测器眼里什么都没发生
= **620s 墙钟打满 + 不发卡 + 堵住 proactive 串行队列后续轮次**。

### 实测（动手前先做掉的那条）

lark-cli 1.0.71：**`--device-code` 优先于 `--no-wait`，与顺序无关**，两者同给等价于
只给 `--device-code`（都报无效码 exit=3）。所以无条件注入其实安全；实现里仍显式排除，
是为了 CLI 升级后优先级万一变了不会静默改变行为（线上 1.0.71 / 最新 1.0.80）。

### 实现

灰度名单写在 wrapper 文件里（`NOWAIT_UIDS`），用已经 setenv 进沙箱的 `H_AUDIT_UID`
匹配。**零 bridge 代码改动、零重启、零发版**；改名单那一行即时生效，清空 = 全关。

**部署用原子 rename 不用原地截断**——当时有正在跑的沙箱 ro-bind 着这个文件，
截断写会破坏它正在 exec 的脚本，违反 fail-open 铁律。rename 后旧 inode 被 mount
钉住，在跑的沙箱不受影响，新沙箱绑新文件。

审计日志记的是**实际执行的命令**（含 `--no-wait(injected)`），不是用户给的那条 ——
记账要匹配真正发生的事。

### 验收

| 层 | 内容 | 结果 |
|---|---|---|
| 假 REAL 八例 | 注入位置 / 不重复注入 / `--device-code` 排除 / 非 auth login 不动 / 灰度外不动 / uid 未设不动 / `--cells` 载荷值仍不进日志 | 8/8 |
| 真沙箱 | 带 `--device-code` → 不注入，5.2s exit=3 | ✓ |
| 真沙箱 | 裸 `auth login` → 注入，**0.2s 秒回** exit=0，stdout 含 verification URL | ✓ |
| 检测器 | 把上面那段真实 stdout 喂给 `extractUserActionRequest` | `kind=feishu_cli_auth` ✓ |
| 回归 | `npm test` exit 0 / 对等巡检 9 用户 0 落后 / L0 落盘两段都在 | ✓ |

### L0 `lark-shared` 同轮改两处（sha `2766bd4f8f3a`）

1. **三步法第 2 步消歧**：正文那条 URL 是**给平台看的触发信号**，不是给用户点的 ——
   agent 必须明说「请点卡片上的按钮」，且**不要引导用户点正文里那条**
   （那条流由 CLI 起、平台不轮询，点了不生效）。
2. **删掉自相矛盾的阻塞式示例**：同一份 skill 里 46 行教 `--no-wait`、79 行却给阻塞式
   写法当「推荐」，agent 会挑错的那个跑。改成正误对照。

### 真机验收（三次才过，前两次是我出题的问题）

| 轮 | 指令 | 结果 |
|---|---|---|
| 1 | 「帮我授权一下 slides（演示文稿）的权限」 | ❌ Bot 理解成「给文档开权限」，跑 `drive permission.members create`，**全程没碰 `auth login`** |
| 2 | 「你现在有 slides 域的 user 身份授权吗？没有的话去申请」 | ❌ Bot 看 `auth status` 里有 `drive:docs` 相关 scope，**自己错判成「已有 slides 授权」**，不申请 |
| 3 | 「用 lark-cli 申请 slides 域的 user 授权：auth login --domain slides」 | ✅ 走到了，但**暴露真 bug**（见下） |

**教训**：题目只要留给 Bot 判断「需不需要 X」，测的就是它的判断力，不是我要测的机制。
想测机制就直接指名命令。前两轮白跑，还差点被当成平台失效。

### 真 bug：卡片发不出来（`6d33ad4` 已修）

第 3 轮里注入生效、Bot 16s 秒回、URL 也出来了、检测器也触发了，
**但用户只收到一张没有按钮的通用提示**。bridge 日志：

```
lark auth broker start fail uid=rayman.chen  lark auth CLI exit 2: "param": "--domain"
```

根因不在检测器，在 `inferLarkAuthorization`：域名是从 **Bot 的自然语言正文**里正则抠的，
措辞一变就带脏字——

```
执行 `lark-cli auth login --domain slides` …    →  抠成  slides`
（lark-cli auth login --domain slides）。        →  抠成  slides）。
```

broker 拿脏值调 CLI → exit 2 → 起不了流 → 降级成通用提示。

**这个脆弱性本来就在**，是我的注入把常见情形从 `--scope "带引号"`（正则有引号分支，
抠得干净）挪到了 `--domain 裸词`，才踩中。**一个改动的影响面不止于它改的那行，
还包括它让哪条既有路径变成了主路径。**

修法：按 CLI `--help` 列的合法域做白名单，两端削非标识字符，认不出就丢掉退回
`--recommend`；scope 过 `domain:resource:action` 形状校验。宁可授权范围宽一点，
也不能让整条链断掉。+3 条回归测试钉住。

### ✅ 终局验收（2026-07-31 10:17）

```
10:17:20  lark auth flow started uid=rayman.chen expires=600s
10:17:21  user action delivered feishu_cli_auth          ← 撞墙到发卡 1 秒
10:17:36  lark auth flow completed uid=rayman.chen       ← 川哥点卡完成闭环
```
审计日志同轮记录 `auth login --domain --as --no-wait(injected)`。
对比旧行为：620s 墙钟打满 + 卡片不来。**川哥确认「有授权卡片了」。**

### ⏸ 一个待观察

1. ~~`inferLarkAuthorization` 的 domain 提示可能丢~~ ✅ **已确认是真问题并修掉**
   （当时标为「大概率是孤立测试的假象」——**是我判轻了，它就是真的**）。
2. ~~孤儿流仍在~~ ✅ **已消除**（方案 2′，`d3b1b03`，见 K 章）。
   ⚠️ 顺带发现：**CLI 自己的 hint 文本明确教 agent「YOU must execute
   `auth login --device-code <device_code>` yourself」** —— 与平台设计冲突
   （平台自己轮询自己那条流）。L0 第 3 步已经写了「不要跑 `--device-code`」压住它，
   但这是**skill 对抗 CLI 内置提示**，属概率性压制，是方案 2 的另一个理由。

### 灰度已放开到全员（2026-07-31 11:2x，`9c2c2e0`）

`NOWAIT_UIDS="all"`。语义与 `.env` 的 `H_LARK_AUDIT` 对齐，**别记两套**：

| 值 | 含义 |
|---|---|
| `all` | 全体租户 |
| 空 | 全关 |
| 其余 | 空格分隔的 uid 白名单 |

**owner Bot 碰不到**——它不进沙箱（`resolveSandboxSpec` 对非 user 返回 null），
wrapper 根本没挂。

**放开依据**：产品专家真机通过（撞墙→发卡 1 秒）+ domain 白名单 bug 已修。
对同事是净改善：最坏退回旧行为，而旧行为除了不发卡还会堵住 proactive 串行队列。

**验收**：三种模式逐一实测（`all` 下 9 租户 + unknown 全注入 / 空全关 /
白名单只命中名单内）；排除逻辑仍在；**精确数过 `--no-wait` 出现次数，
三种输入都恰好 1 次**（上一版我只验了「包含」没验「次数」，差点漏掉重复注入）；
隐私回归 `--cells` 载荷值仍不进日志；生产文件实跑一次确认生效。

### 回滚

`~/h-ops-rollback/20260731-nowait-inject/`：
- `lark-cli-audit.prod.bak` / `.repo.bak` —— 注入功能整体撤掉
- `lark-cli-audit.pre-all.bak` —— 只退回两台测试 Bot 的灰度

**都不用重启、不用发版**；只想收窄范围最省事：直接改 `NOWAIT_UIDS` 那一行，
下一个新沙箱即时生效。


---

## K · 方案 2′：授权信号改走审计日志（2026-07-31 10:5x，`d3b1b03`）

### 先说推翻了什么

原方案 2 打算「wrapper 打提示串 + 放宽检测器判据」，前提是**检测器能看见工具输出**。
真机探针把这个前提证伪了：

```
grok --output-format plain 跑 `echo <标记>`
→ stdout 全文只有最终回复 "done"，标记出现 0 次；stderr 0 行
```

**`publishOutput(stdout, stderr)` 从来就看不见工具输出。** 今天能发授权卡，靠的是
L0 教 agent 把 URL **复述**进正文——那不是冗余，是唯一的信号通道，而且是概率性的。
按原方案改成复述一个标记串只会**更不可靠**（URL 必须逐字粘贴，标记串容易被 agent
改写成散文）。

> 这条值得单记：**做方案设计时"检测器能看到 X"这类前提，必须先花一次探针验证。**
> 我原本已经把方案 2 写进 todo 当成待办，差点直接照做。

### 改成什么

| 层 | 做法 |
|---|---|
| wrapper | 对 `auth login`（不带 `--device-code`）**fail-fast**，不真跑设备流；写结构化记录 `authreq=domain:slides` 进审计日志 |
| `lib/auth-signal.mjs`（新） | 跟着单次 run 生命周期盯该租户审计日志的新增部分，看到 `authreq=` 就构造与真实路径同构的 `feishu_cli_auth` 请求 |
| 接线点 | **`runner-adapter`**，不是 `grok-runner` —— 那是四条腿的唯一必经路径，一处接线全覆盖；而且 grok-runner 里有 codex 未提交的改动，不该动 |

`request.url` 留空是对的：`bridge.mjs:1764` 对 `feishu_cli_auth` **显式忽略**
`request.url`，发卡实际用 broker 自己那条 `flow.url`。

⚠️ **wrapper 里故意记 `--domain`/`--scope` 的值**，是「只记 flag 名不记值」隐私规则的
**唯一例外**：它们是权限范围声明（`calendar`/`slides`），不含用户数据，而平台需要它
才能申请到对的 scope。消费端 `auth-signal.mjs` 还会再过一遍白名单，脏值绝不外传给 CLI。

### 收益

撞墙 **25ms** 返回（旧行为阻塞到超时）· **零孤儿设备流** · 用户不会再看到两条 URL ·
**触发不再依赖 agent 说什么**。

### 边界（别高估）

**只在审计 wrapper 挂着时有效。** 关掉 `H_LARK_AUDIT`，本通道一起失效，退回
「靠 agent 复述」的老路——不会更糟，但要知道这层耦合。`H_AUTH_SIGNAL=0` 可单独关本通道。

### 验收

- **9 条单测**，含端到端（run 期间写记录 → 断言 `onUserActionRequired` 真被调到）
  和两个反证（`H_AUTH_SIGNAL=0` 零信号 / 无 sandbox 零行为）
- **真沙箱** `rayman.chen`：fail-fast `exit=1` 25ms、输出**无 URL**、
  watcher 拿到 `{"domains":["calendar","slides"]}`、审计日志有 `authreq=`
- 相关 8 个测试文件全绿；healthz ok / 契约 `2026-07-30.3` / err 日志空
- **部署顺序**：先重启（watcher 上线但惰性）→ 再放 wrapper。反过来会出现
  「wrapper 拦了但没人接管 = 完全没卡」的窗口

### L0 同轮改（sha `6ddefa07c74e`）

三步法改成「**这条命令会失败，而且这是正常的**；你不会也不需要拿到链接；
**不要编造链接**；不要重试；不要跑 `--device-code` / `auth qrcode`」。

### 回滚

`~/h-ops-rollback/20260731-plan2prime/`（wrapper + adapter + worker 三份备份 + 卡片）。
分档：`H_AUTH_SIGNAL=0` 只关信号通道；wrapper 里 `FAILFAST_AUTH_LOGIN=0` 退回注入
`--no-wait`（即时生效不用重启）；全撤按卡片走。

### 上线后从生产日志里抓到自己一个 bug（`e5497d5` 已修）

```
02:56:21Z  cmd=auth login --domain --help (failfast:platform-takeover)  authreq=domain:slides
```

**`auth login --help` 被 fail-fast 拦了** —— agent 只是想查帮助，结果查不到，
还多发了一次授权信号。同一个 run 里 watcher 只发一次所以没造成重复发卡，
但跨 run 就会重复弹卡。

根因：判据只看**子命令名**（`$1=auth && $2=login`），没看后面的 flag 在要什么。
`--device-code` 排除了，`--help`/`-h` 漏了。补上后七种情形逐一实测
（四种放行零信号 / 三种拦下各发一次）。

> 「门只能判它看得见的东西」的又一例 —— 这次是**看得见却没看全**。

### 生产实录（川哥真机确认）

```
10:56:02.189  runner-worker auth signal from audit log {"domains":["slides"]}
10:56:02.430  lark auth flow started        ← 信号到起流 240ms
10:56:03.163  user action delivered          ← 卡片 1 秒
10:56:18.126  lark auth flow completed       ← 川哥点卡完成
```

### 自省

**① 转义层数（第 N 次）**：改 wrapper 时用 `String.replace` 把 `"$$"`（shell 的 PID）写成了 `"$"` ——
**replace 的替换串里 `$$` 是「插入一个 `$`」的特殊语法**。审计日志的 pid 字段
当场变成字面 `$`，靠逐行看输出才发现。改用函数式 replacer 才对。
这次的层在 JS 而不是 sh。

**② 守卫锚点写太宽**：接线脚本用 `includes('sandbox,')` 判断「是否已接线」，
而文件里别处就有这个串，于是报了「已接线」实际没接上，靠事后 grep 才发现。
**守卫的锚点必须唯一**，宁可长一点。


---

## L · Mini A/B POC 收口 + 一场跨机事故（2026-07-31 下午）

### 分支状态

`codex/h-mini-ab-poc`，**不合 main**（川哥定：codex 还在做 Mini 线，全做完验证完再合）。
dev198 已切到该分支运行。

| commit | 内容 |
|---|---|
| `2fbd4ef` | Mini A/B POC 收口（executionSite / 租约 CAS / Mini 独立栈 / LaunchAgent / skills 站点过滤） |
| `e06858e` | 日志脱敏——不再 dump 第三方错误对象 |
| `08074df` | 租约丢失后自动重新申领 |

**边界⑤达成**：`6d33ad4` 的授权参数清洗与方案 2′ 五个文件，合并后与 `origin/main`
**逐字节一致**，未回退。合并零冲突（先 `checkout HEAD --` 撤掉工作树里那份内容相同的
副本，再 merge，让它以 commit 形式进来）。

### 事故：一条 2026-07-17 写下的跨机依赖

`/etc/environment` 里 `HTTP_PROXY=http://10.9.1.57:10808` —— **Mini 的 DHCP 地址**。
Mini 换手动 IP（`.54`）后该目标失联：xAI 只能走代理（直连超时）、飞书 token 刷新
也走它，**9 个 Bot 全线不可用 12 分钟**（11:20:47 起）。

- **不是我的部署引起的**：首条 EHOSTUNREACH 在 11:20:47（旧进程），我重启在 11:24:14。
- **配置藏得深**：不在 `.env`、不在 systemd unit、不在任何仓库文件，而在
  `/etc/environment`（PAM 在 session 建立时读，早于一切 shell rc）。
- **注入点不止一个**：修完 `/etc/environment` 登录 shell 仍是死地址 ——
  第二处在 `~/.profile:36` 加载的 `~/.config/proxy-mini.env`，而那行**排在
  source .bashrc 之后**，会覆盖 .bashrc。**我当时先宣布了一次部分胜利，是个教训。**

现在三层都指向 dev198 自己的 Xray `127.0.0.1:10808`，跨机依赖断干净。
unit 级 `Environment=` 优先级**实测证伪过**（把管理器环境设成死地址重启，进程内仍是本地）。

### 排查中发现的凭据泄漏（已修 `e06858e`）

飞书 SDK 报错时，三处把整个 error 对象丢进日志（SDK 默认 logger / Node 的
unhandledRejection 默认处理器 / `main().catch` 里的 `console.error`），
`util.inspect` 展开 `err.config.data` —— **某个用户 Bot 的真实 `app_secret`
十几分钟内落进 journald 几十次**。

修法是**白名单提取**（只拿 name/code/message/method/url…，绝不碰 config.data /
headers / request / response.data）+ 键名与值形态双层兜底。
⚠️ 给 unhandledRejection 加监听器会抑制 Node 默认崩溃，**必须显式 `exit(1)`**
保留「崩溃→systemd 拉起」的原语义（实测确认过原来确实是 exit 1）。

川哥定：**不轮换该 secret、不清历史日志**。

### 租约自愈（已修 `08074df`）

复核时撞见 `connected 5/9` —— 12:32 一次几秒的网络抖动让 4 个 App 租约续约失败、
断开，网络恢复后**再也没回来**。根因：`lose()` 置 `stopped=true`、清定时器、关连接，
**之后什么都没有**。症状极隐蔽（healthz `ok=false`，无告警，日志一片安静）。

修法：指数退避重新申领（5s 起 ×2 封顶 60s），claim 成功才 `onRegained` 重建 WS。
**安全不变量未削弱**：claim 的互斥在控制面（409），别站持有期间一直退避绝不连接。
新增 `status()` 让降级可观测。

**真机证伪**：强制 release 产品专家的租约 → `lease lost` → 5 秒后
`reacquired attempts=1 down=5058ms` → 重建 WS，`connected` 全程 9/9，新 leaseId 为证。

### 终态

```
dev198  08074df / codex/h-mini-ab-poc   apps=9  connected 9/9  botOpenId 9/9
        契约 2026-07-30.3  有效租约 8/8  owner 无租约  lastError=null
Mini    connected  apps=1  uid=u-aca292be3f  site=mini  Outbox pending=0
控制面  cli_a9768… 唯一租约 site=mini / instanceId=mini-primary
npm test  全量 exit 0、0 not-ok
```

### 补：Mini 拉平到 08074df（当天 15:00–15:12）

给 codex 更新交接文档时顺手核对两端版本，发现 **Mini 跑的根本不是 `08074df`**：
`bridge.mjs` 的 md5 对上的是 `2fbd4ef`，且 `lib/safe-logger.mjs`、
`lib/auth-signal.mjs` **两个文件压根不存在**，`lib/app-placement.mjs` 是旧版。

也就是说，当天在 dev198 上真发作过的两个缺陷，**在 Mini 上原封不动地留着**：
飞书 API 一报错就把 app_secret 写进日志；租约丢了不会自愈。

拉平过程（方法本身沉进了 skill，值得复用）：

1. **全量 md5 对撞**定位差异 —— Mini 的 `.git` 是悬空指针
   （指向已不存在的 `/private/tmp/feishu-grok-bridge-codex.0RIHus/...`），
   git 完全用不了，只能逐文件比。372 个代码面文件里 13 个不一致 + 6 个缺失。
2. **先判方向再覆盖**：mtime 全是部署批次时间戳、逐个 diff 也全是「Mini 缺新东西」，
   确认零本地改动才敢覆盖。
3. `git archive 08074df` 取 **git 对象**（不取工作树，避免夹带未提交改动），
   保留可执行位（`ops/lark-cli-audit` 需要），**`workspace/` 的 304 个文件一个不动**。
4. 复跑对撞 → **372 一致 / 0 不一致 / 0 缺失**。

验收：Mini 上真跑 `safe-logger` + `app-placement-reclaim` 两个测试 **15/15 pass**；
healthz `ok=true connected=true`，契约 2026-07-30.3，Outbox pending=0；
dev198 **10 个 App connected 10/10**、lastError 全 null，未受影响。
回滚点 `~/local/h-mini-rollback-20260731-150247`。

**过程中两个教训**：

- **KeepAlive 抢跑**：我 kill 进程后 launchd **4 秒内**就用旧代码拉起来了，
  而我的脚本还在往下走「解包 → 启动」。差一点就在没生效的部署上宣布成功。
  正确顺序是**先拷文件再 `kickstart -k`**。
- **我误判了「Mini 无守护」并写进了交接文档**：`launchctl list | grep -i
  "feishu\|grok\|h-mini"` 返回空，可真实标签是 `com.hplatform.mini-bot.*`，
  三个自编关键词一个都不匹配。见 [[feedback_truncated_output_negative_conclusion]]
  案例三 —— 过滤词是猜的时候，「没搜到」只证明我猜错了名字。

### ⏸ 本章挂起

1. **分支不合 main**，等 codex 的 Mini 线全部完成 + 验证。
2. **Mini 仍是 macOS `native` POC**，不代表 Linux bwrap/gVisor 物理隔离完成 ——
   外部租户必须留在 Linux。
3. Mini `H_USER_MEMORY=0`，独立 ai-memory 原生服务未补齐。
4. ~~`help` skill 含个人绝对路径被隐私门拒~~ ✅ `022618c` 已改为可移植路径并部署。
5. 长任务验证的是**主动完成卡 + ACK**，不等于「用户消息触发、前台 120 秒后转后台」
   的视觉验收。
6. ~~Mini 的版本不可查~~ ✅ `022618c` 已用 `.deploy-meta.json` + healthz `version/deploy`
   自报版本；`.git` 悬空指针仍是低优先级运维债，不再阻塞版本取证。
7. ~~两端 healthz 结构不一致~~ ✅ 当前两端均使用统一 `apps{}` envelope；Mini
   `appCount=1`，dev198 为多 App。巡检共用结构解析，顶层字段只作兼容。
8. `MEMORY.md` 已 18.4KB（绊线 12KB），`/rule-compress` 需川哥在场跑。


---

## M · 收口 codex 的 deploy-meta + help 可移植（2026-07-31 傍晚）

### 成果

`022618c` = `feat(mini-ab): expose deploy version and fix portable help skill`，
7 文件 +290 行，已 push `origin/codex/h-mini-ab-poc`（`main` 停 `e5497d5` 未动）。

Mini 从此**能回答自己在跑哪个版本**：healthz 暴露 `version`（commit 前 12 位，
不一致时带 `+dirty`）与 `deploy` 对象。之前只能靠逐文件 md5 对撞，太笨。

`lib/deploy-meta.mjs` 的写法值得留意：`normalizeDeployMeta` 是**白名单构造**
——只从原始 JSON 取 7 个已知字段、逐个正则校验、返回全新对象，任何塞进
`.deploy-meta.json` 的多余字段都进不了 healthz；校验失败 fail closed 成
`{available:false}`，绝不回显原文；写入走 tmp+rename 原子替换。

`help` skill 的 `/home/chuan/.grok` 改成 `~/.grok`，SHA `4595c5fc…f17c62`
控制面已发布。部署后 5422 行日志里 **privacy reject 计数 0**，最后一次停在
07:32:43（部署在 07:57）—— 有明确时间分界，不是"我没看到"。

### 验收数字

```
全量 npm test   398 pass / 0 fail / 0 not ok（15 批次）
test:mini-ab    20/20
Mini            version=022618c26352  dirty=false  fileCount=521
                ok/connected=true  mode=ws  Outbox pending=0
dev198          10 apps  connected 10/10  lastError 0  租约 9/10
                不含 AI 专家；owner connected + executionSite=dev198
主动消息        cc-verify-022618c-r2  completed  probes=2，两条均有 om_ messageId
```

### 三条教训

**① 验证动作的产物污染了被验证对象。** 我在部署第 ⓪ 步规规矩矩备份了
`.deploy-meta.json`，结果那个 `.bak` 被 manifest 扫进去，`fileCount` 从 521
变 522 —— **我为了能安全回滚而做的动作，改变了我正要用来证明"部署干净"的
那个指纹**，而且每次部署都会累积。能发现全靠部署前抄了基线 521。
已单独立记忆 [[feedback_verification_artifact_pollutes_measurement]]。

**② 断言强度必须匹配验收目标。** 主动消息验收我只想证明「Runner 真跑了 +
消息送达 + 拿到 ACK」，却给探针设了 `expectText="147714"`（Bot 心算 3517×42）。
两条消息全部 `ok=true` 且都有 messageId——**通道完全正常**——却因这条精确子串
没命中判成 `status=failed`。查源码才知道 `expectText` 留空会记 `null`，而
`status` 判据是 `expectedMatched !== false`，**空断言根本不拖垮 `completed`**。
只验通道就该留空。出报告时「通道成功但断言失败」和「通道失败」必须分开写。

**③ 「started」是个动词歧义，我按错的那个意思理解了。**
`proactive acceptance runner started` 只是**轮询器起来了**（每 2 秒扫 request
文件），没有待处理请求时它静默待命、永远不会有 `finished`。我按"任务开始了"
理解，等了 400 秒没等到，一度判成"卡住"，直到读源码才明白是空转。
判卡住的正确依据是 runner 日志的 `grok start skey=accept:<requestId>:<probeId>`
和 healthz 的 `liveGrokSessions`/`activeSessions`/`queueDepthTotal`。

另外两次低级错误：zsh 不对未加引号的变量做词分割，导致我的比对脚本一段说
"完全吻合"另一段说"全部缺失"（自相矛盾→整轮读数作废重验）；
`git diff --no-index` 有差异时返回 1 是 **diff 语义不是错误语义**，我拿它当
空白错误判据，误报了 4 个文件。同族：拿 `cmd | tail` 的 exit code 当上游结果。

### 额外文件分类（步骤 9 要求，145 个全部有归属）

`376 + 145 = 521`，与 manifest 精确吻合。
`shared/skills/**` 132（控制面同步的 L0 资产）/ `logs/**` 5 / `.deploy-stage/**` 3
（10:54 部署暂存残留，其 `bridge.mjs` md5=`7dfc1619…` 即 **2fbd4ef 版**陈旧副本，
不被加载）/ `.env.example`+`.gitignore` 2（tracked，被清单规则排除，已补验一致）/
`.env.bak.proxy-*` 1（600 权限，改代理时的备份）/ `.skills-manifest.json` +
`memory/…/history-backfill.json` 2。无不明来源项，故 `dirty=false` 诚实。

### ⏸ 本章挂起

1. ~~清 Mini 上两处遗留~~ ✅ **已做（16:30，川哥批准）**，详见下节。
2. `bridge.mjs:1552` 的 `process.env.HOME || '/home/chuan'` 硬编码 fallback
   （既有技术债，不在本次 diff；Mini 上 HOME 有值所以不触发）。
3. ~~两端 healthz 结构仍不一致~~ ✅ 已核源码与真机：两端均为统一 `apps{}` envelope，
   只需按端口分别采集，不维护两套结构解析。
4. dev198 仍在 `08074df`，未部署 `022618c`（本次只部署 Mini，按分工）。
5. 分支仍不合 main，等 codex 的 Mini 线全部完成。


### 清理部署根遗留（16:30，川哥批准）

从 Mini 部署根移出 4 个文件，`fileCount` **521 → 517**，闭合仍精确：
tracked 376（0 不一致 0 缺失）+ 额外 141 = 517。

**删之前先证明能删** —— 两类遗留用了两种不同的证法：

`.deploy-stage/`（3 个文件）走「无人用 + 是旧副本」：

```bash
lsof +D "$D/.deploy-stage"                    # 无进程打开
grep -rn "deploy-stage" *.mjs lib/ scripts/ deploy/   # 代码零引用
# 再逐个与运行版对 md5，确认都是陈旧副本而非唯一副本：
#   bridge.mjs        stage=7dfc1619（2fbd4ef 版）  vs 运行版 e5dcd3e6
#   app-placement.mjs stage=6ec3327c（租约自愈前）  vs 运行版 b3634f93
#   install-mini-bot.sh stage=c30371e6            vs 运行版 b9da410c
```

`.env.bak.proxy-*` 走「是当前配置的真子集」——**只比键名，绝不看值**
（隐私墙：备份含凭据）：

```
当前 .env 53 键 / 备份 47 键
只在备份里有的键 = 无        ← 关键判据，删掉不会丢任何配置
只在当前有的键   = 6 个代理键（HTTP_PROXY 等大小写各 3）
共同键值不同的   = 无
```

结论：备份 ⊂ 当前，删除零信息损失，也印证了它就是 10:24 改代理前的快照。

**回滚副本放在部署根之外** `~/local/h-mini-cleanup-20260731-1630`（700，
`.env.bak` 保持 600）—— 这正是本章教训 ① 的处置方式①：备份若留在部署根下，
又会被 manifest 扫进去，重演 `fileCount` 漂移。

清理后复验：tracked 376/0/0、healthz `version=022618c26352 dirty=false
fileCount=517` `manifestSha256=9f77d336…`、connected=true、Outbox pending=0；
dev198 10/10 未受影响。

---

## N · Mini A/B P0 第二批：站点指标 + B3 证据链（2026-07-31 17:15）

### 当前状态

Codex 独立工作树 `~/mycc/2-Projects/feishu-grok-bridge（2026-08-02 从 /private/tmp 迁入）`、分支
`codex/h-mini-ab-poc` 已由 cc 选择性收口为 `6bc38ca88696e95ea4806672612c74767b648ee8`
并 push；控制面和 Mini 已部署该批次。`main`、dev198 Bridge 与 owner workspace 均未改动。

已完成：

1. Runtime report 增加脱敏站点身份和部署版本；不包含 appId、uid、路径、进程参数或凭据。
2. 控制面 runtime store 从单站结构迁移为按 `executionSite` 独立保存 latest、分钟样本、
   24 小时峰值、stale 与容量判断；旧文件自动归入 dev198。
3. 管理台「dev198 性能」改为「站点性能」，并列展示 Mini / dev198；任一预期站点未上报
   会明确显示等待，不能被另一站点健康状态掩盖。
4. 新增 `scripts/verify-b3-long-task.mjs`：只读 TaskSessionLog + Delivery Outbox，验证真实
   飞书入站、120 秒转后台、新消息 ACK、TaskSessionLog/Outbox messageId 强一致、Outbox
   清零和事件顺序；输出只含脱敏指纹。
5. 修正 skill/todo 中“两端 healthz 结构不同”的过期结论：两端当前均为统一 `apps{}` envelope。

### 已通过证据

- 聚焦指标/B3/页面测试：60/60。
- `npm run test:runtime`：11/11。
- `npm run test:mini-ab`：23/23。
- 控制面全量：140/140。
- 仓库 `npm test`：412 tests / 0 fail；`git diff --check`：通过；新增 diff 的七类
  secret/个人绝对路径扫描零命中。
- 2026-07-31 17:12 真机只读复核：Mini 1/1 connected、版本 `022618c26352`、
  Outbox=0；dev198 10/10 connected、owner 留在 dev198、lastError=0、Outbox=0。
- 当前控制面数据仍是单站 schema v1（1439 个样本），证明新 store 的兼容迁移路径是必要项。

### 生产部署与验收证据（2026-07-31 17:32）

1. cc 独立复核后只提交指定 13 个路径；commit `6bc38ca`，远端分支已更新，工作树无残留。
2. aliyun-hk 控制面部署前发现线上真实版本为 `v1.34.0`，并非旧文档声称的
   `v1.35.1`；三方逐文件比对确认差异仅为本批功能、版本文件及线上遗留 `.bak`，未覆盖
   未收口热修。外置回滚点：`/srv/h-control/rollback/mini-ab-p0-20260731-172920-pre-6bc38ca`。
3. 控制面线上测试 140/140，服务 active，healthz `v1.35.1`。旧 schema v1 的 1439 个样本
   无损迁入 `sites.dev198`；新报告写入后文件为 schema v2、权限 0600。
4. Mini 外置回滚点：`~/local/h-mini-rollback-20260731-173103-pre-6bc38ca`。正式 commit
   tracked 清单核对为 380/0 mismatch/0 missing；deploy-meta `dirty=false`、fileCount=519，
   runner 与 bridge 按顺序双重启。
5. 当前双站：dev198 10/10（owner 1 + 用户 9、租约 9）、Mini 1/1（用户 1、租约 1），
   两站 App 交集为 0、lastError=0、Outbox pending/retrying=0；控制面汇总 11/11、两站均新鲜。
6. 性能面板当前显示“暂停扩容”是**真实状态而非页面误判**：dev198 有 2 条待人工决策的
   RPC/孤儿记录，Mini 有 1 条旧 compute orphan；本次只读取证，未自动重跑或清除。
7. 唯一未闭环项是 B3 视觉验收：川哥需在 AI 专家会话发真实 >120 秒任务；后台完成后运行
   `scripts/verify-b3-long-task.mjs`，脚本全绿且截图确认新完成卡位于会话底部才正式通过。


---

## O · 某租户 calendar 授权死循环（2026-07-31 18:0x，⚠️ 根因未定案）

> 隐私边界：本节记 uid / appId（川哥 2026-07-31 定为非敏感），**不记任何 `ou_` 真实
> openId、token、scope 缓存文件名**（那些文件名本身疑似 access token）。

### 现象

`u-9a037b10f7` / `cli_aae1f1703278dbdf` 约日程持续失败。Bot 自述「仍因缺少
`calendar:calendar.event:create` 和 `update` scopes 无法创建日程，平台已发送最新授权卡」。
用户连点三轮授权卡，每轮都失败。

### 已验证的事实（证据来自 dev198，非转述）

**① 授权流程报"完成"，但权限没到手 —— 三轮全同**

```
17:58:09  lark auth flow started
17:58:20  lark auth flow completed     ← 流程完成
17:58:30  仍缺 create + update          ← 完成后 10 秒
```

（17:57 / 17:59 两轮同形）。**如果是用户没点完，flow 不会走到 `completed`。**

**② 缺的 scope 在交替，但 create/update 从没拿到过**

```
17:56:54  缺 create + update
17:56:56  缺 read
17:57:24  缺 create + update
17:58:30  缺 create + update
18:01:01  缺 create + update
```

`read` 有时不缺（说明 read 拿到过），`create`/`update` **一次都没成功**。

**③ 关键：她的 lark-cli scope 缓存里，从来没有 calendar 系列**

`~/.lark-cli/cache/auth_login_scopes/` 共 10 个条目，最大一次（12:37:38）请求了
**130+ 个 scope**，覆盖 base / docs / docx / drive / im / mail / minutes / sheets /
slides / space / spark / task / vc / wiki —— **没有一个 `calendar:` 开头的**。

且缓存**停在 12:37**，17:5x 那三轮授权一个新条目都没产生 —— 这符合本轮上线的
`FAILFAST_AUTH_LOGIN=1`：wrapper 拦下 `auth login`、改由平台发卡，不再走 lark-cli
自己的 auth 路径，所以不写它的 scope 缓存。

**④ 横向对比：不是平台性故障**

今日缺 `calendar:calendar.event:create` 的调用次数 / 今日总调用：

```
u-9a037b10f7   4 / 125
rayman.chen    2 / 71      ← 川哥自己的产品专家今天也缺过
u-f7870bc4b3   0 / 52
u-01481f4a32   0 / 1
```

**⑤ 控制面 `/internal/auth-status?uid=` 查不到飞书 scope**

返回的只有 provider 绑定状态（addons / xai / kimi / zhipu / minimax）与 dashboard 链接，
**没有任何飞书授权字段**。这坐实了 G 章挂起的那条「授权状态无可查询字段」——
排障时无法从平台侧回答"这个租户现在到底有哪些 scope"。

### 两个候选根因（都还没定案，别当结论用）

**候选 A：应用级权限未在飞书开发者后台开通。**
飞书是两层模型：应用级（后台申请 + 管理员审批）→ 用户级（点卡授权）。第一层没开通时，
授权页压根不列该权限，用户能顺利"完成"授权但 scope 到不了手 —— 完美解释 ① 的死循环。
**证伪方法**：开发者后台 → 该 App → 权限管理，看 `calendar:calendar.event:create` /
`update` 在不在已开通列表。**我够不到这个界面。**

**候选 B：平台发卡请求的 scope 里不含 calendar。**
本轮方案 2′ 后，发卡由 `lib/interactive-wait.mjs` 从 agent 散文里清洗出 `--domain` /
`--scope` 再交 broker。若清洗结果丢了 calendar，卡再点也要不到。
**证伪方法**：bridge 日志**不记** scope 参数（只有 `lark-audit calls=N writes=N`），
需要给发卡路径补一行 scope 落盘，或直接读 broker 的 flow 记录。

⚠️ 证据 ③ 对两个候选都成立，**区分不开** —— 因为 12:37 之后本来就不走 lark-cli 的
auth 路径了。别拿"缓存里没有 calendar"直接判 A。

### 下一步

1. **【需川哥】** 开发者后台核 `cli_aae1f1703278dbdf` 的 calendar create/update 是否已开通
   —— 这一步定 A 的生死。
2. **【需川哥】** 顺带核 `cli_a970695d27221bb3`（产品专家），它今天也缺过 2 次 create。
3. **【可做】** 给发卡路径补 scope 落盘日志，让候选 B 可证伪。当前排障只能靠猜，
   这本身就是缺口。
4. **【可做】** 控制面 `auth-status` 补飞书 scope 字段（G 章挂起项，本次再次被它卡住）。

### 教训

**「flow completed」是流程信号，不是目标达成。** 三轮 completed 全都没拿到权限，
而系统里没有任何一处会说"完成了但你要的东西没到"。这与本轮另外两次同源：
`runner started` 不是任务开始、`grep` 没命中不等于不存在 —— 都是**把符号的字面语义
当成了实际状态**。凡是"完成/成功/已发送"这类信号，都要再问一句：**它保证的是
动作发生了，还是目标达成了？**


---

## P · 收口 codex 的 Mini 原生记忆 + GitHub 强制代理（2026-08-01 08:0x）

### 两个提交

| 仓库 | commit | 内容 |
|---|---|---|
| feishu-grok-bridge | `3232145` | feat(mini-ab): add native memory parity and force GitHub through Xray（14 文件） |
| mycc | `0216555` | docs(h-platform): require Mini GitHub access through Xray（1 文件） |

`main` 停 `e5497d5` 未动未合并。暂存严格受控：bridge 侧 14 项与指令预期逐一吻合、
6 个 `.sh` 保留 `100755`；mycc 侧只 1 项，evomap/current/scheduler 三个运行态文件
保持未暂存。

### 终态

```
dev198  3232145+dirty  10/10 connected  lastError 0  租约 9  Outbox 0  h-memory 9
Mini    3232145        1/1  connected   lastError 0  租约 1  Outbox 0  h-memory 1
        dirty=false  fileCount=738（390 tracked + 348 额外，全部归类）
双站 App 交集 0 · owner 固定 dev198 · 契约统一 2026-07-31.4
稳定性观察 21 样本 / 625 秒 / 异常 0
npm test 430 pass / 0 fail · test:mini-ab 29/29
```

Mini ai-memory 闭环：`{ok, serviceReady, mcpInjected, writeQueryDelete}` 全 true，
输出只含聚合状态无 token/正文。GitHub 强制代理四项 + 两道额外防线全过
（死端口 exit=128、非 loopback exit=2、`-c` 覆盖 exit=2）。

### 超出原指令的两处（均经川哥批准）

**① dev198 也升到了 3232145。** 触发原因：稳定性门 `lib/mini-ab-observer.mjs:67`
要求双站 commit 一致，而原指令只让部 Mini。升级前三个前提逐一实测（Linux 分支
依赖脚本存在、`H_MEMORY_PROVISION_SCRIPT` 未定义、`process.platform=linux`），
确认改动全是平台分支、Linux 路径逐字未变，零交集核对后快进。10 个 h-memory
实例一个没掉，owner 13 项活文件原封未动。

**② 清掉 dev198 上已迁走用户的 ai-memory 残留。** 服务停+disable、`ports.json`
移除条目（原文件备份），**7.3M 数据归档保留未删**（川哥定：留着当备份）。

### 三条教训（同一个根）

本轮连栽三次「阴性结果」，成因各不相同：

| 现象 | 我的判断 | 实际成因 |
|---|---|---|
| 安全扫描 8 项全 0 处 | 干净可提交 | `cat $FILES` 在 zsh 未分词 → 扫描面 0 行，一个字节没扫 |
| fail-closed 测出 exit=0 | 脚本有洞 | 注入点错：脚本 exec 时覆盖 `ALL_PROXY`，真入口是 `H_MINI_XRAY_PROXY` |
| grep 新测试文件名 0 次 | 新测试没跑 | `node --test` 根本不打印文件名，只打印用例名 |

第一次尤其危险：**安全扫描的「全 0」既可能是通过也可能是没执行，两者长得一模一样**，
而它正要给"能不能提交"背书。

**纪律：凡期望零命中的检查，必须同时带一个期望非零的对照锚。** 先打印扫描面规模
（0 行直接判无效），再加一个必然出现的正向项（如 `127.0.0.1:10808` 应 ≥1 处）。
防护探测则要先读实现确认作用点，说"没防住"之前先问"我这一击落在它身上没有"。
已并入 [[feedback_truncated_output_negative_conclusion]] 案例四五六 + 第三条纪律。

另记两个运维基线：**dev198 healthz 就绪要 ~57 秒而 Mini 只要 ~4 秒**（10 个长连接
vs 1 个）——哪天 dev198 十秒就"就绪"反而要怀疑没连全；`.deploy-meta.json` 是未跟踪
文件，`merge --ff-only` 不会更新它，升级流程必须含「重写元数据 + 再重启一次 Bridge」。

### ⏸ 本章挂起

1. **剩余边界**：当前是 macOS 应用/运维入口的 fail closed，**不是 PF/netns 级物理
   封锁**。三道防线都在应用层，有 shell 的进程仍可绕过。要"任何进程都无法绕过"，
   须纳入 Mandatory Action Gateway 或 Linux 网络命名空间/防火墙白名单。
2. 控制面 `auth-status` 补飞书 scope 字段（原第 11 条的 ②），方案已定：bridge 复用
   `evaluateScopes` 随 runtime report 上报 → 控制面新端点 → `auth-status` 加
   `larkScopes` → 管理台展示。
3. 三个租户的 calendar 权限需川哥去开发者后台开通（`u-9a037b10f7` 张雨琦周一回来前、
   `u-dec457e69d`、`u-93577af39a`）；`u-f7870bc4b3` 只需重新点一次授权卡。
4. 分支仍不合 main。

## 2026-08-02 · Studio 网络与模型调用（川哥拍板）

**决策**：不修 Mini↔Studio 雷电转发的 crash-loop。下周川哥给 Studio 接**有线网络**（192.168.61.x 段），此后凡是调 Studio 上的模型，一律**走有线直连**，不再经 Mini 中转（`192.168.61.66:11436` 那条转发链退役）。

**网线接好后的切换清单**：
1. 确认 Studio 有线 IP（进 192.168.61.x 段，静态优先），实测 `curl <ip>:11434/api/version`。
2. dev198 `ai-memory-llm-proxy`（`~/.local/share/ai-memory-llm-proxy` env / repo `deploy/dev198/ai-memory-llm-proxy/`）：PRIMARY_BASE 从 `192.168.61.66:11436` 改为 Studio 有线 IP 直连；**注意 no_proxy 加具体 IP（CIDR 无效）**。
3. dev198 KidsBench chat shim（18231，`kidsbench.middleware.ollama_chat_shim --upstream`）同步改 upstream。
4. Mini 两个 LaunchAgent `com.cc.studio-ollama-lan` / `com.cc.studio-ollama-tunnel` 退役（unload + 移 plist），当前本就 crash-loop（255）。
5. 顺带处理 Studio 的空壳模型：qwen2.5:3b 在 Ollama 0.31.2 返回空壳 200（换模型或重拉 blob；qwen2.5:7b 实测正常），换完 proxy 的 PRIMARY_MODEL 跟着改。
6. 验收：dev198 `journalctl --user -u ai-memory-llm-proxy` 出现 `primary ok` 且返回真内容（33c0f74 起空壳已判失败）；`node ops/memory-embed-probe.mjs` 5/5。

**现状（不阻塞）**：dev198 记忆抽取/D3 检测由火山方舟 fallback 接管，功能正常；向量检索走 dev198 本机 Ollama（127.0.0.1:11434，qwen3-embedding:0.6b），与 Studio 链路无关，2026-08-02 端到端探针 5/5 全过。

## 2026-08-03 20:0x 真值（执行保真层上线，契约 2026-08-03.7）

- **P2b 思路重构落地（.6）**：撞墙自动发卡=既有机制（方案 2′）；本轮增量=①窄流
  完成跟发「一次补齐」对账卡（≥20 项，24h 去重，按钮回调不过期）②「应用未配置」
  owner 摘要卡（24h/app 去重）。管理员退出发送环；push-scope-card.mjs 降级兜底。
- **执行保真层（.7）真凶实锤**：租户 grok 全跑 grok-4.20-non-reasoning（scaffold
  钉死已下架的 grok-code-fast-1 → CLI 静默降级），owner=grok-4.5 订阅通道。
  编造交付两例（刘子贤零写声称批量更新 / 产品专家 okr 全 rc=3 编 cycle_id）。
- **已上线**：grok 模型钉死（9/9 租户启动装配即回 4.5，池校验绝不硬写）+ trace
  记实际模型 + 用户后台模型自选（/api/model，列表随 models_cache 自动更新，
  控制面 v1.39.0）+ Stop hook 判定④（写声明×零写）+ wrapper rc 行 + 事实行
  失败披露。双站 8504b9d，契约 .7 唯一；wrapper/hook md5 对撞一致。
- **等真实流量**：租户任务 trace model=grok-4.5 读数；后台模型下拉出现（需一次
  context-report 上报）；判定④首次真实拦截。
- **P2b 尾巴不变**（王宣凯 18:31 点卡 600s 超时可再点/南鸽未点/越权域/后台补勾）。
