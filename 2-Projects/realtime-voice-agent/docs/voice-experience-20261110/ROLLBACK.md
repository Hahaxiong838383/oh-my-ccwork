# 2026-11-10 语音体验发布回滚记录

仅本轮两个 Worker 正式二进制、watchdog 范围环境及 Brain 全局 idle 配置。无数据库迁移，无整树覆盖，无其他设备/搜索/倾听名单调整。

- 主池代码前基线07efb5a2，现役二进制553629a0，源码5453c80f；二者含义不同，不用本地HEAD冒充现役。
- 倾听代码前HEAD136c68f1，现役源码85de8fb0、二进制636b1c3d。
- 两树均有rollback/*-experience-pre-20261110标签；主池实际标签rollback/p003-voice-experience-pre-20261110。
- Worker逐池备份：/root/p003-voice-experience-fix-20261110/before-main及before-listening；binary、env、unit、倾听release元数据、baseline/receipt逐项核哈希。
- Brain备份：同根brain-before；全配置只读快照和listening-release.json。

如需回退，先确认无真实会话，暂停本轮发布者，检查漂移。先在Brain执行python3 /root/p003-voice-experience-fix-20261110/brain-release.py --rollback；原global缺省恢复为0（不签idle策略），保留所有设备override与单调revision，不整库回灌。
然后在Worker执行python3 /root/p003-voice-experience-fix-20261110/rollback-pool.py listening --apply，再main --apply。脚本校验当前候选SHA/env及完整备份，拒绝并发漂移；恢复原二进制/env/元数据，核进程哈希与注册健康。省略--apply为只读回滚准备检查。

发布脚本自身异常会恢复该池旧binary/env/metadata。上线之后回滚检查通过才标已具备回滚；不能把备份文件存在等同回滚演练已实际执行。
