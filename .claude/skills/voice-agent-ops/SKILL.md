---
name: voice-agent-ops
description: realtime-voice-agent(自建 LiveKit cascade 中文语音)部署 + 排障 SOP。触发词:"/voice-ops"、"voice 部署"、"voice-agent 排障"、"voice-hk 连不上/无声/没反应"、"语音 agent 无声"、"部署 voice worker"、"热词增减/改热词"、"说单个字没反应"、"没有字幕"、"rust 灰度线/voice-worker-rust"。涵盖:HK ECS 部署链(rsync editable+systemd)、排障决策树(通话中无声/重连无反应/局部无声/5G 直连不通/单字被上游丢弃)、rtc_probe 验收姿势(三通道:音频/字幕/metrics)、延迟分解四锚点、TURN relay、承接音与 bench 工具、热词增减 SOP、Rust 灰度线运维。
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
# ⚠️ 必须剥代理再跑:交互 shell 的 ALL_PROXY=socks5://... 会漏进 httpx,
#    9 条 mock HTTP 测试报 ImportError(socksio 未装)——纯环境污染,不是回归(2026-08-12 追过一次)
env -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy \
  .venv/bin/ruff check src tests && .venv/bin/mypy src && \
  env -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy \
  .venv/bin/pytest -q
# 注:ruff 的 lint 范围只有 src tests,scripts/ 不在门内(rtc_probe 有 3 处历史 E501,非新增)

# 2. rsync(HK 是 editable 装,src 落地即生效;venv 在 /root/voice-venv 非项目内)
rsync -a --exclude '__pycache__' src scripts root@47.239.204.68:/root/realtime-voice-agent/

# 3. 重启 + 确认(livekit-server 只在改 /etc/livekit/config.yaml 时才重启)
ssh root@47.239.204.68 'systemctl restart voice-worker && sleep 6 && systemctl is-active voice-worker'

# 4. 端到端验收(ECS 上跑;probe.wav=真人问句)
ssh root@47.239.204.68 'cd /root/realtime-voice-agent && timeout 50 \
  /root/voice-venv/bin/python scripts/rtc_probe.py --wav probe.wav --room t$(date +%s) --listen 7'
# 期望:eou ~550-700 / "★ 端到端首声"(probe 口径含 ~1s 伪影,真实≈值-1s)/ llm / tts metric 全有
#      + 字幕行 `[probe] 字幕[<identity>][final]:` 用户侧与 agent 侧各至少一条
```

- 改承接音文案:改 `scripts/gen_fillers.py` FILLERS → ECS 上跑 `gen_fillers.py` → restart;**换 TTS 音色必须重跑**。
- 改测试页:`/var/www/voice/voice-test.html`(nginx 静态,改完让用户硬刷新);仓内 `web/voice-test.html` 是 dev198 版,逻辑同步、URL/token 不同。
- ⚠️ macOS 本机没有 `timeout` 命令,长命令别加(静默 command not found 会被管道吞掉误判"无输出")。
- ⚠️ **验收是数「用户实际消费的输出通道」,不是数矩阵格子**(2026-08-12 教训):Rust 重写把字幕发布
  **整个漏了**,P3 验收 12 项照样全绿,川哥打开页面第一句就是"没有字幕"——因为老 probe 只订阅音频轨+
  metrics,**从没订阅 transcription 通道**,没订阅的东西不会变红、只会不存在。本项目对外通道共三条:
  **音频轨 / 字幕(legacy Transcription 包) / metrics**,交付前三条都要有探针见证(probe 已常驻监听
  `transcription_received`)。详见 [[feedback_probe_subscribes_only_known_channels]]。

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

### Phase 2a 设备感知观察模式(2026-08-20 上线,rust 线+device brain)
LLM 判断用户想调设备时在回复开头输出 `[[DEV:N]]`;worker `DevMarkStripper`(llm.rs)**无条件剥离**
(绝不进 TTS/字幕/历史),只打日志**不执行**(codex BLOCKED_PENDING_VAD_CANDIDATE_ID,2b 前置=
vad_candidate_id 关联合同)。
- **开关在 server 侧**:aliyun-hk `/opt/p003/server/.env.local` 的 `DEVICE_INTENT_OBSERVE=1`
  (协议层注入 device brain systemPrompt 第五层,仅 role=device);关=置 0+`pm2 restart p003-voice`,
  分钟级——**对话人设漂移是第一风险项,先关这个**。生效证据=运营台白盒第五层 chars>0。
- **观察数据**:`journalctl -u voice-worker-rust | grep 'llm device intent observed'`(label+known
  白名单校验);攒召回/误出手率/方向正确率给 2b 放开做依据。
- 话术铁律:协议要求 LLM 不承诺执行("我已经调好"禁说)——执行播报永远归 worker 固定短句。
- 若真机听到"DEV/括号"被念出=剥离器漏(格式变体),关开关+查 `dev_mark_strip_table` 测试补形态。

### 症状:僵尸房——端侧显示"连接中/通话中"但整轮零 ASR 零回应(常连房间模式专属)
= **信令 WS 活着但媒体死了**。分型看 worker 的 `media watchdog stats` 行(2026-08-19 上线,60s 一行):
- `lost=True`/frames 停增 = **传输死**(NAT 失效/网络切换/WebView 冻结)→ L1 自动处置:SFU 报 LOST 持续 `MEDIA_LOST_HANGUP_S`(默认 15s)→ worker 删房 → 端侧收标准 disconnected 自行重连。看 `media watchdog 删房` 行确认。
- frames 正常但 `peak≈0` 而端侧硬件 VAD 报在说话 = **采集死**(系统收走麦克风,WebRTC 只发静音,传输层全绿)→ 服务端无法检测,端侧「无 ASR 看门狗」处置(P003WebDemo 侧,联合修复文档 docs/ZOMBIE-ROOM-JOINT-FIX-20260819.md)。
- 生效证据=job 日志 `media watchdog armed: ... tap=True`;回滚 `MEDIA_WATCHDOG=0`+restart。代码 engines/media_watchdog.py。
- 关联机制:IDLE_HANGUP_TIMEOUT_S(空闲超时关房,仅 tenant-colleague.env 启用)管"活连接挂太久",watchdog 管"连接名存实亡",正交并存——**排障时两个删房源都可能是 disconnected 的来源**,按日志行区分(`idle hangup` vs `media watchdog 删房`)。

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

### 症状:说单个短词(停/好/对)AI 完全没反应(2026-08-12 定性:上游丢弃,不是本地 bug)
**先别查自己**:火山话语检测层对孤立超短音段**整段丢弃**——零 interim 零 definite,
本地 VAD/门控/判停全正常(它们确实正常),日志里与"用户压根没说话"完全同形,在自己这侧穷举到不了根因。
- **定性方法**:写直连 sauc WS 的脚本**绕过项目全部代码**跑对照矩阵,一次一个变量 + 一条已知能过的
  长句当锚样本同批跑(锚不过=装置坏了,不是结论)。旧脚本思路留在 64.90 `/tmp/volcmx`。
- **已试无效,别再试一遍**:`enable_ddc=0`(只影响标点)/`force_to_speech_time=10`(无效)/
  增益 ×2.5(不但没捞回还误识别成别的词)。
- **唯一有效杠杆=热词表**(见下面「热词增减 SOP」)。**但有声学硬底**:opus 往返模拟 RTC 损耗后,
  合成弱音"停"即使 `scale=2.0` 仍丢——热词只救得回信道良好+发音清晰的。
- **兜底方向(未做)**:话术层引导双音节("停一下/好的"存活率远高于单音节);仍不够则上本地 KWS 急停
  (sherpa,重活另立项)。详见 [[feedback_upstream_silent_drop_vs_no_input]]。

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

## 热词增减 SOP(2026-08-18 大修,取代 08-12 版)

**是什么**:火山 ASR 话语检测会整段丢弃孤立短指令(停/好/对——连 interim 都没有),热词让服务端对指定词降低检出门槛。矩阵实验定案:ddc/force_to_speech_time/增益全无效,唯热词有效;**语气词(嗯/啊)绝不入表**=环境音免疫天然保留。

**⚠️ 热词通道真相(2026-08-18 全链实证,详见记忆 p003_asr_nonstream)**:
- **唯一生效通道=直传 context**。控制台词表(boosting_table_id)在 bigmodel/bigmodel_async 两端点、一遍/二遍两模式下**全部零生效**(数据面不消费,待火山工单;64.90 env 里表 ID 已注释)。别再往火山控制台加词。
- 双向流式一遍链路热词总预算 **100 tokens** 从前向后截断;**二遍(enable_nonstream)链路升 5000 词**——rust 线已 per-SN 灰度二遍(canary 003+098),灰度键 `VOLC_ASR_NONSTREAM_ENABLED/_CANARY_SN`。
- 大模型热词=prompt 注入,**无权重概念**(`词|7` 无效),boost 随词数**稀释**(3 词能翻声母,20 词不能)——一遍链路只配核心短词,专名排最前。
- **声母级误转(调→跳/掉)热词救不动**,正解=Matcher 误转别名(device_aliases.tsv);**误转别名绝不进热词**(教 ASR 输出错字)。

**Rust 线增减入口(唯一正道)**:kidshub 后台「热词管理」tab 编辑→发布,或 admin API(`PUT /api/admin/hotwords/<kind>/draft` + `POST /api/admin/hotwords/publish`,Bearer admin token,凭据在 aliyun-hk `/opt/p003/server/.env.local`——**dotenv 值带引号,手工读要剥**)。发布链自动:apply_hotwords.py→env 原子写(自动备份)→**纪律重启(stop→EOT 清零→start,禁 restart)**→进程三方对撞→失败自动回滚。四 kinds:interrupt/asr/exit/device_asr;单表上限 500(hotword-store.ts)。**手工 sed env=造 DB↔env 漂移,禁止**。

**验证**:journal `asr: connected (... hotwords=N)` 的 N 对上(当前 267=27 打断+240 设备全量);真机说表内词看 `stt final`。

**入表原则**:高频短指令+专名才进;≥2 音节存活率天然高不一定需要;误识别拉偏→删词即回。**语气词/单字/误转别名禁入**。代码位:rust `stt_volc.rs`(VOLC_ASR_HOTWORDS+P003_DEVICE_ASR_HOTWORDS 汇流)/Python `volc_stt.build_hotwords_corpus`。Python 线仍走 poc-eou.env(发布链 receipt 的 poc_note:python 线不重启,自然重启生效)。

- 火山 RTC 只是 benchmark,**绝不切回**(项目目的=摆脱它);火山 ASR/TTS/方舟是独立组件可用。
- agent 生命周期**宁可简单重建,不要状态复用**(close_on_disconnect 留守方案已被实战推翻)。
- cc 改安全组/开公网端口会被 harness 拦 → 给现成命令川哥自己跑。
- 部署自验必须 rtc_probe 真跑(editable 装才 rsync 即生效;曾栽过 site-packages 旧副本)。
- **git 归属(2026-07-04 川哥拍板定稿)**:随 mycc 仓隐私剥离曾短暂出仓,当日川哥拍板**回归 oh-my-ccwork 仓 `2-Projects/` 正常管理**(1c2c14462 快照入仓;旧历史已被 filter-repo 洗净,从快照重新开始)。"部署过的代码立即 commit"落 mycc 仓即可;`.gitignore`/`.git/info/exclude` 的剥离清单里**不再有本项目**(其余 4 个剥离项目不受影响)。

### 症状:Rust 线判停变钝 + 声纹全失效(EOT sidecar 死了且**永不重连**,2026-08-14 实证)

- **判据**:`journalctl -u voice-worker-rust | grep -E "speaker embed 通道不可用|EOT sidecar 不可用"`;
  `ss -xlp | grep rust-worker-eot.sock` **无监听者**即已死(socket 文件还在,是残留,不代表活着)。
- **机理**:`eot.rs` 的 `GLOBAL.get_or_init` 是**进程级单例**——sidecar 一旦不可用就固化为 `None`,
  **整个 worker 生命周期不再重试**。且 sidecar 常由**上一代 worker** 拉起(日志 `connected (existing)`),
  它自己死掉时当前 worker 只握着一条断连接,只打 WARN 不报错。
  后果:判停降级为 min_delay(≈框架 turn detector 预测失败的行为)、声纹旁路整个关闭,
  **对话仍能进行**,所以从体感只是"变钝",不会有任何红灯。
- **已修(2026-08-14 部署,commit 8f6ece7a0)**:改为 OnceCell 只存**客户端外壳**,连接可为空;请求失败即
  丢弃连接并触发**后台**重连/重拉(热路径不等待——spawn 要等模型加载十几秒,不能占判停 500ms 预算),
  下一轮自动恢复;spawn 带 10s 冷却防风暴,新 child 替换旧值即 kill_on_drop 不留孤儿。
  实证:杀掉 sidecar 后 `eot prediction` 计数 1→**0**→1,日志 `EOT sidecar 连接已自愈`+
  `speaker embed 连接已自愈`,sidecar 进程数恒 1。
- ⚠️ **别用 `systemctl restart` 当修复手段**:它自己就是这个故障的制造者(老 sidecar 没死透→新 worker
  连上它走 `(existing)` 分支→不 spawn 自己的子进程→老的随后死掉)。要重启用
  **`stop` → 确认无残留 sidecar → `start`**。旧版本上这条尤其重要;新版本能自愈,但仍会白丢一轮判停。
- ⚠️ **验收判据别数 `eou` 指标**:判停降级走 min_delay 时**照样发 eou**,三次探测全是 1、区分不了。
  要数 `eot prediction`(只有 predict 真跑通才有)。
- ⚠️ **查 sidecar 进程别用 `ps -eo ...,cgroup,cmd`**:cgroup 列极长会把 cmd 挤没,
  空结果与"进程不存在"同形。用 `ps -eo pid,ppid,rss,args ww | grep -F eot_sidecar` 或 `ss -xlp`。
  同理 `grep -i oom` 会被 **`room=`** 命中(2026-08-14 误报 285 条),数 OOM 要 `grep -i oom | grep -iv room`。
- 🔴 **「等 sidecar 清零」禁止写进 ssh 单行复合命令**(2026-08-18 部署实撞,自匹配第五形态):
  `ssh host '... until ! pgrep -f eot_sidecar.py; do sleep 1; done; cp ... && systemctl start ...'`
  ——远端 bash 自己的 cmdline 含该串,pgrep 永真死循环;本地超时杀掉的只是 ssh,**远端 bash 成
  PPID=1 孤儿继续空转,且后半段 cp/mv/start 还挂在它身上**——条件哪天为真它会替你把部署再跑一遍。
  复核时连 `pgrep -f "eot_sidecar[.]py"` 都会命中这个孤儿(方括号只防探测命令自己,不防同类残留)。
  **正确姿势**:部署序列写成脚本文件 scp 过去跑;等清零用
  `ps -eo pid,ppid,etime,args | grep -F eot_sidecar.py | grep -v grep` 外部判;取消远程复合命令后
  必须回去清孤儿(找 PPID=1 的匹配进程,PID 直杀),不能只看本地任务已停。

### Rust 线容量真值(2026-08-14 实测,4 核 Xeon/3915MB)

固定 ≈430MB(worker+sidecar+两个模型,**进程级单例不随 job 涨**;sidecar 单进程 302MB)/
每路 job 边际 **12–18MB**、**0.3 核**(1路7.5%→2路15%,线性)。job 关闭后内存不回落=allocator 保留,
下一个 job 复用(实证:2 路只在 405MB 基础上 +24MB)。
**→ 瓶颈是 CPU 不是内存**;MemoryMax=1.2G 可容 ~40 路,远不是限制。`WORKER_MAX_JOBS` **2026-08-21 起 = 10**
(6→10:4 核 ÷ 0.3 核/路,留 1 核给三条 Python 线+系统;内存侧 10 路≈624MB 距 High 900MB 仍有余量)。⚠️ 该数来自**单轮短 probe**,长会话多轮的 CPU 会更高,上规模前补压测。

## Rust 灰度线(2026-08-12 起,64.90 同机并行)

- **为什么同机**:A/B 对照只能差被测变量本身。最初部署在 dev198(另一台机/另一地理)被川哥当场驳回——
  跨机测出的差异不可归因。**同机、同配置源、同网络路径,只差实现语言**。
- **unit**:`voice-worker-rust`。与 `voice-worker`(Python 主线)/`voice-worker-colleague`/`voice-console`
  并存,**老三个 unit 零触碰**是这条线的红线。二进制 `/root/rust-worker/voice-rust-worker`
  (WorkingDirectory 同目录),上一版留 `.prev` 可秒回滚。
- **env 层叠**(systemd EnvironmentFile 后覆盖前):`/root/realtime-voice-agent/.env` →
  `/root/realtime-voice-agent/poc-eou.env`(**与 Python 主线共享**,含热词)
  → `rust-worker.env`(只放两线差异项)。⚠️ **共享配置一律只写 poc-eou.env,别在 rust-worker.env 复制同值**
  ——两处同值 = 必然漂移(热词就是先踩后收敛的)。
- **构建(2026-08-28 起默认走 home-studio,GHA 降为备用)**:home-studio(家开发机,Ubuntu 24.04/x86_64/20核,
  与 64.90 完全同构)实测 **1m44s vs GHA 10m26s**。SOP:①本机 `git push ssh://hahaxiong83@10.10.10.23/~/mycc <sha>:refs/heads/tmp-rust-build`
  (它无 GitHub 凭据)②`ssh home-studio-mesh` worktree /tmp/wt-rust-build 挂该分支③跑 `scripts/build-local.sh`
  (比 CI 多查 libstdc++,带门禁负向验证;产物 md5 与 GHA 不同=正常,Rust 非重现构建)④产物**本机中转**
  scp 到 64.90(home-studio 直连 64.90 缺 host key)⑤deploy-worker-bin.sh;完事两侧 worktree+tmp 分支即清。
  部署档案记 commit+md5 锚。⚠️ 新二进制必须放 `/root/rust-worker/voice-rust-worker.new`(脚本只认此路径)。
  备用:本机/dev198 的 glibc 比 64.90(24.04/2.39)新,产物拷过去直接跑不起来→走 GitHub Actions
  `.github/workflows/rust-worker-build.yml`(ubuntu-24.04 + glibc 符号天花板门禁)。
  **产物走 release asset(2026-08-20 起)**:`gh release download rust-worker-build-<run_id> -p voice-rust-worker`
  ——actions artifact 配额曾被 71 个历史产物打满,**删除后配额重算 6-12h+ 不即时**(四连撞墙实证),
  release asset 不占该配额。传 64.90:base64 管道或 scp 到 `.new` → `deploy-worker-bin.sh`(自动备份+纪律重启+md5 锚)。
  ⚠️ `gh workflow run` 要求 workflow 文件在**默认分支上**才认。
- **测试页**:Python 线 `voice-test.html` / Rust 线 `voice-test-rust.html`(同一 nginx docroot
  `/var/www/voice`,各自 token 与 agent_name)。⚠️ docroot 在 **47.239**(LiveKit 那台),不是 64.90。
- **设备/第三方接入**(自研通道):完整 SOP 见 `docs/RUST-LINE-DEVICE-ONBOARDING.md`。要点:派单
  **内嵌在 token 的 `roomConfig.agents[].agentName="rust-worker"`**,签 token 漏这段 = 设备能进房
  但永远等不到 AI 且零报错;Python 主线无 AGENT_NAME(自动派单),显式 dispatch 会抑制它不串台
  (30 天日志实证 0 次误接,8078 条它接别的房间作对照锚);并发上限 `WORKER_MAX_JOBS=2`;
  **设备侧必须自带 AEC**——服务端只有 0.5s 打断抑制窗不是回声消除,外放设备会每句自我打断。
- **日志**:`journalctl -u voice-worker-rust`。关键行与 Python 线同名不同措辞
  (`asr: connected (... hotwords=N)`);输入观测每 10s 一行 `audio in (10s) frames=N mean_amp=X`
  (frames=0 → 上行断流/息屏;amp≈0 → 送的是静音;正常 → 问题在下游)。
- **v140 退出信令(2026-08-28)**:三路命中(exact/tail/fragment)吞句+发 `session_exit_detected`
  (topic=control,payload 仅 reply_kind+path 禁带正文/SN);同 seq 重试 800ms×3,终态=ACK/cancel/room close;
  灰度键 `SESSION_EXIT_SIGNAL_ENABLED=1`+`SESSION_EXIT_SIGNAL_CANARY_SN=<SN逗号分隔>`(rust-worker.env,
  fail-closed,003 扩面=列表加 SN)。日志锚:`session_exit signal sent|retry|ack received|terminated by cancel|gave up`;
  吞句锚 `session_exit utterance swallowed path=exact|tail|fragment`。回滚=ENABLED 置 0+restart(零二进制)。
  ⚠️ refspec 推 home-studio 用 `${SHA}:refs/heads/...` 花括号(zsh 把 `$SHA:r` 当 modifier 展开)。
  **Q3 真机闭环(2026-08-31)**:三终态真机全覆盖(ack matched=true 清 pending / cancel+ack 后到 matched=false 仅记账 /
  cancel-only 无 ack);sent→ack 往返 76ms;重试真机零触发=健康态正常。**验证 tail 路径的标准话术=连贯不停顿
  「不想聊了退出吧」或带前缀「啊不想聊了退出吧」**——逗号停顿>600ms 被 EOU 切半后前半若=词表原子会走 exact 桶
  (体感照样退出,但拿不到 tail 样本);吞句判定全量生效,只有信令发送被 canary 门控(非 canary 设备=吞句无信令)。
  **排障:「说再见没反应/沉默不退」**(2026-08-31 003 实锤)——三查:①journal 吞句行 path 分桶(有吞句=worker 正常)
  ②该 SN 在不在 SESSION_EXIT_SIGNAL_CANARY_SN ③端侧版本有没有 v140 消费端;非 canary+老端侧=「吞句面>端侧判定面」
  差集必沉默卡死(带尾词告别端侧不认),解法=装消费端+加 canary,别动 worker 吞句面。
- **回声对撞门(2026-09-01,招呼语回声幽灵轮止血)**:worker 每会话向 server 拉该设备 active 招呼语文案
  (`/v1/internal/local-audio-texts`,brain 通行证鉴权,fail-open),开场窗内 commit 三层判定
  (≥4字 LCS≥0.8/2-3字精确子串/1字一律吞)+追杀(suppressed 命中撤销 2s 内短碎片幽灵轮)。
  env `LOCAL_AUDIO_ECHO_WINDOW_MS`(默认 15000,**置 0=整门关**);日志锚 `echo bank loaded texts=N`/
  `echo suppressed (opening window)`/`echo chase-abort`。**排障:「开场说话没反应」先查是不是被本门吞了**
  (suppressed 行带原句),真误伤=开场 15s 内说了与 active 招呼语高相似句;库只装 greeting 不装 farewell
  (防真退出意图被误吞)。详情 rg 'echo-gate' 记忆。
- **代码**:worktree `~/mycc/.claude/worktrees/rust-worker`,分支 `feat/rust-worker`(已 push origin)。

### EOT 判停快照采集口(2026-08-16 上线,smart-turn 迁移前置 D1;任务 tasks/voice-eot-上线前置.md)

**是什么**:每个 EOT 触发点(静音 200ms、旧模型被调那刻)把 8s 窗 wav + 行为事件流落盘,
为阈值重标定攒自家真实对话分布。**2026-08-16 起已 merge 进 feat/rust-worker(部署真源唯一,
eot-snapshot 分支废弃勿再单独部署——当天曾被三次 rust-worker 部署静默覆盖断采,env 开关还在但
代码没了=死开关;分支合并后此坑关闭)**。另:LLM 舞台指示剥离同日上线(textproc::strip_stage_directions,
「（笑）」类闭合括号/星号段 TTS 前剥除+prompt 语域约束,判据看 tts synth 正文——**先剥行尾 `…(N字)`
后缀再查括号,半角括号判据会被后缀喂饱恒真**)。

- **开关**:`rust-worker.env` 的 `EOT_SNAPSHOT_DIR=/root/eot-snapshots`。**删这行+stop/start=完全关闭
  (零行为变化,E2E 锚 2/快照行 0 验过)**。护栏:单 job 50 个(`EOT_SNAPSHOT_MAX_PER_JOB`)/
  全局 2048MB(`EOT_SNAPSHOT_MAX_TOTAL_MB`),超限停采 WARN 一次不报错。
- **产物**:`/root/eot-snapshots/events.jsonl`(全局事件流:job_start/speech_*/eot_request/
  eot_prob/user_final/turn_commit/job_end;room 名 sha256 脱敏)+ `<UTCts>-<rand6>/t{seq:04}.wav`
  (16k mono s16 整 8s;**尾 19200 样本=旧模型 1.2s 输入窗**,离线切尾即得,不必单存)。
- **进度一眼**:`ssh root@64.90.13.117 'find /root/eot-snapshots -name "*.wav" | wc -l; du -sh /root/eot-snapshots'`
  (目标 ≥300 触发点进 D3 标定)。弱标签:`rust-worker/scripts/label_snapshots.py <目录>`
  (触发点后 ≤800ms 恢复说话=0/2s 内 commit 无恢复=1/其余人工;旧模型概率按 gap_gen 对齐)。
- 🔴 **隐私**:快照与文本=用户语音数据,只存本机、只在私有环境标注,**禁外派任何外部引擎**。
- **打 rust 线攒数据**:voice-test-rust.html(47.239 docroot)或 P003 安卓端;
  rtc_probe 打 rust 线要临时副本改 `AGENT = "rust-worker"`(脚本无 --agent-name 参数,常量在 ~50 行),用完删。

### TTS 切讯飞聆小璇(2026-08-14 上线,P003 读写台音色统一)

**线上态**(2026-08-16 起):二进制 md5 `b91c95fb8302d631b899e6732f454ce6`(feat/eot-snapshot `c0cc0fc8c`,
含快照采集口;回滚=`.prev` 或 `.bak-20260816-pre-snapshot`,校验锚 `grep -ac EOT_SNAPSHOT_DIR` 新1/旧0)、
`TTS_PROVIDER=xfyun`、`XFYUN_TTS_VCN=x6_lingxiaoxuan_pro`、
`FILLER_DIR=/opt/voice-agent/fillers-colleague`。**STT 仍是火山**——判停 401ms 靠火山 ASR
的 B5 伪 final,讯飞无此机制,**别顺手把 STT 一起换了**。

**凭据**:env 直配(`XFYUN_TTS_APP_ID/_API_KEY/_API_SECRET/_VCN` 写在 `rust-worker.env`,600)。
值从租户加密存储解出、全程不出服务器。⚠️ **绝不写共享 `.env`**——会穿透 Python 生产 worker。

**🔴 换 TTS 引擎的执行期 checklist(同一坑踩过两次,别再靠记性)**:
1. `TTS_PROVIDER` 写 `rust-worker.env`(unit 最后一个 EnvironmentFile),不碰 `.env`
2. **`FILLER_DIR` 必须一起换** —— filler 承接音是**预生成 wav 直接播帧、不经 TTS 引擎**,
   只切 provider 会出现「正文是新音色、衔接短句还是旧音色」,用户听成两个人在回复。
   聆小璇资产在 `/opt/voice-agent/fillers-colleague`(62 wav + manifest,24k/mono/s16)。
   ⚠️ filler.rs 是**按 manifest.json 条目**加载不是扫目录,两个目录各有各的 manifest。
3. greeting 走 TTS 合成(跟着 provider 变),无需单独处理
4. 验收:job 日志 `tts provider 生效值 tts_provider=... tts_voice=...` +
   **人耳确认正文与衔接词同一音色**(前面全绿也可能 vcn 传错发出别的声音)

**回滚(已验资产有效,2026-08-14)**:
```
# 回火山:换二进制 + 删 provider 行 + stop/start(别用 restart)
cp /root/rust-worker/voice-rust-worker.bak-20260814-1846-pre-xfyun /root/rust-worker/voice-rust-worker
sed -i '/^TTS_PROVIDER=xfyun$/d;s#^FILLER_DIR=.*#FILLER_DIR=/root/realtime-voice-agent/assets/fillers#' /root/rust-worker/rust-worker.env
systemctl stop voice-worker-rust && sleep 3 && systemctl start voice-worker-rust
```
回滚点校验方法(64.90 **没装 binutils**,`strings`/`objdump`/`readelf` 全缺,别用它们):
`grep -ac x6_lingxiaoxuan_pro <binary>` → 新版 1 / 老版 0;
对照锚 `grep -ac openspeech.bytedance.com` 两版都是 3(火山 STT 两边都在)。

**入站控制通道 cancel/ack(2026-08-15 上线,✅ 真机验过)**:topic `control`,reliable+ordered。
设备发 `{trace_id,ts_ms,src:"android",type:"cancel",lane,seq,payload}`,worker 回 `cancel.ack`
(`src:"worker"`,同 topic)。**只认 `src=android`——worker 自己的 ack 也走这个 topic,
不挡掉会自己取消自己**(有单测钉住)。`(trace_id,seq)` 幂等,重复回 `already_done=true` 不报错。
cancel 走**硬 abort**(`hard_abort_current`:abort turn + clear RTC buffer + 字幕按已播样本截断),
不进 pause+假打断窗口。`wake`/`vad`/`command_word` 走**旁路只记日志,绝不改 turn 判定**。
验收判据(探针 `/tmp/cancel_probe.py`):`control cancel ... cancelled=true already_done=false had_turn=true`
→ 第二次同 trace+seq → `cancelled=false already_done=true **had_turn=false**`。
⚠️ 最后那个 `had_turn=false` 才是关键证据——它证明第一次 abort **真把 turn 干掉了**;
只看 `cancelled=true` 证明不了副作用发生过。

**指标两行,别在一行里找**(2026-08-15 补齐,此前「缺 2 项」的说法已失效):
- 每**句** `tts metrics`:`tts_connect_ms`/`warm`/`warm_connect_ms`/`tts_ttft_ms`/
  `audio_frames`/`audio_duration_ms`/`cancelled`。字段名是 `tts_ttft_ms` 不是 ttfb
  (老行 `say synthesized ttfb_ms=` 同源仍在)。
- 每**轮** `playout metrics`:`room`/`turn_id`/`underrun_count`/`underrun_ms`/
  `buffered_audio_ms`/`played_frames`(turn 结束时出,**含被打断的轮**——挂在 Drop 上,
  覆盖全部退出路径)。

判读:
- `underrun_count` 判的是**可听静音缺口**,不是「channel 空了」(讯飞 1.9 倍实时,正常长句本就会空)。
  **暂停/打断造成的静音不计**。
- `buffered_audio_ms` 是本轮**低水位**。正常 ≈200(RTC 队列背压上限)。
  🔴 **`-1` = 没采到,不是 0**——缓冲没灌到 150ms 就不采(turn 开播时缓冲天然接近 0,
  不设门则每轮都报 ~0)。承接音是**一整块 PCM**,只有一次 recv,所以只播了承接音就被打断的轮必是 `-1`。
- `played_frames × 10ms` 应 ≈ 本轮各句 `audio_duration_ms` 之和,可交叉对账(实测 308 帧 vs 3080ms 精确吻合)。
- 实测:8 句长回复 64 秒音频 → `underrun_count=0 buffered_audio_ms=199`,合约用例 10 服务端侧通过。
- 🔴 **但那是运气好的样本**。2026-08-15 川哥真机一轮 8 个 turn 里:
  一轮 `underrun_count=1 underrun_ms=282 低水位=0`(真出现过 282ms 可听缺口,
  他体感"不明显"),另一轮**低水位只剩 25ms**(正常应在 200 上下=背压天花板)。
  **讯飞 1.9 倍实时的吐流裕度是真实风险,不是纸面推算**——长句 + 网络抖动会咬到。
  该欠载**不是 capture 重试造成的**:同一轮里另两个 turn 同样触发了重试而欠载为 0(内部对照)。
- 计数分支已在生产真实触发过一次,**判据不是恒绿**。
- 新增 `first_underrun_ms`(首次欠载距**开播**多少 ms,`-1`=本轮没欠载):
  靠近 0 = 起播缓冲薄(该预缓冲/让 TTS 更早起跑);明显靠后 = 上游中途掉链子(该并行合成下一句)。
  **没这个数,选哪个优化方案都是猜。**
- 🔴 **只信 `job closed` 之前出的那些行**:turn 的播放任务可能在 job 关闭后还活着(见下条未结),
  它之后出的指标测的是「没人在听」那段。实测 9 行里 8 行通话中全 0 欠载、低水位 197–209,
  唯一一行 `underrun_count=2 underrun_ms=39890` 正是 job 关闭 **45 秒后**才出的。
  不加这条过滤会去追一个不存在的缓冲问题。
- ❌ **别去调厚 32 槽 channel**:实测每槽 181ms(129 样本)、32 槽 ≈ **5.8 秒**容量,
  而 underrun 的定义就是「播放循环在 recv 上等住了」= **channel 当时是空的**,
  容量只在满时起作用。往空 channel 加槽位零收益。真要动只有三条路:
  加大 RTC 队列(打断变钝)/ 预缓冲再起播(首声加延迟,与刚省的 250ms 反向)/ 并行合成下一句(动 progress 记账=行为资产)。

**打断修复现状(2026-08-14,⚠️ 已部署未验证)**:`tts_xfyun::send_or_abort` 每轮先查
`ctl.aborted()` 再 `send_timeout`(200ms 只作**轮询间隔不作判定阈值**),撞打断即丢弃
剩余音频 + 关 WS。**判据是日志 `xfyun tts 中止本句,丢弃剩余音频` 出现过**——
截至部署后首轮实测该行 **0 次**,即分支未被触发过。
触发条件是**在合成进行中打断**(刚说完上一句、下一句正在合成的窗口),
落在句子**播放**期间的打断走不到这里。**别拿"用户说顺畅了"当验收**,两者同形。
遗留:字幕输出不流畅(句粒度)。⚠️ 这条**不会被预建连改善**——字幕粒度由每句 TTS 返回的
bytes 决定,预建连没动那个结构。要改得动字幕发布策略,是另一件事。

**讯飞协议真值(2026-08-14 实测,勿凭文档臆断)**:
- 端点 `wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6`,
  鉴权 host/date/request-line HmacSHA256 → base64 → authorization 整体再 base64
- **`payload.text.text` 必须 base64**,发明文报 10009
- **一条 WS = 一次合成任务**;任务结束(收到 `audio.status==2`)后同连接再发 → `26016
  intput channel is closed`。**但这不等于"不支持流式"**:`status` 支持 0/1/2,
  一次任务内可分段流式喂文本(实测 0→2 与 0→1→2 均成功)。
  ⚠️ 我曾把「用 status=2 之后不能复用」误报成「协议不支持复用」,判据作用域过宽。
- **无取消/中止指令**(官方文档确认)。整句一次性发出后服务端一定吐完 → 打断时
  worker 只能丢弃,停不了上游
- 吐流速度 **1.9 倍实时**(火山 6.5 倍),长句裕度小,联调盯播放缓冲 underrun
- ttfb:**含建连 527ms**(Rust 线实测) / **不含建连 248–275ms**。差值 ~267ms 是每句建连成本
- **14 秒无上行即断**(`26005`),且**计时器从建连起算**(2026-08-15 实测:连上后干等 10s
  再发首帧成功、15s 被关)。这是预建连可行的依据
- **下行不带文本段标识**:`payload.audio.seq` 是**帧序号**(1..N 连续)、`id` 恒为 `"0"`。
  故一条 WS 喂多段时**音频无法归属回句子**

### 预建连流水线(2026-08-15 上线,替代「一条 WS 流式喂多段」的设想)

**为什么不做流式喂多段**:它省的是句间建连,但代价是上面那条——音频归属不回句子。
而 pipeline 靠 `synthesize` 每句返回的 bytes 建 `progress[(累计字,累计样本)]`,
**字幕逐句推进**(`sentence_spans`)与**打断后历史截断**(`truncate_spoken`)全依赖它。
那是拿两个行为资产换延迟。**改用预建连:每句仍独立会话,归属关系一字节没动。**

**做法**:turn 一开始就起后台握手(与 LLM 请求并行);每句在合成的同时为下一句握好手。
`WARM_MAX_AGE=12s < 协议 14s`,超龄丢弃重连(赌它还活着,输了是整句合成失败)。
预建连失败降级为现连,**绝不能让预热失败变成合成失败**。

**回滚**:`XFYUN_TTS_PRECONNECT=0` 写进 `rust-worker.env` + 重启,不用换二进制。

**实测收益**(同一二进制翻开关的 A/B,开场白无承接音遮挡):
开 **292ms**(296/295/286) vs 关 **544ms**(515/549/567) → **净省 ~250ms**。
⚠️ **带承接音的轮里看不到**——端到端首声只从 782→765ms,因为首声是预生成 wav 挡着。
验收看 `tts_ttft_ms`(272–338 vs 499–588),别只看首声。

### 🔴 打断后 AI 彻底不出声(2026-08-15 定位并修复,md5 `55eb8a5d…`)

**症状**:打断后新一轮 `played_frames=0`,该轮 TTS 全 `cancelled=true`,用户只听到承接音就没下文,
不重连恢复不了。**真人会触发**(川哥 12:42 实测,turn 6/8/10/12 全 0 帧)。

**根因**:`playout` 的 `source.capture_frame()` 返回 `RtcError InvalidState - failed to capture frame`,
老代码 `if ....is_err() { return; }` **静默退出整轮**;下游 TTS 随即全撞
`丢弃剩余音频 reason="consumer gone"`。触发窗口=打断瞬间**新旧两个 playout 短暂共存于同一个
`NativeAudioSource`**(旧的收到 abort 要等一次调度才退,新轮承接音已经开始喂),
`hard_abort_current` 里的 `source.clear_buffer()` 正好夹在中间。**纯瞬时**——实测 6/6 一次
20ms 重试即恢复(`tries=1`)。

**修复**:①每条退出路径标 `ExitWhy` 进 `playout metrics`(`Aborted`/`SourceDrained`/
`ControlGone`/`CaptureFailed`,没标的显示 `unmarked`)②capture 失败在 300ms 窗口内每 20ms 重试。

**生产验证(2026-08-15 川哥真机一轮,非探针)**:8 个 turn 全部播出音频、无 0 帧轮;
capture 失败**触发 9 次、救回 9 次**,`consumer gone`/放弃/`CaptureFailed`/`unmarked` 全 0。
即**故障条件仍然天天发生**(它是 abort 竞态的固有产物),只是每次都被重试吃掉了——
所以别看到 `进入重试窗口` 就当异常,**要看的是它后面有没有跟着 `重试成功`**。

**排障姿势**:
```
grep -c "consumer gone"                # 期望 0;非 0 = 播放侧先死了,别去查 TTS
grep "capture_frame"                   # 失败 / 重试成功 / 放弃 三条
grep "playout metrics" | grep exit=    # CaptureFailed 或 unmarked 都是异常
```

⚠️ **归因教训**:这条我一度判成「只有合成音探针会触发、真人不会」,依据是「43 次提交里相邻
<1.5s 为 0」——**判据搭错了对象**:它根本不需要相邻提交,普通打断就够,真人当天就在踩。
排除法算对了一半(A/B 确实排除了预建连),但「谁会触发」那半是我拿一个不相干的统计量推的。

⚠️ **不是当天两次部署引入的**:同一探针三版全复现(预建连版 6/6、预建连关 6/6、
pre-underrun 版 12 次 consumer gone)。以前看不见是因为①更早的症状是 TTS 永久阻塞,
更重的故障盖住了它 ②`playout metrics` 当天才有。**回退不解决,只能修。**

### ⚠️ 未结:job 关闭时 playout 任务疑似泄漏
6 轮里 1 轮,job 关闭时仍在播的 turn **没有输出 `playout metrics`**(该行挂 Drop,
缺行=任务既没返回也没被 drop)。疑似 `capture_frame` 缓冲路径的 `rx.await` 永不返回
(完成回调的 sender 是 `Box::into_raw` 泄出去的)。已立项,判据=打断 20 轮后
`playout metrics` 行数必须等于建立过的 turn 数。

### 开场白开关 `AGENT_GREETING_ENABLED`(2026-08-15 上线,P003 安卓要求)

写在 **`/root/rust-worker/rust-worker.env`**——它是 `voice-worker-rust` 独有的最后一个
`EnvironmentFile`,另外两个 worker 不加载。**共享的 `.env` 里那行 `AGENT_GREETING=…` 别动**,
改它会穿透到 Python 两条线。

- `=0`(现行) → 不建 Say turn:不调 TTS、不产 PCM、不写历史、不发字幕,停在 Listening。
- 未设置 → 默认开,其余环境行为不变。非法值回退默认不 panic。
- `AGENT_GREETING` 为空同样不播(与 Python 侧 `tier_a_cascade` 的 `elif` 落空同语义)。
- 回滚:改 `=1` → stop/start(**别用 restart**)。二进制回滚点 `voice-rust-worker.bak-78b07bf5`。

### 🔴 部署取产物:让服务器直拉,别经过本机

产物最终落在 64.90,经 Mac 中转 = 68MB 跨境往返两趟。**实测:本机 `gh run download`
连续两次卡死(7min/6min 零进展或半途断);同一 artifact 让 64.90 自己 curl → 18.2 秒、1.35MB/s。**

做法:Mac 用 `gh auth token` + `curl -w '%{redirect_url}'`(**不加 `-L`**)取签名 URL,
经 **stdin** 送给服务器的 `curl -K -`(签名 URL 不进 argv/history/日志)。
服务器**没装 unzip**,用 `python3 -c "import zipfile;…"` 解。

### CI 构建三坑(2026-08-16 EOT 迁移工程实证)

1. **`gh run watch --exit-status` 的退出码不可信**——构建 FAIL 它照样 exit 0
   (实证 run 31900433772:输出里有 "X Process completed with exit code 1" 但命令退出 0)。
   判终态一律 `gh run view <id> --json status,conclusion`,认 `conclusion==success`。
2. **workflow_dispatch 不认只在 feature 分支的 workflow**(`gh workflow run` 报 not found,
   GitHub 只注册默认分支定义)→ 新 workflow 用 `on: push: branches:[分支]` 触发,零污染 main。
3. **MS 官方 ORT 的 SONAME 是 major-only `libonnxruntime.so.1`**(不是 .so.1.28.0)——
   ldd/DT_NEEDED/部署文件名全按这个形态;zip artifact 不保 symlink,打包时 `cp -L` 以
   DT_NEEDED 名放真身。验证判据跟对象形态走,别想当然写 `.so.1.28` 去 grep。

### sherpa-onnx × onnxruntime 版本矩阵(smart-turn 迁移用,2026-08-16 实证)

- `ort` crate 2.0.0-rc.13 版本门:**只收 ORT minor ≥28**(MINOR_VERSION=ORT_API_VERSION,
  低版本 dlopen 直接 `BadVersion` panic,高版本仅警告;lib.rs:150 实读)。
- sherpa 官方**全部预编译产物 ≤1.27.1**:venv wheel 1.13.3=1.24.4、release tar 1.13.5=1.27.1、
  PyPI 1.13.5 wheel 干脆不带 C API so(形态变了)→ 单 ORT 统一 1.28 **只能源码构建**。
- 源码构建接口(v1.13.5):cmake `-DSHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=ON`
  + env `SHERPA_ONNXRUNTIME_INCLUDE_DIR/LIB_DIR` 指 MS 官方 tgz 解压目录;
  speaker-embedding 源文件在核心列表**不受** TTS/DIARIZATION 开关门控,可放心关省时。
  现成 workflow:`.github/workflows/sherpa-ort128-build.yml`(feat/eot-snapshot 分支)。
- **S2 结论(2026-08-16)**:sherpa 1.13.5×ORT1.28 vs 1.13.3×1.24.4 同音频 embedding
  **cos=1.000000**(max_abs 3.9e-6)→ registry.json 向量跨版本可复用,声纹免重注册。

### 本地交叉编译:2026-08-15 试过,卡在环境层,**未证伪也未证实**

结论:**维持 GitHub Actions + 服务器直拉**。想再试之前先读这段,别重走。

真正的技术问题(`livekit 0.8.3`→webrtc-sys 的 C++ ABI、`ort` 的 ONNX 预编译库
能否交叉编译)**至今没有答案**——我卡在它前面两层:

1. 本机 rust 是 **homebrew 装的、没有 rustup**,`rustup target add` 无从执行;
2. 装 rustup 后撞冲突:它把 homebrew 的 rustc **当成已存在的 linked toolchain 接管**,
   这类 toolchain 没有 manifest,`rustup target add` 报 `Missing manifest` 直接失败;
3. 强装 rustup 自带 toolchain → 下载两次超时(9 分钟未完)。

→ 真要试,**前置是先 `brew uninstall rust` 再装 rustup**,否则第 2 条会一直挡路。
这会换掉整机所有 Rust 项目的工具链,属于要川哥拍板的改动。
→ zig 0.16.0 已 `brew install`(独立编译器,与 rust 无耦合,留着无副作用)。
→ **收益提醒**:本地构建原本要解的两个痛点,「取产物费劲」已被上面的服务器直拉解决,
   只剩「等 9 分钟」,而那段时间可以并行。动手前先重算一次还值不值。

### 🔴 读服务端日志:`room=` 不是每行都有

**带 room 的**:`job connected` / `turn committed` / `audio in` / `job closed` / `开场白已关闭`。
**不带的**:`tts metrics` / `tts synth` / `AgentSpeechStarted` / `契约 *`。

2026-08-15 实证:按房间名 grep 统计,得出「TTS 请求 0、用户没被识别」并据此判定链路断在 LLM——
**全是过滤器造的零**,那一轮 ASR/LLM/TTS 全程正常。且当时**配了锚也没救**:锚用的 `job room`
恰好带 room,被统计的行不带,锚只证明了同构那条通道。

→ 统计这类行一律**用时间窗**,并先确认窗口内只有目标 job(`received job request` 计数=1)。
→ 下阴性结论前,拿一条**已知发生过的正例**用同一过滤条件捞一次,捞不回来就是过滤器的问题。

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

**interim 文本判读三真值(2026-08-10 问号普查,14 天 226 条真打断实证,服务器 /tmp/interim_qmark.py)**:
- **interim 快照会跨句拼接,句首标点是上一句的残留**(实样 `？嗯`/`？这个`)——「含问号」≠「疑问语气」,判问号必须限**句尾**,归一化先剥句首残留标点。
- **讯飞的问号来自句法结构(疑问词/语气助词)不是升调**【推断,行为层已验证】:问号率随句长升(1-2字5%→5-8字18%),句尾问号样本清一色带疑问词面;**纯语气词(嗯/啊/唉)永远拿不到句尾问号**——「嗯?」型 14 天零出现。想靠标点区分「嗯(附和)」vs「嗯?(反问)」在讯飞文本层**不可行**。
- 日志里**用户文本的唯一载体是 interrupt telemetry 的 interim 快照**:`契约 UserTranscriptInterim/Final` 行都不带文本;含问号的另一大类 `xfyun tts synthesize` 是 **agent 说的话**,别当用户 ASR 对照锚。另:`grep -c interim` 区分大小写,不会数进 `UserTranscriptInterim`(大写 I)。

**语气词打断门·方案定稿+挂起(2026-08-10 川哥拍板)**:原两桶设想(backchannel 否决/query 放行)经问号普查裁决**退化为单桶**——query 桶唯一要救的「纯语气词+升调」在文本层无信号且样本零出现,其余反问("你说什么/然后呢")天然带疑问词面进不了否决桶。定稿=2026-08-04 单桶判据(短 AND 归一化后整句仅语气词→否决)+**误杀哨兵**(纯计数不改行为:语气词打断被否决后同 room 5s 内用户再开口且带疑问词面=疑似误杀反问,频发才考虑音频层升调方案)。**状态:挂起等更多测试数据,勿开工**。论文依据与全推理链见 `~/mycc/3-Thinking/12-JoyAI-Talker论文分析与MyJavis借鉴.md`。

**端到端延迟归因真值(2026-08-04 双向核实闭环,以后别重查)**:租户线用户说完→听到声约 2.9s,构成=**判停 ~0.8-1.4s + LLM 首字 ~860ms + TTS 首包 ~490ms**。
- **LLM 首字 99% 在模型本身**:我方网络 RTT 3.4ms(64.90↔对方端点同在香港阿里云网段)/TLS 86ms 仅首次;对方分段埋点自测=其网关处理 5.1ms、等上游模型 771.9ms;两边数字对得上(其 779ms vs 我方推算 860ms,差值=我方攒字)。**我方与对方网关都无空间,唯一杠杆是换模型**(其直连基准:Qwen3.5-397B 757ms / 35B 404ms 但有 3s 长尾 / deepseek-v4-flash 2735ms 疑含推理阶段未关)。
- ⚠️ **三个我曾误判的坑**:①"地板 19ms/中位 860ms=排队"**错**——是"不调模型的快路径(占位探针/开场白)"与真实轮次混在一个分位数里,**按请求类型分开统计**;②"第2轮起翻倍"**错**——我按会话内轮次分组而**第1轮就是开场白**(短 prompt),对方按历史长度分桶复现不出来;③"关 tools 省 prefill"**错**——见上。
- **判停截断有专用遥测**:`grep "truncation-suspect"`——语义=turn 提交后 **1.2s 内**用户又开口(tier_a_cascade.py:381-385),即判停切早了。基线 34/280=**12%**,gap 中位 352ms。川哥 2026-08-04 拍板**延迟优先、eos 不调大**,故这 12% 是已知并接受的代价,别再提调大 eos。

**「只说一句/内容缺失」诊断遥测**(常驻,2026-08-03):三行日志一次定层——
`journalctl grep "llm stream done"`(上游给了多少字)+`grep "xfyun tts synthesize"`(每句进合成的文本,数行数=句数)+录音有效时长。三层对齐=己方无罪(实战:上游只给 15 字,全部念完,责任面一次切清);llm chars 大而 tts 一段=切句层;tts 多段而听到一句=播放/打断层(配 interrupt telemetry interim 判)。

**「TTS 彻底无声/合成不产出」排障(2026-08-11 实案:讯飞 11200 授权额度)**:
- 症状全家福:`/v1/tts` 缓存句正常、新句 **HTTP 200 + 0 字节**;prewarm accepted 但永不入缓存;healthz 恒绿;worker 侧欢迎语/回复全不出声。→ 第一站看**上游原始错误**:`journalctl -u voice-console | grep -iE "error|讯飞"` / worker 同理——本案 `code=11200 LiccCheck failed, err: licc limit` = **讯飞账号授权额度耗尽/到期**(总量型:全天仅 5 次请求也被拒,排除按天限额),不是服务坏。修复=处理讯飞账号(充值/换 key),不是修服务器。
- 判读纪律:①`xfyun tts synthesize` 行是**发起**不是成功,发起后 0.3s 内跟 RuntimeError=每次都被上游拒;②裸 grep "11200" 会假阳性命中 metrics 行里的数字,用 `code=11200`;③console+租户 worker **共用租户凭据**,双路径同爆=凭据/账号层实锤;④主 worker `TTS_PROVIDER=volc` 无讯飞流量,不能当讯飞对照组(阴性二义)。
- **已知欠账(待川哥拍板)**:`/v1/tts` StreamingResponse 先发 200 头,首 chunk 前失败=200 空体,把上游拒绝伪装成成功(修法:首 chunk 到手再开流,或转 502);healthz 不覆盖合成能力,11200 连爆 5 天无告警。见 [[feedback_hollow_200_needs_payload_check]] 生产者侧变体。
- 对外接报障结论时:对方黑盒探针的**观察**(200 空体/时序)照单收下当复现入口,**越界归因**("你们引擎坏了")一律重验——黑盒上限=定位到边界。见 [[feedback_cross_boundary_attribution_split]]。

**火山大模型 TTS v1 HTTP 接口(2026-08-11 已验参数,给外部接入直接抄)**:
`POST https://openspeech.bytedance.com/api/v1/tts`,鉴权 `Authorization: Bearer;{token}`(**分号**),body 四段 `app{appid,token,cluster:"volcano_tts"}/user{uid}/audio{voice_type,encoding:"mp3",speed_ratio}/request{reqid:每次新uuid,text,operation:"query"}`;响应 JSON,**成功=HTTP200 且 code==3000 且 data(base64 音频)非空**。已实测音色(APP 7699738941,凭据指针=64.90 `.env` VOLC_ACCESS_TOKEN):`zh_male_lengkugege_emo_v2_mars_bigtts`(主worker生产男声)/`zh_female_tianmeixiaoyuan_moon_bigtts`(MyJavis 甜美小媛女声,47.239 `/opt/myjavis/.env` VOLC_TTS_VOICE 生效值)。首包 ~334ms。
- **子贤侧已切火山(2026-08-11)**:讯飞额度死后,川哥把自己火山凭据+甜美小媛音色整理成接入文档给子贤直连火山(文档=川哥桌面`火山TTS接入文档-子贤.md`,含明文 token 勿入仓);租户线 worker 的 `TTS_PROVIDER=xfyun` 未动——同事讯飞账号恢复前,**租户 worker 对话链路仍是坏的**,只有子贤 demo 的 TTS-only 路径切走了。


## 承接音 v7(2026-08-16):87 条+打断轮专用 barge 桶+概率 0.6

- **参数**(64.90 rust-worker.env):`FILLER_PROBABILITY=1.0`(2026-08-17 起必触发——0.6 时代 40% skip 轮正文裸延迟 1.85s 实测=「叫了没反应」,川哥+codex+trace 88185b1e 三方拍板;**0.6/1.0 是触发门控概率,桶内短语=等概率随机+滑窗 3,别混**;greet/thanks 桶代码级固定 0.5 不随 env);`FILLER_BARGE_MAX_MS=1500`(超长保险丝,代码默认 1200)。**打断轮(boost)只从专用 `barge` 桶选条**(6 条收住+转向腔,pick_bucket 永不返回 barge→普通轮碰不到;桶缺失才回退语义桶短条)。资产 87 wav @ /opt/voice-agent/fillers-colleague(旧 81 备份 .bak-v6-20260816)。
- **改文案 SOP**:改 scripts/gen_fillers.py FILLERS 表 → scp 到 64.90:/root/realtime-voice-agent/scripts/gen_fillers_v7.py(PROJ 结构依赖:必须在该项目 scripts/ 下) → `set -a; . /root/rust-worker/rust-worker.env; set +a`(讯飞凭据;探针另需共享 .env 的 LIVEKIT_*) → `cd /root/realtime-voice-agent && /root/voice-venv/bin/python scripts/gen_fillers_v7.py --engine xfyun --out /opt/voice-agent/fillers-colleague.new` → 独立复核(条数/无>3s/barge 全≤1500/老文案零漂移) → stop → mv 原子切 → start → 探针。**⚠️ 文案纪律:task 桶禁执行承诺腔(v5 川哥定);跨桶完整短语禁重;讯飞短句 padding 非线性——要 ≤1500ms 文案就得 ≤3 字**(4-5 字实测 1560-2080ms 全超,「嘞/的」拖腔字再+200ms;线性外推模型不可信,合成后逐条实测是硬门)。
- **验收探针**:filler_v6_probe.py(64.90:/root/rust-worker/);判据=`filler picked bucket= dur_ms= boost=` 行:**boost 轮全部 bucket=barge 且 ≤1500**/普通轮零 barge/相邻不重复/bank loaded: 87 buckets 含 barge。**探针写法铁律:播问句前先停静音 feeder**(交错=音频打碎,ASR 零识别而 mean_amp 正常——2026-08-16 踩过)。
- **barge 桶现行 12 条(v7.1,川哥《日常打断短促回复短语》文档拍板,标点照字面)**:嗯！1360/好！960/行！1080/哦！920/收到！1280/得嘞！1200/好嘞！1120/嗯嗯1080/好呀1000/行呀960/你说1120/你说吧1120。好/行开头在打断桶解禁(v5 禁令只管 task 承接腔)。资产 93 wav;备份链 .bak-v5(62)/.bak-v6(81)/.bak-v7(87)。

## 主循环死锁防护(2026-08-16 四环死锁事故后加装)

- **红线**:pipeline 主循环内**禁止阻塞等锁**——两处 llm 锁均 try_lock,拿不到弃投机(日志
  `speculation skipped: llm busy` / `preemptive miss (llm busy)`,出现=防护在工作,非故障)。
- **watchdog**:pipeline 50ms 心跳,job 层 5s 无跳 → `pipeline 主循环卡死(watchdog 5s 无心跳)` error
  +自动关房删房(用户重连即新房)。**看到这行=出现了新的主循环卡死诱因**,拉卡死前最后一条日志定位。
- **死锁探针**:`deadlock_probe.py`(64.90:/root/rust-worker/,跑法同 filler 探针需共享 .env 的 LIVEKIT_*)
  ——重放真人打断死亡时序(插话→断续拖尾)。判据:插话后 audio in (10s) 持续=活,停发+overflow 每秒刷=死。
  ⚠️ **打断有两条代码分支**:cancel 包=硬 abort,真人语音=pause+假打断窗——filler/canary 探针只走前者,
  改打断相关代码必须跑 deadlock_probe 覆盖 pause 分支。
- 🔴 **LLM 拓扑 P1 大变更(2026-08-17 深夜,提交 59b13d999/二进制 5c91255c)**:rust 主路=kidshub-ai
  大脑 /v1(人设+记忆+过滤,aliyun-hk pm2 p003-voice)——**排障 LLM 问题先分层**:rust 日志 won_by=main=
  大脑赢(其内部另有 [race] won_by 日志=DeepSeek vs doubao,pm2 logs p003-voice 看);rust won_by=
  fallback=裸 doubao 灾备接管(回答无人设「我是豆包」=大脑挂了,查 aliyun-hk)。让步窗
  LLM_RACE_MAIN_GRACE_MS=800(兜底先出等主路 800ms;`main within grace window` 行=窗生效)。
  **换大脑地址/服务器只改 rust-worker.env LLM_BASE_URL 一行**。回滚:env+二进制 .bak-20260817-
  pre-brain;大脑侧 /root/p003-backup-20260817-pre-race/+.env.local 的 LLM_PROVIDER=race→deepseek。
  部署赛跑坑:安静检查与部署必须同一远端脚本无间隙衔接(分两条命令=真机随时插进来)。
- **LLM 双路赛马(2026-08-17,提交 999086e77/二进制 8c676d2a,_run_race 移植)**:主 DeepSeek+兜底火山
  doubao-seed-2.0-lite(coding/v3 网关);env LLM_FALLBACK_{BASE_URL,API_KEY,MODEL,THINKING}=四件套在
  rust-worker.env(三件套缺任一=单路)。⚠️ **THINKING=disabled 必配**(doubao 默认开思考,首块全
  reasoning_content,speakable 被拖:实测开 2112ms/关 418-540ms)。日志锚:`llm race 兜底路已配置`(启动)/
  `llm race won won_by= race_ttft_ms=`(每轮)。🔴 **won_by=fallback 不是故障**——健康时 doubao 更快也赢;
  故障判据=连续全 fallback+投机路 WARN(llm chat failed)成串。双路基线 bench:scripts/bench_race_pair.py(64.90 上 source .env+rust-worker.env 后跑,2026-08-17 基线 553/573ms)。故障注入验收法:rust-worker.env 追加
  LLM_BASE_URL=http://127.0.0.1:9/v1(覆盖 .env)重启→fallback 接管→删行恢复。投机=主路单发(设计内,
  主路坏时投机 WARN 而常规轮由 race 兜住)。
- 🔴 **rust 日志判读铁律:契约行/filler bank/tts synth/llm stream 行不带 room= 字段**——
  按 room grep 数这些行**必得 0**,已两次造成「零 filler/零契约」误判(8-16 job#1、8-17 trace 对撞)。
  ⚠️ 版本界线:**601ef841e(2026-08-17)起 filler picked/skip 行带 room+turn_id**,此前的历史日志仍不带。
  取证姿势:先按 room 锁时间窗(job accepted→closed),再按时间窗全量抓无 room 过滤;并发房用
  「窗口内非目标房行数=0」确认独占。
- **EOT 快照能量剖析(丢音定位)**:trace 里某句「ASR 零输出」时,找覆盖该时段的快照 wav
  (mtime=触发时刻,回看 8s),python wave 分 8 段算平均幅度——「设备 VAD 事件到了但对应秒段能量
  0-2/32767=数字静音」→声学能量丢在设备/上行侧,Worker 文本链无责(88185b1e「停」实证;
  快照=用户语音,只在 64.90 本机分析,禁下载禁外派)。
- **session_exit 吞句(2026-08-17 晚,提交 601ef841e/二进制 586b033f)**:第二张吞句表
  EXIT_SWALLOW_HOTWORDS(35 词,与 Android sessionExitPhrases 逐字一致,**env 权威**——Android 词表
  变更只改 env 一行+stop/start,零构建);Worker 只吞轮次,退出动作全归 Android。投机也按两表拦
  (`speculation skipped: swallow-word tail`)。⚠️ 退出场景 cancel ack 新常态 cancelled=false(无幽灵
  轮可杀),验收判据锚「ack 收到+无幽灵音频」勿锚 true。验收探针 exit_probe_v2.py(64.90:/root/rust-worker/,
  五轮矩阵含负锚「退出后告诉我怎么重新进入」)。
- **stop_only 吞句(2026-08-17 生命周期 v2,提交 6af77311b/二进制 4490304a)**:整句 normalize==急停词
  →commit 门吞掉(无 Committed 契约/无 filler/无回答),日志 `stop_only utterance swallowed`。急停表=
  INTERRUPT_HOTWORDS(rust-worker.env 12 词,含停止/不说了)。**火山流式会把「停，换个话题」切成独立段**
  ——停段吞、内容段正常,混合句零损失。验收 `swallow_probe.py`(64.90:/root/rust-worker/);**验新增 env
  词要用只在新表的词当锚**(「停」默认表也有,证不了 env 生效)。⚠️ unit 三层 EnvironmentFile
  (.env→poc-eou.env→rust-worker.env),打断参数在 poc-eou.env(字数门=0/假打断窗 0.7s)——查配置必须
  `systemctl cat` 拿全三层再逐个 grep,单文件断「未配置」会误判。
- **cancel 时序探针**:`cancel_timing_probe.py`(64.90:/root/rust-worker/,亦入库 rust-worker/scripts/)
  ——一房三连「真声打断+说完立即发 cancel」,模拟 Android 最紧形态。判读:journal `control cancel`(=ack
  发出)→其后最近 `filler picked bucket=barge` 差值。**2026-08-16 基线:454/571/670ms**(结构保证=barge
  必须等打断句自身 EOT commit,ack 先发;DataChannel 往返 10-12ms)。安卓「barge 截音/AUDIO_RESUMED 乱序」
  类报障先复跑它对基线——**cancel/ack 不关房**(hard_abort 无 close,同房 3 连 cancel 实证),关房只有
  明确退出意图或 30s 空闲;两条打断分支都触发 barge(cancel 到达时 interim 必非空→boost 闭环)。

## canary.say 联调通道运维(2026-08-16 上线)

- **是什么**:codex 安卓联调用的确定性长句通道——control topic 发 `canary.say` → worker 走**正式 TTS 链路**播 1..300 字,回幂等 ack + final metrics(`completed` 字段区分播完/取消)。合同真值 `tests/fixtures/s2b1_canary_control_contract.json`(rust/python 双侧 include 同一份,改字段先双方冻结)。
- **开关**(64.90 rust-worker.env):`CANARY_SAY_ENABLED=1` + `CANARY_SAY_IDENTITY_ALLOW`(逗号分隔,fail-closed 空=全拒)。**加设备=identity 追加进白名单 + stop/start**(禁 restart)。生产开场白开关独立不受影响。
- **E2E 验收**:`/root/rust-worker/canary_say_e2e_probe.py`(八判据:幂等 ack/振幅≥5s/metrics 零欠载/disabled/cancel 中止/伪造丢弃)。跑法:`set -a; . /root/realtime-voice-agent/.env; . /root/rust-worker/rust-worker.env; set +a; /root/voice-venv/bin/python canary_say_e2e_probe.py canary-e2e-$(date +%s)`。
- **三个坑**:①control 消费在 **both directions ready 之后**才启动——设备只 connect 不发麦克风轨,canary.say 无人消费无 ack;②**一人一房**:任何 participant 断开=关整个 job(探针第二连接要用独立房间);③stale_trace 判定用 epoch 时钟(别拿 now_ms 单调毫秒比设备 ts,踩过恒 stale)。
- **tts synth 日志已全局截 24 字**:验"没落全文"时 grep 短语必须取第 25 字以后的内容(保留区命中≠泄露),正锚=`(N字)` 截断标记。

## 64.90 rust worker 日志统计纪律（2026-09-02 踩坑固化）
- **三个 unit 同时 active**：`voice-worker`(py 旧) / `voice-worker-colleague`(py,json 日志) / `voice-worker-rust`(生产 rust)。统计前 `systemctl list-units --state=active | grep voice-worker` 看全，**别 `head -1` 取名**（曾抓到 colleague 得全零误判「观察期零样本」）。
- **rust tracing 日志带 ANSI 色码**：`journalctl -o cat` 直接 grep `label=`/`known=` 全空（`\x1b[3mlabel\x1b[0m=…`）。先 `sed "s/\x1b\[[0-9;]*m//g"` 剥色再 grep；`-o short-iso` 拿时间戳。
- 观察模式统计模板：`llm device intent observed`(慢路)/`start_device_command`(快路)/`device.command.result` status 分布；**每条 observed 要回溯前一行 `turn committed` 用户原话逐条判读**——标签合法≠意图正确（2b 合同实证 4/11 误触发）。
- 登录：`ssh root@64.90.13.117`（BatchMode 可用，config 无别名）。

## 2b LLM 慢路执行灰度（2026-09-02 上产，默认关；合同 `CC_P003_DEVICE_INTENT_2B_EXECUTE_CONTRACT_V2`）
- 键（rust-worker.env）：`P003_DEVICE_INTENT_EXECUTE=0|1` + `P003_DEVICE_INTENT_EXECUTE_CANARY_SN_HASHES=`（sha256(SN) 小写逗号分隔；空=设备房全开）。**独立于 `P003_DEVICE_COMMANDS_CANARY_SN_HASHES`**（那个管 L1 快路，现为空=全开，别混用）。
- 开闸前提（缺一不开）：Android v186 已装目标机 + wake 包 `device_command_contract_version=2`（worker 日志锚 `l2 capability contract_version=2`）+ 首轮只填 003 hash。步骤：改 env → 纪律重启 → 看 `llm device intent executed lane=L2` / `suppressed reason=`。
- 回滚：`EXECUTE=0` + 纪律重启（零二进制）；二进制回滚 deploy 脚本自动备份的上一版（2b 前 md5 `13137847…`，2b 版 `d337df9c…`）。
- 候选槽（2026-09-02 晚 codex 裁定）：**无任何按时间清状态路径**（固定 TTL 会把 M4 already_applied 退化成 null-ID 二次执行）；`candidate_orphan_watchdog` 行（trace/candidate/event=consume|override|clear|job_end/age_ms）**只是观测不是故障**，job_end 大 age=用户唤醒后没说慢路句。补发 wake 版本上线后每 job `l2 capability` 行数 1 或 2 都正常，0 才是丢包。新二进制暂存 `.new` 不等于生效：`deploy-worker-bin.sh` 跑过、md5 回显变了才算。
- **切版/重启前置机械判据（会话外）**：`journalctl -u voice-worker-rust --since <ActiveEnterTimestamp>` 里 `grep -c 'received job request'` == `grep -c 'process exiting'` 才是无活跃 job；再对撞 `.new` md5 与构建回显，两门过才跑 `deploy-worker-bin.sh`（2026-09-02 21:07 切 `a56a9841`/md5 `e5245811…` 实跑）。切后复核：`systemctl show -p MainPID,NRestarts`、`/proc/<pid>/environ` 灰度两键、`/proc/<pid>/exe` md5、90s 内 `registered worker` 恰 1 行、panic/ERROR 计数 0；**3 分钟后再取一次样**（同 PID、NRestarts 0）才算无重启风暴。
- **canary hash 算法真值**：`commands_gate` = `sha256_hex(sn.as_bytes())`——SN **原文（大写）**的 sha256 小写 hex，小写 SN 的哈希不命中；列表条目也认 SN 明文但 env 放哈希。003 = `8fb71c43…6ddb`。
- **灰度全覆盖现状（2026-09-02 晚）**：L1 快路 / 退出信令 / **二遍识别**三条 canary 名单全空=设备房全开（二遍备份 `rust-worker.env.bak-20260902-nonstream-fullopen`，锚 `grep '二遍识别灰度命中'`）；只剩 L2 `EXECUTE` 按 J2 灰度、filler 人格化 F2 未接线、`CANARY_SAY_IDENTITY_ALLOW` 是探针通道非功能。改 env 后一律纪律重启（stop/sleep 3/start）并 `/proc/<pid>/environ` 复核。
- **2b 慢路播报口径（2026-09-03，worker `0b2e491f`）**：`[[DEV:N]]` 带内 token 流中即派发（`executed` 紧随首 delta）；设备短句走 `say_after_current`：回复在播压槽→`PlayedOut` 追加，抢话作废；**成功态 + L2 + 回复在播 = 静默**（锚 `device success reply skipped`），失败/边界/already_applied/超时/accepted 仍追加（锚 `device reply deferred until current turn plays out` → `device reply appended after turn played out`）。L2 发命令不再切 Thinking（在播回复保持 Speaking，否则急停/打断/speaking 信号失效）。回声门拦下后 LLM 仍跑一轮=待办。
- **M0 对撞判据**：同 trace `l2 capability contract_version=2` 行数 = 1（wake 补发版上线后 1 或 2 都正常）；0 = 丢包，先按首包时序定位（Android 建连即发、不等 agent 入房，worker 未入房时发的包 LiveKit 不缓存）。跨端时间别直接比：**设备钟慢 server ≥1.3s**（房名后缀 = server 秒，可当钟锚），主键用 trace。
- 观察锚**文案已改**：`llm device intent observed`（不再带「observe-only」括号），grep 锚不变；统计仍须剥 ANSI。
