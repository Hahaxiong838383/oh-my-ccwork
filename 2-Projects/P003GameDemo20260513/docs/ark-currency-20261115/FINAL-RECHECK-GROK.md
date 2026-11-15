# 方舟币 11 文件补丁有界复验

结论：固定候选 `a26b046a1d02d34e367bb2998a870932dfbbb1d6` 可以按 `DEPLOY-MANIFEST.json` 的 11 个 after 文件发布。上轮 4 类静态短路已关闭，余额门槛没有放宽。本次没有新阻断。未部署，未 commit。

相对 `17dd53fc43d12cf8bb7cc0723003da971fa14b72` 的 Git 范围只有两处源码：`src/xiaoke-kb.ts`、`src/ark/answer.ts`（+18/−5）。工作区干净，HEAD 就是该 SHA。路由、权限、190 语料、WebSocket、供应商沿用 FINAL-REVIEW-GROK.md 已核结论，本次不重开。裸「币」和无上下文企鹅仍是已裁决的保留歧义。现货价格（`黄金|金价|比特币`）仍由未改的 `isOutsideArkQuestion` 挡在方舟状态外，不等于「我有多少余额」。

## 四类是否关闭

关闭依据是 diff 语义，加上 `scripts/ark-currency.test.ts` 对上轮最小复现的断言，以及三池真实 HTTP。

1. 混合句。关闭。`deferArkDirectReply` 见到天气、气温、下雨、带伞、冷不冷、热不热、讲/编故事、唱歌、播放、音量、灯光即整句返回 null；`answerArk` 在用途短答和余额装配之前调用它。上轮五句（问号天气、句号天气、逗号讲故事、故事在前、问号再讲故事）不再回家族币用途。逗号分句旧条件仍在。
2. 当前句否定。关闭。同一函数认 `不要|别|不用` 接 `说|讲|介绍|解释`，以及 `不想听|不想知道|不想了解`。`不要讲金币有什么用`、`别说家族币有什么用`、`我不想听金币有什么用` 都离开直答。
3. 成对引用。关闭。`“”「」『』""` 成对出现即 defer。`“金币有什么用”` 与 `「金币有什么用」是什么意思` 不再回用途短答。`他说|她说|这句话` 仍走原来的域外判断。
4. 用途粒子。关闭。`isPureResourceUsage` 要求币种加用途词，并排除 `多少|几枚/个/张/分/秒|余额|库存|赚|收益|所得|收入|进度|进展|领取|可领|领到|多久|还剩`。`isArkStateQuestion` 对纯用途直接返回 false，因此 `有.{0,8}吗` 不再把「有什么用吗」收成状态句。`answerArkResourceUse` 只在非纯用途时才用 `还有|下一|有几` 等否决。`金币有什么用吗`、`金币还有什么用`、`下一枚金币有什么用` 走静态用途，`answerArk` 在装配余额和进度之前就返回，合成事实下不再报「余额是0枚」或宝箱倒计时。

余额没有放宽。没有用途词的 `多少|有几|余额|赚|收益|下一|多久|还剩` 仍是状态句；纯用途才跳过余额否决。`我有多少金币，它有什么用`、`金币余额和用途是什么`、`下一枚金币还要多久` 仍被 `answerArkResourceUse` 拒绝。今日收益提前返回和 `addAsset` 余额分支不在本次 diff 里。`family_coin` 的 0 与 null、收益不等于余额，仍在通过的 71 项里。

search 池按清单本来就没有 `src/ark/answer.ts`。三池 `xiaoke-kb.ts` after 相同；main 与 listening 的 `answer.ts` after 相同，并等于 Git 工作区。search 的 HTTP 负例走已更新的 kb 与该池自己的 `custom-llm.ts`。

## 命令

工作区：`2-Projects/P003GameDemo20260513/apps/server`。Node：`/Users/fu-121/.local/node-v24/bin/node`。

- `git rev-parse HEAD` → `a26b046a1d02d34e367bb2998a870932dfbbb1d6`；`git status --porcelain` 空；`17dd53fc` 是祖先。
- `git diff --stat 17dd53fc..a26b046a -- src/xiaoke-kb.ts src/ark/answer.ts` → 2 files, +18/−5。
- 单测（cwd 为上面的 server）：`node --experimental-sqlite --import tsx --test --test-concurrency=1 scripts/ark-*.test.ts scripts/xiaoke-kb.test.ts` → tests 71, pass 71, fail 0, exit 0, duration_ms 13689。其中混合/否定/引用与「吗、还有、下一枚」两条用例通过。
- 三池各跑 `scripts/ark-currency-http.test.ts`（同一 Node 参数，`--test-concurrency=1`，合成库，不碰线上）：
  - main：tests 1, pass 1, fail 0, exit 0, duration_ms 2293
  - search：tests 1, pass 1, fail 0, exit 0
  - listening：tests 1, pass 1, fail 0, exit 0, duration_ms 2152
  - 该用例含 5 条真实 HTTP 负例（天气、故事前后、不想听、直角引号）断言「模型回退」，以及 3 个用途变体与原静态用途句。

## 清单

`DEPLOY-MANIFEST.json` 全部 11 个 after_sha256 与字节数对照 `D/isolated/{main,search,listening}` 实际文件：0 处不符。Git 中的两份源码：

- `src/xiaoke-kb.ts` `3f5245f46a4a29297670cb2a5aa72442d6be2479e190b23485a71c4d857f9cd5`（30275）三池一致
- `src/ark/answer.ts` `bdfff9679ee44d6e76c41c9157bb1163278fbd2500f999a54be64714c4786eb5`（7513）等于 main 与 listening

## 发布

可以按这 11 个文件的 after 像发布。4 项阻断关闭。没有新的最小复现。上轮非阻断观察（`ark-direct-http` 的 mode 残留、裸金币不继承收益）不在本次两文件 diff 内，不升格为阻断。
