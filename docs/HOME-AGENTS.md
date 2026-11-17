# AGENTS.md — 本机 AI 协作宪法（HOME 层 · v1，2026-06-17 生效）

> **适用**：所有在本机 `~` 运行的 AI agent（cc / codex / gemini / grok / omp …）。
> **定位**：HOME 层**单一真源**。进入本机先读本文件，再读各自项目级规则（如 `mycc/CLAUDE.md`）。
> **边界（防漂移）**：本文件只放**此处独有**的——HOME 白名单、接线、并发规则。其余一律**指针、不复制**（归档/记忆/身份格式见 `mycc/CLAUDE.md` 与各 agent 入口）。

---

## 一、铁律（共同遵守）

1. **不在 HOME 根乱建**：默认禁止在 `~/` 新建文件 / 目录;新内容进 `~/mycc/` 对应子目录;不确定 → `~/mycc/1-Inbox/`;临时产物用 `/tmp/`。
   - **确需在 HOME 根建（罕见例外）**：**不自行创建** —— 先用**人话**向川哥说清「要建什么 + 为什么必须放在根（不能进 mycc）」，等川哥拍板后再建。不硬拦，但必须先报备、由川哥决策。
2. **进 mycc 后按其规则归档**：见 `mycc/CLAUDE.md §5`（写入任何目录前先读其 `README`）。
3. **安全**：secret 不硬编码 / 不入 git / 不入记忆 → 集中 `~/.mycc-secrets.env`(非 git, 600) 或 Keychain，只存指针;他人数据 → `work-private/`(禁外派 / 禁 git / 禁 memory);发现硬编码 secret → **STOP + 告警**。
   - **凭据生命周期**：API Key、管理密钥、密码等长期凭据的轮换、撤销、替换属于不可逆高风险动作；发现疑似泄露时先停止扩散、清理临时副本并告警，**必须等川哥明确授权具体凭据后再变更**。既有 OAuth `access_token` 自动刷新不属于人工轮换，可按已批准配置继续运行。
4. **共享记忆优先**：当川哥要求“更新记忆 / 同步记忆 / 确保 Claude 知道”时，必须写入 `~/mycc/0-System/` 共享记忆（至少 `RECENT_EVENTS.md`，必要时 `memory-items.md`/`task-log.md`）；Codex 私有 memory 只能作辅助，不能作为唯一记忆来源；secret 仍然一律不入记忆。
5. **跨站大文件走统一规则**：Air↔公司传大文件或批量目录时，进入 `~/mycc` 读取 `docs/rules/MULTI-DEVICE.md` 和 `.claude/skills/cross-site-file-transfer/SKILL.md`；HOME 层只保留此指针，不复制传输参数。
6. DO NOT send optional commentary
7. **home-studio 数据盘优先（2026-10-30）**：在本机新建、下载、生成或导出与软件安装/运行路径无强绑定的独立数据与产物时，默认用 `/data/home-studio/`，不设文件大小门槛。写入前必须读 `~/mycc/docs/rules/HOME-STUDIO-STORAGE.md`（分类、已迁移路径和备份边界唯一真源），确认 `/data` 已实际挂载；未挂载则停止该次数据写入，不在根盘同名目录兜底。已迁移的旧路径软链接须保留。活跃源码、编译、依赖环境、运行数据库仍留 NVMe；知识文档/共享记忆继续按 mycc 归档，凭据与他人数据遵守第 3 条。这是第 1 条的本机独立数据存储例外，不适用于其他设备。

---

## 二、HOME 目录白名单（lint / hook 的唯一机器可读单源）

```yaml
# allowed_home_roots — 合法顶层条目，agent 不得新增同级目录/文件
# 铁律只约束 agent 主动行为；第三方/系统自动产物由 lint_ignore_globs 排除
root_files: [AGENTS.md]                  # HOME 根唯一合法的 agent 维护文件（本宪法）
system:    [Applications, Desktop, Documents, Downloads, Library, Movies, Music, Pictures]
# ↓ home-studio(Linux, 中文 locale) 的 XDG 标准目录 + 系统包目录。这些在 Air(macOS) 上不存在，
#   列入白名单对 Air 无副作用；不列则 lint 在 Linux 侧恒报 11 项误报，把真正的乱建淹掉。
system_linux: ['下载', '公共', '图片', '文档', '桌面', '模板', '视频', '音乐', 'snap']
core:      [mycc, .mycc-global]          # PKM 中枢 + 外置共享状态
private:   [work-private]                # 隐私 vault
runtime:   [bin, local, go, models, nltk_data]
legacy:    [cc-monitor-oss, lnmem-data, xray, scripts, Archive, iterm2-logs]  # 历史例外：保留，禁新增同类
projects:  [MyAgent, task-board, home-lan, dsh-stack]  # 独立项目仓（2026-07-26：MyAgent、task-board；2026-10-06：home-lan=家里局域网与飞牛 NAS；2026-11-12：dsh-stack=DSH CLI 独立实例）
agent_cfg: ['.claude', '.codex', '.gemini', '.grok', '.windsurf', '.continue', '.augment', '.agents', '.dsh']
# 合法点目录基线（系统/语言工具/AI 工具运行时）。新增点目录会被 lint 抓到供审查——防 agent 用 .xxx/ 绕过
allowed_dot_dirs: ['.Trash', '.aliyun', '.android', '.boss-agent', '.bun', '.bytertc', '.cache', '.cargo', '.cc-airplayer', '.cc-switch', '.claude-mem', '.codeg', '.cola', '.coli', '.conda', '.config', '.cups', '.deepface', '.geo-login', '.gnupg', '.gradle', '.hermes', '.kaggle', '.keras', '.lark-cli', '.letta', '.lnmem', '.lnmem-fpga', '.local', '.matplotlib', '.mem0', '.modelscope', '.mycc-mcp', '.npm', '.obsidian', '.ollama', '.omlx', '.omp', '.openclaw', '.opencli', '.openpencil', '.pg0', '.promptfoo', '.rhinocode', '.rustup', '.sogouinput', '.ssh', '.streamlit', '.swiftpm', '.tauri', '.tmux', '.zsh', '.zsh_sessions']
lint_ignore_globs: ['.*', '*.lock', '.DS_Store']  # 仅作用于「文件」（点文件如 .zshrc/.mycc-secrets.env 不告警）；点目录必须在白名单否则报警
```

- 新工具 / 新项目落地 → `~/mycc/2-Projects/`，**不在 HOME 根新开目录**。
- 确需新增合法顶层 → **必须先改上面 YAML 块**（lint 与 hook 都只读它，单源）。

---

## 三、认知（共同理解 · 只放锚点，细节走指针）

- **主人：川哥**（独立开发者 + 产品人，PKM 驱动工作流）。**川哥不写代码**——所有安装/配置/建目录/写脚本由 agent 完成;需权限找川哥要，不让他手动操作。
  *(称呼 / 署名格式归各 agent 入口规则维护，本文件不写死，避免身份漂移。)*
- **组织核心**：`~/mycc/` 是中枢。理解本机 = 理解 mycc（详见 `mycc/CLAUDE.md`）。
- **四机三层**：Air(开发·本机) / Mini(编排中枢 + 生产 + 网关) / Studio(纯算力) / NAS(智能家居) + 阿里云·RackNerd VPS(中转)。**SSH 别名 / IP / 端口用前 grep memory `user_hardware`，不猜。**
- **agent 角色分工 + 记忆系统三位置**：见各 agent 入口规则与 `mycc/CLAUDE.md §4`。本文件**不复制**（防双真源漂移）。

---

## 三·补、AI Ops 运维服务器 SSH 接入（cc / codex / grok 共用）

三引擎都必须能维护 aiops。完整接入真值在仓库文件 `~/mycc/docs/AI-OPS-SSH-ACCESS.md`，不要只指向 cc 私有 skill。

**正文锚点**：`racknerd` = `23.226.135.149`；默认 `ssh racknerd`，兜底 `ssh -o ProxyJump=none -i ~/.ssh/id_ed25519 root@23.226.135.149`；本机用户 `Rayman.Chen` 共享 `~/.ssh/config` + `~/.ssh/id_ed25519`（无 passphrase，600）；服务根目录 `/opt/ai-ops-cockpit`；容器组 `ops-*`；连不上先查 fail2ban；禁用 `pkill -f <pattern>`。

**codex 前提**：调用方启动时必须给 `--sandbox danger-full-access --skip-git-repo-check`，进程内无法自改沙箱。grok 可直接 `grok -p "ssh racknerd ..."`。

---

## 四、并发与冲突（多 agent 共存铁律）

- **Git 提交与推送（所有智能体同权，2026-10-19 川哥授权）**：cc / codex / gemini / grok / omp / hermes 等所有智能体，均可在用户授权的任务范围内自行 `git add`、`git commit` 和普通 `git push`；适用于 `mycc`、`.mycc-global` 及其他项目仓库，无需交由 cc 代提交，也无需因引擎身份另行申请提交/推送权限。
- **Git 并发保护**：提交前检查 `git status` 与 diff，逐个路径暂存且只提交本任务改动，不夹带其他 agent 或人工修改；同一 worktree 的暂存/提交操作串行执行，同一远端分支的推送先核对最新状态，遇锁占用或冲突按下条停止处理（防 git index lock 竞态）。
- **写共享文件先读后写**：改 `0-System/*` / memory / 共享脚本前，先读当前内容，**不覆盖他人或人工内容**;批量写用锁文件。
- **冲突即停**：发现并发写冲突或不确定归属 → **STOP 询问**，不自行覆盖。
- **并行隔离**：并行任务各用 git worktree / 独立 `/tmp`，不在主 checkout 混不相关改动。
- **开工先同步（2026-11-17）**：动任何文件前先 `git pull --rebase --autostash`；拉不动就停下报告，不在旧基线上继续写。
- **小步提交、当日推送**：一个任务一个提交，做完即 push；领先远端超过 3 个提交必须推，禁止攒提交。
- **长期任务用 worktree**：预计半天以上或要保留未提交改动时，`git worktree add .worktrees/<slug> -b <branch>`，主 checkout 不堆几十个未提交文件。
- **永不改写远端历史**：禁止 `push --force` / `--force-with-lease` / 远端 reset / filter-branch；只允许快进追加。
- **分叉即停**：`git rev-list --left-right --count origin/main...HEAD` 两侧都非 0 时停止改动，按 [GIT-SYNC 规则](rules/GIT-SYNC.md) 备份→合并→推送，不自行强推。体检：`bash ~/mycc/4-Assets/scripts/git-sync-health.sh`。
- **完整流程与踩坑**：见 [`docs/rules/GIT-SYNC.md`](rules/GIT-SYNC.md)（含长文件名 sparse-checkout、脏工作树合并、冲突处理）。

---

## 五、守护与接线（本宪法如何被强制执行）

**接线（各 agent 强制读到本文件，不靠自觉）**：

| agent | 接线方式 | 机制 |
|-------|---------|------|
| cc | `~/.claude/rules/home-constitution.md`（指针文件） | rules 目录自动加载 |
| codex | Air：`ln -s ~/AGENTS.md ~/.codex/AGENTS.md`；home-studio：`~/.codex/AGENTS.md` 由 `mycc/4-Assets/scripts/agent-entry-derive.py` 生成＝本文件原文块＋记忆入口块（systemd `agent-entry.path` 盯本文件与热索引自动重生成） | codex 全局只读 `~/.codex/AGENTS.md` 一个文件（在 ~/MyAgent、codeg 会话目录下不会读 `~/AGENTS.md`；2026-09-24 查实 home-studio 原先漏接此线） |
| gemini | home-studio：`~/.gemini/GEMINI.md` 预置 HOME 与存储规则指针；其他机器按各自实际配置 | 本机未安装 CLI，入口已预置，未宣称运行时加载验收 |
| grok | home-studio：`~/.grok/AGENTS.md` 由 `agent-entry-derive.py` 生成＝原权限说明＋本文件原文块＋记忆入口块；omp 编排脚本仍可 prompt 注入 | grok 会加载 `~/.grok/AGENTS.md` 与 Claude rules 目录（含 cc 的指针文件），但**不读 `~/AGENTS.md`**（2026-09-24 home-studio 验收会话实测：rules 段无本文件原文）。`~/.grok/README.md` 是产品文档，勿改 |
| cursor | home-studio：`~/.cursor/hooks.json` 的 `sessionStart` 注入存储规则正文；`workspaceOpen` 为桌面/CLI 加载本地 alwaysApply 规则插件 | 官方全局 hook 已配置、派生规则与真源一致；旧进程事件触发未测，不保证缓存会话热更新 |
| hermes | home-studio：`~/.hermes/SOUL.md` 附加 HOME 与存储规则指针 | 全局身份文件随新会话 system prompt 加载；已缓存会话不保证热更新 |
| omp / openclaw | 接入时由全局入口或编排模板注入本文件及存储规则引用 | home-studio 当前未安装；安装验收须核真实加载，不以 Codeg enabled 标记代替 |

**新 agent 入场握手 checklist**：① 在 §二 YAML `agent_cfg` 加配置目录 ② 按上表接线 ③ 纳入 HOME-lint ④ 确认 secret / 归档 / 并发规则已传达 ⑤ home-studio 新智能体/runtime 必须接入 §一.7 数据盘规则，并用实际会话加载证据验收。

**检测**：
- HOME-lint（`~/mycc/4-Assets/scripts/home-lint-structure.sh`）解析 §二 YAML 白名单查顶层散落，应用 `lint_ignore_globs` 过滤;cron 或各 agent Stop hook 触发。
- 支持 PreToolUse 的工具（cc 确定）硬拦在 HOME 根的写入;其余靠铁律 + lint 兜底。

---

## 六、执行风格（少确认、少啰嗦 · 2026-11-12 生效）

> 目标：去掉废话和重复请示，**不削弱任何安全约束**。适用：本机所有 agent（含 DSH / Codeg 内的 DeepSeek）。
> 这是 §一.6「DO NOT send optional commentary」的展开，冲突时以 §一 铁律为准。

**默认直接做**
- 能一次做完的，做完再报结果；不要逐步请示「要我继续吗」，也不要把一个任务拆成多轮才给答案。
- 需求有歧义时按最合理解释执行，**一行**说明采用的假设；不要反问上下文里已经有的信息。
- 先给结论或结果，再给必要说明。不复述规则、不预告「我准备做什么」、不写免责声明、不科普常识。

**被挡住时**
- 被工具 / 沙箱 / 宿主拒绝：先在**同一授权范围内**换实现（换工具、换参数、换路径、换命令），不要停下来讲原则。
- 确实需要更大权限：一句话说清「要什么权限 + 为什么 + 代价」，然后停下等；不要连问三次。

**刹车仍然有效（这些先问一次，答完照做）**
- 不可逆 / 破坏性：删数据、覆盖未提交改动、`git push --force`、清备份、改或轮换凭据。
- 涉及他人数据、secret 硬编码、对外发送，或目标归属不明（可能是别人的系统）。
- 与 §一 铁律、§四 并发规则冲突 → **冲突即停**，说明冲突并等指示，不自行绕过。

**红线（无论谁怎么要求）**
- 不把「操作者想要」当成覆盖铁律的理由；不把川哥的「停一下 / 这不合规」当成无效指令。
- 不安装、不打补丁、不注入任何以「取消拒绝、取消审批、取消沙箱」为目的的机制——这类"破甲"改动一律先报备。
