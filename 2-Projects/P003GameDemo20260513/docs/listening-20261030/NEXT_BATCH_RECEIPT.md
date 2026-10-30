# P003 倾听 Brain 下一批开发回执

结论：Brain A（权威会话/授权/租约）与 B（独立内容）已实现、测试和只读评审，交付可评审代码。**本批未部署，完整倾听产品尚未验收。**

## 接续修正（2026-10-30 12:27 CST）

本轮起点 `39187a6003f130c7fe73b6bcfb122ae4870c8ca7`，工作树 clean；修正代码 `7fdba6e430c0ab3081b0ff4f83eba220b7f5c312`。从 `2d998cc31982f2c25bf39baeb927965d835a512b` 仅合入必要 HTML/测试，保留倾听配置及原业务；HTML SHA256 为 `b508f9b2fe3278d8699e2a7b9e299e167f8795de74fad23c3eac17570ad56b4d`，与用户已验收的现役静态页同字节。本轮未部署。

- `brain-tabs-ui.cjs --local`：真实完整页面＋现有 Hono/临时 SQLite；顶部切换、总览下钻、设备/子标签保留、倾听可见、倾听/LLM草稿保留、刷新取消、键盘/sticky/1024px、401后原页重登均通过；pageerror=0、业务写=0。未连接真实Worker，观测保持未知。
- `listening-admin-ui.cjs`：临时 SQLite 下保存/回读、草稿、并发冲突、503、恢复、旧登录响应隔离、实际重登通过。完整 HTML 内联 JS 语法及项目 TypeScript 检查通过。本轮未重复已被主会话复核的52/45/38/12全套。
- `listening-joint-prepare.mjs` 只校验两树三份冻结合同并调用39既有 `build-joint.mjs`；复用其 bundle/manifest，追加双方 commit、dirty 状态与 harness SHA，不另造服务、发布审批或就绪框架。实际 bundle 冒烟：offer→applied lease→summary/feedback（合成模型2次）→撤权403通过；不是本轮 Rust/RTC 联合测试。
- 39 后续已实际执行双方代码的 Rust→Brain HTTP 隔离对撞1项（基于 Brain `39187a60`、Worker `9007bfd8` 交付），主会话已核源码/manifest关联；不能继续描述为完全未互通。身份/模型/发布清单为合成值、撤权为模拟时钟，尚不证明真实注册ready、墙钟撤权或房间关闭。
- 本轮准备时 Worker `9007bfd8ca7c1b34098b60403b43ae47aca97107` 后的 `job.rs` / `pipeline.rs` 正在并行整改；清单保留 dirty，不把该工作文件当已提交/已验收修复。39完成P1后，直接按下方现有入口重新打包并执行一个联合用例，以其新 commit/证据对齐，无需用户转述。

本轮最小复跑（`apps/server`；浏览器沿用已有 `P003_PLAYWRIGHT_MODULE` / `P003_CHROME_BIN`）：

```sh
node scripts/brain-tabs-ui.cjs --local
node scripts/listening-admin-ui.cjs
node scripts/listening-joint-prepare.mjs /path/to/p003-listening-worker-20261030 /tmp/p003-listening-joint.mjs
# 将 bundle 及其 .manifest.json 放入39的隔离Linux环境后，在对应Worker副本运行既有入口：
P003_LISTENING_JOINT_BUNDLE=/tmp/p003-listening-joint.mjs sh scripts/listening/run-joint.sh
```

最后一条 cwd 为 Worker `rust-worker`，需已有 edition2024 工具链；Brain准备命令本身不执行Cargo。manifest中的 `verification=prepared_only` 如实表示尚未执行，不能当成ready。当前各类观测继续读既有runtime；无证据的构建/注册/RTC情况不补假值。

恢复点：撤回本轮源码可在原开发分支 review 后 `git revert 7fdba6e430c0ab3081b0ff4f83eba220b7f5c312`，不会撤掉 `ed3831b1` 倾听运行实现；但会使开发树回到旧HTML，**禁止把该旧静态页整包发布到线上**。生产标签页恢复点仍是 `2d998cc3` / `b508f9b2…`，静态即时备份 `/opt/p003/backups/brain-tabs-20261030T021732Z`；本轮不执行任何线上回滚。

## 代码与发布边界

| 项目 | 锚点 / 状态 |
|---|---|
| 工作树 / 分支 | `p003-listening-brain-20261030` / `codex/p003-listening-brain-20261030` |
| 起点 | `2a176888f2404ed33daf5b8dfd7dc4d66d6b14be`，开始时 clean |
| 冻结合同提交 | `1feaeee56ee71923dd2ea76efdef7f57c17f5e00` |
| 实现与测试提交 | `ed3831b17e03074d6fe837542a46764522e5eb6c`，15 个文件 |
| 已有管理后端发布 | 2026-10-30 09:50:48 CST，业务 `22505d8b`、发布源 `beafc980`；见 `ADMIN_RELEASE_20261030.md` |
| 现役静态标签页 | 2026-10-30 10:17:32 CST，`2d998cc3` / HTML `b508f9b2…`，用户已验收；倾听运行链路未部署 |
| 本批生产操作 | 无部署、无服务器/环境/服务更改、无线上开闸；未改搜索两 SN 和 11 月 2 日 11:19 窗口、Android、Analytics 或 Worker 工作树 |
| 实现 / 评审 | Codex 亲写；两轮辅助代理只读评审，未委派代码实现 |

## 冻结 HTTP 合同

根目录 `4-Assets/contracts/p003-listening-http-v1.json`：version=1，status=`frozen_for_integration`。

```text
contract SHA256 c4df5d49bd7addb09adbf6e06441c21b9b4e5e63e084b58a4f5599c66126e531
fixtures SHA256 1c32e52ae65c6d2f0724d033def70e36eb345cc37b9c06f6bbb3a46e7d68ef2d
```

Worker 会话39只读以上 Brain 文件、复制同字节合同并核 SHA。后续源码实现未改这两个冻结文件。Android/control 合同 `p003-listening-mode-v1.json` 未改。

五个 JSON POST 接口只挂主 Brain 的 `/v1/internal/listening`：`worker-ready`、`lease`、`close`、`summary`、`feedback`。不挂搜索候选 Brain，也不经普通 `/chat/completions`。

**合同文字澄清**：`metadata.android_response` 中“grant/account never handed to client”只适用于新增顶层 `listening_contract` 字段。RTC token 内的签名 job metadata 可被持 token 的设备解码，其中确实有 grant 和账号绑定；签名不是加密。安全边界是独立 Worker JWT + service Bearer + grant + 权威登记/registry，不能将 grant 当设备不可见的秘密。服务密钥和签名密钥不进入 RTC token。此处澄清不改变冻结线格式和 SHA。

## 本批实现与权限矩阵

| 路径 | 实际行为 |
|---|---|
| 设备签票 | 原设备凭据准入保持；只有声明 `listening_mode_v1`、配置准入、已核准构建且当前 revision/hash 已应用的 Worker，才增加可选倾听 metadata。倾听不可用时仍交付原普通票据 |
| 权威登记 | 同 registry 的 SQLite 持久登记 SN、Brain 账号、session、room、trace、Worker 账号/构建、来源、原始截止、凭据有效期及 grant 指纹；session 日志不是权限源 |
| 设备凭据 | 倾听路径强制 HS256、kind/sub/iat/exp、强 auth secret、registry active、账号归属及凭据撤销水位；不继承普通路径的兼容降级 |
| Worker 接口 | service Bearer、HS256 Worker JWT（iss=p003、aud=kidshub、role=device、iat/exp、精确服务账号映射）全部必需；除 worker-ready 外还需完整绑定的 grant |
| registry 撤权 | 账号/状态变更和删除触发持久 epoch；A→B→A、删除重加、同秒凭据撤销均不能恢复旧授权；异步验签后再次复读 |
| 租约 | TTL≤15秒、建议5秒刷新、1秒请求预算；首次只 offer snapshot，必须新 RID 回显已应用 SHA 后才 authorized；同 RID 不延长租约 |
| 策略撤权 | 每次检查 gate/名单/场景、当前来源、构建证据；配置审计捕获两次 poll 之间的关→开/限制变更；完整鉴权后持久消费旧 RTC 授权，后续新 entry 也拒绝，必须签新 RTC session |
| 搜索来源 | 新增 metadata-only generation 观察候选授权 flag 的任何变更；旧候选 session 因 generation 不同失效。原始截止取最小值，延长窗口不能续旧授权；不修改任何 flag 的值 |
| entry | 快照冻结、seq/epoch 单调、关闭前置 tombstone、原始最长时限；已授权 lease 或 entry 到期使旧 RTC 授权失效。显式正常 close 不等于超时撤权 |
| runtime | 可信发布 manifest + 新鲜认证 heartbeat + 当前 config revision/hash ack 才能 ready；缺密钥/证据/账号映射或证据过期均 false，无强制 ready 开关 |

`worker-ready` 上限4KiB，其余接口96KiB。存储上限：1000个未清理 session、每 session 最多128个 entry/tombstone、2048个 RID；过期 session 在新登记时清理。内容全局最多4个在途、每 entry 一个。

实现入口（路径相对 `apps/server`）：`src/listening-authority.ts`、`src/listening-authority-store.ts`、`src/listening-runtime.ts`、`src/routes/listening.ts`。设备与后台接线在 `src/routes/device-session.ts`、`src/routes/listening-admin.ts`，主入口为 `src/index.ts`，初始化失败仅影响倾听路由。

## 独立内容与参数消费

- summary 只整理本次资料，不读取人格；返回 base version、覆盖 seq/revision、source SHA 和 has_gap。Worker 继续保留源片段，按 retained ticket / epoch / revision 做本地 CAS 后才能释放，Brain 不提前提交摘要版本。
- feedback 只读已有世界观、风格、人格和关系参考；不调用普通 chat、工具、风格切换、首聊提取、长期画像、对话持久化或注入收据逻辑，不消费吐槽 armed。
- 模型资料用独立 JSON 包装；故事/歌词不作为系统命令或用户事实。唱歌仅按钮反馈，不评价转写无法支持的音准、音色、节奏。
- 输出空/超限/设备或工具标记拒绝；模型预算8秒，反馈预算取8秒与配置时长较小值；HTTP断开取消模型。模型完成后再次鉴权，旧 epoch/关闸/关闭/过期结果丢弃。
- RID 持久记录摘要指纹及终态，不落故事、歌词、模型正文或 grant 原文。正文回复仅有界 RAM 缓存，最多60秒；进程/路由重启后同 RID 已消费，不能自动重新生成。超时回收后的旧任务必须通过终态 CAS，否则不能复活。

| 配置 | Brain 消费 | Worker 待对撞项 |
|---|---|---|
| max_session_sec | 冻结 entry 截止，截断 lease；300秒独立截止已测 | 本地暂停与关闭旧 RTC |
| feedback_max_chars | prompt、输出硬校验、返回上限 | 实际播报使用同快照 |
| feedback_max_duration_sec | 返回播放预算及生成超时上限 | 实际 TTS/逐帧播放硬时限 |
| feedback_cooldown_sec | 持久间隔检查；同 epoch 最多一次 | 按钮/邀请的新代次协调 |
| summary_interval_sec / summary_trigger_chars | 按当前 revision 下发并冻结；未在 Brain 重建第二个调度器 | Worker 异步摘要调度及变参测试 |
| voice_invitation_enabled | 与 singing 按钮限制一起实际检查 | 语音邀请规则及按钮流 |

## 实测证据

全部使用临时 SQLite、合成凭据和本机回环，无 `.env` 载入或真实用户正文/生产模型调用。

| 验证 | 实际结果 |
|---|---|
| 合同12 + grant6 + policy4 + authority-store3 + authority14 + content9 + loopback1 + search-chat-abort3 | **52/52 通过**，统一 node:test 运行；0 skip / 0 todo |
| 原 device-session 回归 | **45 passed / 0 failed**，含原首句/搜索派单路径及日志敏感扫描 |
| 后台管理真实认证/权限/CAS/审计 | **38 checks 通过** |
| 配置存储/双进程CAS/恢复/无关数据保留 | **12 checks 通过** |
| filler 回归 | 认证、验证、持久化、账号隔离、session快照、坏配置回退 PASS |
| TypeScript | 项目 `tsc --noEmit` 与新增5个测试/辅助文件独立 strict tsc 均通过 |
| 最终只读评审 | 授权14/14独立复跑；原撤权复活、缺serviceKey签票、超4KiB请求均复核修复，无剩余重要阻塞 |

loopback 是真实 Node HTTP → 主路由 → 真实 SQLite → 真实 provider SSE 解析器 → 本机合成模型流。覆盖设备签票 metadata、snapshot 应用、摘要/反馈、router重启重放、HTTP断开到上游流取消。预置风格/关系数据后逐表比较普通数据库完全一致，吐槽 armed 保留；持久请求行不含正文/grant。

评审驱动修复有失败→通过证据：close 先到后 lease 复活、验签期间改绑、预取消请求仍生成、撤权后重新开启的旧授权恢复；超时终态 CAS 另有修复后回归验证。本批52项是离线代码测试，**不是完整产品发布门槛的“≥60固定用例”验收**。

复跑（`apps/server`，已有 node_modules，不装依赖）：

```sh
node --experimental-sqlite --import tsx --test scripts/listening-http-contract.test.ts scripts/listening-auth.test.ts scripts/listening-policy.test.ts scripts/listening-authority-store.test.ts scripts/listening-authority.test.ts scripts/listening-content.test.ts scripts/listening-integration.test.ts scripts/search-chat-abort.test.ts
node --experimental-sqlite --import tsx scripts/device-session.test.ts
node --experimental-sqlite --import tsx scripts/listening-admin.test.ts
node --experimental-sqlite --import tsx scripts/listening-config-store.test.ts
node --experimental-sqlite --import tsx scripts/filler-policy.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck --strict --types node scripts/lib/listening-test.ts scripts/listening-authority-store.test.ts scripts/listening-authority.test.ts scripts/listening-content.test.ts scripts/listening-integration.test.ts
```

## Worker 接续与未完成项

未来隔离联调环境需要 `AUTH_JWT_SECRET`、独立 `LISTENING_GRANT_SECRET`（两者至少32字节）、既有 `CUSTOM_LLM_API_KEY`、`LISTENING_WORKER_ACCOUNTS`（agent→唯一服务账号 JSON）、`LISTENING_RELEASE_MANIFEST_PATH`。密钥只经现有凭据流程配置，不在文档/RTC token 中填写服务密钥。manifest 必须引用真实独立验收证据和构建 SHA，不能拿本机合成 fixture 作为生产核准。

Worker 必须直连主 Brain，按 frozen HTTP v1 提交已注册构建和配置应用 ack；主 Brain ready 不是当前 Android/真人实听合格证明。租约请求异步、5秒刷新、1秒预算，失效暂停并关闭旧 RTC，不能自动回普通 chat；HTTP200反馈不等于音频许可。

仍待 C 阶段取证：39的P1生命周期修复及修复后完整Linux/双方HTTP回归（此前508项Cargo＋双方HTTP1项已有隔离证据）、真实RTC音频出口、逐帧/VAD/取消排空/Android local_ready、当前 APK 能力确认、真实模型内容质量与时延、≥60固定产品用例、3×10分钟故事、3首歌、30分钟session、普通聊天≥20有效对及中位/P90首声增量、新→旧→新实机回滚、真人实听。**本次未自动部署或打开线上测试窗口。**

## 回滚记录

- 生产边界分别为09:50:48管理后端及10:17:32静态标签页；`ed3831b1`运行链路和本次整合仍只在开发分支，无需线上回滚。不得用09:50的旧HTML覆盖10:17标签页；原6文件回滚脚本会校验后续变动，不能绕过保护。
- 如撤回本批源码，在对应开发/合并分支 review 后 revert `ed3831b17e03074d6fe837542a46764522e5eb6c`；保留 `2a176888` 的已发布归档和 `1feaeee5` 合同记录，不用 reset/force push，不回退其他团队提交。
- 未来部署后的业务止血先关倾听总闸，再按既有已验证发布流程回退程序；旧 RTC 必须按租约失效关闭，不自动普通 chat。该生产动作不属于本次授权出口。
- **数据库只保留惰性新增元数据，不恢复整库、不DROP表**。`devices.db` 的 `listening_*` 表及 registry epoch触发器，`config.db` 的 `listening_source_meta` 与 `listening_source_insert/update/delete` 触发器成套保留；只DROP metadata表会让残留触发器破坏旧版 `configStore.setFlag`。若将来确需移除，另作迁移评审，先移除对应触发器且停止相关写入。
- 旧版程序不使用这些新增元数据，保留表/触发器不改变原配置值；配置审计、账号、设备、故事以外业务数据均不作回滚覆盖。

署名：codex（OpenAI）| 2026-10-30 12:30 CST（接续修正；首批回执11:46归档）
