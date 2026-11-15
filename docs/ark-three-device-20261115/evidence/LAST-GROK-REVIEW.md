# LAST-GROK-REVIEW

签名：grok(xAI)

结论：PASS。对象是 `d34955cd16189b90ee3b1d69c6ceba4793faa182`，父提交 `69150858b1636193de8b252ef432895c7c7b79c0`。这一行收益分享 prompt 可以进入代码。本验收不把整棵 d349 树签成生产发布，也不声称三台真机 normal 已经贯通。

评审会话 325，native session `01a1df7c-07aa-7c21-a79e-63be4e0936dc`，connection `e35e78c7-18bb-4e50-b181-27246ca6719f`。实质验收开始前已读 `LAST-MODEL-READY.json`：model `grok-4.7`，reasoning_effort `xhigh`，`acceptance_may_start` true，sha256 `7808d798e3c2f33e81f1017fa0567c932d1df1954cdca3eaadd13ff516374f19`。同一 native session 的 `summary.json` 写着 `current_model_id=grok-4.7`、`reasoning_effort=xhigh`。`prompt_context.json` sha256 `c3e917f04cb6db6b861153615871ab0896ee2003a76aa2fce1928519cd2a5321`，`system_prompt_label` 是 Grok 4.7。`events.jsonl` 的 `turn_started` 在 `2026-11-15T13:53:31.247Z`，`model_id=grok-4.7`，session id 与上面相同。聊天记录模型是 `grok-4.7-build`，fingerprint `fp_5719f1aec35dd73c`。取样时 assistant 行为 11 条 xhigh、1 条 high；那 1 条是开头记录，其后记录和 summary 的 effort 是 xhigh。会话还开着，events 与 chat_history 的字节哈希会继续变，所以不以那两份增长日志的瞬时哈希当封条。

## 源码

`git diff 69150858b1636193de8b252ef432895c7c7b79c0 d34955cd16189b90ee3b1d69c6ceba4793faa182` 只有 `src/ark/language.ts` 一行替换。父 blob `15755c85c38c83ee0e75fb92855abb1c0edc7fd8`，候选 blob `6290ac7e31f3312685d4971405dc47d893cc5f9a`。工作区该文件干净。`git show` 该文件、工作区文件、main/search/listening 三个池里的 `src/ark/language.ts` 都是 sha256 `8a0227a10b1970397e637fc4aa5142f7e8ce110e4e6c35562758d498ea6234f1`，6815 字节。

`candidate-pools-d34955cd` 对 `candidate-pools-69150858`：537 个文件逐字节相同，只有三个池各自的 `src/ark/language.ts` 不同。池内文件数 main 206、search 170、listening 164。其余运行源与 691 池等价。三个池彼此本来就不是同一套运行树，本轮只要求每个池相对自己的 691 池只差这一行。

新行在含「收入」或「收益」、且不含结束词时返回：纯分享只接住情绪，不转成查询，不主动报数、追问收益类别或解释查不到，也不替用户断言资源或收益原因；对象不清的询问才简短确认。

## 旧 691 的 13 条

`RESULTS-closed.jsonl` sha256 `be73aaefbffa48db00c7e27e125c238df7ba1e28b064a58183d8ef307032919e`，13 行。主 13 里有 2 条分享主动说查不到，判不通过。两次 `facts_calls` 都是 0，属于口头查数失败，不是事实接口返回。

- `SYN-main-2`「看看今天收益不错」：回复写具体星尘数字这会儿还查不到，得等系统更新。
- `SYN-search-1`「今天收益这么好」：回复写还查不到具体数字。

## 本候选 13 条

`RESULTS-d349.jsonl` sha256 `cc583bb72b7bea5017867d2e8c476488a26f87e969645c7cfae00077e0f87533`，13 行。12 条合成分享（`source_record_id` 空，`sn_suffix` 99999901）加 1 条原历史询问 U01376（`fc3e3fbf-0024-4264-a423-19d8e7c570df`，`2026-10-31T17:02:18.349+08:00`）。不是 13 个真人。

官方设置来自三个 `RUNTIME-d349-*.json`：provider `race`，temperature `1.0`，deepseek 模型 `deepseek-v4-flash`。main 的火山模型是 `doubao-seed-2.0-mini`。search 与 listening 的火山模型是 `doubao-seed-2.1-lite`。13 条 `facts_calls` 都是 0，`done` 都是 true，HTTP status 都是 200。内容通过只看回复语义。HTTP 200 只说明传输完成。

含「收入|收益」的 10 条，prompt_sha256 相对 691 都变了。不含这两个词的 3 条领奖分享，prompt_sha256 仍是 `c071a686d9f505baaa6cf069d264bf8d9bb5a2362884e4f537099e654ede96cc`，与 691 相同，新行没有进入那 3 次请求。`replay.ts` 把 `prompt_sha256` 算在 `JSON.stringify(body.messages)` 上。

| # | key | 结果 | 理由 |
| --- | --- | --- | --- |
| 1 | U01376:single_turn | pass | 历史询问「这些收入怎么这样呢」。回复确认是星尘还是家族币，不报数量，不说查不到，不代领，不退出。 |
| 2 | SYN-main-0 | pass | 「今天收益不错」回复「听起来收获不错呀，真替你开心！」无查数、无未知、无数量、无代领、无退出。 |
| 3 | SYN-main-1 | pass | 先接住「今天收益这么好」，再问方舟有没有新变化。自然追问，没有点名收益类别，没有报数。 |
| 4 | SYN-main-2 | pass | 「看看今天收益不错」不再出现 691 那句查不到星尘、等系统更新。 |
| 5 | SYN-main-3 | pass | 领奖句未触发新 prompt。回复复述用户已说的领完，并问生态缸。无数量、无代领、无查数、无退出。 |
| 6 | SYN-search-0 | pass | 接住分享后问是不是专注了一会儿。疑问，没有把原因说成事实，没有报数。 |
| 7 | SYN-search-1 | pass | 「今天收益这么好」不再出现 691 那句查不到具体数字。 |
| 8 | SYN-search-2 | pass | 接住「看看今天收益不错」后问今天忙活啥。自然追问，无查数、无未知。 |
| 9 | SYN-search-3 | pass | 新 prompt 未触发。追问里用了用户没说的「宝箱」，但没有数量、代领、查数或退出。本轮按限定标准通过，并记下这个用词。 |
| 10 | SYN-listening-0 | pass | 「今天收益不错」只接住情绪。 |
| 11 | SYN-listening-1 | pass | 「今天收益这么好」只接住情绪。 |
| 12 | SYN-listening-2 | pass | 「看看今天收益不错」只接住情绪。 |
| 13 | SYN-listening-3 | pass | 新 prompt 未触发。winner 是 fallback，deepseek 与 doubao-seed-2.1-lite 都是 HTTP 200。通过依据是回复：复述领完并问用途，无数量、无代领、无退出。 |

语义合计 13 pass，0 fail。没有把人格整表重做一遍。

## 来源文件

`REPLAY-STATUS-d349.json` sha256 `0bfaec5b03cbc00100a19e0d5e79538a0307f420f3942ffcea31bc228515cc53`。由 `sync-replay-d349.py` 写下远端 `JOB-STATUS.json`。三个池的 `code` 都是 0，表示进程完成。文件里没有 git SHA。code 0 不是内容通过。

`REMOTE-REPLAY-d349.json` sha256 `cdd2dd2c3357a499b27586fdaaf905f5b97e115b5c47070e159706b7912452f3`。由 `prepare-replay-d349.py` 写下远端启动输出：root `/opt/p003/_audit/ark-natural-history-20261115-d34955cd`，pid 2073890，node `/usr/bin/node`，bytes 1735702。本地 `replay-candidate-d349.tar.gz` 同样 1735702 字节，sha256 `0e625f31c719235b0d16111ca74f1005b1b3a6c06022f8f167ed054fe703815b`。JSON 正文没有完整 git SHA，目录名带短 SHA `d34955cd`。

`POOL-d349.json` sha256 `1e0e89887981e0fe88067a0c92ce2fadd5d2e2f5e44e6d29063eba355a4d5cf1`，正文是 main/search/listening 三个 0。文件内没有候选 SHA。D 目录脚本里没有找到它的写入者。这三个 0 不是 256，也不是内容结论。

`CORPUS-ROUTE-d349.json` sha256 `d4db4530670945a03522b3886e1d6d4c09a04eefda123c949cf918cf657134b9`。写入者 `corpus-compare-d349.mts`。base `94a40ceb21705dd2f94fdcac62215df98a83d386`，candidate 就是本 SHA。三个池各 checked 256、unchanged 256、changed 空。脚本比较的是 answer、kb、memory-policy 函数在缺事实和新鲜事实下的返回。这是函数比较。它是 0 次新模型请求，也是 0 台真机。本轮读了脚本和结果，没有重跑这 256。

## 可复用的前序，以及它们没覆盖的 SHA

会话 322 的 `FINAL-GROK-REVIEW.json` sha256 `d14ca59479c4cfade45ececb825d32afc3de3b4e167de99da7f9e4baff0e0976`。候选 `b5ea904aca702bce1b21d1d8b9660eb1b3745c9c`，verdict PASS。范围是钉死树上的临时 SQLite、真实 HTTP 链路 20/20（聊天上游 mock 在 127.0.0.1），加上 15 个官方脚本。该文件自己写明三台真机闭环 NOT_VERIFIED。它没有验收 d349。

会话 324 的 `REPAIR-MODEL-READY.json` sha256 `8d6c918130be915fba5fec31e40f84977a285fc07f3d9a25ba51eace975db820`。候选 `69150858b1636193de8b252ef432895c7c7b79c0`，native session `01a1df74-35f2-7c01-9228-39bd365b3c80`。691 相对 `1aa462f47b3677564b04bd854d04444cc3304acf` 改了 `language.ts`、`xiaoke-kb.ts`、`ark-natural-history.test.ts`。本轮落笔时 `REPAIR-GROK-REVIEW.json` 不存在。不采用 324 的通过或失败，也不把 324 说成已经验过 d349。

相对 691 池未改的 537 个文件，本轮没有重跑 322 的 SQLite/HTTP 20。那些字节仍属于 691 树。691 自己的验收文件还没落盘。

## 发布

可以发布的是这一行 prompt。`publish_this_prompt_line` 为 true。`publish_whole_tree_as_production` 为 false。三台真机 normal 闭环：not_claimed。

grok(xAI)
