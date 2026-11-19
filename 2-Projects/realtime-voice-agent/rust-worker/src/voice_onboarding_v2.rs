//! Client-owned fixed three-question protocol. No prompts, ordinary LLM or TTS.
use super::*;
impl Session {
    fn body_v2(&self, action: &str, request: &str) -> Value {
        json!({"v":2,"trace_id":self.trace,"session_id":self.session,"lesson_id":self.lesson,
            "request_id":request,"question_index":self.question,"revision":self.revision,"action":action})
    }
    fn state_v2(&mut self, action: &str, result: &str, memory: &str, request: &str) -> Vec<Effect> {
        let mut v = self.body_v2(action, request);
        v["result"] = json!(result);
        v["memory_write"] = json!(memory);
        self.state = v.clone();
        if let Some(r) = self.requests.get_mut(request) {
            r.1 = Some(v.clone());
        }
        vec![Effect::State(v)]
    }
    pub(super) fn control_v2(
        &mut self,
        e: &control::Envelope,
        identity: Option<&str>,
        now: u64,
        listening: bool,
    ) -> Vec<Effect> {
        if !self.trusted_origin(e, identity) || e.payload["trace_id"] != self.trace || listening {
            return vec![];
        }
        let p = &e.payload;
        // Simulation never reaches a profile writer; unknown payload keys fail closed.
        if p.as_object().is_none_or(|m| {
            m.keys().any(|k| {
                ![
                    "v",
                    "trace_id",
                    "session_id",
                    "lesson_id",
                    "request_id",
                    "question_index",
                    "revision",
                    "action",
                    "entry",
                    "audio_status",
                ]
                .contains(&k.as_str())
            })
        }) {
            return vec![];
        }
        let (Some(lesson), Some(request), Some(action), Some(q), Some(rev)) = (
            p["lesson_id"].as_str(),
            p["request_id"].as_str(),
            p["action"].as_str(),
            p["question_index"].as_u64(),
            p["revision"].as_u64(),
        ) else {
            return vec![];
        };
        if !valid_id(lesson)
            || !valid_id(request)
            || q > 3
            || rev > 1000000
            || self.lesson.as_ref().is_some_and(|l| l != lesson)
        {
            return vec![];
        }
        if let Some((old, reply)) = self.requests.get(request) {
            return if old == p {
                reply.clone().map(Effect::State).into_iter().collect()
            } else {
                vec![]
            };
        }
        if self.terminal || e.seq <= self.seq || self.requests.len() >= 96 {
            return vec![];
        }
        if p.get("entry").is_some_and(|v| {
            ![json!("scheduled"), json!("early_wake"), json!("next_day")].contains(v)
        }) || p.get("audio_status").is_some_and(|v| {
            action != "audio_complete" || ![json!("complete"), json!("failed")].contains(v)
        }) {
            return vec![];
        }
        let close = matches!(action, "finish" | "cancel");
        let expired = self.tick_v2(now);
        if self.phase == "expired" {
            if close {
                self.terminal = true;
            }
            return expired;
        }
        match action {
            "begin" if self.started.is_none() && rev == 0 && q == 0 => {}
            "finish" | "cancel" if rev >= self.revision => {}
            "question_started"
                if self.active() && q == self.question + 1 && rev > self.revision => {}
            "audio_complete"
                if self.active()
                    && q == self.question
                    && q > 0
                    && self.phase == "speaking"
                    && rev > self.revision => {}
            "question_skipped"
                if self.active() && q == self.question && q > 0 && rev > self.revision => {}
            _ => return vec![],
        }
        if self.started.is_none() {
            self.started = Some(now);
            self.lesson = Some(lesson.into());
        }
        self.seq = e.seq;
        self.revision = rev;
        self.question = q;
        self.latest = request.into();
        self.pending = false;
        self.answer_request = None;
        self.phase = match action {
            "begin" => "idle",
            "question_started" => "speaking",
            "audio_complete" if p["audio_status"] == "failed" => "skipped",
            "audio_complete" => "ready",
            "question_skipped" => "skipped",
            _ => "completed",
        }
        .into();
        if close {
            self.terminal = true;
        }
        self.requests.insert(request.into(), (p.clone(), None));
        let result = match action {
            "finish" => "finished",
            "cancel" => "cancelled",
            _ => "ack",
        };
        let mut effects = self.state_v2("ack", result, "none", request);
        let brain_action = if action == "audio_complete" && p["audio_status"] == "failed" {
            "question_skipped"
        } else {
            action
        };
        effects.push(Effect::Brain(self.body_v2(brain_action, request)));
        effects
    }
    pub(super) fn tick_v2(&mut self, now: u64) -> Vec<Effect> {
        if self.active() && self.deadline().is_some_and(|d| now >= d) {
            self.phase = "expired".into();
            self.pending = false;
            self.answer_request = None;
            // Keep the audio/chat gate shut until the client finishes/cancels or the room closes.
            // A remote timeout must never start an unsolicited ordinary response mid-lesson.
            let request = uuid::Uuid::new_v4().to_string();
            let mut out = self.state_v2("ack", "expired", "none", &request);
            out.push(Effect::Brain(self.body_v2("cancel", &request)));
            out
        } else {
            vec![]
        }
    }
    pub(super) fn close_v2(&mut self) -> Vec<Effect> {
        if !self.active() {
            return vec![];
        }
        self.terminal = true;
        self.pending = false;
        self.phase = "completed".into();
        self.answer_request = None;
        let request = uuid::Uuid::new_v4().to_string();
        let mut out = self.state_v2("ack", "cancelled", "none", &request);
        out.push(Effect::Brain(self.body_v2("cancel", &request)));
        out
    }
    pub(super) fn answer_v2(&mut self, text: &str, now: u64) -> Vec<Effect> {
        let expired = self.tick_v2(now);
        if !expired.is_empty() {
            return expired;
        }
        if !self.active() || self.blocks_input() || self.pending || text.trim().is_empty() {
            return vec![];
        }
        let request = uuid::Uuid::new_v4().to_string();
        self.answer_request = Some(request.clone());
        self.pending = true;
        if text.chars().count() > 120 {
            return self.failure_v2();
        }
        let mut body = self.body_v2("answer", &request);
        body["text"] = json!(text);
        vec![Effect::Brain(body)]
    }
    pub(super) fn failure_v2(&mut self) -> Vec<Effect> {
        let Some(_) = self.answer_request.take() else {
            return vec![];
        };
        let request = self.latest.clone();
        self.pending = false;
        self.phase = "answered".into();
        self.state_v2("answer_result", "failed", "none", &request)
    }
    pub(super) fn reply_v2(&mut self, value: Value, now: u64) -> Vec<Effect> {
        let expired = self.tick_v2(now);
        if !expired.is_empty() {
            return expired;
        }
        if !self.active()
            || !self.pending
            || value["v"] != 2
            || value["trace_id"] != self.trace
            || value["session_id"] != self.session
            || value["lesson_id"] != json!(self.lesson)
            || value["question_index"] != self.question
            || value["revision"] != self.revision
            || value["action"] != "answer_result"
            || value["request_id"].as_str() != self.answer_request.as_deref()
        {
            return vec![];
        }
        let (Some(result), Some(memory)) =
            (value["result"].as_str(), value["memory_write"].as_str())
        else {
            return self.failure_v2();
        };
        if !["accepted", "unrecognized", "declined", "failed"].contains(&result)
            || !["none", "saved", "skipped", "failed"].contains(&memory)
            || (memory == "saved" && result != "accepted")
        {
            return self.failure_v2();
        }
        self.answer_request = None;
        let request = self.latest.clone();
        self.pending = false;
        self.phase = "answered".into();
        self.state_v2("answer_result", result, memory, &request)
    }
}
