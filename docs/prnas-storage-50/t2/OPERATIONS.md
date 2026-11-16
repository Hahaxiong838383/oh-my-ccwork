# T2手工操作与后续接管边界

本轮是独立通道验证；还不能将脚本直接接到生产timer。NAS数据和密钥目录均为私有，密钥不写入命令行参数或回执。

## 发布端

云端程序依赖Python3标准库（Linux flock），不需要pip安装。对完成的不可变文件发布，不能把正在写的SQLite主文件当备份。Analytics输入必须先由现有`analytics-backup.py`的SQLite Backup API在隔离目录生成；manifest表计数应来自该快照连接，不从运行库另取。

发布接口：`python3 scripts/storage-archive.py --root <专用spool绝对路径> --publish <已完成快照> --kind analytics_backup --record-count <各表行数之和> --source-range <含tables对象的JSON>`。工具返回内部archive_id；只读list/meta/read与ack仅经固定forced-command入口。原始SQL/用户正文不作为命令参数。

NAS专用SSH公钥的forced-command必须绑定准确的脚本及spool，不配置任意shell；host key必须由已信任管理连接读取并固定。不要将新通道公钥复用到现役root日常管理。

## PRnas端

隔离目录：`/share/CACHEDEV2_DATA/p003-archive/t2-20261116`。

- 单包拉取：`code/pull <内部32位hex ID>`。
- 输出`resume_offset`是已有正文的准确字节数。非零退出保持半包；正常连接恢复后重跑同一ID即可。
- `packages/<ID>`只有通过完整SHA、大小及Analytics SQLite行数校验才出现；`receipt.json`表示云端确认已收到并在本地落盘。
- 坏半包进入`quarantine/`，不会获得ACK。健康重试从0重新取。不可删除仍未确认的云端包。
- Docker只运行本项目校验程序，网络关闭、根只读、uid1000，按固定digest使用已有Node22.19.0运行时。镜像标签单独保留为`p003-archive-node:22.19.0-t2`。

## 下一步仍属T2

1. 生产备份导出适配器：直接从Backup API完成物生成manifest，统一预算/进度、互斥；未确认包存在时不重复生成全库备份。
2. 日7/周4轮换及云端保留策略：先验证恢复再轮换，始终保留最后可恢复副本；公式与实际副本数同步改。当前keep2及四副本公式不动。
3. NAS整机重启/宿主SIGKILL的锁恢复、卷挂载身份和空间检查、定时执行/失败状态显示；本轮只验证连接中断，尚未上线无人值守服务。
4. 60/90/120秒旧预算改为一致的独立任务预算，硬上限2小时；在成熟规模库实际备份/恢复后再登记，100MiB测试不能代替。
5. T2完成后再衔接T3/T4，并在T5混合负载和语音对照通过后进入T6部署。规划50台仍不等于已验证50台，不扩大真实设备名单。
