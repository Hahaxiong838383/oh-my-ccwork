我会按“反驳式架构评审”来回答：先补全并发面，再给推荐架构和备选取舍，最后落到脚本/锁/镜像/集成步骤。## 核心判断

cc 草案方向是对的，但要补一条关键约束：**B 类不能只是 symlink 共享，还必须“禁止直写 + 统一写入口”**。否则 `flock` 只是自愿锁，Claude/脚本直接 `Write/Edit/rsync` 仍会绕过锁。

推荐架构：**A 类用 per-session worktree；B 类用仓外 canonical + symlink 投影 + state gateway 串行写 + hook 拦截直写 + 快照式镜像/部署**。

---

## 数据分类策略

- **A 类：工作产物**
  - 代码、项目文档、普通配置、业务文件。
  - 每 session 可独立修改。
  - 放在 `~/mycc-lanes/<session>/` worktree。
  - 通过主仓集成 merge。

- **B 类：全局状态/记忆**
  - `0-System/MEMORY.md`、`RECENT_EVENTS.md`、`task-log.md`、`status.md`、`blackboard.md`、`vector-health.json`。
  - `~/.claude/.../memory/` canonical 记忆卡、索引。
  - 镜像、索引、consolidate 产物。
  - **不参与 lane 分叉，不靠 merge 解决**。
  - 放仓外 canonical，所有写入经 `cc-state` 串行。

---

## 推荐架构

### 1. `~/mycc`：只作为集成主仓

- 用户不直接在 `~/mycc` 日常工作。
- wrapper 启动时自动分配 lane：
  - `~/mycc-lanes/<session-id>/`
  - 从主分支创建/复用 git worktree。
- A 类改动只发生在 lane。
- 集成由 wrapper 或后台 integrator 执行：
  - 检查 lane diff。
  - rebase/merge 到 `~/mycc`。
  - 只处理 A 类文件。
  - B 类路径永远不作为 lane diff 集成对象。

### 2. `0-System/`：从 repo 内容改成共享投影

建议 canonical 放：

```text
~/.cc-state/mycc/0-System/
```

lane 内：

```text
~/mycc-lanes/<lane>/0-System -> ~/.cc-state/mycc/0-System
```

主仓内也可以是同样 symlink，或完全忽略该路径。二选一：

- **方案 A：保留路径兼容性**
  - `0-System` 在 git 里变成 symlink。
  - 优点：旧路径不变，工具少改。
  - 缺点：`git archive` 只会打包 symlink，不会带真实内容，部署必须额外 overlay 快照。

- **方案 B：从 git 删除并 ignore**
  - `0-System/` 不再是仓库管理内容。
  - wrapper 在每个 lane 创建 symlink。
  - 优点：语义最干净，不会污染 merge。
  - 缺点：依赖 wrapper/bootstrap 保证路径存在。

我更推荐 **方案 B**。如果历史兼容压力大，用方案 A 过渡。

### 3. `~/.claude/.../memory/`：继续作为唯一 canonical

不要给每个 lane 独立 memory。保持：

```text
~/.claude/.../memory/
```

作为 arch-v1 唯一真源。

所有 session 读写同一份 memory，但写入必须经过：

```text
cc-state memory append
cc-state memory write-card
cc-state memory update-index
cc-state memory consolidate
```

内部统一拿锁：

```text
~/.cc-state/locks/memory.lock
~/.cc-state/locks/0-system.lock
~/.cc-state/locks/claude-git.lock
```

关键点：**memory 写、索引更新、git add/commit、镜像生成必须在同一把 memory/claude 锁下完成**，否则会出现“卡片写了但 INDEX 旧”“INDEX 更新但 git 状态半截”的撕裂。

### 4. 镜像 rsync：从“手动同步”改成“只读快照生成”

现在的 `~/.claude -> ~/mycc/.claude/.../memory/` 手动 `rsync -a` 是高风险点。

改成：

- canonical 永远是 `~/.claude/.../memory/`。
- `~/mycc/.claude/.../memory/` 不再是源。
- 镜像只由脚本生成：
  - `cc-state snapshot memory --target ~/mycc/.claude/.../memory`
  - 或部署时生成到临时目录。
- snapshot 流程：
  - 拿 `memory.lock`。
  - rsync 到临时目录。
  - 校验索引。
  - atomic rename/replace。
  - 释放锁。
- 禁止 lane 内手动 rsync 到镜像目录。

也就是说：**镜像是 artifact，不是 editable source**。

---

## 并发面处理表

| 并发面 | 推荐处理 |
|---|---|
| `~/mycc` working tree | 不作为日常工作区，只做集成主仓 |
| `~/mycc-lanes/<id>` | 每 session 独立 worktree，承载 A 类改动 |
| `~/mycc/0-System` | 移出 git，变成 `~/.cc-state/mycc/0-System` 的 symlink/投影 |
| lane 内 `0-System` | 同一个 symlink，所有 lane 看到同一份真源 |
| `0-System/*.md/json` 写入 | 通过 `cc-state`，按文件或目录 `flock` 串行 |
| `~/.claude/.../memory` | 保持唯一 canonical，不随 lane 分叉 |
| memory cards/index | 通过 `cc-state memory` 写入，同锁保护 card + index |
| `.consolidate-lock` | 保留，但升级为 gateway 内部锁，不只保护 consolidate |
| memory mirror | 停止手动 rsync，改成锁内快照 artifact |
| `~/.claude` git repo | 所有 git 操作拿 `claude-git.lock`，避免 index 并发 |
| deploy archive | A 类用 `git archive`，B 类用锁内 snapshot overlay |
| 主仓集成 merge | 只 merge A 类；B 类不进入 lane diff |

---

## 需要补查的遗漏并发点

除了 cc 列出的 5 个，我会重点补查这些：

- **`~/.claude` 非 memory 文件**
  - `settings.json`、hooks、MCP 配置、session metadata、logs。
  - 如果 wrapper 会改 settings/hooks，也必须拿 `claude-config.lock`。

- **Claude transcripts / project metadata**
  - 常见在 `~/.claude/projects/...`。
  - 多 session 可能追加 transcript、todo、cache。
  - 通常不需要进 git，但要避免脚本清理/rsync 覆盖。

- **vector/index 数据库**
  - 如果 `vector-health.json` 背后有 sqlite/faiss/chroma/lancedb 等文件，必须按数据库粒度锁。
  - JSON health 文件锁不等于向量库安全。

- **git index 并发**
  - `~/mycc` 主仓集成时只能单写者。
  - `~/.claude` repo 的 `git add/commit/status` 也要串行。
  - worktree 解决工作区，不自动解决共享 repo metadata 的并发操作。

- **后台任务**
  - consolidator、indexer、watcher、cron、deploy、mirror。
  - 全部必须走同一个 lock namespace，否则会绕过架构。

- **部署目标目录**
  - 如果多个 session 都能 deploy，部署也必须单写者。
  - 推荐 `deploy.lock` + atomic release directory。

---

## 对 cc 草案的修正

cc 草案：

> worktree 隔 A + symlink 共享 B + flock 串行

我会改成：

> worktree 隔 A + B 仓外 canonical + symlink 只读/投影 + gateway 强制写 + hooks 阻断直写 + snapshot artifact + 单写者集成

原因：

- 只靠 symlink：解决 merge 冲突，但不解决并发写撕裂。
- 只靠 `flock`：直接 `Write/Edit/rsync` 会绕过锁。
- 只靠 append-only：对 `status.md`、索引、JSON、memory INDEX 不够。
- 只靠单写者进程：一致性最好，但工程量和可用性成本更高。

推荐中间态：**脚本 gateway + hook guard**，低摩擦、足够强。

---

## 落地步骤

1. **建立 canonical state**
   - 创建 `~/.cc-state/mycc/0-System/`。
   - 从 `~/mycc/0-System/` 迁移当前文件。
   - 创建 `~/.cc-state/locks/`、`~/.cc-state/journal/`。

2. **从 lane diff 中移除 B 类**
   - `0-System/` 从 `~/mycc` git 管理中删除或改 symlink。
   - `.gitignore` / `.git/info/exclude` 排除本地投影。
   - 集成脚本拒绝提交 B 类路径。

3. **wrapper 自动初始化 lane**
   - 创建/复用 worktree。
   - 在 lane 内创建 `0-System -> ~/.cc-state/mycc/0-System`。
   - 如果需要 memory mirror 路径，也创建只读 symlink 或 snapshot 目录。
   - 注入环境变量：`CC_SESSION_ID`、`CC_LANE`、`CC_STATE_ROOT`。

4. **实现 `cc-state` gateway**
   - `append-event`
   - `append-task-log`
   - `update-status`
   - `memory-write-card`
   - `memory-update-index`
   - `memory-consolidate`
   - `snapshot-memory`
   - 所有命令内部 `flock` + temp file + atomic rename。
   - 每次写入 journal：session、timestamp、target、hash。

5. **配置 hooks 防直写**
   - Claude Code `PreToolUse` 拦截 `Write/Edit/MultiEdit`。
   - 如果目标匹配：
     - `*/0-System/*`
     - `~/.claude/**/memory/**`
     - `*/.claude/**/memory/**`
   - 则提示必须使用 `cc-state`。
   - `cc-state` 自己通过环境变量白名单放行。

6. **替换手动 rsync**
   - 禁止直接 `rsync -a ~/.claude .../memory`。
   - 提供 `cc-state snapshot memory`。
   - snapshot 在锁内生成，只作为 artifact。

7. **串行化 git 操作**
   - `~/mycc` 集成使用 `integration.lock`。
   - `~/.claude` git 操作使用 `claude-git.lock`。
   - memory 写 + index + git add/commit 尽量在同一事务命令里完成。

8. **部署改成双输入**
   - A 类：从主仓 `git archive`。
   - B 类：从 canonical state 锁内生成 snapshot。
   - 最终 release 目录 atomic switch。

---

## 最终建议

采用 **“A 分叉，B 不分叉”** 作为总原则：

- A 类让 git worktree/merge 处理。
- B 类彻底退出 worktree merge 模型。
- memory 保持 `~/.claude` 单一 canonical。
- `0-System` 迁移到仓外 canonical。
- 镜像只作为快照产物，不再手动双向同步。
- wrapper + hooks + `cc-state` 让用户日常零命令。
