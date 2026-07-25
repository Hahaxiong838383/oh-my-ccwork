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
4. **共享记忆优先**：当川哥要求“更新记忆 / 同步记忆 / 确保 Claude 知道”时，必须写入 `~/mycc/0-System/` 共享记忆（至少 `RECENT_EVENTS.md`，必要时 `memory-items.md`/`task-log.md`）；Codex 私有 memory 只能作辅助，不能作为唯一记忆来源；secret 仍然一律不入记忆。
5. DO NOT send optional commentary

---

## 二、HOME 目录白名单（lint / hook 的唯一机器可读单源）

```yaml
# allowed_home_roots — 合法顶层条目，agent 不得新增同级目录/文件
# 铁律只约束 agent 主动行为；第三方/系统自动产物由 lint_ignore_globs 排除
root_files: [AGENTS.md]                  # HOME 根唯一合法的 agent 维护文件（本宪法）
system:    [Applications, Desktop, Documents, Downloads, Library, Movies, Music, Pictures]
core:      [mycc, .mycc-global]          # PKM 中枢 + 外置共享状态
private:   [work-private]                # 隐私 vault
runtime:   [bin, local, go, models, nltk_data]
legacy:    [cc-monitor-oss, lnmem-data, xray, scripts, Archive, iterm2-logs]  # 历史例外：保留，禁新增同类
agent_cfg: ['.claude', '.codex', '.gemini', '.grok', '.windsurf', '.continue', '.augment', '.agents']
# 合法点目录基线（系统/语言工具/AI 工具运行时）。新增点目录会被 lint 抓到供审查——防 agent 用 .xxx/ 绕过
allowed_dot_dirs: ['.Trash', '.aliyun', '.boss-agent', '.bun', '.bytertc', '.cache', '.cargo', '.cc-airplayer', '.cc-switch', '.cola', '.coli', '.conda', '.config', '.cups', '.deepface', '.hermes', '.kaggle', '.keras', '.lark-cli', '.letta', '.lnmem', '.local', '.matplotlib', '.mem0', '.modelscope', '.npm', '.obsidian', '.ollama', '.omlx', '.omp', '.openclaw', '.opencli', '.openpencil', '.pg0', '.promptfoo', '.rhinocode', '.sogouinput', '.ssh', '.streamlit', '.swiftpm', '.tmux', '.zsh', '.zsh_sessions']
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

## 三·补、AI Ops 运维服务器 SSH 接入（cc / codex / grok 三方共用 · 2026-07-25 加固后实测）

> 川哥要求：**cc、codex、grok 三个引擎都要能顺利连上这台机器维护 aiops**。三者在本机同以 `Rayman.Chen` 用户运行，**共享同一份 `~/.ssh/config` 与 `~/.ssh/id_ed25519`**，因此下面的连法对三方完全一致，不需要各自配密钥。

**机器**：`racknerd` = `23.226.135.149`（RackNerd 美西 1C/2G/39G，Ubuntu 24.04）
**跑什么**：AI Ops 驾驶舱 9 个 docker 容器（ops-caddy / ops-inspector / ops-terminal(ttyd) / ops-n8n / ops-auth / ops-netdata / ops-uptime-kuma / ops-dockge / ops-homepage），根目录 `/opt/ai-ops-cockpit`。配套 skill：`ai-ops-cockpit`。

**连法（两条路径，都已实测通）**：

```bash
ssh racknerd                                              # 默认，经 mini-pub 跳板（更稳）
ssh -o ProxyJump=none -i ~/.ssh/id_ed25519 root@23.226.135.149   # 兜底直连
```

- 默认路径走 `ProxyJump mini-pub`（`cli4.hahaxiong.cc:22022` → aliyun-hk frps → Mac Mini）。
  ⚠️ **这条链路依赖 aliyun-hk 的 frps + Mac Mini 开机**；任一不可用就改走上面的直连兜底（直连偶发 banner 超时，重试即可）。
- **认证只有公钥一条路**：2026-07-25 已关闭密码登录与 root 密码登录（改前取证：近 60 天 1444 次成功登录 **100% publickey、密码 0 次**）。`/root/.ssh/authorized_keys` 只有一把 `id_ed25519`（`Rayman.Chen@RaymanMacBook-Air.local`）。
- **装了 fail2ban**（sshd jail，5 次失败封 2 小时）。连不上先想「是不是自己被 ban 了」：
  `fail2ban-client status sshd` 看封禁列表，`fail2ban-client set sshd unbanip <IP>` 解封。
- ⚠️ **别在这台机器上跑 `pkill -f <pattern>`**：pattern 会匹配到自己那条 ssh 命令行导致自杀，改用 `pgrep` + `kill` 或 `fuser -k <PORT>/tcp`。

**磁盘**：2026-07-25 清理后 49%（曾 71%）。两个会自己长的地方已设防——journald 已限 `SystemMaxUse=500M`；docker build cache 需**定期手动清**（`docker builder prune -af`，上次积了 5.59GB）。⚠️ 容器日志尚未设 `max-size` 上限（改 `daemon.json` 要重启全部容器，待川哥给时间窗）。

---

## 四、并发与冲突（多 agent 共存铁律）

- **git 提交权归 cc 独占**：其他 agent 不直接 commit `mycc` / `.mycc-global`，改动交 cc 收口提交（防 git index lock 竞态）。
- **写共享文件先读后写**：改 `0-System/*` / memory / 共享脚本前，先读当前内容，**不覆盖他人或人工内容**;批量写用锁文件。
- **冲突即停**：发现并发写冲突或不确定归属 → **STOP 询问**，不自行覆盖。
- **并行隔离**：并行任务各用 git worktree / 独立 `/tmp`，不在主 checkout 混不相关改动。

---

## 五、守护与接线（本宪法如何被强制执行）

**接线（各 agent 强制读到本文件，不靠自觉）**：

| agent | 接线方式 | 机制 |
|-------|---------|------|
| cc | `~/.claude/rules/home-constitution.md`（指针文件） | rules 目录自动加载 |
| codex | `ln -s ~/AGENTS.md ~/.codex/AGENTS.md` | codex 全局读 `~/.codex/AGENTS.md` |
| gemini | `~/.gemini/AGENTS.md` 顶部加引用段 | gemini settings `context.fileName` 已自动加载该文件 |
| grok | omp 编排脚本 prompt 注入本文件 | grok 无项目规则文件机制（`~/.grok/README.md` 是产品文档，勿改） |
| omp | 编排脚本模板注入本文件引用 | 脚本层 |

**新 agent 入场握手 checklist**：① 在 §二 YAML `agent_cfg` 加配置目录 ② 按上表接线 ③ 纳入 HOME-lint ④ 确认 secret / 归档 / 并发规则已传达。

**检测**：
- HOME-lint（`~/mycc/4-Assets/scripts/home-lint-structure.sh`）解析 §二 YAML 白名单查顶层散落，应用 `lint_ignore_globs` 过滤;cron 或各 agent Stop hook 触发。
- 支持 PreToolUse 的工具（cc 确定）硬拦在 HOME 根的写入;其余靠铁律 + lint 兜底。
