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

### 症状:通话中偶发卡顿(非无声,能对话但一顿一顿)——内存 thrash(2026-07-04 根治)
真根因=**内存不足磁盘 thrash,不是 CPU**(易误判!先猜 CPU 被 vmstat 打脸)。诊断铁律=
`vmstat 2` 看**三维**:CPU `id`(通话时若 87-96% 空闲=算力没问题)/ 内存 `cache`(被挤爆
从 285→109MB=内存压力)/ IO `wa`+`bi`(wa 飙 91%、bi 暴增 16万块/s=正在 thrash)。
- 元凶:LiveKit prod 默认 `num_idle_processes=min(⌈CPU核数⌉,4)`=2,加活跃通话=3-4 个
  forkserver 子进程各 350-440MB(silero VAD+声纹+av+v1-mini+openai 预载),打爆 2G;无 swap
  → page cache 回收 → 进程页/模型 mmap 从磁盘疯狂重读 → 整机 IO 卡死几秒。
- 修:①`WORKER_NUM_IDLE=1`(app.py num_idle_processes,单用户专机够用,省 ~400MB)②2G swap
  兜底(`fallocate -l 2G /swapfile`+chmod 600+mkswap+swapon+写 fstab 持久化)。
- 验证:活跃通话 `free -m` available 稳 400MB+/`vmstat` wa 0-1%/swap 未动用。`ps -eo rss,args|
  grep "forkserver import main"` 看大进程数(空闲应 ≤2,活跃 ≤3)。

### 症状:改了前端(voice-test.html)手机不生效
= 手机 Chrome 缓存旧版 HTML(nginx `location=/voice-test.html` 若无 cache 头→启发式缓存)。
已根治:nginx 加 `add_header Cache-Control "no-cache, must-revalidate"`(改前端立即生效+304 省流量),
公网 `curl -sI` 应见该头。临时验证可让川哥飞行模式重连(强制重新拉取)。

### 症状:点开始对话"通话中"但无声(FFI panic 首连失败)——已根治(2026-07-04)
真根因(py-spy 栈实锤,**不是**补位进程抢核——那是同秒出现的旁观者,initialize 仅 84ms):
job 进程的 LLM prewarm 协程首次访问 `client.chat` 触发 **openai 惰性 import(pydantic
建模 1s+ 持 GIL)**,恰落在 ctx.connect 的 FFI ReadyForRoomEventRequest 1s deadline
(rust 写死)窗内 → event loop 饿死 → panic 秒崩 → 房里没 agent。空闲机器也 ~25% 中招。
- 终解三件套:`_openai_preload` 模块注册为 Plugin(forkserver preload 一次付清,子进程
  COW 继承)+ setup_process 兜底 import(macOS/spawn 开发环境)+ LLM/TTS prewarm 全部
  挪到 `start_livekit_job` **之后**(纵深防御:任何持 GIL 的活不落 deadline 窗)。
- 验收:10 轮 20s 间隔 0 panic(基线 25%)。复发排查:①journal 有无
  `preloading plugins ... _openai_preload`(forkserver 生效)②新增的 create_task 是否
  又放回了 connect 之前 ③py-spy dump job 进程看谁持 GIL。
- 配套:WORKER_RESPAWN_NICE(10,兜底)/WORKER_INIT_TIMEOUT(30s,防 nice 拖过默认
  10s 被杀进 spawn 循环)。

### 症状:吃首字——用户字幕缺第一个字 / AI 第一个字没念(2026-07-04 双根因修复)
证据先行(两条 INFO 日志已常驻,直接对照,不用猜层位):
`journalctl -u voice-worker | grep -E "stt final|tts synth"`
- **用户侧(ASR)**:`stt final` 完整而字幕缺 → 前端/转发问题;`stt final` 就缺 → 上行音频或火山识别。已修根因=**LiveKit AEC warmup**(agent_activity.push_audio 源码实证):首次 agent 说话起 one-shot 3s 内,agent 说话期间喂 STT 的用户音频被替换成**纯静音**(VAD 收真帧所以能打断,但说的字 ASR 收不到)——greeting 没播完就抢话必中招,抢话点越早丢得越多。修=AEC_WARMUP_DURATION 3.0→0.5(浏览器 AEC 收敛 <300ms,0.5 够保护回声误识别)。若复发:重开 SPEAKER_ID_DUMP_DIR 听 pump 侧音频分层(有声无字=火山层;无声=上行/浏览器 NS/AGC 层)。
- **AI 侧(TTS)**:`tts synth` 与字幕对照——synth 里没那个字=上游剥除(by design),有=合成/播放层。已修根因=旧 R2 在 volc_tts **句级**剥句首承接词("嗯,/好的,"),只改音频不改字幕,字幕比音频多字,川哥对照字幕以为 TTS 丢字。修=剥除挪到 fast_llm.LeadingFillerStripper(LLM 输出流,只剥回复最开头,首字快筛零延迟),TTS/字幕/对话历史三者一致;volc_tts 不再句级剥。开关 LLM_STRIP_LEADING_FILLER 跟随 FILLER_ENABLED(承接音关则正文语气词保留)。

### 症状:响应变慢
拉 worker 日志四锚点分解(**别信单一 metric,probe 端到端数字含 ~1s 伪影**):
`S1v3 preflight emitted`(silence=X 反推停说时刻)→ `UserTurnCommitted` → `tts: connecting`(首句 flush 完成)→ `AgentSpeechStarted`。
基线(2026-07-02):判停 550-700 / commit→tts connect ~950(ttft 750 投机抵 150-270 + 首句 flush ~200)/ TTS 694-820 / 真实端到端 ~2.5s,开承接音感知 <1s。
- 判停恶化 → VOLC_ASR_END_WINDOW_MS(200)/MIN_ENDPOINTING_DELAY(0.65,**不可 <0.55** 否则火山 FINAL 迟到丢尾字);MAX(1.30)−MIN=v1-mini 语义决策窗 650ms(判"没说完"多扛/误判慢最坏 +650ms;0.90 时川哥两报"长句被打断",2026-07-04 加到 1.30——只影响判"没说完"的等待,判"说完"仍走 MIN 快路)。
- LLM 段恶化 → `scripts/llm_ttft_bench.py --only deepseek`(测"首个非空 content"+tps,首字节空 role chunk 会骗人)。
- **POC 预测式判停全家桶(2026-07-29,主 worker)**:配置=/root/realtime-voice-agent/poc-eou.env(主 unit 第二 EnvironmentFile,勿写共享 .env——会穿透租户 worker)。在线组合:阈值 0.18+MIN 0.40/MAX 0.8+POC_INTERIM_COMMIT=1(B5 伪 final,判停 401ms)+END_WINDOW 150+MIN_INTERRUPTION_WORDS=0(插话瞬停)+FALSE_INTERRUPTION_TIMEOUT=0.7+POC_RESUME_FADE_MS=250(恢复渐起)。遥测=grep 'poc eou telemetry|interim-commit'(概率/delay/mismatch/truncation);回滚=删 poc-eou.env+restart(快照 rollback-poc-eou/-b5-interim-0729.tar.gz)。⚠️ 三坑:MIN<定 final 到达=late-final **静默旁路**(遥测零输出+eou_ms≈stt_ms 即此症);B5/END_WINDOW 是 **volc 专属**(讯飞线无伪 final 机制,MIN 按其 final 时序另算);fade 挂载必须 session.start 之后(output 由 RoomIO 组装,早挂静默跳过——所有开关必须有"生效证据日志")。
- 首句 flush 恶化 → TTS_MIN_SENTENCE_LEN(6;调大攒字变慢,过小句间断音:首段播放时长须 > 下段 TTS 建连 ~700ms)。

## 关键 env(HK /root/realtime-voice-agent/.env)

| 组 | 变量(默认) | 说明 |
|---|---|---|
| 投机 | VOLC_PREFLIGHT_ENABLED(1)/ _SILENCE_MS(180)/ _TEXT_QUIET_MS(150)/ _SILENCE_AMP(250) | S1v3 静音触发 |
| 判停 | VOLC_ASR_END_WINDOW_MS(200)、MIN/MAX_ENDPOINTING_DELAY(0.65/1.30) | min≥0.55 防丢尾字;max−min=语义决策窗 |
| 吃字防护 | AEC_WARMUP_DURATION(0.5)、LLM_STRIP_LEADING_FILLER(跟随 FILLER_ENABLED) | 见"吃首字"排障段 |
| 声纹 | SPEAKER_ID_ENABLED(1)/ _THRESHOLD(0.50)/ _MODEL/_REGISTRY(默认 assets 下)/ _DUMP_DIR(标定期开) | 注册必须信道内音频 |
| 承接音 | FILLER_ENABLED(1)/ FILLER_PROBABILITY(0.9)/ FILLER_DIR、IDLE 无 | 资产 assets/fillers+manifest |
| TTS | VOLC_TTS_SPEAKER/RESOURCE_ID/SPEED、TTS_MIN_SENTENCE_LEN(6) | 换音色重跑 gen_fillers |
| worker | WORKER_LOAD_THRESHOLD(0.95)、WORKER_NUM_IDLE(1) | 2 核机默认 0.7 拒接;idle 默认 2 撑爆 2G→thrash,单用户压 1 |
| 内存 | HK 已配 2G swap(fstab 持久化) | 兜底瞬时尖峰,正常不动用 |

## 铁律与边界

- 火山 RTC 只是 benchmark,**绝不切回**(项目目的=摆脱它);火山 ASR/TTS/方舟是独立组件可用。
- agent 生命周期**宁可简单重建,不要状态复用**(close_on_disconnect 留守方案已被实战推翻)。
- cc 改安全组/开公网端口会被 harness 拦 → 给现成命令川哥自己跑。
- 部署自验必须 rtc_probe 真跑(editable 装才 rsync 即生效;曾栽过 site-packages 旧副本)。
- **git 归属(2026-07-04 川哥拍板定稿)**:随 mycc 仓隐私剥离曾短暂出仓,当日川哥拍板**回归 oh-my-ccwork 仓 `2-Projects/` 正常管理**(1c2c14462 快照入仓;旧历史已被 filter-repo 洗净,从快照重新开始)。"部署过的代码立即 commit"落 mycc 仓即可;`.gitignore`/`.git/info/exclude` 的剥离清单里**不再有本项目**(其余 4 个剥离项目不受影响)。

## 租户 worker(BYOK 服务化,2026-07-28 起)

**64.90 三服务**:`voice-console`(FastAPI 127.0.0.1:8930,对外 https://voice-api.hahaxiong.cc 经 caddy)/`caddy`(自动证书)/`voice-worker-colleague`(租户实例)。主 worker 与它们互不依赖,全撤=`systemctl disable --now` 三件。

**租户配置真源**:`/root/realtime-voice-agent/tenant-colleague.env`——unit 的**最后一个 EnvironmentFile**。⚠️ **systemd EnvironmentFile 覆盖 Environment=**,差异配置绝不写 unit Environment 行(2026-07-28 实战:写了=服务 active 但 provider 根本没切)。当前(2026-07-29 拉齐终态,回滚=tenant-colleague.env.bak-0729+restart):STT_PROVIDER=**xfyun_spark_iat**、TTS_PROVIDER=xfyun、LLM_PROVIDER=tenant-brain、打断体验包=POC_PREDICTIVE_EOU=1+POC_EOU_UNLIKELY_THRESHOLD=0.18+MIN/MAX_ENDPOINTING_DELAY=**0.8/1.0**(spark_iat 判停由 eos=700 主导,MIN 按其 final 时序配;⚠️ B5/END_WINDOW=volc 专属勿带)+**MIN_INTERRUPTION_WORDS=1**(2026-08-04 改,原 0;租户线独有,主 worker 仍 0——同事嘈杂 demo 场景,回滚=改回 0+restart 或 tenant-colleague.env.bak-0804-wordgate)+FALSE_INTERRUPTION_TIMEOUT=0.7+POC_RESUME_FADE_MS=250、**MUSIC_ORCHESTRATOR_URL=/KEY= 置空**(2026-08-04,租户 demo 不需点歌;共享 .env 有值,靠租户文件后者胜覆盖——**绝不要去改 .env**,那会穿透主 worker;回滚=tenant-colleague.env.bak-0804-music。⚠️ 省的是传输解析**不是模型 prefill**:同事端点本就不把 tools 转发给模型,首字延迟零收益;真实收益是**解锁 fast_llm 双路竞速**——有 tools 时 race 被跳过,见 fast_llm.py:377)、WORKER_MAX_JOBS=2、WORKER_HTTP_PORT=8082(错开主 8081)、FILLER_DIR=/opt/voice-agent/fillers-colleague(聆小璇音色,租户专属,勿混主 assets/fillers)、GREETING_MODE=llm(开场白走租户大脑;指令走 user 消息位——instructions=system-only 被 DashScope 20015 拒;GREETING_LLM_HINT 换文案,删行=回固定句)。内存护栏 drop-in:`voice-worker-colleague.service.d/memory.conf`(High 1600M/Max 2000M)。

**常用操作**:开租户=`source console.env && python -m voice_agent.console.tenantctl add <名>`(key 只显示一次);凭据状态=`GET /v1/credentials`(Bearer 租户key,只回指纹);换 filler 音色=`gen_fillers.py --engine xfyun --out <独立目录>`(64.90 上跑,凭据走租户存储不出服务器)+FILLER_DIR 指过去。

**排障口径**:
- **agent 不进房间**(用户侧一切正常、无 participantConnected)→ 先查 worker 满载:`journalctl grep "full capacity"` + 最近 job 的 `rss` 打点是否还在打(悬挂会话占名额)。2026-07-28 实锤:cc 自己 E2E 没关页签占死 MAX_JOBS=1 一小时。**E2E 纪律:验完必 `session.close()` + 关页签,日志见 "process exiting" 才算退干净**。
- **对话里出现第二个音色** → `journalctl grep "filler picked"`:承接音是预缓存 wav 直接播帧,**不经 TTS 引擎,切 provider 管不住它**——换 TTS 引擎 checklist 必含"预缓存音频资产盘点"(filler/greeting/提示音)。
- **租户后台"记忆读不到/用户全是同一人"** → 查两层:①job 日志 `tenant-brain user identity: <值>`——值是"user"=前端没传 participantName(SDK 缺省值,激活码必须每次带);②该值经 OpenAI 标准 user 字段进租户端点每个请求(per-request extra_body 注入——池级 header 会串用户,禁改)。
- **切链路验证** → 唯一凭据=job 真实路径日志(`grep -E "xfyun|volc"`,目标引擎成功路径静默、旧引擎必留痕);unit grep+active+registered 全是假象。
- **讯飞碎句(已解)** → 换对话线 provider `xfyun_spark_iat`(中文识别大模型):eos 静音断句(XFYUN_IAT_EOS_MS 默认700,600-800 可调)+dwa=wpgs 中间结果(字数门生命线)+回合制会话(幅度门控/预滚400ms/50s收尾)。切换=租户写 xfyun_spark_iat 凭据(app_id/api_key/api_secret,与超拟人 TTS 同套)→ tenant env STT_PROVIDER=xfyun_spark_iat + restart。旧 xfyun(转写线,accessKey 鉴权)保留兼容。碎句复发排障:job 日志 stt final 密度+调大 EOS_MS。
- **"你们 TLS 握手 800ms+"类外部指控** → 先自己同城测点复现:`curl --noproxy '*' -w 'tcp=%{time_connect} tls=%{time_appconnect}'`;不复现(净值 ~35ms)=第一嫌疑**对方测量机代理**(特征:TCP 极快+TLS 极慢+复用省大头+.cn 对照组正常),交棒复测清单勿改自己服务端。测 resumption 用 `sleep 1 | openssl s_client -sess_out`(echo 管道在 ticket 到达前退出=假阴性)。

**在途需求(2026-07-29 接单,同事需求文档回复见飞书 wiki `MGR4wOvy9i600OkAAEncWZcQnre` §七)**:①SDK `JavisVoice.prewarm()`(纯网络层预热,不建会话)②`POST /v1/tts` TTS-only(Bearer 租户 key→流式 mp3+固定台词文本缓存)③说完即挂=文本哨兵 `[[END_SESSION]]`(待同事确认;agent 流内剥离→播完→关房)④voice-hk nginx 加固(http2+掐 TLSv1.0/1.1,待川哥批)。

## 入房提速与打断门控(2026-07-31,B8/B9)

**入房分段遥测**:`journalctl grep "join timing"` → `imports/ctx.connect/vad/sidecar/build_llm/session_start/wait_participant` 逐段 ms。基线(主 worker)=630ms(210/0/5/116/299)。⚠️ **wait_participant 大不是故障**——那是等用户进房(9~1570ms 全正常),已挪到 session.start 之后不再阻塞装配;真要排查看其余段。build_llm 明显 >150ms → 预 import 没生效(查 setup 日志有无 `[preimport]` 失败行)。

**B9 打断声纹门控**(仅主 worker,`poc-eou.env`):`BARGE_SPEAKER_GATE_MS=700`(0=关)+`BARGE_SPEAKER_GATE_ACT`(默认 0=**只观测不改行为**)+`BARGE_SPEAKER_MIN_SPEECH_S=0.8`。看数据:`journalctl grep "barge gate"` → `resume/act/reason/scores/speech/infer`。
- 转正流程:先跑观测,确认**主用户轮稳定 registered、他人/电视轮稳定 unregistered** 才置 ACT=1。跨信道注册会让 score 整体崩(实测 0.072),直接开动作=主用户插话全被否决,比不做更差。
- ⚠️ **绝不上租户 worker**:注册库里没有租户的用户,开了=所有打断被否决。租户 env 保持无 BARGE_* 即可(默认关)。
- 生效证据:job 日志 `barge speaker gate enabled: delay=700ms act=...`;缺这行=没挂上(声纹旁路未启用时会打 warning)。
**B9 租户红线(2026-07-31)**:⚠️ **永远不要给租户 worker 开 `BARGE_SPEAKER_*`**——声纹注册库只有本机主人的样本,租户用户从未注册,开了=**他们的用户说话被判"外人"→ 所有打断被否决**,比不做还差(负收益,不是效果差一点)。这类"依赖用户特有注册数据"的能力,验收也不能外包给对方,详见 [[feedback_acceptance_needs_owner_specific_data]]。要给租户上,前置交付物是**自助声纹注册流程**,不是打开开关。

**B8 回滚**:`bash 2-Projects/realtime-voice-agent/scripts/rollback-b8.sh`(revert 330d75ce1 + rsync + restart 两 worker,分钟级)。触发条件=开场白丢失/身份错乱/对话行为变化。更早的整体快照 `/root/rollback-batch2-0731.tar.gz`(含 B9 之前全部代码)只在要连 B9 一起退时用。
## 租户链路自主 E2E(2026-08-03,不再等同事真机)

**能力**:自产测试音频+probe 打租户 agent,5 分钟闭环复现租户线任何对话问题。
```bash
# 64.90 上:① 用租户凭据合成问句 wav(16k,零转码)——模板在 /tmp/mk_story_wav.py 思路:
#   build_tts_request(问句, sample_rate=16000, encoding raw) → wave 写 /tmp/q.wav
# ② probe 打租户 agent(PROBE_AGENT 环境变量,2026-08-03 加):
cd /root/realtime-voice-agent && set -a && . .env && set +a &&   PROBE_AGENT=javis-colleaguedem-5675d9 timeout 75 /root/voice-venv/bin/python   scripts/rtc_probe.py --wav /tmp/q.wav --room probe-$(date +%s) --warmup 8 --listen 40 --record /tmp/a.wav
```
注意:会真跑同事 /v1 一轮(花他少量 token,联调范畴);probe identity 会出现在他后台。
⚠️ **probe 会被 `WORKER_MAX_JOBS=2` 挡在门外**(2026-08-04 实战):同事在用时两个 slot 占满,worker 打 `at full capacity, marking as unavailable`,probe 侧只表现为"未录到 agent 音频"+**目标 room 在 worker 日志零命中**——像 dispatch 坏了,其实是排队排不上。跑前先 `journalctl grep "full capacity"` 或数活跃 room,别把容量问题当故障查。

**向协作方收集体验反馈的模板(2026-08-04)**:体验类调整(打断灵敏度/语速/音色)服务端指标只能证明"链路对",**好不好用只有对方知道**,但直接问"是不是变好了"= 把答案印在卷子上(见 [[feedback_acceptance_prompt_carried_the_answer]])。给对方的 prompt 只让记现象,四项:①大致时间点(我方据此对齐服务端日志)②当时环境里在响什么③agent 的表现(卡一下续播/彻底停/换话题)④**反向问题**——"我说话了它没停"(即本次调整的代价面,不主动问就系统性看不见,等对方忍不了才爆)。另附**先分流一个高频真凶**:外放测试时 agent 自己的声音被麦克风收回,产生的是**内容清晰的**打断,字数门拦不住——让对方外放/耳机各测几轮对比,耳机下好转=问题主成分是回声不是环境音,解决方向完全不同。⚠️ 对外文字**不出现架构与开源组件名**(只讲行为:"提高了打断的准入门槛"),回滚承诺要给("分钟级可退")。

**打断遥测(`interrupt telemetry`)判读法(2026-08-04,踩坑修正)**:该行记的是 **agent_state speaking→listening 的全部转换**,`正常播完` 和 `被打断` 混在一起,**`interim=''` 绝不等于"环境音打断"**(实测 3 天 122 条空 interim 里 104 条是正常播完)。正确判据:
- **正常播完** = 空 interim 且同 room ±1.5s 内有 `契约 AgentTranscriptFinal`
- **无字打断(环境音穿透)** = 空 interim 且附近**无** AgentTranscriptFinal
- **有字打断(真插话)** = interim 非空;紧跟同一 turn 的 `AgentSpeechStopped`+`AgentSpeechStarted` = 打断后恢复
统计脚本模板见 `~/mycc` scratchpad `gate_stats.py`/`gate_len.py`(判据自带锚点自检:改前窗口必须数出非零,否则判据本身坏了)。
⚠️ 写这类统计脚本**别用 `ssh host '...'` 内嵌 heredoc**:脚本里的字面单引号会被外层引号吃掉,判据静默失效并报出漂亮的 0(本轮连栽两次:先是正则 `$` 锚点匹配不上 JSON 行,再是引号被吞)。改用**本地写文件 + `cat file | ssh host 'cat > /tmp/x.py && python /tmp/x.py'`**。

**端到端延迟归因真值(2026-08-04 双向核实闭环,以后别重查)**:租户线用户说完→听到声约 2.9s,构成=**判停 ~0.8-1.4s + LLM 首字 ~860ms + TTS 首包 ~490ms**。
- **LLM 首字 99% 在模型本身**:我方网络 RTT 3.4ms(64.90↔对方端点同在香港阿里云网段)/TLS 86ms 仅首次;对方分段埋点自测=其网关处理 5.1ms、等上游模型 771.9ms;两边数字对得上(其 779ms vs 我方推算 860ms,差值=我方攒字)。**我方与对方网关都无空间,唯一杠杆是换模型**(其直连基准:Qwen3.5-397B 757ms / 35B 404ms 但有 3s 长尾 / deepseek-v4-flash 2735ms 疑含推理阶段未关)。
- ⚠️ **三个我曾误判的坑**:①"地板 19ms/中位 860ms=排队"**错**——是"不调模型的快路径(占位探针/开场白)"与真实轮次混在一个分位数里,**按请求类型分开统计**;②"第2轮起翻倍"**错**——我按会话内轮次分组而**第1轮就是开场白**(短 prompt),对方按历史长度分桶复现不出来;③"关 tools 省 prefill"**错**——见上。
- **判停截断有专用遥测**:`grep "truncation-suspect"`——语义=turn 提交后 **1.2s 内**用户又开口(tier_a_cascade.py:381-385),即判停切早了。基线 34/280=**12%**,gap 中位 352ms。川哥 2026-08-04 拍板**延迟优先、eos 不调大**,故这 12% 是已知并接受的代价,别再提调大 eos。

**「只说一句/内容缺失」诊断遥测**(常驻,2026-08-03):三行日志一次定层——
`journalctl grep "llm stream done"`(上游给了多少字)+`grep "xfyun tts synthesize"`(每句进合成的文本,数行数=句数)+录音有效时长。三层对齐=己方无罪(实战:上游只给 15 字,全部念完,责任面一次切清);llm chars 大而 tts 一段=切句层;tts 多段而听到一句=播放/打断层(配 interrupt telemetry interim 判)。
