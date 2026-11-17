# 主13补修独立复验（未提交工作树）

最新结论（2026-11-17 12:13 CST）：第二版补修后，两项已报告缺陷均通过独立复验，可以关闭这两项代码缺陷。下文12:12记录保留第一版补修仍有遗漏的过程证据；不再代表最新状态。真实RTC/Android/供应商/Linux联合验收边界未变，仍不能据此声称生产验收通过。

第二版没有扩展独立样本集合，原样复跑 `brain-fixed-probe.mts`：13个非姓名负例全部不写nickname、不saved；6个裸名/明确自述正例全部正确保存，进程退出0。证据 `brain-fixed-v2-probe.log`。此前4个漏项“再说一次／没听清楚／稍等一下／请重复一遍”均已关闭。

第二版已改为有限等待/重述语法，未引入LLM、协议变更或网络调用；代码复查未发现本次改动引入新问题。Rust生产文件SHA256与上轮独立GREEN完全相同，因此不再重复已通过的边界测试。

第二版所核生产补丁见 `reviewed-second-fix.patch`；SHA256见 `reviewed-second-fix-sha256.json`：

- Brain store：`a1ac4fc82c5d46a16056ce69ff289c77d7a1fb3af6e5acbaf72e0c81d8ce786b`。
- Rust runtime：`b32d69baab41fe6c7f61de7a43444bb655ecae2bcf7ed1081da6e761755386d6`。

尚未新冻结commit，最终SHA由主13提交后核对。本助手仍仅写独立审计目录。

## 第一版补修记录（已被上述第二版结论更新）

2026-11-17 12:12 CST。结论：Rust重复回执问题已修复；Brain原始负例已修复，但同类常用重述/等待句仍会落库，昵称问题尚未完全关闭。没有编辑373树、部署或真实数据写入。

复验对象是HEAD `bf2b37d563ff749d82fca24282ed5878740f3e4e` 加主13未提交补丁，尚非新冻结SHA。复验时生产补丁与校验值见 `reviewed-first-fix.patch`、`reviewed-first-fix-sha256.txt`。

## Rust：通过

原始外部RED测试对补修生产模块复跑通过：相同audio_complete重放不改变state，也不再清掉fresh VAD。另在外部测试补查以下边界，全部通过：

- 旧begin重放不改状态、不清新语音。
- request_exit_prompt带来真正新cue时，旧VAD被清掉。
- speaking期间调用speech不能取得回答资格。
- audio_complete首次转waiting_exit后，迟到ASR仍被拒；新speech后才放行。
- waiting_exit中的audio_complete重放也不吞新语音。

证据：`rust-replay-fixed.log`、`rust-replay-fixed-boundaries.log`、`rust-probe/src/lib.rs`。原RED日志保留。1个独立测试内覆盖上述断言，通过，39个候选原测试过滤未跑；没有重复宣称主13全量测试结果。以revision/active/blocks_input三元组辨别实际状态转换，覆盖当前状态机，没有发现这次改动引入新问题。

## Brain：原例通过，仍有同类遗漏

Node v22.23.5、随机临时SQLite库；直接调用候选生产VoiceOnboardingStore，保留真实事务写入断言。`brain-fixed-probe.mts`与`brain-fixed-probe.log`：

|输入组|结果|
|---|---|
|原始四句“等一下／再说一遍／算了／拒绝”|均未写nickname、未saved|
|其余补测“等一等／稍等／再问一遍／没听清／跳过”|均未写nickname、未saved|
|裸名“星星／安安／Emma”|均按原值saved|
|“我叫星星／你可以叫我星星／我的名字是小明”|分别保存星星／星星／小明|
|“再说一次／没听清楚／稍等一下／请重复一遍”|四句仍全部保存成nickname并返回saved|

最后四句是原审计“澄清请求误存昵称”的同类残留，不另立第三项发现。新增过滤仍仅匹配少量整句固定表达；例如“一遍→一次”“没听清→没听清楚”即绕过。测试最终按“不应保存”断言失败，4!=0。建议以小型等待/重述语法覆盖这些常用变体，并保持裸名、明确自述的正例，无需新模型、新协议或远端依赖。

署名：codex（OpenAI）| 2026-11-17 12:12 CST
