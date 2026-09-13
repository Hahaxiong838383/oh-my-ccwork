# P003 小可 · 生产版本总表（RELEASES）

> 维护规则：每个「正式版」= 一组可回滚的组合（APK + Server + Worker + 开关）。标签打在 server 提交上，组合里的其它锚写进标签 message 与本表；改组合就加一行，不改旧行。

| 版本 | 状态 | 标签 → server 提交 | One-shot | 组合锚 | 回滚 |
|---|---|---|---|---|---|
| **V1.0 正式版** | 2026-09-13T07:06Z 前的生产现役 | `p003-v1.0-no-oneshot` → `f011ace1a` | **无**（仅研发灰度一台走名单） | APK OTA 现役 **v263 = 1.2.2-canary.251**（sha256 `5d164461360f…`，全量 rollout）；Server `f011ace1a`（`device-session.ts` md5 `eafe9820…`，策略键未设 = allowlist）；Worker 生产 `voice-worker-rust` exe `f3707e7e…`（commit `3a2af41c3`） | — |
| **V1.1 正式版** | **服务端已上线 2026-09-13T07:06:25Z**；One-shot Worker 池已升生产规格（08:09:35Z，PID 2902239，10 路/1200M-1500M）；**APK v274（1.2.2-canary.262）验收机四场景通过，2026-09-13 封版（B102），待合包→分批 OTA** | `p003-v1.1-oneshot` → `add34a8db` | **有**：OTA 到 V1.1 APK 的设备自动具备（能力协商，零人工名单） | Server `add34a8db`（`device-session.ts` md5 `504dd062…`）+ `.env.local` `ONESHOT_FIRST_TURN_POLICY=capability`、`ONESHOT_FIRST_TURN_AGENT_NAME=rust-worker-firstturn`；Worker One-shot 池 `voice-worker-firstturn` exe `c2b84b2e…`（commit `299b074`，含 B68/B69 控制出口修复），目标 `WORKER_MAX_JOBS=10` / `MemoryHigh 1200M` / `Max 1500M`；APK：**v274 = 1.2.2-canary.262（versionCode 274，85,670,286 B，sha256 `0017dc50…ddda`）= 封版包**（v272 + 首句边界保护 + 6 s 超时 cancel→提示重说，codex B101；回滚包 v272 sha `9f0eec54…`，`adb install --no-incremental -r -d`，禁卸载/清数据）；谱系 v271（启动迁移原包，不发）→ v272（B90 contract:null 同次回落，off 可作普通回退）→ v273（REJECTED，版号不复用）→ v274；v270 = 声学/交互基线不含自动启用 | **开关（止扩）**：`.env.local` `ONESHOT_FIRST_TURN_POLICY=off`（全停）或 `allowlist`（只名单）+ `pm2 restart p003-voice`；已签票据 ≤1h 自然过期、进行中会话不断。v271 原包：不是「回普通」（`first_turn_not_granted`，B87 §3）；**v272+（含封版包 v274）：off = 同次唤醒回落普通票 + 播「请再说一遍」，可作普通回退（B95 实测；v274 上未实机复验，见残项 6）**。见下「回滚顺序」。**文件级**：`/opt/p003/_backup/20260913-070625-b84-policy/`。**Worker**：`/root/rust-worker-firstturn/voice-rust-worker.rollback-71e42ab0-20260912T083440Z` |

## 后台入口（2026-09-13 B89 起）

**`https://kidshub-ai.hahaxiong.cc/admin/` → Worker 区 → 「🧩 版本与 One-shot」**（admin 角色可见）：
- 版本卡：当前生产版本（标签/说明/生效时间/Server 提交/Worker 二进制/APK 状态）+ 历史版本表——数据来自随 server 部署的 `apps/server/release.json`（**发版时更新它**，`RELEASE_JSON_PATH` 可改路径）。
- One-shot 签发开关：`capability / allowlist / off` 三档 + 备注 → 「应用」；改后**下一次设备唤醒签发即生效，不重启**。开关存 server `data/config.db` 表 `runtime_flag`（键 `oneshot_first_turn_policy`，带操作人/时间/备注）；「清除后台覆盖」回落到 `.env.local` 的 `ONESHOT_FIRST_TURN_POLICY`（当前 `capability`）。生效优先级：后台覆盖 > env > 内置 `allowlist`。每次签发日志带 `policy=<值> policy_src=override|env|default`。
- 点 `off`/`allowlist` 时确认框会念下面「回滚顺序」的边界。API：`GET /api/admin/oneshot`、`PUT /api/admin/oneshot/policy {policy,note}`、`DELETE /api/admin/oneshot/policy`（admin 专属，guest/editor 403）。
- 上线记录：server 提交 `a1d9802df`（09:03:14Z，pm2 pid 1636316），后台单页 md5 `110bba0c…`（09:03:48Z）。**回滚记录**：server 三文件备份 `/opt/p003/_backup/20260913-090314-b89-oneshot-admin/`（+ 删 `release.json`，`pm2 restart`）；后台单页备份 `/opt/p003/web/dist/admin/index.html.bak-20260913-090348-b89`（cp 回去即可，无重启）；开关层回滚 = 后台「清除后台覆盖」（交付时 `runtime_flag` 为 0 行、生效值 = env `capability`）。

## 服务端开关（`ONESHOT_FIRST_TURN_POLICY`；B89 起为后台覆盖之下的兜底层）

| 值 | 行为 | 用途 |
|---|---|---|
| `capability`（V1.1 生产值） | 已准入设备 ∧ 请求 `supports` 同时含 `oneshot_first_turn_v1`、`local_receipt_v1` ∧ 已配派单目标 → 签首句合同、派 `rust-worker-firstturn`；否则普通语音 | 产品态：OTA 即用 |
| `allowlist`（默认/未设） | 只对 `ONESHOT_FIRST_TURN_SN_ALLOW` 名单内 ∧ 声明 `oneshot_first_turn_v1` 的请求签 | 研发灰度 / 半回滚 |
| `off` | 一台都不签。老端（无 supports）照常普通语音；**v271 原包的新端唤醒失败**（端侧强制合同，不回退普通票据）；**v272 起**（B91 修复，`1.2.2-canary.260`）同次唤醒复用普通票据、播「请再说一遍。」后普通聊天 | v271：止扩，配合端侧停用才是完整回滚；**v272+：可作普通回退**（2026-09-13 B95 B/C 在 off 下实测通过：不失声、同 trace、零 ordered 投旧池；D 自动恢复待验） |
| 其它值 | 按 `allowlist` 处理并 `console.warn` | 配置错保护 |

每次签发日志带 `policy=<值> supports=<能力名|…或 ->`，老/新客户端各走哪条路径可从 `[device-session] ok` 行对账。

## 回滚顺序（B87 §3 端侧边界，2026-09-13）

1. **止扩**：后台「🧩 版本与 One-shot」点 `off`（或 `allowlist`）→ 应用（秒生效；等价的 env 改法 `ONESHOT_FIRST_TURN_POLICY=off` + `pm2 restart` 只在后台不可用时用）——新签发立刻停；老端不受影响；进行中会话不断。
2. **新端恢复普通语音**：需端侧合法停用首句工厂（维护配置）或回退到不含迁移的 APK——**只关服务端不够**，v271+ 唤醒会 `first_turn_not_granted` 失败而不是退回普通票据（`VoiceRustWorkerClient.wake` 在工厂已启动时强制合同 V1；`contract:null` 走 `wake_connect` 失败并停止）。
3. **Worker 回滚**：等已签票据排空（TTL ≤1h）与活跃房结束后再动 `voice-worker-firstturn`；**不能把 ordered 首句房派到不支持 ordered 的旧 `rust-worker`**。
4. 不删端侧迁移 marker，不清 Keystore/凭据。

## 验收状态

- 服务端：单测 43/43（B84 9 + B89 4 + B91 2，负向注入各红）；生产 `/health` ok、无凭据探针 401、error 日志零告警（2026-09-13T07:09Z）。
- 设备侧：v271 启动自检四项通过（旧 0 升级 / 缺失自启 / 重复幂等 / 关 0 保持，codex B87）；**真实 OTA 安装上报链 + 名单外设备一句传统唤醒、一句连说、退出**仍待（最小发布验证）。
- 真流量签发样本：已齐——新端 `contract=first_turn_v1 policy=capability policy_src=env`（A1/A2/D/E/F…）、老端 `contract=- supports=-`（0003/0004/0006）、off 窗口新端 `contract=- policy=off policy_src=override`（B/C）。
- 后台面板 B89（2026-09-13 09:03Z 上线）：生产 API E2E 通过（off→bogus 400→capability→清除→幂等→回落 env，日志四条留痕，终态 `runtime_flag` 0 行）；浏览器挂载无模板错误；登录后 UI 点按验收由川哥执行。
- **B91/B92（2026-09-13）端侧回落修复进行中**：codex 已按 B90 改端侧源码——服务端回显式 `contract:null` 时**同次唤醒复用普通票据**、丢弃已采首句并本地播「请再说一遍。」、不缓存拒签（离线 Debug/Release 1023/1023 + Python 102/102，含负向验证），**尚未构建/装机**；cc 已交付本地提示音 `repeat_request.wav`（正式音色，1533ms，sha256 `757972dc…3f58`）+ manifest，并把「`contract` 键显式存在且为 JSON null」钉成严格单测（43/43）。**新包 B/C 通过前，后台 `off`/`allowlist` 对 v271 仍只是止扩**；通过后再把 `off` 改口径为新版可用的普通回退。
- **B93–B96（2026-09-13）v272 回落验收窗口**：v272 装验收机（***0010）；cc 10:25:38Z 后台切 `off`（override）→ codex Air B 传统/C 连说在 off 下通过（同次唤醒普通票、提示音后重说得答、零 ordered 投旧池）→ cc 11:54:14Z 清覆盖恢复 `capability`（env）。真流量签发证据首次到手（A1/A2 `contract=first_turn_v1`，B/C `contract=- policy=off policy_src=override`，老端 `supports=-`）。观察：同声场邻机 0003/0004 随 0010 同醒，B 房两句额外输入疑为邻机回答声。**D（恢复后自动 One-shot）待。**
- **B97–B101（2026-09-13 晚）首句边界修复**：D（v272）首句残句「小可小可3+」= 端侧 greet 冻结边界截断（B98 三轮对照 samples 37280=A1 尺寸、尾静音 0）；v273 候选（静音保护）挡住早 greet 但 6 s 无判停无回复被拒（B100：worker begin 后 1.19 s 已有 10 字 final + `end_candidate quiet 1000ms`，设备未发 end/cancel 静默断连）；**v274**（边界保护 + 消费 worker 候选 + 6 s 超时 cancel→FAILED→「请再说一遍」→同房普通麦）四场景通过（B101/B102）。
- 变更记录：B84（codex 需求）→ B85/B86（cc 回执）→ B87（codex v271 交付 + 回滚边界）→ B88（cc 文档收口）→ B89（后台版本卡 + 开关）→ B90（cc 端侧需求：优雅回落）→ B91（codex 端侧实现 + 索要提示音）→ B92（cc 交付提示音 + 严格 null 单测）→ B93（codex v272 装机 + A 通过）→ B94（cc 切 off）→ B95（codex B/C 通过）→ B96（cc 恢复 capability + 对表）→ B97/B98（D 残句定位）→ B99/B100（v273 拒收取证）→ B101（codex v274）→ **B102（cc 四 trace 对账 + 封版）**。

## 封版记录（2026-09-13 B102）

**判定：v274 核心生产接入验收通过，可以封版。** 封版件：server = 仓库 HEAD（线上 `device-session.ts` `3feaa45b…` / `admin-data.ts` `43230d3c…` / `config-store.ts` `4d95aef2…` 与 HEAD 逐字节一致）、`ONESHOT_FIRST_TURN_POLICY=capability`（env，`runtime_flag` 0 行）；Worker One-shot 池 `voice-worker-firstturn` exe `c2b84b2e…`（299b074，MAX_JOBS 10 / 1200M-1500M）；APK v274 `0017dc50…ddda`；标签 `p003-v1.1-oneshot-sealed-20260913`。

| 场景 | trace | 服务端半边 | 结果 |
|---|---|---|---|
| A1/A2 正常（v271） | 8d5aec57 / aef63594 | first_turn_v1，firstturn 池 begin accepted，A2 committed | ✓ |
| B/C off 回落（v272） | 6e1f0a13 / 39c96897 | contract=- policy=off policy_src=override，生产池接房，零 ordered | ✓ 不失声、同次重说得答 |
| D 自动恢复（v272） | 7a32f1da | first_turn_v1 env，firstturn begin accepted | ✓ 恢复；✗ 首句残句（端侧边界，v274 修） |
| D 短连说（v274） | 855b8a5e | end +917 ms，61,920 样本，10 字全句，1 次 commit，正文直出（本地承接），underrun 0 | ✓ |
| T 传统（v274） | 645a03ba | wake_only → 普通轮「3+5等于几」，filler→正文，underrun 1×562 ms | ✓ |
| E 长连说（v274） | 7d129eac | end +4755 ms，128,000 样本，28 字全句，1 次 commit，underrun 0 | ✓ |
| F 超预算重说（v274） | 21306920 | 无 end；cancel → `failed:cancelled action=repeat_prompt finals_held=0` → RTC；首句零 speculation/commit/caption/正文；重说普通轮 1 次 commit 答 8 | ✓ 闭环 |

**已知残项（封版时冻结，不阻塞）**：
1. Worker 次级判停候选（端侧 `first_turn_worker_candidate`）离线覆盖、实机未命中——等自然样本，命中后按 trace 对 worker `end candidate published quiet_ms` 行。
2. ready 3 s 兼容兜底（`input_ready_fallback mode=compatibility`）仍在，未修。
3. worker 播出 filler→正文交接 underrun（T 562 ms、旧 D 374 ms、B 房 222 ms、邻机 735/475 ms）——既有播出缓冲问题，非 v274 引入；worker 侧改动待 V1.1 解冻。
4. worker 被动断连/失败代次不 dump `decision evidence`（B100 缺口），一行改动待排。
5. 同声场多设备同醒（0003/0004/0006 随 0010 醒并各自作答）——真实产品场景未处理；多机家庭/教室会「齐答」。
6. off 回滚点在 v274 上未实机复验（v272 实机 B/C 通过；codex：v274 九文件差量不含 wake/contract 解析路径，离线 1035 项含回落测试）——建议分批 OTA 第 1 批后做一次 B/C（cc 切开关 5 分钟）。
7. 真人听感/物理首音时延未测（Air 代理：D 2556 / T 771 / E 1841 / F 722 ms，含观测链路）。
8. APK 85.67 MB > 80 MB 目标（< 150 MB 红线）。
9. v271 原包不追溯（off 对 v271 仍是止扩）；v273 REJECTED，版号不复用。
10. 生产池 `voice-worker-rust` MemoryPeak 1.12 GiB（MemoryHigh 1.4 GiB 的 82%），与 One-shot 无关；分批期间老端流量仍走它，需盯。

**分批 OTA 边界（服务端）**：firstturn 池 MAX_JOBS 10；2026-09-13 全天 17 房峰值并发 1、MemoryPeak 48 MB（单房级）；近 7 天签发设备 9 台（`ota_device_status` 9 行）。规则：峰值并发 ≤ 70% MAX_JOBS（7）；机队 > 14 台前先扩（单房内存小，加 MAX_JOBS 或第二实例）。**池满形态**：LiveKit 无该 agentName 可派 → 首句房无 worker → 端 6 s 超时 → 提示重说但 RTC 也无人接；分批期间看 firstturn journal `accepting` 与 `job closed` 差、签发行 `policy/supports`、`result outcome` 分布（task / no_task / failed:cancelled）、underrun。建议第 1 批 = 0010 + 1–2 台此前只走普通合同的老端（如 0003/0004）→ cc 交每台首次 `first_turn_v1` 签发行 + firstturn 接房 → 一次 off B/C 复验 → 第 2 批余下。回滚顺序不变（上节）。
