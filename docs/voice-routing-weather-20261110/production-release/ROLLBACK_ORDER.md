# 本轮成对回滚顺序

Codex主13唯一执行；所有命令由 run-step.py 通过既有受控SSH执行。用户已授权，执行前查当前SHA和备份，在线有用户房间/搜索任务则等待，不强关。

1. 若只是Brain预览/UI异常，运行 brain-rollback.py --apply，恢复4文件并只重启p003-voice；不动Worker。
2. 倾听池异常，先检查空房，先Brain listening-metadata.py --rollback恢复旧构建声明，再Worker rollback-pool.py listening --apply恢复旧二进制与release.json，核三者旧build/proc SHA/ready一致。两步紧接执行；中间准入不一致时不会派给错误build，禁止把此短暂状态当完工。
3. 倾听发布成功但Brain metadata apply失败且自身已恢复旧声明时，只回滚倾听Worker，不对已恢复的metadata再执行--rollback。
4. 主池异常，Worker rollback-pool.py main --apply，仅恢复主池旧二进制。
5. 全轮回滚：倾听成对回滚→主Worker→Brain4文件。P1版本展示若已更新，另从before-metadata/p1-release.json精确恢复，SHA防漂移；这是展示记录，不影响准入。
6. SSH中断不盲重试：先读远端before-*/receipt.json和/proc SHA确定实际状态。任何漂移先查并发改动，不整树覆盖，不回灌数据库、不改env/设备范围。

全部回滚后必须核活进程SHA、注册、listening runtime.ready、生产正常语音、无合成房遗留、PM2其他服务和配置不变。脚本check只是演练校验，不宣称实际执行过回滚。
