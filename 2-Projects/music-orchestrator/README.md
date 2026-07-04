# music-orchestrator

MyJavis + realtime-voice-agent 共用的音乐播放能力（个人自用，不商用）。独立 FastAPI 服务，部署在 HK ECS 47.239.204.68（与两个消费方同机），三源（bilibili/YouTube Music/网易云）搜索解析 + 流代理 + 缓存，暴露 5 个语音场景高层 Tool + admin 维护 API。

**当前状态**：设计定稿，Team 模式并行实现中（见 DESIGN.md）。

详见 [DESIGN.md](./DESIGN.md)。
