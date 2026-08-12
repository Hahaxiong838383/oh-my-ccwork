//! cascade 编排(P3a 最小闭环):
//! 用户音频 → STT 长连(+VAD 门控) → 判停 v1(definite+delay) → LLM → 切句 → TTS → 播放。
//!
//! 行为对齐点(P3a 范围):
//! - 判停:pending final 非空 && VAD 静音 && 距最后 definite ≥ MIN_ENDPOINTING_DELAY(0.55)
//! - 打断:agent 回答中 interim/final 字数 ≥ MIN_INTERRUPTION_WORDS(1) → 立即停播
//!   (契约日志 `interrupt telemetry: speaking→listening interim='..'` 同格式)
//! - greeting:固定句走 TTS(对齐 session.say)
//!
//! 未做(P3b):0字门+假打断恢复+渐起、急停白名单、S1 投机、EOT sidecar、赛马、TTS 池、filler。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use futures_util::StreamExt;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::llm::{Llm, LlmConfig};
use crate::segmenter::Segmenter;
use crate::stt_volc::{self, SttConfig, SttEvent};
use crate::tts_volc::{self, TtsConfig, TTS_SAMPLE_RATE};
use crate::vad::{SileroVad, VadGate, WINDOW};

pub struct PipelineConfig {
    pub min_endpointing_delay: Duration,
    pub min_interruption_words: usize,
    pub tts_min_sentence_len: usize,
    pub greeting_text: String,
    pub vad_model_path: String,
}

impl PipelineConfig {
    pub fn from_env() -> Self {
        let f = |k: &str, d: f32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        Self {
            min_endpointing_delay: Duration::from_secs_f32(f("MIN_ENDPOINTING_DELAY", 0.55)),
            min_interruption_words: std::env::var("MIN_INTERRUPTION_WORDS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1),
            tts_min_sentence_len: std::env::var("TTS_MIN_SENTENCE_LEN")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(6),
            greeting_text: std::env::var("GREETING_TEXT")
                .unwrap_or_else(|_| "你好，我在。".into()),
            vad_model_path: std::env::var("VAD_MODEL_PATH").unwrap_or_else(|_| {
                format!("{}/assets/silero_vad.onnx", env!("CARGO_MANIFEST_DIR"))
            }),
        }
    }
}

pub async fn run_pipeline(
    mut mic: NativeAudioStream,
    source: NativeAudioSource,
    room_name: String,
) -> Result<()> {
    let cfg = PipelineConfig::from_env();
    let stt_cfg = SttConfig::from_env();
    let tts_cfg = TtsConfig::from_env();
    let llm = Arc::new(Mutex::new(Llm::new(
        LlmConfig::from_env().ok_or_else(|| anyhow::anyhow!("LLM_BASE_URL 未配置"))?,
    )));

    let mut vad = SileroVad::load(&cfg.vad_model_path)?;
    let mut gate = VadGate::new(
        std::env::var("VAD_ACTIVATION_THRESHOLD").ok().and_then(|v| v.parse().ok()).unwrap_or(0.6),
        std::env::var("VAD_MIN_SPEECH_DURATION").ok().and_then(|v| v.parse().ok()).unwrap_or(0.15),
        0.3,
    );

    // STT 长连
    let (stt_pcm_tx, stt_pcm_rx) = mpsc::channel::<Vec<i16>>(128);
    let (stt_ev_tx, mut stt_ev_rx) = mpsc::channel::<SttEvent>(64);
    let stt_task = tokio::spawn({
        let stt_cfg = stt_cfg.clone();
        let rn = room_name.clone();
        async move {
            if let Err(e) = stt_volc::run_asr_stream(stt_cfg, stt_pcm_rx, stt_ev_tx).await {
                warn!(room = %rn, error = %e, "火山 ASR 流异常");
            }
        }
    });

    let speaking = Arc::new(AtomicBool::new(false));
    let mut pending_turn = String::new();
    let mut last_final_at: Option<Instant> = None;
    let mut latest_interim = String::new();
    let mut vad_buf: Vec<i16> = Vec::with_capacity(WINDOW * 2);
    // 火山按段消化音频:攒 200ms(3200 样本)一发,对齐 Python segment_duration_ms=200。
    // 逐 10ms 帧发(100 包/s 单帧 gzip)实测把 definite 拖慢数秒。
    const STT_SEGMENT_SAMPLES: usize = 3200;
    let mut stt_buf: Vec<i16> = Vec::with_capacity(STT_SEGMENT_SAMPLES * 2);
    let mut commit_tick = tokio::time::interval(Duration::from_millis(50));

    // greeting:固定句走 TTS(session.say 语义)
    let mut agent_task: Option<JoinHandle<()>> = Some(spawn_say(
        tts_cfg.clone(),
        source.clone(),
        cfg.greeting_text.clone(),
        speaking.clone(),
        room_name.clone(),
    ));

    loop {
        tokio::select! {
            frame = mic.next() => {
                let Some(frame) = frame else { break };
                let samples: Vec<i16> = frame.data.to_vec();
                stt_buf.extend_from_slice(&samples);
                if stt_buf.len() >= STT_SEGMENT_SAMPLES {
                    // 满则丢段不阻塞热路径(channel 128 段 ≈ 25s 缓冲,正常永远不满)
                    let _ = stt_pcm_tx.try_send(std::mem::take(&mut stt_buf));
                }
                vad_buf.extend_from_slice(&samples);
                while vad_buf.len() >= WINDOW {
                    let chunk: Vec<i16> = vad_buf.drain(..WINDOW).collect();
                    if let Ok(p) = vad.predict(&chunk) {
                        let _ = gate.feed(p);
                    }
                }
            }
            ev = stt_ev_rx.recv() => match ev {
                Some(SttEvent::Interim(t)) => {
                    latest_interim = t;
                    maybe_interrupt(
                        &speaking, &mut agent_task, &source,
                        &latest_interim, cfg.min_interruption_words, &room_name,
                    );
                }
                Some(SttEvent::Final(t)) => {
                    // agent 回答中的 final:同款字数门检查(Python final 路径同语义)
                    maybe_interrupt(
                        &speaking, &mut agent_task, &source,
                        &t, cfg.min_interruption_words, &room_name,
                    );
                    if !pending_turn.is_empty() {
                        pending_turn.push(' ');
                    }
                    pending_turn.push_str(&t);
                    last_final_at = Some(Instant::now());
                    latest_interim.clear();
                }
                Some(SttEvent::Closed) | None => {
                    warn!(room = %room_name, "stt 事件流结束(P3a 无重连,job 收尾)");
                    break;
                }
            },
            _ = commit_tick.tick() => {
                let agent_busy = agent_task.as_ref().map(|t| !t.is_finished()).unwrap_or(false);
                let ready = !pending_turn.is_empty()
                    && !gate.speaking()
                    && !agent_busy
                    && last_final_at.map(|t| t.elapsed() >= cfg.min_endpointing_delay).unwrap_or(false);
                if ready {
                    let user_text = std::mem::take(&mut pending_turn);
                    last_final_at = None;
                    info!(room = %room_name, "契约 UserTurnCommitted text_len={}", user_text.chars().count());
                    agent_task = Some(spawn_agent_turn(
                        llm.clone(),
                        tts_cfg.clone(),
                        source.clone(),
                        user_text,
                        speaking.clone(),
                        cfg.tts_min_sentence_len,
                        room_name.clone(),
                    ));
                }
            }
        }
    }

    if let Some(t) = agent_task.take() {
        t.abort();
    }
    drop(stt_pcm_tx);
    let _ = tokio::time::timeout(Duration::from_secs(3), stt_task).await;
    info!(room = %room_name, "pipeline closed");
    Ok(())
}

/// 打断判定+执行:agent 回答中 && 文本字数达门 → abort 回答任务 + 清播放缓冲。
fn maybe_interrupt(
    speaking: &Arc<AtomicBool>,
    agent_task: &mut Option<JoinHandle<()>>,
    source: &NativeAudioSource,
    text: &str,
    min_words: usize,
    room_name: &str,
) {
    if !speaking.load(Ordering::SeqCst) {
        return;
    }
    let n = text.trim().chars().filter(|c| !c.is_whitespace()).count();
    if n < min_words {
        return;
    }
    if let Some(t) = agent_task.take() {
        t.abort();
    }
    source.clear_buffer();
    speaking.store(false, Ordering::SeqCst);
    info!(
        room = %room_name,
        "interrupt telemetry: speaking→listening interim={:?}",
        text.chars().take(40).collect::<String>()
    );
}

/// 一轮 agent 回答:LLM 流 → 切句 → 逐句 TTS → 播放。
/// abort 安全:LLM/TTS 内联(future drop 即断连),playout 靠 pcm channel 关闭自然退出。
fn spawn_agent_turn(
    llm: Arc<Mutex<Llm>>,
    tts_cfg: TtsConfig,
    source: NativeAudioSource,
    user_text: String,
    speaking: Arc<AtomicBool>,
    min_sentence_len: usize,
    room_name: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        speaking.store(true, Ordering::SeqCst);
        info!(room = %room_name, "契约 AgentSpeechStarted (turn)");
        let (delta_tx, mut delta_rx) = mpsc::channel::<String>(64);
        let (pcm_tx, pcm_rx) = mpsc::channel::<Vec<u8>>(32);
        let playout = spawn_playout(source.clone(), pcm_rx);

        let llm2 = llm.clone();
        let user2 = user_text.clone();
        // LLM 拉流与 TTS 合成并发:LLM task 只往 delta channel 写
        let llm_task = tokio::spawn(async move {
            let mut g = llm2.lock().await;
            if let Err(e) = g.chat(&user2, delta_tx).await {
                warn!(error = %e, "llm chat failed");
            }
        });

        let mut seg = Segmenter::new(min_sentence_len);
        while let Some(delta) = delta_rx.recv().await {
            for sentence in seg.feed(&delta) {
                if let Err(e) = tts_volc::synthesize(&tts_cfg, &sentence, &pcm_tx).await {
                    warn!(room = %room_name, error = %e, "tts synthesize failed");
                }
            }
        }
        if let Some(tail) = seg.flush()
            && let Err(e) = tts_volc::synthesize(&tts_cfg, &tail, &pcm_tx).await
        {
            warn!(room = %room_name, error = %e, "tts synthesize failed (tail)");
        }
        let _ = llm_task.await;
        drop(pcm_tx);
        let _ = playout.await; // 等最后一帧入 RTC 队列(1s 队列内的余量由 RTC 播完)
        speaking.store(false, Ordering::SeqCst);
        info!(room = %room_name, "契约 AgentSpeechStopped (turn played out)");
    })
}

/// 固定句 TTS 直说(greeting 用,session.say 语义)。
fn spawn_say(
    tts_cfg: TtsConfig,
    source: NativeAudioSource,
    text: String,
    speaking: Arc<AtomicBool>,
    room_name: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        speaking.store(true, Ordering::SeqCst);
        let (pcm_tx, pcm_rx) = mpsc::channel::<Vec<u8>>(32);
        let playout = spawn_playout(source.clone(), pcm_rx);
        match tts_volc::synthesize(&tts_cfg, &text, &pcm_tx).await {
            Ok((ttfb, bytes)) => {
                info!(room = %room_name, ttfb_ms = ttfb, bytes, "greeting synthesized");
            }
            Err(e) => warn!(room = %room_name, error = %e, "greeting tts failed"),
        }
        drop(pcm_tx);
        let _ = playout.await;
        speaking.store(false, Ordering::SeqCst);
    })
}

/// PCM(24k i16le bytes)→ 10ms AudioFrame 逐帧 capture(RTC 侧 1s 队列背压限速)。
fn spawn_playout(
    source: NativeAudioSource,
    mut pcm_rx: mpsc::Receiver<Vec<u8>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        const FRAME_SAMPLES: usize = (TTS_SAMPLE_RATE as usize) / 100; // 10ms
        let mut residual: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES * 2);
        while let Some(chunk) = pcm_rx.recv().await {
            let mut samples: Vec<i16> = chunk
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect();
            residual.append(&mut samples);
            while residual.len() >= FRAME_SAMPLES {
                let frame_data: Vec<i16> = residual.drain(..FRAME_SAMPLES).collect();
                let frame = AudioFrame {
                    data: frame_data.into(),
                    sample_rate: TTS_SAMPLE_RATE,
                    num_channels: 1,
                    samples_per_channel: FRAME_SAMPLES as u32,
                };
                if source.capture_frame(&frame).await.is_err() {
                    return;
                }
            }
        }
        if !residual.is_empty() {
            let n = residual.len();
            let frame = AudioFrame {
                data: residual.into(),
                sample_rate: TTS_SAMPLE_RATE,
                num_channels: 1,
                samples_per_channel: n as u32,
            };
            let _ = source.capture_frame(&frame).await;
        }
    })
}
