//! Session-owned background search. Networking is never awaited by the audio loop.
use crate::llm::LlmConfig;
use crate::search_policy::{DeliveryGate, Intent};
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

#[derive(Clone)]
struct Api {
    client: reqwest::Client,
    url: reqwest::Url,
    token: String,
    key: String,
}
impl Api {
    fn new(cfg: &LlmConfig) -> Option<Self> {
        let mut url = reqwest::Url::parse(&format!(
            "{}/internal/search-tasks",
            cfg.base_url.trim_end_matches('/')
        ))
        .ok()?;
        if url.scheme() != "https"
            || url.port_or_known_default() != Some(443)
            || url.host_str() != Some("kidshub-ai.hahaxiong.cc")
            || url.username() != ""
            || url.password().is_some()
            || !["/v1/internal/search-tasks", "/_canary/search-20261021/v1/internal/search-tasks"].contains(&url.path())
            || url.fragment().is_some()
        {
            return None;
        }
        let query = reqwest::Url::parse(&format!("https://localhost/?{}", cfg.url_query)).ok()?;
        let token = query
            .query_pairs()
            .find(|(k, _)| k == "token")?
            .1
            .to_string();
        url.set_query(None);
        url.query_pairs_mut().append_pair("room", &cfg.room);
        Some(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .ok()?,
            url,
            token,
            key: cfg.api_key.clone(),
        })
    }
    async fn request(&self, suffix: &str, body: Option<Value>) -> Result<Value> {
        let mut url = self.url.clone();
        url.set_path(&format!("{}{}", self.url.path(), suffix));
        let req = if let Some(body) = body {
            self.client.post(url).json(&body)
        } else {
            self.client.get(url)
        };
        let mut response = req
            .header("x-p003-worker-token", &self.token)
            .bearer_auth(&self.key)
            .send()
            .await
            .map_err(|e| anyhow!(if e.is_timeout() { "search_timeout" } else if e.is_connect() { "search_connect" } else { "search_transport" }))?;
        if !response.status().is_success() {
            return Err(anyhow!("search_http_{}", response.status().as_u16()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| anyhow!("search_body"))? {
            if bytes.len() + chunk.len() > 65536 {
                return Err(anyhow!("search_body_limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
}

enum Command {
    Submit {
        query: String,
        turn: String,
        replace: bool,
        epoch: u64,
        generation: u64,
    },
    Cancel {
        epoch: u64,
        generation: u64,
    },
    Resume {
        speech: Speech,
        automatic: bool,
        epoch: u64,
        generation: u64,
    },
    Claim {
        id: String,
        delivery: String,
        epoch: u64,
    },
    Receipt {
        id: String,
        delivery: String,
        outcome: &'static str,
    },
}
enum Event {
    Ack {
        text: &'static str,
        epoch: u64,
        generation: u64,
    },
    Ready {
        id: String,
        text: String,
        epoch: u64,
    },
    Claimed {
        speech: Speech,
        epoch: u64,
    },
    Finished {
        epoch: u64,
    },
    Revoked {
        epoch: u64,
    },
}
#[derive(Clone)]
pub struct Speech {
    pub text: String,
    task: Option<String>,
    delivery: String,
    expires: Instant,
    result_until: Option<Instant>,
    auto_replayed: bool,
}

pub struct SearchSession {
    api: Api,
    tx: mpsc::Sender<Command>,
    rx: mpsc::Receiver<Event>,
    task: JoinHandle<()>,
    epoch: u64,
    generation: u64,
    busy: bool,
    gate: DeliveryGate,
    speech: VecDeque<Speech>,
    started: Instant,
    active: Option<Speech>,
    remainder: Option<Speech>,
    idle_since: Option<Instant>,
    verified: HashMap<String, Instant>,
    revoked: bool,
    auto_pending: bool,
    suppress_auto: bool,
    query_intent: crate::search_policy::QueryIntent,
}
pub fn enabled(enabled: &str, allowlist: &str, room: &str) -> bool {
    let Some(rest) = room.strip_prefix("sn-") else {
        return false;
    };
    let Some((sn, suffix)) = rest.split_once('-') else {
        return false;
    };
    enabled == "1"
        && sn.starts_with("BJP003")
        && sn.len() == 20
        && sn[6..].bytes().all(|b| b.is_ascii_digit())
        && !suffix.is_empty()
        && suffix.bytes().all(|b| b.is_ascii_digit())
        && allowlist.split(',').any(|s| s.trim() == sn)
}
impl SearchSession {
    pub fn from_config(cfg: &LlmConfig) -> Option<Self> {
        if !enabled(
            &std::env::var("P003_SEARCH_ENABLED").unwrap_or_default(),
            &std::env::var("P003_SEARCH_DEVICE_ALLOWLIST").unwrap_or_default(),
            &cfg.room,
        ) {
            return None;
        }
        let api = Api::new(cfg)?;
        let (tx, commands) = mpsc::channel(16);
        let (events, rx) = mpsc::channel(16);
        let task = tokio::spawn(run(api.clone(), commands, events));
        Some(Self {
            api,
            tx,
            rx,
            task,
            epoch: 0,
            generation: 0,
            busy: false,
            gate: DeliveryGate::default(),
            speech: VecDeque::new(),
            started: Instant::now(),
            active: None,
            remainder: None,
            idle_since: None,
            verified: HashMap::new(),
            revoked: false,
            auto_pending: false,
            suppress_auto: false,
            query_intent: crate::search_policy::QueryIntent::default(),
        })
    }
    pub fn interpret(&mut self, text: &str) -> Option<Intent> {
        self.query_intent.route(text, self.started.elapsed().as_millis() as u64)
    }
    pub fn on_commit(&mut self) {
        self.generation += 1;
        self.speech.retain(|s| s.task.is_some());
    }
    pub fn command(&mut self, action: Intent) {
        match action {
            Intent::Clarify => self.notice("你想查什么？请说出具体主题，我再帮你查询。"),
            Intent::Search(query) => {
                // One active query per session in v1.
                if self.busy {
                    self.notice("我还在查刚才的问题；要换一个，可以说“改查”。");
                    return;
                }
                self.submit(query, false);
            }
            Intent::Replace(query) => self.replace_query(query),
            Intent::Cancel => {
                self.suppress_auto_replay();
                self.epoch += 1;
                self.gate.cancel();
                self.speech.clear();
                self.remainder = None;
                if self
                    .tx
                    .try_send(Command::Cancel {
                        epoch: self.epoch,
                        generation: self.generation,
                    })
                    .is_err()
                {
                    self.notice("暂时没能确认取消，请稍后再试。");
                }
            }
            Intent::Resume => {
                self.auto_pending = false;
                if self.busy {
                    self.notice("还在查或准备播报，查到后我会告诉你。");
                    return;
                }
                if let Some(speech) = &self.remainder {
                    if speech
                        .result_until
                        .is_some_and(|until| Instant::now() < until)
                        && !speech.text.is_empty()
                    {
                        self.epoch += 1;
                        if self
                            .tx
                            .try_send(Command::Resume {
                                speech: speech.clone(),
                                automatic: false,
                                epoch: self.epoch,
                                generation: self.generation,
                            })
                            .is_ok()
                        {
                            self.busy = true;
                        } else {
                            self.notice("暂时没能确认这条结果是否仍有效。");
                        }
                        return;
                    }
                }
                self.notice("暂时没有可继续的搜索结果，可以重新查一下。");
            }
        }
    }
    pub fn replace_query(&mut self, query: String) {
        self.suppress_auto_replay();
        self.epoch += 1;
        self.gate.cancel();
        self.speech.clear();
        self.remainder = None;
        self.submit(query, true);
    }
    fn submit(&mut self, query: String, replace: bool) {
        self.epoch += 1;
        let cmd = Command::Submit {
            query,
            turn: uuid::Uuid::new_v4().to_string(),
            replace,
            epoch: self.epoch,
            generation: self.generation,
        };
        if self.tx.try_send(cmd).is_ok() {
            self.busy = true;
        } else {
            self.notice("这次搜索没能接单，你可以继续和我聊。");
        }
    }
    fn notice(&mut self, text: &str) {
        if self.speech.len() < 3 {
            self.speech.push_back(Speech {
                text: text.into(),
                task: None,
                delivery: String::new(),
                expires: Instant::now() + Duration::from_secs(10),
                result_until: None,
                auto_replayed: false,
            });
        }
    }
    /// Called on the existing audio tick; drains messages only, never awaits a lock or HTTP.
    pub fn poll(&mut self, safe: bool) -> Option<String> {
        while let Ok(event) = self.rx.try_recv() {
            match event {
                Event::Ack {
                    text,
                    epoch,
                    generation,
                } if epoch == self.epoch && generation == self.generation => self.notice(text),
                Event::Ready { id, text, epoch } if epoch == self.epoch => {
                    self.verified.insert(id.clone(), Instant::now());
                    self.gate
                        .offer(id, text, self.started.elapsed().as_millis() as u64);
                }
                Event::Claimed { speech, epoch } if epoch == self.epoch => {
                    if let Some(id) = &speech.task {
                        self.verified.insert(id.clone(), Instant::now());
                    }
                    self.speech.push_back(speech);
                }
                Event::Finished { epoch } if epoch == self.epoch => self.busy = false,
                Event::Revoked { epoch } if epoch == self.epoch => {
                    self.busy = false;
                    self.gate.cancel();
                    self.speech.retain(|s| s.result_until.is_none());
                    self.remainder = None;
                    // An empty ledger after submit timeout invalidates results,
                    // not the explanation that no acknowledgement was received.
                    // Otherwise the next poll cuts that notice before its first audio.
                    let active_result = self.active.as_ref().is_some_and(|s| s.task.is_some());
                    if active_result { self.active = None; self.revoked = true; }
                    tracing::info!(active_result, "background search results revoked; diagnostic notices preserved");
                    self.auto_pending = false;
                }
                Event::Claimed { speech, .. } => {
                    if let Some(id) = speech.task {
                        let _ = self.tx.try_send(Command::Receipt { id, delivery: speech.delivery, outcome: "dropped" });
                    }
                }
                _ => {}
            }
        }
        let now = Instant::now();
        if safe {
            self.idle_since.get_or_insert(now);
        } else {
            self.idle_since = None;
        }
        let mut kept = VecDeque::new();
        while let Some(speech) = self.speech.pop_front() {
            if now < speech.expires {
                kept.push_back(speech);
            } else if let Some(id) = speech.task {
                self.busy = false;
                let _ = self.tx.try_send(Command::Receipt {
                    id,
                    delivery: speech.delivery,
                    outcome: "dropped",
                });
            }
        }
        self.speech = kept;
        if let Some((id, _)) = self
            .gate
            .take_ready(self.started.elapsed().as_millis() as u64, safe)
        {
            let delivery = uuid::Uuid::new_v4().to_string();
            let _ = self.tx.try_send(Command::Claim {
                id,
                delivery,
                epoch: self.epoch,
            });
        }
        if !safe || self.active.is_some() {
            return None;
        }
        // Acknowledgements also wait for a full quiet interval.
        if self.idle_since.map(|t| t.elapsed()).unwrap_or_default() < Duration::from_millis(800) {
            return None;
        }
        if self.auto_pending && !self.busy {
            self.auto_pending = false;
            if let Some(mut speech) = self.remainder.clone().filter(|s| now < s.expires && !s.auto_replayed) {
                speech.auto_replayed = true;
                self.epoch += 1;
                if self.tx.try_send(Command::Resume { speech, automatic: true, epoch: self.epoch, generation: self.generation }).is_ok() {
                    self.busy = true;
                }
            }
        }
        if let Some(id) = self.speech.front().and_then(|s| s.task.as_ref()) {
            if self
                .verified
                .get(id)
                .map(|at| at.elapsed() > Duration::from_millis(1500))
                .unwrap_or(true)
            {
                return None;
            }
        }
        let speech = self.speech.pop_front()?;
        let text = speech.text.clone();
        tracing::info!(task_id = speech.task.as_deref().unwrap_or("ack"), delivery_id = %speech.delivery, session_ms = self.started.elapsed().as_millis() as u64, "background search speech scheduled (not audio proof)");
        self.suppress_auto = false;
        self.active = Some(speech);
        Some(text)
    }
    pub fn take_revoked(&mut self) -> bool {
        std::mem::take(&mut self.revoked)
    }
    /// Called only once by the playout first-frame observation, never per audio frame.
    pub fn log_audio_started(&self, room: &str, turn_id: u64) {
        if let Some(speech) = &self.active {
            tracing::info!(room, turn_id, task_id = speech.task.as_deref().unwrap_or("ack"),
                delivery_id = %speech.delivery, session_ms = self.started.elapsed().as_millis() as u64,
                "background search first audio published (device hearing unverified)");
        }
    }
    pub fn suppress_auto_replay(&mut self) {
        self.suppress_auto = true;
        self.query_intent.clear();
        self.auto_pending = false;
        // Invalidate an automatic revalidation already in flight without blocking ordinary speech.
        if self.busy && self.remainder.is_some() { self.epoch += 1; self.busy = false; }
        self.speech.retain(|s| !s.auto_replayed);
    }
    pub fn finish(&mut self, interrupted: bool, spoken_chars: usize) {
        self.finish_with_progress(interrupted, spoken_chars, u64::MAX, true);
    }
    pub fn finish_with_progress(&mut self, interrupted: bool, spoken_chars: usize, played_ms: u64, segment_complete: bool) {
        if let Some(speech) = self.active.take() {
            tracing::info!(task_id = speech.task.as_deref().unwrap_or("ack"), delivery_id = %speech.delivery, session_ms = self.started.elapsed().as_millis() as u64, interrupted, spoken_chars, "background search speech finished (device hearing unverified)");
            if speech.result_until.is_some() {
                self.auto_pending = interrupted && played_ms < 1000 && !segment_complete
                    && !speech.auto_replayed && !self.suppress_auto && Instant::now() < speech.expires;
                tracing::info!(task_id = speech.task.as_deref().unwrap_or("ack"), played_ms, segment_complete,
                    automatic_requeue = self.auto_pending, "background search interruption decision");
                let mut remainder = speech.clone();
                if interrupted {
                    remainder.text = speech.text.chars().skip(spoken_chars).collect();
                }
                self.remainder = Some(remainder);
                self.busy = false;
            }
            if let Some(id) = speech.task {
                let _ = self.tx.try_send(Command::Receipt {
                    id,
                    delivery: speech.delivery,
                    outcome: if interrupted {
                        "interrupted"
                    } else if spoken_chars == 0 {
                        "dropped"
                    } else {
                        "completed"
                    },
                });
            }
        }
    }
}
impl Drop for SearchSession {
    fn drop(&mut self) {
        self.task.abort();
        let api = self.api.clone();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let _ = api.request("/session/cancel", Some(json!({}))).await;
            });
        }
    }
}

fn result_text(task: &Value) -> Option<String> {
    if task["status"] == "failed" {
        return Some("刚才的搜索暂时没有完成，这次我还不能确认。".into());
    }
    let text = task["result"]["text"].as_str()?;
    if text.is_empty()
        || text.chars().count() > 150
        || text.contains("[[")
        || text.contains("]]")
        || text.contains("http")
    {
        return None;
    }
    Some(text.into())
}
fn claimed_speech(task: &Value, id: String, delivery: String) -> Option<Speech> {
    let valid = task["valid_for_ms"].as_u64()?.min(300_000);
    let automatic = task["automatic_for_ms"].as_u64()?.min(60_000).min(valid);
    if automatic == 0 {
        return None;
    }
    let now = Instant::now();
    Some(Speech {
        text: result_text(task)?,
        task: Some(id),
        delivery,
        expires: now + Duration::from_millis(automatic),
        result_until: Some(now + Duration::from_millis(valid)),
        auto_replayed: false,
    })
}
async fn run(api: Api, mut commands: mpsc::Receiver<Command>, events: mpsc::Sender<Event>) {
    let mut current: Option<String> = None;
    let mut epoch = 0;
    let mut polling = false;
    let mut replaying = false;
    let mut poll_until = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break; };
                match command {
                    Command::Submit { query, turn, replace, epoch: e, generation } => {
                        epoch = e; replaying = false;
                        if !replace { current = None; }
                        let mut body = json!({"protocol":1,"phase":"committed","query":query,"turn":turn});
                        if replace { if let Some(id) = &current { body["replace"] = json!(id); } }
                        let mut attempt = 0;
                        let response = loop {
                            let budget_ms = if attempt == 0 { 1500 } else { 3000 };
                            attempt += 1;
                            let started = Instant::now();
                            let response = tokio::time::timeout(Duration::from_millis(budget_ms), api.request("", Some(body.clone()))).await;
                            let class = match &response {
                                Err(_) => "search_deadline".to_string(),
                                Ok(Err(e)) => e.to_string(),
                                Ok(Ok(v)) if v["task"]["id"].as_str().is_some() => "accepted".to_string(),
                                _ => "search_invalid_ack".to_string(),
                            };
                            // Whitelist classes only: no URL/query/body/provider error strings.
                            let safe_class = if class.starts_with("search_http_") || ["accepted","search_deadline","search_timeout","search_connect","search_transport","search_body","search_body_limit","search_invalid_ack"].contains(&class.as_str()) {class.as_str()} else {"search_invalid_response"};
                            tracing::info!(turn_id=%turn, attempt, elapsed_ms=started.elapsed().as_millis() as u64, outcome=safe_class, "background search submit attempt");
                            let retry = matches!(safe_class,"search_deadline"|"search_timeout"|"search_connect"|"search_transport"|"search_body");
                            if !retry || attempt >= 2 {break response;}
                        };
                        let rejected = matches!(&response, Ok(Err(e)) if e.to_string().starts_with("search_http_"));
                        let text = match response {
                            Ok(Ok(v)) if v["task"]["id"].as_str().is_some() => { current = v["task"]["id"].as_str().map(str::to_owned); "好，我查一下，你可以继续和我聊。" },
                            _ if rejected => "这次搜索没有接单，你可以继续和我聊。",
                            _ => "暂时没能确认搜索是否接单，你可以继续和我聊。",
                        };
                        // A rejected replacement must not revive the superseded query.
                        polling = !rejected; poll_until = Instant::now() + Duration::from_secs(80);
                        let _ = events.send(Event::Ack { text, epoch, generation }).await;
                        if !polling { let _ = events.send(Event::Finished { epoch }).await; }
                    }
                    Command::Cancel { epoch: e, generation } => {
                        epoch = e; replaying = false;
                        let status = api.request("", None).await;
                        let mut ids: Vec<String> = status.as_ref().ok().and_then(|v| v["tasks"].as_array()).into_iter().flatten().filter_map(|t|t["id"].as_str().map(str::to_owned)).collect();
                        if let Some(id) = &current { if !ids.contains(id) { ids.push(id.clone()); } }
                        let text = if ids.len() > 1 { "现在有多个查询，请说明要取消哪一个。" }
                            else if let Some(id) = ids.first() {
                                if api.request(&format!("/{id}/cancel"),Some(json!({}))).await.is_ok() { current = None; polling = false; "好，已取消这次搜索。" }
                                else { "暂时没能确认取消，请稍后再试。" }
                            } else if status.is_ok() { polling = false; "当前没有进行中的搜索。" } else { "暂时没能确认取消，请稍后再试。" };
                        let _ = events.send(Event::Ack { text, epoch, generation }).await;
                        if !polling { let _ = events.send(Event::Finished { epoch }).await; }
                    }
                    Command::Claim { id, delivery, epoch: e } => {
                        if e != epoch { continue; }
                        if let Ok(v) = api.request(&format!("/{id}/claim"),Some(json!({"delivery":delivery}))).await {
                            if let Some(speech) = claimed_speech(&v["task"], id, delivery) { let _ = events.send(Event::Claimed { epoch, speech }).await; }
                        }
                    }
                    Command::Resume { mut speech, epoch: e, generation, automatic } => {
                        epoch = e;
                        let Some(id) = speech.task.clone() else { continue; };
                        let delivery = uuid::Uuid::new_v4().to_string();
                        let body = json!({"previous": speech.delivery, "delivery": delivery, "automatic": automatic});
                        let response = api.request(&format!("/{id}/replay"), Some(body)).await;
                        if let Ok(v) = response {
                            let valid = v["task"]["valid_for_ms"].as_u64().unwrap_or(0).min(300_000);
                            if valid > 0 && v["task"]["delivery"] == "claimed" && speech.result_until.is_some_and(|until| Instant::now() < until) {
                                if automatic && Instant::now() >= speech.expires {
                                    let _ = api.request(&format!("/{id}/receipt"), Some(json!({"delivery":delivery,"outcome":"dropped"}))).await;
                                    current = None; polling = false;
                                    let _ = events.send(Event::Finished { epoch }).await;
                                    continue;
                                }
                                speech.auto_replayed = true;
                                speech.delivery = delivery;
                                let original_automatic = speech.expires;
                                speech.expires = speech.result_until.unwrap().min(Instant::now() + Duration::from_millis(valid));
                                speech.result_until = Some(speech.expires);
                                if automatic { speech.expires = speech.expires.min(original_automatic); }
                                current = Some(id); replaying = true; polling = true; poll_until = speech.expires;
                                let _ = events.send(Event::Claimed { speech, epoch }).await;
                                continue;
                            }
                        }
                        let _ = events.send(Event::Revoked { epoch }).await;
                        let _ = events.send(Event::Ack { text: "刚才的结果已不可用，可以重新查一下。", epoch, generation }).await;
                    }
                    Command::Receipt { id, delivery, outcome } => {
                        let _ = api.request(&format!("/{id}/receipt"),Some(json!({"delivery":delivery,"outcome":outcome}))).await;
                        // Keep the known delivered task for a subsequent explicit cancel/replace.
                        // A fresh Submit clears it; stopping polling must not forget task ownership.
                        if current.as_deref() == Some(id.as_str()) { polling=false; }
                    }
                }
            }
            _ = tick.tick(), if polling => {
                if Instant::now() >= poll_until { polling = false; let _ = events.send(Event::Finished { epoch }).await; continue; }
                let suffix = if replaying { current.as_ref().map(|id| format!("/{id}/playback")).unwrap_or_default() } else { String::new() };
                let response = api.request(&suffix, None).await;
                if let Ok(mut v) = response {
                    if replaying { v = json!({ "tasks": [v["task"].clone()] }); }
                    if let Some(tasks) = v["tasks"].as_array() {
                        if tasks.is_empty() { polling = false; let _ = events.send(Event::Revoked { epoch }).await; }
                        for task in tasks {
                            if let (Some(id),Some(text)) = (task["id"].as_str(),result_text(task)) {
                                // A lost POST acknowledgement can be recovered by the owned ledger.
                                if current.is_none() { current = Some(id.to_owned()); }
                                let _ = events.send(Event::Ready { id: id.into(),text,epoch }).await;
                            }
                        }
                    }
                } else if response.as_ref().err().map(|e| {
                    let code=e.to_string(); ["search_http_503", "search_http_401", "search_http_403", "search_http_404", "search_http_409"].contains(&code.as_str())
                }).unwrap_or(false) { polling=false; let _=events.send(Event::Revoked { epoch }).await; }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_v1_contract_deserializes_into_playable_result() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../4-Assets/contracts/p003-search-task-v1.json"
        ))
        .unwrap();
        let task = &fixture["ready"];
        let speech = claimed_speech(
            task,
            task["id"].as_str().unwrap().into(),
            "fixture-delivery".into(),
        )
        .unwrap();
        assert_eq!(speech.text, task["result"]["text"].as_str().unwrap());
        assert!(speech.expires <= speech.result_until.unwrap());
    }
    #[test]
    fn gates_are_closed_for_empty_list_and_other_devices() {
        let room = "sn-BJP00326070803800006-123";
        assert!(!enabled("1", "", room));
        assert!(!enabled("0", "BJP00326070803800006", room));
        assert!(enabled("1", "BJP00326070803800006", room));
        assert!(!enabled(
            "1",
            "BJP00326070803800006",
            "sn-BJP00326070803800007-123"
        ));
    }
    #[test]
    fn tool_or_url_text_never_becomes_a_voice_result() {
        for text in ["[[DEV:6]]", "https://example.com", ""] {
            assert!(result_text(&json!({"result":{"text":text}})).is_none());
        }
        assert_eq!(
            result_text(&json!({"result":{"text":"刚才查到了。"}})).unwrap(),
            "刚才查到了。"
        );
    }
    fn test_session() -> (SearchSession, mpsc::Sender<Event>, mpsc::Receiver<Command>) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let api = Api {
            client: reqwest::Client::new(),
            url: reqwest::Url::parse("http://127.0.0.1:9/tasks").unwrap(),
            token: "synthetic".into(),
            key: "synthetic".into(),
        };
        let (tx, commands) = mpsc::channel(16);
        let (events, rx) = mpsc::channel(16);
        let task = tokio::spawn(std::future::pending());
        (
            SearchSession {
                api,
                tx,
                rx,
                task,
                epoch: 0,
                generation: 0,
                busy: false,
                gate: DeliveryGate::default(),
                speech: VecDeque::new(),
                started: Instant::now(),
                active: None,
                remainder: None,
                idle_since: None,
                verified: HashMap::new(),
                revoked: false,
            auto_pending: false,
            suppress_auto: false,
            query_intent: crate::search_policy::QueryIntent::default(),
            },
            events,
            commands,
        )
    }
    #[tokio::test]
    async fn early_interruption_returns_once_after_idle_but_stop_and_expiry_suppress_it() {
        for played_ms in [0, 600] {
            let (mut s, _events, mut commands) = test_session();
            let speech=claimed_speech(&json!({"status":"ready","valid_for_ms":300000,"automatic_for_ms":60000,"result":{"text":"查询结果。"}}),"task-1".into(),"d1".into()).unwrap();
            s.active=Some(speech);
            s.finish_with_progress(true, 0, played_ms, false);
            assert!(matches!(commands.try_recv(),Ok(Command::Receipt{outcome:"interrupted",..})));
            s.on_commit();
            assert!(s.poll(false).is_none()); assert!(commands.try_recv().is_err());
            s.idle_since=Some(Instant::now()-Duration::from_millis(801));
            assert!(s.poll(true).is_none());
            let Command::Resume{speech,automatic:true,..}=commands.try_recv().unwrap() else {panic!("early result must revalidate and replay")};
            s.active=Some(speech); s.finish_with_progress(true,0,100,false);
            commands.try_recv().unwrap();
            s.idle_since=Some(Instant::now()-Duration::from_millis(801)); s.poll(true);
            assert!(commands.try_recv().is_err(),"no second automatic replay");
        }
        for cause in ["stop","long","segment","expired"] {
            let (mut s,_events,mut commands)=test_session();
            let mut speech=claimed_speech(&json!({"valid_for_ms":300000,"automatic_for_ms":60000,"result":{"text":"查询结果。"}}),"t".into(),"d".into()).unwrap();
            if cause=="expired" {speech.expires=Instant::now();}
            s.active=Some(speech);
            if cause=="stop" {s.suppress_auto_replay();}
            s.finish_with_progress(true,0,if cause=="long" {1000}else{600},cause=="segment");
            commands.try_recv().unwrap();
            s.idle_since=Some(Instant::now()-Duration::from_millis(801));s.poll(true);
            assert!(commands.try_recv().is_err(),"{cause} must not automatically replay");
        }
    }
    #[tokio::test]
    async fn repeated_interruption_retains_progress_without_extending_expiry() {
        let (mut s, _events, mut commands) = test_session();
        let original=claimed_speech(&json!({"status":"ready","valid_for_ms":20000,"automatic_for_ms":10000,"result":{"text":"甲乙丙丁戊"}}),"task-1".into(),"d1".into()).unwrap();
        let expiry = original.result_until.unwrap();
        s.active = Some(original);
        s.finish(true, 2);
        assert_eq!(s.remainder.as_ref().unwrap().text, "丙丁戊");
        assert!(matches!(
            commands.try_recv(),
            Ok(Command::Receipt {
                outcome: "interrupted",
                ..
            })
        ));
        s.command(Intent::Resume);
        let Command::Resume { speech, .. } = commands.try_recv().unwrap() else {
            panic!("resume must revalidate with server")
        };
        s.active = Some(speech);
        s.finish(true, 1);
        assert_eq!(s.remainder.as_ref().unwrap().text, "丁戊");
        assert_eq!(s.remainder.as_ref().unwrap().result_until, Some(expiry));
        assert!(
            claimed_speech(
                &json!({"valid_for_ms":10000,"automatic_for_ms":0,"result":{"text":"过期"}}),
                "old".into(),
                "d".into()
            )
            .is_none()
        );
    }
    #[tokio::test]
    async fn ordinary_turns_keep_results_but_revocation_and_cancel_destroy_replay() {
        let (mut s, events, _commands) = test_session();
        let speech=claimed_speech(&json!({"status":"ready","valid_for_ms":300000,"automatic_for_ms":60000,"result":{"text":"科技馆开放安排。"}}),"task-1".into(),"d1".into()).unwrap();
        events
            .send(Event::Claimed {
                speech: speech.clone(),
                epoch: 0,
            })
            .await
            .unwrap();
        assert!(s.poll(false).is_none());
        for _ in 0..3 {
            s.on_commit();
            assert_eq!(s.speech.len(), 1);
            assert!(s.poll(false).is_none());
        }
        s.idle_since = Some(Instant::now() - Duration::from_millis(801));
        assert_eq!(s.poll(true).as_deref(), Some("科技馆开放安排。"));
        events.send(Event::Revoked { epoch: 0 }).await.unwrap();
        s.poll(false);
        assert!(s.take_revoked());
        s.finish(true, 0);
        assert!(s.active.is_none() && s.remainder.is_none());
        s.remainder = Some(speech);
        s.command(Intent::Cancel);
        assert!(s.remainder.is_none());
        events.send(Event::Claimed{speech:claimed_speech(&json!({"valid_for_ms":300000,"automatic_for_ms":60000,"result":{"text":"旧结果"}}),"old".into(),"old".into()).unwrap(),epoch:0}).await.unwrap();
        s.poll(true);
        assert!(s.speech.is_empty(), "cancel epoch rejects delayed claim");
    }
    #[tokio::test]
    async fn real_http_submit_poll_claim_receipt_does_not_block_foreground() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let release = Arc::new(tokio::sync::Notify::new());
        let blocked = release.clone();
        let paths = Arc::new(Mutex::new(Vec::new()));
        let observed = paths.clone();
        let server = tokio::spawn(async move {
            let mut receipted = false;
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&bytes[..end]);
                        let len = head
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|v| v.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                let raw = String::from_utf8(bytes).unwrap();
                let first = raw.lines().next().unwrap().to_string();
                assert!(
                    raw.to_lowercase()
                        .contains("x-p003-worker-token: synthetic-worker")
                );
                assert!(!first.contains("synthetic-worker"));
                observed.lock().unwrap().push(first.clone());
                if first.contains("/receipt?") { receipted = true; }
                let body = if first.contains("/claim?") {
                    json!({"task":{"id":"task-1","status":"ready","valid_for_ms":300000,"automatic_for_ms":60000,"result":{"text":"刚才查到了。"}}})
                } else if first.contains("/replay?") {
                    let request: Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
                    assert_eq!(request["previous"], "d1"); assert_ne!(request["delivery"], "d1");
                    assert_eq!(request["automatic"], true);
                    json!({"task":{"id":"task-1","status":"delivered","delivery":"claimed","valid_for_ms":299000,"automatic_for_ms":59000,"result":{"text":"刚才查到了。"}}})
                } else if first.contains("/playback?") {
                    json!({"task":{"id":"task-1","status":"delivered","delivery":"claimed","valid_for_ms":299000,"automatic_for_ms":59000,"result":{"text":"刚才查到了。"}}})
                } else if first.contains("/receipt?") || first.contains("/cancel?") {
                    json!({"ok":true})
                } else if first.starts_with("POST") {
                    let request: Value =
                        serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
                    assert_eq!(request["phase"], "committed");
                    assert_eq!(request["protocol"], 1);
                    blocked.notified().await;
                    json!({"task":{"id":"task-1","status":"running"}})
                } else if receipted {
                    json!({"tasks":[]})
                } else {
                    json!({"tasks":[{"id":"task-1","status":"ready","valid_for_ms":300000,"automatic_for_ms":60000,"result":{"text":"刚才查到了。"}}]})
                };
                let text = body.to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",text.len(),text).as_bytes()).await.unwrap();
            }
        });
        let api = Api {
            client: reqwest::Client::new(),
            url: reqwest::Url::parse(&format!("http://{addr}/tasks?room=synthetic-room")).unwrap(),
            token: "synthetic-worker".into(),
            key: "synthetic-key".into(),
        };
        let (tx, commands) = mpsc::channel(16);
        let (events, mut rx) = mpsc::channel(16);
        let actor = tokio::spawn(run(api, commands, events));
        tx.send(Command::Submit {
            query: "科技馆开放时间".into(),
            turn: "t1".into(),
            replace: false,
            epoch: 0,
            generation: 1,
        })
        .await
        .unwrap();
        for _ in 0..3 {
            tokio::time::sleep(Duration::from_millis(15)).await;
            assert!(
                rx.try_recv().is_err(),
                "foreground progressed before delayed HTTP acknowledgement"
            );
        }
        release.notify_one();
        let mut ready = false;
        for _ in 0..3 {
            if matches!(
                tokio::time::timeout(Duration::from_secs(3), rx.recv())
                    .await
                    .unwrap(),
                Some(Event::Ready { .. })
            ) {
                ready = true;
                break;
            }
        }
        assert!(ready);
        tx.send(Command::Claim {
            id: "task-1".into(),
            delivery: "d1".into(),
            epoch: 0,
        })
        .await
        .unwrap();
        let mut claimed = false;
        for _ in 0..3 {
            if let Some(Event::Claimed { speech, .. }) =
                tokio::time::timeout(Duration::from_secs(3), rx.recv())
                    .await
                    .unwrap()
            {
                assert_eq!(speech.text, "刚才查到了。");
                claimed = true;
                break;
            }
        }
        assert!(claimed);
        tx.send(Command::Receipt {
            id: "task-1".into(),
            delivery: "d1".into(),
            outcome: "interrupted",
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            paths
                .lock()
                .unwrap()
                .iter()
                .any(|p| p.contains("/receipt?"))
        );
        // The pending-task list omits delivered/interrupted results. Cancellation
        // must still use the actor's known task instead of claiming nothing exists.
        tx.send(Command::Cancel { epoch: 1, generation: 1 }).await.unwrap();
        let mut cancelled=false;
        for _ in 0..6 {
            if let Some(Event::Ack {text,epoch:1,..})=tokio::time::timeout(Duration::from_secs(3),rx.recv()).await.unwrap() {
                assert_eq!(text,"好，已取消这次搜索。");cancelled=true;break;
            }
        }
        assert!(cancelled);
        assert!(paths.lock().unwrap().iter().any(|path|path.contains("/task-1/cancel?")));
        let replay = claimed_speech(&json!({"valid_for_ms":300000,"automatic_for_ms":60000,"result":{"text":"刚才查到了。"}}),"task-1".into(),"d1".into()).unwrap();
        let deadline = replay.expires;
        tx.send(Command::Resume { speech: replay, automatic: true, epoch: 1, generation: 1 }).await.unwrap();
        let mut replayed=false;
        for _ in 0..6 {
            if let Some(Event::Claimed {speech,epoch:1}) = tokio::time::timeout(Duration::from_secs(3),rx.recv()).await.unwrap() {
                assert_ne!(speech.delivery,"d1"); assert!(speech.expires <= deadline); replayed=true;break;
            }
        }
        assert!(replayed, "automatic replay must obtain a new server claim");
        let mut expired = claimed_speech(&json!({"valid_for_ms":300000,"automatic_for_ms":60000,"result":{"text":"刚才查到了。"}}),"task-1".into(),"d1".into()).unwrap();
        expired.expires = Instant::now();
        tx.send(Command::Resume {speech:expired,automatic:true,epoch:2,generation:1}).await.unwrap();
        let mut released=false;
        for _ in 0..6 {
            if matches!(tokio::time::timeout(Duration::from_secs(3),rx.recv()).await.unwrap(),Some(Event::Finished{epoch:2})) {released=true;break;}
        }
        assert!(released,"expiry during claim must release busy state instead of wedging future searches");
        actor.abort();
        server.abort();
    }
    #[tokio::test]
    async fn slow_ack_retry_keeps_same_turn_and_does_not_starve_foreground() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use std::sync::{Arc,Mutex};
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr=listener.local_addr().unwrap();
        let bodies=Arc::new(Mutex::new(Vec::<Value>::new()));let seen=bodies.clone();
        let server=tokio::spawn(async move {
            loop {
                let (mut socket,_)=listener.accept().await.unwrap();let seen=seen.clone();
                tokio::spawn(async move {
                    let mut bytes=Vec::new();let mut buf=[0;4096];
                    loop {
                        let n=socket.read(&mut buf).await.unwrap();if n==0{return;}bytes.extend_from_slice(&buf[..n]);
                        if let Some(end)=bytes.windows(4).position(|w|w==b"\r\n\r\n") {
                            let head=String::from_utf8_lossy(&bytes[..end]);
                            let len=head.lines().find_map(|l|l.to_lowercase().strip_prefix("content-length: ").and_then(|v|v.parse::<usize>().ok())).unwrap_or(0);
                            if bytes.len()<end+4+len {continue;}
                            let post=head.starts_with("POST");
                            if post {seen.lock().unwrap().push(serde_json::from_slice(&bytes[end+4..end+4+len]).unwrap());}
                            if post {tokio::time::sleep(Duration::from_millis(1900)).await;}
                            let body=if post {json!({"task":{"id":"slow-task"}})} else {json!({"tasks":[]})}.to_string();
                            let wire=format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                            let _=socket.write_all(wire.as_bytes()).await;return;
                        }
                    }
                });
            }
        });
        let api=Api{client:reqwest::Client::new(),url:format!("http://{addr}/v1/internal/search-tasks?room=synthetic").parse().unwrap(),token:"synthetic".into(),key:"synthetic".into()};
        let (tx,commands)=mpsc::channel(4);let(events,mut rx)=mpsc::channel(8);let actor=tokio::spawn(run(api,commands,events));
        tx.send(Command::Submit{query:"火星为什么是红色".into(),turn:"same-turn".into(),replace:false,epoch:1,generation:1}).await.unwrap();
        let started=Instant::now();let mut ticks=0;
        while started.elapsed()<Duration::from_millis(500) {tokio::time::sleep(Duration::from_millis(20)).await;ticks+=1;}
        assert!(ticks>=20,"foreground scheduling must remain available during HTTPS delay");
        let event=tokio::time::timeout(Duration::from_secs(5),rx.recv()).await.unwrap().unwrap();
        let Event::Ack{text,..}=event else {panic!("expected acknowledgement")};
        assert_eq!(text,"好，我查一下，你可以继续和我聊。");
        let requests=bodies.lock().unwrap();assert_eq!(requests.len(),2);assert_eq!(requests[0],requests[1]);assert_eq!(requests[0]["turn"],"same-turn");
        actor.abort();server.abort();
    }

    #[tokio::test]
    async fn empty_ledger_must_not_abort_the_unconfirmed_submit_notice() {
        let (mut s, events, _commands) = test_session();
        s.notice("暂时没能确认搜索是否接单，你可以继续和我聊。");
        s.idle_since = Some(Instant::now() - Duration::from_millis(801));
        assert!(s.poll(true).unwrap().contains("暂时没能确认"));
        events.send(Event::Revoked { epoch: 0 }).await.unwrap();
        s.poll(false);
        assert!(!s.take_revoked(), "empty poll may revoke results, never the failure explanation");
        assert!(s.active.as_ref().is_some_and(|a| a.task.is_none()));
        s.finish(false, 28);
        assert!(s.active.is_none() && s.remainder.is_none());
    }
    #[tokio::test]
    async fn rejected_replacement_must_not_resume_the_previous_query() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        use tokio::io::{AsyncReadExt,AsyncWriteExt};
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {
            let mut posts=0;
            loop {
                let(mut socket,_)=listener.accept().await.unwrap();let mut bytes=Vec::new();let mut buf=[0;4096];
                loop {
                    let n=socket.read(&mut buf).await.unwrap();if n==0{break;}bytes.extend_from_slice(&buf[..n]);
                    if let Some(end)=bytes.windows(4).position(|w|w==b"\r\n\r\n") {
                        let head=String::from_utf8_lossy(&bytes[..end]);let len=head.lines().find_map(|l|l.to_lowercase().strip_prefix("content-length: ").and_then(|v|v.parse::<usize>().ok())).unwrap_or(0);if bytes.len()<end+4+len{continue;}
                        let post=head.starts_with("POST");if post{posts+=1;}
                        let rejected=post && posts>1;
                        let body=if rejected{json!({"error":"disabled"})}else if post{json!({"task":{"id":"old-task"}})}else{json!({"tasks":[{"id":"old-task","status":"ready","result":{"text":"旧搜索结果。"}}]})}.to_string();
                        let status=if rejected{"403 Forbidden"}else{"200 OK"};let wire=format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);socket.write_all(wire.as_bytes()).await.unwrap();break;
                    }
                }
            }
        });
        let api=Api{client:reqwest::Client::new(),url:format!("http://{addr}/tasks").parse().unwrap(),token:"synthetic".into(),key:"synthetic".into()};
        let(tx,commands)=mpsc::channel(4);let(events,mut rx)=mpsc::channel(8);let actor=tokio::spawn(run(api,commands,events));
        tx.send(Command::Submit{query:"火星".into(),turn:"first".into(),replace:false,epoch:0,generation:1}).await.unwrap();
        while !matches!(rx.recv().await,Some(Event::Ack{epoch:0,..})){}
        tx.send(Command::Submit{query:"恐龙".into(),turn:"second".into(),replace:true,epoch:1,generation:2}).await.unwrap();
        while !matches!(rx.recv().await,Some(Event::Ack{epoch:1,..})){}
        let next=tokio::time::timeout(Duration::from_secs(2),rx.recv()).await.unwrap().unwrap();
        assert!(matches!(next,Event::Finished{epoch:1}),"rejected replacement must release busy and not replay old result");
        actor.abort();server.abort();
    }

}
