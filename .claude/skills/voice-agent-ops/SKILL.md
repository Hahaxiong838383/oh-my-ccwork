---
name: voice-agent-ops
description: realtime-voice-agent(自建 LiveKit cascade 中文语音)部署 + 排障 SOP。触发词:"/voice-ops"、"voice 部署"、"voice-agent 排障"、"voice-hk 连不上/无声/没反应"、"语音 agent 无声"、"部署 voice worker"。涵盖:HK ECS 部署链(rsync editable+systemd)、排障决策树(通话中无声/重连无反应/局部无声/5G 直连不通)、rtc_probe 验收姿势、延迟分解四锚点、TURN relay、承接音与 bench 工具。
---

# voice-agent-ops — 部署与排障 SOP

项目:`~/mycc/2-Projects/realtime-voice-agent/`(mycc 仓内)。
生产:阿里云 HK ECS `47.239.204.68`(2核2G,专用),`https://voice-hk.hahaxiong.cc/voice-test.html`。
备用一套在 dev198(公司内网经 frp,改动未必同步,同步前先 diff)。
深层原理与血泪坑 → 记忆 `rg <关键词> ~/.claude/projects/-Users-rayman-chen-mycc/memory/`:
`livekit_agent_rejoin_dead_room_5g`(重连/5G/生命周期)、`livekit_cascade_first_audio_latency_traps`(开口延迟四坑)、`voice_filler_semantic_bucket_pattern`(承接句范式)、`project_realtime_voice_agent`(全史)。

**查文档 vs 读源码(分工纪律)**:
- "API 怎么用/有什么配置/怎么迁移/新能力(电话/视觉/RAG)" → 官方文档,入口
  `https://docs.livekit.io/llms.txt`(AI 友好全索引,WebFetch 定位子页再细读)。
  ⚠️ v2.0 迁移预警:`preemptive_generation/min_endpointing_delay/turn_detection` 等
  AgentSession 参数将改 `turn_handling=TurnHandlingOptions(...)`,升级前必查文档。
- "实际行为为什么这样/默认值是什么/坑在哪" → **读本地 venv 源码**
  (`.venv/lib/python3.12/site-packages/livekit/agents/`)——文档不写
  min_sentence_len=20 攒字、load_threshold 0.7、dispatch 只在房间创建时这类坑,
  本项目的关键修复全部源自源码级确认,别只信文档。

## 架构一图流

```
手机/浏览器 ──wss 443(nginx)──► livekit-server:7880(信令)
        ├──媒体 UDP 7882 / TCP 7881(直连,node_ip=公网IP)
        └──TURN 中继 TLS 5349 / UDP 3478(跨境 5G 兜底,页面自动降级)
livekit-server ◄─localhost─► voice-worker(systemd,/root/voice-venv)
worker 内:silero VAD(setup_fnc 预载)+ v1-mini 判停 + 火山 seedasr2.0 STT
         + DeepSeek v4-flash(FastLLM 关思考+预热)+ 火山 TTS(emo_v2)
         + S1v3 静音投机 + 语义承接音 + StreamAdapter min_sentence_len=6
         + 声纹旁路(CAM++ 26MB,setup 后台线程延迟4s预载;turn 后异步比对
           → 粘滞身份注入 LLM 近因位;assets/speakers/registry.json 每 job 加载)
```

## 部署 SOP(HK)

```bash
# 1. 本地三门(必过再部署)
cd ~/mycc/2-Projects/realtime-voice-agent
.venv/bin/ruff check src tests && .venv/bin/mypy src && .venv/bin/pytest -q

# 2. rsync(HK 是 editable 装,src 落地即生效;venv 在 /root/voice-venv 非项目内)
rsync -a --exclude '__pycache__' src scripts root@47.239.204.68:/root/realtime-voice-agent/

# 3. 重启 + 确认(livekit-server 只在改 /etc/livekit/config.yaml 时才重启)
ssh root@47.239.204.68 'systemctl restart voice-worker && sleep 6 && systemctl is-active voice-worker'

# 4. 端到端验收(ECS 上跑;probe.wav=真人问句)
ssh root@47.239.204.68 'cd /root/realtime-voice-agent && timeout 50 \
  /root/voice-venv/bin/python scripts/rtc_probe.py --wav probe.wav --room t$(date +%s) --listen 7'
# 期望:eou ~550-700 / "★ 端到端首声"(probe 口径含 ~1s 伪影,真实≈值-1s)/ llm / tts metric 全有
```

- 改承接音文案:改 `scripts/gen_fillers.py` FILLERS → ECS 上跑 `gen_fillers.py` → restart;**换 TTS 音色必须重跑**。
- 改测试页:`/var/www/voice/voice-test.html`(nginx 静态,改完让用户硬刷新);仓内 `web/voice-test.html` 是 dev198 版,逻辑同步、URL/token 不同。
- ⚠️ macOS 本机没有 `timeout` 命令,长命令别加(静默 command not found 会被管道吞掉误判"无输出")。

## 排障决策树(按症状)

**先跑通用三查**:`systemctl is-active livekit-server voice-worker`;`free -m`(1.6G 小机);
`journalctl -u voice-worker --since "15 minutes ago" | grep -E "job request|panic|ERROR"`。

### 症状:页面"通话中"但无声、无字幕、指标全"-"
按**信令/上行/下行**三层切分(别被"通话中"骗,它只代表信令):
1. worker 日志有无该 room 的 `received job request`?
   - **无** → 房间问题:agent dispatch 只在 room 创建时发生。查 server 日志 `not dispatching`(worker 拒接,看 load/进程池)或旧房未删。现行代码 `delete_room_on_close=True` 断开秒级删房,若复发查该配置是否在。
   - **有** → 看有无 `UserSpeechStarted`(上行通)+ `AgentSpeechStarted`(agent 说了)。
2. agent 说了但用户听不到 + 指标"-" = **下行断** → 十有八九是网络路径(见 5G 症状)。
3. 用户说了没转写(无 UserTranscript)→ ASR 流问题,grep `火山 ASR 流异常`。

### 症状:开代理能通、直连不通(或中途断声)
= **大陆→境外跨境 UDP 被运营商 QoS 掐**(server 日志 `short ice connection`)。这是网络路径问题,服务端无责。
- 页面已内置自动降级:直连失败/Reconnecting → 自动切 TURN 中继并 localStorage 记住;`?relay=1` 强制中转,`?relay=0` 恢复直连。
- 验证 TURN 链路:本机 `LIVEKIT_URL='wss://voice-hk.hahaxiong.cc' LIVEKIT_API_KEY=voicekey LIVEKIT_API_SECRET=<config.yaml> .venv/bin/python scripts/rtc_probe.py --wav /tmp/probe.wav --room r$(date +%s) --relay --listen 6`(NO_PROXY='*')。
- TURN 依赖:config.yaml turn 段(证书=certbot)+ 安全组 5349/tcp+3478/udp(cc 改安全组会被 harness 拦,给命令川哥跑)。

### 症状:某句回复局部无声 / TTS 报 "no audio frames were pushed"
= 切句器把孤立标点(如 LLM 输出的右引号 `”`)切成独立段,火山 0 帧报错且可能把 TTS 流水线打进异常态。已修(`volc_tts.has_speakable` 静音短路);若变体复发,检查该函数是否覆盖新 case。

### 症状:AI 把 (笑)(叹气) 念出来
prompt 层已禁(config.py instructions)+ TTS 入口 `strip_stage_directions` 兜底(括号/星号 ≤12 字 + emoji)。新形态标注 → 扩 `_STAGE_RE`。

### 症状:worker restart 后第一个连接必失败(FFI panic)
= 2 核机 job 进程内 onnx 冷加载阻塞 event loop。已修(`AgentServer(setup_fnc=...)` 预载 silero 存 proc.userdata);复发查 setup_fnc 是否还在。

### 症状:LLM 慢/晚高峰抖(赛马组件,2026-07-03 上线)
双路赛马:DeepSeek 主 + MiniMax-M2.7-highspeed 兜底(`LLM_FALLBACK_*` 三 env)。
- 看胜负:`journalctl -u voice-worker | grep "race won by"`——健康时 main ~600-660ms;
  **fallback 频繁胜 = DeepSeek 在抖**(兜底可开口 ~2.1s,正常现象非故障)。
- 兜底回复念出思考过程 → ThinkStripper 回归,查 `LLM_FALLBACK_STRIP_THINK`(默认 1)。
- 关赛马回单路:删 .env 三行 LLM_FALLBACK_* 重启。

### 症状:TTS 回复段变慢/句间卡(连接池组件,2026-07-03 上线)
连接池复用(`_volc_tts_pool`):回复段 ttfb 基线 ~470-520(池前 694-820)。
- `grep "tts pool"` 日志:`prewarmed`/`connection ready` 正常;`tts pool 路径失败`
  频繁 = 池降级中(每句多付建连税但可用),查火山侧/网络。
- 复用铁律:session 必须收到 SessionFinished 才回池;barge-in 取消的连接直接丢弃。
- 一键关:`TTS_POOL_ENABLED=0` 重启(回一次性连接,慢但稳)。

### 症状:声纹不识别 / AI 不认人(声纹组件,2026-07-03 上线)
分层切:`journalctl -u voice-worker | grep "speaker id"`。
1. 无"旁路启用"日志 → env `SPEAKER_ID_ENABLED=1`?模型/注册库文件在?setup 阶段
   stderr 有无 `[speaker_id] setup: extractor 后台预载完成`(延迟 4s 错峰;job 撞上
   未就绪窗=该 job 旁路禁用下个恢复,正常)。
2. 有识别但 UNKNOWN、score 低(<0.4):**九成是注册信道不一致**——注册必须用
   **通话信道内音频**(浏览器 NS/AGC+opus+RTC 频谱改动大;录音 app 注册实测只有 0.07)。
   重注册:.env 开 `SPEAKER_ID_DUMP_DIR=/root/voiceprint-calib` → 真机说 4-6 句(长句为主)
   → `enroll_speaker.py --name 川哥 /root/voiceprint-calib/turn-*.wav`(同名 upsert 换纹)
   → **无需 restart**(registry 每 job 加载)。基线:同人 0.54-0.68 / 非同人 <0.28 / 阈值 0.50。
3. 声纹命中但 AI 说不认识 → grep `llm ctx note 注入`(P2 粘滞身份注入 FastLLM 近因位;
   **首句建立身份第二句生效**,首句问"我是谁"答不知道是设计内)。
4. 🔴 铁律:job 内绝不同步加载 onnx(阻塞 event loop→FFI panic);<1s 短句 skip 是设计内;
   声纹 Score=概率非强认证,绝不当记忆主键(记忆 voice_mem_traps 六陷阱)。

### 症状:整机卡死(ping 通 / ssh 死 / nginx 无响应)
= 2核小机被连发压测打进 job 残骸雪球(inference 排队 40s+ → thrash),2026-07-03 实锤。
- 修复:阿里云控制台**强制停止**再启动(实例 i-j6cbb5uj10lp67k1xak0,hk-personal 账号);
  卡死系统对优雅重启无响应,Stopping 会挂几分钟等强杀。
- 服务自启已 enable(livekit-server/voice-worker,2026-07-03 补——之前从未重启过没暴露)。
- 🔴 预防:**HK 上禁止连发 probe(≥30s 间隔,或 probe 客户端挪本机跑)**。
- 遗留(已立案):job 分配瞬间补位进程 bootstrap 与 FFI 握手抢核,~25% 首连失败(对照
  实验证明与声纹无关的存量;nice 降级钩子已部署缓解),用户侧=偶发无响应重试即好。

### 症状:响应变慢
拉 worker 日志四锚点分解(**别信单一 metric,probe 端到端数字含 ~1s 伪影**):
`S1v3 preflight emitted`(silence=X 反推停说时刻)→ `UserTurnCommitted` → `tts: connecting`(首句 flush 完成)→ `AgentSpeechStarted`。
基线(2026-07-02):判停 550-700 / commit→tts connect ~950(ttft 750 投机抵 150-270 + 首句 flush ~200)/ TTS 694-820 / 真实端到端 ~2.5s,开承接音感知 <1s。
- 判停恶化 → VOLC_ASR_END_WINDOW_MS(200)/MIN_ENDPOINTING_DELAY(0.65,**不可 <0.55** 否则火山 FINAL 迟到丢尾字);MAX(0.90)−MIN=v1-mini 语义决策窗 250ms(判"没说完"多扛/误判慢最坏 +250ms;2026-07-03 川哥"长句被打断"定稿,13.6s 长句实测完整)。
- LLM 段恶化 → `scripts/llm_ttft_bench.py --only deepseek`(测"首个非空 content"+tps,首字节空 role chunk 会骗人)。
- 首句 flush 恶化 → TTS_MIN_SENTENCE_LEN(6;调大攒字变慢,过小句间断音:首段播放时长须 > 下段 TTS 建连 ~700ms)。

## 关键 env(HK /root/realtime-voice-agent/.env)

| 组 | 变量(默认) | 说明 |
|---|---|---|
| 投机 | VOLC_PREFLIGHT_ENABLED(1)/ _SILENCE_MS(180)/ _TEXT_QUIET_MS(150)/ _SILENCE_AMP(250) | S1v3 静音触发 |
| 判停 | VOLC_ASR_END_WINDOW_MS(200)、MIN/MAX_ENDPOINTING_DELAY(0.65/0.90) | min≥0.55 防丢尾字;max−min=语义决策窗 |
| 声纹 | SPEAKER_ID_ENABLED(1)/ _THRESHOLD(0.50)/ _MODEL/_REGISTRY(默认 assets 下)/ _DUMP_DIR(标定期开) | 注册必须信道内音频 |
| 承接音 | FILLER_ENABLED(1)/ FILLER_PROBABILITY(0.9)/ FILLER_DIR、IDLE 无 | 资产 assets/fillers+manifest |
| TTS | VOLC_TTS_SPEAKER/RESOURCE_ID/SPEED、TTS_MIN_SENTENCE_LEN(6) | 换音色重跑 gen_fillers |
| worker | WORKER_LOAD_THRESHOLD(0.95) | 2 核机默认 0.7 会拒接 |

## 铁律与边界

- 火山 RTC 只是 benchmark,**绝不切回**(项目目的=摆脱它);火山 ASR/TTS/方舟是独立组件可用。
- agent 生命周期**宁可简单重建,不要状态复用**(close_on_disconnect 留守方案已被实战推翻)。
- cc 改安全组/开公网端口会被 harness 拦 → 给现成命令川哥自己跑。
- 部署自验必须 rtc_probe 真跑(editable 装才 rsync 即生效;曾栽过 site-packages 旧副本)。
