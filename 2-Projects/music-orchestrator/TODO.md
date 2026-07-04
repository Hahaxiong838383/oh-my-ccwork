# music-orchestrator 后续优化 TODO

> 2026-07-04。当前状态：MyJavis + realtime-voice-agent 都能播放 + 换歌（止血修复已上线）。以下按优先级排。

## P0 — 核心地基（决定"是不是智能音箱级体验"）

- [ ] **共存阶段 1：唤醒词门控 + ducking**（`DESIGN-coexistence.md` v2 的落地）。当前最大瓶颈：音乐大声放着时，助手被音乐盖住听不清指令（barge-in）。真机日志实锤：MyJavis 转录出"包含拟真暴力"乱码（音乐漏进麦克风）、voice-agent 播放后 17s 零 STT。
  - MyJavis：客户端 KWS（sherpa-onnx WASM 或 Tauri 原生）+ 播放中 mute 火山上行，喊「hi 贾维斯/你好 贾维斯/贾维斯 贾维斯」才唤醒。
  - voice-agent：服务端 agent 侧 KWS（已有 mic 流 + sherpa Python）+ STT fanout 门控。
  - 唤醒后 duck 音乐到 15-25% 让助手听清，对话完恢复。
  - ⚠️ 唤醒词音素拆分对着官方模型 tokens.txt 现验，不手搓。
- [ ] **服务端唤醒词门控（更轻的 MVP 前置）**：不做端侧 KWS，先在大脑侧——播放中转录文本不含唤醒词就不响应。几乎纯服务端，先止住"歌词乱触发"。

## P1 — 播放体验 / 命令完整度

- [ ] **搜索结果质量**：现在搜"周杰伦"top 结果常是 4K MV/游戏视频（如"原神一条龙"），不是干净音源。ranking 加"音乐向"信号（时长带、UP 主类型、"纯音乐/无损"关键词加权、排除游戏/影视区）。
- [ ] **上一首（prev）真实现**：现在是 stub（只暂停）。需 music-session 存播放历史栈，prev 回上一首。
- [ ] **queue / 播放列表**：music_queue 现是内存 stub。做真队列（加歌/清空/查看/连播）。
- [ ] **单曲循环 / 随机播放 / 播完自动下一首**：音箱标配。播完自动 next 需前端 `<audio>` 的 ended 事件 → 触发 next。
- [ ] **音量绝对值设置**："音量调到 50%""音量最大"（现在只有相对 大声点/小声点）。
- [ ] **收藏 / 我喜欢**："收藏这首歌"，需持久化存储。

## P2 — 源 / 可用性

- [ ] **网易云源（ncm-cli）接入 ranking**：已有资产，国内曲库互补 + bilibili 挂时兜底。从 Phase3 提前。
- [ ] **YouTube Music 源**：小号 cookies + `bgutil-ytdlp-pot-provider`，全球库补充。
- [ ] **bilibili 反爬监控**：get_download_url(html5) 这条路将来可能也被收紧，加健康探活告警。
- [ ] **多源竞速 / 自动换源**：某源解析失败自动降级下一源（ranking 已并发搜，解析层补降级）。

## P3 — 工程 / 运维

- [ ] **multica 日常维护实装**：`deploy/multica/` 脚本已写好，装到 Mini（launchd + workspace 建 agent 绑 skill），联调 `/admin` 巡检。
- [ ] **流式首播支持 Range**：现在首次流式不支持 Range（缓存命中才支持）。若要 seek 未缓存的新歌需补。
- [ ] **并发同歌去重**：两个请求同一首未缓存的歌各自触发下载（无 leader/follower）。个人自用概率低，量大再做。
- [ ] **token TTL / 续签**：现 6h。长会话跨 6h 续播会 401，需前端感知重新拿 URL 或延长 TTL。
- [ ] **观测**：命中率 / 各源失败率 / 首字节延迟埋点，数据驱动调 ranking 权重和缓存阈值。

## P4 — 跨产品统一

- [ ] **共存交互层抽象共享**（`DESIGN-coexistence.md` §4）：状态机语义 + 事件契约 + ducking 策略 + 唤醒词配置抽成共享模块，MyJavis / voice-agent 各实现 WakeWordDetector/SpeechInputGate/MusicController/AssistantTurnController 接口。
- [ ] **家庭设备层（远期）**：Music Assistant 放家里 Mini/NAS，Orchestrator 加"家庭设备"target（AirPlay/Cast/小爱）。
