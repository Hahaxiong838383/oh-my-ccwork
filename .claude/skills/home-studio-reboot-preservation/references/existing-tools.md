# 本机已有工具与使用边界

首先由存储规则和共享记忆确定最新归档。2026-11-02 已验归档为 `/data/home-studio/archives/reboot-20261102`，以下是该版本工具的能力，不是其他版本的接口保证。实际运行前读取归档 README 与工具源码。

| 工具/资料 | 用途与限制 |
|---|---|
| `recovery/preserve-temp.py capture --label <新唯一标签>` | 脚本 BASE 来自自身父目录；固定检查 `/data` 挂载，固定扫描本机四个临时根。只更新归档且保留被覆盖旧版本，不删源，不是可任意传目标路径的通用复制器。相同 capture 标签会拒绝。 |
| `recovery/preserve-temp.py verify --label <对应标签>` | 遍历该轮清单，对普通文件源/档案做 SHA、对档案软链接核清单目标。可能花很久；失败要读具体条目。相同标签再次 verify 会重写该标签的验证报告，已封存证据不要覆盖。 |
| `recovery/recover-path.py` | 默认查询；显式 `--destination` 才复制，目标必须不存在。拒绝覆盖、逃逸软链和直接恢复运行句柄；不自动修复 Git 注册。先看 `--help` 和 `RECOVER-WORKTREE.md`。 |
| `databases/refresh-sqlite.py`、`sources.json` | 关键库在线快照输出到新时间目录；按 manifest 确认 status、quick_check、SHA，而非仅看脚本退出。不是应用数据库恢复器。 |
| `runtime/RECOVERY.md` | deleted 日志、瞬态服务和运行时安装证据；按需重建服务，不把历史诊断任务全设为开机运行。 |
| `inventory/path-index.jsonl`、`inventory/PATH-INDEX.md` | 旧路径到归档路径映射。最新增量也可能是单独的 `runtime/readiness-*/` 目录，要同时读其清单。 |

## 不可省略的补充检查

- `capture` 的退出值主要是 rsync 状态；扫描失败、目录错误须另看 summary。`verify` 主要验普通文件/软链接，目录存在、空目录、mode/mtime和权限盲区需要另外核查。不要把一次脚本返回 0 称为全范围验收。
- `verify` 不重新扫描新出现的文件，且软链接验的是档案对既有清单；收尾须查新增文件与源链接变化。源可能在两次检查之间写入，报告必须保留采集与验证时间。
- 累次 capture 不删旧目标，所以 `files/temporary` 是保全超集。整目录恢复可能带回较早保留的文件；需要精确某轮状态时按该轮 inventory 选取，结合 previous-versions 核对，不能称目录复制是精确时间点恢复。若找不到与该轮可信清单对应的版本，停止对“精确恢复”的声明并说明缺口，不能用当前累积副本代替。
- `recover-path.py` 验的是当前档案到恢复副本；恢复前需把档案与封存 `verification/*-sha256.jsonl` 或相应数据库 manifest 的可信 SHA 对比。
- 多个引用同一对象库的工作树共享依赖；恢复后的 `.git` 指针不可继续指向归档内冷副本。按 `RECOVER-WORKTREE.md` 处理外部主仓/alternates、重新注册或生成可用持久仓，再核 HEAD 和真实脏文件。
- 不将 snapshot/commit/计数做死常量断言。重复维护以最新清单为准，老验收记录只证明其记录时刻。

- 当前采集未保存 ACL/xattr，且不恢复原属主；不要声称完整保留所有文件系统属性。跨挂载扫描仅以设备号判断，同设备 bind mount 还需核 mountinfo。
- 现有 SHA 工具面向可信私密归档，未用 O_NOFOLLOW/inode 锁定抵抗不可信目录并发替换；源/目标类型或链接结构突变时先停止并查明，不能当通用不可信输入验证器。
- 数据库 `--only` 过滤可能选出0库；必须先列必需源并断言非空、逐库对照，不能接受0/0成功。
- 恢复大稀疏文件时按逻辑大小预算目标空间，现有恢复复制不保证稀疏布局；所选树外的硬链关系也不会自动重建。
