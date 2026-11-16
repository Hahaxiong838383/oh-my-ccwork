# 两摘要独立审查回执

结论：**本次源码审查通过。发现的时钟回拨 P2 已修复；最终单次 GROUP BY 激活查询保留了原归属、存档、顺序、来源和时间约束。** 此结论不代表生产已发布或真实设备端到端验收通过。

审查时间：北京时间 2026-11-16 20:55:39。审查者：codex（OpenAI）独立子代理 `/root/review_summaries`。

## 固定源码

相对 `apps/server/`：

| 文件 | SHA-256 |
|---|---|
| `src/ark/records-contract.ts` | `f16556dc814f6f746f1b33b94e376afa95479952c21f1b7af92b2ed94731f123` |
| `src/ark/records-store.ts` | `896378873b0e2f43c14a8b56939d2181473adf190718b375fd30c4fe831773bd` |

## 审查发现与处理

- 原 P2：同一存档两笔获得，sequence 1 的发生时间比 sequence 2 晚 1 秒时，初版按发生时间选出旧笔；若 sequence 2 为 GM/unknown，还会错误回退旧 normal。已用临时 SQLite 复现。最终实现先在当前可见范围内按每个 save 选最大获得 sequence，再跨 save 按发生时间比较，新增 normal 与 GM/unknown 回拨用例通过。
- 昨日收益只聚合北京时间昨天、normal、可归时、reward_claim/tank_unlock 的正向家族币/星尘；消费不抵扣，logical_day 不替代实际发生日。缺失币种保持 null，部分覆盖不伪装完整收入；累计金额允许安全整数。
- 最新获得先选择候选再判 source_mode，不跳过 GM/unknown 回退旧 normal。获得记录存在不可归时数据时保守返回 clock_unknown，不凭接收顺序冒称最新。
- 最终激活查询先在完整 `where` 范围内过滤 SN、原家长、原设备账号、epoch、grant 和 ingest 高水位；同时要求同 save、sequence 大于获得记录、对应 acquired_record_id、选中实例 ID、operation=activated、reason=item_activation、source_mode=normal、time_status=reported。
- GROUP BY 每个实例取最大合格 sequence，外层用 `(sn,save_id,sequence)` 唯一键取回该行 record_id。唯一约束保证不会关联到别的代际/存档记录。最多返回所选获得事务的 32 个实例，不全量加载历史记录正文。
- 激活仅投影已有实例状态和 activation_record_id，不增加物品数量或收益；分页中的原始获得事实不被改写。

## 独立执行证据

运行环境：本机 Node v24.19.0，临时 SQLite，合成身份与业务；没有生产连接、凭据或生产写入。

1. 初版独立重跑摘要 12/12 通过；额外构造时钟回拨样例发现上述 P2。
2. 回拨修复后、激活优化前独立重跑 15/15 通过；9001 条容量样例摘要 730.84ms，堆内存增加 196152 bytes，已接近 750ms 测试门限。
3. 最终两源 SHA 对应版本执行：

```sh
node --experimental-sqlite --import tsx --test --test-name-pattern='activation|summaries never|same-save' scripts/ark-records-summaries.test.ts
```

结果：6/6 通过，包含两项回拨、正常激活、GM/unknown/未知与异常时钟激活隔离、归属代际隔离，以及 9001 条容量样例。容量样例为 32 件获得、1000 笔各 32 件激活、8000 笔收入；摘要 **427.999958ms**，堆内存增加 **171984 bytes**。测试进程 exit 0。

前后数据说明单次 GROUP BY 减少了本地样例延迟；不是生产性能或长期语音负载保证。全部摘要查询仍同步运行在 BEGIN IMMEDIATE 内，发布前应保留生产 Node22 隔离运行结果；不据本地测试宣称全量设备或满容量并发验收。

## 边界

- 本审查未部署、未查生产数据、未操作 Android/手机。
- 真实记录、设备 ACK/outbox、服务端持久化及手机显示须由主执行者依据真实证据分别对账。
- 独立审查只写本文件，未修改被审源码。

署名：codex（OpenAI）| 2026-11-16 20:55:39 CST
