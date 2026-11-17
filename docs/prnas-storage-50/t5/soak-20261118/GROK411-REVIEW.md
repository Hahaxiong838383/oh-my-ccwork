# T5 preflight delta 只读复审

结论：`b5bb1cbf562aad44b46fed9753541c3f73f9c3a4` 相对 `b3f77dbb1c62acbde8daa8ca10d827e6da252485` 的预验增量与本轮规格一致。阻断：无。

预验运行：未验证。24h：未验证。本轮没有把 b3 的 Linux 加速记录改写成通过。

## 范围

- 归档：工作树干净，`HEAD` 等于 `b5bb1cbf562aad44b46fed9753541c3f73f9c3a4`。`b3f77dbb1c62acbde8daa8ca10d827e6da252485` 与 `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1` 都是其祖先。
- 区间只有一个提交：`test(storage): preserve failed query evidence and preflight actual mixed cadence`（2026-11-18 02:01:46 +0800）。
- 业务 `apps/server/src` 相对 `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1` 的 diff 为空。
- 脚本 diff：3 个文件，+16 / -10。同提交还带有文档附件，见下，未把附件里的旧结论再审一遍。
- 未改主树、未改生产配置、未启动 10 分钟或 24 小时负载。未重开 410 正在审的 b3 调度修正；只回归执行了仍在测试里的全日时刻断言。
- 三个被审脚本在读档和复跑之后相对 `HEAD` 仍无差异。复审收尾时工作树另有未暂存文件 `storage-ark-export.test.py`（+31/-1，writer lock 测试）。那不是本复审写入的，也没有回滚。

## 规格对照

| 要求 | 归档中的实现 | 结果 |
| --- | --- | --- |
| 三模式互斥 | `storage-soak-schedule.ts` 4–6 行，`Number(fullDay)+Number(smoke)+Number(preflight)<=1` | 符合 |
| 50×6000、批 200、日截止 1h、维护、备份、候选索引 | `storage-capacity-load.ts` 35 行，`fullDay` 与 `preflight` 同一断言 | 符合 |
| 至少 600000ms | 计划 `durationMs=600000`；105–118 行在 client 之后用单调钟等到 `durationMs`，提前异常进入 `FAILURE.json` | 符合。没有单独的 `elapsed_ms>=600000` 断言，也没有跑满 10 分钟 |
| 20s 后日批 | `dailyDelayMs=20000`，与 CST 23:00 无关；105 行等到该延迟再启动 client | 符合 |
| Ark 50s | `arkIntervalMs=50000`，88–90 行按该间隔写 | 符合 |
| 维护 / 查询 300s | `maintenanceIntervalMs=300000`。查询在 `maintain()` 内，且 `arkRounds>0` 才启动。归档循环用同一个间隔 | 符合。另有原有的 2s 首维护、首 ACK 强制一轮、结束再一轮，不取代 300s 间隔 |
| 监控 5s | `monitorIntervalMs=5000`，69 行 `setInterval` 使用该值 | 符合 |
| ACK p95<=500 且 p99<=2000 | 161 行未改。`p95!<=500` 是 TypeScript 非空断言加 `<=` | 符合。用同一运算符核对：500/2000 通过，502/1732 失败 |
| 查询 p99<=100 | 154 行预验分支 `queryP99<=100`，样本来自 jsonl，不按成功子进程过滤 | 符合 |
| 失败子进程入账 | 64 行先 `push` 再 `assert.equal(exit,0)`；150–152 行写 `failed_cycles` 后断言必须为 0 | 符合，见残余 1 |
| 全日门保持 | 时长仍为 86400000；CST 23:00 公式未改；153 行仍是 samples>=10000、p99<=100、跨度>=86400000-600000、缺口<=600000；158 行仍要求 elapsed>=86400000 与资源门 | 符合 |
| 预验不能冒充 24h | `fullDay` 仍为 false；156 行 `full_t5_pass:false`；资源门在 `storage-load-resources.ts` 66–67 行要求 `requiredMs>=86400000` 且 elapsed 达到该值 | 符合。该资源文件不在本 delta 内，只用来确认 10 分钟跑不了全日资源位 |

预验查询门还有提交说明里的 samples>=150、跨度>=540000、缺口<=600000。540000 等于 600000-60000。全日跨度余量仍是 600000ms，没有被这次收紧或放宽。

加速 30k 与正式 30 万不是同一次负载：50×600=30000，50×6000=300000。b5 的 `LONG-SOAK-PREP.md` 把 b3 Linux 加速记为 50×600、ACK P95=502.172ms、7 轮查询里 2 轮失败。本轮没有重读那份原始结果。

## 阻断

无。

## 残余

1. `storage-capacity-load.ts` 64 行把 `JSON.parse` 放在 `queryReports.push` 的参数里。结果文件缺失时会入账 `result:null` 和非 0 exit。结果文件存在但 JSON 损坏时，解析先抛出，该子进程不进 `failed_cycles`。`maintain()` 仍把错误留在 `maintenanceError`，162 行会拒绝通过，所以这不是假绿。b3 描述的“非 0 exit 没进汇总”在文件缺失或 JSON 完整时已经先入账再断言。原始 jsonl 由子进程先落盘，父进程在结束时读取；损坏的 jsonl 会在写出 `SOAK-QUERY-RESULT.json` 之前抛出，同一次运行仍然失败。
2. 仓库测试锁了预验时长、Ark、维护和 20s 日批，没有锁 `monitorIntervalMs===5000`，也没有写 `preflight===true`。实现里这两项存在。独立脚本对真实 `soakPlan` 补了这两项，以及 smoke / 全日间隔回归。
3. 跨度门要有一次较早的查询。只靠 300s 与 600s 两轮，跨度约为 300000ms，过不了 540000ms。首 ACK 后的强制 `maintain()` 可以补上这一轮，但前提是当时 `arkRounds>0`。首轮 50 次串行 Ark 若晚于这次维护，预验查询门会失败。这是保守失败。本轮没有测量首轮 Ark 耗时。
4. samples>=150 对应 50 设备 × `T5_QUERY_ROUNDS=1` 的 50 条/轮，至少 3 个写全 jsonl 的轮次。正常相位是首 ACK、300s、600s 间隔和结束维护，多于 3 轮。这是静态计数，没有启动查询子进程。

## 未验证

- 正式频率 50×6000 的预验结果。主 13 正在跑，本轮未读其输出，也未启动另一份。
- 任何 24h、NAS 排空、资源配额实测。
- `storage-capacity-load.ts` 集成路径。执行它会起 harness。
- 维护重叠与备份 `published` 重叠在真实日批窗口里是否出现。
- 提交附件 `PREFLIGHT-PLAN-CHECKS.json` 的 functional smoke：`samples=18`、`span_ms=17521`，scope 为 `PREFLIGHT_PLAN_AND_FUNCTIONAL_SMOKE_NOT_24H`。该数字达不到预验门。本轮未重放这些日志。
- `GROK409-REVIEW.md` / `GROK409-CHECKS.json`。它们是 1h 断线归档，不是本 delta 的行为变更。
- Node。调度测试跑在本机 v22.14.0。附件记载的 smoke Node 是 24.19.0，未在 24.19.0 上复跑。`soakPlan` 不依赖版本。

## 已执行

- `node --import tsx scripts/storage-soak-schedule.test.ts`，工作目录 `apps/server`，退出码 0。输出：`PASS CST 23:00 scheduling, exact real-day duration, smoke never full-day`。
- 独立脚本导入 b5 的 `soakPlan`，退出码 0。覆盖：四个钟点上的预验 600000 / 20000 / 50000 / 300000 / 5000；预验不跟随 CST；`true`、`0`、空字符串不开启预验；两两及三者同时设置都抛 `choose one test scope`；预验的 `NaN`、`0`、负数时刻抛出；全日 01:00=22h、23:00=0、23:30=23.5h；smoke 仍为 17000 / 2000 / 2000 / 5000 / 1000。
- ACK 运算符对照：`p95! <= 500 && p99! <= 2000` 拒绝 502/1732。这是运算符核对，不是一次负载运行。
- 查询门与 `failed_cycles` 的不等式用源码里的同一谓词在脚本里复算了一遍。`capacity-load.ts` 没有导出这些函数，所以这不是 harness 执行。

## 明确未做

未修改线上配置，未启动长测，未改主树，未重复 b3 全日相位的大范围审计。
