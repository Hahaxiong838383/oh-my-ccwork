# Git 同步规则（多机多智能体共享仓）

> 2026-11-17 生效。背景：`mycc` 在 home-studio 曾三个月没 pull，累积成「本地 54 提交 vs 远端 537 提交」的分叉，
> 合并花了半天。这份规则的目的就是让任何 agent 都不再把仓拖成分叉。

适用仓库：`mycc`、`MyAgent`、`home-lan`、`.mycc-global` 以及其他多机共享仓。

## 一、四条硬规则

1. **开工先同步**：改任何文件前先 `git pull --rebase --autostash`。拉不动（冲突/网络）就先停下报告，不要在旧基线上继续写。
2. **小步提交、当日推送**：一个任务一个提交，做完就 `git push`；领先远端超过 3 个提交就必须推，不许攒。
3. **长任务用 worktree**：预计超过半天、或需要长时间保留未提交改动的任务，用
   `git worktree add .worktrees/<slug> -b <branch>` 另开工作树，不在主 checkout 上堆几十个未提交文件。
4. **永不改写远端**：禁止 `push --force`、`--force-with-lease`、`reset` 远端分支、`filter-branch`。
   远端历史只允许快进追加。

## 二、收工前的自检

```bash
git status -sb        # 第一行必须是 ## main...origin/main（无 ahead/behind）
git log --oneline @{u}..HEAD   # 应为空
```

有 ahead → 先 push；有 behind → 先 pull --rebase；两边都有 → 说明已经分叉，进入第三节。

## 三、发现分叉怎么办（STOP，不要自行 force）

判据：`git rev-list --left-right --count origin/main...HEAD` 两边都不是 0。

1. **先备份**：`git branch backup/<repo>-$(date +%Y%m%d) HEAD`，再
   `git bundle create /data/home-studio/backups/<repo>-$(date +%Y%m%d).bundle --all`。
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
- **`git status -sb` 不显示 ahead/behind**：说明本地分支没设 upstream；先 `git branch --set-upstream-to=origin/main main`。
- **另一个 agent 正在写**：`git status` 里出现刚改过的文件就先停，等它收口（冲突即停原则）。

## 五、健康检查

```bash
bash ~/mycc/4-Assets/scripts/git-sync-health.sh          # 只读，检查 mycc / MyAgent / home-lan
bash ~/mycc/4-Assets/scripts/git-sync-health.sh --fetch  # 先 fetch 再比
```

输出 `OK` / `AHEAD n` / `BEHIND n` / `DIVERGED a/b` / `DIRTY n`。发现 `AHEAD` 超过 3 或 `DIVERGED` 就按本文处理。
