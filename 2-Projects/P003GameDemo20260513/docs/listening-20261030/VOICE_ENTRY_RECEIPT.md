# P003 倾听语音入口：Brain 38 开发回执

结论：**本会话Brain职责已完成并提交，可交主会话独立复核；整个产品尚未端到端验收或上线。** 未部署、未开倾听总闸、未扩设备、未改搜索窗口/生产音频/Android/Worker树。现役顶部标签布局保留，只有倾听开关说明文字更新。

| 代码锚 | 内容 |
|---|---|
| 基线/回滚目标 | `aa667364d400fdfdcea5f2c7056ed63e143ba1eb`，开始clean |
| 初始冻结 | `6235bbaa`，mode/HTTP/fixtures可执行JSON |
| 实现/最终合同 | `5fb0c0b0c41705dff12978d17f356eb9842e64b2`；原分支`codex/p003-listening-brain-20261030` |
| 后续文档提交 | 见本文件所在HEAD；最终HEAD/远端核同记录在本机`/Users/fu-121/.local/state/p003-listening-voice-20261030/38-done.json` |

- 签发：新Android supports、批准构建能力、鲜活Worker ACK均声明`listening_voice_control_v1`，且原`voice_invitation_enabled=true`才签可选`voice_control`；签名job与客户端顶层合同同源。原五项Worker能力继续兼容，无新授权系统、配置字段或数据库迁移，不强制ready。
- 权限：持久保存本轮实际协商标记；旧库仅存的原始supports字符串不能冒充新能力。独立HTTP新增真实`voice_command`来源，含唱歌明确呼名唱后口令；仍检查租约/registry/Worker/场景/快照/epoch/单次消费，模型后重验。旧故事/分享`voice_invitation`与开关保持，旧唱歌仍button-only。
- 配置：复用已有开关、CAS/审计/恢复，值与快照hash格式未变。关闭对新进入生效，已有entry使用冻结参数；有效会话的安全退出不受邀请开关阻止，paused/撤权仍关旧RTC。页面显示/保存/回读一致，不把配置保存说成运行生效。
- 控制合同：`listening.proposal`来自可信Worker，独立proposal_id/3秒TTL，不占Android seq；Android自动echo至原enter/exit，local_ready及两阶段ACK沿用。首句、过渡收音/缓冲、口令去除、超时暂停、退出后仅下一句聊天均有约束和JSON样例；实际管线由39实现和取证，无新确认音。

## 合同精确版本

control/HTTP主version均为1、status=frozen_for_integration。mode的voice_extension_revision=2；HTTP/fixtures扩展修订1（字段未因修订2变化）。修订2仅澄清口令前安静边界和元语言问句负例，已在`contract-ready.json.changes_after_freeze`登记，未静默漂移。

```text
p003-listening-mode-v1.json          9711a8fabc04dc99c718b09a8d8287ccaed8ad7ed0da92370c2df843d46bf5e3
p003-listening-http-v1.json          86825d6281da13fdf17c32b04d5c9dcb4edf71ceb69257d839aacb9df0a99f1e
p003-listening-http-v1.fixtures.json c58dd98ade3329d04e5c9b7622e7e4668c33483b38cd804f37257e5baa6d415b
```

位置：本树`4-Assets/contracts/`。39按`/Users/fu-121/.local/state/p003-listening-voice-20261030/contract-ready.json`复制逐字节版本。接线说明在同目录`38-contract-notes.md`，明确唱歌用`voice_command`，不可误沿39早期建议的旧`voice_invitation`。本轮已只读核对39工作文件：三份合同SHA均一致（Worker HEAD仍9156bf94，其本轮实现未由38代提交/代验）；最终仍需39交付commit/测试核同，不把本地文件一致当线上就绪。

## 真实测试与边界

命令cwd：`2-Projects/P003GameDemo20260513/apps/server`，全部使用临时SQLite/合成身份/本机HTTP/本机SSE模型替身，无.env/生产连接。

```sh
node --experimental-sqlite --import tsx --test scripts/listening-http-contract.test.ts scripts/listening-auth.test.ts scripts/listening-policy.test.ts scripts/listening-authority-store.test.ts scripts/listening-authority.test.ts scripts/listening-content.test.ts scripts/listening-integration.test.ts scripts/search-chat-abort.test.ts
node --experimental-sqlite --import tsx scripts/listening-admin.test.ts
node --experimental-sqlite --import tsx scripts/listening-config-store.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck scripts/listening-authority.test.ts scripts/listening-content.test.ts scripts/listening-integration.test.ts
node scripts/listening-admin-ui.cjs
node scripts/brain-tabs-ui.cjs --local
```

- 最终相关测试 **61/61**（包括新旧能力/开关矩阵、历史raw supports防提权、唱歌一次许可、模型中撤能力、严格fixtures、真实签票及独立SSE反馈、普通数据无写入/取消回归）；管理API **39 checks**，配置 **12 checks**；项目及改动测试的严格TypeScript检查通过。
- 两条浏览器入口复用已装Playwright/Chromium，沿既有`P003_PLAYWRIGHT_MODULE`/`P003_CHROME_BIN`运行：真实卡片开关关闭→保存→重读、恢复true、冲突/503/重登通过；完整页面四标签、设备状态和草稿保留、键盘/sticky/1024/原页重登通过，pageerror=0、完整页业务写=0。交互保存仅临时SQLite。
- TDD证据：新wire两项先拒绝、新协商/反馈用例先失败；去掉客户端语音字段后真实HTTP测试如期失败，再恢复通过；历史仅广告cap用例先得到200而应403，补独立协商标记后通过。原始日志`/tmp/p003-voice-*-red.log`和最终`/tmp/p003-voice-brain-final.log`等，仅本机测试产物。
- 首次额外单文件tsc命令未启strict，触发既有路由的类型收窄错误；按项目strict选项重跑通过，未改搜索或放宽类型。普通取消回归的临时目录无课程图资源，原有降级日志保留，不代表读取到真实课程知识库。

## 未验、安卓接续与最小下一步

[安卓交接清单](../P003_LISTENING_ANDROID_HANDOFF_20261030.md#7-安卓本轮最小接续清单尚未交付验收)已列能力、可信实际sender、自动seq/echo、幂等/超时、保持麦克风/idle、本地清队列、无屏确认及取证。Android代码/APK未在本轮改动。

39本轮首句ordered→RTC、实际Orchestrator普通LLM/filler隔离、过渡buffer、回声/引语/歌词负例、安静阈值及故障收房需其自身证据；本回执不代验。新合同的Rust→Brain联合、真实注册/租约墙钟、Android/RTC/扬声器、真人唱歌和普通聊天体验、回滚演练均未由38本轮证明。文本规则不能保证零误触；MacTTS/替身也不是实机通过。

最小下一步：39最终commit/合同SHA与本回执核同，复用既有`listening-joint-prepare.mjs`和39 joint harness隔离复跑，再由主会话验收汇总给安卓；无需新服务/新分支/审批框架。真实设备测试按后续实际证据推进，本轮不部署或自动开窗。

## 精确恢复点

本轮尚未部署。要撤开发源码，在原分支撤`5fb0c0b0c41705dff12978d17f356eb9842e64b2`再撤`6235bbaa`，返回基线语义；保留`aa667364`已合入的顶部标签。无需恢复整库，现有session JSON新可选标记可由旧代码忽略。跨端降级时新voice能力不再声明，Worker恢复原五项能力/旧HTTP触发枚举，不能对旧Brain发送第六项或`voice_command`。不自动执行这些操作；不触碰已发布09:50管理后端和10:17静态页。

署名：codex（OpenAI）| 2026-10-30 14:02 CST
