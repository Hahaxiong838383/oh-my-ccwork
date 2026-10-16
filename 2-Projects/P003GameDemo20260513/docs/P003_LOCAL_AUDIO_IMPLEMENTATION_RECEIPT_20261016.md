# P003 本地回复语完整性修复：实施与回滚记录

> 后续更新：2026-10-16 22:43 已按用户授权全量启用14台，048/020已发布且后台写入恢复。以下为当时的历史记录；当前状态见[全量发布回执](P003_LOCAL_AUDIO_FULL_ROLLOUT_RECEIPT_20261016.md)。

状态：**云端修复已部署，038 单机灰度已发布，端到端尚未通过。** 截至 2026-10-16 17:12 CST，038 的服务端 revision=16、真实 applied=15；048/020 仍为 11/10、7/6，未发布候选。后三者分别表示「服务端版本／真实设备已应用版本」，不能用服务端探针替代设备回报。

本记录承接用户已批准的 2026-10-16 修复方案。旧方案的“待拍板”是审批前历史快照；本次已获得执行授权。后续用户要求代码亲自实施，故业务代码、测试、发布及恢复脚本均由 Codex 编写。产品文档由 Grok 起草、Codex 对照代码与审计复核；没有把 Cursor Auto 冒称为 Opus 5.5，也没有沿用其未完成代码。

## 已交付产品定义

[小可个性化与自我成长本地回复语产品定义](P003_PERSONALIZED_LOCAL_REPLY_PRODUCT_DEFINITION_20261016.md)。交付副本位于本机 Downloads；SHA256 `3b835061ead77bb74e9076ce009e74097b7ba9f0f29c2fe7d27056c20b032fbb`。定义明确区分当前能力、本次完整性修复和后续成长；本轮不扩大话风学习、声线或 Worker 承接音范围。

## 改动与测试

- 新素材 ID 纳入场景及不可变元信息，仍为 16 位十六进制；完整音频 SHA 独立校验。合法旧 ID 继续可读、可复用。
- 音频不可覆盖；数据库去掉 REPLACE；发布在同一写事务内校验真实槽归属、条数、WAV、SHA、容量和 revision。失败保留旧包；并发过期候选拒绝提交。
- 所有生成入口使用维护门，force 也不能绕过。清理先拿事务锁；候选使用独立 24 小时 `.pin` 租约，不改 created_at 或清单字段。
- 新受控工具默认只读；显式发布／恢复需指定集合 SHA、当前 revision，并核设备归属与关系锚。恢复发布更高版本，不覆盖真实 applied，不回灌整库。
- 人格、18 个功能回复槽、3 个设置槽统一素材写入。固定文案不改，本轮没有铺开额外固定槽。

| 验证 | 结果与边界 |
|---|---|
| 本地音频既有回归 | 193 passed / 0 failed；R、S 均通过 |
| 人格／设备配置回归 | 138／36 项通过 |
| 完整性及 HTTP 合同 | 不可变写入、缺槽／坏文件拒绝、CAS、维护期可读、鉴权、跨账号、SHA、ETag 通过 |
| 发布／恢复工具 | 只读准备、权限、集合 SHA、设备换绑、关系锚变化、revision 冲突、恢复递增且保留 applied 通过 |
| 独立进程与容量 | 两发布者仅一成功；SQLite 事务中 SIGKILL 回滚；21 固定槽与按不同 ID 累加的 5MiB 边界通过 |
| S/R 兼容 | S 实际源码读取 R 新 ID、通过鉴权路由提供全部字节，版本与 applied 保持；非同一模块缓存模拟 |
| 真实数据副本演练 | 三台分别发布候选，再由 S 工具恢复完整内容到更高 revision；12 张其他业务表及 applied／fetch 流水未改变。只写隔离副本 |
| 新增 CLI／测试 strict TypeScript | 通过；全仓仍有基线已有的 3 个 `race-llm.ts` 的 `DeepseekLlmClient.abort` 类型错误，不报告全仓 tsc 全绿 |
| 实际 APK | v319 原 APK SHA `b947a16aad193cc2da460d5b859aec4496cd94b03967aaec601b24a5468025dc`；DEX 清单解析分别校验 16hex ID 和 64hex SHA，fingerprint 不含 generated_at。v336 未取得构建产物，继续以真实灰度取证；静态核验不等于安装／播放验收 |

## 部署范围与现网结果

2026-10-16 **17:10:03–17:10:06 CST**，房间清单为 0 时暂停公司侧进程、做最终快照、部署 R 并恢复服务。保持 `LOCAL_AUDIO_WRITES_PAUSED=1`，动态包读取仍开启。只改香港 `/opt/p003/server` 以下 8 个文件，没有整目录覆盖：

```text
src/local-audio-store.ts
src/local-audio-integrity.ts
src/local-audio-generator.ts
src/local-audio-device-reply.ts
src/local-audio-g1-settings.ts
src/routes/admin-data.ts
scripts/local-audio-device-reply.ts
scripts/local-audio-release.ts
```

生产文件与 R 制品摘要逐项一致；包管理文件、依赖、Nginx、Rust Worker、Analytics、个人站未修改。`p003-voice` PID 由 2817417 变为 3752181；个人站 PID 1626403、Analytics PID 3192914 及其重启计数保持。`/health` 返回 ok；这不代替真人语音对话验证。

17:11:07 CST 发布 **038：15→16**，31 条不增减，只把一个普通招呼素材改为场景隔离 ID `95ccd460f9bfac5e`，文案和音频字节未变。其他 **13 台**的 active 集合、revision、生成状态均未变化。048/020 的修复候选和完整恢复集合已验证并私有保存，但尚未发布。

17:11:56 CST 服务端本机 HTTP 探针：manifest 200／revision16／31 条，新 ID 音频 SHA 通过，ETag 304，无凭据 401。探针**未携带 applied_revision**，只产生真实的服务端检查 fetch 流水；038 的真实 applied 仍为 15。

## 回滚锚

| 类型 | 不可混淆的用途 |
|---|---|
| 原始基线 | `03bf0fdcc4788410de6367deb334f1a2c48311d7`，仅灾难参考，不能恢复旧缺陷后重新开启生成 |
| 安全构建 S | `2a643f8fa5e3c878aed8611ab69d76f4fa30fcf7`，旧 ID 算法加不可变／发布完整性／维护门／候选租约／关系校验，用于正常代码回退 |
| 完整修复 R | `181f83d328fa5a826e290b07a10fa48cd64a4043`，本次部署的业务源码提交 |
| 制品目录 | `/opt/p003/server/backups/local-audio-integrity/builds-181f83d3-2a643f8f`，S/R 各 8 文件及 manifest；S 的 release CLI 使用经验证的 R CLI |
| 首次在线备份 | `.../preflight-20261016T084734Z`，SQLite quick_check 通过；487 个现役及三台历史音频共 47,209,268 bytes。此时未冻结写入 |
| 停写后最终备份 | `.../frozen-20261016T091003Z`，393 个全部现役音频、local_audio 表、原代码及私有配置；profile SHA `4d89ba18aa8126be84531cdeba1959ad90e9cc6399a5242d15501346e6c69600` |
| 副本演练 | `.../rehearsal-181f83d3/receipt.json`；严禁把其更高版本误读为生产设备状态 |

上表 `.../` 均为 `/opt/p003/server/backups/local-audio-integrity/`。备份目录 700、私有数据文件 600；完整 profile 快照仅作灾难留存，**正常音频回滚不回灌整库**。

| 设备 | 完整内容恢复目录 | 预审 bundle SHA256 |
|---|---|---|
| 03800006 | `before-03800006-181f83d3` | `816fa27ada8fdabeffdf8d60ffd9a747fda353e3e583a2b3a815609f74f9135e` |
| 04800006 | `recovery-04800006-181f83d3` | `77bc43f2d514467d3ab1efc60e99b72ae5d3a92444fc86d424af4ed746638b71` |
| 02000004 | `recovery-02000004-181f83d3` | `03a6961938675f9b9c2e3fef9ed49d3c39ee178cba13d99410e0e1c10d7d5e33` |

048/020 的 before 集合缺槽，仅供留证，不能用来正常恢复。其 recovery 集合使用已存历史正确场景素材，各 28 条；新补齐及恢复文案的场景文本门均通过，无新增 LLM／TTS 计费调用。

正常恢复顺序：保持服务写暂停、读取最新状态和设备归属；需要代码回退时在无活跃会话窗口备份现场并按制品清单覆盖 S 的 8 个文件、仅重启 p003-voice；验证源 SHA 和健康。内容恢复由独立进程显式设 `LOCAL_AUDIO_WRITES_PAUSED=0`，运行：

```text
LOCAL_AUDIO_WRITES_PAUSED=0 .runtime/node-v24.19.0-linux-x64/bin/node --env-file=.env.local --experimental-sqlite --import tsx scripts/local-audio-release.ts recover \
  --bundle <上述完整恢复目录> \
  --expect-revision <刚读取的当前revision> \
  --expect-bundle-sha <上述完整SHA256>
```

使用服务器现有 Node24 绝对路径运行。外部环境设 0 只授权本次 release 进程，**不能改生产 PM2 进程的暂停状态**。恢复后核新 revision 递增、真实 applied 未被工具覆盖、其他设备包不变。设备已换绑或关系锚变化时工具会拒绝，必须重新核验。

## 尚未完成及继续条件

1. 038 真实下载、原子应用 revision16 和场景播放，收到后才推进 048，再推进 020。设备离线单独记录，不视作失败或通过。
2. v336 构建产物／连接设备位置仍待补；不得将 v319 静态分析替代 v336 实机证据。[端侧验收回执](P003_LOCAL_AUDIO_CLIENT_CANARY_HANDOFF_20261016.md)可直接转交同事。
3. 三台通过后在空闲窗口解除 `LOCAL_AUDIO_WRITES_PAUSED` 并只重启公司进程，再覆盖一次实际夜间生成→拉取→回报及 24 小时观察；目前未完成，也没有另建自动监控任务。
4. 暂停写入期间既有音频仍可下载、播放，但不会自动刷新话术，清理也暂停。不要关闭 `PERSONA_LOCAL_AUDIO_ENABLED` 来代替停写，否则设备会停用动态包。

本机审计原件：`~/.local/state/p003-local-audio-20261016/`。共享记忆需另做版本检查与备份，不将代码 push 等同共享记忆已 push。

署名：codex（OpenAI）｜2026-10-16 17:12 CST
