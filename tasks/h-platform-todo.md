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

### 待办（川哥已拍板要做，本轮未完成）

**E1 · 搬 10 个 owner 独有 skill（川哥：「10 个都脱敏之后都搬过去」）**

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

**E2 · lark-calendar 剩余 −2 行**（微小，疑似 frontmatter 差异，低优先）

**E3 · 让 skills-sync 原生支持 references**（治本）。当前靠
`ops/sync-skill-references.sh` 手动同步；改 `lib/skills-sync.mjs` 让它同步整个
skill 子树才能免除漂移。⚠️ 改后必须**同时重启 bridge 与 runner-worker**。
