//! cascade 编排(P3b-W1:判停/打断语义对齐 livekit-agents 框架实际行为):
//!
//! - 判停 v2:VAD 停说锚点 + EOT sidecar 语义选挡(prob<0.3550 → MAX 否则 MIN),
//!   EOT 在说话中静音累积 ≥200ms 时刻拿最近 1.2s 音频预测(说话恢复作废重来)。
//! - 打断 v2(pause→false-timer→resume/abort 三段,对齐 agent_activity):
//!   VAD 语音 ≥MIN_INTERRUPTION_DURATION(0.5s)+ 字数门(≥1 字)→ **pause**(非 abort,
//!   RTC 内 ≤200ms 尾音自然放完);VAD 停说起 FALSE_INTERRUPTION_TIMEOUT(1.5s)定时,
//!   超时无 turn → resume 续播 + 契约 FalseInterruption;期间用户 turn 提交 → 才真 abort。
//! - AEC warmup(首次开口起 0.5s one-shot):窗口内禁音频路打断(框架同款)。
//! - 急停白名单:标准化精确命中 → 绕过字数门直接硬打断。
//! - 打断历史截断:按已播样本把 assistant 历史修正为真实说出的部分(句级+比例近似)。
//! - 契约日志:`契约 {事件} turn={id}` 逐字段对齐 pipeline/session.py。
//!
//! 未做(P3b-W2/W3):S1 投机、filler、剥承接词、TTS 池、metrics publish、STT 重连、
//! 声纹、音乐工具。

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use futures_util::StreamExt;
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::contract::Contract;
use crate::control;
use crate::eot::{EOT_MAX_SAMPLES, EotClient, UNLIKELY_THRESHOLD_ZH};
use crate::filler::FillerBank;
use crate::llm::{self, ChatOutcome, Llm, LlmConfig};
use crate::playout::{self, PlayoutControl};
use crate::preflight::{PreflightConfig, PreflightGate};
use crate::segmenter::Segmenter;
use crate::speaker_id::SpeakerSidecar;
use crate::stt_volc::{self, AsrEnd, SttConfig, SttEvent};
use crate::textproc::{normalize_utterance, parse_hotwords};
use crate::transcript_pub::{self, TranscriptPub, sentence_spans};
use crate::tts::TtsCfg;
use crate::turn::TurnGate;
use crate::vad::{SileroVad, VadEvent, VadGate, WINDOW};

pub struct PipelineConfig {
    pub min_endpointing_delay: Duration,
    pub max_endpointing_delay: Duration,
    pub unlikely_threshold: f32,
    pub min_interruption_words: usize,
    pub min_interruption_duration: f32,
    pub false_interruption_timeout: Duration,
    pub aec_warmup_duration: Duration,
    pub tts_min_sentence_len: usize,
    pub greeting_text: String,
    /// 连接后是否自动播固定开场白。P003 安卓 demo 要求关掉(2026-08-15 联调)。
    /// 默认 true —— 其余环境行为不变。
    pub greeting_enabled: bool,
    /// S2B1 canary.say 联调通道。默认关;identity 白名单空=全部拒绝(fail-closed)。
    pub canary_say_enabled: bool,
    pub canary_identity_allow: Vec<String>,
    pub vad_model_path: String,
    pub hotwords: HashSet<String>,
}

/// 是否播开场白。抽成函数是为了让**生产用的那条判据**能被单测直接调用——
/// 在测试里重写一遍条件等于没测它。
fn should_greet(enabled: bool, text: &str) -> bool {
    enabled && !text.trim().is_empty()
}

/// 布尔型 env 解析。**非法值回退默认值而不是 panic**:开场白开关误配
/// 不该让整个 worker 起不来——它是体验开关,不是安全开关。
fn parse_flag(raw: Option<&str>, default: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) => match v.as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => default, // 含空字符串
        },
        None => default,
    }
}

impl PipelineConfig {
    pub fn from_env() -> Self {
        let f = |k: &str, d: f32| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d)
        };
        Self {
            min_endpointing_delay: Duration::from_secs_f32(f("MIN_ENDPOINTING_DELAY", 0.55)),
            max_endpointing_delay: Duration::from_secs_f32(f("MAX_ENDPOINTING_DELAY", 0.6)),
            unlikely_threshold: f("POC_EOU_UNLIKELY_THRESHOLD", UNLIKELY_THRESHOLD_ZH),
            min_interruption_words: std::env::var("MIN_INTERRUPTION_WORDS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1),
            min_interruption_duration: f("MIN_INTERRUPTION_DURATION", 0.5),
            false_interruption_timeout: Duration::from_secs_f32(f(
                "FALSE_INTERRUPTION_TIMEOUT",
                1.5,
            )),
            aec_warmup_duration: Duration::from_secs_f32(f("AEC_WARMUP_DURATION", 0.5)),
            tts_min_sentence_len: std::env::var("TTS_MIN_SENTENCE_LEN")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(6),
            greeting_text: std::env::var("AGENT_GREETING")
                .unwrap_or_else(|_| "你好，我在。你可以直接打断我。".into()),
            greeting_enabled: parse_flag(
                std::env::var("AGENT_GREETING_ENABLED").ok().as_deref(),
                true,
            ),
            canary_say_enabled: parse_flag(
                std::env::var("CANARY_SAY_ENABLED").ok().as_deref(),
                false,
            ),
            canary_identity_allow: std::env::var("CANARY_SAY_IDENTITY_ALLOW")
                .unwrap_or_default()
                .split(',')
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect(),
            vad_model_path: std::env::var("VAD_MODEL_PATH").unwrap_or_else(|_| {
                format!("{}/assets/silero_vad.onnx", env!("CARGO_MANIFEST_DIR"))
            }),
            hotwords: parse_hotwords(std::env::var("INTERRUPT_HOTWORDS").ok().as_deref()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentState {
    Listening,
    Thinking,
    Speaking,
}

#[derive(Debug)]
enum TurnEvent {
    AudioStarted(u64),
    PlayedOut(u64),
}

enum TurnKind {
    Say(String),
    Reply {
        user_text: String,
        pending_amend: Option<String>,
        /// 承接音(文案, 24k pcm):先于回复音频入轨,同轨串行(C1 v2 语义)。
        filler: Option<(String, Vec<u8>)>,
        /// S1v3 投机命中:直接消费投机流,不再发正式 LLM 请求。
        spec: Option<Speculation>,
    },
}

/// 投机生成(preflight 触发的提前 LLM 流;命中=提交文本全等+历史版本未变)。
struct Speculation {
    text: String,
    version: u64,
    started: Instant,
    task: JoinHandle<Result<ChatOutcome>>,
    rx: mpsc::Receiver<String>,
}

struct AgentTurn {
    id: u64,
    task: JoinHandle<()>,
    ctl: PlayoutControl,
    synth_text: Arc<StdMutex<String>>,
    /// 每句合成完成后追加 (累计字符数, 累计样本数),打断截断用。
    progress: Arc<StdMutex<Vec<(usize, u64)>>>,
}

/// 在途 canary.say:turn 结束(播完或取消)后从 stats 槽取终态发 metrics。
struct CanaryPending {
    test_id: String,
    trace_id: String,
    seq: i64,
    turn_id: u64,
    stats: std::sync::Arc<std::sync::Mutex<Option<crate::playout::FinalStats>>>,
}

struct Orchestrator {
    cfg: PipelineConfig,
    tts_cfg: TtsCfg,
    llm: Arc<Mutex<Llm>>,
    source: NativeAudioSource,
    participant: LocalParticipant,
    room_name: String,
    contract: Contract,
    turn_gate: TurnGate,
    state: AgentState,
    agent_turn: Option<AgentTurn>,
    next_turn_id: u64,
    /// Some(timeout)=当前回答被 pause(假打断窗口),timeout 为 VAD 停说后起的定时时长。
    paused: Option<Duration>,
    false_deadline: Option<Instant>,
    aec_deadline: Option<Instant>,
    aec_armed: bool,
    resume_grace: Option<Instant>,
    latest_interim: String,
    /// 打断遥测快照(对齐 _tele_interim:最近一次转写文本,telemetry 行后清空)。
    tele_text: String,
    /// 真插话时刻(interim 非空的 speaking→listening),5s 窗内的 turn=打断轮 filler 必播。
    last_interrupt_at: Option<Instant>,
    turn_ev_tx: mpsc::Sender<TurnEvent>,
    eot_tx: mpsc::Sender<(u64, f32)>,
    eot_gap_gen: u64,
    eot_requested: bool,
    pending_amend: Option<String>,
    bank: Option<FillerBank>,
    pf: PreflightGate,
    spec: Option<Speculation>,
    speaker: Option<SpeakerSidecar>,
    /// 字幕发布(legacy Transcription 包,页面气泡消费)。
    tr: TranscriptPub,
    /// 当前 turn 已发 interim(句进入播出)/final(句播完)的句数游标。
    tr_started: usize,
    tr_finaled: usize,
    /// 入站 cancel 的 (trace_id, seq) 幂等表
    ctrl_dedup: control::Dedup,
    /// canary.say 独立幂等表(与 cancel 分表:两类消息的 seq 空间互不干扰)
    canary_dedup: control::Dedup,
    /// 在途 canary:等 playout 终态就绪后发 final metrics(单发)
    canary_pending: Option<CanaryPending>,
    t0: Instant,
    /// EOT 判停快照采集(上线前置① D1;EOT_SNAPSHOT_DIR 未设=None,零行为变化)
    snap: Option<crate::eot_snapshot::SnapshotSink>,
}

pub async fn run_pipeline(
    mut mic: NativeAudioStream,
    source: NativeAudioSource,
    participant: LocalParticipant,
    room_name: String,
    route: transcript_pub::Route,
    mut ctrl_rx: mpsc::Receiver<(control::Envelope, control::Inbound, Option<String>)>,
    beat: std::sync::Arc<std::sync::atomic::AtomicU64>,
) -> Result<()> {
    let cfg = PipelineConfig::from_env();
    let stt_cfg = SttConfig::from_env();
    let tts_cfg = TtsCfg::from_env()?;
    info!(
        room = %room_name,
        tts_provider = tts_cfg.provider_name(),
        tts_voice = %tts_cfg.voice(),
        "tts provider 生效值"   // 音色对不上时一眼对账,别靠猜 env 生效没生效
    );
    let llm_cfg = LlmConfig::from_env().ok_or_else(|| anyhow::anyhow!("LLM_BASE_URL 未配置"))?;
    let mut llm_inner = Llm::new(llm_cfg);
    // 预热(藏进「用户说首句+判停」窗口):LLM TLS 建连 + TTS 池首连
    {
        let (client, pcfg) = llm_inner.prewarm_parts();
        tokio::spawn(llm::prewarm(pcfg, client));
        let tc = tts_cfg.clone();
        tokio::spawn(async move { tc.prewarm().await });
    }
    // 声纹旁路(SPEAKER_ID_ENABLED=1 且注册库在):粘滞身份槽接入 LLM 近因位
    let speaker = SpeakerSidecar::load_from_env();
    if let Some(s) = &speaker {
        llm_inner.set_speaker_slot(s.sticky_slot());
    }
    let llm = Arc::new(Mutex::new(llm_inner));

    let mut vad = SileroVad::load(&cfg.vad_model_path)?;
    let mut gate = VadGate::new(
        std::env::var("VAD_ACTIVATION_THRESHOLD")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.6),
        std::env::var("VAD_MIN_SPEECH_DURATION")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.15),
        0.3,
    );

    // STT 长连(断线重连:改进项,Python 版死流;连续 5 败放弃)
    let (stt_pcm_tx, stt_pcm_rx) = mpsc::channel::<Vec<i16>>(128);
    let (stt_ev_tx, mut stt_ev_rx) = mpsc::channel::<SttEvent>(64);
    let stt_task = tokio::spawn({
        let stt_cfg = stt_cfg.clone();
        let rn = room_name.clone();
        let mut pcm_rx = stt_pcm_rx;
        async move {
            let mut fails = 0u32;
            loop {
                let started = Instant::now();
                match stt_volc::run_asr_stream(stt_cfg.clone(), &mut pcm_rx, stt_ev_tx.clone())
                    .await
                {
                    Ok(AsrEnd::InputDone) => break,
                    Ok(AsrEnd::ServerClosed) => {}
                    Err(e) => warn!(room = %rn, error = %e, "火山 ASR 流异常"),
                }
                if started.elapsed() > Duration::from_secs(10) {
                    fails = 0; // 长稳连接后的断开不算连败
                }
                fails += 1;
                if fails > 5 {
                    warn!(room = %rn, "asr 连续 {fails} 次失败,放弃重连");
                    break;
                }
                let backoff = Duration::from_millis(500 * 2u64.pow((fails - 1).min(3)));
                warn!(room = %rn, attempt = fails, backoff_ms = backoff.as_millis() as u64, "asr 断线重连");
                tokio::time::sleep(backoff).await;
            }
            let _ = stt_ev_tx.send(SttEvent::Closed).await;
        }
    });

    let (turn_ev_tx, mut turn_ev_rx) = mpsc::channel::<TurnEvent>(16);
    let (eot_tx, mut eot_rx) = mpsc::channel::<(u64, f32)>(8);

    let participant2 = participant.clone();
    let mut orch = Orchestrator {
        turn_gate: TurnGate::new(
            cfg.min_endpointing_delay,
            cfg.max_endpointing_delay,
            cfg.unlikely_threshold,
        ),
        cfg,
        tts_cfg,
        llm,
        source,
        participant,
        room_name: room_name.clone(),
        contract: Contract::new(),
        state: AgentState::Listening,
        agent_turn: None,
        next_turn_id: 0,
        paused: None,
        false_deadline: None,
        aec_deadline: None,
        aec_armed: false,
        resume_grace: None,
        latest_interim: String::new(),
        tele_text: String::new(),
        last_interrupt_at: None,
        turn_ev_tx,
        eot_tx,
        eot_gap_gen: 0,
        eot_requested: false,
        pending_amend: None,
        bank: FillerBank::load_from_env(),
        pf: PreflightGate::new(PreflightConfig::from_env()),
        spec: None,
        speaker,
        tr: TranscriptPub::new(participant2, route),
        tr_started: 0,
        tr_finaled: 0,
        ctrl_dedup: control::Dedup::default(),
        canary_dedup: control::Dedup::default(),
        canary_pending: None,
        t0: Instant::now(),
        snap: crate::eot_snapshot::SnapshotSink::from_env(&room_name),
    };

    // EOT 环形缓冲:采集关=最近 1.2s(原状);采集开=8s(smart-turn 窗,快照落盘用,
    // predict 仍只取尾 1.2s,判停行为不变)
    let ring_keep = crate::eot_snapshot::SnapshotSink::ring_keep(orch.snap.is_some(), EOT_MAX_SAMPLES);
    let mut eot_ring: VecDeque<i16> = VecDeque::with_capacity(ring_keep + WINDOW);
    let mut vad_buf: Vec<i16> = Vec::with_capacity(WINDOW * 2);
    // 火山按段消化音频:攒 200ms(3200 样本)一发,对齐 Python segment_duration_ms=200。
    const STT_SEGMENT_SAMPLES: usize = 3200;
    let mut stt_buf: Vec<i16> = Vec::with_capacity(STT_SEGMENT_SAMPLES * 2);
    let mut commit_tick = tokio::time::interval(Duration::from_millis(50));

    // greeting(session.say 语义:入历史、可被打断、走同一播放机)
    // 门禁(P003 安卓联调 2026-08-15):AGENT_GREETING_ENABLED=0 关闭;文本为空同样不播,
    // 对齐 Python 侧「AGENT_GREETING 为空即静默」的既有约定(tier_a_cascade 的 elif 落空)。
    // 关闭路径**不建 Say turn** —— 不碰 TTS、不产 PCM、不写历史、不发字幕,停在 Listening。
    // 日志只记两个布尔,不带开场白文本(联调日志会外发)。
    let greeting = orch.cfg.greeting_text.clone();
    if should_greet(orch.cfg.greeting_enabled, &greeting) {
        orch.start_turn(TurnKind::Say(greeting));
    } else {
        info!(
            room = %room_name,
            enabled = orch.cfg.greeting_enabled,
            text_empty = greeting.trim().is_empty(),
            "开场白已关闭,保持 Listening"
        );
    }

    // 输入水位观测(2026-08-12 聋窗排查加装):每 10s 一行 frames+均幅。聋时一眼分层——
    // frames=0=源侧断流(mute/息屏);frames 正常 amp≈0=送的是静音;都正常=下游(火山)问题。
    let mut in_frames: u64 = 0;
    let mut in_amp_acc: u64 = 0;
    let mut in_report = Instant::now();

    loop {
        tokio::select! {
            // 入站控制包(设备 → worker)。放在最前面:cancel 的时效性高于音频帧处理。
            ctrl = ctrl_rx.recv() => {
                // channel 关闭不退主循环——控制通道是可选能力,断了不该拖垮通话
                if let Some((ev, kind, identity)) = ctrl {
                    orch.on_control(&ev, kind, identity.as_deref()).await;
                }
            }
            frame = mic.next() => {
                let Some(frame) = frame else { break };
                let samples: Vec<i16> = frame.data.to_vec();
                in_frames += 1;
                if !samples.is_empty() {
                    in_amp_acc += samples.iter().map(|s| u64::from(s.unsigned_abs())).sum::<u64>()
                        / samples.len() as u64;
                }
                stt_buf.extend_from_slice(&samples);
                if stt_buf.len() >= STT_SEGMENT_SAMPLES {
                    // 满则丢段不阻塞热路径(channel 128 段 ≈ 25s 缓冲,正常永远不满)
                    let _ = stt_pcm_tx.try_send(std::mem::take(&mut stt_buf));
                }
                eot_ring.extend(samples.iter().copied());
                while eot_ring.len() > ring_keep {
                    eot_ring.pop_front();
                }
                if let Some(sp) = orch.speaker.as_mut() {
                    sp.ring.append(&samples); // 声纹 ring:写入即幅度过滤
                }
                orch.on_pf_frame(&samples).await;
                vad_buf.extend_from_slice(&samples);
                while vad_buf.len() >= WINDOW {
                    let chunk: Vec<i16> = vad_buf.drain(..WINDOW).collect();
                    if let Ok(p) = vad.predict(&chunk) {
                        let active = p >= gate.activation_threshold;
                        let ev = gate.feed(p);
                        orch.on_vad_frame(&gate, ev, active, &eot_ring).await;
                    }
                }
            }
            ev = stt_ev_rx.recv() => match ev {
                Some(SttEvent::Interim(t)) => orch.on_interim(t),
                Some(SttEvent::Final(t)) => orch.on_final(t),
                Some(SttEvent::Closed) | None => {
                    warn!(room = %room_name, "stt 事件流结束(重连=W2,job 收尾)");
                    break;
                }
            },
            Some((gap_gen, prob)) = eot_rx.recv() => {
                let accepted = gap_gen == orch.eot_gap_gen;
                if accepted {
                    orch.turn_gate.on_eot_prob(prob);
                    tracing::debug!(probability = prob, threshold = orch.cfg.unlikely_threshold, "eot prediction");
                }
                if let Some(s) = &mut orch.snap {
                    s.event("eot_prob", &[
                        ("gap_gen", &gap_gen.to_string()),
                        ("prob", &format!("{prob:.6}")),
                        ("accepted", if accepted { "1" } else { "0" }),
                    ]);
                }
            }
            Some(te) = turn_ev_rx.recv() => orch.on_turn_event(te),
            _ = commit_tick.tick() => {
                // watchdog 心跳(epoch ms):主循环卡死(如等锁)时停跳,job 层 5s 无跳即惊闸关房
                beat.store(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                    std::sync::atomic::Ordering::Relaxed,
                );
                if in_report.elapsed() >= Duration::from_secs(10) {
                    let mean_amp = if in_frames > 0 { in_amp_acc / in_frames } else { 0 };
                    info!(room = %room_name, frames = in_frames, mean_amp, "audio in (10s)");
                    in_frames = 0;
                    in_amp_acc = 0;
                    in_report = Instant::now();
                }
                orch.on_tick().await;
            }
        }
    }

    if let Some(t) = orch.agent_turn.take() {
        t.ctl.abort();
        t.task.abort();
    }
    if let Some(sp) = orch.spec.take() {
        sp.task.abort();
    }
    drop(stt_pcm_tx);
    let _ = tokio::time::timeout(Duration::from_secs(3), stt_task).await;
    info!(room = %room_name, "pipeline closed");
    Ok(())
}

impl Orchestrator {
    /// agent 状态迁移:telemetry 行(speaking→listening)+ 契约事件(bridge 同款,
    /// 进 listening 一律发 AgentSpeechStopped——含 thinking→listening 的 quirk)
    /// + speaking 状态 publish(topic=state,租户图标 UI 状态机依赖)。
    fn set_state(&mut self, new: AgentState) {
        if self.state == new {
            return;
        }
        if self.state == AgentState::Speaking && new == AgentState::Listening {
            let snap: String = self.tele_text.chars().take(40).collect();
            info!(room = %self.room_name, "interrupt telemetry: speaking→listening interim='{snap}'");
            if !self.tele_text.is_empty() {
                // interim 非空的 speaking→listening=真插话,记时刻供打断轮 filler 必播
                self.last_interrupt_at = Some(Instant::now());
            }
            self.tele_text.clear();
        }
        match new {
            AgentState::Speaking => {
                self.contract.agent_speech_started();
                self.publish_json("state", json!({"k": "speaking", "speaking": true}));
            }
            AgentState::Listening => {
                self.contract.agent_speech_stopped();
                if self.state == AgentState::Speaking {
                    self.publish_json("state", json!({"k": "speaking", "speaking": false}));
                }
            }
            AgentState::Thinking => {
                if self.state == AgentState::Speaking {
                    self.publish_json("state", json!({"k": "speaking", "speaking": false}));
                }
            }
        }
        self.state = new;
    }

    /// publish_data 到 room(web 延迟面板/租户状态机消费;失败只记不抛)。
    fn publish_json(&self, topic: &'static str, v: Value) {
        let p = self.participant.clone();
        tokio::spawn(async move {
            let packet = DataPacket {
                payload: v.to_string().into_bytes(),
                topic: Some(topic.to_string()),
                reliable: true,
                ..Default::default()
            };
            if let Err(e) = p.publish_data(packet).await {
                tracing::debug!(error = %e, "publish_data failed");
            }
        });
    }

    fn now_ms(&self) -> f64 {
        self.t0.elapsed().as_secs_f64() * 1000.0
    }

    /// S1v3 触发器逐帧喂音频;fire → 起投机。
    async fn on_pf_frame(&mut self, samples: &[i16]) {
        let now_ms = self.now_ms();
        if let Some((text, sil, quiet)) = self.pf.on_frame(samples, now_ms) {
            let tail_snip: String = text
                .chars()
                .rev()
                .take(16)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            info!(
                room = %self.room_name,
                "S1v3 preflight emitted (silence={sil:.0}ms quiet={quiet:.0}ms tail='{tail_snip}')"
            );
            self.start_speculation(text).await;
        }
    }

    /// 起投机 LLM(不含 TTS;历史快照版本随身,提交时校验)。旧投机作废。
    ///
    /// ⚠️ 死锁红线(2026-08-16 voice-test-rust 卡死实证):主循环内**禁止阻塞等 llm 锁**。
    /// 回复孙任务持锁跨整个 LLM 流;真打断 pause 悬置时 playout 不消费 → pcm 满 →
    /// 回复任务停收 delta → delta 满 → 孙任务挂在 send 上锁永不释放;而 pause 的
    /// 解除路径(假打断定时/下轮提交)全在主循环——主循环一等锁即四环死锁。
    /// 投机是可丢的优化:拿不到锁=放弃本次,零损失。
    async fn start_speculation(&mut self, text: String) {
        if let Some(old) = self.spec.take() {
            old.task.abort();
        }
        let Ok(llm_guard) = self.llm.try_lock() else {
            info!(room = %self.room_name, "speculation skipped: llm busy(回复流持锁中)");
            return;
        };
        let (client, cfg, messages, version) = llm_guard.speculation_request(&text);
        drop(llm_guard);
        let (tx, rx) = mpsc::channel::<String>(1024);
        let task = tokio::spawn(async move { llm::stream_chat(&client, &cfg, messages, tx).await });
        self.spec = Some(Speculation {
            text,
            version,
            started: Instant::now(),
            task,
            rx,
        });
    }

    fn aec_active(&self, now: Instant) -> bool {
        self.aec_deadline.map(|d| now < d).unwrap_or(false)
    }

    async fn on_vad_frame(
        &mut self,
        gate: &VadGate,
        ev: VadEvent,
        active_frame: bool,
        eot_ring: &VecDeque<i16>,
    ) {
        let now = Instant::now();
        match ev {
            VadEvent::SpeechStart => {
                self.turn_gate.on_speech_start();
                self.contract.user_speech_started();
                self.eot_gap_gen += 1;
                self.eot_requested = false;
                if let Some(s) = &mut self.snap {
                    s.event("speech_start", &[]);
                }
                // 用户开口:取消假打断定时(保留 paused);agent 未出声(thinking)则先按住
                self.false_deadline = None;
                if self.state != AgentState::Speaking
                    && self.paused.is_none()
                    && let Some(turn) = &self.agent_turn
                    && !turn.task.is_finished()
                {
                    turn.ctl.pause();
                    self.paused = Some(Duration::ZERO); // 停说即恢复,除非升格为真打断窗
                }
            }
            VadEvent::SpeechEnd => {
                self.turn_gate
                    .on_speech_end(now, Duration::from_secs_f32(gate.min_silence_s()));
                self.eot_requested = false;
                if let Some(timeout) = self.paused {
                    self.false_deadline = Some(now + timeout);
                }
                if let Some(s) = &mut self.snap {
                    s.event("speech_end", &[]);
                }
            }
            VadEvent::None => {}
        }
        if gate.speaking() {
            if active_frame && self.eot_requested {
                // 说话恢复:上一静音窗的预测作废(框架 cancel_inference 同款)
                self.eot_gap_gen += 1;
                self.eot_requested = false;
                self.turn_gate.on_speech_start();
            }
            if !active_frame && !self.eot_requested && gate.silence_dur_s() >= 0.2 {
                // 静音累积 ≥200ms:跑 EOT(每静音窗一次)。ring 采集关=1.2s/开=8s,
                // predict 内部恒取尾 1.2s(EOT_MAX_SAMPLES),判停行为与 ring 容量无关。
                self.eot_requested = true;
                let gap_gen = self.eot_gap_gen;
                let snapshot: Vec<i16> = eot_ring.iter().copied().collect();
                // 采集旁路:8s 窗落 wav + 触发点事件(seq↔gap_gen 对齐概率回包)
                if let Some(s) = &mut self.snap {
                    let seq = s.snapshot(&snapshot);
                    s.event("eot_request", &[
                        ("seq", &seq.map_or("capped".into(), |v| v.to_string())),
                        ("gap_gen", &gap_gen.to_string()),
                        ("silence_ms", &format!("{:.0}", f64::from(gate.silence_dur_s()) * 1000.0)),
                        ("speech_s", &format!("{:.2}", gate.speech_dur_s())),
                    ]);
                }
                let tx = self.eot_tx.clone();
                tokio::spawn(async move {
                    if let Some(c) = EotClient::global().await
                        && let Ok(p) = c.predict(&snapshot).await
                    {
                        let _ = tx.send((gap_gen, p)).await;
                    }
                });
            }
            if gate.speech_dur_s() >= self.cfg.min_interruption_duration {
                self.try_interrupt_by_audio(now);
            }
        }
    }

    fn on_interim(&mut self, t: String) {
        self.contract.user_transcript_interim();
        self.tr.user_interim(&t);
        self.tele_text = t.clone();
        let now_ms = self.now_ms();
        self.pf.on_interim(&t, now_ms);
        self.check_hotword(&t);
        self.latest_interim = t;
    }

    fn on_final(&mut self, t: String) {
        self.contract.user_transcript_final();
        self.tr.user_final(&t);
        self.tele_text = t.clone();
        self.pf.reset(); // definite 提交后,下个句段重新允许投机
        self.check_hotword(&t);
        self.turn_gate.on_final(&t, Instant::now());
        self.latest_interim.clear();
        if let Some(s) = &mut self.snap {
            s.event("user_final", &[("text", &self.tele_text)]);
        }
    }

    /// 急停白名单(P0):仅 agent 出声中触发;标准化精确命中 → 绕字数门硬打断。
    fn check_hotword(&mut self, text: &str) {
        if self.state != AgentState::Speaking || self.cfg.hotwords.is_empty() {
            return;
        }
        let norm = normalize_utterance(text);
        if self.cfg.hotwords.contains(&norm) {
            info!(room = %self.room_name, "急停白名单命中: '{norm}' → interrupt");
            self.hard_abort_current();
        }
    }

    /// 音频活动打断(框架 _interrupt_by_audio_activity):AEC 窗内禁;字数门;
    /// 过门 → pause + 假打断窗(已 pause 则升格 timeout)。
    fn try_interrupt_by_audio(&mut self, now: Instant) {
        if self.aec_active(now) {
            return;
        }
        if self.resume_grace.map(|g| now < g).unwrap_or(false) {
            return;
        }
        if self.cfg.min_interruption_words > 0 {
            let chars = self
                .turn_gate
                .pending()
                .chars()
                .chain(self.latest_interim.chars())
                .filter(|c| !c.is_whitespace())
                .count();
            if chars < self.cfg.min_interruption_words {
                return;
            }
        }
        let Some(turn) = &self.agent_turn else { return };
        if turn.task.is_finished() {
            return;
        }
        self.false_deadline = None;
        if self.paused.is_none() {
            turn.ctl.pause();
            self.paused = Some(self.cfg.false_interruption_timeout);
            self.set_state(AgentState::Listening);
        } else {
            // thinking-pause(timeout=0)升格为真打断窗
            self.paused = Some(self.cfg.false_interruption_timeout);
        }
    }

    /// 硬打断:杀任务+清播放队列+历史截断为真实播出部分(暂存,下轮 LLM 请求前落账)。
    /// 处理设备下发的控制包。cancel 走**硬 abort**(川哥 2026-08-15 拍板):
    /// 用户明确按了停,不进 pause+假打断窗口,不等 1.5s 定时器判断是不是说错话。
    async fn on_control(
        &mut self,
        ev: &control::Envelope,
        kind: control::Inbound,
        identity: Option<&str>,
    ) {
        match kind {
            control::Inbound::CanarySay => self.on_canary_say(ev, identity),
            control::Inbound::Bypass => {
                // 芯片唤醒/VAD/命令词:只记录,**绝不改变 worker 的 turn 判定**。
                // worker 持有完整音频流,判停与打断以它为权威(合同 §5.3)。
                info!(room = %self.room_name, trace_id = %ev.trace_id, kind = %ev.kind,
                      "control 旁路事件(不影响主链路)");
            }
            control::Inbound::Cancel => {
                let first = self.ctrl_dedup.first_time(&ev.trace_id, ev.seq);
                // 有在说的 turn 才谈得上"取消";没有则 cancelled=false 但不报错
                let had_turn = self.agent_turn.is_some();
                let cancelled = first && had_turn;
                if cancelled {
                    self.hard_abort_current();
                    self.set_state(AgentState::Listening);
                }
                info!(room = %self.room_name, trace_id = %ev.trace_id, seq = ev.seq,
                      cancelled, already_done = !first, had_turn,
                      "control cancel");
                self.publish_json(
                    control::TOPIC,
                    control::cancel_ack(
                        &ev.trace_id,
                        ev.seq,
                        self.now_ms() as i64,
                        cancelled,
                        !first,
                    ),
                );
            }
        }
    }

    /// canary.say(S2B1 联调):校验链顺序=开关/白名单 → 文本 → 时钟偏差 → 幂等 → 忙。
    /// 只有真正启动 turn 才落幂等表——被拒的 seq 必须可重试。
    /// 完整文本绝不进日志(只打 test_id 与字符数)。
    fn on_canary_say(&mut self, ev: &control::Envelope, identity: Option<&str>) {
        // ⚠️ 必须用 epoch 毫秒:包内 ts_ms 是设备的 epoch 时间,而 self.now_ms()
        // 是 pipeline 启动起算的单调毫秒——拿它比对会恒判 stale(2026-08-16 E2E 实证)。
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let allowed = self.cfg.canary_say_enabled
            && identity
                .map(|i| self.cfg.canary_identity_allow.iter().any(|a| a == i))
                .unwrap_or(false);
        let test_id = ev
            .payload
            .get("test_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let text = ev
            .payload
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let chars = text.chars().count();

        let reject = |o: &Self, accepted: bool, already: bool, reason: &str| {
            info!(room = %o.room_name, trace_id = %ev.trace_id, seq = ev.seq,
                  test_id = %test_id, identity = identity.unwrap_or("-"),
                  text_chars = chars, accepted, reason, "canary.say rejected/acked");
            o.publish_json(
                control::TOPIC,
                control::canary_say_ack(&ev.trace_id, ev.seq, ts, accepted, already, reason),
            );
        };
        if !allowed {
            return reject(self, false, false, "disabled");
        }
        if test_id.is_empty() || chars == 0 || chars > control::CANARY_TEXT_MAX {
            return reject(self, false, false, "invalid_text");
        }
        if ev.ts_ms > 0 && (ts - ev.ts_ms).abs() > control::CANARY_STALE_SKEW_MS {
            return reject(self, false, false, "stale_trace");
        }
        if self.canary_dedup.seen(&ev.trace_id, ev.seq) {
            return reject(self, true, true, "already_done");
        }
        if self.agent_turn.is_some() || self.canary_pending.is_some() {
            return reject(self, false, false, "already_running");
        }

        self.canary_dedup.first_time(&ev.trace_id, ev.seq);
        self.start_turn(TurnKind::Say(text.to_string()));
        let Some(turn) = self.agent_turn.as_ref() else {
            // start_turn 失败不该发生;发生了宁可不留 pending,也不能让 metrics 悬空
            warn!(room = %self.room_name, "canary.say start_turn 后 turn 缺失");
            return;
        };
        self.canary_pending = Some(CanaryPending {
            test_id: test_id.clone(),
            trace_id: ev.trace_id.clone(),
            seq: ev.seq,
            turn_id: turn.id,
            stats: turn.ctl.final_stats_handle(),
        });
        info!(room = %self.room_name, trace_id = %ev.trace_id, seq = ev.seq,
              test_id = %test_id, text_chars = chars, turn_id = turn.id,
              "canary.say accepted, formal say turn started");
        self.publish_json(
            control::TOPIC,
            control::canary_say_ack(&ev.trace_id, ev.seq, ts, true, false, "ok"),
        );
    }

    /// 终态就绪(播完或取消,BufferWatch Drop 已写槽)→ 发一次 final metrics。
    /// PlayedOut 时立即调;on_tick 兜底(cancel 场景的 Drop 是异步的,晚到几十 ms)。
    fn try_flush_canary_metrics(&mut self) {
        let Some(p) = &self.canary_pending else {
            return;
        };
        let Some(fs) = p.stats.lock().ok().and_then(|g| g.clone()) else {
            return;
        };
        let epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let msg =
            control::canary_metrics(&p.trace_id, p.seq, epoch_ms, &p.test_id, &fs);
        info!(room = %self.room_name, test_id = %p.test_id, turn_id = p.turn_id,
              audio_duration_ms = fs.played_frames * 10,
              underrun_count = fs.underrun_count, underrun_ms = fs.underrun_ms,
              buffered_audio_ms = fs.buffered_audio_ms, played_frames = fs.played_frames,
              completed = fs.completed, "canary.say final metrics sent");
        self.publish_json(control::TOPIC, msg);
        self.canary_pending = None;
    }

    fn hard_abort_current(&mut self) {
        let Some(turn) = self.agent_turn.take() else {
            return;
        };
        let played = turn.ctl.played_samples();
        turn.ctl.abort();
        turn.task.abort();
        self.source.clear_buffer();
        let synth = turn
            .synth_text
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();
        let progress = turn.progress.lock().map(|p| p.clone()).unwrap_or_default();
        let spoken = truncate_spoken(&synth, &progress, played);
        // 字幕:在播句按截断文本收尾 final(Python flush 已推送部分同义)
        self.tr_flush_on_abort(turn.id, &synth, &progress, &spoken, played);
        info!(
            room = %self.room_name,
            played_samples = played,
            synth_chars = synth.chars().count(),
            spoken_chars = spoken.chars().count(),
            "agent turn aborted, history truncated to spoken part"
        );
        self.pending_amend = Some(spoken);
        self.paused = None;
        self.false_deadline = None;
        self.set_state(AgentState::Listening);
    }

    /// 字幕逐句推进:句进入播出 → interim(整句);句播完 → final。50ms tick 驱动。
    fn publish_agent_progress(&mut self) {
        let Some(turn) = &self.agent_turn else { return };
        if !turn.ctl.audio_started() {
            return;
        }
        let played = turn.ctl.played_samples();
        let turn_id = turn.id;
        let synth = turn
            .synth_text
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();
        let progress = turn.progress.lock().map(|p| p.clone()).unwrap_or_default();
        for (i, span) in sentence_spans(&synth, &progress).iter().enumerate() {
            if i >= self.tr_started && played >= span.start_samples {
                self.tr.agent_segment(turn_id, i, &span.text, false);
                self.tr_started = i + 1;
            }
            if i >= self.tr_finaled && played >= span.end_samples {
                self.tr.agent_segment(turn_id, i, &span.text, true);
                self.tr_finaled = i + 1;
            }
        }
    }

    /// 打断收尾:已播完句补 final,在播句发截断部分 final,未开播句不发。
    fn tr_flush_on_abort(
        &mut self,
        turn_id: u64,
        synth: &str,
        progress: &[(usize, u64)],
        spoken: &str,
        played: u64,
    ) {
        let spoken_chars = spoken.chars().count();
        for (i, span) in sentence_spans(synth, progress).iter().enumerate() {
            if i < self.tr_finaled {
                continue;
            }
            if played >= span.end_samples {
                self.tr.agent_segment(turn_id, i, &span.text, true);
                self.tr_finaled = i + 1;
            } else if played > span.start_samples && spoken_chars > span.char_start {
                let partial: String = spoken.chars().skip(span.char_start).collect();
                self.tr.agent_segment(turn_id, i, &partial, true);
                self.tr_finaled = i + 1;
                break;
            } else {
                break;
            }
        }
    }

    /// 自然播完收尾:剩余未 final 的句(含 tick 竞态漏发的)全文补 final。
    fn tr_finish_turn(&mut self) {
        let Some(turn) = &self.agent_turn else { return };
        let turn_id = turn.id;
        let synth = turn
            .synth_text
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();
        let progress = turn.progress.lock().map(|p| p.clone()).unwrap_or_default();
        let spans = sentence_spans(&synth, &progress);
        for (i, span) in spans.iter().enumerate() {
            if i >= self.tr_finaled {
                self.tr.agent_segment(turn_id, i, &span.text, true);
            }
        }
        self.tr_started = spans.len();
        self.tr_finaled = spans.len();
    }

    fn on_turn_event(&mut self, te: TurnEvent) {
        match te {
            TurnEvent::AudioStarted(id) => {
                if self.agent_turn.as_ref().map(|t| t.id) != Some(id) {
                    return; // 已被替换的旧 turn,忽略
                }
                self.set_state(AgentState::Speaking);
                // AEC warmup:首次开口起 one-shot(框架同款,窗口内禁音频路打断)
                if !self.aec_armed {
                    self.aec_armed = true;
                    self.aec_deadline = Some(Instant::now() + self.cfg.aec_warmup_duration);
                    info!(room = %self.room_name, "aec warmup active, disabling interruptions for {:.2}s",
                        self.cfg.aec_warmup_duration.as_secs_f32());
                }
            }
            TurnEvent::PlayedOut(id) => {
                if self.agent_turn.as_ref().map(|t| t.id) != Some(id) {
                    return;
                }
                self.tr_finish_turn(); // 字幕:剩余句补 final(先于清 turn)
                self.agent_turn = None; // 任务已自然结束
                // canary turn:Say 块里 playout_task.await 先于 PlayedOut,终态必已定格
                self.try_flush_canary_metrics();
                self.paused = None;
                self.false_deadline = None;
                self.contract.agent_transcript_final();
                // 自然播完≠被插话:清残留 interim,否则 set_state 的 speaking→listening
                // 会把它当"真插话"记 last_interrupt_at → 播完后 5s 内的下一轮全被误判
                // boost,barge 桶文案落在非打断语境(2026-08-16「先你的。」实证)
                self.tele_text.clear();
                self.set_state(AgentState::Listening);
            }
        }
    }

    async fn on_tick(&mut self) {
        // cancel 掉的 canary:turn.task.abort() 后 BufferWatch Drop 异步落槽,tick 兜底补发
        self.try_flush_canary_metrics();
        let now = Instant::now();
        // 字幕逐句推进(按播出位置;pause 时 played 冻结自然停发)
        self.publish_agent_progress();
        // 假打断定时:超时无 turn → resume 续播(渐起由 playout 配置)+ 契约 FalseInterruption
        if let Some(dl) = self.false_deadline
            && now >= dl
        {
            self.false_deadline = None;
            if self.paused.take().is_some() {
                if let Some(turn) = &self.agent_turn
                    && !turn.task.is_finished()
                {
                    turn.ctl.resume();
                    self.resume_grace = Some(now + Duration::from_millis(250));
                    self.set_state(AgentState::Speaking);
                    info!(room = %self.room_name, "resumed false interrupted speech");
                }
                self.contract.false_interruption();
            }
        }
        // 判停提交
        if let Some(commit) = self.turn_gate.poll_commit(now) {
            let user_text = commit.text;
            // 有在途回答(播放中/已 pause/生成中)→ 提交即接管:硬打断再开新轮
            if self.agent_turn.is_some() {
                self.hard_abort_current();
            }
            self.contract.user_turn_committed();
            if let Some(s) = &mut self.snap {
                s.event("turn_commit", &[
                    ("text", &user_text),
                    ("eou_ms", &commit.eou_delay.as_millis().to_string()),
                ]);
            }
            info!(
                room = %self.room_name,
                eou_ms = commit.eou_delay.as_millis() as u64,
                stt_ms = commit.stt_delay.as_millis() as u64,
                "turn committed: {user_text}"
            );
            self.publish_json(
                "metrics",
                json!({
                    "k": "eou",
                    "eou_ms": commit.eou_delay.as_millis() as u64,
                    "stt_ms": commit.stt_delay.as_millis() as u64,
                }),
            );
            self.latest_interim.clear();
            self.set_state(AgentState::Thinking);
            // 声纹旁路:消费本轮音频异步比对(fire-and-forget,首句识别第二句起生效)
            if let Some(sp) = self.speaker.as_mut() {
                sp.on_turn();
            }
            let amend = self.pending_amend.take();
            // S1v3 投机核销:提交文本全等 + 历史版本未变 → 复用;否则作废。
            // try_lock 同 start_speculation 的死锁红线:锁被回复流持着(上一轮孙任务
            // 尚未退出)时当 miss 丢投机,绝不阻塞主循环。
            let spec = match self.spec.take() {
                Some(sp) => match self.llm.try_lock() {
                    Ok(llm_guard) => {
                        let ver_now = llm_guard.history_version();
                        drop(llm_guard);
                        if sp.text == user_text && sp.version == ver_now {
                            info!(
                                room = %self.room_name,
                                lead_ms = sp.started.elapsed().as_millis() as u64,
                                "using preemptive generation"
                            );
                            Some(sp)
                        } else {
                            info!(
                                room = %self.room_name,
                                spec_text = %sp.text.chars().take(24).collect::<String>(),
                                "preemptive miss (text/ctx changed), discarding"
                            );
                            sp.task.abort();
                            None
                        }
                    }
                    Err(_) => {
                        info!(room = %self.room_name, "preemptive miss (llm busy), discarding");
                        sp.task.abort();
                        None
                    }
                },
                None => None,
            };
            // 承接音:打断轮(5s 窗)必播,其余按桶概率
            let boost = self
                .last_interrupt_at
                .map(|t| t.elapsed() < Duration::from_secs(5))
                .unwrap_or(false);
            let filler = self.bank.as_mut().and_then(|b| b.pick(&user_text, boost));
            self.start_turn(TurnKind::Reply {
                user_text,
                pending_amend: amend,
                filler,
                spec,
            });
        }
    }

    fn start_turn(&mut self, kind: TurnKind) {
        self.next_turn_id += 1;
        let id = self.next_turn_id;
        self.tr_started = 0;
        self.tr_finaled = 0;
        let (pcm_tx, pcm_rx) = mpsc::channel::<Vec<u8>>(32);
        let (playout_task, ctl) =
            playout::spawn_playout(self.source.clone(), pcm_rx, self.room_name.clone(), id);
        let synth_text = Arc::new(StdMutex::new(String::new()));
        let progress = Arc::new(StdMutex::new(Vec::new()));

        // 开播观察者:首帧 capture → AudioStarted(agent_state=speaking 的时刻语义)。
        // 退出条件必须含 abort:hard_abort 只杀外层 turn task,detached 的观察者
        // 若 turn 未开播就被打断会永转(dev198 内存排查时发现的隐性泄漏)。
        let watch_ctl = ctl.clone();
        let watch_tx = self.turn_ev_tx.clone();
        let watcher = tokio::spawn(async move {
            loop {
                if watch_ctl.aborted() {
                    return;
                }
                if watch_ctl.audio_started() {
                    let _ = watch_tx.send(TurnEvent::AudioStarted(id)).await;
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });

        let tts_cfg = self.tts_cfg.clone();
        let llm = self.llm.clone();
        let room_name = self.room_name.clone();
        let ev_tx = self.turn_ev_tx.clone();
        let min_len = self.cfg.tts_min_sentence_len;
        let synth2 = synth_text.clone();
        let prog2 = progress.clone();
        let lp = self.participant.clone();
        // 合成侧要能看见打断信号(讯飞在 pause 期间不能裸 send,见 tts_xfyun::send_or_abort);
        // ctl 本体后面还要交给 AgentTurn,这里克隆一份进 task。
        let ctl_tts = ctl.clone();
        // turn 一开始就起预建连流水线:它与下面的 LLM 请求并行跑,
        // 等第一句文本出来时握手早已完成 → 首句省掉 ~220ms 建连。
        // (火山线返回关闭态,行为不变)
        let mut warm = tts_cfg.start_prewarm();

        let task = tokio::spawn(async move {
            let publish = |v: Value| {
                let p = lp.clone();
                tokio::spawn(async move {
                    let _ = p
                        .publish_data(DataPacket {
                            payload: v.to_string().into_bytes(),
                            topic: Some("metrics".into()),
                            reliable: true,
                            ..Default::default()
                        })
                        .await;
                });
            };
            let mut samples_cum: u64 = 0;
            let mut chars_cum: usize = 0;
            let mut track = |sentence: &str, bytes: usize| {
                samples_cum += (bytes / 2) as u64;
                chars_cum += sentence.chars().count();
                if let Ok(mut s) = synth2.lock() {
                    s.push_str(sentence);
                }
                if let Ok(mut p) = prog2.lock() {
                    p.push((chars_cum, samples_cum));
                }
            };
            match kind {
                TurnKind::Say(text) => {
                    match tts_cfg
                        .synthesize(&text, &pcm_tx, &ctl_tts, &mut warm)
                        .await
                    {
                        Ok((ttfb, bytes)) => {
                            info!(room = %room_name, ttfb_ms = ttfb, bytes, "say synthesized");
                            publish(json!({"k": "tts", "ttfb_ms": ttfb}));
                            track(&text, bytes);
                        }
                        Err(e) => warn!(room = %room_name, error = %e, "say tts failed"),
                    }
                    drop(pcm_tx);
                    let _ = playout_task.await;
                    watcher.abort();
                    // 自然播完:固定句全文入历史(say add_to_chat_ctx 语义)
                    llm.lock().await.push_assistant(&text);
                    let _ = ev_tx.send(TurnEvent::PlayedOut(id)).await;
                }
                TurnKind::Reply {
                    user_text,
                    pending_amend,
                    filler,
                    spec,
                } => {
                    // 承接音先入轨(同轨串行,盖住 LLM+TTS 首音;不进历史/不计截断字符
                    // ——track 空句=只登记样本偏移,截断映射因此对齐)
                    if let Some((_ftext, fpcm)) = filler {
                        track("", fpcm.len());
                        let _ = pcm_tx.send(fpcm).await;
                    }
                    // LLM 流:投机命中→消费投机流(需手动落账);未命中→常规 chat(自落账)
                    let (mut delta_rx, llm_join, spec_mode) = match spec {
                        Some(sp) => {
                            {
                                let mut g = llm.lock().await;
                                if let Some(spoken) = pending_amend {
                                    g.set_last_assistant(&spoken);
                                }
                                g.push_user(&user_text);
                            }
                            (sp.rx, sp.task, true)
                        }
                        None => {
                            let (delta_tx, delta_rx) = mpsc::channel::<String>(64);
                            let llm2 = llm.clone();
                            let ut = user_text.clone();
                            let h = tokio::spawn(async move {
                                let mut g = llm2.lock().await;
                                // 上一轮被打断的历史修正在同一把锁内先落账,保证消息顺序
                                if let Some(spoken) = pending_amend {
                                    g.set_last_assistant(&spoken);
                                }
                                g.chat(&ut, delta_tx).await
                            });
                            (delta_rx, h, false)
                        }
                    };
                    let mut seg = Segmenter::new(min_len);
                    while let Some(delta) = delta_rx.recv().await {
                        for sentence in seg.feed(&delta) {
                            match tts_cfg
                                .synthesize(&sentence, &pcm_tx, &ctl_tts, &mut warm)
                                .await
                            {
                                Ok((ttfb, bytes)) => {
                                    publish(json!({"k": "tts", "ttfb_ms": ttfb}));
                                    track(&sentence, bytes);
                                }
                                Err(e) => {
                                    warn!(room = %room_name, error = %e, "tts synthesize failed");
                                }
                            }
                        }
                    }
                    if let Some(tail) = seg.flush() {
                        match tts_cfg
                            .synthesize(&tail, &pcm_tx, &ctl_tts, &mut warm)
                            .await
                        {
                            Ok((ttfb, bytes)) => {
                                publish(json!({"k": "tts", "ttfb_ms": ttfb}));
                                track(&tail, bytes);
                            }
                            Err(e) => {
                                warn!(room = %room_name, error = %e, "tts synthesize failed (tail)")
                            }
                        }
                    }
                    match llm_join.await {
                        Ok(Ok(outcome)) => {
                            if spec_mode {
                                llm.lock().await.settle(&outcome);
                            }
                            // tps=字符/秒近似(SSE chunk≠token,诚实口径;web 面板显示用)
                            publish(json!({
                                "k": "llm",
                                "ttft_ms": outcome.ttft_ms,
                                "tps": outcome.tps(),
                            }));
                        }
                        Ok(Err(e)) => warn!(room = %room_name, error = %e, "llm chat failed"),
                        Err(e) => warn!(room = %room_name, error = %e, "llm task join failed"),
                    }
                    drop(pcm_tx);
                    let _ = playout_task.await;
                    watcher.abort();
                    let _ = ev_tx.send(TurnEvent::PlayedOut(id)).await;
                }
            }
        });
        self.agent_turn = Some(AgentTurn {
            id,
            task,
            ctl,
            synth_text,
            progress,
        });
    }
}

/// 已播样本数 → 真实说出的文本(整句边界 + 句内按样本比例折算字符,截断历史用)。
fn truncate_spoken(synth: &str, progress: &[(usize, u64)], played_samples: u64) -> String {
    if synth.is_empty() || progress.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = synth.chars().collect();
    let mut prev_chars = 0usize;
    let mut prev_samples = 0u64;
    for &(chars_cum, samples_cum) in progress {
        if played_samples >= samples_cum {
            prev_chars = chars_cum;
            prev_samples = samples_cum;
            continue;
        }
        // 播到本句中途:按样本比例折算字符数
        let sent_samples = samples_cum - prev_samples;
        let sent_chars = chars_cum - prev_chars;
        if sent_samples == 0 {
            break;
        }
        let frac = (played_samples - prev_samples) as f64 / sent_samples as f64;
        let extra = (sent_chars as f64 * frac).floor() as usize;
        prev_chars += extra;
        break;
    }
    chars.into_iter().take(prev_chars).collect()
}

#[cfg(test)]
mod greeting_gate_tests {
    use super::{parse_flag, should_greet};

    // --- 开关解析(codex 联调规格 §4.1 逐行对应) -------------------------------

    #[test]
    fn unset_defaults_to_enabled() {
        // 未设置 → true。这条守的是「不影响其他既有环境」的兼容承诺。
        assert!(parse_flag(None, true));
    }

    #[test]
    fn truthy_values_enable() {
        for v in ["1", "true", "yes", "on", "TRUE", "On", " yes "] {
            assert!(parse_flag(Some(v), false), "{v:?} 应解析为开启");
        }
    }

    #[test]
    fn falsy_values_disable() {
        for v in ["0", "false", "no", "off", "FALSE", "Off", " 0 "] {
            assert!(!parse_flag(Some(v), true), "{v:?} 应解析为关闭");
        }
    }

    #[test]
    fn invalid_value_falls_back_to_default_without_panic() {
        // 非法值不 panic,回退默认——且要证明「回退」是真的跟随 default,
        // 不是碰巧返回了固定值:同一个非法输入,两个 default 必须给出两个结果。
        assert!(parse_flag(Some("maybe"), true));
        assert!(!parse_flag(Some("maybe"), false));
        assert!(parse_flag(Some(""), true));
        assert!(!parse_flag(Some(""), false));
    }

    // --- 门禁判据(测的是生产那条 should_greet,不是测试里重写的条件) -----------

    #[test]
    fn enabled_with_text_greets() {
        // 正例锚:没有它,下面三条「不播」全绿也可能只是函数恒假。
        assert!(should_greet(true, "你好，我在。"));
    }

    #[test]
    fn disabled_with_nonempty_text_does_not_greet() {
        assert!(!should_greet(false, "你好，我在。"));
    }

    #[test]
    fn enabled_with_empty_text_does_not_greet() {
        // 对齐 Python 侧「AGENT_GREETING 为空即静默」的既有约定。
        assert!(!should_greet(true, ""));
    }

    #[test]
    fn enabled_with_whitespace_only_text_does_not_greet() {
        // 全空白等价于空:否则会拿空白串去合成,产出一段无声 PCM。
        assert!(!should_greet(true, "  \n\t "));
    }

    #[test]
    fn disabled_and_empty_does_not_greet() {
        assert!(!should_greet(false, ""));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_spoken_by_sentence_and_fraction() {
        // 两句:"你好呀"(3字,2400样本)+"今天天气不错"(6字,4800样本)
        let synth = "你好呀今天天气不错";
        let progress = vec![(3, 2400), (9, 7200)];
        assert_eq!(truncate_spoken(synth, &progress, 0), "");
        assert_eq!(truncate_spoken(synth, &progress, 2400), "你好呀");
        // 第二句播一半(2400/4800)→ 3 + 3 字
        assert_eq!(truncate_spoken(synth, &progress, 4800), "你好呀今天天");
        assert_eq!(
            truncate_spoken(synth, &progress, 99999),
            "你好呀今天天气不错"
        );
    }

    #[test]
    fn truncate_spoken_empty_progress_is_empty() {
        assert_eq!(truncate_spoken("文本", &[], 1000), "");
        assert_eq!(truncate_spoken("", &[(1, 100)], 1000), "");
    }
}
