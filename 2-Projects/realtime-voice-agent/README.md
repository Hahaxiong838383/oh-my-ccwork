# realtime-voice-agent

> 通用型实时语音 Agent — **体验引擎可插拔（变），记忆内核恒定（不变），两者之间是一份稳定契约。**

- **北极星**：用 Tier A（cascade）达成媲美火山引擎 RTC 的对话式 AI 体验（打断自然、判停准、低延迟、~1s）。
- **护城河**：可控、可审计、带跨会话长期记忆的对话内核（CQRS 事件溯源 + interrupt-safe 一致性）。

完整设计见 [`docs/PRODUCT-DEFINITION-v3.3.md`](docs/PRODUCT-DEFINITION-v3.3.md)（最新正文）、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)（架构时序）、[`docs/DEPLOYMENT-MINI-STUDIO.md`](docs/DEPLOYMENT-MINI-STUDIO.md)（M0/M1 自托管部署拓扑）与 [`docs/voice-agent-product-definition-v3.2.md`](docs/voice-agent-product-definition-v3.2.md)（**附录 C/D/E/F**：契约接口 / 延迟预算 / Voice-Eval / 适配器骨架；正文以 v3.3 为准）。

> 🔧 **火山 RTC 实操对标参考（已验证一手代码）**：[`../../4-Assets/SOP/volc-rtc-realtime-voice-agent-SOP.md`](../../4-Assets/SOP/volc-rtc-realtime-voice-agent-SOP.md) — 火山 RTC AIGC 全链路实施蓝图（服务开通 / SDK / 豆包 ASR+TTS / CustomLLM 接 LLM / 10 条踩坑）。本项目里它是**北极星对标基准**（Tier A 要媲美的火山 RTC 体验）+ **Tier B 托管路线的具体落地**（M3 热插 Tier B）。提炼自 P003「小可」生产代码，真机 E2E 跑通。

---

## 分层架构（与代码目录一一对应）

```
用户音频 ─► 体验引擎(engines/，可插拔) ─► 适配层(adapters/) ─► 稳定契约(contract/) ─► 记忆内核(kernel/，恒定)
              Tier A/B/C                  引擎事件→归一化       9 类契约事件          CQRS：DRAFT→Event Log→投影→仲裁
                                                                                              │
                                                              Context 注入 ◄── 投影(Working Set / Vector) ◄┘
```

| 目录 | 层 | 状态 | 说明 |
|---|---|---|---|
| `src/voice_agent/contract/` | 稳定契约（不变） | ✅ 完整 | 9 类归一化事件 + 基础类型，记忆内核只认它 |
| `src/voice_agent/kernel/` | 记忆内核（恒定 / CQRS） | ✅ 纯逻辑写实 | DRAFT 状态机 / Event Log（append-only + 幂等）/ 投影 / 来源仲裁 / 三闸抽取 |
| `src/voice_agent/engines/` | 体验引擎（可插拔 / 变） | 🟡 接口骨架 | Tier A Cascade ★MVP / B 托管 Realtime / C 自托管双流；M0 接 LiveKit |
| `src/voice_agent/adapters/` | 适配层 | ✅ 映射写实 | LiveKit 事件→契约；Tier B/C 旁挂 STT+turn detector 合成 committed |
| `src/voice_agent/pipeline/` | 冷热路径编排 | ✅ 编排写实 | 会话编排 + 冷路径异步边界 + 热路径延迟埋点 |
| `src/voice_agent/eval/` | Voice-Eval | ✅ 指标写实 | §5 指标门槛 + CER/percentile + Event Log 文字级审计 |

> **「记忆内核纯逻辑」现在就可运行可测**（零外部依赖）；**「体验引擎」是接口骨架**（依赖 LiveKit + 真 key，M0 接线）。这条边界 = 「护城河先立、引擎后插」。

---

## 快速开始

```bash
make dev      # 安装包 + dev 依赖(pytest/ruff/mypy)
make check    # 交付双门:ruff + mypy(strict) + pytest 全过
make run      # 跑骨架入口(打印组装结果,无需任何真值)
make m0-smoke # 跑 M0 离线契约验收(事件桥→契约覆盖→基础指标门)
make tree     # 看源码树
```

接线真实引擎（M0）：

```bash
cp .env.example .env        # 填 LiveKit / STT / LLM / TTS 真值
pip install -e '.[tier-a]'  # 装 Tier A 引擎依赖(livekit-agents 等)
make run-livekit            # 启动 M0 LiveKit worker(默认 agent: realtime-voice-agent)
```

当前 M0/M1 自托管主线：**Mac mini 跑 LiveKit SFU/TURN/WSS，Studio 通过雷电网桥跑 voice-agent worker 与后续本地模型**。详见 [`docs/DEPLOYMENT-MINI-STUDIO.md`](docs/DEPLOYMENT-MINI-STUDIO.md)。

---

## 归一化契约事件（`contract/`，记忆内核消费的最小公共集）

| 事件 | 触发 | 对记忆的作用 |
|---|---|---|
| `UserSpeechStarted` | VAD 开口 | 开一个 turn |
| `UserTranscriptInterim` | STT 中间结果 | **仅维持 DRAFT，不提交** |
| `UserTranscriptFinal` | STT 最终化 | COMMIT 候选（对账用 `item_id`） |
| `UserTurnCommitted` | 语义 EOU | **唯一提交点** |
| `Interruption` | 真打断 | 冻结/丢弃 DRAFT（零成本回滚） |
| `FalseInterruption` | 假打断 | **不动记忆** |
| `Agent*` | agent 开口/收口/转录 | 状态机推进 / 记 agent 回合 |

**核心不变量**：写记忆只在 `UserTurnCommitted` + 抽取完成；interim 永远 DRAFT；打断 = 零成本回滚。三 Tier 共用同一组契约 → 引擎热插、记忆 IP 不重写。

---

## 演进路线（验收门见 `PRODUCT-DEFINITION-v3.3.md` §8）

| 里程碑 | 目标 | 验收门 |
|---|---|---|
| **M0** | Tier A L1 打断 + 契约打通 | G0：契约事件 100% 覆盖 + 端到端可演示 |
| **M1** | 调优到 RTC 级 + 记忆接入 | G1：P95<1.2s / EOU 误打断<5% / 判停 P95<1.5s / 跨会话可召回可审计 |
| **M2** | 自然轮替 + 失败模式硬化 | G2：barge-in 假阳性<2% / 幂等·对账·三闸全绿 |
| M3（可选） | 热插 Tier B，记忆零改 | G3：Tier B 路径内核零代码改动 |
| M4（可选） | 端侧 / Tier C 自托管 | — |

---

## 延迟调优速查（附录 D.4，按收益排序）

> 反直觉锚点（E2）：延迟不藏在 STT/TTS，藏在 **turn-taking 判停** 与 **LLM 首 token(TTFT)**。先打这两处，其余达标即可。

1. **先打 turn-taking 与 LLM TTFT**——延迟真正藏身处。
2. **语义判停替代纯 VAD 静音**（避免傻等 500ms），调 `min/max_endpointing_delay`。
3. **预测性生成 `preemptive_generation`**：EOU 前投机起 LLM/TTS，打断时白做 → 正好挂记忆 DRAFT 零成本回滚。
4. **全链路流式、严禁阻塞**：STT partial → LLM token → TTS chunk 逐级重叠。
5. **选低 TTFA 的 TTS**（用 **TTFA 不用 TTFB** 衡量）；⚠️ **中文 TTFA 是 E0 缺口，须自测**（火山/MiniMax/Qwen-TTS）。
6. 地理同址；7. WebSocket 多路复用（省 ~50ms/回合）；8. 调小客户端音频缓冲；9. 云端 3A + AI 降噪。

**延迟分段预算（D.1，用户停说→首音频）**：判停 150–300ms（最大变量）· LLM TTFT 300–600ms（第二大）· TTS TTFA 40–300ms。各段**流式重叠非相加**，感知端到端可压到 ~600ms–1s。

---

## 证据级（诚实声明，对齐 §10）

- 契约/事件名/对账约定：**E3**（三引擎官方核对）。
- 延迟预算/对标靶：**E2/E3**（公开实测，非本系统）。
- **本系统端到端运行 / 延迟 / CER / 误打断：E0 → 待 Voice-Eval 实测 E4**。在 `eval/` 产出真实数字前，性能结论都是「设计 + 调研」，不是「已验证」。
- ✅ **附录 C/D/E/F 已补齐**（见 `docs/voice-agent-product-definition-v3.2.md`）：契约的三引擎真实事件映射(C)、延迟预算+调优手册(D)、Voice-Eval 规范(E)、可运行适配器骨架(F，事件名 E3 核对 / 端到端 E0 未测)。
