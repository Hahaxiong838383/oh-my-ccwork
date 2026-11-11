# 倾听路由封版复验

18/18 通过。F1、F2、F3、F4 在固定倾听提交 `77c33308082941197897cc3258b1592d0fabccac` 的真实 preview 上关闭。这次不把设备真人验证或生产部署算作通过。

## 验收对象

倾听工作树 `/Users/fu-121/.codex/worktrees/p003-voice-routing-listening-20261110` 的 HEAD 就是该提交，工作树干净，本轮没有改源码，也没有重跑 cargo。相对父提交 `f68c9acb9ce18859167463b37e5442bbbb3b6b50`，这个提交只改 `search_routing.rs`：日期判断和澄清条件从整句包含「明明天」，改成 `weather_place_words` 剥完后剩余恰好是「明明」或「明」。昆明、三明、高明剥完仍是完整市名，不会被这条规则截住。

四个路由文件的 git 对象、工作树和 `EXACT-FINAL-SOURCE.json` 一致，`source-listening-final-boundary-{test,release,preview}.json` 里的同名哈希也一致：

| 文件 | SHA-256 |
| --- | --- |
| search_routing.rs | `b8cf23af072a64bbf8c66d8b37159fff93b13ab922dd611f106bab99e81e73be` |
| search_tasks.rs | `acd31a2c460585a7dae8afbefafe0bfec7ba452303bcd3c9cda595a69f9ed405` |
| search_weather_intent.rs | `fea3ba4a9b485ffe189c3dfe1dfecdf0c5c014aab49a31ffb83ec1e665059ce1` |
| search-routing-defaults.json | `92d65d9d1406664c3f7fb9fc511a077ddf66514cf93d37a72030c5ffedc6f8b4` |

实际调用的二进制：

`/home/hahaxiong83/local/p003-lexicon-implementation-20261111/listening/2-Projects/realtime-voice-agent/rust-worker/tools/search-route-preview/target-final-reviewed/release/search-route-preview`

- SHA-256：`f978af6f93a76400fe7c6d1c9601dca5dfd979cc305a280e57f1d2b982a77f44`
- 大小：1047864 字节
- 与本地 `search-route-preview-approved` 相同
- CLI 返回码 0，`ok: true`，stderr 为空
- 配置是 `routing-after.json`（SHA-256 `cad53510404e0885873fe3fa0a86c839598b9a80746354543801fe1866c8b093`）。CLI 回显的 config 与该文件相等。天气、百度天气、自动定位均为开启。
- 18 条用例在同一次进程里跑完，每条第一条 utterance 带 `reset: true`。

`EXACT-FINAL-SOURCE.json` 申报的 runtime SHA-256 `b59660fa77bf11d6f2e7c6457702847657b504863579aa178b98cf71a6575579`（78274304 字节）本轮没有重新哈希。

任务 247 用过的父提交 `f68c9acb` 和旧 preview `4f3410f5641280ef0eb5695f5f5f21037d8e8ed19b0e68793be07fbcc299f0a9`（`search-route-preview-final` 与 `payload-final/search-route-preview`）没有执行，不能部署。

## 每条真实输出

判定看最后一句；短追问两条都看。`weather` 在这些输出里都是 null。没有写出的 `place_weather` / `auto_weather` 就是 CLI 省略的空字段。

1. F1 `杭州` @0ms → `今天会冷吗` @2500ms。第二句是自动定位，query 没有杭州。

```json
[{"action":"chat","query":null,"reason":"未命中查询规则","rule_id":"default-chat","weather":null},{"action":"search","auto_weather":{"day_offset":0,"metric":"forecast"},"query":"今天会冷吗","reason":"后台按本轮设备网络定位城市，不等待前台聊天","requested_info":["comfort"],"rule_id":"natural-weather","weather":null}]
```

2. F1 同一对句子，间隔 2000ms。第二句仍是杭州今天。

```json
[{"action":"chat","query":null,"reason":"未命中查询规则","rule_id":"default-chat","weather":null},{"action":"search","place_weather":{"day_offset":0,"metric":"forecast","place":"杭州"},"query":"杭州今天会冷吗","reason":"后台校验省市与天气站后查询百度天气","requested_info":["comfort"],"rule_id":"weather-city-followup","weather":null}]
```

3. F2 `先别查杭州今天冷不冷`。chat，无 query。

```json
[{"action":"chat","query":null,"reason":"普通聊天或保护表达","rule_id":"protected","weather":null}]
```

4. F2 `先不查杭州今天冷不冷`。chat，无 query。

```json
[{"action":"chat","query":null,"reason":"普通聊天或保护表达","rule_id":"protected","weather":null}]
```

5. F3 `明明天气怎么样`。clarify，无天气对象。

```json
[{"action":"clarify_city","query":null,"reason":"日期或地点没有听完整，请说清城市和日期","requested_info":["overview"],"rule_id":"natural-weather","weather":null}]
```

6. F3 `明明天会下雨吗`。clarify，无天气对象。

```json
[{"action":"clarify_city","query":null,"reason":"日期或地点没有听完整，请说清城市和日期","requested_info":["overview"],"rule_id":"natural-weather","weather":null}]
```

7. F3 `昆明明天天气`。完整城市，明天。

```json
[{"action":"search","place_weather":{"day_offset":1,"metric":"forecast","place":"昆明"},"query":"昆明明天天气","reason":"后台校验省市与天气站后查询百度天气","requested_info":["overview"],"rule_id":"natural-weather","weather":null}]
```

8. F3 `三明明天天气`。完整城市，明天。

```json
[{"action":"search","place_weather":{"day_offset":1,"metric":"forecast","place":"三明"},"query":"三明明天天气","reason":"后台校验省市与天气站后查询百度天气","requested_info":["overview"],"rule_id":"natural-weather","weather":null}]
```

9. F3 `高明明天天气`。完整城市，明天。

```json
[{"action":"search","place_weather":{"day_offset":1,"metric":"forecast","place":"高明"},"query":"高明明天天气","reason":"后台校验省市与天气站后查询百度天气","requested_info":["overview"],"rule_id":"natural-weather","weather":null}]
```

10. F4 `请问深圳明天下雨`。place 是深圳，不是「请问深圳」。

```json
[{"action":"search","place_weather":{"day_offset":1,"metric":"forecast","place":"深圳"},"query":"请问深圳明天下雨","reason":"后台校验省市与天气站后查询百度天气","requested_info":["overview"],"rule_id":"natural-weather","weather":null}]
```

11. F4 `能说说会同明天天气`。place 是会同。

```json
[{"action":"search","place_weather":{"day_offset":1,"metric":"forecast","place":"会同"},"query":"能说说会同明天天气","reason":"后台校验省市与天气站后查询百度天气","requested_info":["overview"],"rule_id":"natural-weather","weather":null}]
```

12. `杭州今天需要带伞吗`。今天，umbrella。

```json
[{"action":"search","place_weather":{"day_offset":0,"metric":"forecast","place":"杭州"},"query":"杭州今天需要带伞吗","reason":"后台校验省市与天气站后查询百度天气","requested_info":["umbrella"],"rule_id":"natural-weather","weather":null}]
```

13. `杭州明天需要带伞吗`。明天，umbrella。

```json
[{"action":"search","place_weather":{"day_offset":1,"metric":"forecast","place":"杭州"},"query":"杭州明天需要带伞吗","reason":"后台校验省市与天气站后查询百度天气","requested_info":["umbrella"],"rule_id":"natural-weather","weather":null}]
```

14. `杭州今天天气` @0ms → `需要带伞吗` @1000ms。短追问保持今天。

```json
[{"action":"search","place_weather":{"day_offset":0,"metric":"forecast","place":"杭州"},"query":"杭州今天天气","reason":"后台校验省市与天气站后查询百度天气","requested_info":["overview"],"rule_id":"natural-weather","weather":null},{"action":"search","place_weather":{"day_offset":0,"metric":"forecast","place":"杭州"},"query":"杭州今天需要带伞吗","reason":"后台校验省市与天气站后查询百度天气","requested_info":["umbrella"],"rule_id":"weather-city-followup","weather":null}]
```

15. `杭州明天天气` @0ms → `需要带伞吗` @1000ms。短追问保持明天。

```json
[{"action":"search","place_weather":{"day_offset":1,"metric":"forecast","place":"杭州"},"query":"杭州明天天气","reason":"后台校验省市与天气站后查询百度天气","requested_info":["overview"],"rule_id":"natural-weather","weather":null},{"action":"search","place_weather":{"day_offset":1,"metric":"forecast","place":"杭州"},"query":"杭州明天需要带伞吗","reason":"后台校验省市与天气站后查询百度天气","requested_info":["umbrella"],"rule_id":"weather-city-followup","weather":null}]
```

16. 既有否定 `别查杭州今天冷不冷`。chat，无 query。

```json
[{"action":"chat","query":null,"reason":"普通聊天或保护表达","rule_id":"protected","weather":null}]
```

17. 方舟 `我有几张补勤卡`。本地知识，无 query。

```json
[{"action":"chat","query":null,"reason":"方舟资源用途由本地知识回答","rule_id":"ark-local-knowledge","weather":null}]
```

18. 普通聊天 `我想知道你喜欢什么`。chat，无 query。

```json
[{"action":"chat","query":null,"reason":"未命中查询规则","rule_id":"default-chat","weather":null}]
```

明明和明明天的澄清决策带 `requested_info: ["overview"]`，但 query 和三个天气对象都为空，没有可提交的天气请求。

## 阻断与未计入项

代码阻断 F1、F2、F3、F4 已关闭。F3 不再误伤昆明、三明、高明。本轮范围内没有新的代码阻断。

以下不算通过：

- 设备上的真人验收没有做。
- 生产没有部署，本轮也没有碰生产。
- runtime 二进制没有在本轮重新哈希。
- 全套 cargo 没有在本轮重跑。磁盘日志原文是：`worker-listening-final-boundary-test.log` 为 693 passed / 2 ignored，另加 `listening_core` 30、`listening_runtime` 13、`listening_voice` 10，合计 693+53 passed、2 ignored；`worker-final-boundary-main-test.log` 为 615 passed / 1 ignored。
- `source-final-boundary-main-test.json` 的 `src/search_routing.rs` 是 `fa1ed6fd9bc712ba19ca2b563d95455ca905841699eb0aa3e3301a51e565aa31`，与倾听文件不是同一份。615 这条日志不能证明刚才这只 preview。

先前非阻断项 F6、F7 本轮没有重测，既不关闭也不重新打开。
