---
name: home-studio-storage-ops
description: 盘点 home-studio 的磁盘/内存资源，把冷数据迁到 /data 并保留原路径软链，扩 zram/swap，核验飞牛备份容量与新鲜度，判断 NAS 空间该不该挂到本机；用于“硬盘满了”“盘够不够用”“迁到 data”“swap 扩容”“备份还有没有余量”。重启前保全转 home-studio-reboot-preservation，重启后验收转 home-studio-boot-maintenance。
---

# home-studio 存储与交换空间运维

适用 `hahaxiong-home-studio`（Ubuntu 24.04，NVMe 根盘 + 单块 2.5″ 机械 `/data`）。裁决顺序永远是：**先测量 → 再判断能不能动 → 六道闸迁移 → 复验**。没有测量就给的“清理建议”一律不算结论。

## 一、先测，但只测该测的

1. 一眼总账：`lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL,ROTA`、`df -hT -x tmpfs -x devtmpfs`、`df -i`。inode 与容量分开看。
2. 大目录用**定点** `du -xhd1 <dir>`，逐层下钻到“能解释 80% 体积”的那一层就停。**不要**对 `/`、`/home`、`/data/home-studio` 这类上百 G 全量 `du` —— 一条命令几十秒到几分钟，会话看起来就是卡死。
3. 内存侧同时取 `free -h`、`swapon --show`、`/proc/meminfo` 的 `MemAvailable`，以及每进程 `VmSwap`（`/proc/<pid>/status`）。swap 用满不等于内存泄漏，先看谁被换出去了。
4. 挂载真实性：`findmnt -no SOURCE,TARGET,FSTYPE,OPTIONS /data`。`/data` 未实际挂载时**停止任何写入**，不在根盘同名目录兜底。

## 二、为什么可以迁、迁什么

判定“能不能迁”只有一条硬标准：**有没有进程把它当成 exe / cwd / 打开 fd / mmap 持有**。

```bash
for p in /proc/[0-9]*; do
  pid=${p#/proc/}; t="$(readlink $p/cwd 2>/dev/null)$(readlink $p/exe 2>/dev/null)"
  case "$t" in *"<目标目录名>"*) echo "PID $pid $(cat $p/comm)";; esac
done
```

- **命中即排除**：跨挂载点迁移 = 复制 + 删源，原 inode 消失；被 mmap 的执行体（node/python/ELF）下次缺页直接 **SIGBUS**，只持有 cwd 的进程不崩但会写进 `(deleted)`。
- 典型豁免名单：`.local/bin`、`.local/lib/rea/runtime`、`uv/python`、`codeg/chat-sessions`（当前会话 cwd）、任何正在跑的调试/探针目录。
- 迁什么：**冷**构建快照、发布包、模型、数据集、训练成果。活跃源码、编译目录、依赖环境、运行数据库留 NVMe。
- 先看体积构成再决定：一个 3.4 G 的 worktree 里 90% 常是 gitignored 的 `build/`（APK、ONNX、GGUF）。这类东西迁到 5400rpm 盘会让**下次构建**明显变慢；如果只是要腾地方，删可重建产物往往比迁移更优。

## 三、迁移六道闸（缺一道就不要删源）

1. **无进程引用**：上面那段 `/proc` 扫描，逐目录确认。
2. **git 干净**：`env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git -C <dir> rev-parse --is-inside-work-tree` 成功后，再看 `status --porcelain --untracked-files=no` 为 0。
3. **复制**：`rsync -aHAX --delete --info=stats2 <src>/ <dst>/`（跟符号链接、保 xattr/ACL/硬链接）。
4. **复验**：`rsync -aHAXn --delete --itemize-changes <src>/ <dst>/` **输出为 0 行**才算一致。
5. **切换**：`rm -rf <src> && ln -s <dst> <src>`。
6. **再验**：经软链重跑第 2 步的 git 检查；失效就 `rm 软链; mv <dst> <src>` 回滚。

迁移后立刻 `df -h / /data` 记账，并把新映射写进 `~/mycc/docs/rules/HOME-STUDIO-STORAGE.md` 的“已完成映射”表 —— 那是本机迁移路径的唯一真源。

## 四、三个会让你得出错误结论的坑（都踩过）

| 坑 | 表现 | 正确做法 |
|---|---|---|
| **git env 中毒** | shell 里有 `GIT_CONFIG_COUNT=1` 却缺 `GIT_CONFIG_KEY_0`，任何 git 命令 `fatal: unable to parse command-line config`；接 `wc -l` 时输出 0，看着像“0 处改动”的假干净 | 所有脚本判定前先 `env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git ...`，并校验 `rev-parse --is-inside-work-tree` 成功 |
| **`diff -rq` 假失败** | 目录里有悬空软链（如 `out`），两侧都报 `No such file or directory` 并返回非零，正确副本被判不一致 | 用第三节的 `rsync -n --itemize-changes` 空跑判等 |
| **`mv` 跨盘 SIGBUS** | 正在运行的 node/python 直接崩 | 迁移前跑第二节的 `/proc` 扫描；先停服务再搬 |

补充：git **worktree** 迁走再用软链指回，git 仍然可用（git 沿软链解析，`worktree list` 仍显示原路径）。别为了“修 git”去重建 worktree。

## 五、swap / zram 分层

优先级只能是 **1–32767**，`-1` 是“自动”的哨兵，所以“把旧 swap 排到后面”必须 `swapoff && swapon -p N`（会把已换出页拉回内存，先看 `MemAvailable`）。

推荐三层（`swap-expand.sh` 已实现）：

| 层 | 设备 | 优先级 | 说明 |
|---|---|---|---|
| 1 | `/dev/zram0`（zstd） | 100 | 内存压缩，2.5–3:1，零磁盘 IO，不占根盘 |
| 2 | `/swap.img`（NVMe） | 10 | 现有文件，重挂才生效 |
| 3 | `/data/swapfile`（机械盘） | 5 | 只做兜底；4K 随机 10–20 ms，真用到就很卡 |

- 内核侧配 `vm.swappiness=100`、`vm.page-cluster=0`（zram 场景标准）。
- **新加的高优先级 swap 不会搬走旧 swap 里已有的页**——想清空只能 swapoff，冷页留在原设备没有运行时成本，通常不必清。
- systemd 单元的 `ExecStart` 必须带“已在 swap 中就退出”的守卫，否则 `systemctl start` 会在活跃设备上重跑 `mkswap` 而失败；`RemainAfterExit=yes` 之后要 `systemctl start` 一次让 `is-active` 与事实一致。
- 脚本与日志固化在 `/data/home-studio/work/hs-disk-ops/`（`migrate-cold-data.sh`、`swap-expand.sh`、`zram-fix.sh`），不放 `/tmp`。

## 六、核验飞牛备份：容量账 + 新鲜度

- 真源：Backrest 配置 `~/.config/backrest/config.json`（用 `cfgview.py` 脱敏读）、计划 `fnos2-full-home`、restic 仓库在飞牛2 `/vol2/1000/开发机备份/home-studio-restic/home-studio`。
- **别用 restic 客户端探仓库**：`rest:https://…:18000/…` 同时踩自签证书和 basic auth 两个坑，退避重试会刷到 69 秒一次，看着像卡死。直接读 NAS 上的 `data/ index/ snapshots/` 目录即可：快照数 = `snapshots/` 文件数，新鲜度 = 最新文件 mtime，体积 = `du -sh`。
- 容量账：源侧实测（`/home` + `/data/home-studio` + 指定 RackNerd 文件）对比仓库体积，去重压缩约 2.2×；再看目标卷剩余空间是仓库的几倍。
- **新鲜度是必查项**：Backrest 崩过会静默跳过当晚任务（日志里是 crash loop，`03:00–05:00` 空白）。判定法 `最新快照 mtime > 36 小时即异常`，别只看服务 `active`。
- 备份边界：restic 只覆盖 HOME + `/data/home-studio` + 指定文件，**不是整个 `/data`**；HOME 里的软链不会被跟随，迁到 `/data` 的目录必须落在 `/data/home-studio` 内才继续被备份。

## 七、NAS 空间该不该挂过来

先分清**块设备**和**共享目录**：

- iSCSI LUN 是裸块：单 initiator、断链/NAS 重启后上层 FS 转只读甚至要 fsck、NAS 侧快照用不上、开机不加 `nofail` 会卡等设备。**不适合当日常数据池**，最多当备份目标。
- 判据清单：后端介质（单盘/RAID、5400rpm 还是 3.5″+缓存盘）、是否 thick 占满整卷、`ACL` 是否为空、有没有 CHAP、端到端链路速率（`cat /sys/class/net/<nic>/speed` + 实测 `dd` 过 SSH 看真实 MB/s）、同机是否有更合适的卷。
- 要扩容量，优先在容量大、介质好的卷上建共享目录走 NFS/SMB，只放冷数据；热数据留本地 NVMe。
- 结论写成“挂/不挂 + 理由 + 替代方案”，并把实测数字（MB/s、剩余空间、占用率）一起留档，别只给判断。

## 八、收尾

- 迁移/扩容/评估都留证据：日志、`df` 前后、脚本固化到 `/data/home-studio/work/hs-disk-ops/`。
- 更新 `~/mycc/docs/rules/HOME-STUDIO-STORAGE.md`（新映射、备份边界变化）+ 共享记忆 `0-System/RECENT_EVENTS.md`、必要原子 item、`task-log.md`。
- 破坏性动作（`swapoff`、删源、删快照）分别报告“已做/未做”，未获授权就不做；只清理自己创建的副本。
