# H 平台后续 TODO（2026-07-30 16:1x 快照）

> **线上终态**：控制面 `v1.33.1`（aliyun-hk `/srv/h-control/app`）/ 全 Bot 行为契约
> `2026-07-30.1` / bridge+runner-worker 双进程（dev198 user 级 systemd）/ dev198 git
> 已入账追平 `origin/main` = **`4e60dd7`**（A 方案审计）。测试 **377/377**。
> ⚠️ **重启矩阵**：改 `sandbox.mjs`/`grok-runner.mjs`/任何 Runner 侧共享 lib，
> **必须 bridge + runner-worker 两个都重启**（真实 Runner 在 `runner-worker.mjs:84`）；
> 只重启 bridge = 静默失效零报错。改控制面代码/`data/*.json` → `restart h-control`。
> **实测基线**（cc 07-30 11:2x–12:0x 亲验）：9/9 Bot 在线、契约唯一值 1 个、bridge
> 全量 369/369、Delivery Outbox pending 0、`grants` 持续增长（真实流量）、
> orphan compute=1（设计内保守标记，Recovery 实见两次成功重放）。
> **真值备忘**：healthz `127.0.0.1:18765`；`systemctl --user`；控制面代码在 `app/` 子目录。

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
| B1 | H-0027 Pi 本阶段能力 | 已修复待验收（durable 栈 + 公平调度 + orphan 恢复面均有线上活证据） |
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
