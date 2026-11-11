# P003 词库一期回滚顺序（主13执行）

范围：仅03800006倾听灰度；主Worker、主Brain源码/进程、原P2、其他设备不变。截止2026-11-18 08:46:34 CST。原始回滚目录在各机/root/p003-lexicon-implementation-20261111。凭据仅保留私有目录，不提交Git。

所有命令通过本机run-step.py，连接既有受控SSH别名；执行前确认无真实通话。不要整树覆盖、不要整库回灌。

1. Brain activate-canary.py rollback（先关search gate并恢复038原route/draft；其他target不变）。
2. Brain renew-window.py brain rollback；Worker renew-window.py worker rollback（先核两个backup，可逐节点回；旧窗口可能已过期，此时停止灰度并回普通池，不强造旧窗）。
3. Brain listening-metadata-reviewed.py --rollback（恢复旧authority build）。
4. Worker rollback-pool-reviewed.py listening --apply（恢复517f5290二进制及release；不改原env，重新注册并核health）。
5. Brain scoped-brain-amap-deploy.py canary-brain rollback（7文件恢复，新增weather-advice删除，只重启灰度Brain）。
6. Brain scoped-brain-amap-deploy.py main-ui rollback（后台HTML/preview2文件恢复，无主Brain重启）。
7. 核主Worker/主Brain PID与重启次数不变；listening authority/健康/实际路由一致。回滚后的灰度不满足窗口则保持关闭。

安全检查：各脚本逐文件before/after SHA及配置revision拒绝并发漂移。每个阶段有自己的before目录和receipt。检查模式不执行回退；真正执行失败保留失败回执，不删日志后重跑冒充首次成功。
