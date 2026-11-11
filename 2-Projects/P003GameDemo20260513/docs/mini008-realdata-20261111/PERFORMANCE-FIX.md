# mini008 focus 查询性能修正

结论：在 b0426e1e86175f29d439fd601caf766024be26e0 上最小修正完成，业务源码只修改 `src/telemetry-store.ts`。三文件发布范围保持不变。没有部署、生产业务写入、授权或设备变更。新固定 SHA 与 archive 复测结果以协调目录 CANDIDATE.json 为准，Grok 对旧候选的结论不能替代新 SHA 差分复核。

## 根因与修正

原查询只有 `(sn, occurred_at_ms)` 索引，按 SN 扫描该设备全部事件，再执行 JSON 区间过滤。usage 读取和 ingest 不同 ID 重叠检查均受影响。

新增一个 additive partial expression index `idx_tel_focus_sn_end`，键为 SN 与安全 `CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.end_ms') END`；固定条件 `type='focus_segment' AND json_valid(data_json)`。查询明确重复 partial 条件和索引表达式，按 `end > from AND end < to + DAY_MS` 做双边索引范围，再保留 `start < to` 检查。上界来自原合同：有效片段 `end - start <= DAY_MS`，所以 `start < to` 必然推出 `end < to + DAY_MS`；合法跨边界片段不被截掉。

没有改 usage 的一日边缘余量、first-receipt/rowid 排序、JS 有效性检查、保守重叠排除、跨日分摊、null/round0 规则或 ingest 原子事务。没有缓存、TTL、新表、新管道或数据修订。

EXPLAIN（由测试截获**实际生产 prepare 的 SQL**后执行，非另写的相似查询）：

```text
旧：SEARCH device_telemetry_event USING INDEX idx_tel_evt_sn_time (sn=?)
新：SEARCH device_telemetry_event USING INDEX idx_tel_focus_sn_end (sn=? AND <expr>>? AND <expr><?)
    USE TEMP B-TREE FOR ORDER BY
```

usage、近期 overlap、29天前 overlap 均命中新索引两侧边界。仍有窗口内按首次接收时间排序，未增加排序索引。

## 桌面隔离对照（不是生产性能承诺）

Node v24.19.0，单 SN 30天每分钟一个 focus=43,200，加172,800 posture，总216,000行；25次七日 usageRange。另用独立 SN 放脏 JSON/非法 shape/旧重叠/跨日/最大24小时边界。固定 fixture 的前后 SHA256 均为 `a003d96ee9c7956560afea553e43f75d3bc216856c4bda411971436bd365f290`。

| 固定数据 | b042 候选 p50 / p95 / max ms | 修正工作树 p50 / p95 / max ms |
|---|---:|---:|
| usageRange | 239.11 / 281.69 / 333.48 | 77.33 / 104.05 / 119.29 |
| ingest 近期异 ID overlap | 183.33 / 217.61 / 305.86 | 0.185 / 0.463 / 1.868 |
| ingest 29天前 overlap | 178.43 / 195.75 / 206.38 | 2.147 / 3.969 / 4.034 |
| ingest 新相邻 focus，含事务/日聚合 | 180.95 / 222.34 / 226.32 | 0.822 / 1.855 / 2.247 |

主13未修改的 `main-usage-perf.mts` 本机复跑：旧244.19 / 296.27 / 306.31ms，新87.34 / 119.89 / 124.67ms。主13此前旧 archive 记录250.06 / 287.75 / 376ms，保留原证据，不覆盖。

**优先目标 p50<50ms 未达到。** 固定数据约3.1倍加速。局部剖析（25次）SQL约36.8ms、含解析的 focusSegments约52.3ms、完整 usage约80.2ms；窗口内仍约一万条有效原始片段，继续压缩需要扩大投影/处理范围，本次不扩修。同步阻塞仍存在，不能据此宣称已达到生产语音实时预算。

## 验证与证据

- 旧 SHA 红测：性能断言失败；更新为可移植的索引双边计划断言后，再次对旧固定 archive 红测失败。最终基准按相同 fixture 校验至少2倍改善，50ms作为明确报告项，不把硬件时延当通用 CI 门槛。
- 自身16、旧遥测37、Ark state/runtime/proxy/history 16+7+4+11、主13原 HTTP 脚本13，全部通过。
- 新性能/迁移测试：旧库脏 JSON 和非法 shape 安全建索引；既存事件逐字段 SHA 不变；重复打开幂等；usage不写历史；合法跨日/旧重叠/JSON数值 `.0`/24h边界保语义；新focus与旧脏数据共存；新脏JSON写入不报错；integrity_check=ok。
- 保索引回滚烟测：使用真正生产基线36f18f55的 telemetry-store，旧 posture/focus 继续写入和日聚合，索引保留，已有事件不删除，integrity_check=ok。
- 原基线失败仍在：tsc只有 listening-content.ts:29 的 GeminiLlmClient.abort；ark-resource第14行旧“实时余额”断言。未扩修，不宣称全仓全绿。

可复现脚本：`apps/server/scripts/mini008-focus-perf.mts`、本目录 `verify-perf-fix.py`。原主13脚本、前后 JSON/SQL计划、红绿日志和回归日志见 `evidence/perf-fix/`；最终固定 archive 结果另存协调目录 `evidence/perf-fix/fixed/`。

## 索引上线和回滚（仅主13执行）

1. 沿原三文件 before/after 漂移保护发布，before仍是当前线上两份原源码SHA，新增dashboard仍要求不存在；不要把旧候选SHA当生产before。
2. telemetryStore 构造时 `CREATE INDEX IF NOT EXISTS` 一次性创建索引，保留所有表、字段、事件和daily。不是零DDL：旧库首次启动会同步扫描建索引，需短时DDL写锁和额外磁盘/WAL空间。本机216,000行旧库完整import+初始化约164ms（旧约21ms），重复打开只检查存在；不能外推生产更大历史库。主13发布时记录启动耗时和成功状态。
3. 业务回滚只恢复原两份源码、按SHA删除新增dashboard、按主13安排重载。**保留 idx_tel_focus_sn_end**，不删除索引、不删除/改写事件、不回滚整库、不执行清库或回灌。旧源码读写已在保索引隔离库验证。
4. Grok266先前只评旧b042；新固定候选需另核该单文件差分、EXPLAIN、性能与回归证据。生产/真机验收继续由主13和用户安排。

署名：codex（OpenAI）| 2026-11-11
