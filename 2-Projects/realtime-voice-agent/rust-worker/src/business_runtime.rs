//! Bridge from trusted job metadata and actual pipeline evidence to the pure
//! deadline model. No network I/O or await is permitted while holding state.
use std::{sync::{Arc, Mutex}, time::{Duration, Instant}};
use crate::business_watchdog::{Activity, BusinessWatchdog, Decision, Mode, Policy};

#[derive(Clone)]
pub struct Runtime {
    origin: Instant,
    mode: Mode,
    idle_ms: Option<u64>,
    revision: Option<String>,
    state: Arc<Mutex<State>>,
}
struct State {
    model: BusinessWatchdog,
    deadlines: [Option<u64>; 5],
    generations: [u64; 5],
}
impl Runtime {
    pub fn from_settings(mode: &str, allow: &str, room: &str,
                         metadata: Option<&serde_json::Value>, origin: Instant) -> Option<Self> {
        let mode = match mode { "observe" => Mode::Observe, "enforce" => Mode::Enforce, _ => return None };
        if !crate::search_enrollment::enabled("1", "allowlist", allow, room, "") { return None; }
        let signed = metadata.and_then(|v| {
            let idle = v["timeout_ms"].as_u64().filter(|v| (5000..=300000).contains(v))?;
            let revision = v["revision"].as_str()?;
            let digits = revision.strip_prefix("cfg-")?;
            if digits.is_empty() || digits.len() > 20 || !digits.bytes().all(|v| v.is_ascii_digit()) { return None; }
            Some((idle, revision.to_owned()))
        });
        let idle_ms = signed.as_ref().map(|v| v.0);
        let revision = signed.map(|v| v.1);
        let policy = Policy { mode, idle_ms, startup_ms: crate::startup_participant::STARTUP_BUDGET_MS };
        Some(Self { origin, mode, idle_ms, revision,
            state: Arc::new(Mutex::new(State { model: BusinessWatchdog::new(policy, 0), deadlines: [None; 5], generations: [0; 5] })) })
    }
    pub fn from_env(room: &str, metadata: Option<&serde_json::Value>, origin: Instant) -> Option<Self> {
        Self::from_settings(&std::env::var("P003_BUSINESS_WATCHDOG_MODE").unwrap_or_default(),
            &std::env::var("P003_BUSINESS_WATCHDOG_DEVICE_ALLOWLIST").unwrap_or_default(), room, metadata, origin)
    }
    fn ms(&self, now: Instant) -> u64 { now.saturating_duration_since(self.origin).as_millis().min(u64::MAX as u128) as u64 }
    pub fn input_frame(&self, now: Instant, sample_count: usize) {
        if sample_count > 0 { self.first_frame(now); }
    }
    fn first_frame(&self, now: Instant) { self.state.lock().unwrap_or_else(|e| e.into_inner()).model.first_frame(self.ms(now)); }
    pub fn progress(&self, now: Instant) { self.state.lock().unwrap_or_else(|e| e.into_inner()).model.progress(self.ms(now)); }
    /// The pipeline is the sole producer of holds. Pass the task's original
    /// absolute deadline, never `now + budget` on every tick. A changed deadline
    /// represents a new task/authorized phase (e.g. command accepted, resume grant).
    pub fn activity_until(&self, kind: Activity, until: Option<Instant>) {
        let deadline = until.map(|t| self.ms(t));
        let slot = kind as usize;
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.deadlines[slot] == deadline { return; }
        s.deadlines[slot] = deadline;
        if let Some(until) = deadline {
            s.generations[slot] = s.generations[slot].saturating_add(1);
            let generation = s.generations[slot];
            s.model.begin_activity(kind, generation, until, 0);
        } else {
            let generation = s.generations[slot];
            s.model.end_activity(kind, generation);
        }
    }
    pub fn evaluate(&self, now: Instant) -> Decision { self.state.lock().unwrap_or_else(|e| e.into_inner()).model.evaluate(self.ms(now)) }
    pub fn startup_deadline(&self) -> Option<Instant> {
        (self.mode == Mode::Enforce && self.idle_ms.is_some())
            .then(|| self.origin + Duration::from_millis(crate::startup_participant::STARTUP_BUDGET_MS))
    }
    pub fn revision(&self) -> Option<&str> { self.revision.as_deref() }
}

/// Both connect and publish consume the same assignment-relative budget.
pub async fn within_startup<T>(deadline: Option<Instant>, task: impl std::future::Future<Output = anyhow::Result<T>>) -> anyhow::Result<T> {
    match deadline {
        Some(at) => {
            // Tokio polls an immediately ready future before its expired timer.
            // Check both boundaries so an overdue stage cannot bypass the budget.
            if Instant::now() >= at { anyhow::bail!("business_startup_deadline"); }
            let value = tokio::time::timeout_at(tokio::time::Instant::from_std(at), task).await
                .map_err(|_| anyhow::anyhow!("business_startup_deadline"))??;
            if Instant::now() >= at { anyhow::bail!("business_startup_deadline"); }
            Ok(value)
        },
        None => task.await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::business_watchdog::Reason;
    use serde_json::json;
    const SN: &str = "BJP00326110799999901";
    const ROOM: &str = "sn-BJP00326110799999901-123";
    #[tokio::test]
    async fn expired_startup_budget_never_polls_even_an_immediately_ready_operation() {
        let mut polled = false;
        let result = within_startup(Some(Instant::now()-Duration::from_millis(1)), async { polled=true; Ok(()) }).await;
        assert!(result.is_err());
        assert!(!polled);
    }
    #[tokio::test]
    async fn startup_budget_is_shared_and_does_not_restart_for_a_second_stage() {
        let deadline = Instant::now() + Duration::from_millis(40);
        within_startup(Some(deadline), async { tokio::time::sleep(Duration::from_millis(25)).await; Ok(()) }).await.unwrap();
        let result = within_startup(Some(deadline), async { tokio::time::sleep(Duration::from_millis(30)).await; Ok(()) }).await;
        assert_eq!(result.unwrap_err().to_string(), "business_startup_deadline");
        assert_eq!(within_startup(None, async { Ok(17) }).await.unwrap(), 17);
    }
    fn policy() -> serde_json::Value { json!({"timeout_ms":5000,"revision":"cfg-12"}) }
    #[test]
    fn default_empty_scope_and_unlisted_devices_cannot_execute() {
        for mode in ["", "off", "invalid"] { assert!(Runtime::from_settings(mode,SN,ROOM,Some(&policy()),Instant::now()).is_none()); }
        for allow in ["", "BJP00326110799999902", "*"] { assert!(Runtime::from_settings("enforce",allow,ROOM,Some(&policy()),Instant::now()).is_none()); }
        assert!(Runtime::from_settings("enforce",SN,"probe",Some(&policy()),Instant::now()).is_none());
    }
    #[test]
    fn malformed_or_absent_signed_policy_never_acquires_close_authority() {
        let t=Instant::now();
        for value in [json!(null),json!({}),json!({"timeout_ms":5000}),json!({"timeout_ms":5000,"revision":"local"}),json!({"timeout_ms":0,"revision":"cfg-1"}),json!({"timeout_ms":300001,"revision":"cfg-1"}),json!({"timeout_ms":"5000","revision":"cfg-1"})] {
            let w=Runtime::from_settings("enforce",SN,ROOM,Some(&value),t).unwrap();
            assert_eq!(w.evaluate(t+Duration::from_secs(1000)),Decision::Observe(Reason::UnknownPolicy));
            assert!(w.startup_deadline().is_none());
        }
        let w=Runtime::from_settings("enforce",SN,ROOM,None,t).unwrap();
        assert_eq!(w.evaluate(t+Duration::from_secs(1000)),Decision::Observe(Reason::UnknownPolicy));
    }
    #[test]
    fn empty_audio_frames_do_not_disarm_startup_protection() {
        let t=Instant::now();let w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();
        for ms in (0..60000).step_by(50) { w.input_frame(t+Duration::from_millis(ms),0); }
        assert_eq!(w.evaluate(t+Duration::from_secs(60)),Decision::Close(Reason::StartupNoInput));
    }
    #[test]
    fn real_progress_and_transport_ready_are_distinct_across_clones() {
        let t=Instant::now();let w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();let p=w.clone();
        p.first_frame(t+Duration::from_millis(4999));
        assert_eq!(w.evaluate(t+Duration::from_millis(5000)),Decision::Close(Reason::IdleNoProgress));
        p.progress(t+Duration::from_millis(5001));
        assert_eq!(w.evaluate(t+Duration::from_millis(10000)),Decision::Keep);
        assert_eq!(w.evaluate(t+Duration::from_millis(10001)),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn repeated_absolute_activity_deadline_never_renews_it() {
        let t=Instant::now();let w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();w.first_frame(t);
        let expiry=t+Duration::from_secs(80);
        for _ in 0..1000 { w.activity_until(Activity::Search,Some(expiry)); }
        assert_eq!(w.evaluate(expiry-Duration::from_millis(1)),Decision::Keep);
        assert_eq!(w.evaluate(expiry),Decision::Close(Reason::IdleNoProgress));
        w.activity_until(Activity::Search,Some(expiry+Duration::from_secs(100)));
        w.activity_until(Activity::Search,None);
        assert_eq!(w.evaluate(expiry),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn observing_has_no_startup_abort_and_execution_uses_existing_sixty_second_budget() {
        let t=Instant::now();let w=Runtime::from_settings("observe",SN,ROOM,Some(&policy()),t).unwrap();
        assert!(w.startup_deadline().is_none());assert_eq!(w.evaluate(t+Duration::from_secs(60)),Decision::Observe(Reason::StartupNoInput));
        let w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();
        assert_eq!(w.startup_deadline(),Some(t+Duration::from_secs(60)));
        w.first_frame(t+Duration::from_secs(60));w.progress(t+Duration::from_secs(60));
        assert_eq!(w.evaluate(t+Duration::from_secs(60)),Decision::Close(Reason::StartupNoInput));
    }
}
