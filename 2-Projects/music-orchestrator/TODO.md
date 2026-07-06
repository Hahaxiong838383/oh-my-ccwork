# music-orchestrator 后续优化 TODO

> 2026-07-05 更新。当前状态：**共存 P0 步 2 已上线并生产验证**（MyJavis v0.6.1）——放歌进守护态零误触发、点球 PTT 唤醒、duck、追问窗口、双计费模式（默认省钱）全闭环。以下按优先级排。

## P0 — 核心地基（决定"是不是智能音箱级体验"）

> ⚠️ 2026-07-05 复审后，P0 执行以 **`DESIGN-coexistence.md` §8**（v3 复审章节）为准：含 2 个路线修正（voice-agent 先做 AEC 实测可能免 KWS / MyJavis KWS 走 Tauri Rust 原生优先）+ 修正后 5 步执行序。D1 拍板=C（计费开关默认省钱）、D2 拍板=是（中间态先上）。

- [x] **步1 AEC 实测** ✅ 2026-07-06 真机完成，**判定=免 KWS**（54s 纯音乐外放灌麦零误触发/混合段转写逐字正确/音乐中"停止播放"识别执行全通）——浏览器 WebRTC AEC 覆盖 LiveKit 音乐 track 的架构红利实锤，voice-agent 天然全双工
- [x] **步2 MyJavis mute+duck 闭环** ✅ 2026-07-05 完成（MyJavis v0.6.0 `2c58d68` 实现 + v0.6.1 `2489c3d` 修致命回归后 preview 连生产全链路验证：播放 166s 不断/守护停任务/点球唤醒同房重启 voiceprints=2/8s 追问窗口自动回守护）。**遗留验证点：川哥真机最终体感**（cc 无法模拟真实麦克风+扬声器环境）
- [x] **步3 MyJavis 接 KWS** ✅ 2026-07-06 上线(v0.9.0 `3767d8b` release-app.sh 发版):sherpa-onnx 官方 Rust crate(社区 sherpa-rs 已弃用)+cpal;三唤醒词音素逐 token 对 tokens.txt 验证;仅 guarded 态惰性运行(免 TTS 自触发);wav 直喂 5/5 PASS+mic 冒烟+clippy 零告警;回滚 tag rollback-pre-kws。**遗留验证点:川哥真机声学链路**(双进程采麦/外放中喊唤醒词命中率)
- [x] ~~**步4 voice-agent KWS/门控**~~ ✅ 免做（步1判定 AEC 干净，voice-agent 无需唤醒词/守护态；"bot 说话时 duck 音乐 track"降级为 P1 可选优化）
- [ ] **步5 状态机收敛**（§4 接口抽象，共享规则测试用例）——voice-agent 侧已大幅简化，仅 MyJavis 需完整三态
- ~~[ ] 服务端唤醒词门控（更轻的 MVP 前置）~~ **已否决**（§8.1 问题3：文本门控挡不住信令层 VAD/打断被音乐搅乱，且 mute 后无存在意义——假台阶）

### 步2 上线后观察项（真机使用中留意，出现即修）
- [ ] 省钱模式重启任务后对话 history 丢失的体感（固有代价，若不可接受 → `.env` 改 `MUSIC_GUARD_MODE=respond` 重启 server 即切响应模式）
- [ ] 追问窗口 8s（`FOLLOWUP_WINDOW_MS`）长短体感；唤醒后 ~2s 才能说话（save 模式）是否可接受
- [ ] 点球唤醒后若 resume-agent 失败的重试体验（现=回守护态可重点）

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
