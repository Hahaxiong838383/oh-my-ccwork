//! 可暂停播放器(对齐 room_io _output.py pause/resume 语义):
//! - pause():仅停止继续喂帧,RTC source 里已排队的 ≤200ms 自然播完(Python 同款,
//!   clear_queue 被注释掉);resume() 继续喂,可选渐起(fade_output.py FadeInAudioOutput)。
//! - 硬打断:abort + source.clear_buffer()(丢弃排队尾音,立即静音)。
//! - 进度:captured_samples 计数;真实已播 ≈ min(首帧起 wall-clock, captured)
//!   (capture 被 200ms 队列背压限速,近似实时,用于打断后历史截断)。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tracing::{info, warn};

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
    /// 本轮播放终态(BufferWatch Drop 时写入;None=还没结束)
    final_stats: Arc<Mutex<Option<FinalStats>>>,
}

/// 单测专用:只造控制句柄,不起播放循环(那需要真的 NativeAudioSource)。
/// 返回 `(守住 watch 接收端的 guard, ctl)`——guard 必须活着,
/// 否则 `watch::Sender` 会因无接收端而让 `send` 失败,`abort()` 就成了空操作。
#[cfg(test)]
pub fn test_control() -> (
    (watch::Receiver<bool>, watch::Receiver<bool>),
    PlayoutControl,
) {
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
        final_stats: Arc::new(Mutex::new(None)),
    };
    ((pause_rx, abort_rx), ctl)
}

impl PlayoutControl {
    /// 终态槽的共享句柄(pipeline 存进 CanaryPending,播完/取消后读)。
    pub fn final_stats_handle(&self) -> Arc<Mutex<Option<FinalStats>>> {
        self.final_stats.clone()
    }

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

/// 一帧时长(与 `FRAME_SAMPLES` 同源:24000/100 samples = 10ms)
const FRAME_MS: u64 = 10;
/// 欠载噪声地板。播放进度是**按帧累加的估计值**,不是从 RTC source 读的真实队列深度,
/// 小于两帧的缺口与调度抖动无法区分,不计。
const UNDERRUN_FLOOR_MS: u64 = 20;
/// 低水位起测阈值。turn 刚开播时缓冲天然接近 0(第一块 PCM 只有几十毫秒),
/// 不设这道门,低水位每轮都报 ~0,指标失去区分力。150 < RTC 队列 200ms 背压上限,可达。
const PRIME_MS: u64 = 150;

/// 播放缓冲欠载观测(S2-B1 合约用例 10「长句播放缓冲不 underrun」的服务端判据)。
///
/// **判据不是「channel 空了」**——讯飞吐流 1.9 倍实时,正常长句本来就会短暂空。
/// 判据是「空的时长超过了此刻还剩的缓冲」,即真的出现了**可听的静音缺口**。
///
/// 缓冲水位用「已喂音频预计播完的墙钟时刻 `play_deadline`」推算:每喂一帧后推 10ms,
/// 等待期间墙钟前进而 deadline 不动 → 差值收窄即为排空。这个模型会被
/// `capture_frame().await` 的 200ms 背压自动校准(队列满时喂帧与真实播放同速),
/// 所以误差不会随 turn 变长而无界累积。
struct BufferWatch {
    /// 终态回传槽:Drop 时把 FinalStats 写进去(pipeline 经 PlayoutControl 读)。
    /// 挂 Drop 与日志同一时机——全退出路径覆盖,不多一条也不少一条。
    sink: Arc<Mutex<Option<FinalStats>>>,
    room: String,
    turn_id: u64,
    /// 已喂出的音频预计播完的时刻。None = 尚未开播,或刚从暂停恢复(缓冲已排空,重新起算)
    play_deadline: Option<Instant>,
    /// 缓冲是否曾灌到 `PRIME_MS`。未灌满过就不采低水位,见该常量注释
    primed: bool,
    underruns: u64,
    underrun_ms: u64,
    buf_min_ms: Option<u64>,
    frames: u64,
    /// 本轮音频真正开始喂出的时刻(跨暂停不重置)。首次欠载的相对位置以它为原点。
    audio_start: Option<Instant>,
    /// 首次欠载距开播多少 ms。**这是选优化方案的判据**:
    /// 靠近 0 = 起播阶段缓冲太薄(该预缓冲/让 TTS 更早起跑);
    /// 明显靠后 = 上游中途掉链子(该并行合成下一句)。两种方案对症完全不同。
    first_underrun_ms: Option<u64>,
    why: Option<ExitWhy>,
}

impl BufferWatch {
    fn new(room: String, turn_id: u64, sink: Arc<Mutex<Option<FinalStats>>>) -> Self {
        Self {
            sink,
            room,
            turn_id,
            play_deadline: None,
            primed: false,
            underruns: 0,
            underrun_ms: 0,
            buf_min_ms: None,
            frames: 0,
            audio_start: None,
            first_underrun_ms: None,
            why: None,
        }
    }

    /// 标记退出原因。`None`(没人标)会以 `unmarked` 出现在日志里——
    /// 那本身就是信号:说明又多了一条没被标注的退出路径。
    fn exit(&mut self, why: ExitWhy) {
        self.why = Some(why);
    }

    /// 喂出一帧:预计播完时刻后推一帧。若 deadline 已过期(说明中间断过流),
    /// 从当下重新起算而不是从过去的 deadline 累加——否则缺口会被记进后续水位里。
    fn on_frame(&mut self, now: Instant) {
        let base = match self.play_deadline {
            Some(d) if d > now => d,
            _ => now,
        };
        let deadline = base + Duration::from_millis(FRAME_MS);
        self.play_deadline = Some(deadline);
        self.audio_start.get_or_insert(now); // 只记第一次,暂停恢复不重置
        self.frames += 1;
        if !self.primed
            && deadline.saturating_duration_since(now) >= Duration::from_millis(PRIME_MS)
        {
            self.primed = true;
        }
    }

    /// 一次「等 PCM」结束。`wait_start`=开始等的时刻,`now`=拿到数据的时刻。
    /// **只在真的拿到数据时调用**:channel 关闭(TTS 吐完)那次等待是本轮收尾,不是欠载。
    fn on_wait(&mut self, wait_start: Instant, now: Instant) {
        let Some(deadline) = self.play_deadline else {
            return;
        }; // 未开播,无缓冲可欠
        let buf_before = deadline.saturating_duration_since(wait_start).as_millis() as u64;
        let waited = now.saturating_duration_since(wait_start).as_millis() as u64;
        if waited > buf_before {
            let gap = waited - buf_before;
            if gap >= UNDERRUN_FLOOR_MS {
                self.underruns += 1;
                self.underrun_ms += gap;
                if self.first_underrun_ms.is_none() {
                    // 以「开始等」为时刻:缺口是从这里开始张开的
                    let at = self
                        .audio_start
                        .map(|t| wait_start.saturating_duration_since(t).as_millis() as u64)
                        .unwrap_or(0);
                    self.first_underrun_ms = Some(at);
                }
            }
        }
        if self.primed {
            let left = buf_before.saturating_sub(waited);
            self.buf_min_ms = Some(self.buf_min_ms.map_or(left, |m| m.min(left)));
        }
    }

    /// 暂停恢复:暂停期间 RTC 队列自然排空,这段静音是**用户按了打断**造成的,
    /// 不是生产端跟不上,不能计欠载。缓冲重新起算。
    fn on_resume(&mut self) {
        self.play_deadline = None;
        self.primed = false;
    }

    fn stats(&self) -> PlayoutStats {
        PlayoutStats {
            underrun_count: self.underruns,
            underrun_ms: self.underrun_ms,
            // -1 = 缓冲从未灌到 PRIME_MS,**没采到**低水位;不是「低水位是 0」
            buffered_audio_ms: self.buf_min_ms.map_or(-1, |m| m as i64),
            first_underrun_ms: self.first_underrun_ms.map_or(-1, |m| m as i64),
            played_frames: self.frames,
        }
    }
}

/// 一轮播放的最终统计(BufferWatch Drop 时定格),经 PlayoutControl 回传给 pipeline
/// ——canary.say.metrics 的数据源(S2B1 合同:指标必须来自正式 playout 统计)。
/// completed=true 仅当自然播完(SourceDrained);cancel/异常一律 false。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalStats {
    pub underrun_count: u64,
    pub underrun_ms: u64,
    pub buffered_audio_ms: i64,
    pub first_underrun_ms: i64,
    pub played_frames: u64,
    pub completed: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct PlayoutStats {
    underrun_count: u64,
    underrun_ms: u64,
    buffered_audio_ms: i64,
    /// -1 = 本轮没发生欠载(不是「第 0 毫秒欠载」)
    first_underrun_ms: i64,
    played_frames: u64,
}

impl Drop for BufferWatch {
    /// 挂 Drop 而不是在函数末尾打日志:播放循环有多条 return 路径(硬打断、
    /// source 断开、consumer 消失),外层还会被 `turn.task.abort()` 连带 drop。
    /// 只有 Drop 能覆盖全部退出路径——少一条就是「这轮没有指标」而不是「这轮没问题」。
    fn drop(&mut self) {
        let s = self.stats();
        // 终态回传:completed 仅认自然播完;写槽失败(锁中毒)不影响日志路径
        if let Ok(mut g) = self.sink.lock() {
            *g = Some(FinalStats {
                underrun_count: s.underrun_count,
                underrun_ms: s.underrun_ms,
                buffered_audio_ms: s.buffered_audio_ms,
                first_underrun_ms: s.first_underrun_ms,
                played_frames: s.played_frames,
                completed: matches!(self.why, Some(ExitWhy::SourceDrained)),
            });
        }
        info!(
            room = %self.room,
            turn_id = self.turn_id,
            underrun_count = s.underrun_count,
            underrun_ms = s.underrun_ms,
            buffered_audio_ms = s.buffered_audio_ms,
            first_underrun_ms = s.first_underrun_ms,
            played_frames = s.played_frames,
            exit = match self.why {
                Some(w) => format!("{w:?}"),
                None => "unmarked".into(),
            },
            "playout metrics"
        );
    }
}

/// 播放循环的退出原因。**每条退出路径都必须带一个**——
/// 2026-08-15 川哥「打断后 AI 不出声」的根因就是 `capture_frame` 失败时静默 `return`:
/// turn 当场死掉、一行日志都没有,下游 TTS 随后全撞 `consumer gone`,
/// 从症状完全看不出是播放侧先没的。**静默退出是这次排查最大的成本。**
#[derive(Debug, Clone, Copy)]
enum ExitWhy {
    /// 硬打断(正常)
    Aborted,
    /// 本轮音频吐完(正常)
    SourceDrained,
    /// 控制通道全部发送端消失(异常,理论上不该发生)
    ControlGone,
    /// RTC source 持续拒收(异常,见 `capture_with_retry`)
    CaptureFailed,
}

/// `capture_frame` 失败的重试窗口。
///
/// 打断瞬间**新旧两个 playout 会短暂共存于同一个 `NativeAudioSource`**
/// (旧的收到 abort 后要等一次调度才退出,新 turn 的承接音已经开始喂),
/// 这类冲突是瞬时的。为一次瞬时冲突把整轮判死代价太大——用户表现为
/// 「打断之后 AI 彻底不说话」,而且不重连就恢复不了。
const CAPTURE_RETRY_WINDOW: Duration = Duration::from_millis(300);
const CAPTURE_RETRY_GAP: Duration = Duration::from_millis(20);

async fn capture_with_retry(
    source: &NativeAudioSource,
    frame: &AudioFrame<'_>,
    room: &str,
    turn_id: u64,
) -> bool {
    let first = match source.capture_frame(frame).await {
        Ok(()) => return true,
        Err(e) => e,
    };
    warn!(room, turn_id, error = %first, "capture_frame 失败,进入重试窗口");
    let deadline = Instant::now() + CAPTURE_RETRY_WINDOW;
    let mut tries = 0u32;
    while Instant::now() < deadline {
        tokio::time::sleep(CAPTURE_RETRY_GAP).await;
        tries += 1;
        if source.capture_frame(frame).await.is_ok() {
            info!(room, turn_id, tries, "capture_frame 重试成功,本轮保住");
            return true;
        }
    }
    warn!(room, turn_id, tries, error = %first, "capture_frame 持续失败,放弃本轮播放");
    false
}

/// PCM(24k i16le bytes)→ 10ms 帧逐帧 capture;暂停门 + 渐起 + 进度计数。
/// RTC source 队列 200ms 背压限速(与 Python room_io queue_size_ms=200 对齐)。
pub fn spawn_playout(
    source: NativeAudioSource,
    mut pcm_rx: mpsc::Receiver<Vec<u8>>,
    room: String,
    turn_id: u64,
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
        final_stats: Arc::new(Mutex::new(None)),
    };
    let ctl2 = ctl.clone();
    let task = tokio::spawn(async move {
        const FRAME_SAMPLES: usize = (TTS_SAMPLE_RATE as usize) / 100; // 10ms
        let mut watch = BufferWatch::new(room, turn_id, ctl2.final_stats.clone());
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
                watch.exit(ExitWhy::Aborted);
                return;
            }
            // 暂停门:置 true 时停喂(source 内 ≤200ms 排队自然播完)
            if *pause_rx.borrow() {
                while *pause_rx.borrow() {
                    if pause_rx.changed().await.is_err() {
                        watch.exit(ExitWhy::ControlGone);
                        return;
                    }
                }
                watch.on_resume();
            }
            let wait_start = Instant::now();
            let chunk = tokio::select! {
                // 注意 break 在 on_wait 之前:channel 关闭=本轮 TTS 吐完,那次等待是收尾不是欠载
                c = pcm_rx.recv() => match c {
                    Some(c) => c,
                    None => { watch.exit(ExitWhy::SourceDrained); break }
                },
                _ = abort_rx.changed() => { watch.exit(ExitWhy::Aborted); return }
            };
            watch.on_wait(wait_start, Instant::now());
            let mut samples: Vec<i16> = chunk
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect();
            residual.append(&mut samples);
            while residual.len() >= FRAME_SAMPLES {
                if *abort_rx.borrow() {
                    watch.exit(ExitWhy::Aborted);
                    return;
                }
                if *pause_rx.borrow() {
                    while *pause_rx.borrow() {
                        if pause_rx.changed().await.is_err() {
                            watch.exit(ExitWhy::ControlGone);
                            return;
                        }
                    }
                    watch.on_resume();
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
                if !capture_with_retry(&source, &frame, &watch.room, watch.turn_id).await {
                    watch.exit(ExitWhy::CaptureFailed);
                    return;
                }
                watch.on_frame(Instant::now());
                ctl2.first_frame_us
                    .compare_exchange(
                        0,
                        ctl2.anchor.elapsed().as_micros().max(1) as u64,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    )
                    .ok();
                ctl2.captured
                    .fetch_add(FRAME_SAMPLES as u64, Ordering::SeqCst);
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
            if capture_with_retry(&source, &frame, &watch.room, watch.turn_id).await {
                watch.on_frame(Instant::now()); // 末帧可能不足 10ms,但其后不再有等待,不影响欠载判定
                ctl2.captured.fetch_add(n as u64, Ordering::SeqCst);
            }
        }
        // 收尾:等 source 队列(≤200ms)播完再退出,让 done 语义=真播完
        tokio::time::sleep(std::time::Duration::from_millis(220)).await;
    });
    (task, ctl)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// 灌到 `PRIME_MS` 以上:同一时刻连喂 n 帧,deadline 即 t0 + n*10ms。
    #[test]
    fn final_stats_written_on_drop_and_completed_only_when_drained() {
        let sink: Arc<Mutex<Option<FinalStats>>> = Arc::new(Mutex::new(None));
        {
            let mut w = BufferWatch::new("r".into(), 7, sink.clone());
            w.exit(ExitWhy::SourceDrained);
        }
        let fs = sink.lock().unwrap().clone().expect("drop 后必须有终态");
        assert!(fs.completed, "自然播完 completed=true");

        let sink2: Arc<Mutex<Option<FinalStats>>> = Arc::new(Mutex::new(None));
        {
            let mut w = BufferWatch::new("r".into(), 8, sink2.clone());
            w.exit(ExitWhy::Aborted);
        }
        assert!(
            !sink2.lock().unwrap().clone().unwrap().completed,
            "cancel 后 completed=false"
        );

        let sink3: Arc<Mutex<Option<FinalStats>>> = Arc::new(Mutex::new(None));
        {
            let _w = BufferWatch::new("r".into(), 9, sink3.clone());
            // 无 exit 标记(unmarked)——completed 也必须是 false,不能把异常算成播完
        }
        assert!(!sink3.lock().unwrap().clone().unwrap().completed);
    }

    fn primed_watch(t0: Instant, frames: u64) -> BufferWatch {
        let mut w = BufferWatch::new("r".into(), 1, Arc::new(Mutex::new(None)));
        for _ in 0..frames {
            w.on_frame(t0);
        }
        w
    }

    #[test]
    fn never_started_reports_minus_one_not_zero() {
        // 占位值必须能和真实测量区分开:报 0 会被读成「缓冲曾经见底」
        let w = BufferWatch::new("r".into(), 1, Arc::new(Mutex::new(None)));
        assert_eq!(
            w.stats(),
            PlayoutStats {
                underrun_count: 0,
                underrun_ms: 0,
                buffered_audio_ms: -1,
                first_underrun_ms: -1,
                played_frames: 0
            }
        );
    }

    #[test]
    fn wait_within_buffer_lowers_watermark_only() {
        let t0 = Instant::now();
        let mut w = primed_watch(t0, 20); // deadline = t0+200ms
        w.on_wait(t0, t0 + ms(120));
        let s = w.stats();
        assert_eq!(s.underrun_count, 0, "缓冲还剩 80ms,不该判欠载");
        assert_eq!(s.buffered_audio_ms, 80);
    }

    #[test]
    fn wait_beyond_buffer_counts_underrun_with_gap_ms() {
        let t0 = Instant::now();
        let mut w = primed_watch(t0, 20); // 200ms 缓冲
        w.on_wait(t0, t0 + ms(350)); // 等了 350ms → 静音 150ms
        let s = w.stats();
        assert_eq!(s.underrun_count, 1);
        assert_eq!(s.underrun_ms, 150);
        assert_eq!(s.buffered_audio_ms, 0, "见底了低水位就是 0");
    }

    #[test]
    fn gap_below_noise_floor_is_ignored() {
        let t0 = Instant::now();
        let mut w = primed_watch(t0, 20);
        w.on_wait(t0, t0 + ms(215)); // 缺口 15ms < 20ms 地板
        assert_eq!(w.stats().underrun_count, 0);
        // 反向锚:再多 10ms 就必须被抓到,否则上面那条是恒绿的
        let mut w2 = primed_watch(t0, 20);
        w2.on_wait(t0, t0 + ms(225));
        assert_eq!(
            w2.stats().underrun_count,
            1,
            "25ms 缺口必须计,否则判据没有区分力"
        );
    }

    #[test]
    fn first_underrun_position_is_measured_from_audio_start() {
        // 这个数决定选哪个优化方案:靠近 0 = 起播缓冲薄,靠后 = 上游中途掉链子。
        // 位置算错会把人引到错误的方案上,所以单独钉住。
        let t0 = Instant::now();
        let mut w = BufferWatch::new("r".into(), 1, Arc::new(Mutex::new(None)));
        for _ in 0..20 {
            w.on_frame(t0); // 开播于 t0,deadline = t0+200ms
        }
        // 2 秒处开始等,等到 2.5 秒 → 缓冲早已见底,缺口发生在开播后 2000ms
        w.on_wait(t0 + ms(2000), t0 + ms(2500));
        let s = w.stats();
        assert_eq!(s.underrun_count, 1);
        assert_eq!(
            s.first_underrun_ms, 2000,
            "位置以开播时刻为原点,不是以 turn 创建时刻"
        );
        // 第二次欠载不能覆盖第一次的位置
        w.on_wait(t0 + ms(5000), t0 + ms(5400));
        assert_eq!(w.stats().underrun_count, 2);
        assert_eq!(
            w.stats().first_underrun_ms,
            2000,
            "记的是**首次**,后续不得覆盖"
        );
    }

    #[test]
    fn no_underrun_reports_minus_one_not_zero_position() {
        // 报 0 会被读成「开播瞬间就欠载」——那是最需要立刻处理的情况,不能和「没欠载」同形
        let t0 = Instant::now();
        let mut w = primed_watch(t0, 20);
        w.on_wait(t0, t0 + ms(100)); // 缓冲够,不欠载
        let s = w.stats();
        assert_eq!(s.underrun_count, 0);
        assert_eq!(s.first_underrun_ms, -1);
    }

    #[test]
    fn pause_does_not_reset_the_audio_start_anchor() {
        // audio_start 跨暂停保留:否则打断后恢复的轮,欠载位置会被算回 0 附近,
        // 看起来像「起播就卡」,把人引向错误的方案。
        let t0 = Instant::now();
        let mut w = BufferWatch::new("r".into(), 1, Arc::new(Mutex::new(None)));
        for _ in 0..20 {
            w.on_frame(t0);
        }
        w.on_resume(); // 暂停恢复
        for _ in 0..20 {
            w.on_frame(t0 + ms(3000)); // 3 秒后继续播
        }
        w.on_wait(t0 + ms(3200), t0 + ms(3900));
        assert_eq!(
            w.stats().first_underrun_ms,
            3200,
            "原点必须还是最初开播的 t0"
        );
    }

    #[test]
    fn resume_after_pause_is_not_an_underrun() {
        let t0 = Instant::now();
        let mut w = primed_watch(t0, 20);
        w.on_resume(); // 用户打断 → pause → resume,队列本就该是空的
        w.on_wait(t0, t0 + ms(5_000));
        assert_eq!(
            w.stats().underrun_count,
            0,
            "暂停造成的静音不是生产端跟不上"
        );
    }

    #[test]
    fn deadline_restarts_after_gap_instead_of_accumulating() {
        let t0 = Instant::now();
        let mut w = primed_watch(t0, 20); // deadline t0+200
        // 500ms 后才喂下一帧:deadline 必须从 t0+500 起算,不是 t0+210
        w.on_frame(t0 + ms(500));
        w.on_wait(t0 + ms(500), t0 + ms(520));
        // 若错误地从 t0+210 累加,buf_before 会算成 0 而不是 10 → 会多记一次欠载
        assert_eq!(
            w.stats().underrun_count,
            0,
            "缺口只能记一次,不能在后续等待里重复计"
        );
    }

    #[test]
    fn unprimed_skips_watermark_but_still_counts_underrun() {
        let t0 = Instant::now();
        let mut w = BufferWatch::new("r".into(), 1, Arc::new(Mutex::new(None)));
        w.on_frame(t0); // 只有 10ms 缓冲,远未 primed
        w.on_wait(t0, t0 + ms(200)); // 静音 190ms,开播就卡是真欠载
        let s = w.stats();
        assert_eq!(s.underrun_count, 1, "开播阶段的卡顿同样可听,必须计");
        assert_eq!(s.buffered_audio_ms, -1, "没灌满过就没有可信低水位,不能报 0");
    }
}
