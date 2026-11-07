//! Nonblocking orchestration adapter. Only this job's signed metadata may construct it.
use crate::{
    listening_buffer::SummaryTicket,
    listening_http::{self, Client, Metadata, Snapshot as Policy},
    listening_mode::*,
    listening_runtime::*,
};
use serde_json::{Value, json};
use tokio::{sync::mpsc, task::JoinHandle};

pub struct Effects {
    pub acks: Vec<Value>,
    pub entered: bool,
    pub stopped: bool,
    pub feedback: Option<String>,
}
impl Effects {
    fn new() -> Self {
        Self {
            acks: vec![],
            entered: false,
            stopped: false,
            feedback: None,
        }
    }
}
struct Proposal {
    id: String,
    action: Action,
    deadline: u64,
}
struct Pending {
    cmd: Command,
    participant: String,
}
enum Event {
    Lease {
        epoch: u64,
        id: String,
        request: String,
        result: Result<listening_http::Lease, ()>,
    },
    Content {
        epoch: u64,
        id: String,
        request: String,
        kind: Content,
        result: Result<Value, ()>,
    },
    Closed,
}
enum Content {
    Feedback,
    Summary {
        ticket: SummaryTicket,
        source_hash: String,
        gap: bool,
    },
}
pub struct Adapter {
    pub runtime: ListeningSession,
    client: Client,
    policy: Policy,
    tx: mpsc::Sender<Event>,
    rx: mpsc::Receiver<Event>,
    lease_task: Option<JoinHandle<()>>,
    content_task: Option<JoinHandle<()>>,
    close_task: Option<JoinHandle<()>>,
    content_request: Option<String>,
    lease_request: Option<String>,
    pending: Option<Pending>,
    pending_queries: Vec<Command>,
    pending_deadline: Option<u64>,
    entry: Option<(String, Scene)>,
    counter: u64,
    next_lease: u64,
    last_summary: u64,
    summary_next_attempt: u64,
    summary_failures: u8,
    pending_feedback: Option<(u64, String, &'static str)>,
    entry_completed: bool,
    closing: bool,
    paused_reported: bool,
    proposal: Option<Proposal>,
    voice_counter: u64,
    pending_story: Vec<String>,
    pending_chars: usize,
    speech_generation: u64,
    had_speech_end: bool,
    last_speech_end: Option<u64>,
    speech_began_after_pause: bool,
    last_voice: Option<(u64, crate::listening_voice::Intent)>,
    recent_wake: crate::listening_voice::RecentWake,
    feedback_fragments: crate::listening_voice::FeedbackFragments,
    feedback_fragment_entry: Option<String>,
    released_voice_captions: Vec<String>,
}
impl Drop for Adapter {
    fn drop(&mut self) {
        for t in [
            &mut self.lease_task,
            &mut self.content_task,
            &mut self.close_task,
        ] {
            if let Some(t) = t.take() {
                t.abort();
            }
        }
    }
}
impl Adapter {
    pub fn new(
        cfg: &crate::llm::LlmConfig,
        metadata: Metadata,
        room: &str,
        trace: Option<&str>,
        session: Option<&str>,
    ) -> Option<Self> {
        if !crate::listening_ready::snapshot_matches(
            &metadata.snapshot.sha256,
            &metadata.agent,
            &metadata.worker_build_sha,
        ) {
            return None;
        }
        let client = Client::new(cfg, metadata, room, trace, session)?;
        Self::from_client(client)
    }
    fn from_client(client: Client) -> Option<Self> {
        let runtime = ListeningSession::new(Binding {
            room: client.meta.session.room.clone(),
            trace: client.meta.session.trace_id.clone(),
            session: client.meta.session.session_id.clone(),
        })
        .ok()?;
        let (tx, rx) = mpsc::channel(16);
        let policy = client.meta.snapshot.clone();
        Some(Self {
            runtime,
            client,
            policy,
            tx,
            rx,
            lease_task: None,
            content_task: None,
            close_task: None,
            content_request: None,
            lease_request: None,
            pending: None,
            pending_queries: vec![],
            pending_deadline: None,
            entry: None,
            counter: 0,
            next_lease: 0,
            last_summary: 0,
            summary_next_attempt: 0,
            summary_failures: 0,
            pending_feedback: None,
            entry_completed: false,
            closing: false,
            paused_reported: false,
            proposal: None,
            voice_counter: 0,
            pending_story: vec![],
            pending_chars: 0,
            speech_generation: 0,
            last_speech_end: None,
            had_speech_end: false,
            speech_began_after_pause: false,
            last_voice: None,
            recent_wake: Default::default(),
            feedback_fragments: Default::default(),
            feedback_fragment_entry: None,
            released_voice_captions: vec![],
        })
    }
    pub fn voice_available(&self) -> bool {
        self.client
            .meta
            .voice_control
            .as_ref()
            .is_some_and(|v| v.version == 1 && v.capability == "listening_voice_control_v1")
    }
    fn natural_voice_allowed(&self) -> bool {
        self.voice_available()
            && self.runtime.snapshot().phase == Phase::Normal
            && self.client.meta.grant_expires_at_ms > listening_http::unix_ms()
            && self.policy.tuning.voice_invitation_enabled
            && !self.closing && self.pending.is_none() && self.proposal.is_none()
    }
    pub fn clear_voice_wake(&mut self) {
        self.recent_wake.clear();
        self.flush_feedback_fragments();
    }
    // Pipeline drains after each final/control/poll, before publishing any later final.
    pub fn take_voice_captions(&mut self) -> Vec<String> {
        std::mem::take(&mut self.released_voice_captions)
    }
    pub fn discard_echo_voice_context(&mut self) {
        self.recent_wake.clear();
        // Only the arriving tail was classified as echo. Earlier accepted user
        // fragments remain story/captions, but can no longer authorize a command.
        self.flush_feedback_fragments();
    }
    fn restore_feedback_fragments(&mut self, raw: Vec<String>) {
        let Some(entry) = self.feedback_fragment_entry.take() else { return; };
        for text in raw {
            if self.runtime.restore_held_text(&entry, &text) {
                self.released_voice_captions.push(text);
            }
        }
    }
    fn flush_feedback_fragments(&mut self) {
        let raw = self.feedback_fragments.take_raw();
        self.restore_feedback_fragments(raw);
    }
    fn feedback_fragment_context(&self) -> Option<(u64, Scene)> {
        let s = self.runtime.snapshot();
        (self.voice_available() && s.phase == Phase::Listening && self.entry_completed
            && self.policy.tuning.voice_invitation_enabled
            && self.client.meta.grant_expires_at_ms > listening_http::unix_ms()
            && !self.closing && self.pending.is_none() && self.proposal.is_none()
            && self.pending_feedback.is_none()).then_some((s.epoch, s.scene?))
    }
    fn expire_feedback_fragments(&mut self, now: u64) {
        if self.feedback_fragments.stale(now, self.feedback_fragment_context()) {
            self.flush_feedback_fragments();
        }
    }
    fn feedback_fragment_candidate(&self, text: &str) -> bool {
        self.feedback_fragment_context().is_some_and(|(epoch, scene)|
            self.feedback_fragments.candidate(text, self.runtime.now_ms(), epoch, scene))
    }
    fn feedback_fragment_complete(&self, text: &str) -> Option<String> {
        let (epoch, scene) = self.feedback_fragment_context()?;
        self.feedback_fragments.complete_text(text, self.runtime.now_ms(), epoch, scene)
    }
    pub fn voice_echo_text(&self, text: &str) -> Option<String> {
        if !self.voice_final_candidate(text) { return None; }
        // Compare a completed command, never a coincidentally repeated short
        // prefix or the last one-character fragment of a longer user command.
        self.feedback_fragment_complete(text).or_else(|| Some(text.to_owned()))
    }
    fn active_exit_context(&self) -> bool {
        self.voice_available() && matches!(self.runtime.snapshot().phase,
            Phase::Listening | Phase::FeedbackReserved | Phase::FeedbackActive)
    }
    fn parse_voice(&self, text: &str) -> Option<crate::listening_voice::Utterance> {
        crate::listening_voice::parse(text).or_else(|| {
            self.active_exit_context().then(|| crate::listening_voice::parse_active_exit(text)).flatten()
        })
    }
    pub fn voice_final_candidate(&self, text: &str) -> bool {
        self.parse_voice(text).is_some()
            || self.feedback_fragment_complete(text).is_some()
            || (self.natural_voice_allowed() && (crate::textproc::is_wake_only(text)
                || (self.recent_wake.active(self.runtime.now_ms(), self.runtime.snapshot().epoch)
                    && crate::listening_voice::parse_natural_enter(text).is_some())))
    }
    pub fn voice_candidate(&self, text: &str) -> bool {
        crate::listening_voice::possible_prefix(text)
            || self.feedback_fragment_candidate(text)
            || (self.active_exit_context() && crate::listening_voice::possible_active_exit_prefix(text))
            || (self.natural_voice_allowed() && (crate::textproc::is_wake_only(text) || self.recent_wake.possible_tail(
                text, self.runtime.now_ms(), self.runtime.snapshot().epoch)))
    }
    /// Called only after the pipeline's echo gate, for ordered AND RTC finals.
    pub fn voice_final(&mut self, text: &str) -> Option<Effects> {
        if text.trim().is_empty() { return None; }
        let now = self.runtime.now_ms();
        self.runtime.tick(now);
        let epoch = self.runtime.snapshot().epoch;
        self.expire_feedback_fragments(now);
        if self.natural_voice_allowed() && crate::textproc::is_wake_only(text) {
            self.recent_wake.arm(now, epoch);
            return Some(Effects::new()); // no success playback, no ordinary reply
        }
        let natural = if self.natural_voice_allowed() {
            self.recent_wake.take_enter(text, now, epoch)
        } else { self.recent_wake.clear(); None };
        if let Some(utterance) = self.parse_voice(text).or(natural) {
            self.flush_feedback_fragments();
            return self.voice_utterance(utterance);
        }
        if let Some((epoch, scene)) = self.feedback_fragment_context() {
            let step = self.feedback_fragments.push(text, now, epoch, scene, self.speech_began_after_pause);
            if !step.released.is_empty() { self.restore_feedback_fragments(step.released); }
            if step.consumed && self.feedback_fragment_entry.is_none() {
                self.feedback_fragment_entry = self.runtime.entry_command().map(|e| e.request_id.clone());
            }
            if let Some((utterance, after_pause)) = step.command {
                self.feedback_fragment_entry = None;
                return self.voice_utterance_with_pause(utterance, after_pause);
            }
            if step.consumed { return Some(Effects::new()); }
        }
        None
    }
    fn pause_voice(&mut self, out: &mut Effects) {
        self.clear_voice_wake();
        self.runtime.pause_pending_entry();
        self.proposal = None;
        self.pending_story.clear();
        self.pending_chars = 0;
        self.cancel_content();
        self.pending_feedback = None;
        out.stopped = true;
    }
    fn queue_story(&mut self, text: &str) {
        if text.trim().is_empty() {
            return;
        }
        let size = text.chars().count();
        if self.pending_chars.saturating_add(size) > 12000 {
            // Fail closed rather than silently lose pre-entry context or allocate unbounded memory.
            self.runtime.pause_pending_entry();
            self.pending_story.clear();
            self.pending_chars = 0;
            return;
        }
        self.pending_chars += size;
        self.pending_story.push(text.to_owned());
    }
    /// Only final STT commits commands; this never fabricates an Android sequence.
    pub fn voice_text(&mut self, text: &str) -> Option<Effects> {
        self.clear_voice_wake();
        let utterance = self.parse_voice(text)?;
        self.voice_utterance(utterance)
    }
    fn voice_utterance(&mut self, utterance: crate::listening_voice::Utterance) -> Option<Effects> {
        self.voice_utterance_with_pause(utterance, self.speech_began_after_pause)
    }
    fn voice_utterance_with_pause(&mut self, utterance: crate::listening_voice::Utterance, began_after_pause: bool) -> Option<Effects> {
        use crate::listening_voice::Intent;
        let mut out = Effects::new();
        // Explicit unsupported commands are consumed silently: no false success from ordinary LLM.
        if !self.voice_available() {
            return Some(out);
        }
        let now = self.runtime.now_ms();
        self.runtime.tick(now);
        let state = self.runtime.snapshot();
        if state.phase == Phase::Paused
            || self.client.meta.grant_expires_at_ms <= listening_http::unix_ms()
        {
            return Some(out);
        }
        if self.last_voice.as_ref() == Some(&(self.speech_generation, utterance.intent.clone())) {
            return Some(out);
        }
        self.last_voice = Some((self.speech_generation, utterance.intent.clone()));
        match utterance.intent {
            Intent::Feedback { singing_only } => {
                if state.phase != Phase::Listening
                    || !self.policy.tuning.voice_invitation_enabled
                    || self.pending_feedback.is_some()
                {
                    return Some(out);
                }
                if state.scene == Some(Scene::Singing)
                    && (!singing_only || !began_after_pause)
                {
                    return Some(out);
                }
                if singing_only && state.scene != Some(Scene::Singing) {
                    return Some(out);
                }
                // A bounded, sanitized intent is the only question sent to Brain, never the control phrase.
                self.pending_feedback = Some((
                    state.epoch,
                    "请对刚才的分享给一次简短反馈。".into(),
                    "voice_command",
                ));
                self.next_lease = 0;
            }
            intent => {
                if self.proposal.is_some() || self.pending.is_some() || self.closing {
                    return Some(out);
                }
                let action = match intent {
                    Intent::Enter(scene)
                        if state.phase == Phase::Normal
                            && self.policy.tuning.voice_invitation_enabled
                            && self.policy.scenes.iter().any(|s| s == scene.as_str()) =>
                    {
                        Action::Enter {
                            scene,
                            epoch: state.epoch,
                        }
                    }
                    Intent::Exit
                        if matches!(
                            state.phase,
                            Phase::Listening | Phase::FeedbackReserved | Phase::FeedbackActive
                        ) =>
                    {
                        Action::Exit { epoch: state.epoch }
                    }
                    _ => return Some(out),
                };
                self.voice_counter += 1;
                let id = format!(
                    "{}:voice:{}",
                    self.runtime.binding.trace, self.voice_counter
                );
                let mut payload = json!({"version":1,"proposal_id":id,"session_id":self.runtime.binding.session,"participant":format!("dev-{}",self.client.meta.session.sn),"mode_epoch":state.epoch,"action":if matches!(action,Action::Enter{..}){"enter"}else{"exit"},"ttl_ms":3000});
                if let Action::Enter { scene, .. } = action {
                    payload["scene"] = json!(scene.as_str());
                }
                out.acks.push(json!({"trace_id":self.runtime.binding.trace,"ts_ms":listening_http::unix_ms(),"src":"worker","type":"listening.proposal","payload":payload}));
                let entering = matches!(action, Action::Enter { .. });
                if entering {
                    self.entry_completed = false;
                }
                self.proposal = Some(Proposal {
                    id,
                    action,
                    deadline: now + 3000,
                });
                self.runtime.hold_voice_transition();
                self.cancel_content();
                self.pending_feedback = None;
                out.stopped = true;
                if entering {
                    self.queue_story(&utterance.tail);
                }
            }
        }
        Some(out)
    }
    /// Used only for ordered first-turn admission; control() still authenticates every return packet.
    /// Mode leases and in-flight protocol handshakes retain their accepted
    /// absolute deadlines. No active flag or periodic poll creates a lease.
    pub fn business_deadline(&self) -> Option<std::time::Instant> {
        self.business_deadline_at(self.runtime.now_ms())
    }
    fn business_deadline_at(&self, now: u64) -> Option<std::time::Instant> {
        if self.closing || self.runtime.snapshot().phase == Phase::Paused { return None; }
        let proposal = self.proposal.as_ref().map(|p| p.deadline);
        let pending = self.pending.as_ref().and(self.pending_deadline);
        self.runtime.business_deadline(now).into_iter()
            .chain(proposal.into_iter().chain(pending).filter(|at| *at > now)
                .filter_map(|at| self.runtime.deadline_instant(at)))
            .max()
    }

    pub fn matches_voice_proposal(&self, command: &Command) -> bool {
        self.voice_available()
            && self.proposal.as_ref().is_some_and(|p| {
                command.proposal_id.as_deref() == Some(p.id.as_str())
                    && command.action == p.action
                    && self.runtime.now_ms() < p.deadline
            })
    }
    fn id(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}-{}", self.counter)
    }
    fn body(&mut self, prefix: &str, epoch: u64) -> Option<Value> {
        let (id, scene) = self.entry.clone()?;
        Some(
            json!({"version":1,"request_id":self.id(prefix),"session":self.client.meta.session,"listening_id":id,"scene":scene.as_str(),"mode_epoch":epoch}),
        )
    }
    fn ack(&self, cmd: &Command, stage: &str, reason: Option<&str>) -> Value {
        crate::control::listening_ack(
            &self.runtime.binding.trace,
            cmd.seq,
            &cmd.request_id,
            stage,
            &self.runtime.snapshot(),
            reason,
        )
    }
    fn apply_policy(&mut self, p: Policy) {
        self.runtime.configure(
            p.tuning.max_session_sec * 1000,
            p.tuning.feedback_max_duration_sec * 1000,
            p.tuning.feedback_cooldown_sec * 1000,
        );
        self.policy = p;
    }
    fn lease(&mut self, epoch: u64, applied: bool) {
        if self.lease_task.is_some() {
            return;
        }
        let Some(body) = self.body("lease", epoch) else {
            return;
        };
        let request = body["request_id"].as_str().unwrap().to_owned();
        self.lease_request = Some(request.clone());
        let id = self.entry.as_ref().unwrap().0.clone();
        let client = self.client.clone();
        let tx = self.tx.clone();
        let policy = applied.then(|| self.policy.clone());
        self.lease_task = Some(tokio::spawn(async move {
            let result = client.lease(body, policy.as_ref()).await;
            let _ = tx
                .send(Event::Lease {
                    epoch,
                    id,
                    request,
                    result,
                })
                .await;
        }));
        self.next_lease = self.runtime.now_ms() + 5000;
    }
    pub fn control(
        &mut self,
        participant: Option<&str>,
        trace: &str,
        cmd: Option<Command>,
    ) -> Effects {
        let mut out = Effects::new();
        if !self.runtime.authenticated(participant, trace) {
            return out;
        }
        self.runtime.tick(self.runtime.now_ms());
        let Some(cmd) = cmd else {
            return out;
        };
        if !matches!(cmd.action, Action::State) { self.clear_voice_wake(); }
        match self.runtime.precheck(&cmd) {
            Ok(Some(snapshot)) => {
                let (stage, reason) = if matches!(cmd.action, Action::Enter { .. }) {
                    if snapshot.phase == Phase::Entering {
                        ("received", None)
                    } else if snapshot.phase == Phase::Paused {
                        ("rejected", Some("close_required"))
                    } else if !self.entry_completed {
                        ("rejected", Some("not_ready"))
                    } else {
                        ("completed", None)
                    }
                } else {
                    ("completed", None)
                };
                out.acks.push(crate::control::listening_ack(
                    trace,
                    cmd.seq,
                    &cmd.request_id,
                    stage,
                    &snapshot,
                    reason,
                ));
                return out;
            }
            Err(r) => {
                out.acks
                    .push(self.ack(&cmd, "rejected", Some(reject_code(r))));
                return out;
            }
            Ok(None) => {}
        }
        let now = self.runtime.now_ms();
        if let Some(p) = &self.pending {
            if p.cmd == cmd {
                return out;
            }
            let same = self.pending_queries.iter().find(|q| q.seq == cmd.seq);
            let reason = if cmd.seq == p.cmd.seq || same.is_some_and(|q| q != &cmd) {
                Some("sequence_conflict")
            } else if same.is_none()
                && cmd.seq
                    <= self
                        .pending_queries
                        .last()
                        .map(|q| q.seq)
                        .unwrap_or(p.cmd.seq)
            {
                Some("stale_sequence")
            } else if !matches!(cmd.action, Action::State)
                || (same.is_none() && self.pending_queries.len() >= 32)
            {
                Some("not_ready")
            } else {
                None
            };
            if let Some(reason) = reason {
                out.acks.push(self.ack(&cmd, "rejected", Some(reason)));
                return out;
            }
            let duplicate = same.is_some();
            if !duplicate {
                self.pending_queries.push(cmd.clone());
            }
            let mut snapshot = self.runtime.snapshot();
            snapshot.duplicate = duplicate;
            out.acks.push(crate::control::listening_ack(
                trace,
                cmd.seq,
                &cmd.request_id,
                "received",
                &snapshot,
                None,
            ));
            return out;
        }
        if !matches!(cmd.action, Action::State)
            && (cmd.proposal_id.is_some() || self.proposal.is_some())
        {
            if !self.matches_voice_proposal(&cmd) {
                let reason = if self.proposal.as_ref().is_some_and(|p| now >= p.deadline) {
                    "proposal_expired"
                } else {
                    "proposal_conflict"
                };
                self.pause_voice(&mut out);
                out.acks.push(self.ack(&cmd, "rejected", Some(reason)));
                return out;
            }
            self.proposal = None;
        }
        if let Action::Enter { scene, epoch } = cmd.action {
            if self.runtime.snapshot().phase == Phase::Normal {
                if self.closing
                    || epoch != self.runtime.snapshot().epoch
                    || !self.policy.scenes.iter().any(|v| v == scene.as_str())
                {
                    out.acks.push(self.ack(&cmd, "rejected", Some("not_ready")));
                    return out;
                }
                self.pending = Some(Pending {
                    cmd,
                    participant: participant.unwrap().into(),
                });
                self.pending_deadline = Some(now + 3000);
                self.entry = Some((self.pending.as_ref().unwrap().cmd.request_id.clone(), scene));
                self.lease(epoch + 1, false);
                return out;
            }
        }
        let before = self.runtime.snapshot();
        match self.runtime.control(participant, trace, cmd.clone(), now) {
            Ok(s) => {
                out.acks.push(crate::control::listening_ack(
                    trace,
                    cmd.seq,
                    &cmd.request_id,
                    if s.phase == Phase::Entering {
                        "received"
                    } else {
                        "completed"
                    },
                    &s,
                    None,
                ));
                if !s.duplicate {
                    match cmd.action {
                        Action::Feedback { .. } => {
                            self.pending_feedback = Some((s.epoch, String::new(), "button"));
                            self.cancel_content();
                            self.next_lease = 0;
                        }
                        Action::Exit { .. } => {
                            self.runtime.release_voice_transition();
                            self.pending_story.clear();
                            self.pending_chars = 0;
                            out.stopped = true;
                            self.cancel_content();
                            self.pending_feedback = None;
                            self.close(before.epoch);
                        }
                        _ => {}
                    }
                }
                self.complete_entry(&mut out);
            }
            Err(reason) => out
                .acks
                .push(self.ack(&cmd, "rejected", Some(reject_code(reason)))),
        }
        out
    }
    fn flush_pending_queries(&mut self, out: &mut Effects) {
        let trace = self.runtime.binding.trace.clone();
        let participant = format!("dev-{}", self.client.meta.session.sn);
        for cmd in std::mem::take(&mut self.pending_queries) {
            match self.runtime.control(
                Some(&participant),
                &trace,
                cmd.clone(),
                self.runtime.now_ms(),
            ) {
                Ok(snapshot) => out.acks.push(crate::control::listening_ack(
                    &trace,
                    cmd.seq,
                    &cmd.request_id,
                    "completed",
                    &snapshot,
                    None,
                )),
                Err(r) => out
                    .acks
                    .push(self.ack(&cmd, "rejected", Some(reject_code(r)))),
            }
        }
    }
    fn cancel_content(&mut self) {
        if self.content_task.is_some() {
            self.summary_next_attempt = self.summary_next_attempt.max(self.runtime.now_ms() + 5000);
        }
        self.content_request = None;
        if let Some(t) = self.content_task.take() {
            t.abort();
        }
    }
    fn close(&mut self, epoch: u64) {
        self.clear_voice_wake();
        if self.closing {
            return;
        }
        self.lease_request = None;
        if let Some(t) = self.lease_task.take() {
            t.abort();
        }
        let Some(body) = self.body("close", epoch) else {
            return;
        };
        self.closing = true;
        let tx = self.tx.clone();
        let client = self.client.clone();
        self.close_task = Some(tokio::spawn(async move {
            if client.request("close", body).await.is_ok() {
                let _ = tx.send(Event::Closed).await;
            }
        }));
    }
    pub fn speech_start(&mut self) {
        self.speech_generation = self.speech_generation.saturating_add(1);
        let now = self.runtime.now_ms();
        // Fixed extra 500ms after observed VAD SpeechEnd; breathing/command's own end is insufficient.
        self.speech_began_after_pause = self.had_speech_end
            && self
                .last_speech_end
                .is_some_and(|t| now.saturating_sub(t) >= 500);
        self.had_speech_end = false;
        self.runtime.speech_start(now);
        self.cancel_content();
        self.pending_feedback = None;
        self.next_lease = 0;
    }
    pub fn speech_end(&mut self) {
        self.had_speech_end = true;
        let now = self.runtime.now_ms();
        self.last_speech_end = Some(now);
        self.runtime.speech_end(now);
        if self.pending_feedback.is_some() {
            self.next_lease = 0;
        }
    }
    pub fn cancel_feedback(&mut self) {
        self.runtime.cancel_feedback();
        self.cancel_content();
        self.pending_feedback = None;
        self.next_lease = 0;
    }
    pub fn final_text(&mut self, text: &str) {
        if self.runtime.active()
            && !self.entry_completed
            && self.runtime.snapshot().phase != Phase::Paused
        {
            self.queue_story(text);
            return;
        }
        // P0 high precision direct address only. Narratives, quotes and singing never trigger.
        if self.runtime.snapshot().phase == Phase::Listening
            && self.runtime.snapshot().scene != Some(Scene::Singing)
            && self.policy.tuning.voice_invitation_enabled
            && voice_invitation(text)
        {
            self.pending_feedback = Some((
                self.runtime.snapshot().epoch,
                "请对刚才的分享给一次简短反馈。".into(),
                "voice_invitation",
            ));
        } else {
            self.runtime.final_text(text);
        }
    }
    fn request_feedback(&mut self, epoch: u64, question: String, trigger: &'static str) {
        let now = self.runtime.now_ms();
        if matches!(trigger, "voice_invitation" | "voice_command") {
            // Voice invitations need the same state reservation without spending Android sequence IDs.
            if self.runtime.reserve_voice_feedback(epoch, now).is_err() {
                return;
            }
            self.cancel_content();
            self.pending_feedback = Some((self.runtime.snapshot().epoch, question, trigger));
            self.next_lease = 0;
            return;
        }
        self.send_feedback(epoch, question, trigger);
    }
    fn send_feedback(&mut self, epoch: u64, question: String, trigger: &'static str) {
        if self.content_task.is_some() || self.runtime.snapshot().phase != Phase::FeedbackReserved {
            return;
        }
        let Some(mut body) = self.body("feedback", epoch) else {
            return;
        };
        let c = self.runtime.context();
        body["snapshot_revision"] = json!(self.policy.revision);
        body["snapshot_sha256"] = json!(self.policy.sha256);
        body["summary"] = json!(c.summary.unwrap_or_default());
        body["recent"] = json!(c.recent);
        body["has_gap"] = json!(c.has_gap);
        body["question"] = json!(question);
        body["trigger"] = json!(trigger);
        let id = self.entry.as_ref().unwrap().0.clone();
        let request: String = body["request_id"].as_str().unwrap().into();
        let tx = self.tx.clone();
        let client = self.client.clone();
        self.content_request = Some(request.clone());
        self.content_task = Some(tokio::spawn(async move {
            let result = client.request("feedback", body).await;
            let _ = tx
                .send(Event::Content {
                    epoch,
                    id,
                    request,
                    kind: Content::Feedback,
                    result,
                })
                .await;
        }));
    }
    fn summary(&mut self, epoch: u64) {
        let Some(ticket) = self.runtime.summary_ticket() else {
            return;
        };
        let Some(mut body) = self.body("summary", epoch) else {
            return;
        };
        let segments: Vec<Value> = ticket
            .segments()
            .iter()
            .map(|(seq, rev, text)| json!({"seq":seq,"revision":rev,"text":text}))
            .collect();
        // A prefix can never claim complete context if it was already truncated.
        let gap = self.runtime.context().has_gap;
        let source = json!({"base_summary_version":ticket.base_version(),"previous_summary":ticket.previous_summary.clone().unwrap_or_default(),"has_gap":gap,"segments":segments});
        let source_hash = listening_http::hash(&source);
        for (key, value) in source.as_object().unwrap() {
            body[key] = value.clone();
        }
        body["snapshot_revision"] = json!(self.policy.revision);
        body["snapshot_sha256"] = json!(self.policy.sha256);
        let request: String = body["request_id"].as_str().unwrap().into();
        let id = self.entry.as_ref().unwrap().0.clone();
        let tx = self.tx.clone();
        let client = self.client.clone();
        self.content_request = Some(request.clone());
        self.content_task = Some(tokio::spawn(async move {
            let result = client.request("summary", body).await;
            let _ = tx
                .send(Event::Content {
                    epoch,
                    id,
                    request,
                    kind: Content::Summary {
                        ticket,
                        source_hash,
                        gap,
                    },
                    result,
                })
                .await;
        }));
        self.last_summary = self.runtime.now_ms();
        self.summary_next_attempt = self.last_summary + 5000;
    }
    /// Caller clears native queue after observing capture_is_drained, before invoking this.
    pub fn drained(&mut self) -> Effects {
        let mut out = Effects::new();
        let s = self.runtime.snapshot();
        if s.phase == Phase::Entering && self.runtime.capture_is_drained() {
            let _ = self.runtime.capture_drained(s.epoch, self.runtime.now_ms());
            self.complete_entry(&mut out);
        }
        out
    }
    fn complete_entry(&mut self, out: &mut Effects) {
        if !self.entry_completed && self.runtime.snapshot().phase == Phase::Listening {
            self.entry_completed = true;
            self.runtime.release_voice_transition();
            for text in std::mem::take(&mut self.pending_story) {
                self.runtime.final_text(&text);
            }
            self.pending_chars = 0;
            if let Some(c) = self.runtime.entry_command() {
                out.acks.push(self.ack(c, "completed", None));
            }
        }
    }
    pub fn poll(&mut self) -> Effects {
        let mut out = Effects::new();
        let now = self.runtime.now_ms();
        self.runtime.tick(now);
        if !self.natural_voice_allowed() { self.recent_wake.clear(); }
        self.expire_feedback_fragments(now);
        if self.proposal.as_ref().is_some_and(|p| now >= p.deadline) {
            self.pause_voice(&mut out);
        }
        if self.pending_deadline.is_some_and(|d| now >= d) {
            self.pending_deadline = None;
            if let Some(p) = self.pending.take() {
                let epoch = self.runtime.snapshot().epoch + 1;
                self.runtime.pause_pending_entry();
                out.stopped = true;
                out.acks
                    .push(self.ack(&p.cmd, "rejected", Some("authority_unavailable")));
                self.close(epoch);
                self.flush_pending_queries(&mut out);
            }
        }
        while let Ok(event) = self.rx.try_recv() {
            match event {
                Event::Closed => {
                    self.closing = false;
                    self.close_task = None;
                    self.entry = None;
                }
                Event::Lease {
                    epoch,
                    id,
                    request,
                    result,
                } => {
                    if self.lease_request.as_deref() != Some(&request) {
                        continue;
                    }
                    self.lease_request = None;
                    self.lease_task = None;
                    let current = self.runtime.snapshot();
                    let pending = self
                        .pending
                        .as_ref()
                        .map(|p| matches!(p.cmd.action,Action::Enter{epoch:e,..} if e+1==epoch))
                        .unwrap_or(false);
                    if self.entry.as_ref().is_none_or(|v| v.0 != id)
                        || (!pending && current.epoch != epoch)
                    {
                        self.next_lease = 0;
                        continue;
                    }
                    match result {
                        Ok(lease) => {
                            if lease.ttl_ms == 0 {
                                if self.pending.is_some() {
                                    self.apply_policy(lease.snapshot);
                                    self.lease(epoch, true);
                                }
                                continue;
                            }
                            let remaining = lease
                                .ttl_ms
                                .saturating_sub(lease.received.elapsed().as_millis() as u64);
                            if remaining == 0 {
                                continue;
                            }
                            if self.policy.sha256 != lease.snapshot.sha256 {
                                continue;
                            }
                            if self
                                .runtime
                                .renew_lease(lease.revision, now + remaining, now)
                                .is_err()
                            {
                                continue;
                            }
                            if let Some(p) = self.pending.take() {
                                self.pending_deadline = None;
                                let trace = self.runtime.binding.trace.clone();
                                match self.runtime.control(
                                    Some(&p.participant),
                                    &trace,
                                    p.cmd.clone(),
                                    now,
                                ) {
                                    Ok(s) => {
                                        self.entry_completed = false;
                                        self.last_summary = now;
                                        self.summary_next_attempt = 0;
                                        self.summary_failures = 0;
                                        out.entered = true;
                                        out.stopped = true;
                                        out.acks.push(self.ack(&p.cmd, "received", None));
                                        debug_assert_eq!(s.phase, Phase::Entering);
                                    }
                                    Err(r) => {
                                        self.runtime.pause_pending_entry();
                                        out.stopped = true;
                                        out.acks.push(self.ack(
                                            &p.cmd,
                                            "rejected",
                                            Some(reject_code(r)),
                                        ));
                                        self.close(epoch);
                                    }
                                }
                            }
                            self.flush_pending_queries(&mut out);
                            if let Some((e, q, t)) = self.pending_feedback.take() {
                                if e == self.runtime.snapshot().epoch {
                                    if self.runtime.input_active() {
                                        self.pending_feedback = Some((e, q, t));
                                        continue;
                                    }
                                    if matches!(t, "voice_invitation" | "voice_command")
                                        && self.runtime.snapshot().phase == Phase::Listening
                                    {
                                        self.request_feedback(e, q, t);
                                    } else {
                                        self.send_feedback(e, q, t);
                                    }
                                }
                            }
                        }
                        Err(()) => {
                            if let Some(p) = self.pending.take() {
                                self.pending_deadline = None;
                                self.runtime.pause_pending_entry();
                                out.stopped = true;
                                out.acks.push(self.ack(
                                    &p.cmd,
                                    "rejected",
                                    Some("authority_unavailable"),
                                ));
                                self.close(epoch);
                                self.flush_pending_queries(&mut out);
                            }
                        }
                    }
                }
                Event::Content {
                    epoch,
                    id,
                    request,
                    kind,
                    result,
                } => {
                    if self.content_request.as_deref() != Some(&request) {
                        continue;
                    }
                    self.content_request = None;
                    self.content_task = None;
                    let s = self.runtime.snapshot();
                    if s.epoch != epoch || s.listening_id.as_deref() != Some(&id) {
                        continue;
                    }
                    match kind {
                        Content::Feedback => {
                            let text = result.ok().and_then(|v| {
                                if !content_bound(&v, &request, &id, epoch, self.policy.revision)
                                    || v["max_chars"] != self.policy.tuning.feedback_max_chars
                                    || v["max_duration_ms"]
                                        != self.policy.tuning.feedback_max_duration_sec * 1000
                                {
                                    return None;
                                }
                                let text = v["text"].as_str()?;
                                if text.trim().is_empty()
                                    || text.chars().count() > self.policy.tuning.feedback_max_chars
                                {
                                    return None;
                                }
                                Some(text.to_owned())
                            });
                            if let Some(text) = text {
                                out.feedback = Some(text);
                            } else {
                                self.runtime.cancel_feedback();
                                self.next_lease = 0;
                            }
                        }
                        Content::Summary {
                            ticket,
                            source_hash,
                            gap,
                        } => {
                            let mut committed = false;
                            if let Ok(v) = result {
                                let coverage: Vec<Value> = ticket
                                    .coverage()
                                    .iter()
                                    .map(|(seq, rev)| json!({"seq":seq,"revision":rev}))
                                    .collect();
                                if content_bound(&v, &request, &id, epoch, self.policy.revision)
                                    && v["base_summary_version"] == ticket.base_version()
                                    && v["source_sha256"] == source_hash
                                    && v["covered"] == json!(coverage)
                                    && v["has_gap"] == gap
                                {
                                    if let Some(text) = v["summary"].as_str() {
                                        committed = self.runtime.apply_summary(ticket, text);
                                    }
                                }
                            }
                            if committed {
                                self.summary_failures = 0;
                                self.summary_next_attempt = now + 5000;
                            } else {
                                self.summary_failures = self.summary_failures.saturating_add(1);
                                self.summary_next_attempt = now
                                    + (5000u64.saturating_mul(
                                        1u64 << self.summary_failures.saturating_sub(1).min(3),
                                    ))
                                    .min(30000);
                            }
                        }
                    }
                }
            }
        }
        let s = self.runtime.snapshot();
        if s.phase == Phase::Paused {
            self.cancel_content();
            self.pending_feedback = None;
            if !self.paused_reported {
                self.paused_reported = true;
                out.stopped = true;
                self.close(s.epoch);
            }
        }
        if self.runtime.active()
            && s.phase != Phase::Paused
            && self.lease_task.is_none()
            && now >= self.next_lease
        {
            self.lease(s.epoch, true);
        }
        if s.phase == Phase::Listening
            && self.content_task.is_none()
            && self.pending_feedback.is_none()
            && now >= self.summary_next_attempt
            && (now.saturating_sub(self.last_summary)
                >= self.policy.tuning.summary_interval_sec * 1000
                || self.runtime.raw_chars() >= self.policy.tuning.summary_trigger_chars)
        {
            self.summary(s.epoch);
        }
        out
    }
}
fn content_bound(v: &Value, request: &str, id: &str, epoch: u64, revision: u64) -> bool {
    v["version"] == 1
        && v["request_id"] == request
        && v["listening_id"] == id
        && v["mode_epoch"] == epoch
        && v["snapshot_revision"] == revision
        && v["policy_revision"].as_u64().is_some_and(|r| r >= revision)
}
fn reject_code(r: Reject) -> &'static str {
    match r {
        Reject::InvalidRequest => "invalid_request",
        Reject::NotAuthorized => "not_authorized",
        Reject::SequenceConflict => "sequence_conflict",
        Reject::StaleSequence => "stale_sequence",
        Reject::NotReady => "not_ready",
        Reject::StaleEpoch => "stale_epoch",
        Reject::StaleTurn => "stale_turn",
        Reject::CloseRequired => "close_required",
        Reject::StalePolicy => "stale_policy",
        Reject::InvalidLease => "invalid_lease",
        Reject::UserSpeaking => "user_speaking",
    }
}
fn voice_invitation(text: &str) -> bool {
    let t = text.trim().trim_end_matches(['。', '？', '?', '！', '!']);
    [
        "小可你觉得呢",
        "小可你怎么看",
        "小可现在请你说说",
        "小可请给我反馈",
    ]
    .contains(&t)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn listening_voice_invitation_excludes_quotes_lyrics_and_ordinary_questions() {
        assert!(voice_invitation("小可你觉得呢？"));
        for t in [
            "你觉得呢",
            "故事里的小可你觉得呢",
            "他说：小可你觉得呢",
            "小可你觉得呢然后唱歌",
        ] {
            assert!(!voice_invitation(t));
        }
    }
}

#[cfg(test)]
mod http_joint_tests {
    use super::*;
    async fn wait_entry(a: &mut Adapter) -> Effects {
        for _ in 0..200 {
            let e = a.poll();
            if e.entered || !e.acks.is_empty() {
                return e;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("joint entry timed out")
    }
    #[tokio::test]
    #[ignore = "requires bundled Brain HTTP fixture; run the joint harness"]
    async fn listening_joint_real_brain_http_entry_feedback_and_revocation() {
        let path = std::env::var("P003_LISTENING_JOINT_CONFIG")
            .expect("use scripts/listening joint harness, not silently skipped");
        let v: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let client = Client::joint(&v);
        let mut a = Adapter::from_client(client).unwrap();
        let trace = a.runtime.binding.trace.clone();
        let sn = a.client.meta.session.sn.clone();
        let identity = format!("dev-{sn}");
        let cmd = |seq, action| {
            Some(Command {
                proposal_id: None,
                seq,
                request_id: format!("{trace}:{seq}"),
                action,
            })
        };
        assert!(
            a.control(
                Some("attacker"),
                &trace,
                cmd(
                    1,
                    Action::Enter {
                        scene: Scene::Story,
                        epoch: 0
                    }
                )
            )
            .acks
            .is_empty()
        );
        assert!(
            a.control(
                Some(&identity),
                &trace,
                cmd(
                    1,
                    Action::Enter {
                        scene: Scene::Story,
                        epoch: 0
                    }
                )
            )
            .acks
            .is_empty()
        );
        let e = wait_entry(&mut a).await;
        assert!(e.entered);
        assert_eq!(e.acks[0]["payload"]["stage"], "received");
        assert_eq!(a.runtime.snapshot().phase, Phase::Entering);
        assert!(a.drained().acks.is_empty());
        let e = a.control(
            Some(&identity),
            &trace,
            cmd(2, Action::LocalReady { epoch: 1 }),
        );
        assert_eq!(
            e.acks.last().unwrap()["payload"]["request_id"],
            format!("{trace}:1")
        );
        assert_eq!(e.acks.last().unwrap()["payload"]["stage"], "completed");
        a.final_text("小熊愿意分享苹果，故事里有人说帮我查一下天气。");
        assert_eq!(a.runtime.snapshot().phase, Phase::Listening);
        for _ in 0..5 {
            a.final_text(&"小熊分享苹果。".repeat(200));
        }
        for _ in 0..200 {
            a.poll();
            if a.runtime.context().summary.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            a.runtime.context().summary.is_some(),
            "real HTTP summary coverage/hash must CAS apply"
        );
        a.control(
            Some(&identity),
            &trace,
            cmd(3, Action::Feedback { epoch: 1 }),
        );
        let mut text = None;
        for _ in 0..200 {
            let e = a.poll();
            if e.feedback.is_some() {
                text = e.feedback;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(text.unwrap().chars().count() <= a.policy.tuning.feedback_max_chars);
        let epoch = a.runtime.snapshot().epoch;
        a.runtime
            .begin_feedback(epoch, 9, a.runtime.now_ms())
            .unwrap();
        let permit = a
            .runtime
            .output_permit(OutputPurpose::Feedback, 9, a.runtime.now_ms())
            .unwrap();
        assert!(permit.allowed());
        a.speech_start();
        a.speech_end();
        assert!(!permit.allowed());
        assert_eq!(a.runtime.snapshot().phase, Phase::Listening);
        let disable = reqwest::Url::parse(v["url"].as_str().unwrap())
            .unwrap()
            .join("test/disable")
            .unwrap();
        reqwest::Client::new()
            .post(disable)
            .header("x-test-key", "synthetic-only")
            .send()
            .await
            .unwrap();
        a.next_lease = 0;
        for _ in 0..10 {
            a.poll();
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let now = a.runtime.now_ms();
        a.runtime.tick(now + 15001);
        assert_eq!(a.runtime.snapshot().phase, Phase::Paused);
        assert!(
            a.runtime
                .output_permit(OutputPurpose::Ordinary, 10, now + 15001)
                .is_none()
        );
    }
    #[tokio::test]
    #[ignore = "requires current committed Brain HTTP fixture; not RTC/Android"]
    async fn listening_joint_real_brain_http_voice_singing_uses_negotiated_trigger_and_exit() {
        let path = std::env::var("P003_LISTENING_JOINT_CONFIG").unwrap();
        let config: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let v = &config["voice"];
        let mut a = Adapter::from_client(Client::joint(v)).unwrap();
        assert!(a.voice_available());
        let e = a.voice_text("小可，听我唱首歌。月亮出来了。").unwrap();
        let proposal = e.acks[0]["payload"]["proposal_id"]
            .as_str()
            .unwrap()
            .to_owned();
        a.final_text("花儿也笑了。");
        let identity = "dev-BJP00326070803800006";
        let trace = "trace-test-1";
        a.control(
            Some(identity),
            trace,
            Some(Command {
                seq: 1,
                request_id: format!("{trace}:1"),
                proposal_id: Some(proposal),
                action: Action::Enter {
                    scene: Scene::Singing,
                    epoch: 0,
                },
            }),
        );
        assert!(wait_entry(&mut a).await.entered);
        assert_eq!(a.runtime.snapshot().phase, Phase::Entering);
        a.drained();
        let e = a.control(
            Some(identity),
            trace,
            Some(Command {
                seq: 2,
                request_id: format!("{trace}:2"),
                proposal_id: None,
                action: Action::LocalReady { epoch: 1 },
            }),
        );
        assert_eq!(e.acks.last().unwrap()["payload"]["stage"], "completed");
        assert!(a.runtime.context().recent.contains("月亮出来了"));
        assert!(!a.runtime.context().recent.contains("听我唱首歌"));
        // Actual route/authority validate the new trigger, with model and registry doubles only.
        a.speech_start();
        a.speech_end();
        a.runtime.advance_clock(501);
        a.speech_start();
        a.voice_text("小可，我唱完了，请给我反馈。");
        a.speech_end();
        let mut feedback = None;
        for _ in 0..300 {
            let e = a.poll();
            if e.feedback.is_some() {
                feedback = e.feedback;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            feedback.is_some(),
            "Brain must authorize real voice_command for a negotiated singing entry"
        );
        let epoch = a.runtime.snapshot().epoch;
        a.runtime
            .begin_feedback(epoch, 11, a.runtime.now_ms())
            .unwrap();
        let permit = a
            .runtime
            .output_permit(OutputPurpose::Feedback, 11, a.runtime.now_ms())
            .unwrap();
        assert!(permit.allowed());
        a.runtime.feedback_done(11, a.runtime.now_ms()).unwrap();
        assert_eq!(a.runtime.snapshot().phase, Phase::Listening);
        assert!(!permit.allowed());
        let stats: Value = reqwest::get(format!("{}test/stats", config["url"].as_str().unwrap()))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(
            stats["triggers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["scene"] == "singing" && v["trigger"] == "voice_command")
        );
        a.speech_start();
        let p = a.voice_text("小可结束倾听恢复聊天").unwrap().acks.remove(0);
        let e = a.control(
            Some(identity),
            trace,
            Some(Command {
                seq: 3,
                request_id: format!("{trace}:3"),
                proposal_id: Some(p["payload"]["proposal_id"].as_str().unwrap().into()),
                action: Action::Exit {
                    epoch: a.runtime.snapshot().epoch,
                },
            }),
        );
        assert_eq!(e.acks[0]["payload"]["state"], "normal");
        assert!(!a.runtime.active());
        assert!(!permit.allowed());
        assert!(
            a.runtime
                .output_permit(OutputPurpose::Ordinary, 12, a.runtime.now_ms())
                .is_some()
        );
    }
}
#[cfg(test)]
mod adapter_tests {
    use super::*;
    fn adapter() -> Adapter {
        adapter_at(0)
    }
    fn adapter_at(elapsed: u64) -> Adapter {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../4-Assets/contracts/p003-listening-http-v1.json"
        ))
        .unwrap();
        let client = Client::joint(
            &json!({"url":"http://127.0.0.1:9/","metadata":contract["metadata"]["shape"],"key":"synthetic","token":"synthetic"}),
        );
        let mut a = Adapter::from_client(client).unwrap();
        a.runtime.advance_clock(elapsed);
        let now = a.runtime.now_ms();
        a.apply_policy(a.policy.clone());
        a.runtime.renew_lease(3, now + 10000, now).unwrap();
        let enter = Command {
            proposal_id: None,
            seq: 1,
            request_id: "trace-test-1:1".into(),
            action: Action::Enter {
                epoch: 0,
                scene: Scene::Story,
            },
        };
        a.runtime
            .control(Some("dev-BJP00326070803800006"), "trace-test-1", enter, now)
            .unwrap();
        a.runtime.capture_drained(1, now).unwrap();
        a.runtime
            .control(
                Some("dev-BJP00326070803800006"),
                "trace-test-1",
                Command {
                    proposal_id: None,
                    seq: 2,
                    request_id: "trace-test-1:2".into(),
                    action: Action::LocalReady { epoch: 1 },
                },
                now,
            )
            .unwrap();
        a.entry = Some(("trace-test-1:1".into(), Scene::Story));
        a.entry_completed = true;
        a.next_lease = u64::MAX;
        a
    }
    fn voice_adapter() -> Adapter {
        let mut a = adapter();
        a.client.meta.voice_control = Some(listening_http::VoiceControl {
            version: 1,
            capability: "listening_voice_control_v1".into(),
        });
        a.runtime = ListeningSession::new(a.runtime.binding.clone()).unwrap();
        a.entry = None;
        a.entry_completed = false;
        a
    }
    fn active_voice_adapter() -> Adapter {
        let mut a = adapter();
        a.client.meta.voice_control = Some(listening_http::VoiceControl {
            version: 1, capability: "listening_voice_control_v1".into(),
        });
        a
    }
    #[tokio::test]
    async fn business_listening_lease_and_protocol_transitions_are_absolute_and_bounded() {
        let mut a=active_voice_adapter();let now=a.runtime.now_ms();
        let until=a.business_deadline_at(now).expect("valid story lease");
        for _ in 0..100 {assert_eq!(a.business_deadline_at(now+5000),Some(until));}
        assert!(a.business_deadline_at(now+10000).is_none());
        a.runtime.pause_pending_entry();assert!(a.business_deadline_at(now).is_none());
        let mut a=voice_adapter();assert!(a.business_deadline_at(0).is_none());
        a.runtime.hold_voice_transition();assert!(a.business_deadline_at(0).is_none(),"a bool alone never protects an idle room");
        a.proposal=Some(Proposal{id:"synthetic-proposal".into(),action:Action::Enter{scene:Scene::Story,epoch:0},deadline:3000});
        let until=a.business_deadline_at(0).expect("accepted proposal handshake budget");
        for now in [0,1000,2999] {assert_eq!(a.business_deadline_at(now),Some(until));}
        assert!(a.business_deadline_at(3000).is_none());
        a.closing=true;assert!(a.business_deadline_at(0).is_none());
    }
    fn rtc_final(a: &mut Adapter, text: &str) {
        if a.voice_final(text).is_none() { a.final_text(text); }
    }
    #[tokio::test]
    async fn listening_split_feedback_real_three_finals_route_once_without_recording_command() {
        let mut a = active_voice_adapter();
        a.final_text("礼物是一只紫色风筝");
        a.speech_start();
        rtc_final(&mut a, "小可");
        a.speech_end(); a.runtime.advance_clock(1095); a.speech_start();
        rtc_final(&mut a, "我讲完了");
        assert!(a.pending_feedback.is_none());
        a.speech_end(); a.runtime.advance_clock(1668); a.speech_start();
        rtc_final(&mut a, "请说说你的看法");
        assert_eq!(a.pending_feedback.as_ref().map(|p| p.2), Some("voice_command"));
        assert_eq!(a.runtime.context().recent, "礼物是一只紫色风筝");
    }
    #[tokio::test]
    async fn listening_split_feedback_holds_prefix_until_mismatch_then_preserves_original_story() {
        let mut a = active_voice_adapter();
        rtc_final(&mut a, "小可，");
        rtc_final(&mut a, "我讲完了。");
        assert_eq!(a.runtime.raw_chars(), 0, "not committed as story before classification");
        rtc_final(&mut a, "但现在不要说话");
        assert!(a.pending_feedback.is_none());
        assert_eq!(a.runtime.context().recent, "小可，\n我讲完了。\n但现在不要说话");
    }
    #[tokio::test]
    async fn listening_split_feedback_timeout_preserves_prefix_without_waiting_for_another_final() {
        let mut a = active_voice_adapter();
        rtc_final(&mut a, "小可，");
        assert_eq!(a.runtime.raw_chars(), 0);
        a.runtime.advance_clock(5000);
        a.poll();
        assert_eq!(a.runtime.context().recent, "小可，");
        rtc_final(&mut a, "我讲完了请说说你的看法");
        assert!(a.pending_feedback.is_none(), "expired wake cannot authorize feedback");
    }
    #[tokio::test]
    async fn listening_split_feedback_authority_changes_and_echo_clear_never_authorize_tail() {
        for fault in 0..6 {
            let mut a = active_voice_adapter();
            rtc_final(&mut a, "小可");
            match fault {
                0 => a.client.meta.voice_control = None,
                1 => a.policy.tuning.voice_invitation_enabled = false,
                2 => a.client.meta.grant_expires_at_ms = 0,
                3 => a.runtime.pause_pending_entry(),
                4 => a.discard_echo_voice_context(),
                _ => { a.runtime.reserve_voice_feedback(1, a.runtime.now_ms()).unwrap(); },
            }
            rtc_final(&mut a, "我讲完了请说说你的看法");
            assert!(a.pending_feedback.is_none(), "fault {fault}");
        }
    }
    #[tokio::test]
    async fn listening_split_feedback_does_not_make_normal_chat_wait() {
        let mut a = voice_adapter();
        assert!(a.voice_final("小可").is_some());
        assert!(a.voice_final("我讲完了").is_none());
        assert!(a.voice_final("请说说你的看法").is_none());
        assert!(a.pending_feedback.is_none());
    }
    #[tokio::test]
    async fn listening_split_feedback_tail_is_echo_candidate_before_any_mutation() {
        let mut a = active_voice_adapter();
        rtc_final(&mut a, "小可");
        assert!(!a.voice_final_candidate("我讲完了"));
        rtc_final(&mut a, "我讲完了");
        assert!(a.voice_final_candidate("请说说你的看法"));
        assert_eq!(a.voice_echo_text("请说说你的看法").as_deref(), Some("小可我讲完了请说说你的看法"));
        a.discard_echo_voice_context();
        assert!(!a.voice_final_candidate("请说说你的看法"));
        rtc_final(&mut a, "请说说你的看法");
        assert!(a.pending_feedback.is_none());
    }
    #[tokio::test]
    async fn listening_split_singing_feedback_retains_first_pause_across_vad_fragments() {
        for initially_paused in [false, true] {
            let mut a = active_voice_adapter();
            a.runtime = ListeningSession::new(a.runtime.binding.clone()).unwrap();
            let now = a.runtime.now_ms();
            a.runtime.renew_lease(3, now + 10000, now).unwrap();
            a.runtime.control(Some("dev-BJP00326070803800006"), "trace-test-1", Command {
                seq: 1, request_id: "trace-test-1:1".into(), proposal_id: None,
                action: Action::Enter { epoch: 0, scene: Scene::Singing },
            }, now).unwrap();
            a.runtime.capture_drained(1, now).unwrap();
            a.runtime.control(Some("dev-BJP00326070803800006"), "trace-test-1", Command {
                seq: 2, request_id: "trace-test-1:2".into(), proposal_id: None,
                action: Action::LocalReady { epoch: 1 },
            }, now).unwrap();
            if initially_paused { a.speech_end(); a.runtime.advance_clock(501); }
            a.speech_start(); rtc_final(&mut a, "小可");
            a.speech_end(); a.runtime.advance_clock(100); a.speech_start();
            rtc_final(&mut a, "我唱完了");
            a.speech_end(); a.runtime.advance_clock(100); a.speech_start();
            rtc_final(&mut a, "请给我反馈");
            assert_eq!(a.pending_feedback.is_some(), initially_paused);
            if initially_paused { assert_eq!(a.runtime.raw_chars(), 0); }
        }
    }
    #[tokio::test]
    async fn listening_split_feedback_releases_captions_in_order_once_on_mismatch_and_timer() {
        let mut a = active_voice_adapter();
        rtc_final(&mut a, "小可，"); rtc_final(&mut a, "我讲完了。");
        assert!(a.take_voice_captions().is_empty());
        rtc_final(&mut a, "但不要回复");
        assert_eq!(a.take_voice_captions(), ["小可，", "我讲完了。"]);
        assert!(a.take_voice_captions().is_empty());
        rtc_final(&mut a, "小可，"); a.runtime.advance_clock(5000); a.poll();
        assert_eq!(a.take_voice_captions(), ["小可，"]);
        assert!(a.take_voice_captions().is_empty());
    }
    #[tokio::test]
    async fn listening_split_feedback_expired_lease_retains_prior_authorized_story_only() {
        let mut a = active_voice_adapter();
        rtc_final(&mut a, "小可，");
        a.runtime.advance_clock(10001); a.poll();
        assert_eq!(a.runtime.snapshot().phase, Phase::Paused);
        assert_eq!(a.runtime.context().recent, "小可，", "already accepted prefix belongs to original story");
        rtc_final(&mut a, "我讲完了请说说你的看法");
        assert!(a.pending_feedback.is_none());
        assert_eq!(a.runtime.context().recent, "小可，");
    }
    #[tokio::test]
    async fn listening_split_feedback_echo_tail_does_not_erase_prior_user_fragments() {
        let mut a = active_voice_adapter();
        rtc_final(&mut a, "小可，"); rtc_final(&mut a, "我讲完了。");
        // Pipeline has classified only the new tail as echo; prior accepted
        // fragments must be released, while the echo itself is never appended.
        a.discard_echo_voice_context();
        assert_eq!(a.runtime.context().recent, "小可，\n我讲完了。");
        assert_eq!(a.take_voice_captions(), ["小可，", "我讲完了。"]);
        assert!(!a.voice_final_candidate("请说说你的看法"));
        assert!(a.pending_feedback.is_none());
    }
    #[tokio::test]
    async fn listening_split_feedback_partial_is_not_an_echo_command() {
        let mut a = active_voice_adapter();
        assert!(!a.voice_final_candidate("小可"), "a short prefix alone cannot be compared to prior TTS");
        rtc_final(&mut a, "小可");
        assert!(!a.voice_final_candidate("我讲完了"));
        rtc_final(&mut a, "我讲完了");
        assert!(a.voice_final_candidate("请说说你的看法"));
    }
    #[tokio::test]
    async fn listening_voice_recent_wake_proposes_at_ten_seconds_without_forging_transcript() {
        let mut a=voice_adapter();
        assert!(a.voice_final("小可").unwrap().acks.is_empty());
        assert_eq!(a.runtime.snapshot().phase,Phase::Normal);
        assert!(a.voice_candidate("我要给你讲"));
        assert!(!a.voice_candidate("我今天天气"));
        a.runtime.advance_clock(9982);
        let e=a.voice_final("我要给你讲一个故事。从前有只猫").unwrap();
        assert_eq!(e.acks.len(),1);
        assert_eq!(e.acks[0]["payload"]["action"],"enter");
        assert_eq!(e.acks[0]["payload"]["scene"],"story");
        assert_eq!(e.acks[0]["payload"]["ttl_ms"],3000);
        assert_eq!(a.pending_story,vec!["从前有只猫"]);
        assert!(a.voice_final("我要给你讲一个故事").is_none());
    }
    #[tokio::test]
    async fn listening_voice_recent_wake_ordinary_final_consumes_and_full_command_still_works() {
        let mut a=voice_adapter();
        a.voice_final("小可小可。");
        assert!(a.voice_final("天空为什么是蓝色的").is_none());
        assert!(a.voice_final("我给你讲一个故事").is_none());
        assert!(a.voice_final("小可先听我讲个故事").unwrap().acks.len()==1);
        let mut fresh=voice_adapter();
        assert!(fresh.voice_final("先听我讲故事").is_none(),"new room has no wake");
    }
    #[tokio::test]
    async fn listening_voice_recent_wake_fails_closed_on_capability_policy_grant_epoch_and_pause() {
        for fault in 0..6 {
            let mut a=voice_adapter();a.voice_final("小可");
            match fault {
                0=>a.client.meta.voice_control=None,
                1=>a.client.meta.grant_expires_at_ms=0,
                2=>a.policy.tuning.voice_invitation_enabled=false,
                3=>a.runtime.advance_clock(15000),
                4=>a.runtime.pause_pending_entry(),
                _=>a.policy.scenes.retain(|s|s!="story"),
            }
            assert!(a.voice_final("我给你讲一个故事").is_none_or(|e|e.acks.is_empty()),"fault {fault}");
            assert!(a.proposal.is_none());
        }
        let mut a=voice_adapter();a.client.meta.voice_control=None;
        assert!(a.voice_final("小可").is_none());
        assert!(a.voice_final("先听我讲故事").is_none());
    }
    fn voice_enter(a: &mut Adapter, proposal: &Value) -> Effects {
        a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(Command {
                seq: 1,
                request_id: "trace-test-1:1".into(),
                proposal_id: proposal["payload"]["proposal_id"]
                    .as_str()
                    .map(str::to_owned),
                action: Action::Enter {
                    epoch: 0,
                    scene: Scene::Story,
                },
            }),
        )
    }
    #[tokio::test]
    async fn listening_voice_entry_retains_tail_and_transition_story_until_double_confirmation() {
        let mut a = voice_adapter();
        let e = a.voice_text("小可，先听我讲个故事。从前有只猫。").unwrap();
        let proposal = &e.acks[0];
        assert!(e.stopped);
        assert!(a.runtime.active());
        assert_eq!(proposal["type"], "listening.proposal");
        assert!(proposal.get("seq").is_none());
        a.final_text("后来下雨了。");
        voice_enter(&mut a, proposal);
        inject_lease(&mut a, 1);
        assert!(a.poll().entered);
        assert_eq!(a.runtime.snapshot().phase, Phase::Entering);
        a.final_text("小猫回家了。");
        assert!(
            a.runtime.context().recent.is_empty(),
            "only complete entry commits the pending story"
        );
        a.drained();
        let e = a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(Command {
                seq: 2,
                request_id: "trace-test-1:2".into(),
                proposal_id: None,
                action: Action::LocalReady { epoch: 1 },
            }),
        );
        assert!(
            e.acks
                .iter()
                .any(|a| a["payload"]["request_id"] == "trace-test-1:1"
                    && a["payload"]["stage"] == "completed")
        );
        let c = a.runtime.context();
        assert!(
            c.recent.contains("从前有只猫")
                && c.recent.contains("后来下雨")
                && c.recent.contains("小猫回家")
        );
        assert!(!c.recent.contains("先听我"));
    }
    #[tokio::test]
    async fn listening_voice_legacy_client_never_proposes_or_speaks_a_fake_entry() {
        let mut a = voice_adapter();
        a.client.meta.voice_control = None;
        let e = a.voice_text("小可听我唱首歌").unwrap();
        assert!(e.acks.is_empty() && e.feedback.is_none());
        assert!(!a.runtime.active());
    }
    #[tokio::test]
    async fn listening_voice_proposal_timeout_pauses_and_cannot_voice_exit() {
        let mut a = voice_adapter();
        a.voice_text("小可先听我讲故事").unwrap();
        a.runtime.advance_clock(3001);
        assert!(a.poll().stopped);
        assert_eq!(a.runtime.snapshot().phase, Phase::Paused);
        assert!(a.voice_text("小可退出倾听模式").unwrap().acks.is_empty());
        assert!(
            a.runtime
                .output_permit(OutputPurpose::Ordinary, 5, a.runtime.now_ms())
                .is_none()
        );
    }
    #[tokio::test]
    async fn listening_voice_singing_requires_pause_before_command_and_never_records_command() {
        let mut a = adapter();
        a.client.meta.voice_control = Some(listening_http::VoiceControl {
            version: 1,
            capability: "listening_voice_control_v1".into(),
        });
        a.entry = Some(("trace-test-1:1".into(), Scene::Singing));
        // Scene belongs to the mode; build a singing entry through the real reducer.
        a.runtime = ListeningSession::new(a.runtime.binding.clone()).unwrap();
        let now = a.runtime.now_ms();
        a.runtime.renew_lease(3, now + 10000, now).unwrap();
        a.runtime
            .control(
                Some("dev-BJP00326070803800006"),
                "trace-test-1",
                Command {
                    seq: 1,
                    request_id: "trace-test-1:1".into(),
                    proposal_id: None,
                    action: Action::Enter {
                        epoch: 0,
                        scene: Scene::Singing,
                    },
                },
                now,
            )
            .unwrap();
        a.runtime.capture_drained(1, now).unwrap();
        a.runtime
            .control(
                Some("dev-BJP00326070803800006"),
                "trace-test-1",
                Command {
                    seq: 2,
                    request_id: "trace-test-1:2".into(),
                    proposal_id: None,
                    action: Action::LocalReady { epoch: 1 },
                },
                now,
            )
            .unwrap();
        a.speech_start();
        a.voice_text("小可我唱完了请给我反馈");
        a.speech_end();
        assert!(
            a.pending_feedback.is_none(),
            "continuous lyrics cannot authorize feedback"
        );
        a.runtime.advance_clock(501);
        a.speech_start();
        a.voice_text("小可我唱完了请给我反馈");
        assert!(a.pending_feedback.is_some());
        inject_lease(&mut a, 1);
        a.poll();
        assert_eq!(a.runtime.snapshot().phase, Phase::Listening);
        a.speech_end();
        inject_lease(&mut a, 1);
        a.poll();
        assert_eq!(a.runtime.snapshot().phase, Phase::FeedbackReserved);
        assert_eq!(a.pending_feedback.as_ref().unwrap().2, "voice_command");
        assert!(!a.runtime.context().recent.contains("请给我反馈"));
        let epoch = a.runtime.snapshot().epoch;
        a.voice_text("小可我唱完了请给我反馈");
        assert_eq!(a.runtime.snapshot().epoch, epoch);
        a.speech_start();
        assert!(a.pending_feedback.is_none());
        assert_eq!(a.runtime.snapshot().phase, Phase::Listening);
    }
    #[tokio::test]
    async fn listening_voice_proposal_binds_sender_trace_epoch_and_payload_replay() {
        let mut a = voice_adapter();
        let p = a.voice_text("小可先听我讲故事").unwrap().acks.remove(0);
        let cmd = Command {
            seq: 1,
            request_id: "trace-test-1:1".into(),
            proposal_id: Some(p["payload"]["proposal_id"].as_str().unwrap().into()),
            action: Action::Enter {
                scene: Scene::Story,
                epoch: 0,
            },
        };
        for (sender, trace) in [
            (Some("dev-foreign"), "trace-test-1"),
            (Some("dev-BJP00326070803800006"), "foreign"),
        ] {
            assert!(a.control(sender, trace, Some(cmd.clone())).acks.is_empty());
            assert!(a.proposal.is_some());
        }
        a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(cmd.clone()),
        );
        // Same Android packet while HTTP entry is pending does not start a new lease/proposal.
        assert!(
            a.control(
                Some("dev-BJP00326070803800006"),
                "trace-test-1",
                Some(cmd.clone())
            )
            .acks
            .is_empty()
        );
        inject_lease(&mut a, 1);
        a.poll();
        a.runtime.advance_clock(3001);
        let e = a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(cmd.clone()),
        );
        assert_eq!(e.acks[0]["payload"]["duplicate"], true);
        assert_eq!(e.acks[0]["payload"]["stage"], "received");
        let mut changed = cmd;
        changed.proposal_id = Some("trace-test-1:voice:99".into());
        assert_eq!(
            a.control(
                Some("dev-BJP00326070803800006"),
                "trace-test-1",
                Some(changed)
            )
            .acks[0]["payload"]["reason"],
            "sequence_conflict"
        );
        let mut b = voice_adapter();
        let p = b.voice_text("小可先听我讲故事").unwrap().acks.remove(0);
        let bad = Command {
            seq: 1,
            request_id: "trace-test-1:1".into(),
            proposal_id: Some(p["payload"]["proposal_id"].as_str().unwrap().into()),
            action: Action::Enter {
                scene: Scene::Story,
                epoch: 9,
            },
        };
        assert!(
            b.control(Some("dev-BJP00326070803800006"), "trace-test-1", Some(bad))
                .stopped
        );
        assert_eq!(b.runtime.snapshot().phase, Phase::Paused);
        let mut fresh = voice_adapter();
        assert!(
            fresh
                .control(
                    Some("dev-BJP00326070803800006"),
                    "trace-test-1",
                    Some(Command {
                        seq: 1,
                        request_id: "trace-test-1:1".into(),
                        proposal_id: Some("trace-test-1:voice:1".into()),
                        action: Action::Enter {
                            scene: Scene::Story,
                            epoch: 0
                        }
                    })
                )
                .stopped
        );
        assert_eq!(
            fresh.runtime.snapshot().phase,
            Phase::Paused,
            "reconnected job cannot inherit old proposal even if trace were replayed"
        );
    }
    #[tokio::test]
    async fn listening_voice_missing_local_ready_overflow_and_expired_lease_stay_silent() {
        let mut a = voice_adapter();
        let p = a.voice_text("小可先听我讲故事").unwrap().acks.remove(0);
        voice_enter(&mut a, &p);
        inject_lease(&mut a, 1);
        a.poll();
        a.drained();
        a.runtime.advance_clock(5001);
        assert!(a.poll().stopped);
        assert_eq!(a.runtime.snapshot().phase, Phase::Paused);
        let mut b = voice_adapter();
        b.voice_text("小可先听我讲故事");
        b.final_text(&"歌".repeat(12001));
        assert!(b.poll().stopped);
        assert_eq!(b.runtime.snapshot().phase, Phase::Paused);
        let mut c = adapter();
        c.client.meta.voice_control = Some(listening_http::VoiceControl {
            version: 1,
            capability: "listening_voice_control_v1".into(),
        });
        c.runtime.advance_clock(10001);
        assert!(c.voice_text("小可退出倾听模式").unwrap().acks.is_empty());
        assert_eq!(c.runtime.snapshot().phase, Phase::Paused);
    }
    #[tokio::test]
    async fn listening_active_exit_aliases_complete_normal_transition() {
        for phrase in ["恢复聊天", "结束倾听恢复聊天", "小可结束倾听", "小可，恢复普通聊天。", "小可小可退出倾听模式"] {
            let mut a = adapter();
            a.client.meta.voice_control = Some(listening_http::VoiceControl {
                version: 1, capability: "listening_voice_control_v1".into(),
            });
            assert!(a.voice_final_candidate(phrase), "{phrase}");
            let e = a.voice_final(phrase).unwrap();
            assert_eq!(e.acks.len(), 1, "{phrase}");
            assert_eq!(e.acks[0]["type"], "listening.proposal");
            assert_eq!(e.acks[0]["payload"]["action"], "exit");
            // A proposal alone must not pretend that Android completed the exit.
            assert_eq!(a.runtime.snapshot().phase, Phase::Listening);
            let e = a.control(Some("dev-BJP00326070803800006"), "trace-test-1", Some(Command {
                seq: 3, request_id: "trace-test-1:3".into(),
                proposal_id: Some(e.acks[0]["payload"]["proposal_id"].as_str().unwrap().into()),
                action: Action::Exit { epoch: 1 },
            }));
            assert!(e.stopped);
            assert_eq!(e.acks[0]["payload"]["state"], "normal");
            assert!(a.runtime.output_permit(OutputPurpose::Ordinary, 10, a.runtime.now_ms()).unwrap().allowed());
        }
    }
    #[tokio::test]
    async fn listening_active_exit_does_not_capture_normal_chat_quotes_or_questions() {
        for phrase in ["恢复聊天", "结束倾听恢复聊天", "小可结束倾听"] {
            let mut a = voice_adapter();
            assert!(!a.voice_final_candidate(phrase));
            assert!(a.voice_final(phrase).is_none());
        }
        for phrase in ["故事里的小可说结束倾听恢复聊天", "歌词是恢复聊天", "不要结束倾听", "结束倾听是什么意思", "可以恢复聊天吗", "小可结束倾听这句话怎么说", "“恢复聊天”"] {
            let mut a = adapter();
            a.client.meta.voice_control = Some(listening_http::VoiceControl {
                version: 1, capability: "listening_voice_control_v1".into(),
            });
            assert!(!a.voice_final_candidate(phrase), "{phrase}");
            assert!(a.voice_final(phrase).is_none(), "{phrase}");
            assert!(a.proposal.is_none());
        }
        let mut unsupported = adapter();
        assert!(unsupported.voice_final("恢复聊天").is_none());
        let mut expired = adapter();
        expired.client.meta.voice_control = Some(listening_http::VoiceControl {
            version: 1, capability: "listening_voice_control_v1".into(),
        });
        expired.runtime.advance_clock(10001);
        assert!(expired.voice_final("恢复聊天").is_none());
        assert!(expired.proposal.is_none());
        assert_eq!(expired.runtime.snapshot().phase, Phase::Paused);
    }
    #[tokio::test]
    async fn listening_voice_exit_returns_only_next_chat_and_never_resurrects_old_output() {
        let mut a = adapter();
        a.client.meta.voice_control = Some(listening_http::VoiceControl {
            version: 1,
            capability: "listening_voice_control_v1".into(),
        });
        let e = a.voice_text("小可结束倾听恢复聊天").unwrap();
        let id = e.acks[0]["payload"]["proposal_id"].as_str().unwrap();
        let e = a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(Command {
                seq: 3,
                request_id: "trace-test-1:3".into(),
                proposal_id: Some(id.into()),
                action: Action::Exit { epoch: 1 },
            }),
        );
        assert!(e.stopped);
        assert_eq!(e.acks[0]["payload"]["state"], "normal");
        assert!(!a.runtime.active());
        assert!(a.pending_story.is_empty() && a.pending_feedback.is_none());
        let next = a
            .runtime
            .output_permit(OutputPurpose::Ordinary, 10, a.runtime.now_ms())
            .unwrap();
        assert!(next.allowed());
        a.runtime.hold_voice_transition();
        a.runtime.release_voice_transition();
        assert!(!next.allowed());
    }
    #[tokio::test]
    async fn listening_voice_state_query_does_not_conflict_with_inflight_proposal() {
        let mut a = voice_adapter();
        let p = a.voice_text("小可先听我讲故事").unwrap().acks.remove(0);
        let deadline = a.proposal.as_ref().unwrap().deadline;
        let q = a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(Command {
                seq: 1,
                request_id: "trace-test-1:1".into(),
                proposal_id: None,
                action: Action::State,
            }),
        );
        assert_eq!(q.acks[0]["payload"]["state"], "normal");
        assert_eq!(a.proposal.as_ref().unwrap().deadline, deadline);
        assert!(a.runtime.active());
        let enter = Command {
            seq: 2,
            request_id: "trace-test-1:2".into(),
            proposal_id: Some(p["payload"]["proposal_id"].as_str().unwrap().into()),
            action: Action::Enter {
                scene: Scene::Story,
                epoch: 0,
            },
        };
        a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(enter),
        );
        inject_lease(&mut a, 1);
        assert!(a.poll().entered);
        assert_eq!(a.runtime.snapshot().phase, Phase::Entering);
    }
    #[test]
    fn listening_voice_finite_rules_match_the_three_frozen_contracts() {
        use crate::listening_voice::{Intent, parse};
        let c: Value = serde_json::from_str(include_str!(
            "../../../../4-Assets/contracts/p003-listening-mode-v1.json"
        ))
        .unwrap();
        let r = &c["voice_control"]["recognition"];
        for (key, scene) in [
            ("story", Scene::Story),
            ("sharing", Scene::Sharing),
            ("singing", Scene::Singing),
        ] {
            for text in r["enter"][key].as_array().unwrap() {
                assert_eq!(
                    parse(text.as_str().unwrap()).unwrap().intent,
                    Intent::Enter(scene)
                );
            }
        }
        for key in ["feedback_story", "feedback_singing", "exit"] {
            for text in r[key].as_array().unwrap() {
                assert!(parse(text.as_str().unwrap()).is_some());
            }
        }
        for text in r["negative_examples"].as_array().unwrap() {
            assert!(parse(text.as_str().unwrap()).is_none(), "{}", text);
        }
    }
    #[tokio::test]
    async fn listening_voice_flag_off_denies_entry_but_preserves_safe_exit() {
        let mut a = voice_adapter();
        a.policy.tuning.voice_invitation_enabled = false;
        assert!(a.voice_text("小可先听我讲故事").unwrap().acks.is_empty());
        assert!(!a.runtime.active());
        let mut b = adapter();
        b.client.meta.voice_control = Some(listening_http::VoiceControl {
            version: 1,
            capability: "listening_voice_control_v1".into(),
        });
        b.policy.tuning.voice_invitation_enabled = false;
        assert!(
            b.voice_text("小可我讲完了请说说你的看法")
                .unwrap()
                .acks
                .is_empty()
        );
        assert!(b.pending_feedback.is_none());
        assert_eq!(
            b.voice_text("小可退出倾听模式").unwrap().acks[0]["payload"]["action"],
            "exit"
        );
    }
    #[tokio::test]
    async fn listening_voice_first_ordered_commit_preserves_tail_without_spending_android_seq() {
        use crate::ordered_pcm as pcm;
        let mut ordered = pcm::Session::new(
            Some("trace-test-1".into()),
            pcm::Limits {
                first_turn_rtc: true,
                ..Default::default()
            },
        )
        .with_expected_session(Some("test-session-1".into()));
        let packet = |t: &str, seq: u64, start: u64, end: u64, samples: &[i16]| {
            let header = json!({"t":t,"input_id":"voice-first","trace_id":"trace-test-1","session_id":"test-session-1","capture_epoch":1,"wake_generation":1,"seq":seq,"start":start,"end":end,"keep_from":0,"boundary_kind":"kws_tail","overlaps_local_playback":false,"sr":16000,"ch":1,"fmt":"s16le"});
            pcm::parse_packet(&pcm::encode_packet(&header, samples)).unwrap()
        };
        ordered.on_packet(&packet("begin", 0, 0, 0, &[]), 0);
        ordered.on_packet(&packet("chunk", 0, 0, 3200, &vec![100; 3200]), 1);
        ordered.drain_submits(|_| true);
        ordered.on_stt_final("小可先听我讲故事。从前有只熊。".into(), 2);
        let mut a = voice_adapter();
        assert!(!a.runtime.active(), "held text alone cannot activate mode");
        assert!(
            crate::listening_voice::possible_prefix(&ordered.held_text()),
            "same predicate suppresses held-final speculation"
        );
        ordered.on_packet(&packet("end", 1, 3200, 3200, &[]), 3);
        ordered.drain_submits(|_| true);
        let (pcm::Decision::Commit(text), _) = ordered.on_stream_end(4) else {
            panic!("complete first turn")
        };
        let p = a.voice_text(&text).unwrap().acks.remove(0);
        assert!(a.runtime.active());
        assert_eq!(a.runtime.snapshot().epoch, 0);
        a.final_text("熊开始爬山。");
        voice_enter(&mut a, &p);
        inject_lease(&mut a, 1);
        assert!(a.poll().entered);
        a.drained();
        a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(Command {
                seq: 2,
                request_id: "trace-test-1:2".into(),
                proposal_id: None,
                action: Action::LocalReady { epoch: 1 },
            }),
        );
        assert!(
            a.runtime.context().recent.contains("从前有只熊")
                && a.runtime.context().recent.contains("熊开始爬山")
        );
        assert!(!a.runtime.context().recent.contains("先听我"));
    }
    fn inject_lease(a: &mut Adapter, epoch: u64) {
        if let Some(t) = a.lease_task.take() {
            t.abort();
        }
        let request = a
            .lease_request
            .clone()
            .unwrap_or_else(|| "lease-test".into());
        a.lease_request = Some(request.clone());
        a.tx.try_send(Event::Lease {
            epoch,
            id: a.entry.as_ref().unwrap().0.clone(),
            request,
            result: Ok(listening_http::Lease {
                snapshot: a.policy.clone(),
                revision: 3,
                ttl_ms: 15000,
                received: std::time::Instant::now(),
            }),
        })
        .unwrap_or_else(|_| panic!("test event queue"));
    }
    #[tokio::test]
    async fn listening_authority_timeout_during_entry_pauses_instead_of_chat() {
        let mut a = adapter();
        a.runtime = ListeningSession::new(a.runtime.binding.clone()).unwrap();
        a.entry = None;
        a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(Command {
                proposal_id: None,
                seq: 1,
                request_id: "trace-test-1:1".into(),
                action: Action::Enter {
                    epoch: 0,
                    scene: Scene::Story,
                },
            }),
        );
        if let Some(t) = a.lease_task.take() {
            t.abort();
        }
        a.runtime.advance_clock(3001);
        let e = a.poll();
        assert!(e.stopped);
        assert_eq!(a.runtime.snapshot().phase, Phase::Paused);
        assert!(
            a.runtime
                .output_permit(OutputPurpose::Ordinary, 9, a.runtime.now_ms())
                .is_none()
        );
    }
    #[tokio::test]
    async fn listening_pending_enter_state_query_preserves_entry_sequence() {
        let mut a = adapter();
        a.runtime = ListeningSession::new(a.runtime.binding.clone()).unwrap();
        a.entry = None;
        a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(Command {
                proposal_id: None,
                seq: 1,
                request_id: "trace-test-1:1".into(),
                action: Action::Enter {
                    epoch: 0,
                    scene: Scene::Story,
                },
            }),
        );
        a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(Command {
                proposal_id: None,
                seq: 2,
                request_id: "trace-test-1:2".into(),
                action: Action::State,
            }),
        );
        inject_lease(&mut a, 1);
        let e = a.poll();
        assert!(
            e.entered,
            "state query must not spend sequence ahead of the pending enter"
        );
        assert_eq!(a.runtime.snapshot().phase, Phase::Entering);
    }
    #[tokio::test]
    async fn listening_duplicate_enter_never_completes_before_both_confirmations() {
        let mut a = adapter();
        a.runtime = ListeningSession::new(a.runtime.binding.clone()).unwrap();
        a.entry = None;
        let command = Command {
            proposal_id: None,
            seq: 1,
            request_id: "trace-test-1:1".into(),
            action: Action::Enter {
                epoch: 0,
                scene: Scene::Story,
            },
        };
        a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(command.clone()),
        );
        inject_lease(&mut a, 1);
        assert!(a.poll().entered);
        let duplicate = a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(command),
        );
        assert_eq!(duplicate.acks[0]["payload"]["stage"], "received");
        assert_eq!(a.runtime.snapshot().phase, Phase::Entering);
    }
    #[tokio::test]
    async fn listening_voice_invitation_preempts_inflight_summary() {
        let mut a = adapter();
        a.content_task = Some(tokio::spawn(async {
            std::future::pending::<()>().await;
        }));
        a.content_request = Some("summary-old".into());
        a.final_text("小可你觉得呢？");
        inject_lease(&mut a, 1);
        a.poll();
        assert_eq!(a.runtime.snapshot().phase, Phase::FeedbackReserved);
        assert!(
            a.content_task.is_none(),
            "voice feedback must cancel old summary before reserving the next epoch"
        );
        assert!(a.pending_feedback.is_some());
    }
    #[tokio::test]
    async fn listening_voice_final_before_vad_end_is_not_lost() {
        let mut a = adapter();
        a.speech_start();
        a.final_text("小可你觉得呢？");
        inject_lease(&mut a, 1);
        a.poll();
        assert!(
            a.pending_feedback.is_some(),
            "STT final can precede SpeechEnd; invitation must wait silently"
        );
        assert_eq!(a.runtime.snapshot().phase, Phase::Listening);
        a.speech_end();
        assert_eq!(a.next_lease, 0);
    }
    #[tokio::test]
    async fn listening_control_tick_cannot_hide_pause_cleanup() {
        let mut a = adapter();
        a.runtime.advance_clock(15001);
        let e = a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(Command {
                proposal_id: None,
                seq: 3,
                request_id: "trace-test-1:3".into(),
                action: Action::State,
            }),
        );
        assert_eq!(e.acks[0]["payload"]["state"], "paused");
        assert!(
            a.poll().stopped,
            "pause must close output/RTC even when control noticed expiry first"
        );
        assert!(!a.poll().stopped);
    }
    #[tokio::test]
    async fn listening_stale_content_does_not_clear_new_inflight_request() {
        let mut a = adapter();
        a.content_request = Some("new".into());
        a.tx.send(Event::Content {
            epoch: 1,
            id: "trace-test-1:1".into(),
            request: "old".into(),
            kind: Content::Feedback,
            result: Err(()),
        })
        .await
        .unwrap();
        a.poll();
        assert_eq!(a.content_request.as_deref(), Some("new"));
    }
    #[tokio::test]
    async fn listening_summary_failure_cannot_retry_on_every_audio_tick() {
        let mut a = adapter();
        for _ in 0..5 {
            a.runtime.final_text(&"甲".repeat(1400));
        }
        a.poll();
        let request = a.content_request.clone().unwrap();
        if let Some(t) = a.content_task.take() {
            t.abort();
        }
        let ticket = a.runtime.summary_ticket().unwrap();
        a.tx.try_send(Event::Content {
            epoch: 1,
            id: "trace-test-1:1".into(),
            request,
            kind: Content::Summary {
                ticket,
                source_hash: String::new(),
                gap: true,
            },
            result: Err(()),
        })
        .unwrap_or_else(|_| panic!("test queue"));
        a.poll();
        assert!(
            a.content_task.is_none(),
            "failed summary must back off even when raw still exceeds threshold"
        );
        for _ in 0..20 {
            a.poll();
        }
        assert!(a.content_task.is_none());
    }
    #[tokio::test]
    async fn listening_summary_threshold_and_interval_are_consumed() {
        for (threshold, elapsed, interval, expected) in [
            (5000, 0, 600, true),
            (8000, 0, 600, false),
            (8000, 61000, 60, true),
            (8000, 61000, 600, false),
        ] {
            let mut a = adapter_at(elapsed);
            a.policy.tuning.summary_trigger_chars = threshold;
            a.policy.tuning.summary_interval_sec = interval;
            for _ in 0..5 {
                a.runtime.final_text(&"甲".repeat(1200));
            }
            a.poll();
            assert_eq!(
                a.content_task.is_some(),
                expected,
                "threshold {threshold} elapsed {elapsed} interval {interval}"
            );
        }
    }
    #[tokio::test]
    async fn listening_feedback_character_tuning_and_reply_binding_are_consumed() {
        for (max, wrong_epoch, accepted) in
            [(40, false, false), (160, false, true), (160, true, false)]
        {
            let mut a = adapter();
            a.policy.tuning.feedback_max_chars = max;
            a.runtime
                .reserve_voice_feedback(1, a.runtime.now_ms())
                .unwrap();
            let epoch = a.runtime.snapshot().epoch;
            a.content_request = Some("f1".into());
            let response = json!({"version":1,"request_id":"f1","listening_id":"trace-test-1:1","mode_epoch":if wrong_epoch {epoch+1}else{epoch},"policy_revision":3,"snapshot_revision":3,"text":"甲".repeat(80),"max_chars":max,"max_duration_ms":12000});
            a.tx.send(Event::Content {
                epoch,
                id: "trace-test-1:1".into(),
                request: "f1".into(),
                kind: Content::Feedback,
                result: Ok(response),
            })
            .await
            .unwrap();
            assert_eq!(a.poll().feedback.is_some(), accepted);
        }
    }
    #[tokio::test]
    async fn listening_voice_flag_and_singing_exclude_automatic_feedback() {
        for (enabled, scene, expected) in [
            (true, Scene::Story, true),
            (false, Scene::Story, false),
            (true, Scene::Singing, false),
        ] {
            let mut a = adapter();
            if scene == Scene::Singing {
                a.runtime = ListeningSession::new(a.runtime.binding.clone()).unwrap();
                let now = a.runtime.now_ms();
                a.runtime.renew_lease(3, now + 15000, now).unwrap();
                a.runtime
                    .control(
                        Some("dev-BJP00326070803800006"),
                        "trace-test-1",
                        Command {
                            proposal_id: None,
                            seq: 1,
                            request_id: "trace-test-1:1".into(),
                            action: Action::Enter { epoch: 0, scene },
                        },
                        now,
                    )
                    .unwrap();
                a.runtime.capture_drained(1, now).unwrap();
                a.runtime
                    .control(
                        Some("dev-BJP00326070803800006"),
                        "trace-test-1",
                        Command {
                            proposal_id: None,
                            seq: 2,
                            request_id: "trace-test-1:2".into(),
                            action: Action::LocalReady { epoch: 1 },
                        },
                        now,
                    )
                    .unwrap();
            }
            a.policy.tuning.voice_invitation_enabled = enabled;
            a.final_text("小可你觉得呢？");
            assert_eq!(a.pending_feedback.is_some(), expected);
        }
    }
    #[tokio::test]
    async fn listening_enter_replay_is_rejected_before_any_http_side_effect() {
        let mut a = adapter();
        let epoch = a.runtime.snapshot().epoch;
        let e = a.control(
            Some("dev-BJP00326070803800006"),
            "trace-test-1",
            Some(Command {
                proposal_id: None,
                seq: 1,
                request_id: "trace-test-1:1".into(),
                action: Action::Enter {
                    epoch,
                    scene: Scene::Sharing,
                },
            }),
        );
        assert_eq!(e.acks[0]["payload"]["reason"], "sequence_conflict");
        assert!(a.lease_task.is_none());
    }
}
