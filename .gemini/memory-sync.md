# mycc 共享记忆快照（自动生成 · MCP 通道）
> 生成时间: 2026-04-25 14:34:29 +0800
> 来源: 0-System + agent-memory（与 cc/codex 同源）

## 当前状态（status.md）
# Status（短期记忆）

> 自动注入给 cc。由 mycc 后端每 30 分钟自动刷新。

---

## 今日快照

**日期**：2026-04-25

**今天做了什么**：
- 记忆巩固完成 (7/7 steps)
- IPO 市场报告 定时任务完成

---

## 注意力图式

| 聚焦 | 负载 | 选择原因 |
|------|------|----------|
| 无活跃任务 | 1/5 | — |

**被抑制的任务**：无

## 系统状态

| 系统 | 状态 | 说明 |
|------|------|------|
| mycc 后端 (18080) | ✅ 运行中 | PID 1102 |
| Ghost OS MCP | ❌ 未安装 |  |
| 飞书通道 | ✅ 随后端 | cc/codex/gemini 三通道 |
| 内置 Scheduler | ✅ 运行中 | 每 60s 检查 tasks.md |

## 定时任务

| 任务 | 频率 | 说明 |
|------|------|------|
| 记忆巩固 | 04:00 | 每日记忆整理：快照→delta合并→归档→事件清理→SQLite同步→质量门 |
| IPO 市场报告 | 08:00 | 生成并发送 IPO 市场每日调研报告 |
| IPO 市场报告 | 14:00 | 生成并发送 IPO 市场每日调研报告 |
| 每日进展更新 | 22:30 | 提醒更新 0-System/status.md 记录今日进展 |
| 周记归档 | 周日 22:30 | 提醒归档本周记录到 5-Archive/周记/ |

## 多引擎黑板

> 三引擎共享状态，详见 `0-System/blackboard.md`

---

*自动更新：2026-04-25 14:06*

## 用户画像（user-profile.md）
# 用户画像（自动生成，勿手动编辑）

> 上次重建：2026-04-02（首次生成）
> 来源：`[user/*]` 命名空间 + `0-System/about-me/`
> 更新频率：每周一 04:00 自动重建

## 身份与角色

- 川哥，cc 的老板/搭档
- 独立开发者 + 产品思维
- 双机工作：MacBook Air M5 32GB（主力）+ Mac Studio M2 Max 32GB（10.9.1.155，跑大模型）

## 工作风格与偏好

- **沟通**：简洁直接，不喜欢废话和客套
- **决策**：务实不纠结，够用就行，先跑起来再迭代
- **执行**：偏好 BRO-PDCA 方法论，70% 任务直接干，30% 先对齐
- **工具链**：Claude Code CLI 为主力开发环境，多引擎协同（cc + codex + gemini）
- **文档**：重视结构化记录，但不过度文档化

## 技术栈与能力

- **主力语言**：TypeScript/Node.js
- **基础设施**：macOS + Ollama 本地模型 + 飞书生态 + NAS 自动同步
- **AI 工程**：记忆系统设计、多 Agent 编排、意识理论×架构映射
- **运维**：Xray 代理、FRP 中转、Nginx、sing-box

## 当前关注

- mycc-brain 认知 OS 产品化（双模式大脑 + 经验流 + 微调闭环）
- 记忆系统持续进化（v5.6：ASMR 启发的六维度摄入 + 语义矛盾检测）
- cc-eye 贾维斯视觉感知

## 沟通风格

- 给指令时通常简短，期望 cc 自主判断细节
- 不喜欢重复确认，做错了代价 < 30 分钟就直接干
- 喜欢看到结构化的对比分析（表格优先）
- 大任务交付时需要署名和 task-log 记录

## 最近事件（RECENT_EVENTS，尾部 120 行）
- `09:22` Mini 桌面跑 `lark-cli auth status --verify` 成功：tokenStatus=valid，自动 refresh 到 04-13 11:16，verified=true
- `09:24` ssh 非交互 session 仍读不到 Keychain（macOS security domain 隔离，lark-cli 内部拼 `appsecret:...` 条目名需要 CLI bundle 签名，ssh bash 不带 bundle）→ **接受限制**：Mini 桌面/cc-remote 交互 session 可用 qb-archive；ssh 自动化 + mycc 后端 launchd 派生无法直接用 lark-cli
- `09:25` 临时文件清理（Mini /tmp/acl.sh、/tmp/.mk，Air /tmp/.mk），master.key Keychain 条目保留（将来用户在桌面 session 还能用）


- `20:30` Hermes Day 5.5 全部完成：P0 密钥 + P1a LLM + P1b 前日摘要 + P1d 成本熔断
- `20:31` VPS .env 新增 GEMINI_PROXY_URL/KEY，Cron 已更新加载 .env
- `20:32` 编排器升级：callLLM(gemini/minimax) + resolvePreviousRun + checkCostCircuitBreaker
- `20:35` 全链路测试通过：59→36→Gemini分析(6.6K tok)→MiniMax报告(4.7K tok)→飞书推送成功
- `20:36` Codex 审查 FAIL：2 CRITICAL(熔断绕过+死代码) + 3 HIGH(runId碰撞+无重试+prompt泄漏)
- `20:40` 5 个 findings 全部修复：by_stage累加+which检测+秒级runId+指数退避重试+DEBUG控制
- `20:41` 修复版重新部署 VPS，dry-run 验证通过，bonus: `<think>` 标签自动剥离
- `20:50` 飞书推送改 bot 身份（--as bot），全链路验证通过
- `21:00` 飞书实施进展文档更新（Day 5.5 记录 + 后续 TODO）
- `21:15` Prompt 自进化子系统设计 v1.0 + Codex 第4轮审查（5条全采纳）
- `21:30` v2.5 实施方案创建（合并 v2.4 + prompt 自进化 + stageEval）
- `21:42` stageEval 反馈驱动迭代设计追加到 v2.5（7阶段流水线 + shadow mode）
- `21:50` Day 6-14 执行计划 + Codex 第5轮审查（重排节奏：eval先shadow/密钥轮换单独做）
- `22:00` HANDOFF-hermes-day6-exec.md 写完，整合全部 codex 反馈

- `19:59` [Dream 冲突检测] 发现 9 对潜在记忆冲突，需 cc 决策：
  - [project/VPS代理网络] "★★★ DMIT 只支持 SSH 密钥登录，密钥位置见本地 ..." ↔ "★★  DMIT SSH 跳板连落地机：见本地 .env 中..."
  - [project/状态-技能库] "learned instinct 文件的 ECC 格式要求为..." ↔ "learned instinct 文件的 ECC front..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★★ cc 每日自进化检查中，黄标升级候选可自主升级，无需..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★★ cc 每日自进化检查中，白标升级候选需列出后等待老板..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★  cc 完成自主升级后需向老板汇报结果与改善点 [20..."
- `20:54` Codex 完成 Futurus v2.5 + Hermes 代码对齐评审，给出多智能体可视化编排/执行界面 4 套可对比方案（看板/控制台/DAG/飞书内嵌），建议优先做控制台路线
- `21:53` Codex 输出 Hermes 多智能体可视化控制台 v1 执行规划文档，归档到 2-Projects/futurus-okr，推荐先做运行控制台，再演进 DAG 编排器
- `22:16` Codex 已将 Hermes 多智能体可视化控制台 v1 执行规划创建为飞书文档，并插入 Futurus 战略情报多智能体系统设计目录下


- `20:50` 读取飞书产品定义索引 + Codex版分析 + v1.3最终版三篇文档
- `21:00` cc 初审 → v1.4 评审报告（6亮点+7问题+修订路线图）
- `21:10` Codex 对抗审查 → 5个盲点+架构一致性升级+Day-1体验升级
- `21:20` cc 终审整合 → v1.4 正式版
- `21:25` 川哥纠偏：心流理论回归第一公民，不是营销而是自主进化动机核心
- `21:30` v1.5 心流工程化版（7组可编码公式：challengeRatio/flowBoost/isDegrading等）
- `21:45` V1.0 产品定义正式版输出（12章 ~900行），Codex 并行写 IntrinsicMotivation 代码
- `22:00` 新增服务器需求章节（2A），竞品表格化（4张表21项），飞书文档同步
- `22:10` 多智能体调研：Explore Agent 逆向 claude-code-source 6个机制 + 8框架对比
- `22:20` 推荐混合方案：CC骨架 + Swarm交接 + 心流自研
- `22:30` V1.1 多智能体架构版，新增第十二章，飞书文档+电子表格同步完成
- `22:34` 更新记忆+提交代码
- `22:58` **✅ 读取 EvoDesk 产品定义与框架评估表，输出 Agent Swarm 并行实施双 Prompt**：
  - 数据源：产品定义 Wiki `ZPrywFgNqi64InkeL8ecDeOdn3f` + 框架评估表 `HhwywHDGciI2qgkT2PGcA1zKnZd`
  - 关键提炼：多智能体不是“讨论型”，而是能力槽位路由 + 后台进化 + 跨 session 记忆 + 心流统一调控
  - 框架结论：采用 `Claude Code 工程骨架 + Swarm 轻量交接 + 心流状态机自研`，不走 CrewAI/AutoGen 讨论式编排
  - 产出：1 套“规划 Prompt” + 1 套“执行 Prompt”，可直接投喂 swarm 编排器

### 关键决策
- 心流理论是产品灵魂（全局规则，已写入 memory）
- 多智能体不照搬任何框架，Claude Code 工程骨架 + 心流自研
- Brain Server 推荐部署 Mini M4，端口 19080

### 飞书产出
- 产品定义 V1.1: https://www.feishu.cn/wiki/JsKCwhXhZib0B5k17pUcS2x0njg
- 框架评估表: https://futurus.feishu.cn/wiki/HhwywHDGciI2qgkT2PGcA1zKnZd

- `14:20` US VPS (Colocrossing, IP/rDNS 存 .env) 新增：Ubuntu 24.04 + BBR + 3x-ui + xray-core 26.2.6；创建 VLESS-Reality(443) + VMess-WS(10086) 双节点；SSH 别名 us-vps；项目落在 2-Projects/vps-proxy/xray/（.env/subscription/outbounds 全 gitignore）

- `14:39` US Xray 中转部署：LAX DMIT（IP/hostname 存 .env）gost 转发 :443/10086 → 落地机；Reality 经中转穿透验证（openssl 拿到 CN=www.cloudflare.com）；SSH 别名 lax-relay；subscription 新增 4 条链接（直连 + 中转 × VLESS + VMess）
- `14:51` VLESS-Reality dest 从 www.cloudflare.com 改为 www.microsoft.com（cloudflare SNI 在 5G/某些 ISP 下被 RST/污染导致 context deadline exceed；microsoft.com 更稳）

- `22:00` Gemini CLI 接入 Claude Code（MCP 路径）：choplin/mcp-gemini-cli＠0.3.1 写入 ~/.claude.json 顶层 mcpServers.gemini-cli（npx 动态拉取，不全局装），env 显式 PATH+NO_PROXY；底层 spawn 官方 gemini 0.36.0（OAuth personal，~/.gemini/oauth_creds.json 已登录 hahaxiong83＠gmail.com）；MCP stdio 握手通过，暴露 3 tool：googleSearch/chat/analyzeFile；gemini-cli 0.36 settings.json 的 auth 字段在 security.auth.selectedType（不是顶层 selectedAuthType）；备份 ~/.claude.json.bak-gemini-mcp-20260417-215832；重启 Claude Code 后调用 mcp__gemini-cli__chat 可端到端验证。
- `22:24` Gemini CLI 重复浏览器授权根因修复：`scripts/gemini-mycc.sh` 每次启动都把项目 `.gemini/settings.json` 覆盖到 `~/.gemini/settings.json`，抹掉用户级 `security.auth.selectedType`，导致 CLI 误判未选认证方式而反复弹 OAuth；已改为不再覆盖用户级 settings/config，保留官方“用户级 ~/.gemini + 项目级 .gemini 自动合并”机制，连续两次启动后 `~/.gemini/settings.json` hash 不变且 `selectedType=oauth-personal` 保持。

- `00:30` ⚠️ Gemini MCP 端到端**未通**（修正前条"✅" 表述）：根因锁定为 `~/.local/bin/gemini` 是 symlink 指向 **mycc 自己的 wrapper** `scripts/gemini-mycc.sh`（不是官方独立 CLI），wrapper 再 exec 项目本地 `mycc/node_modules/.bin/gemini`。MCP subprocess 调 gemini 时卡在 "Opening authentication page Y/n" — 极可能因 MCP server env 的 HOME 未正确传递导致 wrapper 的 `$HOME/.gemini` 解析错位 / 或项目本地 gemini 依赖版本与独立 CLI 认证字段不一致。3 次尝试：①env 只传 PATH+NO_PROXY ②补 HOME/USER/GCA 重测 ③yolo=true，均失败。已记 ~/.claude.json.bak-gemini-mcp-20260417-215832 可回滚。反思：一开始 `which gemini` 看到 0.36.0 就相信官方，没 `file`/`readlink` 验证 — feedback_negative_conclusion_discipline.md 的维度覆盖自检漏洞。

- `00:45` Gemini MCP 接入根因突破：装官方 `＠google/gemini-cli＠0.38.1` 到 `~/local/node/bin/gemini`（独立 npm global，旁路 mycc wrapper symlink）；cd /tmp + 绝对路径冒烟：`"MCP issues detected. Run /mcp list for status.pong"` exit 0 — **pong 真的拿到了**。改 ~/.claude.json 的 mcpServers.gemini-cli.env.PATH 为 `/Users/rayman.chen/local/node/bin:/usr/local/bin:/usr/bin:/bin`（剔除 .local/bin 避免 PATH 命中 mycc wrapper）。**重启 Claude Code 后**调 mcp__gemini-cli__chat 即可端到端通。

- `00:50` Gemini MCP 全链路 + mycc 记忆共享**打通**：新增 `mycc/scripts/gemini-for-mcp.sh`（复用 gemini-mycc.sh 的 build_memory_sync + cd ROOT，但 exec 指向独立官方 `~/local/node/bin/gemini＠0.38.1`）；新增 symlink 目录 `~/local/mcp-gemini-bin/gemini` → wrapper；`~/.claude.json` mcpServers.gemini-cli.env.PATH 改为 `~/local/mcp-gemini-bin:~/local/node/bin:...`。wrapper 层冒烟实测返回 pong(exit 0)，memory-sync.md(18KB) 刚刷新含 cc/codex/gemini 三套 agent-memory。**cc/codex/gemini 真·共享 mycc 记忆架构**（AGENTS.md + GEMINI.md + memory-sync.md + agent-memory/*）。重启 Claude Code 后即可通过 mcp__gemini-cli__chat 端到端验证。

- `19:58` [Dream 冲突检测] 发现 9 对潜在记忆冲突，需 cc 决策：
  - [project/VPS代理网络] "★★★ DMIT 只支持 SSH 密钥登录，密钥位置见本地 ..." ↔ "★★  DMIT SSH 跳板连落地机：见本地 .env 中..."
  - [project/状态-技能库] "learned instinct 文件的 ECC 格式要求为..." ↔ "learned instinct 文件的 ECC front..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★★ cc 每日自进化检查中，黄标升级候选可自主升级，无需..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★★ cc 每日自进化检查中，白标升级候选需列出后等待老板..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★  cc 完成自主升级后需向老板汇报结果与改善点 [20..."

- `15:40` [EvoDesk V1.5.0 B14-4b 完成] desktop-shell 接入 Provider Router（commit 1ede1e1，~300 LOC 前端）：ipc.ts 加 getRouterDecision/getRouterStats + FlowPage 加 RouterDecisionCard/RouterStatsCard + 5 处版本号 0.9.0→0.10.0。Tauri .dmg EvoDesk_0.10.0_aarch64.dmg 打包成功。测试 133/133 + tsc 0 错 + curl 200 实测。gemini-3-flash-preview plan 审 PASS-with-changes 采纳 3/5 条（0.10.0 不跃 1.0.0 / Total Requests 聚合 / pre-flight restart），批量端点+4×5 预置矩阵留 B14-4c。pre-flight 教训：上 session B14-4a commit 的 handleRouter dispatch 链因 brain-kernel 进程未重启导致 404，本 session 首动作 restart 后 200。gemini 内嵌 plan 实战合规（600 字评审 12s）。挂起：L0 飞书主索引升版 + 离线包同步（非本轮动点）。

- `20:55` [EvoDesk V1.5.0 收尾] 清完🔴 1-4 挂起项：(1) git push origin main commit 1ede1e1 + fcbd586 已同步 remote (2) sync-offline-kit.sh 同步离线包到 V1.5.0 头（5 文件刷新，commit fcbd586）(3) L0 飞书主索引 OUZAdQA... H1 升 `V1.5 (V1.5.0)`，log_id 202604192052533E1364099E78E290104B，fetch 验证 `V1.5.0=True / V1.4.2 in H1=False` (4) 实装 EvoDesk_0.10.0_aarch64.dmg 到 /Applications，bundle 0.10.0 + window title `EvoDesk v0.10.0` 肉眼确认。git commit hostname 变成 bogon，用 -c user.email=xxx 临时传参（不改 global config，守 NEVER update git config 规则）。

- `21:37` [哲学体系文档增强] 飞书文档 N1eawou0MiXfUbkOaIgcYTm1n7b 的“工程化/编码化实现”升级为 6 列：新增“为什么对应（机制依据）”，逐行解释 ADR/schema+RDF/Coq/PyTorch/NetworkX/OpenTelemetry/Temporal/Ax 等项目或论文如何通过显式约束、证据路由、proof checking、loss+validation、图推理、遥测自观测、durable workflow、反馈回写体现白板逻辑；并追加“判定依据”三条，fetch 回读已验证。

- `21:47` [CLAUDE.md 新增 "Context/Session 管理（1M 时代）" 小节] 读 Thariq ＠trq212《Using Claude Code: Session Management & 1M Context》后固化 3 条规则：**R1** 主动 compact 带老板确认门（cc 提 `focus on <下一步> / drop <无关区>` 计划，等点头再执行，避免 cc 判断下一步失误导致关键信息被丢）；**R2** 方案失败时优先 `/rewind`（Esc Esc）回到踩坑前 / 读文件后，不在污染 context 里"再试一下"，rewind 置于 failure-escalation RETRY 之前；**R3** delegate 前做 subagent 路由测试 "要结论 or 要过程？"。小节插入在 `跨 session 交接` 之后、`飞书通道确认规则` 之前。出处 x.com/trq212/status/2044548257058328723（jina reader 公网拉，opencli twitter 因 x.com 未登录 fallback）。核心新认知：1M context 不是"无脑塞"的许可，context rot 在 ~300-400k 就开始；bad compact 根因 = 压缩时模型正处 rot 最严重 + 不知下一步意图，所以必须主动 + 带 intent。

- `21:55` [EvoDesk V1.5.1 B14-4c 完成] Router 前端增强（commit b0e487c）：后端 /v1/router/decisions 批量 + /v1/router/policy SSoT + 3 新测试 136/136；前端 5 次→1 次 fetch + 4×5 色块矩阵降级（标「策略意图·未实时执行」）；版本号 0.10.0→0.11.0（grep 零残留）；Tauri .dmg EvoDesk_0.11.0_aarch64.dmg 实装，window title v0.11.0；gemini-3-flash-preview 6 条建议全采纳（部分成功 200 / 色块 / 策略意图标注 / policy SSoT / IPC 容错 / 0.11.0 语义）；L0 飞书主索引已升 V1.5.1；离线包同步 V1.5.1。**新教训**：bundle_dmg 残留挂载失败（/Volumes/dmg.*），重打包前必 detach；tauri build 成功会清理 macos/EvoDesk.app，实装必须从 .dmg 挂载复制。

- `21:51` [哲学体系文档原理对齐增强] 飞书文档 N1eawou0MiXfUbkOaIgcYTm1n7b 的“工程化/编码化实现”第六列改写为“为什么对应（原理对齐）”：逐行补入功能位置、信息流、约束与反馈机制，说明 ADR/schema+RDF/Coq/PyTorch/NetworkX/OpenTelemetry/Temporal/Ax 如何在代码层承担与白板同构的哲学角色；并把判定依据升级为功能同构/信息流同构/约束同构/反馈同构四条。

- `23:05` [Agent Swarm P0 HTTP 接入] 两轮完成 dd4e0fc + 381f864，服务路径 `.agents/skills/mycc/scripts/`（gitignored，`git add -f`）：**R1** dispatcher.poll timeoutMs=0 单次探测 + http-server GET /api/task-status/:run_id + POST /api/task-dispatch；**R2** 吸收 codex 对抗审查（主线 `codex exec` 直调，落盘 /tmp/codex-review-dd4e0fc.md，180KB 含 8 轮 cat+推理）修 CRITICAL×2（原子写 tmp+rename / 错误脱敏）+ HIGH×3（task-status 鉴权 / timingSafeEqual 防时序侧信道 / run_id 白名单）+ NIT（202 Location 头）+ poll 损坏 JSON 自愈 unlink。14/14 vitest 通过，tsc 无新错。**新教训**：`Agent({subagent_type:"codex:codex-rescue"})` 不跑审查就返回空壳 —— 对抗审查必须主线 Bash 直调 codex exec，落盘 stdout（feedback_codex_rescue_subagent_trap.md）。
- `13:35` B16 Agent 完整实装完成（state-machine 真实 handlers + M1 errorCode 安全修复 + 防线 4 LLM-judge + feishu webhook + proposals 端点），194/194 tests，B.5 回流飞书 CURRENT+ROADMAP 写后读校验通过，codex 对抗审查后台运行中

- `19:58` [Dream 冲突检测] 发现 9 对潜在记忆冲突，需 cc 决策：
  - [project/VPS代理网络] "★★★ DMIT 只支持 SSH 密钥登录，密钥位置见本地 ..." ↔ "★★  DMIT SSH 跳板连落地机：见本地 .env 中..."
  - [project/状态-技能库] "learned instinct 文件的 ECC 格式要求为..." ↔ "learned instinct 文件的 ECC front..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★★ cc 每日自进化检查中，黄标升级候选可自主升级，无需..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★★ cc 每日自进化检查中，白标升级候选需列出后等待老板..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★  cc 完成自主升级后需向老板汇报结果与改善点 [20..."

- `00:24` [Dream 冲突检测] 发现 9 对潜在记忆冲突，需 cc 决策：
  - [project/VPS代理网络] "★★★ DMIT 只支持 SSH 密钥登录，密钥位置见本地 ..." ↔ "★★  DMIT SSH 跳板连落地机：见本地 .env 中..."
  - [project/状态-技能库] "learned instinct 文件的 ECC 格式要求为..." ↔ "learned instinct 文件的 ECC front..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★★ cc 每日自进化检查中，黄标升级候选可自主升级，无需..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★★ cc 每日自进化检查中，白标升级候选需列出后等待老板..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★  cc 完成自主升级后需向老板汇报结果与改善点 [20..."

- `13:57` xray 路由：lovart.ai 从 direct 迁至 google-ai-balancer（美宅 US2 VLESS-Reality + VMess-WS）。DoH+verbose TLS 诊断确认本网 Air SNI 阻断；JP 兜底 10s 超时、direct SSL_ERROR_SYSCALL；Gemini 节点 1.9s/200 稳定。skill/project_xray/新建 feedback_cloudflare_sni_diag 同步。

- `19:03` [记忆同步] 三引擎记忆链路校准完成：补全 0-System/agent-memory 的 cc/codex 记忆，更新 gemini 为 0.38.2，并将 scripts/memory-sync-all.sh 升级为可调用性自检（claude/codex/gemini + gemini-for-mcp 冒烟 + .gemini/memory-sync.md 刷新检查）；实测结果全绿。

- `04:39` [Dream 冲突检测] 发现 9 对潜在记忆冲突，需 cc 决策：
  - [project/VPS代理网络] "★★★ DMIT 只支持 SSH 密钥登录，密钥位置见本地 ..." ↔ "★★  DMIT SSH 跳板连落地机：见本地 .env 中..."
  - [project/状态-技能库] "learned instinct 文件的 ECC 格式要求为..." ↔ "learned instinct 文件的 ECC front..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★★ cc 每日自进化检查中，黄标升级候选可自主升级，无需..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★★ cc 每日自进化检查中，白标升级候选需列出后等待老板..."
  - [user/全局规则] "★★★ cc 每日自进化检查中，红标升级候选可立即自主升级，..." ↔ "★★  cc 完成自主升级后需向老板汇报结果与改善点 [20..."

- `14:29` xray-manager 修复 Gemini/AI Studio/NotebookLM 路由：硬绑 Gemini-US2-VLESS-Reality 单节点（38.49.38.237），删 google-ai-balancer。诊断中发现 first-match-wins 顺序问题（rule#4 宽匹配 domain:google.com 吞掉 rule#5 子域），新增 feedback_xray_routing_first_match.md

## 原子记忆（memory-items）
### user/agent 类别（全量）

### project 类别索引（仅类别名）

## 多引擎独立记忆（agent-memory）
### cc
# cc Agent Memory

> Claude Code 在 mycc 团队中的执行记忆。用于保证与 codex / gemini 的记忆协同一致。

## [experience]

- **身份**：你是 cc（Claude Code，`cli_a91f0b3677f8dcc4`），职责是规划、决策、编排。
- **本机可调用性（2026-04-23 验证）**：`claude` 可执行路径为 `/Users/rayman.chen/local/node/bin/claude`，版本 `2.1.117`。
- **记忆入口**：项目根 `AGENTS.md -> CLAUDE.md`（同源）；短期记忆由 `.claude/settings.local.json` 的 hooks 注入 `0-System/status.md` 等。
- **三引擎共识**：涉及跨引擎协作时，统一使用 `0-System/RECENT_EVENTS.md` + `0-System/memory-items.md` + `0-System/agent-memory/*`。

## [pitfalls]

- **只写规则不验链路会失真**：更新记忆后必须执行 `bash scripts/memory-sync-all.sh`，否则 Gemini 侧 `memory-sync.md` 可能仍是旧快照。
- **多引擎协作时要区分职责**：cc 负责编排，不应把批量实现长期留在本引擎。

## [preferences]

- **输出语言**：中文（强制）。
- **任务收口**：重要任务完成后追加 `0-System/task-log.md`。
- **协作原则**：先达成 O1/O2 对齐，再分发 codex/gemini 并行。

### codex
# codex Agent Memory

> Codex 在 mycc 团队中的执行记忆。用于保证代码执行链路与 cc / gemini 同步。

## [experience]

- **身份**：你是 codex（OpenAI Codex，`cli_a92166c624f85bc6`），职责是写代码、改仓库、跑测试。
- **本机可调用性（2026-04-23 验证）**：`codex` 可执行路径为 `/Users/rayman.chen/local/node/bin/codex`，版本 `codex-cli 0.120.0`。
- **配置位置**：`~/.codex/config.toml`，当前已启用 `features.memories = true`。
- **共享记忆源**：执行 mycc 任务时，以 `AGENTS.md/CLAUDE.md` 规则为准，并同步读取 `0-System/RECENT_EVENTS.md`、`0-System/memory-items.md`、`0-System/agent-memory/*`。

## [pitfalls]

- **只看单一入口会漏上下文**：仅依赖 `AGENTS.md` 不足以覆盖近期变更，跨 session 前需补读 `RECENT_EVENTS.md`。
- **记忆更新不跑同步会造成跨端漂移**：修改 `0-System/*` 后需执行 `bash scripts/memory-sync-all.sh`，避免 Gemini/Studio 侧滞后。

## [preferences]

- **输出语言**：中文（强制）。
- **交付规范**：重要任务完成后写入 `0-System/task-log.md`。
- **执行风格**：先给可验证结果，再补必要说明，减少空泛陈述。

### gemini
# gemini Agent Memory

> Gemini 在 mycc 团队中的独立记忆。由每次 MCP 调用前的 `gemini-for-mcp.sh` 通过 memory-sync.md 自动注入。

---

## [experience]

- **身份**：你是 mycc 三引擎之一，App ID `cli_a92167071e385bc0`；与 cc（Claude, `cli_a91f0b3677f8dcc4`）、codex（OpenAI, `cli_a92166c624f85bc6`）共同服务川哥。
- **被 Claude Code 调用的链路**（2026-04-18 打通）：
  ```
  Claude Code (cc)
    └─ MCP: mcp-gemini-cli＠0.3.1 (npx)
         └─ spawn 'gemini' (PATH 命中 ~/local/mcp-gemini-bin/gemini)
              └─ symlink → mycc/scripts/gemini-for-mcp.sh
                   ├─ build_memory_sync → mycc/.gemini/memory-sync.md (每次刷新)
                   ├─ cd /Users/rayman.chen/mycc
                   └─ exec ~/local/node/bin/gemini＠0.38.2 (独立官方, OAuth personal)
  ```
- **暴露给 Claude 的 3 个 tool**：`mcp__gemini-cli__googleSearch`（联网搜索）、`mcp__gemini-cli__chat`（对话）、`mcp__gemini-cli__analyzeFile`（图片/PDF/文本分析）
- **记忆共享源**（与 cc/codex 同源）：你每次被调用时都能看到：
  - `AGENTS.md` + `GEMINI.md`（自动作为 context 注入，由 `~/.gemini/settings.json` 的 `context.fileName` 声明）
  - `mycc/.gemini/memory-sync.md`（18KB 实时快照，含 status.md + user-profile.md + RECENT_EVENTS 尾部 120 行 + memory-items.md user/agent 全量 + 三引擎 agent-memory）
- **典型职责**（CLAUDE.md 定义）：搜资料、写报告、调研。cc 做规划/决策/编排，codex 做代码/改仓库/测试，你做调研/报告。
- **并存路径**：`mcp__g__ask_gemini`（代理层 23.226.135.149:4000 Vertex+OAuth）仍然可用，不冲突 —— 那是云端代理方案；本 MCP 路径是本地官方 CLI 方案，OAuth 走用户个人账号。

## [pitfalls]

- **认证路径**：OAuth 凭据只在 `~/.gemini/oauth_creds.json`（hahaxiong83＠gmail.com）。MCP subprocess 需要 env 显式声明 `HOME=/Users/rayman.chen` 才能读到，否则触发首次登录菜单（2026-04-18 已踩坑修复）。
- **settings 字段**：CLI 0.36+ 的认证路径在 `security.auth.selectedType`（嵌套），不是顶层 `selectedAuthType`。
- **免费额度**：1000 req/day + 60 req/min（Gemini 2.5 Pro/Flash 混用）。批量任务建议显式传 `model="gemini-2.5-flash"` 省配额。遇 429 时 CLI 会自动 fallback 到备用 model，不必手动切。
- **proxy 干扰**：代理环境下 OAuth 回调走代理会失败；MCP env 已显式 `NO_PROXY=localhost,127.0.0.1,accounts.google.com,oauth2.googleapis.com,generativelanguage.googleapis.com,cloudcode-pa.googleapis.com`。
- **MCP issues 警告**：CLI 启动时可能打印 `MCP issues detected. Run /mcp list for status.` —— 那是 CLI 内部加载了 feishu/context7/memory/sequential-thinking 这四个 MCP server 失败（`~/.gemini/settings.json` 声明但 env 跑不起来），**不影响核心 chat/search/analyzeFile 能力**，忽略即可。
- **多套 gemini 并存**：机器上至少三份 binary：`~/.local/bin/gemini`（mycc wrapper symlink，用户日常用）、`mycc/node_modules/.bin/gemini`（项目本地依赖）、`~/local/node/bin/gemini`（MCP 链路走的独立 0.38.2）。这次踩坑 root cause 就在没 `readlink -f` 验证 binary 真身就下结论。

## [preferences]

- **默认 model**：`gemini-2.5-pro`（choplin MCP wrapper 默认）；省配额场景传 `model="gemini-2.5-flash"`。
- **输出语言**：中文（mycc 硬规则）。
- **任务交付署名**：`署名：gemini（Google Gemini）| [完成时间]`。
- **工具路由**：被 cc 编排到"搜资料/写报告/调研"场景；代码/仓库操作应建议 cc 切 codex。
- **记忆写入纪律**：如果在对话中获得新知识或修正，建议 cc 追加到 `0-System/memory-items.md` 或 `RECENT_EVENTS.md`，不要自行假设 cc/codex 会同步。
