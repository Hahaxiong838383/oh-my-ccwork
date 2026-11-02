# v375 精确增量发布与回滚（13专用）

48已完成候选导出；本文件不是部署回执。主13是唯一线上执行者。候选856552b942f5f8c2feb08db5949ebe7080eff77f；比较基线9e7aab980114b796e22cc5286a1edf5c44f3b35a已固化现役BLE差异。正式回滚标签`rollback/p003-v375-runtime-pre-20261102`解引用为9e7aab98；更早6c2f828d只能作历史证据，不得整树退回。

包：协调目录bundle-856552b9.tar.gz，SHA256 e5b28557253af25fa458b101b4d2e41f669e729ae887a3c5e630781ef2ec4faa。21个运行文件及逐文件before/after SHA在DEPLOY_MANIFEST.json；包内before仅供对撞，最终回滚必须用发布当刻实际备份。无环境/凭据/数据库/Worker二进制/依赖安装。

旧0e29acf6候选存在F45-01未闭合周期缺陷，旧包不可部署；本包只增加该摄入边界修复，45已对最终856候选独立复验通过（PASS_ISOLATED），生产预检仍归13。

## 发布前

1. 核45独立REVIEW对应固定候选，通过后再继续；重新读取在线进程/文件SHA和设备范围，18:22/20:15历史快照不能当发布真值。若搜索/其他会话改了任意目标文件，重新合并对应差分、测试、生成新候选并复审；不可force覆盖。
2. 用prepare_bundle.py可重导相同固定提交（tar元数据可能不同，内容SHA不变）。传到HK独立暂存目录后，按manifest核候选文件完整性。
3. 只读检查：`python3 verify_bundle.py --bundle <解包目录> --production-root /opt/p003 --phase before`。必须全部相同，新增目标必须不存在。任何差异exit1，不是让用户批准强行覆盖，而是13与相关会话核实现役增量后再合并。
4. 主13建立受限备份目录`/opt/p003/backups/v375-tiering-<UTC时刻>`；复制21个目标存在文件并保存不存在清单、mode/owner及SHA。SQLite用在线backup取得config/devices/analytics一致性证据（只取证，不回灌）。记录目标SN12项新配置、原上传总闸/名单/hour/revision和搜索/倾听/Ark配置，备份不得含到公开文档的凭据。
5. 核`/opt/p003/server/data/analytics-control.json`及managed policy仍只038/23，所有新增开关false；维护timer保留现役运行计划。只读统计原raw/batch数量与新增TTL候选数，禁止以发布为由手动大删。

## 增量应用

- manifest的`apps/server/src/...`映射`/opt/p003/server/src/...`；唯一web文件映射`/opt/p003/web/dist/admin/index.html`。只传这些文件，写同目录临时文件后原子rename并保留权限；不要整树rsync、git reset或覆盖其他服务。
- 本轮新增表在AnalyticsStore及ConfigStore启动时additive创建；没有ALTER旧raw结构。先发布/重启p003-analytics（3006），核ready及capabilities.version=1/gzip=true，再发布/重启p003-voice（3001）加载管理路由和配置键；admin HTML最后替换。任一步前重核目标SHA，避免发布期间另一会话更新。
- `pm2 restart p003-analytics` / `pm2 restart p003-voice`仅13执行，择空闲时段；不重启Rust Worker、SFU、搜索/倾听独立Brain，不变.env、generation、grant/epoch。
- `verify_bundle.py ... --phase after`全同；健康ready/storage_failures/sql_busy及正常语音/搜索/倾听/Ark smoke。公网与内部查询必须用现有认证，凭据仅继承环境，不入命令/日志。验证未经授权请求401/403、后台非admin拒绝、新开关仍false。
- 再按SERVER_HANDOFF.md单038逐步开gzip、双开关、短期请求；其他设备false，日批23不改。

## 配置回滚优先（仍保留新服务端兼容层）

后台分层页对目标SN保存request_gzip_enabled=false、tiering_enabled=false、aggregate_upload_enabled=false、on_demand_capture_enabled=false；最后一项会撤销请求且显式下发on_demand_upload_enabled=false/on_demand_request_id空。回读revision并由端侧确认应用。
**不能仅删除键或直接回滚旧server**：v375已持久排队的聚合/样本可能继续上传，旧server不认识事件会terminal reject。保留新解析器，让合法旧聚合继续结算；撤销样本按200逐ID拒收，raw不受牵连。
如果兼容层本身失效，13可临时关闭现有Analytics上传总闸并核验接口返回可重试JSON503/ANALYTICS_UPLOAD_DISABLED，让客户端保留队列，再处理代码回滚；原名单/23时策略备份保留，不擅自扩大设备或开启新的窗口。普通语音/Ark权威状态与上传总闸分离。

## 逐文件代码回滚

先核所有目标当前SHA仍为manifest.after；若出现后续修改，停止自动恢复并合并本次差分，禁止覆盖他人更新。对下表“恢复”的文件，原子恢复发布当刻备份，核SHA为before；“删除”仅在当前SHA完全等于本候选且当刻备份记不存在时删除。保持新增表/seen/usage和实时业务数据，不DROP、不恢复整库。
恢复后重启受影响的p003-analytics/p003-voice，确认新配置已显式false；旧端队列不能确认排空时上传保持暂停，恢复接收需要保留兼容摄入实现。不要退回6c2f828d抹掉BLE。

|目标相对路径|回滚动作|
|---|---|
|apps/server/src/analytics/admin-query.ts|恢复发布当刻备份|
|apps/server/src/analytics/contracts.ts|恢复发布当刻备份|
|apps/server/src/analytics/device-context.ts|恢复发布当刻备份|
|apps/server/src/analytics/event-registry-v1.ts|恢复发布当刻备份|
|apps/server/src/analytics/http-body.ts|当前after SHA匹配才删除|
|apps/server/src/analytics/index.ts|恢复发布当刻备份|
|apps/server/src/analytics/ingest.ts|恢复发布当刻备份|
|apps/server/src/analytics/rollup.ts|恢复发布当刻备份|
|apps/server/src/analytics/store.ts|恢复发布当刻备份|
|apps/server/src/analytics/tier-contracts.ts|当前after SHA匹配才删除|
|apps/server/src/analytics/tier-control-route.ts|当前after SHA匹配才删除|
|apps/server/src/analytics/tier-query.ts|当前after SHA匹配才删除|
|apps/server/src/analytics/tier-settings.ts|当前after SHA匹配才删除|
|apps/server/src/analytics/tiers.ts|当前after SHA匹配才删除|
|apps/server/src/analytics/transport.ts|当前after SHA匹配才删除|
|apps/server/src/analytics/writer-thread.ts|恢复发布当刻备份|
|apps/server/src/analytics/writer.ts|恢复发布当刻备份|
|apps/server/src/config-store.ts|恢复发布当刻备份|
|apps/server/src/routes/admin-data.ts|恢复发布当刻备份|
|apps/server/src/routes/device-config.ts|恢复发布当刻备份|
|apps/web/public/admin/index.html|恢复发布当刻备份|

署名：codex（OpenAI）| 2026-11-02 CST
