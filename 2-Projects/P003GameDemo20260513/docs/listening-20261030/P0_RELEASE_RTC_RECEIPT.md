# P003 倾听 P0：Brain 发布准备与隔离 RTC 回执

**Brain 本批开发、只读取证、发布/恢复准备已完成；完整 RTC 尚未通过，当前不可据此发布生产或交安卓宣称验收通过。** 本轮没有部署、重启、开闸、扩设备或修改搜索窗口。39仍负责真实 RTC 与房间清理；主会话独立验收。

- 工作树：`/Users/fu-121/.codex/worktrees/p003-listening-brain-20261030`；分支 `codex/p003-listening-brain-20261030`。
- 进入基线 `a784ad9b79a0da9b7b327f4ed17ea149be69f9cc`，clean；本批实现提交 `365dd76c8c62bec30b04a7cc87638626e4906f4e`。验证脚本元数据提交 `9a524a6b`（注明实际运行平台，业务payload不变）；本文件另作文档提交。
- 私有证据目录：`/Users/fu-121/.local/state/p003-listening-p0-20261030/`（下文记为 STATE）。凭据及原始源码快照不进 Git。

## 1. 本轮实际变动

1. **仅一处生产业务代码改动**：`listening-runtime.ts` 使用 `LISTENING_SERVICE_KEY ?? CUSTOM_LLM_API_KEY ?? ''`。新键仅供倾听内部严格鉴权，保留旧部署回落；显式空值/缺键失败关闭，不扩大普通聊天鉴权范围。HTTP wire 和三合同不变。
2. `scripts/listening-rtc-brain.ts`：loopback 隔离入口，动态加载正式 `deviceSessionRoute`、`getListeningAuthority`、`createListeningRoute`，使用 `Date.now`。批准构建清单不能生成 ready；Worker必须从外部完成实际注册、配置下发及 ACK。无 `testAuthority`、固定时钟、预塞 ready 或生产调试路由。
3. 合成唯一 SN/账号、随机服务/设备 JWT、独立 SQLite；启动清理继承的业务环境，禁止复用目录。输入0600、目录0700、输出凭据0600。实际 RTC 凭据仅通过启动进程环境传入，不写输出凭据文件/日志。
4. 文本 provider、普通聊天 SSE 为明确替身；ASR/TTS/SFU由39接实际服务。合成 provider 仅记录输入字符数、SHA、指定 marker 命中和同 room/session/trace/request/listening/epoch，不保存正文。默认52字符合成反馈仅供测播放中打断，不能作模型质量证据。
5. `listening-rtc-prepare.mjs`沿用旧 joint harness 的 esbuild/metafile 取证方式；导出65个源码输入SHA及两项只读 JSON 资源。`listening-release-prepare.py`、`listening-release-check.ts`做离线增量覆盖/恢复及实采 DDL 兼容检查，不含 SSH/生产写操作。

## 2. 实采现役（只在所列时间成立）

严格SSH入口 `aliyun-hk`，未修改SSH/系统防护。首次快照2026-10-30 **16:57:43 CST**；路由补采17:06:05、17:08:03；结束复核17:24:34，交付前再核 **17:39:32 CST**。

| 对象 | 实际观测 |
|---|---|
| 主Brain | `/opt/p003/server`；pm2 `p003-voice`，PID3213742、online、重启计数40；tsx加载`.env.local`及`src/index.ts`，Node22.22.2；3001 `/health` 200 |
| 搜索Brain | systemd `p003-search-brain.service`，PID3151603；`/opt/p003/search-canary-20261021/brain`，3007 `/health` 200；agent `p003-search-canary-20261021` |
| 实际域名路由 | 启用中的 `/etc/nginx/sites-enabled/kidshub-ai`：`/v1/`→3001；`/_canary/search-20261021/v1/`→3007。另有verification→3018配置，但该端口本轮不通，不能当现役健康服务 |
| 倾听配置 | config.db revision=3，enabled=false，allowlist空；管理配置在，运行链路未发布 |
| 搜索范围 | enabled=1，canary名单2台，expires_at_ms=1793589540000（11月2日11:19 CST）；未修改。普通搜索scope=all_registered、enabled=1、tools=0；与canary独立 |
| 数据结构 | 实采config.db/devices.db的DDL，没有复制用户数据、账号/故事/凭据行 |
| 最后复核 | 305个已采源码/环境摘要/nginx对象无漂移；主Brain与analytics PID/重启计数未变，3001/3007仍200。不是以后可永久沿用的部署许可 |

证据：`38-live-private.json`、`38-live-routing-private.json`、`38-live-assets-private.json`、`38-live-final-private.json`、`38-live-postcheck.json`、`38-live-deliverycheck.json`及相应0600只读脚本。进程环境presence只作旁证：`/proc/PID/environ`不一定反映Node后加载的env-file。

**已核普通聊天兼容风险**：主`.env.local`未设置`CUSTOM_LLM_API_KEY`，搜索池设置了。实采主路由代码在解析JSON前检查该键。对3001发送“故意错误Bearer+非法JSON”返回400 `invalid json body`，在模型、身份/DB副作用之前结束（`38-effective-auth.json`；17:34:07补采`38-listening-env-presence.json`确认本批4个独立键均缺省、env SHA未变）。因此不能直接给主Brain补共享键，否则会将普通聊天改成401。新内部键避免该连带变化。

现役主源码与本分支存在18处差异，搜索池3处差异；差异本身不判定新旧。没有证据证明现役整树等于某个Git HEAD，**以实际文件SHA/进程路径为版本真值**，不拿Git基线冒充云端回滚。

## 3. 最小候选、依赖与配置

候选以实采主Brain源码为底，仅覆盖下表13项，保留153个其他对象。特别保留现役providers/search、package/lock、搜索独立树、analytics、nginx及已验收顶部标签页。管理HTML相对现役仅两处语音说明文案，无布局回退。

| payload相对路径（根为`/opt/p003`） | 恢复方式 | candidate SHA前12位 |
|---|---|---|
| `server/src/index.ts` | 现役备份恢复 | `e58e6e4bf8c4` |
| `server/src/routes/device-session.ts` | 现役备份恢复 | `80909ac2d4c3` |
| `server/src/routes/listening-admin.ts` | 现役备份恢复 | `731efd1b9c71` |
| `server/src/routes/listening.ts` | 新建；恢复时删除 | `a268c9fd7521` |
| `server/src/listening-authority-store.ts` | 新建；恢复时删除 | `b3ad0514258e` |
| `server/src/listening-authority.ts` | 新建；恢复时删除 | `2c3509e5ca54` |
| `server/src/listening-content.ts` | 新建；恢复时删除 | `32bc94b8bcff` |
| `server/src/listening-grant.ts` | 新建；恢复时删除 | `5ed655ecaf99` |
| `server/src/listening-http-contract.ts` | 新建；恢复时删除 | `e190d8ef1d1c` |
| `server/src/listening-runtime.ts` | 新建；恢复时删除 | `d3ed750c365e` |
| `server/src/listening-settings-store.ts` | 现役备份恢复 | `ff7e93870450` |
| `server/src/listening-settings.ts` | 现役备份恢复 | `a48e2da1d9d6` |
| `web/dist/admin/index.html` | 现役备份恢复 | `2b867756ca13` |

完整before/after SHA、模式和绝对目标在 `STATE/38-release-v3/manifest.json`。新增7文件的恢复是按after SHA核实后删除；已有6文件从实际现役字节及mode恢复。

**依赖**：不装依赖，不更新package/lock或node_modules。现场版本hono4.12.19、@hono/node-server1.19.14、jose6.2.3、zod3.25.76、tsx4.22.1、TypeScript5.9.3；新增逻辑仅使用现有包及Node内建模块。候选完整入口149个输入已作Node22目标语法/导入图构建；依赖external，产物只是compile-check，不能拿它当可部署bundle。实采旧入口和保留现役的候选入口，均在本机Node24+临时库真实启动、health200、错误Bearer的非法JSON400。

**目标Linux Node22兼容门已补齐**：只读复制现役`/usr/bin/node`（22.22.2）和已安装node_modules到独立Linux构建机私有`/tmp/p003-brain-38-node22-*`，不安装/替换系统依赖。Node二进制SHA `81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90`在实采archive与实际执行端一致；候选/实采旧版均真实启动、health200、非法JSON普通chat400，检查进程随后停止。相同Node22.22.2还通过schema/旧settings兼容检查；未加载任何生产env/DB。详见`38-node22-result.json`。未执行生产进程切换、真实线上恢复及带真实provider的普通聊天体验验证。数据库测试为实采DDL+合成行：新表/触发器只增量添加，共享配置/搜索flag/registry行不变，实采旧settings代码仍能读取；不是生产库备份还原。回滚保留新增元数据表和触发器，禁止用旧DB/WAL覆盖正在使用的数据库。

后续配置只作准备，本轮旧→新实际均未变：

| 键/状态 | 实采旧值 | 未来实施约束 |
|---|---|---|
| LISTENING_SERVICE_KEY | 未配置（文件/安全旁证） | 首先进程内核实并复用获准Worker当前有效 `LlmConfig.api_key`；无有效值则阻断或先成对配置，不能Brain单边生成新值。拒绝空值/sk-noauth，不输出键值 |
| CUSTOM_LLM_API_KEY | 主Brain未启用；搜索池已配置 | **保持各自原值/缺省**，不为倾听开启主路普通chat校验 |
| LISTENING_GRANT_SECRET | 未配置 | 独立强secret（>=32字节）；不复用设备/管理员密钥 |
| LISTENING_WORKER_ACCOUNTS | 未配置 | 映射准确agent→可信Worker JWT accountId，不能用设备账号替代，不能几agent共一个凭据身份 |
| LISTENING_RELEASE_MANIFEST_PATH | 未配置 | 受控私有文件，绑定39实际默认feature发布构建SHA、能力和到期；批准不等于ready |
| AUTH_JWT_SECRET、现有RTC/模型secret | 已有 | 保持原值/读取链，不复制进Git或日志 |
| enabled / allowlist | false / [] | 本轮保持。即便将来落代码，未完成注册/配置ACK也不得宣称ready |

Worker目前从LlmConfig取服务Bearer。本轮隔离`credentials.json.worker_env`把LLM_API_KEY与内部键配为同一随机值，真实Worker进程须使用该文件。未来生产先在进程内验证现役Worker键是否有效并对应；不一致则阻断，不盲改搜索池共享键。本批只准备主Brain倾听链，**未给搜索独立Brain挂倾听路由，也未完成搜索池适配**。

## 4. 发布前核对与恢复步骤（本轮未执行）

1. 再次只读采目标文件before SHA、package/lock、env摘要、nginx、进程、倾听revision/总闸/名单，以及搜索两SN范围及窗口。必须在**同一次受控执行**内比较→备份→切文件；任何漂移停止并重做差分，不能直接使用17点快照硬覆盖。
2. 仅准备13个目标的同文件系统临时文件，核after SHA/mode；保存已有6文件的真实备份，新增7文件列明“原不存在”。环境仅备份本批涉及键的旧存在性/值到0600私有文件。库备份如需做，只用SQLite一致性backup作证据，不用于日常代码回滚覆盖。
3. 默认保持总闸false/空名单。先完成目标Linux环境及39候选联调门槛；未通过不得部署。本机演练不等于线上演练。单进程主Brain文件替换和重启可能造成短暂普通聊天不可用，后续切换须等待在途会话结束；当前没有做零中断发布验证。
4. 实施时只定向操作`p003-voice`、13文件及本批4个独立配置键；停止该进程后核SHA再次一致、逐个同目录原子rename、核after SHA，再按当前已核启动方式恢复。不要整树rsync，不操作analytics、searchBrain/Worker或nginx。未采用跨文件事务，不能在服务持续接新请求时逐文件覆盖。
5. 验证health、原chat鉴权行为、设备签发/顶部tabs/草稿/重登、搜索路由及窗口保持；再看真实Worker注册→配置ACK→runtime，不用健康检查代替ready。总闸/范围仍不自动打开。
6. 恢复：如曾开倾听，先现有管理员`POST /api/admin/worker-voice/listening/disable` `{}`并重读（含鉴权）；等租约撤权目标16秒，再停止本次主进程。**核目标仍是本批after SHA**才恢复6旧文件及mode、删除7新文件；如发现其他人的新版本，停止恢复而非覆盖。仅恢复本批配置键，保留后来并行键；不恢复整份env或任何DB/WAL。定向启动并验主chat/签发/tabs/搜索；不顺带重启搜索服务。

本树源码恢复点是a784ad9b；365dd76c是本批实现，可在专用分支审查后定向revert。它们均不是已验证的生产恢复包。

## 5. 已执行测试与产物

| 本轮真实运行 | 结果/边界 |
|---|---|
| `node --experimental-sqlite --import tsx scripts/listening-authority.test.ts` | 15 tests通过；合成身份/时钟单测，不作RTC证据 |
| 同命令 `listening-http-contract.test.ts` | 16 tests通过；三合同字节保持 |
| `listening-config-store.test.ts` / `listening-admin.test.ts` | 12 / 39 checks通过；临时SQLite、真实管理鉴权/CAS |
| `listening-integration.test.ts` | 1个完整HTTP+SQLite+provider-SSE测试通过；新增独立键优先、legacy fallback、显式空/缺失503、普通chat400/401互不影响。红→绿日志保留 |
| `listening-rtc-brain.test.ts`，源码入口及实际bundle各运行 | 通过；无注册不签、批准build不等于ready、配置ACK、签名room/trace/account、撤销；合成尾句marker进入summary且绑定trace/request/room；不是实机或实际Worker注册证据 |
| `tsc --noEmit` + 三脚本`--strict --target ES2022 --module NodeNext --skipLibCheck` | 均通过；初次临时命令漏strict造成Zod推断诊断，已保留失败记录并用项目一致选项重跑，未改无关源码 |
| 离线apply→restore、故意并发漂移、DDL兼容 | v3通过；恢复字节/mode一致，153其他文件保留；非生产服务切换 |
| 实采旧入口/候选入口启动、候选Node22构建图 | 本机Node24临时库启动通过；Node22 compile graph通过；随后Linux用实采Node22.22.2+现役依赖完成候选/旧版启动与schema真实检查，全部通过（38-node22-result.json） |

结构化命令/exit/log：`STATE/38-tests.json`；红绿、入口预检、schema/startup和构建结果均在`38-*`。v3与v2的13个payload字节逐项一致，v2本机启动/构建证据由v3的`*.prior-evidence.json`明确引用；Linux Node22检查另有完整真实运行。首次Linux检查的schema脚本因私有包根缺ESM标记失败，补齐隔离目录package.json的type=module后先重跑成功，再用全新目录完整复跑schema+两入口均通过；保留初次失败日志，没有改业务源码掩盖失败。

最终产物源锚365dd76c：

| 产物 | SHA256 |
|---|---|
| `38-release-v3/manifest.json` | `ed5f22e7fbb16ecb3eff764ff3e3a1a261e3be666fcd9e9a52a49ebef713a990` |
| `38-release-v3/payload.tar.gz` | `1d1f175fd1dc133a0137418d5470e7461b9be73860e442ed1b27a124301b993e` |
| `38-release-v3/restore.tar.gz` | `2ca31bfcc62158495f76e9670d32f539523c588690875c218f6c4446f250f470` |
| `38-release-v3/schema-check.json` | `03a7cbc9e5ded799219ab94c1e529e8872a5e64502c41b4ede3c976c063300fe` |
| `38-release-v3/listening.patch` | `4ee1a3d171ca41d4911b340f9d139c2f83cb6b025561e0cdf816c2fe740ffe07` |
| `38-rtc-brain.mjs` | `05752431e4cb9fcdca06021ee4654525434f6e2cf7ed9d1ae26e6b6e03d776f5` |

`payload.tar.gz`仅13文件，`restore.tar.gz`仅6原有文件；均无env/凭据/DB/node_modules。新增文件删除清单在manifest。`38-rtc-brain.mjs`是**隔离合成文本provider服务**，不可部署为生产Brain。bundle需同目录的`weather-places.json`与`search-routing-defaults.json`（SHA在bundle manifest）；不要只复制mjs。

## 6. 复跑及39对齐

在本树`2-Projects/P003GameDemo20260513/apps/server`，选全新目录，禁止复用生产目录：

```sh
node scripts/listening-rtc-prepare.mjs "$STATE/38-rtc-brain.mjs"
node --experimental-sqlite --import tsx scripts/listening-rtc-brain.test.ts
P003_RTC_BRAIN_BUNDLE="$STATE/38-rtc-brain.mjs" node --experimental-sqlite --import tsx scripts/listening-rtc-brain.test.ts
python3 scripts/listening-release-prepare.py "$STATE" "$STATE/38-release-review-new"
node --experimental-sqlite --import tsx scripts/listening-release-check.ts "$STATE" "$STATE/38-release-review-new"
```

`STATE`先由操作者设为上文私有证据目录；源码执行预检无需任何远端secret。构建依赖沿用已有node_modules；新输出的candidate/live目录如需运行TS检查，分别链接到本树已有node_modules，勿安装/改生产依赖。Linux精确运行时复跑入口为私有`STATE/38-node22-stage-and-run.py`（经Air直达home-studio-mesh），每次新建独立临时目录；输入为已只读取得的运行时包和无env/DB的源码/合成DDL包，SHA在38-node22-result.json。

39使用`STATE/brain-integration.json`/`worker-integration.json`协调：输入0600 JSON含独立agent、**本轮实际编译SHA**、port18738、`rtc_credentials_kind=real`及`synthetic_markers=["紫色风筝"]`；LIVEKIT三项只进启动进程。执行：`node --experimental-sqlite BUNDLE INPUT NEW_PRIVATE_DIRECTORY`，监听127.0.0.1:18738。Worker只从输出0600 credentials文件取合成LLM_BASE_URL/LLM_API_KEY/LLM_URL_QUERY。禁止启动时伪造ready或把worker-ready预检结果拼作RTC结果。

39于17:16导出的实际隔离启动bundle SHA与上表一致，`39-rtc-brain-verified.json`另核65个输入与提交365dd76c完全一致；真实SFU/ASR/讯飞TTS、合成账号/Android软件端/文本模型的边界已记录。初轮normal缺完整字幕正锚、部分情形input_ready超时并需要测试方收房；缺ready/撤权/断连有探针局部通过，但**不等于全链路验收**。39已修探针时序并确认max_jobs=1存在真实容量通告缺陷；max_jobs=2绕过已撤回，修复提交7e75a73f已通过其Linux回归并在max_jobs=1重跑矩阵，17:37仍观测到一次收房失败，最终RTC未判绿。最终同构建RTC、实际Worker注册/配置ACK及provider marker证据以其后续交付为准，本回执不提前判绿。

**17:40增量实际证据已收到并核对**：`STATE/39-brain-authority-evidence.json`（SHA `b3d4d8a9eaac84a1691736402f079bfa0e2a26fb5f1b32678531e6e43bf37d17`），绑定Brain365dd76c、Worker7e75a73f与上表同一bundle。61次真实worker-ready观测中，初次200/ready=false（revision2），约5秒后确认配置200/ready=true，随后持续刷新并应用revision4；隔离实例runtime=evidence_ready、applied_revision=4。两条`listening_feedback` provider观测均为168字符输入，`紫色风筝=true`，具有各自room/session/trace/request/epoch及SHA；一条trace为`p0-39-245923b5-20e4-48a8-be5b-b3c903bb4205`。这补齐实际Worker注册/配置应用和合成尾句进入反馈输入的Brain侧证据，未冒充HTTP预检。该ready/effective_enabled仅指私有合成实例，生产总闸仍关闭。该轮normal收房失败、lease探针SDK teardown rc=-6仍保留，不能把这些局部证据等同最终RTC矩阵通过。

最小下一步：39用相同冻结bundle+最终实际build SHA，先取得普通聊天audio+完整字幕+metrics正锚；再同trace做首句进入→立即续讲尾句marker→State在途→local_ready→反馈→播放中打断→退出恢复聊天，并在最终同构建轮继续导出Brain真实注册/ACK与provider观测，复核已有证据而非跨轮拼接。缺ready、过期、撤权、断网和自动收房分别保留失败记录。无真实pending-tail和有界停止时序，不认定打断通过。

仍待：上述最终RTC链、生产服务切换/恢复验证、真实Android麦克风/本地停音/真人听感、真实模型理解质量。后两项不在本批伪造通过；不等安卓即可继续云端隔离联调。主会话验收后再统一给安卓配合回执。

三合同保持原修订/字节（没有协议变更）：

| 合同 | SHA256 |
|---|---|
| `p003-listening-mode-v1.json` | `c055866fad0e9b69cdd75c526eeb2fee6ad97899641d792be63037a064bf2411` |
| `p003-listening-http-v1.json` | `86825d6281da13fdf17c32b04d5c9dcb4edf71ceb69257d839aacb9df0a99f1e` |
| `p003-listening-http-v1.fixtures.json` | `c58dd98ade3329d04e5c9b7622e7e4668c33483b38cd804f37257e5baa6d415b` |

署名：codex（OpenAI）| 2026-10-30
