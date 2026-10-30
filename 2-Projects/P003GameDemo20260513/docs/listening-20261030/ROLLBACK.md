# P003 倾听模式冻结与回滚记录

状态：2026-10-30开发前冻结，第一批未部署。以下是已核实基线，不是已执行回滚。

| 项目 | 记录 |
|---|---|
| Brain源码基点 | e4bf06324553850ce28b9d1bcdaa70bef974eb46；rollback/p003-listening-brain-20261030 |
| Worker源码基点 | ef92ee1aa30e6ef869f6270de22173ce51617f30；rollback/p003-listening-worker-20261030；文件树同普通运行源码8a343694 |
| 普通Worker运行SHA256 | a00744bfb55478e9d549d19f8712e643e2d9234901aa81e3cb93855c4b5ceb2d |
| 搜索候选Worker运行SHA256 | 680af65efcc15bf0adb1f9830fa7bdfc2ae04a0ddfc71c8b418135027d3ab8f9 |
| 读取时间 | 2026-10-30 07:54 CST；普通PID1546073、候选PID1545357；PID仅当时观测 |
| Brain现发布 | 主/候选style-ark-release.json读取成功；未宣称已对当前所有源码逐文件核hash |
| 原Brain备份 | /opt/p003/backups/style-ark-20261029T131327Z |
| 原Worker备份 | /root/rust-worker/backups/style-ark-20261029T131327Z |

## 本批撤回

新增模块没有import进运行链路，没有改服务器/数据库/开关。源码撤回使用本分支对应提交的`git revert <commit>`，或另开干净worktree从上述tag继续；不要reset他人工作树，不删除无关未提交内容。当前无需重启或覆盖线上服务。

## 发布前必须补齐

- 重读实际运行进程SHA、部署目录触及文件hash、配置与权限，备份到新的带时间路径；不要假定本冻结仍是届时最新版。
- 记录普通R18＋style/ark与候选R26＋style/ark的单独构建产物、发布清单和恢复命令；只替换倾听改动文件，不整树覆盖。
- 配置/数据结构只增不破坏现读者；禁用总闸首先停止签发并按短租约撤销。进入暂停的会话必须关闭后重建，不能开闸关闭即自动恢复普通抢话。
- 先隔离测试新→旧→新；证明撤权≤16秒目标与普通聊天恢复，随后才开单机窗口。真人实听与数据库权限验证尚待完成。
- 不改原搜索两个SN及2026-11-02 11:19 CST截止；不整库回灌，不影响Analytics、个人语音和现有local reply功能。

署名：codex（OpenAI）| 2026-10-30
