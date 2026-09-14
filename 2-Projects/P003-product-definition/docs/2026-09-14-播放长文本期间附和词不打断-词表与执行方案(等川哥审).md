# 播放长文本期间「附和词不打断」——词表 + 执行方案（等川哥审，2026-09-14 08:45 CST）

分支：`p003/story-truncation-20260914`。川哥 2026-09-14 08:36 拍板方向：小可正在播长文本时，两字以内且命中附和词表的识别结果不打断、不起新轮、只记日志；停/停止/别说了/换一个/退出照常。词表进后台「热词管理」页，可手动编辑。

## 0. 先看数据（近 7 天两池 worker 日志，2026-09-07 起）

| 指标 | 数值 |
|---|---|
| agent 被打断总次数 | 4867 |
| 打断后 2 s 内提交成用户轮 | 4655 |
| 其中提交文本 ≤2 字 | 952 |
| 其中命中附和候选词 | **467**（嗯 216 / 对 66 / 啊 58 / 哦 33 / 是 31 / 行 15 / 对呀 9 / 哇 8 / 好的 8 / 好 8 / 嗯嗯 5 …） |
| 命中附和词且发生在长文本播放中（已合成 ≥80 字） | **4** |

读法：按「只管长文本」的范围，这个改动对日常聊天零影响，收益全在讲故事/科普；但数据也说明日常短回答里附和打断更多（463 次/周），要不要扩到全部播放，是观察期之后的第二个决定，先不做。注意 ≤2 字里还有「我/这个/就是/然后/那个」这类**真插话被判停切短**的开头词——那是判停问题，不进本词表。

## 1. 词表（请审）

**A 默认启用（≤2 字，纯附和/应声）** 27 词：
嗯、嗯嗯、嗯哼、哦、哦哦、噢、唔、对、对对、对呀、对啊、是、是的、是呀、是啊、好、好的、好呀、好啊、好嘞、行、可以、啊、哈、哈哈、哇、哇塞

**B 可选（催更/追问，含 3 字，超出「两字以内」口径，单独拍板）**：继续、然后呢、后来呢、接着呢、再讲、真的、对吧、是吧

**黑名单（服务端校验，永远不许进这张表）**：急停词表全部（停/停止/停停/停下/停一下/等等/等一下）、退出词表全部、别说了、换一个、换、不、不要、别、喂、小可、小可小可，以及句子开头词 我/这个/那个/就是/然后/那。

匹配规则：整句 normalize（去标点空白、全角转半角）后**精确等于**表内词才算，子串不算——「嗯，换一个」不会被吞。

## 2. 执行方案（说人话）

### 2.1 后台「热词管理」加第五类：播放中附和词 ↔ env `BACKCHANNEL_HOTWORDS`
- 服务端 `hotword-store.ts`：kind 加 `backchannel`，DB CHECK 迁移（照 device_asr 先例）；`validateWords` 新规则：每词 ≤2 字（B 组采纳则放宽到 3 字）、不得与打断语/退出词重叠、不得含黑名单；发布走现有通道与版本/回滚模型；`hotword.test.ts` 扩。
- admin 页（`admin-proto/index.source.html` → `public/admin/index.html` → scp）：第五张卡，文案「只在小可播放长文本时生效；停止/退出/换一个不受影响」，发布 diff 预览同现有。
- 64.90 `apply_hotwords.py`（仓库 `rust-worker/ops/` 有源）：`ALLOW_KEYS` 加 `BACKCHANNEL_HOTWORDS`；**重启范围补上 voice-worker-firstturn**——现在发布只重启 voice-worker-rust，One-shot 池共用 rust-worker.env 却不重启，发布对它不生效。firstturn 重启同样走「无设备通话」安全窗口 + 健康自检 + 失败回滚。
- **收益**：以后加减词 5 分钟生效，不改代码不找我；有版本、有回滚、有发布回执三方对撞。

### 2.2 worker（Rust）新逻辑
- 新 env：`BACKCHANNEL_HOTWORDS`（词表）、`BACKCHANNEL_MODE=observe|enforce`（默认 observe）、`BACKCHANNEL_MIN_REPLY_CHARS=120`（长文本判定：本轮回复 LLM 已产出的字数，不看已念到哪——孩子在第 3 秒说「嗯」也算）。
- 判定位置：用户句 commit 时的吞句分支，排在急停/退出之后、回声对撞之前。条件三与：agent 正在播放或刚被 VAD 暂停 ∧ 本轮回复 ≥120 字 ∧ 整句 normalize 后 ∈ 附和词表。
  - observe：只记一行 `backchannel candidate (observe) text= reply_chars= spoken_chars=`，行为不变。
  - enforce：不 commit、不起 LLM、不 abort、不投机；若已被 VAD 暂停则立即 resume（复用假打断 resume 路径）；记 `backchannel utterance ignored` + 快照 event kind=backchannel；字幕照发。
- 不动：急停词/退出词优先级在前；≥3 字或不在表内的句子照常打断；音频门 `MIN_INTERRUPTION_DURATION` 不改（第一版接受 ≤0.7 s 的短暂停顿再续播，观察期看体感再决定要不要在 interim 阶段就跳过暂停）；One-shot 首句阶段不受影响（那时 agent 不在播放）。
- 单测：词表解析/黑名单/阈值/observe vs enforce/「停」永不被当附和/短回复不生效/急停词与附和词重叠时急停赢。
- **收益**：孩子听故事随口「嗯/对/是」不再打断、不丢段落、不跳故事线（今早三次打断丢了 1079+522+~220 字）；observe 先跑两天拿真实误伤率，再一键切 enforce——切换只是改 env 发布，不用再发版。

### 2.3 发布顺序与验证
1. 服务端 + admin 页 + apply 脚本先上（不影响 worker 行为，只是多一类词表）；后台先发一版词表（进程 environ 对撞）。
2. worker 二进制：home-studio 构建 → 先上 voice-worker-rust（普通池，observe）看 24 h → 再上 voice-worker-firstturn（One-shot 池，observe）。⚠️ firstturn 现役是 V1.1 封版二进制 c2b84b2e…，这一步等于 One-shot 池发版：建议放在全量 OTA 观察期稳定后，并知会 codex（封版记录里二进制哈希会变）。
3. 两天后看 observe 日志：候选总数 / 其中随后 2 s 内孩子又说了完整句子的（=其实想插话，误伤）/ 长文本场景占比。
4. 切 enforce：发布 `BACKCHANNEL_MODE=enforce` → 真机复验三件事：讲故事时说「嗯/对」不停；说「停止」立即停；说「换一个」照常换。
5. 回滚：`BACKCHANNEL_MODE=observe` 或清空词表，发布即生效，不回二进制。

### 2.4 工作量与边界
- 服务端 + admin + apply 脚本约半天；worker 约半天 + 构建部署；观察 2 天。
- 不解决「孩子真想插话却被判停切成两字」（判停问题，另案）；不改设备端；不改 One-shot 合同。

署名：cc（Claude）| 2026-09-14 08:45 CST

## 决策与进度（2026-09-14 09:20 CST）

- **川哥 09:02 拍板**：词表只用 A（27 词），B 不进；One-shot 池（voice-worker-firstturn）的 worker 发版等全量 OTA 之后；后台「版本与 One-shot」加待办清单，相关待办都记那里，每次版本更新有来源。
- **已上线（server 09:17 CST 重启，health 200、零 error）**：
  - 「版本与 One-shot」新增「📝 下一版待办」卡：`config.db` 表 `release_todo`，API `GET/POST /api/admin/oneshot/todos`、`PATCH/DELETE /:id`（删除=软删 dropped 仍可追），每条带 target/owner/来源/操作人/时间；单测 `npm run test:release-todo` 8/8（含 guest 403、字段负锚、404）。已录 4 条待办（worker 附和词发版 / 投机轮不落库 / 端侧退出窗口与跨会话续讲 codex / 被动断连 evidence dump）。
  - 热词管理第五类「播放中附和词（不打断）」↔ env `BACKCHANNEL_HOTWORDS`：服务端校验（≤2 字、控制词/唤醒词/句首词黑名单、与打断语退出词交集门）、DB CHECK 迁移已在生产完成（日志 `kind CHECK 迁移完成(+device_asr,+backchannel)`）；`hotword.test.ts` 26/26。**A 表 27 词已存为草稿，未发布**（发布会重启普通池且旧二进制忽略该键，等 worker 发版一起发）。
  - 64.90 `apply_hotwords.py` 白名单加 `BACKCHANNEL_HOTWORDS`（备份 `apply_hotwords.py.bak-20260914-backchannel`；重启范围仍只 voice-worker-rust，firstturn 重启选项随 worker 发版一起做）。
  - admin 页直接改 `public/admin/index.html` 并 scp（与 B89 同路径）；线上 md5 5adacde3…；Browser 打开 /admin/ 无 Vue 模板告警。
- **已写未发（分支 commit 待推）**：worker `src/backchannel.rs`（纯函数：装配/黑名单/两字上限/observe|enforce/阈值）+ pipeline 三处接线（cfg、AgentTurn.llm_chars 计数、commit 路径吞句分支在急停退出之后回声对撞之前）；`cargo test` 325+5 全过。未构建、未部署任何 worker。
- **回滚**：server 三文件 + admin 页在 `/opt/p003/_backup/20260914-091752-b-todo-backchannel/`；apply 脚本 .bak 同目录。

署名：cc（Claude）| 2026-09-14 09:20 CST
