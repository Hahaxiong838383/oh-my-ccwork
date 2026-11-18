# home-studio 数据与文件存储规则

2026-10-30 川哥授权；规则标识 `home-studio-data-first-20261030`。本文件是本机存储规则与迁移映射的单一真源，由 HOME 宪法和各智能体/runtime 全局入口引用。

## 新文件的默认存放规则

- **适用范围：home-studio。** 本机新产生、与软件安装和运行路径无耦合的独立数据与文件产物，默认优先存 `/data/home-studio/`，不以文件达到某个大小作为前提；其他设备不能直接套用本机绝对路径。
- 按所属项目选择 `artifacts/<项目>/`（发布包、导出文件、需保留的安装包、输出报告/媒体产物）、`models/<项目>/`（模型权重）、`datasets/<项目>/`（数据集和素材）、`training/<项目>/`（训练成果、checkpoint）、`archives/<项目>/`（冷归档）；目录有实际内容再建。
- 活跃源码、Git/worktree、编译目录、依赖环境、运行数据库和高频随机 I/O 状态继续使用 NVMe 原路径；普通知识文档与共享记忆仍按 mycc 归档规则保存。不要因为本规则批量移动现有软件目录或活动中的文件。
- 凭据沿用 `~/.mycc-secrets.env`/Keychain；他人数据沿用 `~/work-private/` 隐私边界，不写入普通 data 分类、不自动纳入新的备份范围。
- 新建下载、导出、模型获取、训练或打包流程时，先确认真实输出路径；能配置输出目录就直接使用 data 分类目录。既有软链接是兼容入口，不要删掉软链接后在旧位置重新建普通目录。
- 写入前确认 `/data` 是实际挂载点、目标目录可写且空间足够；挂载缺失时停止该次数据写入并报告，禁止在根盘同名挂载点静默兜底。
- 已迁移目录从原路径访问会落到 data；既有目录的额外迁移仍须检查引用/活动写入，复制→完整性核对→切换路径→实际读写验收。删除迁移回滚原件前，须先完成 NAS 备份与恢复验证。
- 当前 Backrest `fnos2-full-home` 每日 03:30 显式备份 HOME、`/data/home-studio`、RackNerd 指定备份 source 和恢复资料；并非备份整个 `/data`，不能依靠 HOME 软链接被备份工具跟随。新建在 `/data/home-studio` 内的分类目录进入下一次成功计划；写到该根以外必须另核备份范围。
- 迁移清单的 648 文件与 59 APK 是 2026-10-30 验收时的历史数值，目录之后允许正常新增产物。后续校验应分别检查历史条目、合法修改与新增文件，不把计数变化直接当成迁移损坏。

## 已完成映射（原路径现为软链接）

| 原路径 | data 路径 | 迁移时文件数 |
|---|---|---:|
| `/home/hahaxiong83/MyAgent/4-Assets/Code/myjavis-audio-probe/out` | `/data/home-studio/artifacts/myjavis/out` | 451 |
| `/home/hahaxiong83/MyAgent/4-Assets/Code/myjavis-audio-probe/third_party/text-benchmark` | `/data/home-studio/models/myjavis/text-benchmark` | 9 |
| `/home/hahaxiong83/.local/share/myjavis-training/r2-20261014/4-Assets/Code/myjavis-audio-probe/third_party/phone-intent-r2` | `/data/home-studio/training/myjavis/r2-20261014/phone-intent-r2` | 65 |
| `/home/hahaxiong83/.local/share/myjavis-training/r3-20261015/4-Assets/Code/myjavis-audio-probe/third_party/phone-intent-r3` | `/data/home-studio/training/myjavis/r3-20261015/phone-intent-r3` | 15 |
| `/home/hahaxiong83/.local/share/myjavis-training/r4-20261015/4-Assets/Code/myjavis-audio-probe/third_party/phone-intent-r4` | `/data/home-studio/training/myjavis/r4-20261015/phone-intent-r4` | 8 |
| `/home/hahaxiong83/.local/share/myjavis-training/r5-20261016/4-Assets/Code/myjavis-audio-probe/third_party/phone-intent-r5` | `/data/home-studio/training/myjavis/r5-20261016/phone-intent-r5` | 18 |
| `/home/hahaxiong83/.local/share/myjavis-training/r51-20261016/4-Assets/Code/myjavis-audio-probe/third_party/phone-intent-r51` | `/data/home-studio/training/myjavis/r51-20261016/phone-intent-r51` | 7 |
| `/home/hahaxiong83/.local/share/myjavis-training/r52-20261020/4-Assets/Code/myjavis-audio-probe/third_party/phone-intent-r52` | `/data/home-studio/training/myjavis/r52-20261020/phone-intent-r52` | 45 |
| `/home/hahaxiong83/.local/share/myjavis-training/r53-20261021/4-Assets/Code/myjavis-audio-probe/third_party/phone-intent-r53` | `/data/home-studio/training/myjavis/r53-20261021/phone-intent-r53` | 15 |
| `/home/hahaxiong83/.local/share/myjavis-training/r54-20261024/4-Assets/Code/myjavis-audio-probe/third_party/phone-intent-r54` | `/data/home-studio/training/myjavis/r54-20261024/phone-intent-r54` | 15 |


## 迁移证据与后续维护

迁移于 2026-10-30 完成，约 40.1 GiB 业务资产从 NVMe 移到 data，全部旧目录软链接保留。详细过程见 `~/mycc/1-Inbox/2026-10-30-home-studio磁盘资源摸排.md`；逐文件清单与 NAS 恢复证据在 `/data/home-studio/maintenance/`。迁移回滚副本均已删除，不再作为可用数据源。

规则变更修改本文件；HOME 仅保留原则与指针，各入口引用本文件。新引擎、新runtime、新Codeg工作目录接入时须验明其真实加载入口，不把“配置存在”当作“已被会话读取”。长期会话若缓存system prompt，需在下次新建/重新加载时读最新规则；不得为了宣称热更新而擅自中断活跃任务。


## 2026-11-02 重启维护归档与找回

本次重启前保全入口：`/data/home-studio/archives/reboot-20261102/README.md`；这里记录当前完成状态、NAS 快照和恢复边界，验收未完成前不得自行宣称完成。需要找回原 `/tmp`、`/var/tmp`、`/dev/shm` 或 `/run/user/1000` 文件时，先查该入口与 `inventory/`，文件映射为 `files/temporary/<原绝对路径去掉开头斜杠>`。例如 `/tmp/某工作树/a.py` 对应归档内 `files/temporary/tmp/某工作树/a.py`。

- 需要跨会话保留的源码、未提交修改和 Git 工作树应放在 NVMe 的既有项目持久工作区（按该项目规则选择位置），不再以 `/tmp`、`/dev/shm` 或 `/run` 为唯一副本；临时验证仍可用临时目录，但任务结束前将有价值产物存入 data 分类目录、源码修改保存到持久仓/工作树。
- 全量可读普通文件、软链接及临时 Git 工作树以私密归档保全，活动原路径保留；归档不是新开发工作区。`files/git-metadata/` 保存工作树依赖的 HOME 主仓 Git 元数据，`databases/` 保存在线一致性快照，`runtime/` 保存可抢救的日志与瞬态定义。
- 按需找回与继续开发见 `recovery/RECOVER-WORKTREE.md` 和 `recovery/recover-path.py`；先核现存路径，恢复到不覆盖原文件的 NVMe 工作区，再处理 Git 注册；不要在归档内运行软件或自动恢复旧 socket/PID/锁。配置和凭据备份只在私密归档，不复制进共享记忆正文。
- 归档代表其记录的采集时间。重启操作前由执行维护的智能体重新核活跃任务与新增文件，使用 `recovery/preserve-temp.py capture` 刷新并复核清单，再完成一致性数据库快照、现有 Backrest 成功备份及 `sync`；不要将当前保全外推成未来内存/未保存编辑内容的保证。
- 2026-11-02 实测 `/data` 已通过 `/etc/fstab` 与 UUID 持久挂载，Backrest 显式覆盖 `/data/home-studio`；旧记忆“data 重启不挂载/未纳入备份”已过时。本次未执行电脑重启，root 私有路径的权限盲区须以归档报告为准。

- 可复用操作技能：`~/mycc/.claude/skills/home-studio-reboot-preservation/SKILL.md`（保全、增量就绪核验、NAS恢复验证及找回）；“准备重启/能否重启”只触发保全核验，实际电脑重启须按用户指令执行。

## 2026-11-18 根盘瘦身（C 档）与交换空间

根盘 `/` 由 190 G/92% 降到 **149 G/72%（可用 59 G）**，`/data` 109 G→150 G（可用 68 G）。规则标识 `home-studio-disk-tierC-20261118`。

| 原路径 | data 路径 | 说明 |
|---|---|---|
| `~/.local/share/myjavis-development/{040..052}-integration`、`048-routing`、`049-teaching-integration`（共 14 个） | `/data/home-studio/archive/myjavis-development/<同名>` | MyAgent 的旧 git worktree，各 2.4–3.4 G，共 41 G；内容约 90% 是 gitignored 的 `build/` 产物（2×722 MB APK、ONNX/GGUF） |
| — | `/data/home-studio/work/hs-disk-ops/` | 本类运维脚本与日志固化位置（`migrate-cold-data.sh`、`swap-expand.sh`、`zram-fix.sh`、迁移日志）；不放 `/tmp` |

- **未迁且不得迁**：`feedback-phone-20261118`（adb cwd）、`052-runtime`（python cwd）、`.local/bin`、`.local/lib/rea/runtime`、`.local/share/uv/python`、`.local/share/codeg/chat-sessions`。判定法与六道闸见技能 `home-studio-storage-ops`。
- 软链后 git worktree 仍可用（git 沿软链解析，`worktree list` 仍显示原路径），不要为“修 git”重建工作树。
- 交换空间：`/dev/zram0`（zstd、8 G、优先级 100）为第一层，`/swap.img`（8 G、-1）第二层；`vm.swappiness=100`、`vm.page-cluster=0`；持久单元 `/etc/systemd/system/zram-swap.service`。规划中的 `/data/swapfile` 第三层**未建**。
- 备份边界实测：restic 仓库在飞牛2 `/vol2/1000/开发机备份/home-studio-restic/home-studio`（99 G、23 快照），源侧约 216 G，目标卷剩 844 G。上述迁移目录位于 `/data/home-studio` 内，继续被 `fnos2-full-home` 覆盖；**HOME 里的软链不被跟随**。2026-11-18 03:30 因 backrest crash loop 未产出快照，最新快照停在 11-17 03:37 —— 巡检按“最新快照 mtime 超 36 小时即异常”判定。

- 可复用操作技能：`~/mycc/.claude/skills/home-studio-storage-ops/SKILL.md`（磁盘盘点、迁移六道闸、swap/zram 分层、备份容量与新鲜度核验、NAS 空间是否挂载的判据）。


## Codeg 智能体升级（2026-11-18）

- npm 下载内容经 `~/.npm/_cacache` 写入 `/data/home-studio/artifacts/codeg/npm-content-cache/`。先用 `findmnt /data` 核挂载。运行中的 npx 工具、全局包和 Codeg 二进制仍用 NVMe 原路径。迁移时逐文件校验，旧内容暂存 `~/.npm/_cacache.before-codeg-20261118`，待 NAS 恢复验证后按既有规则处理。
- 本机默认 Node 22.23.5 安装在 `~/local/node`。验升级环境以 Codeg 设置页的强制预检、实际安装日志和新会话为准。DeepSeek ACP 0.11.0 要求 Node ≥22.19.0。Codeg 的内置 DeepSeek 与独立 DSH 使用各自的版本和数据目录。
- Codeg Web 0.45.0 的 npm 安装和二进制下载请求已在本机改为 15 分钟，其余请求沿用原有超时。发布包替换 Web 资源后，应从浏览器设置页验证一次超过 60 秒的升级，并核对落盘版本。备份在 `/data/home-studio/maintenance/codeg-agent-upgrade-20261118/`，其中包括修改前的 Web 文件和旧 Node 核心文件。后续版本先核上游实现，再决定是否需要本地修改。
