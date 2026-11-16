# R1 本地实施计划与记录
C SN BJP00326081002000031；唯一树 codex/p003-mini008-realdata-20261111；不部署。
权威需求：协调目录 SERVER_CONTRACT_R1.md 与 MAIN13_TECHNICAL_DECISION.md；细化见 DIFF_R1.md。

1. 固化现役Ark基线和来源SHA（独立提交；index保持现役）。
2. 先真实HTTP失败测试；实现严格schema、附库锁与不可变记录/索引/配额。
3. 接线现有arkRoute、父分页、dashboard独立空态；覆盖幂等/失败/越权/历史/时钟/引用/稳定分页。
4. 双连接撤销竞态、容量限流边界、旧mini008/Ark/Telemetry回归；固定archive复验。
5. 独立评审、逐文件发布/回滚包、联调说明、固定候选push与ls-remote交13。

Pre-flight: records的认证context和分页原归属共用同一grant校验；dashboard仅复用读取，不生成钱包。
Ruling: 采用DIFF_R1的item_references补足原合同未定义的引用状态字段；成本：安卓/小程序须经主13冻结后对齐，不能宣称已接受。
Ruling: 使用SQLite固定时间桶限流减少跨进程/重启漏洞；成本：窗口边界允许相邻两窗突发，文档明确。
Task 1: baseline complete；现役Ark文件逐个与已提交来源一致，非他人dirty拷贝。补齐xiaoke-kb运行依赖。

Task 2-3: 27/27隔离HTTP/SQLite通过，含真实SQLITE_FULL、双连接并发撤销、body竞态、批中撤销、分页水位、引用到达乱序、额度/限流。schema原候选59/59。
Task 4: mini008 16、Telemetry37、现役Ark state16/history11/runtime7等回归通过；216000行旧focus性能/保数据验证通过。
Ruling: 保留未含R1基线亦失败的ark-currency-http三项及listening-content.ts类型错误，不扩大到语音路由/ASR；成本：整树不能标全绿，发布仅六个R1文件需主13在现役环境复核。
Ruling: 旧Telemetry换绑后SN历史仍可见，经隔离HTTP复现；本轮只隔离新records原归属、不改旧历史。成本：旧usage跨代际限制仍待独立治理。

Task 4: final scoped suite 93/93（含31组R1，Telemetry脚本内部37项）；schema实施修订59/59。全量tsc与未含R1基线均仅listening-content.ts旧错误。
Final review: independent Codex fixed archive review。三项修复RED→GREEN，详见REVIEW_FIXES.md；未做第二轮代理复审，交13/Grok最终核验。
