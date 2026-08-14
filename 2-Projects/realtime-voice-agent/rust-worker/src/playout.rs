//! 可暂停播放器(对齐 room_io _output.py pause/resume 语义):
//! - pause():仅停止继续喂帧,RTC source 里已排队的 ≤200ms 自然播完(Python 同款,
//!   clear_queue 被注释掉);resume() 继续喂,可选渐起(fade_output.py FadeInAudioOutput)。
//! - 硬打断:abort + source.clear_buffer()(丢弃排队尾音,立即静音)。
//! - 进度:captured_samples 计数;真实已播 ≈ min(首帧起 wall-clock, captured)
//!   (capture 被 200ms 队列背压限速,近似实时,用于打断后历史截断)。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::tts_volc::TTS_SAMPLE_RATE;

#[derive(Clone)]
pub struct PlayoutControl {
    pause_tx: watch::Sender<bool>,
    abort_tx: watch::Sender<bool>,
    captured: Arc<AtomicU64>,       // 已喂 RTC 的样本数
    first_frame_us: Arc<AtomicU64>, // 首帧时刻(us since anchor);0=未开播
    anchor: Instant,
    fade_ms: u32,
    fade_req: Arc<AtomicU64>, // resume 渐起请求(置 1=下帧起从 0 爬回)
}

/// 单测专用:只造控制句柄,不起播放循环(那需要真的 NativeAudioSource)。
/// 返回 `(守住 watch 接收端的 guard, ctl)`——guard 必须活着,
/// 否则 `watch::Sender` 会因无接收端而让 `send` 失败,`abort()` 就成了空操作。
#[cfg(test)]
pub fn test_control() -> ((watch::Receiver<bool>, watch::Receiver<bool>), PlayoutControl) {
    let (pause_tx, pause_rx) = watch::channel(false);
    let (abort_tx, abort_rx) = watch::channel(false);
    let ctl = PlayoutControl {
        pause_tx,
        abort_tx,
        captured: Arc::new(AtomicU64::new(0)),
        first_frame_us: Arc::new(AtomicU64::new(0)),
        anchor: Instant::now(),
        fade_ms: 0,
        fade_req: Arc::new(AtomicU64::new(0)),
    };
    ((pause_rx, abort_rx), ctl)
}

impl PlayoutControl {
    pub fn pause(&self) {
        let _ = self.pause_tx.send(true);
    }

    pub fn resume(&self) {
        if self.fade_ms > 0 {
            self.fade_req.store(1, Ordering::SeqCst);
        }
        let _ = self.pause_tx.send(false);
    }

    /// 硬打断:播放循环立即退出(channel 里囤的音频一并丢弃;RTC 队列由调用方 clear)。
    pub fn abort(&self) {
        let _ = self.abort_tx.send(true);
        let _ = self.pause_tx.send(false); // 唤醒可能阻塞在暂停门上的循环
    }

    /// turn 的开播观察者依赖此退出条件:硬打断后未开播的 turn,观察者不得永转。
    pub fn aborted(&self) -> bool {
        *self.abort_tx.borrow()
    }

    /// 是否已真正开始出声(首帧已 capture)。
    pub fn audio_started(&self) -> bool {
        self.first_frame_us.load(Ordering::SeqCst) != 0
    }

    /// 估算已播出的样本数(24k):首帧起 wall-clock 与已喂样本取小。
    pub fn played_samples(&self) -> u64 {
        let first = self.first_frame_us.load(Ordering::SeqCst);
        if first == 0 {
            return 0;
        }
        let elapsed_us = self.anchor.elapsed().as_micros() as u64 - first;
        let by_clock = elapsed_us * u64::from(TTS_SAMPLE_RATE) / 1_000_000;
        by_clock.min(self.captured.load(Ordering::SeqCst))
    }
}

/// PCM(24k i16le bytes)→ 10ms 帧逐帧 capture;暂停门 + 渐起 + 进度计数。
/// RTC source 队列 200ms 背压限速(与 Python room_io queue_size_ms=200 对齐)。
pub fn spawn_playout(
    source: NativeAudioSource,
    mut pcm_rx: mpsc::Receiver<Vec<u8>>,
) -> (JoinHandle<()>, PlayoutControl) {
    let (pause_tx, mut pause_rx) = watch::channel(false);
    let (abort_tx, mut abort_rx) = watch::channel(false);
    let ctl = PlayoutControl {
        pause_tx,
        abort_tx,
        captured: Arc::new(AtomicU64::new(0)),
        first_frame_us: Arc::new(AtomicU64::new(0)),
        anchor: Instant::now(),
        fade_ms: std::env::var("POC_RESUME_FADE_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
        fade_req: Arc::new(AtomicU64::new(0)),
    };
    let ctl2 = ctl.clone();
    let task = tokio::spawn(async move {
        const FRAME_SAMPLES: usize = (TTS_SAMPLE_RATE as usize) / 100; // 10ms
        let mut residual: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES * 2);
        // 渐起状态:>0 时逐样本乘增益爬坡(fade_output.py fade_gains 同款线性)
        let mut fade_gain: f32 = 1.0;
        let fade_step: f32 = if ctl2.fade_ms > 0 {
            1.0 / (TTS_SAMPLE_RATE as f32 * ctl2.fade_ms as f32 / 1000.0)
        } else {
            0.0
        };
        loop {
            if *abort_rx.borrow() {
                return;
            }
            // 暂停门:置 true 时停喂(source 内 ≤200ms 排队自然播完)
            while *pause_rx.borrow() {
                if pause_rx.changed().await.is_err() {
                    return;
                }
            }
            let chunk = tokio::select! {
                c = pcm_rx.recv() => match c { Some(c) => c, None => break },
                _ = abort_rx.changed() => return,
            };
            let mut samples: Vec<i16> =
                chunk.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
            residual.append(&mut samples);
            while residual.len() >= FRAME_SAMPLES {
                if *abort_rx.borrow() {
                    return;
                }
                while *pause_rx.borrow() {
                    if pause_rx.changed().await.is_err() {
                        return;
                    }
                }
                if ctl2.fade_req.swap(0, Ordering::SeqCst) != 0 {
                    fade_gain = 0.0; // resume 渐起:从静音爬回
                }
                let mut frame_data: Vec<i16> = residual.drain(..FRAME_SAMPLES).collect();
                if fade_gain < 1.0 {
                    for s in &mut frame_data {
                        *s = (f32::from(*s) * fade_gain) as i16;
                        fade_gain = (fade_gain + fade_step).min(1.0);
                    }
                }
                let frame = AudioFrame {
                    data: frame_data.into(),
                    sample_rate: TTS_SAMPLE_RATE,
                    num_channels: 1,
                    samples_per_channel: FRAME_SAMPLES as u32,
                };
                if source.capture_frame(&frame).await.is_err() {
                    return;
                }
                ctl2.first_frame_us
                    .compare_exchange(
                        0,
                        ctl2.anchor.elapsed().as_micros().max(1) as u64,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    )
                    .ok();
                ctl2.captured.fetch_add(FRAME_SAMPLES as u64, Ordering::SeqCst);
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
            if source.capture_frame(&frame).await.is_ok() {
                ctl2.captured.fetch_add(n as u64, Ordering::SeqCst);
            }
        }
        // 收尾:等 source 队列(≤200ms)播完再退出,让 done 语义=真播完
        tokio::time::sleep(std::time::Duration::from_millis(220)).await;
    });
    (task, ctl)
}
