# 单池单设备发布与回滚

发布范围：仅p003-listening-worker，强制业务回收仅03800006。主池及独立搜索池二进制/env/服务状态保持；不改既有名单、窗口截止、数据库业务数据及倾听rev6。

已备份实际运行50bac0b2/二进制1e9ec83a到Worker `/root/p003-business-watchdog-20261107/listening-watchdog-before-20261108`，含binary/env/release/unit及SHA基线。源码回滚tag `rollback/p003-listening-watchdog-pre-20261108`指22ab1c31已推送核同。不能用更早feedback备份覆盖本轮回退点。

发布步骤：
1. 核当前binary/env/release/window/systemd哈希、队列健康/0jobs及SFU无活跃房；漂移或活跃则退出，不能强停用户。
2. 安装正式636b1c3d、运行构建85de8fb0；只增加watchdog enforce及完整038 allowlist两项env，失败自动恢复刚备份版本。
3. Brain manifest只更新build/evidence_ref，其他字段逐字节语义保持；确认后台重新ready、授权租约和rev6。
4. 标准后台API仅新增038的voice.session_idle_timeout_ms=5000，验证全局/其他设备override不变，再用短效运维凭据核真实签发metadata和响应一致。此操作不连接真机、不冒称端侧已应用。
5. 正式运行探针+健康/清理/同PID无重启观察；受控探针用独立合成SN，不能把它当038真机通过。

回滚顺序：先标准API删除本轮新建且rev未漂移的038 idle覆盖（此前不存在），保其他设备及全局；恢复Brain manifest备份；在无活跃房时运行私有rollback-listening-watchdog-worker.py恢复binary/env/release并核ready。三段都做当前版本/hash条件检查，禁止整库回灌。只要环境发生他人变更，先核差分，不能机械覆盖。

私有执行器及对应rollback均保存在本机 `/Users/fu-121/.local/state/p003-listening-watchdog-20261108`。脚本中不含明文凭据，凭据只在远端运行时读取。发布/配置实际revision、时间及哈希以最终RELEASE_RECEIPT记录为准。
