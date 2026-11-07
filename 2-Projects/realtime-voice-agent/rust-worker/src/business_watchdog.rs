//! Business deadlines are separate from the pipeline liveness heartbeat.
//! All times are elapsed milliseconds from the job's monotonic Instant.
//! No packet count, ready restatement, or persistent busy boolean is progress.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode { Off, Observe, Enforce }
#[derive(Clone, Copy, Debug)]
pub struct Policy { pub mode: Mode, pub idle_ms: Option<u64>, pub startup_ms: u64 }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason { StartupNoInput, IdleNoProgress, UnknownPolicy }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision { Keep, Observe(Reason), Close(Reason) }
#[derive(Clone, Copy, Debug)]
pub enum Activity { Reply, Search, Command, Listening }

#[derive(Clone, Copy, Debug)]
struct Hold { generation: u64, until: u64, active: bool }

pub struct BusinessWatchdog {
    policy: Policy,
    started: u64,
    ready: bool,
    last_progress: u64,
    // Retain the generation after completion: a delayed duplicate cannot
    // resurrect an expired/finished task and buy another full lease.
    holds: [Option<Hold>; 4],
}
impl BusinessWatchdog {
    pub fn new(mut policy: Policy, now: u64) -> Self {
        policy.idle_ms = policy.idle_ms.filter(|ms| (5_000..=300_000).contains(ms));
        Self { policy, started: now, ready: false, last_progress: now, holds: [None; 4] }
    }
    pub fn first_frame(&mut self, now: u64) {
        if !self.ready { self.ready = true; self.progress(now); }
    }
    /// Only fresh evidence of actual input/output may call this. In particular
    /// keepalives, silence frames and a stale VAD/playing flag must not.
    pub fn progress(&mut self, now: u64) { self.last_progress = self.last_progress.max(now); }
    /// The integration owns a monotonically increasing generation per kind.
    /// A duplicate generation cannot extend the original deadline. Listening
    /// may advance only on a newly acknowledged authority lease, not a poll.
    pub fn begin_activity(&mut self, kind: Activity, generation: u64, budget_ms: u64, now: u64) {
        let slot = &mut self.holds[kind as usize];
        if slot.map(|h| generation <= h.generation).unwrap_or(false) { return; }
        *slot = Some(Hold { generation, until: now.saturating_add(budget_ms), active: budget_ms > 0 });
    }
    pub fn end_activity(&mut self, kind: Activity, generation: u64) {
        if let Some(h) = &mut self.holds[kind as usize] {
            if h.generation == generation { h.active = false; }
        }
    }
    pub fn evaluate(&mut self, now: u64) -> Decision {
        if self.policy.mode == Mode::Off { return Decision::Keep; }
        let Some(idle_ms) = self.policy.idle_ms else { return Decision::Observe(Reason::UnknownPolicy); };
        let reason = if !self.ready {
            // An unready room cannot escape its startup deadline by claiming
            // activity. Ready is the first consumed input frame, exactly once.
            if now.saturating_sub(self.started) < self.policy.startup_ms { return Decision::Keep; }
            Reason::StartupNoInput
        } else {
            if now.saturating_sub(self.last_progress) < idle_ms
                || self.holds.iter().flatten().any(|h| h.active && now < h.until) {
                return Decision::Keep;
            }
            Reason::IdleNoProgress
        };
        match self.policy.mode {
            Mode::Enforce => Decision::Close(reason),
            _ => Decision::Observe(reason),
        }
    }
}

/// Exact scalar diagnostics. No raw audio is retained, and no per-frame
/// integer division can hide isolated non-zero samples.
#[derive(Default, Debug)]
pub struct AudioStats { pub samples: u64, pub nonzero: u64, pub peak: u16, pub absolute_sum: u64 }
impl AudioStats {
    pub fn push(&mut self, samples: &[i16]) {
        self.samples = self.samples.saturating_add(samples.len() as u64);
        for sample in samples {
            let amplitude = sample.unsigned_abs();
            self.nonzero = self.nonzero.saturating_add(u64::from(amplitude != 0));
            self.peak = self.peak.max(amplitude);
            self.absolute_sum = self.absolute_sum.saturating_add(u64::from(amplitude));
        }
    }
    pub fn mean_abs(&self) -> f64 {
        if self.samples == 0 { 0.0 } else { self.absolute_sum as f64 / self.samples as f64 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy(idle: Option<u64>, mode: Mode) -> Policy { Policy { mode, idle_ms: idle, startup_ms: 30_000 } }
    fn ready(idle: u64) -> BusinessWatchdog {
        let mut w=BusinessWatchdog::new(policy(Some(idle),Mode::Enforce),0);w.first_frame(1000);w
    }
    #[test]
    fn silent_connected_room_expires_despite_repeated_ready_and_ticks() {
        let mut w=ready(5000);
        for now in (2000..6000).step_by(50) { w.first_frame(now);assert_eq!(w.evaluate(now),Decision::Keep); }
        assert_eq!(w.evaluate(6000),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn startup_without_any_pcm_has_an_absolute_deadline() {
        let mut w=BusinessWatchdog::new(policy(Some(300_000),Mode::Enforce),500);
        assert_eq!(w.evaluate(30_499),Decision::Keep);
        assert_eq!(w.evaluate(30_500),Decision::Close(Reason::StartupNoInput));
    }
    #[test]
    fn three_hundred_second_idle_is_not_replaced_by_sixty_seconds() {
        let mut w=ready(300_000);
        assert_eq!(w.evaluate(61_000),Decision::Keep);
        assert_eq!(w.evaluate(300_999),Decision::Keep);
        assert_eq!(w.evaluate(301_000),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn fresh_input_or_output_progress_preserves_long_speech_and_playback() {
        let mut w=ready(5000);
        for now in (2000..900_000).step_by(1000) { w.progress(now);assert_eq!(w.evaluate(now),Decision::Keep); }
        assert_eq!(w.evaluate(903_999),Decision::Keep);
        assert_eq!(w.evaluate(904_000),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn repeated_busy_boolean_cannot_extend_a_generation_deadline() {
        for kind in [Activity::Reply,Activity::Search,Activity::Command,Activity::Listening] {
            let mut w=ready(5000);
            for now in (2000..32_000).step_by(1000) {
                w.begin_activity(kind,7,30_000,now);
                assert_eq!(w.evaluate(now),Decision::Keep);
            }
            assert_eq!(w.evaluate(32_000),Decision::Close(Reason::IdleNoProgress));
        }
    }
    #[test]
    fn stale_finish_cannot_remove_new_generation_and_stale_start_cannot_revive_old() {
        let mut w=ready(5000);w.begin_activity(Activity::Search,7,30_000,2000);
        w.begin_activity(Activity::Search,8,40_000,3000);w.end_activity(Activity::Search,7);
        assert_eq!(w.evaluate(42_999),Decision::Keep);
        w.begin_activity(Activity::Search,7,900_000,42_999);
        assert_eq!(w.evaluate(43_000),Decision::Close(Reason::IdleNoProgress));
        w.end_activity(Activity::Search,8);w.begin_activity(Activity::Search,8,900_000,43_000);
        assert_eq!(w.evaluate(43_001),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn unknown_or_invalid_idle_is_observed_never_silently_enforced() {
        for idle in [None,Some(0),Some(4999),Some(300_001)] {
            let mut w=BusinessWatchdog::new(policy(idle,Mode::Enforce),0);w.first_frame(1000);
            assert_eq!(w.evaluate(3_600_000),Decision::Observe(Reason::UnknownPolicy));
        }
    }
    #[test]
    fn observation_and_rollback_off_do_not_close() {
        let mut observe=BusinessWatchdog::new(policy(Some(5000),Mode::Observe),0);observe.first_frame(1000);
        assert_eq!(observe.evaluate(6000),Decision::Observe(Reason::IdleNoProgress));
        let mut off=BusinessWatchdog::new(policy(Some(5000),Mode::Off),0);
        assert_eq!(off.evaluate(u64::MAX),Decision::Keep);
    }
    #[test]
    fn an_expired_task_does_not_interrupt_new_real_input() {
        let mut w=ready(5000);w.begin_activity(Activity::Search,1,30_000,1000);w.progress(30_500);
        assert_eq!(w.evaluate(31_000),Decision::Keep);
        assert_eq!(w.evaluate(35_500),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn timers_do_not_wrap_and_backwards_timestamps_do_not_extend_life() {
        let mut w=ready(5000);w.progress(2000);assert_eq!(w.evaluate(5000),Decision::Keep);
        w.progress(1000);assert_eq!(w.evaluate(7000),Decision::Close(Reason::IdleNoProgress));
        let mut late=BusinessWatchdog::new(policy(Some(5000),Mode::Enforce),u64::MAX-500);
        assert_eq!(late.evaluate(u64::MAX-1),Decision::Keep);
    }
    #[test]
    fn amplitude_stats_do_not_turn_sparse_nonzero_audio_into_exact_silence() {
        let mut stats=AudioStats::default();let mut chunk=vec![0;1000];chunk[123]=100;
        stats.push(&chunk);assert_eq!(stats.samples,1000);assert_eq!(stats.nonzero,1);
        assert_eq!(stats.peak,100);assert_eq!(stats.absolute_sum,100);assert!((stats.mean_abs()-0.1).abs()<1e-10);
        stats.push(&[-32768,32767]);assert_eq!(stats.peak,32768);assert_eq!(stats.nonzero,3);
        assert_eq!(stats.samples,1002);assert_eq!(stats.absolute_sum,65635);
    }
    #[test]
    fn amplitude_is_sample_weighted_and_empty_or_zero_input_is_distinct() {
        let mut stats=AudioStats::default();stats.push(&[]);assert_eq!(stats.samples,0);
        stats.push(&[0;99]);stats.push(&[100]);assert_eq!(stats.mean_abs(),1.0);
        let zeros=AudioStats::default();assert_eq!(zeros.mean_abs(),0.0);
    }

}
