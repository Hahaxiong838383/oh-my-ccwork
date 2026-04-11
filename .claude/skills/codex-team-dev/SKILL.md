---
name: codex-team-dev
description: Agent team 并行开发模式 — cc 主线写代码 + codex adversarial-review 后台对抗审查 + Explore agent 并行抽 pattern。数据层/跨层契约/暴露给外部工具前的必经门控。触发词："agent team"、"并行开发"、"codex 协助"、"并行 codex"、"/codex-team-dev"
layer: 编排层
authorization: B区（需要用户确认 scope 后执行）
output_levels: L2（结构化工作流报告）
---

# codex-team-dev — Agent Team 并行开发模式

> cc 主线顺序写代码，同时在后台跑 codex adversarial-review 和 Explore agent，形成"写-研究-审查"三轨并行的工作流。
> 不是一次性代码审查，是一整套**数据层 / 跨层契约代码暴露前的质量门控流程**。

## 触发词

- `/codex-team-dev`
- "开 agent team / 启动 agent team / agent team 模式"
- "codex 协助写代码 / codex 协助审查 / 找 codex 一起干"
- "并行开发 / 并行审查 / 多 Agent 协同"
- "用你那套 [codex 对抗审查的] 工作流"

## 触发时机（必须走）

- 写**新数据层模块**（新 DB / 新 schema / 新 store）
- 写**跨层契约代码**（service layer / adapter / serializer）
- 写**schema 变更 / 迁移代码**（ALTER / 自动迁移函数）
- 把模块**首次暴露给外部**（MCP tool / HTTP API / RPC endpoint / CLI）
- **并发敏感代码**（in-flight promise / mutex / event loop lifecycle）

## 不触发场景

- 纯 UI 改动 / 样式调整
- 文档 / 注释 / README 更新
- 纯 refactor（无行为变化）+ 已有完整测试覆盖
- Hotfix 紧急时段（先修后审）

---

## 全局默认配置

**继承 `codex-adversarial-review` 的 codex 默认值**：

| 配置项 | 值 |
|--------|----|
| `model` | `gpt-5.4` |
| `model_reasoning_effort` | `xhigh`（从 `~/.codex/config.toml`） |
| `service_tier` | `fast` |

启动前自检：
```bash
grep -E "^(model|model_reasoning_effort|service_tier)" ~/.codex/config.toml
```

---

## 标准工作流（6 步）

### Step 1 — cc 主线：输出 P1，等川哥确认

**必须**先输出任务拆解 + scope + schema + API surface，等确认再动手。

模板：
```markdown
## P1 任务拆分（{task_name}）

### Scope（Phase N only，不做 X/Y/Z）
- {bullet points}

### Schema / API
- {核心数据结构 / 函数签名}

### Agent Team 并行分工
| Agent | 任务 | 并行度 |
|---|---|---|
| cc 主线 | {顺序步骤} | 主 |
| Explore agent | {研究主题} | 后台并行 |
| Codex adversarial-review | {审查点} | 最后一步 |

### 交付门（Verify + Guard）
1. tsc --noEmit exit 0
2. 单元测试全 pass
3. codex verdict=approve 或 findings 全部 LOW

### 不做
- {明确排除项}
```

### Step 2 — 主线动手前，**立即**派 Explore agent（早期启动）

**关键教训**：Explore 越早越好。cc 写代码的时候 Explore 在后台跑，回来时给 cc 做"设计验证"+"pattern 复用建议"。

**Agent tool 调用模板**：
```javascript
Agent({
  description: "Collect pattern references",
  subagent_type: "Explore",
  run_in_background: true,
  prompt: `我要在 {path} 新建 {module}。读以下参考：
- {file1} — 抽取 {pattern1}
- {file2} — 抽取 {pattern2}
- {file3} — 抽取 {pattern3}

输出要求（≤ 800 字）：
1. {pattern1} 的完整代码片段
2. {pattern2} 的使用场景
3. {pattern3} 是否有坑

不要写任何代码，只给 pattern 摘要。`
})
```

**不要**让 Explore 写代码，它写的代码和 cc 主线会冲突。**只让它做研究**。

### Step 3 — cc 主线写代码 + tsc + 单测 + commit

- 写代码 → `npx tsc --noEmit` exit 0 → 写 `node:test` 单元测试 → `npx tsx --test` 全 pass
- `git add` **精确**加文件（不 `-A`，不吞 pre-existing dirty）
- `git commit` 带详细 message（including codex 反馈会基于 commit diff 审查）

### Step 4 — commit 后**立即**派 codex adversarial-review（后台）

**Bash 工具调用模板**（`run_in_background: true`）：
```bash
node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" \
  adversarial-review \
  --model gpt-5.4 \
  --background \
  --scope working-tree \
  "质疑 {commit_short_hash} 的 {module}。
背景：{1 句话}
关键设计（{N} 条）：① {decision1} ② {decision2} ...
请挑战：
1) {dimension1}
2) {dimension2}
3) {dimension3}
输出 HIGH/MEDIUM/LOW 风险清单。"
```

**Prompt 铁律**：
- **≤ 500 字**，codex xhigh 在长 prompt 下会卡死/超时（曾观察 2m21s 中断）
- 结构化：commit 简述 → 设计决策 → 挑战维度 → 输出格式
- 不要喂完整代码（codex 会自己读 git diff）
- 不要让 codex 写 fix（它会越界）

### Step 5 — 门控判定

等 codex 后台任务完成（会收到 task-notification），读 output：

```bash
# 检查 codex 任务状态
node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" status

# 读 task output（task-id 从后台 Bash 启动时获得）
cat /private/tmp/claude-501/.../tasks/{task-id}.output
```

| codex verdict | 动作 |
|---|---|
| `approve` / 全 LOW | ✅ 通过，进下一阶段 |
| `needs-attention` + 有 HIGH | 🔴 **必须修**，不能 skip |
| `needs-attention` + 只 MEDIUM | 🟡 评估：结构性缺陷立即修；边界 case 记 TODO |
| task failed/timeout | ⚠️ 重新提交（prompt 精简）或 cc 自行评估关键维度 |

### Step 6 — 修复 + 再测试 + 提交修复版

- 按 finding 精确定位 + 写 fix
- **同步更新测试断言**（测试可能固化了错误行为，比如 softDelete 返回 false）
- 重跑 tsc + tests，全绿才 commit
- commit 命名带 `.1`/`.2` suffix（比如 `v0.14 Phase 1.1`），不升主版本号

---

## 示例：完整一次 codex-team-dev 流程

**场景**：brain v0.14 Phase 1 brain-wiki 数据层（本 skill 的首次实战案例）

```
[22:00] 川哥：开始 v0.14 Phase 1，用 codex-team-dev 模式

[22:05] cc：输出 P1（scope + schema + API + 加固原则 + 并行分工）
        等川哥确认

[22:10] 川哥：✅ go

[22:11] cc 并行启动：
        - Agent(Explore) "读 knowledge/store.ts + memory-db.ts 抽 pattern"
        - cc 主线写 src/wiki/types.ts

[22:15] cc 写 src/wiki/store.ts（独立设计，不等 Explore）

[22:30] cc 写 src/wiki/store.test.ts + tsc + test
        21/23 pass，2 fail（FTS5 external content 踩坑）

[22:35] cc 换 contentless → 6/23 fail（更糟）
        换 regular → 23/23 pass ✅

[22:40] cc commit 7679582 + 立即派 codex adversarial-review
        （task bwjr3ftm0，background）

[22:50] Explore agent 返回（ae8299...），cc 对比设计验证
        没有新 pattern 要加，作为 Phase 2 参考

[00:30] codex 完成（verdict=needs-attention，3 条 findings）：
        HIGH-1 openWikiDb 资源泄漏
        HIGH-2 FTS CJK 单字污染
        MEDIUM-1 softDelete 非幂等

[00:40] cc 修 3 个 fix，23/23 仍绿
        commit 7f90412 (Phase 1.1)

[00:55] 任务完成，更新 memory + 归档 qb + push
```

---

## 反模式（DON'T）

1. ❌ **commit 前让 codex 看**：没有 diff 无法 reviewable，codex 会拒绝
2. ❌ **跳过 codex 直接 deploy**：production hazard 会在暴露后爆炸
3. ❌ **长 prompt 喂 codex**：xhigh 超过 500 字会卡死 / 超时
4. ❌ **盲信 codex 假设**：v0.13.3 codex 曾假设"生产 triggers 存在"，cc ssh 查证为空，假设错
5. ❌ **让 Explore 和 cc 写同一文件**：分工要不重叠
6. ❌ **Explore 启动太晚**：代码写完才启动，结果回来时只能做"设计验证"
7. ❌ **codex 发现 HIGH 不修硬发版**：这是 production hazard，不能用"时间紧"当借口

---

## 关联 skill

| skill | 关系 |
|---|---|
| `codex-adversarial-review` | 本 skill 的核心子步骤（Step 4） |
| `codex-status` | 查 codex 后台任务进度 |
| `codex-result` | 读 codex 最终 findings |
| `codex-cancel` | 取消卡死的 codex 任务 |
| `codex-review` | 普通代码审查（比 adversarial 更温和） |
| `agent-orchestration` | 更上层的多 Agent 编排，本 skill 是 "数据层/契约代码" 的专门子集 |
| `brain-review` | brain 项目纲领对齐自检（大改前必跑） |
| `investigate` | 系统化根因调查框架 |

---

## 和 `codex-review` / `codex-adversarial-review` 的边界

- **codex-review**：只跑 codex 审查，不管前置步骤
- **codex-adversarial-review**：只跑对抗审查，不管前置步骤
- **codex-team-dev**（本 skill）：**完整工作流**，包括 P1 确认、Explore agent 早期启动、主线写代码、commit、codex 审查、修复、再提交
- 如果用户只说"给这个 PR review 一下"→ 用 `codex-review`
- 如果用户说"挑战一下这个方案"→ 用 `codex-adversarial-review`
- 如果用户说"用 agent team 写"或"和 codex 一起干"→ 用本 skill

---

## 案例库

- **v0.14 Phase 1 → Phase 1.1**（2026-04-12，首次完整实战）
  - cc 主线：`src/wiki/` 898 行 + 23/23 tests
  - Explore agent（后台）：收集 knowledge/store.ts + memory-db.ts pattern
  - codex adversarial-review（后台）：task `bwjr3ftm0`，3 条 HIGH/MEDIUM findings，verdict=needs-attention → 全部修复 → Phase 1.1
  - 归档：Queen brain `3-笔记与文章/研究整理`
  - 完整记录见 `feedback_codex_team_dev.md` + `feedback_db_migration_hardening.md`

- **v0.13.3 items schema 漂移**（2026-04-11）
  - codex task `brplyyygk`：被中断超时，partial 假设"生产有 triggers"被 cc 独立 ssh 查证否定
  - 教训：**codex 高置信度假设也要独立事实核验**

---

## 输出规则

- Step 1 P1 输出：让用户可以一眼看懂 scope / schema / 并行分工
- Step 5 codex 结果：保留 severity / file path / line numbers / recommendation
- Step 6 修复后的 commit：message 里明确标注 "吃 codex 对抗审查 X 条 findings"
- 最终汇报：包括 commit hash / tests 状态 / codex verdict / 下一步建议

---

署名：cc（claude-opus-4-6[1m]）| 2026-04-12 01:05 CST
