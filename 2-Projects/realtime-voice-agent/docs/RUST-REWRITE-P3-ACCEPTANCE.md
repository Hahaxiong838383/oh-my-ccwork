# Rust 重写 P3 验收报告（P4 灰度卡点材料）

> 2026-08-12 · 分支 feat/rust-worker @ d65a1647d · worktree ~/mycc/.claude/worktrees/rust-worker
> P1 拍板约束「原功能不妥协」的逐项验收；生产 64.90 全程物理零接触。

## 一、验收矩阵（对照生产 .env 实际开启项）

| 能力 | 生产开关 | Rust 状态 | 验证深度 | 证据 |
|---|---|---|---|---|
| 判停（definite+delay） | on | ✅ | E2E | eou_ms=655/671/682/692 |
| EOT 语义判停两挡 | on | ✅ | E2E | MIN 挡 655ms / MAX 挡 1305·1330·1338ms（prob<0.3550 时 EOT 主动多等） |
| 打断（VAD 0.5s+字数门→pause） | on | ✅ | E2E | interim='等' 即 pause，打断点录音立即静音 |
| 假打断恢复（1.5s→resume） | on | ✅ | E2E（注入 MIN_INTERRUPTION_WORDS=0 触发；resume 机制与生产同一段代码） | `resumed false interrupted speech`+`契约 FalseInterruption`，回答从暂停点续播完 |
| 环境音免疫（0 字门） | on | ✅ | E2E | 「嗯嗯」「啊」零打断；ddc 空句 WARN 兜底同款落地 |
| 急停白名单 | on（默认词表） | ✅ | 单测+静态对齐 | 生产 min_words=1 下与 Python 一样几乎总被字数门抢先 |
| AEC warmup 0.5s | on | ✅ | E2E（armed 日志）+框架源码对齐 | 当前框架真语义=窗口内禁音频路打断（tier_a 注释已过时） |
| 打断历史截断 | on | ✅ | E2E | 合成 22→实播 14 字、105→37 字；截断后 LLM 上下文正确 |
| 多轮历史一致性 | on | ✅ | E2E | 5 轮跨 3 次打断后「刚才第一个问题」回忆命中 |
| S1v3 投机+preemptive | on | ✅ | E2E | lead_ms=352/432/1124 命中；文本变化正确作废 |
| filler 9 桶+打断轮必播 | on | ✅ | E2E | ask/task/thanks/gen 四桶命中、滑窗 3 防重复 |
| 剥句首承接词 | on | ✅ | 单测×6+E2E 听感 | 跨 chunk/整句保留/最多 3 层 |
| TTS 连接池 | on | ✅ | E2E | greeting ttfb 680→402ms；7 句长答连续合成零失败 |
| LLM prewarm | on | ✅ | E2E | 244ms 预建连 |
| 声纹旁路+粘滞+ctx 注入 | on | ✅ | E2E | 跨 opus/RTC 信道 0.606~0.871 命中；首句识别第二句注入 |
| 契约日志九事件 | on | ✅ | E2E 逐行对齐 | 微差：AgentTranscriptFinal 我=播完/截断落账时，Python=conversation_item_added |
| metrics/state publish | on | ✅ | 代码对齐+发布无错 | 客户端消费端未抓包，P4 用 web 延迟面板肉眼验 |
| 删房 delete_room_on_close | on | ✅ | E2E | `room deleted`（twirp+roomCreate token） |
| canonical 转写 | on | ✅ | E2E+单测 | 无标点保小数点，S1 命中前提 |
| STT 断线重连 | —（Python 死流） | ✅ 改进项 | 代码级（未真机拔线） | 连败 5 次放弃+长稳重置 |
| greeting say 入历史 | on | ✅ | E2E | |
| RSS 监控 | on | ✅ | Linux E2E | `job rss` 同格式，口径=整 worker 进程 |
| 恢复渐起 fade | off（0） | ✅ 已实现默认关 | 实现级 | |
| B5 interim 提交 / LLM 赛马 / 哨兵挂断 / MyJavis 共脑 / tenant-brain / barge_gate(B9) | off/主线外 | 未实现（接口留） | — | 生产关闭项，需要时对齐 |
| 音乐工具 | 配置 on 但后端 8100 无监听 | **搁置（川哥拍板）** | — | 现网该功能本身已坏，仅测试用途 |

## 二、Linux（dev198, Ubuntu 26.04 / 16C / 31G）基线

- **构建**：TLS 全链 rustls+ring 后全通（openssl 仅存 ort 下载器 build-dep，不进 bin）。教训：libwebrtc 静态库自带 BoringSSL 符号，任何 openssl 进最终链接 Linux 必撞 duplicate symbol（macOS ld64 容忍属侥幸）。
- **cargo test**：37/37（含真模型 silero 冒烟）。
- **sidecar 延迟**：EOT 进程内 p50 19.6ms；UDS 往返 25.4ms → **IPC 净开销 +5.8ms**（判停路径余量 450ms+，无感；macOS M 系为 0.04ms）；声纹嵌入 3s 音频 41ms（旁路异步）。
- **内存**（5 连长对话 + 并发 2 路，probe 实打）：
  | 位点 | RSS |
  |---|---|
  | worker idle | 30MB |
  | 单路通话中 | ~85MB |
  | 稳态（MALLOC_ARENA_MAX=2，5 通收敛） | ~106MB |
  | **并发第二路边际** | **+11MB** |
  | sidecar（EOT+CAM++，全机一份） | 421MB |
  | 默认 arena 对照 | +12MB/通不收敛（glibc arena 持留，非泄漏——ARENA_MAX=2 实验定性） |
- **部署建议**：unit 文件设 `MALLOC_ARENA_MAX=2`；构建机需 `libgio-2.0-dev`（Ubuntu 26.04 拆包后的实际内容包；dev198 无 root 用 apt-get download+dpkg -x 用户态解包旁路验证过）。
- **对比 P0 Python 基线**：单路边际 289~440MB → Rust ~11MB（**26~40 倍**）；Python 每 worker 进程各驮 278MB 推理段 → Rust 集中到 sidecar 全机一份。4c4G 生产机粗算：421+30+N×11 → **20 路+ 内存余量**（CPU 将先成瓶颈，4 核实测留待灰度）。P0 目标「单路 ≤50M、并发 ≥10 路」内存维度达标。

## 三、诚实边界（P4 真人验收清单）

1. 假打断 resume 的**生产形态触发**（min_words=1 下需 ASR 幻听出字）：合成音频构造不出，真人清嗓/背景电视是天然触发器。
2. metrics 面板端到端：web 延迟面板肉眼确认数字流动。
3. 4 核生产机 CPU 上限与并发容量实测。
4. AgentTranscriptFinal 触发时机微差是否影响 console 侧任何消费（grep 契约的工具链）。
5. STT 重连未真机拔线验证。
6. tenant 线（xfyun，voice-worker-colleague）不在本期范围。

## 四、灰度方案（P1 拍板既定）

agent_name 分流：Rust worker 以独立名注册 → dispatch 按名派单 → 逐房灰度；回滚=切回 Python worker 派单（分钟级，Python 全套保留未动）。切换前后 64.90 三 unit 不中断。
