# DNS CNAME 地址提取修复候选

状态：隔离测试通过，尚未部署。生产仍为 713f6f35 / 3dd0430a；不是历史 4.704 秒 DNS 长等待根治结论。

旧 `voice_connect::family` 仅扫描 ANSWER。实际依赖 Hickory 0.26.3 会保留 CNAME ANSWER 与目标地址 ADDITIONAL；这个合法成功结果会被旧代码丢成空地址，导致快速连接失败。隔离 DNS+真实 TCP 测试在旧代码失败，修复后通过。

修改：从查询 owner 沿 IN CNAME 跟随，筛选最终 owner 的 A/AAAA，读取 ANSWER 和 ADDITIONAL，排除无关 glue、去重并拒绝环。保持解析器 TTL、域名、SNI、多地址连接和取消语义。

验证：RED 542 passed / 1 failed / 1 ignored；GREEN 544 passed / 0 failed / 1 ignored。新增 IPv4/IPv6、无关 IP 陷阱及 TTL 到期重查测试。原 DNS 与地址竞争测试保持通过。证据见 dns-cname-evidence/INDEX.json。

边界：线上新增 DNS 元数据与 RTC 正常样本尚未复现 4.704 秒长等，历史备用连接 386ms 失败无 DNS 包；不能断言这就是该次故障的根因。Grok 增量复审进行中。`examples/dns_probe.rs` 为有界诊断，不是默认服务入口，无凭据/TLS/正文/RTC。

探针验收补正：旧生产两轮功能通路通过，但退出日志含 Event loop is closed，旧启动器未记录退出码。冷批第三轮功能 JSON 后 SIGABRT，主 Worker 同 PID 无重启。已保留失败，正在补显式 AudioStream 关闭和进程退出验收；不把功能 PASS 当全进程成功。

发布条件：独立评审无阻断、正式构建、清理后的 RTC 探针 exit0、上线前当前现役双件备份（3dd0430a 与 env5c15e762）、空房且无未完成 job。不得覆盖搜索/倾听池或回灌数据库。

署名：codex（OpenAI）| 2026-11-08
