# Hostinger 开发机备份、恢复和容量保护

部署日期为 2026-11-26。适用于从 MacBook Air 或 maxtkf Windows 打开「Hostinger Claude」使用的同一台 VPS。两台电脑共用一套远端保护。以下时刻均为北京时间。

## 日常怎么用

1. 打开「Hostinger Claude」后，在 `~/mycc/2-Projects/` 下建项目或克隆仓库。平时照常编辑、提交和推送。保存在磁盘上、尚未提交的工作，也会随下一次备份保存。
2. `make`、`gmake`、常规 `git clone` 已接入保护。安装依赖、打包、大测试或批量克隆，用 `hostinger-build` 加在命令前面。例如 `hostinger-build npm ci`、`hostinger-build python3 -m pytest`。这些例子需要相应工具已安装。
3. 终端出现磁盘或备份告警时先读提示。要找误删文件，在 **home-studio** 上按下文恢复到一个新目录，对比后再取回需要的文件。
4. GitHub token 等凭据仍按原约定由 home-studio 的 Vaultwarden 管理。VPS 上的 Claude Code 与 `hahaxiong83` 共用已分配的开发凭据。此次部署及离线恢复演练均未登录 Claude。

## 备份存在哪里，多久做一次

| 位置 | 职责 |
|---|---|
| Hostinger | 普通开发用户的导出程序读取工作区和会话文件，直接通过 SSH 发送。VPS 本地不生成整份压缩包。 |
| home-studio | 用户级 systemd 定时器主动通过 Tailscale SSH 拉取。restic 将数据加密、去重，存入 `/data/home-studio/backups/hostinger/repo`。VPS 没有该仓库的密码或写入凭据。 |
| Vaultwarden | 条目 `Hostinger restic repository` 保存备份仓密码，与 GitHub token 分开。home-studio 的私有配置只记录条目 ID。重建时要找回原密码，保留可独立恢复的 Vaultwarden 访问方式。 |

每天 **00:15、06:15、12:15、18:15** 启动，最多随机错开两分钟。home-studio 关机错过计划后，开机会补跑一次。成功备份之间正常约隔六小时，所以刚保存的修改在下一次成功前仍只在 VPS 上。重要里程碑可以手动立即备份。

保留最近 48 小时的全部快照、7 个日恢复点和 4 个周恢复点，同一快照可同时满足多条规则。每周首次成功任务回收过期数据并抽读 5% 数据包。源端或传输失败会使拉取命令失败；成功快照完成后才更新时间并向 VPS 回送成功回执。备份是对运行中文件的逐文件读取。要保存一组必须同时一致的文件，先让写入任务完成再手动备份。

源盘部署时约 96 GiB，可用约 94 GiB；目标数据盘可用约 33 GiB。每次备份流式读取全部纳入的内容，去重能省目标盘空间，完整读取仍要耗费传输时间。home-studio 在目标盘低于 16 GiB 时预警，低于约 8 GiB 时停止写入；挂载丢失也会停止，不会改存根盘。项目变大后要同时看两台机器的可用空间。

## 能找回来什么

| 内容 | 范围 |
|---|---|
| 工作区 | 用户家目录下普通、可见的顶层目录，包括 `~/mycc`。保留项目里的 `.git`、Git 暂存区、已修改文件和未跟踪文件。顶层挂载点、顶层软链和 `work-private` 跳过。建议项目保存在普通目录内。 |
| Claude 会话和开发设置 | 保存 `~/.claude/projects` 及存在的 tasks、plans、file-history、skills、agents、commands、rules、CLAUDE.md，还有桌面入口调用的远端启动脚本。用户级 settings.json 仅导出 theme、language、autoUpdatesChannel。 |
| 凭据 | 家目录的隐藏配置按清单选取。`.ssh`、GitHub CLI 登录配置、Vaultwarden 解锁会话、Claude 登录凭据、常见密钥文件和项目的 `.env` 等均排除。完整排除项见同目录的 `export-home`。 |
| 依赖和缓存 | 排除 node_modules、.venv、.gradle、Python 缓存、.next，以及带有效 CACHEDIR.TAG 的缓存。普通名为 build 或 dist 的目录可能含手工资产，默认保留。 |
| 其他边界 | 工作区外的数据库、整套操作系统、正在运行的 tmux、进程内存、未保存的编辑器缓冲区不在这份开发备份内。普通软链按链接保存。Git worktree 指向范围外的对象库时，要另行覆盖对象库。 |

文件名过滤无法识别写进源码、Git 历史或聊天正文里的秘密。备份仓已加密，恢复到新目录后，取出的文件是明文。新出现的敏感目录应加入排除清单，再核验导出目录。之前的快照按原保留期处理。

## 手动备份、查看状态

在 **home-studio** 运行。完成备份后，服务可显示 `inactive (dead)`，这是一次性任务的正常结束状态。看 `Result=success`、快照时间和定时器是否 active。

```bash
systemctl --user start hostinger-backup.service
systemctl --user show hostinger-backup.service -p Result
systemctl --user list-timers --all 'hostinger-*'
journalctl --user -u hostinger-backup.service -n 35 --no-pager
~/.local/lib/hostinger-protection/backup restic snapshots
```

在 **Hostinger** 查看容量、告警和上次成功回执。

```bash
df -h /
df -i /
free -h
cat /var/lib/hostinger-guard/notice
date -d "@$(cat ~/.local/state/hostinger-backup/receipt)"
sudo journalctl -u hostinger-guard.service -n 25 --no-pager
```

## 误删了文件或想找回对话

1. 在 home-studio 列出快照，选择文件仍然存在的时刻。误删后产生的最新快照可能已经不包含该文件。
2. 恢复命令接受快照 ID 和一个或多个**相对于 VPS 家目录**的路径，每次都会在数据盘创建全新的、仅当前用户可访问的恢复目录。下面的 `项目名` 和 `快照ID` 要替换为实际值。

```bash
ops="$HOME/.local/lib/hostinger-protection"
"$ops/backup" restic snapshots
"$ops/restore" 快照ID mycc/2-Projects/项目名
```

要找对话文件，先列出快照内的路径。restic 里面看到的是一个 home.tar；用下面的读取命令看它里面的文件。列目录和恢复个别文件都需要顺序读取数据流。

```bash
set -o pipefail
"$ops/backup" restic dump 快照ID /home.tar | tar -tf - | grep '^.claude/projects/'
"$ops/restore" 快照ID .claude/projects/实际项目目录/实际会话ID.jsonl
```

3. 查看恢复目录中的内容。整仓恢复后执行 `git -C 恢复出来的项目路径 status --short`，原先未提交的修改应仍显示为修改，未跟踪的文件应显示为 `??`。需要核对内容时用 `sha256sum`。
4. 先把需要的文件复制到 VPS 的**旁边目录**，对比当前工作再合回。恢复对话时保留原项目路径和会话 ID，避开正在写入的同名会话。正常登录 Claude 后可从原工作目录运行 `claude --resume 会话ID`。只有准备好覆盖当前版本时才替换原件。
5. 确认恢复完成后，按需清理刚生成的明文恢复目录。加密仓目录名为 `repo`，应保留。

如果 home-studio 需要重装，先找回加密仓、Vaultwarden 中原来的仓密码、可信 SSH 主机指纹和 VPS 接入权限。恢复已有仓直接指向原目录。只有确实需要一个全新仓库时才初始化。

## 磁盘和内存保护什么时候生效

VPS 每分钟巡检一次，同时检查根盘可用字节和剩余 inode。inode 是文件数量的额度；特别多的小文件也可能让磁盘无法再创建文件。两项按较严重者处理。

| 触发条件 | 自动动作 |
|---|---|
| 可用空间低于 20 GiB，或剩余 inode 低于 10% | 告警。记录家目录、系统缓存、系统日志等主要目录的占用和相对上次采样的变化。平时每天采一次基线。 |
| 低于 10 GiB，或 inode 低于 5% | 执行 apt-get clean，并把已归档的系统 journal 清到 256 MiB 目标，随后重新读数。清理成功后六小时内不重复；清理失败会记录原因并在十分钟后重试。 |
| 低于 5 GiB，或 inode 低于 2% | 告警升级。受管构建和克隆在启动前检查根盘和工作盘，拒绝启动并返回 75。已启动的任务继续运行。 |
| 可用内存持续约两分钟低于 1 GiB | 告警并记录内存占用靠前的进程名称和 RSS。每分钟采样，实际提示时间取决于下一次采样。 |
| 距离成功备份超过 12 小时 | VPS 根据回执、home-studio 根据本地状态分别告警。home-studio 每五分钟还检查备份定时器、备份仓和 VPS 状态是否正常。 |

告警出现或解除时，VPS 写入系统日志，并向允许广播的已登录终端发送提示。错过广播时，下次从桌面入口打开登录终端仍能看到未解除的告警。home-studio 把异常写入用户服务日志及 `~/.local/state/hostinger-protection/notice`，有桌面通知服务时尝试弹窗。本次实测 home-studio 没有可用的图形通知服务，已配置本机终端广播兜底。两台机器都离线时无法主动通知；当前没有配置手机或外部消息推送。

系统 journal 的持久日志上限配置为 256 MiB，挥发日志 64 MiB，并配置预留 5 GiB。这是 journald 自身的写入策略，其他程序仍可能用掉磁盘。自动清理只处理上述两类缓存；源码、Git 数据和 Claude 会话由用户决定何时归档或删除。

## 重型构建如何受限

`hostinger-build` 把命令及其子进程放进独立的 systemd scope。单个任务和所有受管任务合计都设置 **4 GiB 软限制、5 GiB 硬限制**。接近软限时内核会增加内存回收压力；到硬限仍无法回收时，内核可能终止组内进程。SSH、交互式 Bash 和 Claude 主进程在构建组之外。机器目前没有 swap，本次没有新增 swap 文件。

```bash
hostinger-build make -j2
hostinger-build bash -c 'npm ci && npm run build'
systemctl --user show hostinger-builds.slice -p MemoryHigh -p MemoryMax
```

默认远端登录环境通过 `~/.local/bin` 接管已安装的 make、gmake 和 git clone，普通 Git 操作直接转交系统 Git。Claude 的用户级说明也写入了构建约定。显式调用 `/usr/bin/make`、直接运行其他构建器、使用 sudo 或从其他服务启动，都可能绕开这个入口。这是针对日常开发的保护，运行大型任务时请使用上面的命令。

## 实际恢复和验收记录

2026-11-26 从 VPS 导出，使用 home-studio 上生产服务产生的快照 `a1d7be0f` 做了首次演练。该 ID 会随保留策略到期。

- 在测试 Git 仓库修改了一个已有提交的文件，并新建一个未跟踪文件。在隔离恢复目录中，两份文件的 SHA-256 逐一相符，Git 分别识别为 `M` 和 `??`。
- VPS 原先没有可供验证的项目对话。通过断网的真实 Claude CLI 生成演练记录，恢复后 JSONL 的 SHA-256 与原件相同。将恢复副本放入隔离的 Claude 配置目录，再用真实 CLI 按原 ID 续接，验证原始用户消息和新追加消息都属于同一会话。断网时模型请求未成功，全程没有进行 Claude 登录或订阅验证。
- 从正常登录 shell 运行 make，实际进程进入 hostinger-builds.slice 下的受限 scope。内核回读的软、硬上限分别为 4294967296 和 5368709120 字节。在可用空间低于 5 GiB 的内存文件系统启动测试命令，实测返回 75。
- 在隔离挂载空间模拟磁盘压力，真实 APT 清理删除测试缓存，journal 清理仅接触隔离目录。验证了阈值分级、六小时冷却和登录提示。另测了超 12 小时备份回执和持续低内存都能产生告警。未刻意填满生产盘或触发生产 OOM。
- 使用一次性的运行时定时器规则提前触发了真实备份服务，10:06 触发并成功产生新快照。验收后已撤回临时规则，日常计划仍是六小时一次。两端安装的程序和单元已逐项比对 SHA-256。
- 演练工作区和明文恢复副本在校验后清理。恢复记录属于备份快照，按保留规则到期。

## 维护、重装和停用

本目录中的文件即为安装源。VPS 使用系统单元 `hostinger-guard.{service,timer}`，home-studio 使用用户单元 `hostinger-backup.{service,timer}` 和 `hostinger-watch.{service,timer}`。巡检源码在 `guard.py`，文件导出范围在 `export-home`，保留策略在 `backup`。调整后重新安装对应一端，立即跑一次并实测。

**重装 VPS 端。** 将本目录文件送到 VPS 的临时目录，以开发用户运行 `./install-vps`。需要 sudo、GNU tar、Python 3、systemd 用户管理器和 cgroup v2。脚本安装到 /usr/local，给 journald 加入独立配置并重新加载，仅在缺少时追加 Claude 的构建说明。若同名工具入口已被别的程序占用，先核对其用途。

**重装 home-studio 端。** 确认 /data 已挂载，restic、jq、OpenSSH、Vaultwarden 的 vw 命令及解锁会话可用，用户管理器允许注销后继续运行。准备 `~/.config/hostinger-protection/ssh.conf`，其中 SSH 别名为 `hostinger-backup`，指向 VPS 的 Tailscale 地址和开发用户，指定已核验的主机密钥及登录私钥。把 Vaultwarden 仓密码条目的 ID 存入同目录的 `vault-item-id`。目录权限 700，文件 600。已有仓运行 `./install-studio`；首次创建仓才运行 `./install-studio --init`。这个安装入口会实际备份和检查一次。

**备份失败。** 先查用户服务日志，再检查 /data 挂载和余量、Tailscale SSH 连接、Vaultwarden 是否已解锁、工作区是否在持续写入。排除故障后重跑备份并列出新快照。完整性复核可用 `~/.local/lib/hostinger-protection/backup restic check --read-data`；仓较大时避开高峰。若目标盘紧张，查清空间去向再迁仓或扩容，保留原仓直到新位置完成恢复验证。

**暂停或回退。** home-studio 运行 `systemctl --user disable --now hostinger-backup.timer hostinger-watch.timer` 可暂停计划，已有快照继续保留。VPS 运行 `sudo systemctl disable --now hostinger-guard.timer` 可暂停巡检。以上操作不会终止已经开始的任务。若要撤回构建入口，先核对 `~/.local/bin/{make,gmake,git}` 的软链目标是 /usr/local/bin/hostinger-build，再逐个解除自己的软链。撤回日志限额时移走 /etc/systemd/journald.conf.d/60-hostinger-capacity.conf 并 reload systemd-journald。长期停用时也应移除对应登录提醒、Claude 构建说明和不再使用的单元，再 daemon-reload。不要在停用定时器时一并删除备份仓或 Vaultwarden 条目。

## 仍需区分的两种恢复能力

本次已实证 VPS 丢失工作区或会话文件后，可以从 home-studio 的加密仓独立取回。home-studio 自身的 NAS 备份计划覆盖 /data/home-studio，但此次未从 NAS 回读这份新仓库。Hostinger hPanel 的供应商整机恢复点也未取得只读核验凭据。本次没有把这两条路径计入已通过的恢复保障。以后要验证整机回滚，可先在 hPanel 的 VPS 备份页面核对恢复点日期；生产 VPS 上点“恢复”会覆盖现有状态。
