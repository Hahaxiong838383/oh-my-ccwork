//! 判停状态机(对齐 livekit-agents audio_recognition EOU 语义):
//!
//! - 锚点 = VAD 停说时刻(END_OF_SPEECH 回溯 min_silence),非 final 到达时刻;
//!   框架源码:extra_sleep = endpointing_delay + (last_speaking_time - now)。
//! - delay 由 EOT 语义选择:prob < unlikely_threshold(zh 0.3550)→ MAX,否则 MIN;
//!   预测缺席(sidecar 挂/超时)→ MIN(框架 predict 失败同款降级)。
//! - EOT 触发时刻 = 用户说话中 VAD 静音累积 ≥200ms(MIN_SILENCE_DURATION_MS),
//!   拿最近 1.2s 环形缓冲跑一次;说话恢复则作废重来(inference/eot 同款)。
//! - 提交条件:有累积 final + 用户不在说 + now ≥ 锚点+delay;final 迟到(>deadline
//!   才到)则到即提交(框架 "late stt final" 行为)。
//! - 兜底:VAD 从未见 END(漏检)时锚点退化为最后 final 时刻+MIN(P3a 行为保留)。

use std::time::{Duration, Instant};

pub struct TurnGate {
    pub min_delay: Duration,
    pub max_delay: Duration,
    pub unlikely_threshold: f32,
    pending: String,
    last_final_at: Option<Instant>,
    speech_end_at: Option<Instant>, // 已回溯的真实停说时刻
    eot_prob: Option<f32>,          // 本句段 EOT 预测(说话恢复即作废)
    user_speaking: bool,
    input_ended: bool, // ordered_pcm 终局:输入已由设备 end 宣告结束,判停不再等待(提交/说话恢复即复位)
}

impl TurnGate {
    pub fn new(min_delay: Duration, max_delay: Duration, unlikely_threshold: f32) -> Self {
        Self {
            min_delay,
            max_delay: max_delay.max(min_delay), // 框架保证 max≥min
            unlikely_threshold,
            pending: String::new(),
            last_final_at: None,
            speech_end_at: None,
            eot_prob: None,
            user_speaking: false,
            input_ended: false,
        }
    }

    pub fn pending(&self) -> &str {
        &self.pending
    }

    pub fn on_final(&mut self, text: &str, now: Instant) {
        if text.is_empty() {
            return;
        }
        if !self.pending.is_empty() {
            self.pending.push(' ');
        }
        self.pending.push_str(text);
        self.last_final_at = Some(now);
    }

    pub fn on_speech_start(&mut self) {
        self.user_speaking = true;
        self.input_ended = false;
        self.speech_end_at = None;
        self.eot_prob = None; // 说话恢复,上一次预测作废
    }

    /// VAD END_OF_SPEECH:`silence` 为触发时已累积的静音(min_silence),锚点回溯。
    pub fn on_speech_end(&mut self, now: Instant, silence: Duration) {
        self.user_speaking = false;
        self.speech_end_at = Some(now.checked_sub(silence).unwrap_or(now));
    }

    /// ordered_pcm 终局(B6 2026-09-09 真机实证:7/7 房 eou 400–448 ms 全是空等):输入已由设备 end
    /// 宣告结束、完整性门已裁决,判停等待没有对象——下一次 poll 立即提交(eou_delay≈tick 间隔)。
    /// 只由 ordered 终局调用;VAD 路径语义不变;提交或说话恢复即复位。
    pub fn mark_input_ended(&mut self) {
        self.input_ended = true;
    }

    /// EOT 预测结果到达(异步,可能在 END 前后)。
    pub fn on_eot_prob(&mut self, prob: f32) {
        self.eot_prob = Some(prob);
    }

    #[cfg(test)]
    pub fn eot_prob(&self) -> Option<f32> {
        self.eot_prob
    }

    fn chosen_delay(&self) -> Duration {
        match self.eot_prob {
            Some(p) if p < self.unlikely_threshold => self.max_delay,
            _ => self.min_delay,
        }
    }

    /// 提交检查(commit_tick 轮询)。`eou_delay`=停说→提交,`stt_delay`=停说→末 final
    /// (对齐框架 EOUMetrics.transcription_delay 口径,web 延迟面板消费)。
    pub fn poll_commit(&mut self, now: Instant) -> Option<CommitInfo> {
        if self.pending.is_empty() || self.user_speaking {
            return None;
        }
        let anchor = match (self.speech_end_at, self.last_final_at) {
            (Some(e), _) => e,
            // VAD 漏检兜底:final 时刻当锚(此时无 EOT 语义,chosen 仍按预测规则)
            (None, Some(f)) => f,
            (None, None) => return None,
        };
        let delay = if self.input_ended { Duration::ZERO } else { self.chosen_delay() };
        if now.duration_since(anchor) < delay {
            return None;
        }
        let text = std::mem::take(&mut self.pending);
        let stt_delay = self
            .last_final_at
            .map(|f| f.saturating_duration_since(anchor))
            .unwrap_or_default();
        let info = CommitInfo { text, eou_delay: now.duration_since(anchor), stt_delay, input_ended: self.input_ended };
        self.last_final_at = None;
        self.speech_end_at = None;
        self.eot_prob = None;
        self.input_ended = false;
        Some(info)
    }
}

pub struct CommitInfo {
    pub text: String,
    pub eou_delay: Duration,
    pub stt_delay: Duration,
    /// 本次提交是否由 ordered 终局释放(B 短垫句选材依据)。标记本身在返回前复位,
    /// 下游只能从这里读,不能再读 gate(codex 2026-09-09 §3 提醒)。
    pub input_ended: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> TurnGate {
        TurnGate::new(Duration::from_millis(650), Duration::from_millis(1300), 0.3550)
    }

    #[test]
    fn commit_uses_min_delay_when_eot_likely() {
        let mut g = gate();
        let t0 = Instant::now();
        g.on_speech_start();
        g.on_final("你好", t0);
        g.on_eot_prob(0.8); // ≥阈值 → 判"说完" → MIN
        g.on_speech_end(t0, Duration::from_millis(300));
        // 锚点=t0-300ms,MIN=650ms → t0+350ms 可提交
        assert!(g.poll_commit(t0 + Duration::from_millis(200)).is_none());
        let info = g.poll_commit(t0 + Duration::from_millis(400)).expect("commit");
        assert_eq!(info.text, "你好");
        // stt_delay=final(t0) - 锚点(t0-300ms) = 300ms
        assert_eq!(info.stt_delay, Duration::from_millis(300));
    }

    #[test]
    fn unlikely_prob_stretches_to_max_delay() {
        let mut g = gate();
        let t0 = Instant::now();
        g.on_speech_start();
        g.on_final("我想想啊", t0);
        g.on_eot_prob(0.1); // <0.3550 → 判"没说完" → MAX 1.30
        g.on_speech_end(t0, Duration::from_millis(300));
        // 锚点 t0-300ms → t0+1000ms 才够 1300ms
        assert!(g.poll_commit(t0 + Duration::from_millis(900)).is_none());
        assert!(g.poll_commit(t0 + Duration::from_millis(1050)).is_some());
    }

    #[test]
    fn resumed_speech_invalidates_prediction_and_blocks_commit() {
        let mut g = gate();
        let t0 = Instant::now();
        g.on_speech_start();
        g.on_final("第一句", t0);
        g.on_eot_prob(0.9);
        g.on_speech_end(t0, Duration::from_millis(300));
        g.on_speech_start(); // 又开口:预测作废,提交阻塞
        assert!(g.eot_prob().is_none());
        assert!(g.poll_commit(t0 + Duration::from_secs(2)).is_none());
        g.on_final("第二句", t0 + Duration::from_secs(2));
        g.on_speech_end(t0 + Duration::from_secs(2), Duration::from_millis(300));
        let info = g.poll_commit(t0 + Duration::from_secs(3)).expect("commit");
        assert_eq!(info.text, "第一句 第二句");
    }

    #[test]
    fn late_final_commits_immediately_after_deadline() {
        let mut g = gate();
        let t0 = Instant::now();
        g.on_speech_start();
        g.on_speech_end(t0, Duration::from_millis(300));
        // deadline 已过但无 final → 不提交;final 迟到 → 到即提交
        assert!(g.poll_commit(t0 + Duration::from_secs(1)).is_none());
        g.on_final("迟到的尾句", t0 + Duration::from_secs(1));
        assert!(g.poll_commit(t0 + Duration::from_millis(1001)).is_some());
    }

    #[test]
    fn no_vad_end_falls_back_to_final_anchor() {
        let mut g = gate();
        let t0 = Instant::now();
        g.on_final("漏检句", t0);
        assert!(g.poll_commit(t0 + Duration::from_millis(600)).is_none());
        assert!(g.poll_commit(t0 + Duration::from_millis(700)).is_some());
    }

    /// ordered_pcm 终局:设备 end 已宣告输入结束,final 释放后不等 MIN 延迟,下一次 poll 即提交;提交后复位。
    #[test]
    fn input_ended_commits_at_next_poll_without_endpointing_delay() {
        let mut g = gate();
        let t0 = Instant::now();
        g.on_final("有序代次整句", t0);
        g.mark_input_ended();
        let c = g.poll_commit(t0 + Duration::from_millis(10)).expect("immediate commit");
        assert_eq!(c.text, "有序代次整句");
        assert!(c.eou_delay <= Duration::from_millis(10));
        assert!(c.input_ended, "ordered 来源随结果带出");
        // 复位:下一句(无标记)仍按 VAD 漏检兜底等 MIN
        g.on_final("下一句", t0 + Duration::from_millis(20));
        assert!(g.poll_commit(t0 + Duration::from_millis(600)).is_none());
        let c2 = g.poll_commit(t0 + Duration::from_millis(700)).expect("普通提交");
        assert!(!c2.input_ended, "下一次普通提交不得残留 ordered 标记");
    }

    /// 标记不能穿过「用户在说」门,且说话恢复即复位(VAD 路径语义不变)。
    #[test]
    fn input_ended_is_cleared_by_speech_start() {
        let mut g = gate();
        let t0 = Instant::now();
        g.on_final("句", t0);
        g.mark_input_ended();
        g.on_speech_start();
        assert!(g.poll_commit(t0 + Duration::from_millis(10)).is_none());
        g.on_speech_end(t0 + Duration::from_millis(100), Duration::from_millis(0));
        assert!(g.poll_commit(t0 + Duration::from_millis(200)).is_none()); // 标记已清,等 MIN(650)
        assert!(g.poll_commit(t0 + Duration::from_millis(800)).is_some());
    }
}
