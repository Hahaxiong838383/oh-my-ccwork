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
    deadlines: [Option<u64>; 6],
    generations: [u64; 6],
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
            state: Arc::new(Mutex::new(State { model: BusinessWatchdog::new(policy, 0), deadlines: [None; 6], generations: [0; 6] })) })
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
    /// Only newly classified RTC speech calls this, never a polling tick or
    /// interim text. The connection budget plus 5s result grace is a bounded
    /// local policy, not a provider SLA or a change to the signed idle timeout.
    pub fn asr_speech(&self, now: Instant) {
        let at=self.ms(now);let slot=Activity::Recognition as usize;
        let until=at.saturating_add((crate::stt_volc::CONNECT_TIMEOUT+Duration::from_secs(5)).as_millis() as u64);
        let mut s=self.state.lock().unwrap_or_else(|e|e.into_inner());
        s.model.progress(at);
        s.deadlines[slot]=Some(until);s.generations[slot]=s.generations[slot].saturating_add(1);
        let generation=s.generations[slot];s.model.begin_activity(Activity::Recognition,generation,until,0);
    }
    pub fn asr_final(&self, now: Instant) {
        let at=self.ms(now);let slot=Activity::Recognition as usize;
        let mut s=self.state.lock().unwrap_or_else(|e|e.into_inner());
        if let Some(until)=s.deadlines[slot].take() {
            let generation=s.generations[slot];s.model.end_activity(Activity::Recognition,generation);
            // One actual result may bridge to the normal turn task. Unsolicited,
            // duplicate or already overdue results cannot keep a room alive.
            if at<until {s.model.progress(at);}
        }
    }
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
    pub fn first_turn_to_rtc(&self, now: Instant) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).model.first_turn_to_rtc(self.ms(now));
    }
    pub fn input_transition_deadline(&self, until: Instant) -> Instant {
        // The protocol itself still expires at `until`. Only the job gets an
        // idle interval to process that terminal state and hand input to RTC.
        until.checked_add(Duration::from_millis(self.idle_ms.unwrap_or(0))).unwrap_or(until)
    }
    pub fn evaluate(&self, now: Instant) -> Decision { self.state.lock().unwrap_or_else(|e| e.into_inner()).model.evaluate(self.ms(now)) }
    pub fn startup_deadline(&self) -> Option<Instant> {
        (self.mode == Mode::Enforce && self.idle_ms.is_some())
            .then(|| self.origin + Duration::from_millis(crate::startup_participant::STARTUP_BUDGET_MS))
    }
    pub fn observe_only(&mut self) {
        self.mode = Mode::Observe;
        self.state.lock().unwrap_or_else(|e| e.into_inner()).model.observe_only();
    }
    pub fn enforcing(&self) -> bool { self.mode == Mode::Enforce && self.idle_ms.is_some() }
    pub fn revision(&self) -> Option<&str> { self.revision.as_deref() }
}

/// Existing provider/output budgets composed at their actual anchors.
pub fn reply_startup_deadline(started: Instant, wait_output: bool, receipt: Option<Instant>) -> Instant {
    let generated = started + crate::llm::REQUEST_TIMEOUT + crate::tts_xfyun::CONNECT_TIMEOUT;
    let output = if wait_output { generated + crate::gate::OUTPUT_READY_TIMEOUT } else { generated };
    receipt.map_or(output, |deadline| deadline.max(output))
}
pub fn reply_deadline(initial: Instant, last_pcm: Option<Instant>) -> Instant {
    // Each later sentence can legitimately acquire a connection. Bound that
    // allowance to actual last PCM, so stalled synthesis cannot renew it.
    last_pcm.map_or(initial, |at| initial.max(at + crate::tts_xfyun::CONNECT_TIMEOUT))
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
    #[test]
    fn listening_lease_silence_and_exit_use_fixed_authority_times() {
        use crate::listening_mode::{Action,Command,Scene};
        let mut session=crate::listening_runtime::ListeningSession::new(crate::listening_runtime::Binding {
            room:ROOM.into(),session:"synthetic".into(),trace:"synthetic".into(),
        }).unwrap();
        let t=session.deadline_instant(0).unwrap();
        let w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();w.input_frame(t,160);
        let command=|seq,action|Command{proposal_id:None,seq,request_id:format!("synthetic:{seq}"),action};
        let who=format!("dev-{SN}");
        session.renew_lease(1,15000,0).unwrap();
        let e=session.control(Some(&who),"synthetic",command(1,Action::Enter{scene:Scene::Singing,epoch:0}),0).unwrap();
        session.capture_drained(e.epoch,1).unwrap();
        session.control(Some(&who),"synthetic",command(2,Action::LocalReady{epoch:e.epoch}),1).unwrap();
        for sec in [5,8,12,14] {
            w.activity_until(Activity::Listening,session.business_deadline(sec*1000));
            assert_eq!(w.evaluate(t+Duration::from_secs(sec)),Decision::Keep);
        }
        w.activity_until(Activity::Listening,session.business_deadline(15000));
        assert_eq!(w.evaluate(t+Duration::from_secs(15)),Decision::Close(Reason::IdleNoProgress));
        // The failed evaluation above is a hypothetical future boundary; the
        // live authority advances monotonically below from its last renewal.
        session.renew_lease(1,25000,10000).unwrap();
        let e=session.snapshot().epoch;
        session.control(Some(&who),"synthetic",command(3,Action::Exit{epoch:e}),11000).unwrap();
        for _ in 0..100 {w.activity_until(Activity::Listening,session.business_deadline(11000));w.progress(session.business_exit_at().unwrap());}
        assert_eq!(w.evaluate(t+Duration::from_secs(15)),Decision::Keep);
        assert_eq!(w.evaluate(t+Duration::from_secs(16)),Decision::Close(Reason::IdleNoProgress));
    }
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
    fn recognition_wait_after_real_speech_outlives_idle_but_not_its_fixed_budget() {
        let t=Instant::now();let w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();
        w.input_frame(t,160);w.asr_speech(t+Duration::from_secs(1));
        for sec in [6,8,10,15] {assert_eq!(w.evaluate(t+Duration::from_secs(sec)),Decision::Keep);}
        assert_eq!(w.evaluate(t+Duration::from_secs(16)),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn recognition_final_returns_to_signed_idle_and_cannot_revive_without_speech() {
        let t=Instant::now();let w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();
        w.input_frame(t,160);w.asr_speech(t+Duration::from_secs(1));
        w.asr_final(t+Duration::from_secs(9));
        assert_eq!(w.evaluate(t+Duration::from_secs(9)),Decision::Keep);
        assert_eq!(w.evaluate(t+Duration::from_secs(14)),Decision::Close(Reason::IdleNoProgress));
        w.asr_final(t+Duration::from_secs(15));
        assert_eq!(w.evaluate(t+Duration::from_secs(15)),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn expired_ordered_generation_allows_one_rtc_handoff_without_renewing_upload() {
        let t=Instant::now();let w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();
        w.input_frame(t,160);
        let protocol_end=t+Duration::from_secs(7);
        w.activity_until(Activity::Input,Some(w.input_transition_deadline(protocol_end)));
        // The protocol uses strict >, and its next tick must get to complete
        // the transition instead of racing a whole-job close at exactly 7s.
        assert_eq!(w.evaluate(protocol_end),Decision::Keep);
        w.first_turn_to_rtc(t+Duration::from_millis(7001));
        w.activity_until(Activity::Input,None);
        for ms in [7002,9000,12000] {
            w.first_turn_to_rtc(t+Duration::from_millis(ms));
            assert_eq!(w.evaluate(t+Duration::from_millis(ms)),Decision::Keep);
        }
        assert_eq!(w.evaluate(t+Duration::from_millis(12001)),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn missing_handoff_and_unknown_policy_cannot_be_extended_forever() {
        let t=Instant::now();let w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();
        w.input_frame(t,160);let until=w.input_transition_deadline(t+Duration::from_secs(7));
        for _ in 0..100 {w.activity_until(Activity::Input,Some(until));}
        assert_eq!(w.evaluate(t+Duration::from_secs(12)),Decision::Close(Reason::IdleNoProgress));
        let no=Runtime::from_settings("enforce",SN,ROOM,None,t).unwrap();no.first_turn_to_rtc(t+Duration::from_secs(70));
        assert_eq!(no.evaluate(t+Duration::from_secs(1000)),Decision::Observe(Reason::UnknownPolicy));
        let empty=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();empty.first_turn_to_rtc(t+Duration::from_secs(59));
        assert_eq!(empty.evaluate(t+Duration::from_secs(60)),Decision::Close(Reason::StartupNoInput));
    }
    #[tokio::test]
    async fn pending_output_gate_keeps_its_existing_budget_after_late_first_pcm() {
        let t=Instant::now()-Duration::from_secs(40);
        let w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();w.input_frame(t,160);
        let (ready_tx,ready_rx)=tokio::sync::watch::channel(false);
        let gate=crate::gate::OutputGate::new(ready_rx);
        let (tx,rx)=tokio::sync::mpsc::channel(2);let (fatal_tx,mut fatal_rx)=tokio::sync::mpsc::channel(2);
        let mut output=gate.wrap(rx,fatal_tx);tx.send(vec![1,2,3,4]).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(20),output.recv()).await.is_err());
        w.activity_until(Activity::Reply,Some(reply_startup_deadline(t,true,None)));
        assert_eq!(w.evaluate(Instant::now()),Decision::Keep);
        ready_tx.send(true).unwrap();assert_eq!(output.recv().await,Some(vec![1,2,3,4]));
        assert!(fatal_rx.try_recv().is_err());
        assert_eq!(w.evaluate(t+Duration::from_secs(45)),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn receipt_deadline_and_late_sentence_connection_are_bounded_without_poll_renewal() {
        let t=Instant::now();let w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();w.input_frame(t,160);
        let initial=reply_startup_deadline(t,false,Some(t+Duration::from_secs(50)));
        w.activity_until(Activity::Reply,Some(initial));
        assert_eq!(w.evaluate(t+Duration::from_secs(49)),Decision::Keep);
        assert_eq!(w.evaluate(t+Duration::from_secs(50)),Decision::Close(Reason::IdleNoProgress));
        // A later sentence may use the existing 10s connection budget after
        // the initial response hold. Anchor it to actual last output, not polls.
        let pcm_at=t+Duration::from_secs(100);w.progress(pcm_at);
        for _ in 0..100 {w.activity_until(Activity::Reply,Some(reply_deadline(initial,Some(pcm_at))));}
        assert_eq!(w.evaluate(t+Duration::from_secs(109)),Decision::Keep);
        assert_eq!(w.evaluate(t+Duration::from_secs(110)),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn delayed_first_input_must_allow_vad_to_classify_before_idle_close() {
        let t=Instant::now();let w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();
        // Connection/prebuild can validly consume 40s of the existing 60s
        // startup budget. One 10ms PCM frame cannot fill a 32ms VAD window.
        w.input_frame(t+Duration::from_secs(40),160);
        assert_eq!(w.evaluate(t+Duration::from_millis(40010)),Decision::Keep);
        w.progress(t+Duration::from_millis(40032));
        assert_eq!(w.evaluate(t+Duration::from_millis(45031)),Decision::Keep);
        assert_eq!(w.evaluate(t+Duration::from_millis(45032)),Decision::Close(Reason::IdleNoProgress));
    }
    #[test]
    fn missing_durable_retry_demotes_enforcement_without_resetting_progress() {
        let t=Instant::now();let mut w=Runtime::from_settings("enforce",SN,ROOM,Some(&policy()),t).unwrap();
        w.first_frame(t);w.progress(t+Duration::from_secs(4));w.observe_only();
        assert!(w.startup_deadline().is_none());
        assert_eq!(w.evaluate(t+Duration::from_secs(8)),Decision::Keep);
        assert_eq!(w.evaluate(t+Duration::from_secs(9)),Decision::Observe(Reason::IdleNoProgress));
    }
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
        assert_eq!(w.evaluate(t+Duration::from_millis(5000)),Decision::Keep);
        assert_eq!(w.evaluate(t+Duration::from_millis(9999)),Decision::Close(Reason::IdleNoProgress));
        p.progress(t+Duration::from_millis(10000));
        assert_eq!(w.evaluate(t+Duration::from_millis(14999)),Decision::Keep);
        assert_eq!(w.evaluate(t+Duration::from_millis(15000)),Decision::Close(Reason::IdleNoProgress));
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
