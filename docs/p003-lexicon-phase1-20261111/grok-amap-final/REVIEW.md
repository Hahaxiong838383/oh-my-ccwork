# P003 Amap facts 窄审

通过。`blockers` 为空。本轮只审独立树提交 `c1c0e929c81681f41143a4295182f882cd21c36b`（父提交 `5f3727b6e87fbb4d6b48aa077d37f65366da1fc1`）。没有改源，没有 SSH，没有动生产，也没有把真人设备或 Linux preview 算作通过。

## 验收对象

工作树 `/Users/fu-121/.codex/worktrees/p003-lexicon-listening-brain-20261111` 的 HEAD 就是该提交。`5f3727..c1c0e929` 只有这一个提交，只改 3 个文件。工作区里这三个文件的 git blob 与提交一致，审阅过程没有改它们。

| 文件 | git blob | SHA-256 |
| --- | --- | --- |
| `apps/server/src/tools/amap-weather.ts` | `078869e380382531134d547a5149d57fe2518238` | `78291143f08464ebc8c9ffb414d1b1e25d8d57d54079cd5121e717ae2ae7ae35` |
| `apps/server/scripts/amap-weather.test.ts` | `64ce9f32ef0baead6df01a4c420493e07e9e800c` | `9d563756eeae76e8410447b3cece0600d6d0ee32407bea23c1f6a481c311528d` |
| `apps/server/scripts/weather-compiled-http.test.ts` | `3b37967f22af6ace28673b8e43ac9b37da28aa2c` | `5f982c1b39cb0e4440bcb140e858298a97ec3afdd2a31cd6010c0ebc2f31a130` |

路径前缀是 `2-Projects/P003GameDemo20260513/`。Worker `77c33308` 和 preview `f978` 不在这个 diff 里，本轮没有重跑。

## 代码

`amap-weather.ts` 在既有校验通过之后，把已经交给正文的同一组值放进 `weather_facts`：

- 预报：`metric:'forecast'`，`low`/`high` 为白天、夜间温度的最小和最大，`conditions` 为白天、夜间 `words()` 结果。成都夹具对应 `{low:-2,high:18,conditions:['阴','小雨']}`。
- 当前：`metric:'current'`，`temperature` 与 `conditions` 来自同一次 `temperature()` / `words()`。夹具对应 `{temperature:12,conditions:['小雨']}`。
- 凭证、城市不一致、缺字段、过期、配额、限流仍在构造 facts 之前 `fail()`。失败没有成功结果。
- 缓存键、5 分钟克隆回放、`cache_hit`、用量 `reserve`/`finish`、地名、时效和冷却都没有改。缓存回放克隆整份 `Result`，所以命中后 facts 仍在。
- `fixed-weather.ts` 不在 diff 里。高德失败后仍落到百度，AQI 与区县边界仍走原路径。
- `search-runtime.ts` 也不在 diff 里。`expandedResult` 仍先跑 `FixedWeather`，再把返回值交给 `weatherAdvice`。`weatherAdvice` 用解构去掉 `weather_facts`，再按问句追加带伞或冷热建议。持久化结果上没有 facts。

## 本机实测

Node `/Users/fu-121/.local/node-v24/bin/node` v24.19.0。工作目录是该树的 `apps/server`。命令带 `--experimental-sqlite --import tsx`。运行前清掉 `P003_AMAP_WEATHER_ENABLED`、`AMAP_WEATHER_API_KEY`、`AMAP_USAGE_DB_PATH`、`P003_TEST_AMAP`。

`scripts/amap-weather.test.ts`：exit 0。8 passed，0 failed，178.7 ms。

- R23 负向：错误 infocode、adcode 不一致、过期 `reporttime`、空 `daytemp`、地理编码城市不符全部 reject；空 key 不发请求。
- R23 缓存：并发共享上游，取消一方不影响另一方；命中后 `cache_hit` 为 true，上游次数保持 2。
- R24 计费：合并请求只记 1 次天气和 1 次地理编码；缓存命中不再扣；余额 0 时 `quota_exhausted` 且不再打上游；超时或拒绝记 1 次且错误不含 key；第二个订阅者共享已经支付的那一次。
- 新用例：预报 facts、建议带伞、偏凉、advice 结果不含 `weather_facts`；缓存命中后 facts 与首次相同；当前 facts 走「当前观测」和偏凉，正文不含「预报有降水」。

`scripts/fixed-weather.test.ts`：exit 0。打印 `fixed weather: precise fallback, scope, AQI boundary and cancellation passed`。区县失败不会变成市中心天气，AQI 不走百度，取消不再增加主源调用。注入的高德成功时百度调用数为 0；高德抛 `weather_amap_quota` 时正文回到百度。

新用例的标题写了 metering，它本身只断言了缓存和 facts。计费不变由未改动的 R24 三条和 diff 未触及 `reserve`/`finish` 一起证明。

## 留给 13 的 compiled HTTP

`weather-compiled-http.test.ts` 的 Amap 分支只在 `P003_TEST_AMAP=1` 时启用，并要求 `P003_TEST_PREVIEW_BIN`。本轮按范围没有跑。静态对照：深圳在地名册里唯一落到广东/深圳；mock 的地理编码与预报能通过现有城市、adcode `440300` 和 24 小时时效检查；多云/阴会走出既有的「未提示降水」；地理编码加天气应为 2 次 `restapi.amap.com`；断言要求 durable `task.result` 上没有 `weather_facts`。默认不设该变量时仍是百度 1 次调用和 `station_id` `101280601`。这是交给 Linux 最终 preview 的路径，不是本轮通过记录。
