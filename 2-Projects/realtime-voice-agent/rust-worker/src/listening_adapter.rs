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
        let now = self.runtime.now_ms();
        self.runtime.speech_start(now);
        self.cancel_content();
        self.pending_feedback = None;
        self.next_lease = 0;
    }
    pub fn speech_end(&mut self) {
        let now = self.runtime.now_ms();
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
        self.runtime.final_text(text);
        // P0 high precision direct address only. Narratives, quotes and singing never trigger.
        if self.runtime.snapshot().phase == Phase::Listening
            && self.runtime.snapshot().scene != Some(Scene::Singing)
            && self.policy.tuning.voice_invitation_enabled
            && voice_invitation(text)
        {
            self.pending_feedback = Some((
                self.runtime.snapshot().epoch,
                text.into(),
                "voice_invitation",
            ));
        }
    }
    fn request_feedback(&mut self, epoch: u64, question: String, trigger: &'static str) {
        let now = self.runtime.now_ms();
        if trigger == "voice_invitation" {
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
            if let Some(c) = self.runtime.entry_command() {
                out.acks.push(self.ack(c, "completed", None));
            }
        }
    }
    pub fn poll(&mut self) -> Effects {
        let mut out = Effects::new();
        let now = self.runtime.now_ms();
        self.runtime.tick(now);
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
                                    if t == "voice_invitation"
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
}
#[cfg(test)]
mod adapter_tests {
    use super::*;
    fn adapter() -> Adapter {
        adapter_at(0)
    }
    fn adapter_at(elapsed: u64) -> Adapter {
        let contract: Value =
            serde_json::from_str(include_str!("../../../../4-Assets/contracts/p003-listening-http-v1.json"))
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
