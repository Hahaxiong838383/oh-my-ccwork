# 客户端最终回执独立核验（48）

本轮主链路通过：同两RID服务端252/0/0与客户端ACK一致，端侧附件补齐cfg132实际应用、pending0、resume及daily_marked=false。端侧日志与APK版本为用户提供回执，本轮未独立读设备APK或Windows原日志。32条唯一样本未通过，待端侧ID集合或更正表述。

## 固定版本与证据

客户端精确提交e863cf608cd1955b974687a05f8b5e5453f7dfb3，10份相关文件SHA见source-manifest.json；关键Store、Coordinator、Godot client与旧35502版本diff为空。客户端原件SHA及三版公共回执SHA均列SHA256.json，原件字节不改。

2026-11-03 13:53:26.570 CST仅执行一次目标设备全日只读查询，截止该时刻。mode=ro/query_only、8秒预算、数量上限，未读properties/context正文。结果3批、26样本、2条近期raw均未触及上限，汇总见REQUEST-DAY-SUMMARY-48.json，完整ID哈希列表只留私有协调目录，不随本归档新增外发。

全日263 accepted=237raw+26diagnostic，包含00:00:15.806另一次11raw；本次恢复补传仍252=226raw+26diagnostic，不能混数。本request26个distinct ID，每个settlement accepted一次，usage26，全天目标设备无duplicate/reject。

## local accepted为何不能直接相加

- P003AnalyticsStore.kt:58–106：event_id为主键，CONFLICT_IGNORE；新插入或exists(id)均返回accepted，distinct仅去重单次调用。已有队列ID再次交接会收到local accepted，但不新增行，也不导致云端duplicated。
- P003AnalyticsCoordinator.kt:124–150：accepted为整次bridge返回ID计数，event_names只是输入名称集合，不是逐类型计数。
- analytics_event_client.gd:289–315：诊断ID按CST日、源事件名、维度、source稳定hash；:198–203 handoff后移出Godot队列，同日同维度再采可重建同ID。
- Store:283–297：enqueue后存在prune（14天/10000条/8MB）；本轮未有触发证据，不猜为实际原因。
- LOCAL-DEDUP-SEMANTIC-FIXTURE.json为本地内存SQLite示例：26个唯一ID，再交其中6个可获accepted6而唯一数仍26。仅证明语义，不证明真机那6个ID已全部重合。

云端26条诊断captured/occurred时间在10:07:00.831–11:51:28.052。另有两条raw：g1.presentation_state_changed（13:20:02.332）及g1.route_check_completed（13:20:03.244），与pending250之后+2现象相符，但不能据此认定已还原端侧全部队列变化。

## 待办与范围

需要端侧既有13:20:30批次/相邻记录的event_name和client_event_id或UTF-8 SHA256，最好同时提供12:26:25那26项ID集合，核并集/交集。若无ID记录，将32更正为累计本地交接确认数、云端26个唯一诊断样本，明确细分未取证。不要求重传/清队列/开关切换。

第二批端侧ACK13:41:54.716比服务端received13:41:55.135早419ms，分别保留双端时钟，只按RID关联，不推算延迟。daily_marked=false证明未占日批资格，不代替当晚23点真实日批。7天聚合/节省率、Ark与倾听未验。

本次仅审计文档，无生产写、部署、触发设备或额度变更。回滚本次提交只回退文档；生产暂停仍由13以当时最新policy revision走标准API，保留诊断ID/usage/DB/去重记录。

署名：codex（OpenAI）| 2026-11-03 CST
