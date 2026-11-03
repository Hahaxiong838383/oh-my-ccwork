# 握手独立审计与回滚事实

## 已执行路径
13实际使用标准 `/api/admin/analytics/control` PUT，不是讨论中的单行ConfigStore方案。false为13:29:55.203、cfg96/policy2；收到用户转述端侧13:35:38.739–.744 cfg96+analytics_config false后，13:40:41.495恢复true至cfg132/policy3。用户转述列为client_reported，未冒充48独立取得设备日志。

48于13:33:22独立核false，13:40:52独立核true。每次只目标上传有效值翻转，标准API固有刷新36行global/active设备元数据；其他设备仍false/hour23。false首次为02000060补写原默认false/23，不能把不存在行到显式默认值混称扩大上传。诊断授权和usage不重置，源文件未改。

操作方提供源码/进程/Ark/倾听不变及公网GET证据；48以自身只读配置/SQLite与固定源hash独立核所负责字段。服务端返回client_applied=false正常，不能代替消费ACK；telemetry/diagnostics没有已验证的埋点配置应用ACK，确认要由端侧回传。

## 实际到账与验收界限
主13原查询13:41:52.208为0。首批13:41:52.333、次批13:41:55.135到账，时序不矛盾。48于13:44:09核两RID、ACK、settlement和raw/tier持久化守恒，26诊断计入同request usage；当前无拒因。未取得端侧true日志、drain_kind、pending清零/死信或精确APK/PCK独立证据，故只证明服务端真实接收，未判整个联合链路通过。聚合0不代表故障：7天桶尚未闭合。

## 回滚事实（本次未执行回滚）
13在服务器私有备份分别保存false/true前状态、管理接口回执、配置差异及端侧false确认。历史快照不直接恢复生产库。若明确暂停，13应先读当前管理策略、确认subjects仍仅目标、hour23，以最新policy整数revision做CAS的enabled=false PUT；不能把cfg132当policy revision或硬编码3覆盖后续操作。常规API会再次刷新36行元数据，须记录新cfg并通知端侧。不撤诊断ID、不清队列/seen/usage、不改Ark或其他设备值；再恢复仍需按任务条件取证，不安排自动finally true。本文档提交回滚只删除新审计目录，不改变生产开关。

## 只读查询工具修正
旧按日查询的四个json_extract路径缺`$.`（content_version/app_version/period_start_ms/period_end_ms）。无记录时表达式未执行，初期0行查询无法暴露；遇真实数据后本次明确exit1，不能把错误当0。新副本仅补四个路径，实际非空生产只读查询exit0，并在本地SQLite内存库核四路径与旧错误路径，证据SQL_PATH_VALIDATION.json。没有生产代码变化，也没有伪造生产事件。

使用 `reconcile_day_readonly.py --date-cst YYYY-MM-DD`；继承可信环境的P003_ANALYTICS_AUDIT_DB及P003_ANALYTICS_AUDIT_DEVICE_KEY，密钥不进argv或输出。固定仅该诊断窗口，单CST日查询上限、8秒预算、只读事务、脱敏投影保持。旧脚本保留历史，不再用作后续对账入口。

署名：codex（OpenAI）| 2026-11-03 CST
