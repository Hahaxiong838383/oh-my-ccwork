# 精确发布与回滚（准备包，未执行生产）

C SN BJP00326081002000031。只有主13评审固定候选并核验现役后才安排发布。本轮不部署、不启用名单、不修改C设备或数据库。

发布清单只有六文件：

- 新增 src/ark/records-contract.ts
- 新增 src/ark/records-store.ts
- 新增 src/ark/records-routes.ts
- 新增 src/ark/records-service.ts
- 增量替换 src/routes/ark.ts
- 增量替换 src/routes/telemetry.ts

index.ts、原Ark daily/history/语音/ASR、旧Telemetry store均不发布。基线回流提交有来源SHA，不能把整个候选工作树rsync到生产。release/MANIFEST.json包含六文件原服务器before与固定commit after SHA，以及source commit。已存在但不在清单的文件不碰。

发布前：重新只读核磁盘、当前两替换文件SHA和所依赖现役Ark/registry/auth；任何漂移先停并增量适配，不覆盖新改动。当前预算并非长期保底，也不证明50台可用。由主13安排现役Node24验证、现有流程的安全数据库快照与服务维护窗口（本包不读写DB或重启）。

`records-release-files.py`默认只检查，不联网，不读.env、不操作服务/DB。下面命令只供主13审查，不是本轮授权执行记录。ROOT必须是已经核对的server目录，BACKUP必须是本次新备份目录，PACKAGE为完整发布包。先dry-run：

```
python3 records-release-files.py --package PACKAGE --root ROOT --backup BACKUP
```

经主13发布门后同命令显式加`--apply`，会在任何写入前核全部beforeSHA，保存两个原文件及RELEASE.json，再按清单原子替换单文件，逐个回读afterSHA。全部文件就绪后才按既有运维流程重启；不得在发布文件过程中重启。若中断，BACKUP保留，不要重跑发布覆盖备份；改走回滚。

回滚先dry-run，再明确执行：

```
python3 records-release-files.py --package PACKAGE --root ROOT --backup BACKUP --rollback
python3 records-release-files.py --package PACKAGE --root ROOT --backup BACKUP --rollback --apply
```

回滚只恢复备份的两个旧文件、移除与候选SHA完全一致的四个新增文件；任何第三方变更都拒绝覆盖。支持部分发布与重复回滚。生产records允许名单的开关/恢复由主13另留实际配置回执，本包不改env。SQLite新增表、索引、去重及已接收记录一律保留；不drop、不回滚DB备份覆盖新数据、不改owner/grant/凭据。代码回滚之后旧mini008照常工作，设备新队列须按404/不支持保留，不降级塞state。

本轮仅在临时目录模拟六文件发布、回滚、重复回滚与漂移拒绝；从未把脚本指向生产。

署名：codex(OpenAI) | 2026-11-16
