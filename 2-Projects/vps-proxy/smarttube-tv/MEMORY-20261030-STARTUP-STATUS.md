# 共享记忆增量：启动优化与联网浮窗（2026-10-30）

共享真源仍为`~/mycc/0-System/`；本文仅保存本任务可随Git恢复的增量，不复制全库或凭据。

- 最终启动链已部署：完整ready两次软件重启46.60/45.07秒；浮窗重启46.91秒。v2=16文件，事务外以boot-assets-current为准，回退入口认rolled_back_preserved。
- 浮窗独立包cn.hahaxiong.tvnetstatus，service.d/98-tv-network-status.sh；当贝桌面等待/成功提示，播放前台隐藏；当前boot ready门通过后从真实绘制计时，2081ms移除并退出。成功态验收包含人工HOME返回桌面。
- 保护、Android检查点、查询、完整缓存ready、审计分层计时；约33秒查询通不能代替45～47秒完整ready。旧53.57秒不是Android固有启动时长。
- 原生/proc扫描保留完整匹配与锁；异常回旧shell。微基准不能相加承诺启动收益，限速载荷不是测速。
- 4K截图6～8秒延迟，不能测两秒浮窗；以同boot单调钟绘制/移除日志加真实图像验证，等待态漏拍须记录。
- DIYP恢复必须走当贝MiTV正常入口；内部PlayerActivity缺ForceTV native初始化会闪退，本轮误用已修复，直播1080p帧持续增长、drop/error0。
- 该版物理拔电、SmartTube实际影片、长期稳定性、播放中主出口故障迁移未验；不继承旧版断电或用DIYP替代SmartTube。
- xray技能新增tv-startup-status参考，冷启动参考不再把九文件当当前闭集。71文件快照来自home-lan c15f0b693f919caa0ee2870102cc722d22f21445；签名/配置/节点凭据禁入Git。

详细证据与截图：[复盘](../2026-10-30-电视启动与联网浮窗复盘.md)。提交与推送完成后在共享记忆追加实际SHA收据，旧“未push”记录仅保留历史含义。
