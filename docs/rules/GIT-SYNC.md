# Git 同步规则（多机多智能体共享仓）

> 2026-11-17 生效。背景：`mycc` 在 home-studio 曾三个月没 pull，累积成「本地 54 提交 vs 远端 537 提交」的分叉，
> 合并花了半天。这份规则的目的就是让任何 agent 都不再把仓拖成分叉。

适用仓库：`mycc`、`MyAgent`、`home-lan`、`.mycc-global` 以及其他多机共享仓。

## 分支执行规则（2026-11-19）

适用于所有有 Git 写权限的智能体。负责人指派任务时确定仓库、目标目录和交付物。分支、提交和 PR 的授权范围随任务走。其他电脑同步本文件时，直接使用仓库里的这一份作为执行文档。

| 节点 | 执行动作 | 验收记录 |
|---|---|---|
| 开工 | 同步仓库，查远端分支、打开的 PR 和已有任务。一个任务用一个主分支，换智能体或电脑时复用。独立发布或确需并行才另开，记录原因、工作树所在机器和交接人。 | 任务单写清任务、目录及分支。维护只读巡检的仓库同时更新分支登记。 |
| 推送 | 在授权范围内可普通推送任务分支。合入前重新读取远端，核对合入目标与候选提交的完整差异，包括删除、重命名及混入的其他项目文件。记录测试命令、退出码和遗留项。多人并行、跨项目或生产发布分支的合入走 PR；单人、单项目的小改可沿用普通快进。混入其他项目的改动先拆出。 | 在最新基线上运行 `git diff --name-status origin/main...HEAD`，再检查实际合入结果相对原 main 的差异；回执带提交或 PR 链接。 |
| 发版 | 每个独立运行组件分别登记实机产物 SHA256、实际构建或源码快照的完整提交、可找回该提交的远端引用、维护分支和取证方式。分支 HEAD 前移后仍能定位旧发布物。源码模式运行的服务写明文件清单及摘要算法。 | 从实机重新采样，与发布记录逐组件核对。维护分支和实际发布提交可不同。未知发布保留现场，列入巡检。 |
| 收工 | 写清“已合入并清理”“已打标签归档”或“继续保留”。保留项写原因与下次处理条件。查原机工作树、暂存区、未跟踪文件、在途任务和打开的 PR。归档前按授权核对分支头、以 `archive/YYYY-MM/<原分支名>` 打标签推送，回读完整 SHA；删除时校验服务端当次通告的旧 SHA，删除后再次回读标签和剩余分支。 | 本地未提交内容另做私密保全，记录原 HEAD、相对路径、文件模式和 SHA256；恢复到独立目录比对。原工作树及会话另行处理。巡检发现例外只报告，归档仍按用户授权执行。 |

### 接手和交付

1. **任务登记**。mycc 使用 `tasks/git-branch-register.json`。分支键为完整远端分支名；`task` 写具体任务或任务单，`state` 使用 `active`（在做）、`done`（已完成待清理）、`keep`（明确保留）或 `archived`（已归档）。`keep` 填 `until`。登记随任务单更新，巡检按默认分支上已发布的登记判断；准备中的变更可以显式传 `--registry` 预检。
2. **发布登记**。每个组件在 `releases` 登记 `source_commit`、`source_ref`、`maintainer_branch` 和 `sha256`。在 `proof` 指向不可变的构建证据（提交及 JSON 文件、组件字段、摘要字段），静态文件可直接指向源码提交与文件路径；SHA 必须来自发布实物或已核验的发布清单。P003 的采样范围是 hk2 运行中的语音 worker 进程、阿里云 PM2 服务端发布清单的 245 个文件、以及管理后台入口 HTML。服务端按相对路径排序，逐项拼接 UTF-8 路径、零字节、文件 SHA256 的 32 个原始字节，再取整体 SHA256；发布范围变化时一并更新采样清单。
3. **只读巡检**。在仓库根运行 `python3 -B 4-Assets/scripts/git-branch-audit/audit.py --p003-live`。home-studio 每日 09:45 由用户级 timer 执行；查记录用 `journalctl --user -u git-branch-audit.service -n 60`。其他机器可使用 `--observed <文件>` 传入取自实机的 JSON，格式为 `{"at":"带时区的采样时间","components":{"组件名":"SHA256"}}`。个人语音组件在登记中使用 `scope: personal-voice`；其独立采样 JSON 增加 `"scope":"personal-voice"`。每日 `--p003-live` 只核 P003 的实机指纹，同时核对全部组件的发布证据和远端来源。未指定范围的样本须覆盖全量发布。不带实机样本时，发布部分报告未验。本地缺少最新默认分支对象时，GitHub 仓库可经已登录的 gh 只读获取登记或核验祖先关系。取证对象缺失且未能验证时，会显式报错。
4. **看结果**。逐分支对照线上 refs 与任务登记，列出无任务、任务已完成但分支仍在的例外；逐组件对照实机指纹、维护分支、发布提交能否从远端引用找回。返回 0 表示核验通过，1 表示有待处理项，2 表示无法完成核验。巡检只读取资料，不会推送、删分支、改工作树或部署。
5. **跨机同步**。其他电脑在已授权的工作区同步 mycc，将其 Claude、Codex、Grok、Gemini、Hermes、Cursor、DSH 等实际使用的全局或项目入口指向 `~/mycc/docs/rules/GIT-SYNC.md`。其他位置检出仓库时使用其实际路径。新会话中核对可读取的规则；每套生产环境指定一台机器定时采样即可。

## 一、日常同步与并发规则

1. **开工先同步**：改任何文件前先 `git pull --rebase --autostash`。拉不动（冲突/网络）就先停下报告，不要在旧基线上继续写。
2. **小步提交、当日推送**：一个任务一个提交，做完就 `git push`；领先远端超过 3 个提交就必须推，不许攒。
3. **长任务用 worktree**：预计超过半天、或需要长时间保留未提交改动的任务，用
   `git worktree add .worktrees/<slug> -b <branch>` 另开工作树，不在主 checkout 上堆几十个未提交文件。
4. **永不改写远端**：禁止 `push --force`、`--force-with-lease`、`reset` 远端分支、`filter-branch`。
   远端历史只允许快进追加。

## 二、收工前的自检

```bash
git status -sb        # 当前分支与它自己的远端 upstream 核对
git log --oneline @{u}..HEAD   # 应为空
```

有 ahead → 先 push；有 behind → 先 pull --rebase；两边都有 → 说明已经分叉，进入第三节。

## 三、发现分叉怎么办（STOP，不要自行 force）

判据：主线在 main 上比较 `origin/main...HEAD`，已发布任务分支比较自己的 `@{u}...HEAD`。两侧均非 0 代表同一分支本地与远端分叉；任务分支相对 main 的独立开发历史按上面的合入规则审核。

1. **先备份**：`git branch backup/<repo>-$(date +%Y%m%d) HEAD`，再
   用 `git bundle create <本机已确认的备份目录>/<repo>-YYYYMMDD.bundle --all` 备份。home-studio 按存储规则核实 /data 已挂载后使用数据盘；其他电脑使用各自的持久备份目录。
2. **判断重叠**：`git cherry -v origin/main HEAD`，`-` 开头是远端已有的等价补丁，只剩 `+` 的才是真独有。
3. **在临时工作树合并**，不要动主工作树（尤其它还脏着）：
   ```bash
   git worktree add /tmp/<repo>-merge origin/main -b sync/<repo>-$(date +%Y%m%d)
   cd /tmp/<repo>-merge && git merge --no-ff main
   ```
   仓库里有超过 ext4 255 字节文件名时，用 `git worktree add --no-checkout` +
   `sparse-checkout set --no-cone '/*' '!/超长目录/**'` 再 checkout。
4. **冲突按内容处理**，不要一把 `--ours/--theirs`：文档取并集，脚本/配置按日期取新，改完 `bash -n`/`python -m json.tool` 自检。
5. 推送：先推 `sync/<repo>-...` 分支，再快进远端
   `git push origin sync/<repo>-...:main`（远端是祖先才能成功；失败就停）。
6. 主工作树收口：`git stash push -u` → `git merge --ff-only origin/main` → `git stash pop`，
   逐字节核对恢复情况后再删 stash。

## 四、几个坑（实测）

- **长文件名**：仓库里存在超过 255 字节的文件名，Linux ext4 上完整 checkout 会失败；用 sparse-checkout 排除该目录。
- **脏工作树**：在主 checkout 里 rebase 会连同别人的未提交改动一起滚动，一律用临时工作树合并。
- **`git status -sb` 不显示 ahead/behind**：说明本地分支没设 upstream；先 `git branch --set-upstream-to=origin/<同名分支> <本地分支>`。
- **另一个 agent 正在写**：`git status` 里出现刚改过的文件就先停，等它收口（冲突即停原则）。

## 五、健康检查

```bash
bash ~/mycc/4-Assets/scripts/git-sync-health.sh          # 只读，检查 mycc / MyAgent / home-lan
bash ~/mycc/4-Assets/scripts/git-sync-health.sh --fetch  # 先 fetch 再比
```

输出 `OK` / `AHEAD n` / `BEHIND n` / `DIVERGED a/b` / `DIRTY n`。发现 `AHEAD` 超过 3 或 `DIVERGED` 就按本文处理。
