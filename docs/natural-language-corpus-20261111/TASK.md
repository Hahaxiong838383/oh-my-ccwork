# P003 自然话术补齐 · Grok独立研究任务

用户已授权：按天气、冷热、带伞、普通搜索四类，充分调研公开社交媒体与网络项目自然说法，补齐高频变体，模拟测试并回传主会话13；主会话继续其他任务。Grok负责研究/语料/候选词库/验收建议，Codex负责运行代码接续与最终发布。**不等待用户逐条批准，不修改生产。**

## 固定对象

- 本工作树：`grok/p003-natural-language-corpus-20261111`；运行源码基线 `77c33308082941197897cc3258b1592d0fabccac`。
- 当前生产单机：03800006，新词库版本r7-62c4debd97c6562c8f277931；截止2026-11-18 08:46:34 CST。不要改变该范围、配置、窗口、设备或服务。
- Worker源码：`2-Projects/realtime-voice-agent/rust-worker/src/search_routing.rs`、`search_weather_intent.rs`、`search_tasks.rs`；最终运行binary SHA b59660fa77bf11d6f2e7c6457702847657b504863579aa178b98cf71a6575579。
- 冻结Linux预览CLI：`/home/hahaxiong83/local/p003-lexicon-implementation-20261111/listening/2-Projects/realtime-voice-agent/rust-worker/tools/search-route-preview/target-final-reviewed/release/search-route-preview`，SHA f978af6f93a76400fe7c6d1c9601dca5dfd979cc305a280e57f1d2b982a77f44。只用build主机离线重放，不连生产。
- 真实已发布配置与来源：`/Users/fu-121/.local/state/p003-lexicon-implementation-20261111/routing-after.json`、EXACT-FINAL-SOURCE.json、grok-freeze-review/RESULT.json、grok-amap-final/RESULT.json。
- 最新发布回执：`/Users/fu-121/.codex/worktrees/p003-lexicon-listening-brain-20261111/docs/p003-lexicon-phase1-20261111/`。
- 已知缺口：“打伞”“会不会热”、复杂转述等。单字城市pure route与Session暂存不是同一观测层；不要把纯路由标签直接当作网络外发。

## 交付工作

1. 真实联网调研，不靠凭空想象。覆盖至少4种不同公开来源类型：公开社交讨论/问答、中文语音助手或智能家居公开说明、GitHub公开项目/issue/意图语料、中文对话数据集/论文。尽量达到12个独立可访问页面；不足须如实记录访问限制，不凑来源、不绕登录、不批量抓私域/私人账号。每条来源给标题、原URL、访问日期、具体支持的表达族、许可证/可复用边界。社交帖子短引或改写，不搬运长文，不把网络访问次数称使用频率。
2. 建可运行、去重的JSONL/JSON语料。目标约200–300条独立场景，四类正例每类至少35条，另不少于60条困难负例/上下文场景；质量优先，未达到须说明。来源原话（少量短引）、基于来源改写、合成边界、已有私有脱敏样本必须分标签。不要把合成数据冒充真实用户；历史原始聊天不得上传外部模型/网站。
3. 覆盖口语、省略、语序、语气/礼貌词、日期、冷热体感、带伞/打伞/淋雨、模糊或缺失地名、省市重名、追问/改口/取消；普通搜索区分明确联网意图/当前公开事实与普通知识问答/闲聊。负例含否定、引用别人话、比喻、室内空调/体温、个人游戏资产、隐私问题、无城市、多城市、ASR地名错字。勿以模糊匹配擅自改中国地名。
4. 先按意图族划分开发集/留出集并冻结hash，防止同义改写跨集合泄露；完整记录预期action/place/day_offset/requested_info/clarification、不变量、source_id。持有全部数据的研究者不能宣称独立盲测。旧88条与Grok24条数据和期望不得改写，另列回归。
5. 使用真实冻结CLI做当前基线模拟重放。先跑3–5条已知正负控制验证runner/executable/config SHA；再跑语料。按四类、误触发/漏触发、地点日期槽位报告，不只报总命中率。远程仅通过已验证build只读执行路径；若不可用，交明确NOT_RUN及可运行脚本，不以人工判断充当实测。可以写docs目录下的研究脚本/测试数据，不改运行源码、Cargo依赖、任何生产文件或其他工作树。
6. 产出 `PROPOSED_LEXICON.json`/配置候选及 `IMPLEMENTATION_NOTES.md`：哪些变体仅配置可补，哪些确需Worker归一化/Brain建议词同步，逐文件指出最小改动。可按候选配置用同一CLI对比；代码尚未实现的预期提升必须标注未测，禁止拿未来效果报通过。不要为穷举表达写无限正则/新服务。
7. 语义兜底只做有界设计：强/弱联网意图触发、规则无法判定才考虑后台已有模型tool calling；预算/超时/取消/任务epoch/重复提交/确定闲聊跳过。普通聊天不新增每轮LLM调用；与现有P1/P2职责对齐，不新建第二套全程赛马。给出低成本优先方案和剩余不确定性。
8. `REPORT.md`结论先行，附SOURCES.md、CORPUS、split-manifest、BASELINE_RESULTS、candidate结果、PROPOSED_LEXICON、最短真人变体用例、TODO与验收阈值（冻结硬负例零新增误触发，目标表达族覆盖和地点/日期正确，真实CLI耗时不过度增长）。明确文本模拟≠ASR声学≠供应商≠真机声音通过。
9. 检查来源/泄密/重复/标签及git diff，只commit+push自己docs/natural-language-corpus-20261111内的产物到本分支，核ls-remote。无需合并、无需部署。最终向主13回传：完整SHA、路径、真实基线数字、主要缺口、最小补齐建议、仍未验；不要仅发研究方向。

## 汇报与权限

私有协调目录：`/Users/fu-121/.local/state/p003-natural-language-corpus-20261111`。主13已授权接收结果。完成或实质阻塞时调用该目录 `report_completion.py --file <短回执md>`，只发一次；保留回执与去重marker。若通道不可用，正常结束delegate并给全部路径，主13可从委派结果取回。不要为汇报无限重试或重复唤醒会话。中途自行推进，不给用户弹可选批准框。

代码发布权在Codex主13；Grok可以提交候选数据和研究脚本，但不改本轮已经上线的运行源码。研究输出不是新版本已完成的声明。
