# 小可时间查询独立验收 d8bf6ff1

**结论：PASS_ISOLATED。** 固定候选 `d8bf6ff1a2c2a554a735887d54fa54aa66d50698`（运行代码父提交 `0cd08d4ffcc5107b090432d251ab58473a6c4a66`）从 `git archive` 导入后，80 语料、真实 clock-http SSE、clock-search-runtime、96 独立用例和画像抽取过滤均通过。生产与真机未验。未部署。

验收目录：`/Users/fu-121/.local/state/p003-time-query-20261117/review-d8bf6ff1/`  
Node：`/Users/fu-121/.local/node-v24/bin/node` v24.19.0  
导入根：`tree/`（blob 与 `d8bf6ff1` 一致）。`server/node_modules` 只读软链到既有依赖，未改工作树源码、生产、配置、设备或 360 树。旧候选 `3d1d031c` 的 `out/module.json` 未当作证据。

工作树在归档之后另有文档提交 `447d6ae5`、`84ffd339`，diff 只有 `docs/time-query-20261117` 下的清单与 typecheck 记录，没有改 server TypeScript。本次不把这两个提交当作验收对象。工作树里未跟踪的 `docs/time-query-20261117/RESEARCH-DECISION.md` 不是本验收写入的。

## 新鲜结果

| 检查 | 结果 | 日志 sha256 |
|---|---|---|
| `scripts/clock-query.test.ts` 80/80 | 通过 | `0cec4eae179c3c3308ff804c6bc43694fb043c0bf35b8d4a7b1bc571b3df9c51` |
| `scripts/clock-http.test.ts` 3/3 真实 SSE | 通过 | `e128199e81ea902638fd6c66474ea29f6de04216207f067604a24e65d1089a6e` |
| `scripts/clock-search-runtime.test.ts` | 通过 | `aa1dae52fbd40f248d407c6e18b4b40fa7375d3efa4c04912bc5451f6d413f1d` |
| 96 独立用例 | 0 失败 | `818872f871e9d287bc2ce537eb49c0795c53552d627a23e3465fe31319b6c085` |
| 画像抽取探针 | 8/8 检查通过 | `73071a94e16a5e738197538851dab91057b0f47ed85f55b6edc9f501234a1ab0` |
| 12 文件池增量 `overlays/MANIFEST.json` | 与归档 `evidence/POOL-MANIFEST.json` 字节相同 | `c3e8413479daee25dd18858d247c85a3d7ec3b63bef00357a6a4411b8e3d1d7a` |

结构化结果：`out/module.json` `78d3fca0c9b3df0b3e289b6c5d5e6fb46f451aae09ea979b58626c5c0ed80f7e`，`out/profile.json` `456763ab1b8937741596f91b2daef8d87aa53bf018ad7f7621da669545cf68e9`。

## 语料与补齐项

归档 `docs/time-query-20261117/FIXTURES.json` 31 条含历史原文 H01–H06：`现在几点了`、`现在几点`、`现在才几点啊就跟我说晚安`、`今天是周几`、`今天是几号呀`、`那是几号`。80 条官方测试把这 31 条和补齐项一起跑过。冻结时刻 `1794872324023`（上海 2026-11-17 星期二 07:38）。

独立 96 例在同一冻结时刻实测：

- `当前时间`、`现在的时间` → `现在是北京时间早上七点三十八分。`
- `今天的日期` → `今天是2026年11月17日，星期二。`
- `今天是不是周末` → `今天是星期二。`
- `北京市现在几点` → 北京时间 07:38，`Asia/Shanghai`
- `他说现在几点了` → 不进入 clock
- `美国今天几号` 之后只说 `纽约` → 仍是 date，口播含 `2026年11月16日`
- 非法 IANA `Mars/Phobos` 抛 `invalid_clock_request`

香港、台北口播比不含星期的对照句多了星期：`香港现在是早上七点三十八分，星期二。`、`台北现在是早上七点三十八分，星期二。` 时刻仍是 07:38，星期与该瞬间的 UTC+8 一致。这是准确信息，不计为时间错误。

## 帮我查与供应商

`帮我查现在几点` 在模块层仍是 clock。真实 HTTP SSE 口播本地时间，本轮模型调用 0、Ark facts 调用 0。

Worker 显式搜索沿旧路径：`clock-search-runtime.test.ts` 用 `rule_id=builtin-explicit`、`phase=committed` 提交 `帮我查现在几点`，任务 `ready` / `answered`。时钟轮的 `fetch` 保持 0。随后故意让非时钟查询打到供应商并得到 `upstream_402`，暂停后 `帮我查当前时间` 仍本地 `ready`，`fetch` 仍为 1。这是复用已有排队和取消，没有改 Worker 二进制。

## 画像过滤

官方 `clock-http` 把 `MEMORY_EXTRACT_ENABLED` 设为 0，只证明聊天提示词不含旧报时。另一次探针把抽取打开，并让抽取模型在提示词里一旦出现 `现在几点了`、`七点三十八分` 或 `北京时间早上` 就写入兴趣「几点」、情绪和性格。

实测：

- 报时轮本身零模型调用。对话库两行都带 `memory_excluded=true`。画像兴趣、性格、情绪、方舟进展保持空白。
- 下一轮请求带上无标签的报时问答，再说「我最喜欢恐龙」。实际送进抽取器的对话数据只有「孩子【本轮】: 我最喜欢恐龙」和「小可: 模型回退」。画像兴趣变为 `恐龙`。
- 再把库里的四行原样交给 `extractAndPersist`（报时两行 `memory_excluded=true`，恐龙两行 false）。抽取提示词同样只有恐龙轮。`stripArkDynamicTurns` 按标签丢掉报时行；RTC 下一轮则在进抽取器之前用 `stripClockTurns` 丢掉无标签的报时对。两条生产入口都没有把报时原文送进抽取模型。
- 情景记忆条目为空，没有报时内容。

## 池增量

只读快照 `live-baseline/POOLS-READONLY.json` 为 3 池 × 3 文件，快照内 sha256 与正文一致。两个灰度池的 `POOL-SOURCES-READONLY.json` 完整 src 里，这 3 个文件与快照 sha256 相同。

用归档 `docs/time-query-20261117/build-pool-overlays.py` 在本目录生成 12 个文件。before/after 与归档 `evidence/POOL-MANIFEST.json` 全等。`clock-query.ts` 三池同为 `7d29b955744f24ba7fc824f59888127433676b479ed2ed70093e65901dd9aea2`，与归档源文件和 `mirrors/0|1|2` 一致。三池 `custom-llm.ts`、`search-runtime.ts` 的 after 各不相同；`search-tasks.ts` 主池独立，两个灰度池相同。增量只插入时钟锚点。快照里 weather、location、cancel、ark 的出现次数在三池之间仍然不同，没有整树覆盖。

`mirrors/` 里 12 个对应文件的 sha256 等于这份清单的 after。归档 `evidence/POOL-TESTS.json` 记录主 13 在这些字节上的主池 6 组、搜索 8 组、倾听 8 组退出码为 0。本轮核了文件身份，没有重跑这 22 组。

主池 `search-weather-fallback-runtime` 与 `search-location-fallback-runtime` 在固定基线 `d8bd447c` 已失败，见 `BASELINE-REGRESSIONS.json`。本轮没有重跑，也没有扩大修复。

## 未验

生产进程、真机、部署均未做。
