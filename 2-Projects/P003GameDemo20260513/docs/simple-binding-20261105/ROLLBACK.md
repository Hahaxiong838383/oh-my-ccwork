# 简化绑定发布与回滚

源码基线：`rollback/p003-simple-binding-pre-20261105` → `b31cd36bd0bb175a599ad0ae5009fb935daf5b23`。运行候选见 `DEPLOY_MANIFEST.json`，只发布6个明确文件；以线上逐文件before哈希为准，不能整树覆盖。

部署顺序：新源码原子替换6文件 → Analytics重载共享鉴权（保留队列/库/配置）→ 主服务重载并执行pairing.db两列迁移 → 两服务health/ready → 公网只读/负向检查 → 稳定性与哈希核验。后台、个人站、搜索/倾听池不部署。

优先业务回退：在主服务现有环境中将 `SIMPLE_SN_BINDING_ENABLED=0` 后重启 `p003-voice`。这只停止未知SN自动建档，保留已绑设备、pairing2领证、现有凭据代际校验与激活查询。不清owner，不删除凭据，不回灌数据库；新列保留。

完整源码回退：仅在没有新模式客户端依赖或已暂停联调、确认新凭据兼容后，执行发布备份目录里的 `restore-code.py`。该脚本先核6文件after哈希，有漂移就拒绝；恢复6份before并重启主服务/Analytics。**旧验证器不校验legacy token新增代际，已使用新模式后不要盲目整套退旧代码**，应优先保留新验证器/状态兼容，只关闭自动建档或修复前滚。

所有SQLite备份用于取证/应急数据恢复参考，禁止当作常规代码回滚直接覆盖线上库。运行备份目录、实际上线时间与PID见 `P003_SIMPLE_BINDING_SERVER_RECEIPT_20261105.md`。

署名：codex（OpenAI）| 2026-11-05
