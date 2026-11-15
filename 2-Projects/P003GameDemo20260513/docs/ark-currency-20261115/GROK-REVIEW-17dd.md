# P003 方舟币种问答终审（Grok，只读）

结论：固定候选 `17dd53fc43d12cf8bb7cc0723003da971fa14b72` 的三池后像与 Git、三份 patch 一致，本次复跑的 Node 回归和三池 localhost HTTP 均通过。核心映射在已覆盖的单意图句上成立。已验证设备的静态 SSE 短路仍会吞掉一部分天气/故事，并把当前句里的否定和引用答成家族币用途。这项不闭合，不能把该候选标成可统一部署。

本轮只读工作树，未改源代码，未操作生产，未 push。工作树审查结束时仍是该候选，`git status` 干净。

## 身份与范围

- 候选：`17dd53fc43d12cf8bb7cc0723003da971fa14b72`（2026-11-15 14:41:05 +0800，`fix(p003): ground gold and item exchange replies in Ark currency knowledge`）
- 基线：`b4c227bf95f44ce698a392af92f970ee8f8203b9`
- 工作树：`/Users/fu-121/.codex/worktrees/p003-ark-currency-20261115`
- 目录 B：`2-Projects/P003GameDemo20260513/apps/server`
- Node：`/Users/fu-121/.local/node-v24/bin/node`，`v24.19.0`
- 私有证据目录 D：`/Users/fu-121/.local/state/p003-ark-currency-20261115`
- 基线..候选共 16 个路径。源码审查集中在 `src/ark/answer.ts`、`src/prompts.ts`、`src/routes/custom-llm.ts`、`src/xiaoke-kb.ts`，以及新测试 `scripts/ark-currency.test.ts`、`scripts/ark-currency-http.test.ts`。其余 ark 测试只核对断言有没有被改松。
- Grok308 的设计矩阵不作为实现规格。`MATRIX-GROK.json` 的 190 条没有当作全部已实现。

## 后像与补丁

仓库与 D 的 `DEPLOY-MANIFEST.json` SHA-256 相同：`b6d46e417dc2f29d10df334c9aee9af9aa66411ba5596211e897949180594052`。

11 个文件全部满足：`D/runtime` = manifest `before_sha256`，`D/isolated` = `D/after` = manifest `after_sha256`。主池 4 个文件的 Git blob 与 manifest after 相同。在临时目录用 `D/runtime` 作基线重放 `docs/ark-currency-20261115/{main,search,listening}.patch`，`patch` 退出码 0，重放结果等于 after。`runtime` 与 `isolated` 之间只有这 11 个文件不同。

| 文件 | after SHA-256 | 字节 |
| --- | --- | --- |
| main/search/listening `src/xiaoke-kb.ts` | `2f14297e36cd15e804b93493abfb1a30ffdb0b1766b1cc55f31466b283243576` | 28834 |
| main/search/listening `src/prompts.ts` | `108e3ed3097b9a48d7c7a7a113dec2393dec97dc330d7821dc3330812450e0bf` | 8390 |
| main `src/routes/custom-llm.ts` | `095b05ea879a0deed90c9391a8b3658744ee78d4280b8aa302747737394731fe` | 22051 |
| search `src/routes/custom-llm.ts` | `e5d174e7bc5995f8ae987c16a0a7975f2d5eca3d90ddd1f64176056096ce8091` | 22886 |
| listening `src/routes/custom-llm.ts` | `4f15607c4c6dd3bc596e5e30c1da02fdf8361bf84d6b8b47a63ada56b1650d69` | 23148 |
| main/listening `src/ark/answer.ts` | `df4c70c7f9cce9204c96e5141f31eb0a5f99f9fce860442af7f34422c3f5f2e5` | 7466 |

搜索池 patch 不含 `answer.ts`，SSE 路由不 import `answerArk`。搜索池静态短答只走 `answerArkResourceUse`，不新增动态事实直答。

## 复跑命令与结果

工作树，69 项，退出码 0。日志：`D/FINAL-REVIEW-GROK-node-suite.log`。

```sh
cd /Users/fu-121/.codex/worktrees/p003-ark-currency-20261115/2-Projects/P003GameDemo20260513/apps/server
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx --test --test-concurrency=1 scripts/ark-*.test.ts scripts/xiaoke-kb.test.ts
```

结果：`tests 69`，`pass 69`，`fail 0`，`duration_ms 17843.844208`。

三池各自只跑 `scripts/ark-currency-http.test.ts`。测试自己建临时 SQLite、监听 `127.0.0.1` 随机端口，不读线上业务库。

| 池 | 结果 | duration_ms | 日志 |
| --- | --- | --- | --- |
| main | pass 1 / fail 0，EXIT 0 | 4078.987209 | `D/FINAL-REVIEW-GROK-pool-main.log` |
| search | pass 1 / fail 0，EXIT 0 | 4047.554417 | `D/FINAL-REVIEW-GROK-pool-search.log` |
| listening | pass 1 / fail 0，EXIT 0 | 3963.632667 | `D/FINAL-REVIEW-GROK-pool-listening.log` |

主池和倾听池日志有 `[ark-direct]` 且 `typed_facts:false`。搜索池日志没有 `[ark-direct]`。这与搜索池只短路静态知识、不走 `answerArk` 直答一致。

## 已核对的核心行为

探针在候选工作树用 `node --import tsx` 调用 `answerArk` / `answerArkResourceUse`，事实对象是合成的，`family_coin=0`、`stardust=77`、`makeup_card=null`。

- 明确金币用途与 `我有几枚金币` 读 `family_coin`。0 报「家族币余额是0枚」，不出现 77。`family_coin=null` 报查不到，不报 0，不报 77。
- `星辰有多少` 报星尘 77，不报家族币 0。
- `今天赚了多少金币` 只回「今日收益我暂时查不到，不能把钱包余额当成今天获得的数量。」不报 0 或 77。
- 钱包使用 `occurred_at_ms/received_at_ms` 的上次同步，1 小时前的 0 仍报「截至今天 09:00:00的上次同步」。进度要求收到与采集都在 30 秒内且为当天逻辑日；31 秒前的进度报查不到，10 秒内的暂停宝箱报约 2 分钟。两个窗口没有并成一个。
- 带资源名或「游戏道具」的兑换句引导星尘和设备页面。探针输出不含企鹅已上架、价格、库存或已兑换。
- 静态门要求 `workerAuth.role` 与 `authContext.role` 都是 `device`，且不是 override、不是吐槽。命中后 `arkContext` 被换成空事实。动态直答仍要 `arkDirectReplyAllowed` 的 SN allowlist。搜索池没有这条动态直答。
- `directArkQuestion` 的 `||` / `&&` 优先级与「静态命中，或 allowlist 且 `answerArk` 非空」一致。
- 家长约定奖励句只讲家族币，不带星尘。星尘换人民币带「不能兑换现实金钱或物品」。
- `他说金币有什么用`、`我的世界金币有什么用` 返回 null。
- 上一句用户否定（「不要讲金币有什么用」）时，「那能换什么」不继承。助手旧回复不参与选币。
- GM / unknown 的归零仍在未改动的 `src/ark/context.ts`：非 `normal` 不把快照当钱包。69 项里的 GM/过期/跨日用例通过。`answerArk` 自己看不到 `source_mode`。

## 阻断项

下面每条都是已验证设备静态 SSE 或 allowlist 直答会说出口的确定文本。空 allowlist 时，静态非空就不再调用模型。

### 1. 混合句吞掉天气或故事

分隔只认 `另外|顺便|，|,|；|;`。后半句还要含 `为什么|怎么|什么|多少|吗|呢`，而且不能含币种或「有什么用」。问号、句号，以及故事这种没有这些字的后半句，都会整句变成家族币用途。

最小复现（`answerArkResourceUse` 与 `answerArk` 同文）：

- `金币有什么用？今天天气怎么样`
- `金币有什么用。今天天气怎么样`
- `金币有什么用，讲个故事`
- `讲个故事，金币有什么用`
- `金币有什么用？再讲个故事`

实际输出：

`方舟里显示的金币就是家族币。家族币用来记录你和家长约好的奖励，由家长按约定兑现。`

对照：`金币有什么用，今天天气怎么样` 返回 null，会离开静态短路。逗号加「怎么样」被挡住了，问号和故事没有。

### 2. 当前句否定仍触发用途短答

否定只检查追问的上一句用户话，不检查本句。

- `不要讲金币有什么用`
- `别说家族币有什么用`
- `我不想听金币有什么用`

三句都返回家族币用途短答。`别说家族币有什么用` 不带金币别名，其余两句带「方舟里显示的金币就是家族币。」

### 3. 引用缺少「他说 / 她说 / 这句话」时误触发

- `“金币有什么用”`
- `「金币有什么用」是什么意思`

两句都返回家族币用途短答。`他说金币有什么用` 返回 null。

### 4. 用途句因「还有 / 吗 / 下一」在直答里报余额或进度

`answerArkResourceUse` 对这三句返回 null，所以空 allowlist 的静态门不会接住它们。`answerArk` 在有事实时会把它们当状态句。金币已等同家族币，旧的「是家族币还是星尘」提前返回不再挡住。

合成事实 `family_coin=0`、进度为 10 秒内暂停、下一项宝箱 120 秒：

- `金币有什么用吗` → 含「家族币余额是0枚」和用途。`有.{0,8}吗` 把「有什么用吗」收成状态句。
- `金币还有什么用` → 同样报余额 0 枚。
- `下一枚金币有什么用` → 「计时已暂停，下一项是宝箱，还需约2分钟有效使用时间……」再加家族币用途。

allowlist 打开时，这是 SSE 直答原文。生产 allowlist 的具体 SN 本次没有读。

## 非阻断观察

`scripts/ark-direct-http.test.ts` 在 `for (mode of ['gm','wrong-sn','legacy'])` 之后没有把 `mode` 设回 `normal`。新增断言 `我有几枚金币` 匹配「查不到」时，facts 桩仍停在 `legacy`（只有 prompt 文本，没有 `facts_v1`）。同一函数在正常 `family_coin=0` 下报「余额是0枚」，见 `ark-currency.test.ts` 和本次探针。这行 HTTP 断言不能证明正常金币余额查不到。69 项整体通过，产品单测覆盖了 0 与 null。

`几枚金币怎么兑换游戏道具` 被 `isArkStateQuestion` 判成状态句，但静态门因「几枚」对不上 `有几` 而仍给兑换短答，不读钱包。与「要多少金币」不把余额当价格的测试意图一致，本次不单列阻断。

`金币` 接在 `今天赚了多少金币` 后面：静态门返回 null，`answerArk` 仍回用途，不继承收益。`家族币` 和 `星尘` 会继承成「今日收益我暂时查不到」。`memory-policy.ts` 的 `resourceChoice` 不含「金币」。按本次边界，不把裸「金币」扩成收益继承。

`src/pipeline.ts` 仍调用 `buildKnowledgeRecall(finalText)`，不传历史，也没有静态零 LLM 短路。本次 SSE 路由改了，WS 管道不在 4 个源文件的行为闭合里。

币种 HTTP 测试在 8 个用途/追问上断言了当时的 `modelCalls===0` 和 `factsCalls===0`。余额、收益、外部游戏、家长、匿名之后只断言 `modelCalls===5`。`arkContext` 对 canary SN 的状态问句仍会打 facts proxy；`service.ts` 不在本次 patch 里，门槛没有放宽。测试标题里的「zero facts」没有覆盖这 5 个模型轮。

## 明确不裁决、本次不扩映射

`D/MATRIX-LOCAL-CHECK.json` 是既有本地核对，175 条里 4 条 `fail` 非空。本次没有重跑 190 条矩阵，也不把这 4 条补进实现：

- C007 `看看你这个界面有币什么的这个币可以用于做什么我现在有200币`
- S21 `我点哪里`
- S51 `这个币可以用于做什么`
- S53 `怎么买企鹅摆件`

本次探针：`怎么买企鹅摆件` 的 `answerArkResourceUse` 和 `answerArk` 都是 null。无资源名的企鹅购买没有被收成星尘直答。

真实模型提示词探针本次没有重跑。候选说明里已记录只改提示词会编商品，所以用途改走有限静态短答。prompt HTTP 200 不能当作本候选通过。

## 尚未验证

- 生产进程、生产环境变量、生产 DB、真实重启与回退。
- `ARK_DIRECT_REPLY_SN_ALLOW` 在生产三池的实际取值。
- 客户端中途 abort 的 SSE 集成。代码上主池/倾听池在写出前和落库前看 `aborted`；搜索池的 `cancelled` 在单次请求内。没有跨请求的回复缓冲。abort 后若已写出内容会跳过 `[DONE]` 和落库。这次没有打一条取消请求。
- WS `pipeline.ts` 的跟读与零 LLM 行为。
- 190 条矩阵重跑，以及真人 ASR / 实听。
- DeepSeek / 豆包内容探针。

## 部署含义

后像可以按 manifest 核对后安装，patch 能从 `D/runtime` 的 before 重放到 after。行为上，明确的单意图用途、兑换、余额、收益、null、GM 归零和 30 秒进度窗口有测试或探针支持。混合句、当前句否定、缺标记的引用，以及 allowlist 直答里的「有什么用吗 / 还有什么用 / 下一枚金币有什么用」，会在设备 SSE 上说错或说窄。主 13 统一部署前需要先处理这 4 类短路；本次审查没有改代码。
