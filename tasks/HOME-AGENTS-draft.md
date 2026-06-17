# AGENTS.md — 本机 AI 协作宪法（HOME 层 · v1，team 评审后修订）

> **状态**：v1 草稿，待川哥定稿后部署到 `~/AGENTS.md`。
> **适用**：所有在本机 `~` 运行的 AI agent（cc / codex / gemini / grok / omp …）。
> **定位**：HOME 层**单一真源**。进入本机先读本文件，再读各自项目级规则（如 `mycc/CLAUDE.md`）。
> **边界（防漂移）**：本文件只放**此处独有**的东西——HOME 白名单、接线、并发规则。其余一律**指针、不复制**（归档/记忆/身份格式见 `mycc/CLAUDE.md` 与各 agent 入口）。

---

## 一、铁律（共同遵守）

1. **不在 HOME 根乱建**：禁止在 `~/` 新建文件 / 目录;新内容进 `~/mycc/` 对应子目录;不确定 → `~/mycc/1-Inbox/`;临时产物用 `/tmp/`。
2. **进 mycc 后按其规则归档**：见 `mycc/CLAUDE.md §5`（写入任何目录前先读其 `README`）。
3. **安全**：secret 不硬编码 / 不入 git / 不入记忆 → 集中 `~/.mycc-secrets.env`(非 git, 600) 或 Keychain，只存指针;他人数据 → `work-private/`(禁外派 / 禁 git / 禁 memory);发现硬编码 secret → **STOP + 告警**。

---

## 二、HOME 目录白名单（lint / hook 的唯一机器可读单源）

```yaml
# allowed_home_roots — 合法顶层目录，agent 不得新增同级目录/文件
# 铁律只约束 agent 主动行为；第三方工具/系统自动生成的点文件由 lint_ignore_globs 排除
system:    [Applications, Desktop, Documents, Downloads, Library, Movies, Music, Pictures]
core:      [mycc, .mycc-global]          # PKM 中枢 + 外置共享状态
private:   [work-private]                # 隐私 vault
runtime:   [bin, local, go, models, nltk_data]
legacy:    [cc-monitor-oss, lnmem-data, xray, scripts, Archive, iterm2-logs]  # 历史例外：保留，禁新增同类
agent_cfg: ['.claude', '.codex', '.gemini', '.grok', '.windsurf', '.continue', '.augment', '.agents']
lint_ignore_globs: ['.*', '*.lock', '.DS_Store', '.mycc-secrets.env']  # 系统/三方自动产物不告警
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

## 四、并发与冲突（多 agent 共存铁律）

- **git 提交权归 cc 独占**：其他 agent 不直接 commit `mycc` / `.mycc-global`，改动交 cc 收口提交（防 git index lock 竞态）。
- **写共享文件先读后写**：改 `0-System/*` / memory / 共享脚本前，先读当前内容，**不覆盖他人或人工内容**;批量写用锁文件。
- **冲突即停**：发现并发写冲突或不确定归属 → **STOP 询问**，不自行覆盖。
- **并行隔离**：并行任务各用 git worktree / 独立 `/tmp`，不在主 checkout 混不相关改动。

---

## 五、守护与接线（本宪法如何被强制执行）

**接线（各 agent 强制读到本文件，不靠自觉）**：

| agent | 接线方式 |
|-------|---------|
| cc | `~/.claude/rules/` 加一条引用本文件（常驻加载） |
| codex | `ln -s ~/AGENTS.md ~/.codex/AGENTS.md`（补全局入口） |
| gemini | `~/.gemini/AGENTS.md` 顶部 include / 引用本文件 |
| grok | `~/.grok/README.md` 加引用，或 onboard symlink |
| omp | 编排脚本 prompt 注入本文件 |

**新 agent 入场握手 checklist**：① 在 §二 YAML `agent_cfg` 加配置目录 ② 按上表接线引用 `~/AGENTS.md` ③ 纳入 HOME-lint ④ 确认 secret / 归档 / 并发规则已传达。

**检测**：
- HOME-lint（`~/mycc/4-Assets/scripts/`）解析 §二 YAML 白名单查顶层散落，应用 `lint_ignore_globs` 过滤系统/三方点文件;cron 或各 agent Stop hook 触发。
- 支持 PreToolUse 的工具（cc 确定）硬拦在 HOME 根的写入;其余靠铁律 + lint 兜底。

---
> v1 相对 v0 改动（team 评审采纳）：删与 CLAUDE.md §4/§5 重复段改指针;身份去掉写死称呼只留特质锚点;白名单改机器可读 YAML 块 + 系统点文件过滤 + legacy 标注;新增「并发与冲突」铁律(cc 独占 git);接线从"引用"具体化为 symlink/注入 + 入场握手 checklist;角色/记忆收为指针。
