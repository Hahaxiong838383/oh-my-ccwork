# 延期操作脚本与回滚审计

已全文读取主13实际执行脚本（大对象为执行前快照，私有目录保存，不入仓），SHA256：`92714796cbf77b0d90756fdf0cf1e049b91a05d1276179b35383da6b60055cd6`。

- 唯一业务写SQL是对analytics_diagnostic_request的expires_at_ms更新。
- 使用mode=rw（不创建意外新库）、250ms busy_timeout、BEGIN IMMEDIATE；事务内核全device_config和全部request与备份expected相等，旧期限仍ACTIVE。
- WHERE限定ID、SN、旧expires、created、revoked IS NULL、max_events、lookback、allowed_event_names；rowcount严格1。事务内after与只替换expires的desired逐字段核同，全request表和device_config重核，异常ROLLBACK。
- 私有备份0700/JSON0600包含完整before/after及其他请求/配置状态，不裸拷或回灌WAL库。脚本使用API认证但凭据仅进内存，不写日志/argv/回执。
- 实际接收器AnalyticsDeviceReader独立只读probe、管理接口读回和PM2对比均在脚本COMMIT后执行；无事件POST、无设备语音。48另有独立线上读回，未运行此写脚本。
- 该脚本没有持久化自动回滚或续期任务。COMMIT后若某个只读检查失败，应保留mutation.json按实际状态处理，不能假定写操作未执行而重跑。

## 精确回滚（仅13可执行；本轮未执行）

优先需求是结束窗口时，用既有管理员DELETE `/api/admin/analytics/tiering/<目标完整MCU-SN>/requests/diag-121d6b4b-a9ed-43b2-975c-786542d8b9ae` 撤销；它会清本次upload/id并升revision，不影响raw/aggregate正常日批。不是恢复整库。

若明确只撤回延期，则备份当前状态后，在短事务内复核目标row除expires外仍等同延期后的expected、未撤销且客户端当前request仍该ID：
```sql
UPDATE analytics_diagnostic_request
SET expires_at_ms = :old_expiry
WHERE sn = :target_sn AND id = :request_id
  AND expires_at_ms = :expected_new_expiry
  AND created_at_ms = :expected_created
  AND revoked_at_ms IS NULL
  AND max_events = :expected_max_events
  AND lookback_days = :expected_lookback
  AND allowed_event_names_json = :expected_sources;
```
参数绑定：old_expiry=1793719799775，expected_new_expiry=1794285579162，expected_created=1793679950775，max_events=1000，lookback=3，source列表取私有实际after原字节。changes必须1；其他row/config/usage不写。CAS不匹配立即停止，不覆盖别的操作者后续变更。

当旧截止已经过去时，此恢复会立即使请求过期，必须由13明确作为结束授权处理；不可当作继续开放或自动兜底。禁止清usage/seen、重置created、轮换ID或恢复全库。

该审计提交的回退只涉及文档/只读查询文件，不改变生产期限。
