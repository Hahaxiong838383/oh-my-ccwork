# 前台只读连接与生产接线一致性

只修正合成负载工具：调用createAnalyticsApp时原来漏掉startAnalyticsServer入口的query_only=ON及8MiB页缓存，错误地保留AnalyticsStore通用写连接64MiB预算。现在在离线建索引后、writer启动前应用与生产相同的三条PRAGMA，并断言及记录query_only/cache_size。产品src没有变化，writer缓存/FULL/250ms/8s/并发/验收门均不变。

本机50×200真实HTTP smoke：10000事件完整、50ACK、161尝试（111次503），ACK P95 110.83ms/P99 289.81ms；350queries、0失败，P99 24.51ms。该smoke是在最后增加两条PRAGMA断言与配置元数据之前；不冒称完整固定提交Linux验收。

仍在跑的9e9b4819 Linux profile用原64MiB，以保留单变量原始诊断；不会偷换它的候选。后续8MiB必须另起固定候选实测，不将接线修正当作已解决2.5秒阻塞。

署名：codex（OpenAI）｜2026-11-18
