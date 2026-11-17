# Codex对Grok设计审查逐项处理（实现审查请重读最新SHA）
D1/D8-13：纯计算24条包含北京时间周一/周日、299999/300000、1ms断开、重叠400秒与跨夜；不是用展示整数判门槛。
D2/D3：旧显式日期仍滚动7天，新report以所在自然周。客户端始终请求周一并拒错scope/错week。
D4-7：null/0/exactplayed/de-dup有纯函数、HTTP和UI用例。上传合同不变。
D14-15：available表示已收到可计算证据，coverage.complete永远不假称完整；missing_dates与pending_dates保留，0活跃是已确认下界。
D16-17：首版有scheduled_publish_at、实际published_at、period_end、data_cutoff；首次发布后published_at不变；UIpublished未到period_end注明本周未结束。漏跑实际发布晚于计划时间可从字段核对，没有伪造准时发布。
D18：data_cutoff是统计窗口终点，updated_at/source_updated_at表示后续到达/修订时间；不把12月收到的11月事件算入12月。
D19：最小事件持久、daily结果、report版本；旧原始清理后补传仍重算located区间并集；奖励累计高水位单独保留，晚到absent能纠正估算。
D20：修复临时Analytics失败仅装饰本次读取coverage，不改事实revision；正式服务测试追加验证。
D21-22：现有legacy授权/disabled等字段行为保留；report不具备当前授权为null；授权DB读失败503；await发生ABA/epoch/role/shared-account变更404。
D23：按原始ms计算；UI秒保留小数、日均换分钟仅最后显示。
D24：已新增reference_max=672/above_reference_max，673原值不截断且两端提示。
D25：正式LiveApp源码未找到，真实手机页面不得宣称通过；当前仅同源参考RealDataHome通过并给准确接线文档。

额外已修：scope key不再包含原始JSON文本；等价重排/无关设备授权配置变更不丢历史缓存（两条服务回归）。
