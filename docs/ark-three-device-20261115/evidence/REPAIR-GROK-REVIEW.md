# REPAIR-GROK-REVIEW

会话 324。原生会话 `01a1df74-35f2-7c01-9228-39bd365b3c80`。结果：**PASS**。

这是 `69150858b1636193de8b252ef432895c7c7b79c0` 的代码可发布验收。038 仍是 gm，026 没有快照，031 仍是 unknown，三台都还没有可当作当前事实的正常数据。026 和 031 的埋点上传已经到云，旧日期和授权前的记录不能当成现在的余额或领取状态。本结论不包含真人三机通过。

323 对 `54d3e568211ec98f4439662eb3abe6332f870526` 的代码阻断在冻结池上已经关闭。这么、那么不再被「么」当成问句；「还有点」不再把分享句送进收益答复；看看、帮我看只在收益、收获、奖励或宝箱位于该分句末尾时成立；怎样、如何，以及裸的「收益吧 / 呀 / 未领取的奖励」回到无事实时的查不到模板。含「收益」的策略文案先区分分享和询问。分享句的确定性答复是 null，不查数。

## 原生模型

`REPAIR-MODEL-READY.json` sha256 `8d6c918130be915fba5fec31e40f84977a285fc07f3d9a25ba51eace975db820`。session 324，native_session 与本会话 `summary.json` 的 `info.id` 相同，values 为 model `grok-4.7`、reasoning_effort `xhigh`，`acceptance_may_start` 为 true，candidate 即上述 SHA。这份就绪文件对齐之后才做代码验收。

本会话证据，哈希取自写本报告时的文件：

- `events.jsonl` 的 `turn_started.model_id` 是 `grok-4.7`。sha256 `26d664f57ae3521e915079aec81aff9fb2989734fd897b9b72a3949f121121d3`。
- `prompt_context.json` 的 `system_prompt_label` 是 `Grok 4.7`。sha256 `19962470c377d8433b95520f5cc277968ace903e143b84910ea4e8428f94603f`。
- `summary.json` 的 `current_model_id` 是 `grok-4.7`，`reasoning_effort` 是 `xhigh`，`head_commit` 是 `69150858b1636193de8b252ef432895c7c7b79c0`。sha256 `1fc294d6af1d9edcbeb6468144543a7cb94769d3cbcd6c47eb11bd5dbf53d630`。
- `chat_history.jsonl` 助手消息：1 条 `grok-4.7-build` / `high`，27 条 `grok-4.7-build` / `xhigh`，fingerprint 都是 `fp_5719f1aec35dd73c`。sha256 `8ddf5a4a99bb0d23040c71c2b50d3b3de0dfedc1013f14d7a7565f0fbe1059df`。第一条 high 是开场核对，发生在实质验收之前。其后的 diff、红绿测试和本裁定是 xhigh。

## 固定提交和冻结池

父提交是 `1aa462f47b3677564b04bd854d04444cc3304acf`。`git show` 相对父提交只改三份文件：`src/ark/language.ts`、`src/xiaoke-kb.ts`、`scripts/ark-natural-history.test.ts`，合计 7 行新增、6 行删除。

只读目录是 `candidate-pools-69150858`。没有读可变 `candidate-pools` 的源码，也没有改这个冻结目录。`git cat-file blob 69150858:<path>` 与池内文件逐字节核对：

| 池 | src 文件 | 等于线上基线 | 相对基线有差异且等于 691 源码 |
|---|---:|---:|---|
| main | 198 | 194 | `answer.ts`、`history.ts`、`language.ts`、`xiaoke-kb.ts` |
| search | 165 | 162 | `answer.ts`、`language.ts`、`xiaoke-kb.ts` |
| listening | 159 | 156 | `answer.ts`、`language.ts`、`xiaoke-kb.ts` |

基线哈希表里的 `.bak-*` 文件这三池都没有。`candidate-pools-b5ea`、`candidate-pools-54d3`、`candidate-pools-1aa4` 也同样没有。建池脚本本来就排除这些 bak。其余在池里的 src 文件，除上表差异外，sha256 等于线上基线。三池 `scripts/` 里的测试文件都等于 691 源码。

文件 sha256：

| 文件 | sha256 |
|---|---|
| `src/ark/answer.ts` | `38a57bc670603164b249acb610738c7ea2eb1912664425c7ab2e8d1003c3fd9c` |
| main `src/ark/history.ts` | `b477919e35370415b4bdeca701af8f629b85ab497bb881bd082980a5e8774e29` |
| `src/ark/language.ts` | `6c414e8b3281060f725350cce666faf20588b8b1a23c1bb1236f07b86c93b564` |
| `src/xiaoke-kb.ts` | `d45c317a4081b5fe1d061a80496a308a607b3438182986343a46d6e361ebb586` |
| `scripts/ark-natural-history.test.ts` | `246a58bd84ff9345f8645180b0c2badd54b0f3b43b606c3d918e5bf0d30f54a1` |

`answer.ts` 在 main、search、listening 都与 `b5ea904aca702bce1b21d1d8b9660eb1b3745c9c` 的池文件和 git blob `67ad3de71593fc93067356db2aa6c2c496566383` 相同，也与 691 的同一 blob 相同。main `history.ts` 与 b5 的池文件和 git blob `16d67a1e5334c7e05974440638f36894c781bde8` 相同。search 的 `history.ts` 与 b5 池、线上基线相同，那一份不是 main 这份新 history。listening 没有 `history.ts`，b5 池也没有。

冻结核对 `repair-324/freeze-check.json` sha256 `b953ddc67a4594ae42487255f8199f121d2afabd6b5580356728f18a8df927e9`。

## 增量函数断言

Node `/Users/fu-121/.local/node-v24/bin/node`，v24.19.0。`delta-323/compare.mts` 复制为 `repair-324/compare.mts`，next 路径改为 `candidate-pools-69150858`，旧路径仍是 `candidate-pools-b5ea`。脚本 sha256 `c259f4155685872bf8b1aa43d7aa6ecafb0e49e10993ef258b8188cf3e693551`。成功运行日志 sha256 `81188ffa7c37e6a68e821ca1e5f8bd6e20b441e2de74fac09e67f2e9a4a49958`，退出码 0。明细 `repair-324/function-comparison.json` sha256 `811a4339f74ac0d6e8135b27248fae8b88b338232f22614731b7721d45234847`。

323 的失败观察句已改成断言，三池一致，失败列表为空：

| 句子 | 691 状态 | 无事实答复 |
|---|---|---|
| 今天收获这么多，我很开心 | 聊天 | null |
| 今天收益这么好 | 聊天 | null |
| 那么今天收益不错 | 聊天 | null |
| 我还有点开心，今天收益不错 | 聊天 | null |
| 看看今天收益不错 | 聊天 | null |
| 帮我看今天收益不错 | 聊天 | null |
| 我这么开心，终于把未领取的奖励都领完了 | 聊天 | null |
| 今天收益不错呢 | 聊天 | null |
| 今天收益不错，还有什么好玩的 | 聊天 | null |
| 今天收益怎样 | 问句 | 今日收益查不到模板 |
| 今天收益如何 | 问句 | 今日收益查不到模板 |
| 今天收益呢 | 问句 | 今日收益查不到模板 |
| 今天收益吧 | 问句 | 今日收益查不到模板 |
| 今天收益呀 | 问句 | 今日收益查不到模板 |
| 未领取的奖励 | 问句 | 待领查不到模板，并写明不能代领 |
| 看看今天收益 | 问句 | 今日收益查不到模板 |
| 帮我看看今天收益 | 问句 | 今日收益查不到模板 |

这些聊天句在带上一条「今天收益有哪些」时也不会变成追问，无事实答复和合成事实答复都是 null。问句的无事实答复不含数字。合成夹具是家族币 value 9、`claimable_count` 1。它只在「未领取的奖励」有这份进度时说出「共1项奖励」，并写明小可不能代领。那是夹具，不是设备数。无事实路径不出现这个 1。

「今天收益不错呢」在 b5 上会走收益查不到模板，在 691 上是聊天。句尾的「呢」没有紧贴收益、收获、奖励或宝箱。裸的「今天收益呢」仍是问句。这与 691 自己的自然史测试一致。

原 37 裁定用的正例 12 条、分享 3 条、普通聊天 14 条、反向问句 14 条、反向聊天 4 条，三池都按原预期通过。其中「今天收益不错」在 b5 上仍是收益答复，在 691 上是 null。这是从 b5 到本提交要留在聊天里的那句。

旧 37 语料 `RESULTS-clarified.jsonl` 256 行、256 个互异键，sha256 `e6277ca1d2b0783089fdd29354624343daddc95bd41cb709af44fe2f1c57d8e2`。main、search、listening 各 checked 256、unchanged 256、changed 空。比较面仍是状态、追问、问题解析、静态用途答、知识召回，以及无事实和一份合成新鲜事实的 `answerArk`。这是函数对比，不是新的全量模型回放，也不是真机。

策略面每池只变 1 条，而且都是精确替换：`U01376:single_turn`「这些收入怎么这样呢」从「【收益问询】这是询问收益……」换成「【收益话题】先理解用户是在分享还是询问……」。没有别的策略漂移。这句的状态和答复向量没有变。

不含「收益」或「收入」的句子不会拿到这条新策略。「未领取的奖励」和「我终于把未领取的奖励都领完了」的策略串是空的。前者仍由确定性问句模板回答，后者答复是 null。模型聊天没有被【收益话题】这句话约束。

含「收益」且没有退出词的分享句和问句，三池新策略都是同一句：分享时简短回应，不强行查数或追问；确实在问且对象不清时才确认是哪一项；没有可信事实不捏造数量或代领；不告别，不输出设备或退出标记。旧句「这是询问收益」不再返回。

## 单测红绿

绿：冻结 main 池跑 `ark-natural-history.test.ts`，10 pass / 0 fail。日志 sha256 `d9966f59c27a24543ed920364203b219da8b69a9c34f9811226e0413efad57f2`。新增的「question particles belong to the reward clause」通过，原来的分享三句和读数用例也通过。

红：同一份 691 测试配上父提交 `1aa462f4` 的 `xiaoke-kb.ts`，9 pass / 1 fail。失败点是「看看今天收益不错」仍被判成状态问句。日志 sha256 `44cec12210f2f7b91fc00338f48726f710b849f75a69ca60e560ac0bee24d43b`。断言在该句停住，所以这条日志没有继续展示后面的新句子。绿测已经把同一测试里的怎样、如何、吧、呀和未领取的奖励跑过。

## 十三条真实模型 SSE

`RESULTS-closed.jsonl` 在差分之前就已经有 13 行。差分之后又核过一次，sha256 仍是 `be73aaefbffa48db00c7e27e125c238df7ba1e28b064a58183d8ef307032919e`，13428 字节。没有另编内容。

13 行都是 status 200、route `model`、`facts_calls` 0、`error` null。12 条是新增分享负例，三池各 4 句：今天收益不错、今天收益这么好、看看今天收益不错、我这么开心，终于把未领取的奖励都领完了。同一句在三池的 `prompt_sha256` 相同。另 1 条是受策略文案影响的原语料「这些收入怎么这样呢」。

这 13 条回复都没有数字，没有代领，没有告别，没有 `[[DEV:` 标记。分享句没有进入查数。无事实时没有被写成余额。

模型边界：10 条分享回复里仍有问号。main 对「今天收益这么好」说「星尘和资源都变多」，并以「对吧」收束。这次没有事实调用，回复里也没有数字。这句话不能当成余额或涨幅。「【收益话题】」里的「不强行追问」没有在每一条分享回复上被模型遵守。

「这些收入怎么这样呢」的新 `prompt_sha256` 是 `c8ab74c57f6e3bbedeca65eac067fd2425f15c2f684fa459d37ee86d7d4f25a9`。同句在 `RESULTS-clarified.jsonl` 里的 prompt 是 `50aeae6eeab2c7ce6b692cba1c58c4407587d3dfe98fe9187e65e3ab0e8841f6`。这次回复是在问星尘收获还是家族币记录，没有给数量。本会话没有打开 prompt 正文。

## 322 的边界

本会话没有重跑 `grok-final-accept-322.ts`。`grok-final-accept-322.result.json` sha256 `5d986f04aa23094d4c948a55f7e9dd64c92b74f91c1bb9d6e4dc2d2022aefb9f`，与 323 所引相同，20 项里 failed 0。main 的 `answer.ts` 和 `history.ts` 与 b5 逐字节相同，所以那 20 项对这两份文件仍然可用。它不覆盖这次改过的 `language.ts` 和 `xiaoke-kb.ts`。那份结果里的语料 `candidate_rerun` 仍是 false，提交分布仍是当时的 `0efa24f9` 与 `94a40ceb`。

上面的绿测在 691 冻结 main 上重新执行了自然史里的 SQLite 读数用例，并且 10 项通过。那是这份冻结树上的读数回归，不是把 322 的整套 HTTP 再跑一遍。

## 设备和现场

没有部署，没有改真实数据，没有输出凭据或环境变量。业务工作树在验收前后的 `git status --porcelain` sha1 都是 `80db38f8ccce97ce440c7d15b60296bf8b8f53b1`。验收开始时已经有未跟踪目录 `docs/ark-three-device-20261115/`，以及已修改的 `.claude/skills/voice-agent-ops/references/ark-facts-and-product-replies.md`。它们不在 `69150858` 的这三份差异里，本审查不把它们算进候选 diff。

真机没有重读。038 gm、026 无快照、031 unknown 继续待正常数据。代码验收通过，三机闭环仍开着。

grok(xAI)
