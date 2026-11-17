//! v398 single-lesson authority. No audio synthesis, device commands, or profile values in states.
use crate::control;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};

#[derive(Debug, PartialEq, Eq)]
pub enum InputRoute {
    Ordinary,
    Drop,
    Exit,
}
// Profile answers require fresh input AFTER local playback. Existing exit grammar retains priority.
pub fn route_input(active: bool, blocked: bool, fresh_speech: bool, exit: bool) -> InputRoute {
    if !active {
        InputRoute::Ordinary
    } else if exit {
        InputRoute::Exit
    } else if blocked || !fresh_speech {
        InputRoute::Drop
    } else {
        InputRoute::Ordinary
    }
}

#[derive(Debug, Clone)]
pub enum Effect {
    State(Value),
    Brain(Value),
}

pub struct Session {
    version: u8,
    question: u64,
    phase: String,
    answer_request: Option<String>,
    trace: String,
    session: String,
    identity: String,
    lesson: Option<String>,
    entry: String,
    started: Option<u64>,
    terminal: bool,
    revision: u64,
    brain_revision: u64,
    seq: i64,
    requests: HashMap<String, (Value, Option<Value>)>,
    latest: String,
    missing: Vec<String>,
    audio_count: u32,
    pending: bool,
    pub state: Value,
}
fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
impl Session {
    pub fn new(trace: String, session: String, identity: String) -> Self {
        Self {
            version: 1,
            question: 0,
            phase: "idle".into(),
            answer_request: None,
            trace,
            session,
            identity,
            lesson: None,
            entry: String::new(),
            started: None,
            terminal: false,
            revision: 0,
            brain_revision: 0,
            seq: -1,
            requests: HashMap::new(),
            latest: String::new(),
            missing: vec![],
            audio_count: 0,
            pending: false,
            state: Value::Null,
        }
    }
    pub fn active(&self) -> bool {
        self.started.is_some() && !self.terminal
    }
    pub fn deadline(&self) -> Option<u64> {
        if self.version == 2 && self.phase == "expired" {
            None
        } else {
            self.started.map(|n| n + 180000)
        }
    }
    pub fn blocks_input(&self) -> bool {
        if self.version == 2 {
            return self.active() && (self.phase != "ready" || self.pending);
        }
        self.active()
            && (self.pending
                || self.state["stage"]
                    .as_str()
                    .is_none_or(|s| s.ends_with("speaking")))
    }
    fn emit(&mut self, stage: &str, memory: &str, cue: Option<&str>) -> Vec<Effect> {
        self.revision += 1;
        self.state = json!({"v":1,"session_id":self.session,"lesson_id":self.lesson,"request_id":self.latest,"revision":self.revision,"stage":stage,"memory_write":memory});
        if let Some(cue) = cue {
            if self.audio_count >= 32 {
                return self.end("failed");
            }
            self.audio_count += 1;
            self.state["audio_prompt"] = json!(cue);
            self.state["audio_token"] = json!(format!(
                "v398_{}_{}",
                self.audio_count,
                uuid::Uuid::new_v4().simple()
            ));
        }
        if let Some(v) = self.requests.get_mut(&self.latest) {
            v.1 = Some(self.state.clone());
        }
        vec![Effect::State(self.state.clone())]
    }
    fn brain(&self, action: &str) -> Value {
        json!({"session_id":self.session,"trace_id":self.trace,"lesson_id":self.lesson,"request_id":uuid::Uuid::new_v4().to_string(),"action":action})
    }
    fn end(&mut self, stage: &str) -> Vec<Effect> {
        if !self.active() {
            return vec![];
        }
        self.terminal = true;
        self.pending = false;
        let mut out = self.emit(
            stage,
            if stage == "failed" { "none" } else { "skipped" },
            None,
        );
        out.push(Effect::Brain(self.brain("close")));
        out
    }
    pub fn cancel(&mut self) -> Vec<Effect> {
        if self.version == 2 {
            return self.close_v2();
        }
        self.end("completed")
    }
    pub fn tick(&mut self, now: u64) -> Vec<Effect> {
        if self.version == 2 {
            return self.tick_v2(now);
        }
        if self.active() && self.deadline().is_some_and(|d| now >= d) {
            self.end("failed")
        } else {
            vec![]
        }
    }
    pub fn trusted_origin(&self, e: &control::Envelope, identity: Option<&str>) -> bool {
        e.src == "android"
            && e.kind == "voice_onboarding.request"
            && e.lane.as_deref() == Some("voice_onboarding")
            && e.trace_id == self.trace
            && identity == Some(self.identity.as_str())
            && e.payload["v"] == self.version
            && e.payload["session_id"] == self.session
    }
    /// Same trusted production entry used by pipeline. Duplicate keys never execute a second side effect.
    pub fn control(
        &mut self,
        e: &control::Envelope,
        identity: Option<&str>,
        now: u64,
        listening: bool,
    ) -> Vec<Effect> {
        if self.version == 2 {
            return self.control_v2(e, identity, now, listening);
        }
        if !self.trusted_origin(e, identity) {
            return vec![];
        }
        let p = &e.payload;
        if p["v"] != 1 || p["session_id"] != self.session {
            return vec![];
        }
        let (Some(lesson), Some(request), Some(action), Some(entry)) = (
            p["lesson_id"].as_str(),
            p["request_id"].as_str(),
            p["action"].as_str(),
            p["entry"].as_str(),
        ) else {
            return vec![];
        };
        if !valid_id(lesson)
            || !valid_id(request)
            || !["scheduled", "early_wake", "next_day"].contains(&entry)
        {
            return vec![];
        }
        if self.lesson.as_ref().is_some_and(|l| l != lesson) {
            return vec![];
        }
        let expired = self.tick(now);
        if !expired.is_empty() {
            return expired;
        }
        if let Some((old, reply)) = self.requests.get(request) {
            return if old == p {
                reply.clone().map(Effect::State).into_iter().collect()
            } else {
                vec![]
            };
        }
        if self.terminal
            || e.seq <= self.seq
            || self.requests.len() >= 96
            || p.get("revision")
                .is_some_and(|v| v.as_u64() != Some(self.revision))
        {
            return vec![];
        }
        if listening {
            return self.end("completed");
        }
        match action {
            "begin" if self.started.is_none() => {}
            "cancel" | "finish" if self.started.is_none() || self.active() => {}
            "request_exit_prompt" if self.state["stage"] == "waiting_answer" && !self.pending => {}
            "audio_complete"
                if self.active()
                    && !self.pending
                    && self.state["audio_token"].is_string()
                    && p["audio_token"] == self.state["audio_token"]
                    && [Some("complete"), Some("failed")].contains(&p["audio_status"].as_str()) => {
            }
            _ => return vec![],
        }
        self.seq = e.seq;
        self.latest = request.into();
        self.requests.insert(request.into(), (p.clone(), None));
        if self.started.is_none() {
            self.started = Some(now);
            self.lesson = Some(lesson.into());
            self.entry = entry.into();
        }
        if action == "begin" {
            self.pending = true;
            return vec![Effect::Brain(self.brain("begin"))];
        }
        match action {
            "cancel" | "finish" => self.end("completed"),
            "request_exit_prompt" => self.emit("exit_speaking", "skipped", Some("quiet_exit")),
            "audio_complete" => {
                if p["audio_status"] == "failed" {
                    return self.end("failed");
                }
                match self.state["stage"].as_str() {
                    Some("intro_speaking") => self.next("none"),
                    Some("question_speaking") => self.emit("waiting_answer", "none", None),
                    Some("exit_speaking") => self.emit(
                        "waiting_exit",
                        if self.state["memory_write"] == "saved" {
                            "saved"
                        } else {
                            "skipped"
                        },
                        None,
                    ),
                    _ => vec![],
                }
            }
            _ => vec![],
        }
    }
    fn next(&mut self, memory: &str) -> Vec<Effect> {
        let cue = match self.missing.first().map(String::as_str) {
            Some("age") => "ask_age",
            Some("gender") => "ask_gender",
            Some("nickname") => "ask_nickname",
            None => return self.emit("exit_speaking", memory, Some("complete_exit")),
            _ => return self.end("failed"),
        };
        self.emit("question_speaking", memory, Some(cue))
    }
    pub fn answer(&mut self, text: &str, now: u64) -> Vec<Effect> {
        if self.version == 2 {
            return self.answer_v2(text, now);
        }
        let expired = self.tick(now);
        if !expired.is_empty() {
            return expired;
        }
        if !self.active() || self.pending || text.trim().is_empty() {
            return vec![];
        }
        if self.state["stage"] == "waiting_exit" {
            return self.end("normal_chat");
        }
        if self.state["stage"] != "waiting_answer" {
            return vec![];
        }
        let mut body = self.brain("answer");
        body["revision"] = json!(self.brain_revision);
        body["field"] = json!(self.missing.first());
        body["text"] = json!(text);
        self.pending = true;
        vec![Effect::Brain(body)]
    }
    pub fn brain_failure(&mut self) -> Vec<Effect> {
        if self.version == 2 {
            return self.failure_v2();
        }
        self.end("failed")
    }
    pub fn brain_reply(&mut self, value: Value, now: u64) -> Vec<Effect> {
        if self.version == 2 {
            return self.reply_v2(value, now);
        }
        let expired = self.tick(now);
        if !expired.is_empty() {
            return expired;
        }
        if !self.active() || !self.pending {
            return vec![];
        }
        self.pending = false;
        let Some(rev) = value["revision"].as_u64() else {
            return self.end("failed");
        };
        let Some(missing) = value["missing"].as_array() else {
            return self.end("failed");
        };
        if rev > 1000000
            || missing.len() > 3
            || missing
                .iter()
                .any(|f| !["age", "gender", "nickname"].iter().any(|k| f == k))
        {
            return self.end("failed");
        }
        match value["result"].as_str() {
            Some("ready") if self.state.is_null() && rev == 0 => {
                self.missing = missing
                    .iter()
                    .filter_map(|s| s.as_str().map(str::to_owned))
                    .collect();
                self.emit(
                    "intro_speaking",
                    "none",
                    Some(if self.entry == "early_wake" {
                        "early_intro"
                    } else {
                        "wake_reply"
                    }),
                )
            }
            Some("saved")
                if self.state["stage"] == "waiting_answer"
                    && value["memory_write"] == "saved"
                    && rev == self.brain_revision + 1 =>
            {
                self.brain_revision = rev;
                self.missing = missing
                    .iter()
                    .filter_map(|s| s.as_str().map(str::to_owned))
                    .collect();
                self.next("saved")
            }
            Some("unclear") if rev == self.brain_revision => {
                self.emit("waiting_answer", "none", None)
            }
            Some("declined") if rev == self.brain_revision => self.end("declined"),
            _ => self.end("failed"),
        }
    }
}

/// Async transport owner: no HTTP await on the audio loop. Errors carry no URL/token/body.
pub struct Runtime {
    pub session: Session,
    origin: Instant,
    endpoint: String,
    grant: String,
    client: reqwest::Client,
    pending: Option<tokio::task::JoinHandle<Option<Value>>>,
    queue: VecDeque<Value>,
    in_flight: Option<Value>,
    out_seq: u64,
    out: Vec<Value>,
    expires: i64,
    worker_token: String,
    speech_seen: bool,
}
impl Runtime {
    pub fn from_metadata(
        meta: Option<&Value>,
        trace: Option<&str>,
        session: Option<&str>,
        identity: Option<&str>,
        base: &str,
        query: &str,
    ) -> Option<Self> {
        let m = meta?;
        let grant = m["grant"].as_str()?;
        let expires = m["expires_at_ms"].as_i64()?;
        if ![json!(1), json!(2)].contains(&m["version"])
            || grant.len() != 64
            || !grant.bytes().all(|b| b.is_ascii_hexdigit())
            || base.is_empty()
        {
            return None;
        }
        let worker_token = reqwest::Url::parse(&format!("https://worker.invalid/?{}", query))
            .ok()?
            .query_pairs()
            .find(|(k, _)| k == "token")?
            .1
            .into_owned();
        Some(Self {
            session: {
                let mut s = Session::new(trace?.into(), session?.into(), identity?.into());
                s.version = m["version"].as_u64()? as u8;
                s
            },
            origin: Instant::now(),
            endpoint: format!(
                "{}/internal/voice-onboarding/{}step",
                base.trim_end_matches('/'),
                if m["version"] == 2 { "v2/" } else { "" }
            ),
            grant: grant.into(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_millis(1800))
                .build()
                .ok()?,
            pending: None,
            queue: VecDeque::new(),
            in_flight: None,
            out_seq: 0,
            out: vec![],
            expires,
            worker_token,
            speech_seen: false,
        })
    }
    fn now(&self) -> u64 {
        self.origin.elapsed().as_millis() as u64
    }
    pub fn active(&self) -> bool {
        self.session.active()
    }
    pub fn blocks_input(&self) -> bool {
        self.session.blocks_input()
    }
    pub fn generation(&self) -> (u64, bool, bool) {
        (self.session.revision, self.active(), self.blocks_input())
    }
    pub fn is_v2(&self) -> bool {
        self.session.version == 2
    }
    pub fn input_route(&self, exit: bool) -> InputRoute {
        // Local question/4A/4B audio may itself say an exit word.
        if self.is_v2() && self.active() && (self.blocks_input() || !self.speech_seen) {
            return InputRoute::Drop;
        }
        route_input(self.active(), self.blocks_input(), self.speech_seen, exit)
    }
    pub fn reject_asr(&self) -> bool {
        self.input_route(false) == InputRoute::Drop
    }
    pub fn speech(&mut self) {
        if self.active() && !self.blocks_input() {
            self.speech_seen = true;
        }
    }
    pub fn deadline(&self) -> Option<Instant> {
        if self.active() {
            self.session
                .deadline()
                .map(|d| self.origin + Duration::from_millis(d))
        } else {
            None
        }
    }
    fn start_http(&mut self, body: Value) {
        let client = self.client.clone();
        let url = self.endpoint.clone();
        let grant = self.grant.clone();
        let token = self.worker_token.clone();
        self.in_flight = Some(body.clone());
        self.pending = Some(tokio::spawn(async move {
            let response = client
                .post(url)
                .header("x-p003-onboarding-grant", grant)
                .header("x-p003-worker-token", token)
                .json(&body)
                .send()
                .await
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            response.json().await.ok()
        }));
    }
    fn pump(&mut self) {
        if self.pending.is_none() {
            if let Some(body) = self.queue.pop_front() {
                self.start_http(body);
            }
        }
    }
    fn apply(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::State(v) => {
                    self.out_seq += 1;
                    let seq = if self.is_v2() {
                        json!(self.out_seq)
                    } else {
                        v["revision"].clone()
                    };
                    self.out.push(json!({"trace_id":self.session.trace,"ts_ms":epoch_ms(),"src":"worker","type":"voice_onboarding.state","lane":"voice_onboarding","seq":seq,"payload":v}));
                }
                Effect::Brain(body) => {
                    if !self.is_v2() {
                        if let Some(p) = self.pending.take() {
                            p.abort();
                        }
                        self.start_http(body);
                    } else {
                        let action = body["action"].as_str().unwrap_or("");
                        if ["finish", "cancel"].contains(&action) {
                            self.queue.clear();
                            if let Some(p) = self.pending.take() {
                                p.abort();
                            }
                            self.in_flight = None;
                        } else if ["question_started", "question_skipped"].contains(&action) {
                            // Retire old answers, but preserve ordered begin/start/playback control writes.
                            self.queue.retain(|b| b["action"] != "answer");
                            if self
                                .in_flight
                                .as_ref()
                                .is_some_and(|b| b["action"] == "answer")
                            {
                                if let Some(p) = self.pending.take() {
                                    p.abort();
                                }
                                self.in_flight = None;
                            }
                        }
                        if self.queue.len() < 16 {
                            self.queue.push_back(body);
                        }
                    }
                }
            }
        }
        self.pump();
    }
    pub fn control(&mut self, e: &control::Envelope, identity: Option<&str>, listening: bool) {
        if epoch_ms() >= self.expires
            && !(self.is_v2() && matches!(e.payload["action"].as_str(), Some("finish" | "cancel")))
        {
            return;
        }
        let before = (self.session.revision, self.active(), self.blocks_input());
        let effects = self.session.control(e, identity, self.now(), listening);
        // A cached state reply is transport replay, not a new audio/input turn.
        // Preserve fresh VAD while waiting for its ASR final on request retries.
        if before != (self.session.revision, self.active(), self.blocks_input()) {
            self.speech_seen = false;
        }
        self.apply(effects);
    }
    pub fn answer(&mut self, text: &str) {
        if self.reject_asr() {
            return;
        }
        let effects = self.session.answer(text, self.now());
        self.speech_seen = false;
        self.apply(effects);
    }
    pub fn cancel(&mut self) {
        let effects = self.session.cancel();
        self.apply(effects);
    }
    pub async fn poll(&mut self) -> Vec<Value> {
        let effects = if self.is_v2() {
            self.session.tick(if epoch_ms() >= self.expires {
                u64::MAX
            } else {
                self.now()
            })
        } else if epoch_ms() >= self.expires {
            self.session.brain_failure()
        } else {
            self.session.tick(self.now())
        };
        self.apply(effects);
        if self.pending.as_ref().is_some_and(|p| p.is_finished()) {
            let value = self.pending.take().unwrap().await.ok().flatten();
            let body = self.in_flight.take();
            let effects = if self.is_v2() && body.as_ref().is_some_and(|b| b["action"] != "answer")
            {
                vec![]
            } else {
                match value {
                    Some(v) => self.session.brain_reply(v, self.now()),
                    None => self.session.brain_failure(),
                }
            };
            self.apply(effects);
        }
        if self.blocks_input() {
            self.speech_seen = false;
        }
        std::mem::take(&mut self.out)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        if let Some(p) = self.pending.take() {
            p.abort();
        }
    }
}
fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
#[cfg(test)]
#[path = "voice_onboarding_tests.rs"]
mod tests;
#[path = "voice_onboarding_v2.rs"]
mod v2;
