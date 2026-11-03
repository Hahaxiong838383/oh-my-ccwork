# v376 倾听联调：Brain 历史取证回执

**结果：Brain 侧历史签票、设备范围和语音能力已核实，未发现足以解释本次无 proposal 的 Brain 缺陷；产品仍未完成真机验收。** 本轮不修改业务源码、三个冻结合同或生产配置，不部署、不重启、不唤醒设备。

取证：2026-11-03 10:13–10:22 CST。代码基线 `eeac0a68ef9886487958fdb5780d60474b8357ff`，原分支 `codex/p003-listening-brain-20261030`。启动时工作区干净。

## 1. 历史证据与结论边界

原始客户端回执测试窗口为 **2026-11-02 19:52–20:01 CST**，早于当晚 v375 后端发布。附件 SHA256 为 `aac82635aee578d14664f9470abb322303a676733a8858c82056278874c32ddf`。

| 核验项 | 实际证据 | 能说明什么 |
|---|---|---|
| 身份 | 主 Brain `devices.db/device_session_log` 中附件 trace `af4602f5-6491-45a3-9e5e-ee1cefb44af4` 唯一命中，19:57:23.471 签票；尾号03800006。SN/room SHA 与39独立采集的 Worker journal 映射一致 | 不是仅凭旧名单猜设备 |
| 配置历史 | `config.db/listening_settings_audit`：11/2 18:08:28.760 保存 rev6，enabled=true、仅03800006、story/sharing/singing、voice_invitation_enabled=true；至测试结束无后续配置版本 | 当时具备配置资格；不是拿今天 ready 代替历史 |
| 历史能力 | 8次成功签票均仍有 `listening_sessions` 权威记录，均含 `listening_mode_v1`、`listening_voice_control_v1` 及 `voice_control.version=1` | 两能力真实进入主权威登记；不只是客户端自报 enabled |
| 派单 | 8条签票日志 selected，agent=`p003-search-listening-20261030`，registered=true，健康租约余量7633–12587ms；权威登记 build=`b663e0e09d423ba282e21e242569774466fcfdb0` | 未见派到普通旧 Worker 或因健康门降级 |
| 授权有效期 | 两次倾听尝试分别签于19:58:02.041、19:59:20.478，grant期限20:28:02、20:29:20；上层窗口截止11/4 17:58:31 | 两次 final 时尚未达到已登记截止；不证明后续租约请求成功 |
| 进入记录 | 对上述8个 session 查询 `listening_entries/listening_requests` 均为0，8条 session仍保留 | 没有已持久化的进入/模式租约证据；不能排除未落库的失败HTTP尝试 |

`source_generation=0` 是主权威数据库内部变更计数；派单日志 `canary_generation=v374-listening-ark-20261102-1793613511` 是候选窗口标识。二者属于不同字段域，不能因不相等判错。

语音能力登记的签发前提包含核准构建、可信 Worker 注册、配置 revision/SHA ACK 和设备凭据/registry 检查。该结论由保留的登记记录、配置审计和实际源码条件共同推得；**没有保留下每次 worker-ready HTTP 原文，不能将其称为逐次ACK抓包**。

### 两次倾听尝试的对齐键

| CST 签票 | trace | session | 授权 |
|---|---|---|---|
| 19:58:02.041 | `3c770bf4-2eb6-4bf6-8cc9-38ab3970b77e` | `bb7eca3c-5bd1-4be3-97ca-a4e7e700a991` | 两能力、voice_control、正确agent/build |
| 19:59:20.478 | `172f1281-3387-4401-b697-de5456ed5534` | `c9ab6927-3364-49f4-a6e8-b1519b045f74` | 两能力、voice_control、正确agent/build |

39提供的脱敏 journal 形态证据已经读取并交叉核对身份、时间及源码指纹：19:58:13 的2字 final 仅唤醒词；19:59:32 的9字 final 不含唤醒词或“听”，均未命中原有限口令。各自 final 与普通 commit 文本摘要相同。现有 `listening_voice.rs` 要求完整呼名口令，因此这些证据**不支持“推荐完整口令已被服务端识别，却被 Brain 拒绝”**。声学切分发生在哪一层、完整口令实际到达后能否跑完，仍需隔离正对照及真人验证。此处不转发用户原话。

## 2. 协议检查与39协作

- proposal 沿既有可靠 RTC `control` topic，`src=worker`；Android仍唯一分配 control seq。Brain 不发送 proposal，签票后识别/提议属 Worker 层。
- Android必须以当前房间的服务端 AGENT kind、`attributes[lk.agent.name] == response.expected_agent_name` 验证并锁定实际 sender identity；不能把调度名直接等同 `agent-<job_id>`。本轮未取得 Android 实际校验执行证据。
- proposal 3000ms仅约束首次接受；enter接受后沿原进入超时；state查询不消费 pending proposal。三个合同均未改字节。
- 原合同 `recognition.normalization` 明确呼名开头、拒不完整前缀；“近期唤醒后无呼名同义句”并非原合同已有规则。已向13/39指出边界，不自行放宽唱后反馈、引语、歌词或权限门。
- 已交39本树新构建的既有 RTC harness，复用真实签票/authority/worker-ready/config ACK，`Date.now`、独立SQLite、合成身份及确定性文本provider。39独占真实RTC房间和进程启动/清理；本38没有启动真实RTC会话。

测试包 `rtc-brain.mjs` SHA256：`952e58ac01c278836ee7466f771cf0bc10469dbddb2bc0c344c4e22f7424848a`；manifest：`84e01a52c929b806d1d991fdfb67ff621edeecde5600258bc714a24acfd7263c`。65个源码输入及两份资产已重新核SHA。此包是隔离测试入口，不是生产发布包。

## 3. 现役差分与恢复点

11/3 10:16 当前管理只读响应：rev6、ready=true、applied_revision=6、active_sessions=0；仅作为该时刻状态。当前主进程PID3937878，候选Brain PID3913718，未作变更。源窗口截止仍为11/4 17:58:31，本轮没有延长。

线上185个 `src/**/*.ts` 与本树对撞：124相同、37不同、24本树缺失；这只是文件指纹差分，不是37个缺陷。差异包括BLE绑定、微信、Ark、搜索和埋点。已逐项核实 **v375提交 `856552b9` 的21个发布目标全部与当前线上一致**，admin SHA为 `c4a47f1025247df39cf80be421c7e2f58f64a269d0eb74e2dd07909485cf1634`。

关键保护点：实际 `listening-authority.ts` 比本树多 `acceptsDeviceBindingCredential` 检查，`device-session.ts` 多 `noteBleActivation` 及绑定版本返回；这些是现役BLE功能，不应回退。历史签票成功也说明本次身份通过了当时授权链。

**本轮无源码候选、无需生产回滚。** 如后续确有源码修复，必须基于实时现役精确差分发布，不能整树覆盖。Git基线 `eeac0a68` 只供撤销本轮文档；线上真实备份仍由主13发布记录管理：`/opt/p003/backups/v374-ready-20261102`、`/opt/p003/backups/v375-tiering-20261102T135555Z`，禁止把本树Git版本当线上回滚包。

## 4. 本轮实测与可复跑入口

在本树 `apps/server`，Node v24.19.0：

```sh
node --experimental-sqlite --import tsx --test scripts/listening-http-contract.test.ts scripts/listening-authority.test.ts scripts/listening-integration.test.ts
node --experimental-sqlite --import tsx --test scripts/listening-rtc-brain.test.ts
node scripts/listening-rtc-prepare.mjs /private/tmp/p003-v376-brain/rtc-brain.mjs
```

结果：首组32通过、0失败；入口隔离回归1通过、0失败。涵盖合同、能力交集、旧客户端降级、鉴权/短租约、真实回环HTTP签票与独立SSE内容、配置ACK及撤权。身份、凭据、数据库和provider均为隔离测试用途，不等于真实Android/真实模型/扬声器验收。无业务源码变化，未重跑全项目或声称新增红绿修复。

协调目录：`/Users/fu-121/.local/state/p003-v376-coordination-20261103/`。

- `STATUS-38.md`、`brain-integration.json`：阶段状态和39可直接使用的入口。
- `evidence-38/historical-brain-summary.json`：脱敏签票、权威记录、配置审计、日志行号/摘要。
- `evidence-38/current-readonly.json`、`source-drift.json`：当前配置及源码指纹；完整差分留此处。
- `evidence-38/verify-38.py` → `verification.json`：可复跑身份/房间摘要对撞、8会话资格、现役v375 21目标、合同/测试包一致性检查。
- `brain-targeted-tests.log`、`rtc-entry-tests.log`：本轮实测日志；`verification.json`记录其SHA。
- 原始私有身份映射只留0600证据文件，不进Git、不外发。Nginx本次所读日志未检出倾听内控路径，但未确认该路径日志覆盖，**不把零行当作没有请求**。

## 5. 未完成与安卓最小下一步

1. 39先跑隔离完整推荐口令正对照，核 actual final→proposal→enter→local_ready→completed；失败再按明确层修复。其结果另由39/13验收，本回执不预填通过。
2. 白天或真人在场，用新RTC会话清晰连续说“小可先听我讲个故事”，紧接叙述；按同trace记录proposal_id、Android seq/request_id、可信sender校验结果及ACK顺序。无声仅凭听感不能证明已进入。
3. 再跑一次反馈→回倾听→语音退出→下一句普通聊天，以及唱后明确呼名、歌词不误触、断网/超时；不绕过夜间无人门禁。
4. 钱包null/0与normal快照归45线；本轮不补写余额、不混算方舟通过。主13统一验收/部署。

署名：codex（OpenAI）| 2026-11-03 10:22 CST
