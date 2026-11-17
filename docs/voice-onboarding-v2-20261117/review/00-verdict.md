# P003 语音教学 v2 合同审查结论

日期：2026-11-17
审查者：Grok（只读）
回执对象：主 13
状态：冻结建议。不是实现，不是新 SHA 验收通过。

## 任务边界

本审查只依据用户 2026-11-17 当轮任务，以及附件：

`/Users/fu-121/Library/Application Support/Codeg-company-studio/uploads/conv-12-codex-13/P003_语音交互教学_客户端规则变更与服务端对接回执_20261117.md`

未恢复、未搬迁、未伪造会话 373 的对话记录。373 的已落库结论只引用工作树内 `docs/voice-onboarding-20261117/ROOT-ACCEPTANCE.md`。

已核对工作树：

- 路径：`/Users/fu-121/.codex/worktrees/p003-voice-onboarding-20261117`
- 分支：`codex/p003-voice-onboarding-20261117`
- HEAD：`81cbd0b10be15037f8f3fe0ea4846eb6bac6236b`
- 其下可见：文档 `81cbd0b1`，主 13 补修 `c462462b`，原候选 `bf2b37d5`
- 审查开始时 `git status --short` 为空

本审查没有改上述工作树，没有写生产库、端侧、配置，没有 SSH、部署或安装依赖，也没有重跑 21/21 与 39/39。那组成绩以 `ROOT-ACCEPTANCE.md` 的已记录结果为准，不在本文重新宣称。

产物只在本目录。代码由主 13 修改。改完后固定新 SHA，再按 `03-acceptance.md` 验收。

## 结论

接受附件的业务分工：客户端固定第 1 题年龄、第 2 题性别、第 3 题昵称，并负责跳题、退出和本地完成；服务端只做识别判定、记忆保存和教学隔离。

不接受把这套语义写进现有 `v=1` / `voice_onboarding_v1`。v398 与当前 HEAD 的合同仍是「服务端按缺项选题」。新客户端走新能力 `voice_onboarding_v2`，载荷 `v=2`。只声明 v1 的旧客户端继续走现有路径。

当前 HEAD 不因本附件返工。v1 路径保持 `c462462b` 已修的两条行为：非姓名短语不落库；重复 `audio_complete` 不清掉已经记下的 fresh VAD。

## 四项核定

1. 180 秒和客户端 `finish` 互斥。180 秒只结束服务端隔离，终态是 `expired`，不是教学完成，也不代播 4A/4B。`finish` 只在租约未到期时结束隔离，不延长 180 秒，不把记忆标成 skipped。先发生的那一个终态获胜，后一个只做不写库的幂等回执。详见 `02-machines-and-functions.md` 第 4 节。
2. `question_skipped` 本身不写 `family_member`。同一 `request_id` 重放只回原回执。跳题之后才到达的旧题识别不得写入、不得推进。跳题前已经进入脑端事务并先提交的同一题写入可以留下，但工人不得再把它发布成推进当前题的回执。
3. 年龄只写孩子行的 `age_years` 与 `age_observed_at`。禁止写 `birthday`，禁止由「六岁」换算日期，禁止调用 `upsertBasics` / `upsertProfile` / `copyProfile`。
4. 家长行只读不写。已知家长昵称、性别、生日、年龄不得用来跳题，也不得拷到孩子行。孩子行已有资料也不构成跳题理由；客户端仍发三题，有效新答案只覆盖对应的那一个孩子列。

## 主 13 下一笔要动的范围

只动教学链，按 `02-machines-and-functions.md` 的函数点做最小分支。不要加每句话 LLM，不要新播放服务端题干，不要改 401、设备凭据、Wi-Fi、MCU 或普通聊天的日常补问文案。

v1 回归仍是现有 Brain 21 与 Worker 39。v2 用例在 `03-acceptance.md`，全部是新增。

## 阅读顺序

1. `01-freeze.md`：字段、动作、v1 共存和能力协商。
2. `02-machines-and-functions.md`：三题状态机、函数落点和真实边界。
3. `03-acceptance.md`：下一 SHA 必须执行的用例。

## 审查结束时的工作树

审查开始时工作树干净，基线就是 HEAD `81cbd0b10be15037f8f3fe0ea4846eb6bac6236b`。写完本目录时，工作树已出现未提交改动。这些改动不是本次审查写入的，也没有回滚。

已看到的路径：`device-session.ts`、`voice-onboarding.ts`、`voice-onboarding-runtime.ts`、`voice-onboarding-store.ts`、`voice_onboarding.rs`、`voice_onboarding_tests.rs`，以及未跟踪的 `voice-onboarding-v2.ts`、`voice-onboarding-v2.test.ts`、`docs/voice-onboarding-v2-20261117/`。

本目录的冻结建议只对照审查开始时已提交的 HEAD，不覆盖、不承认这些未提交改动。下一份验收仍等主 13 固定新 SHA 之后，按 `03-acceptance.md` 重跑。
