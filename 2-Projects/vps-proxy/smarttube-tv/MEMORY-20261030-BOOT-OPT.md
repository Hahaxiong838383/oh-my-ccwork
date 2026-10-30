# 电视启动优化共享记忆快照

- 2026-10-30 09:45 CST 用户授权自动重启优化，已修DNS规则有效时抢锁误失败；Android旧版持锁verify0/install1，修正版0/0。规则缺失仍失败关闭，69断言通过。
- 软件重启cc87426c-5bc4-4fb8-a62f-01a6d5f208e4：网络就绪204.19秒→77.30秒，审计77.88秒，无失败重试；双栈正文/1MiB/DoT/5354和15文件通过。DIYP直播自动恢复；SmartTube实播/新版物理拔电仍待验。
- 代码真源commit 90ef15ccebdd069a8c4a42622a73793cc9abc49f；外部guard SHA 1d6095450accfb5b1dd4fd64d45e6bce87a9cff418b9242cb68e6541f7aeb5a4，回滚备份/data/adb/video-proxy/backup-dns-lock-20261030。当前boot-assets清单覆盖旧首发manifest的外部脚本快照；15文件事务不改。
- 经验：幂等安装先核实际不变量；锁忙表示另一个操作者在执行，不能当成保护坏了，更不能据此停健康服务。失败回读所有有序规则，不能无条件吞错误。
- 本轮仅本地commit，不push。共享实时记忆已追加，快照随项目归档；不记录凭据。
