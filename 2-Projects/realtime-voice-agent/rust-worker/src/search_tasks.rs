//! Session-owned background search. Networking is never awaited by the audio loop.
use crate::llm::LlmConfig;
use crate::search_receipts::{Bank as ReceiptBank, Clip as ReceiptClip, Kind as ReceiptKind};
use crate::search_policy::{DeliveryGate, Intent};
use crate::search_routing::{RoutingConfig,RoutingSession,Decision};
use serde::Deserialize;
#[derive(Clone,Deserialize)]
#[serde(deny_unknown_fields)]
struct RoutingSnapshot {version:String,config:RoutingConfig}

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
            || !["/v1/internal/search-tasks", "/_canary/search-20261021/v1/internal/search-tasks",
                "/_canary/search-verification-20261026/v1/internal/search-tasks"].contains(&url.path())
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
                .http1_only()
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
    ResumeLatest { epoch:u64, generation:u64, request:String },
    Progress { speech:Speech, final_outcome:Option<&'static str> },
    Close { resume:bool,done:tokio::sync::oneshot::Sender<()> },
    RoutingAck {version:String},
    Submit {
        routing: Option<Value>,
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
    Context {id:String,revision:u64,epoch:u64},
    Verified {id:String,epoch:u64},
    Accepted { epoch: u64, generation: u64 },
    Routing { snapshot:Option<RoutingSnapshot> },
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
    receipt: Option<ReceiptClip>,
    grant: Option<String>,
    revision: u64,
    digest: String,
    cursor: usize,
    sequence: u64,
    reported_cursor: usize,
    pub text: String,
    task: Option<String>,
    delivery: String,
    expires: Instant,
    result_until: Option<Instant>,
    auto_replayed: bool,
}

struct PendingTopic {
    query: String,
    replace: bool,
    since: Instant,
    route: Option<(String, Decision)>,
    tail_observed: bool,
}
const TOPIC_TAIL_MS: u64 = 1200;
const TOPIC_ACTIVE_TAIL_MS: u64 = 5000;
impl PendingTopic {
    fn deadline_ms(&self) -> u64 {
        if self.tail_observed { TOPIC_ACTIVE_TAIL_MS } else { TOPIC_TAIL_MS }
    }
}
fn bare_topic(q: &str) -> bool {
    (2..=24).contains(&q.chars().count()) &&
        !["什么","为什么","怎么","多少","哪里","哪年","何时","如何","吗","天气","气温","下雨"].iter().any(|p|q.contains(p))
}
fn question_tail(t: &str) -> bool {
    // Only an immediately adjacent predicate, never a new named topic or personal chat.
    t.chars().count()<=40 &&
        (["主要吃","吃什么","是什么","是怎么","是如何","为什么","怎么","有多","有几","多少","在哪里","什么时候","能不能","会不会","最近","最新","正式更新"].iter().any(|p|t.starts_with(p)) || t.contains("这首歌")&&t.contains("谁唱")) &&
        !["帮我","改查","不用","不要","我们","你","我","；",";"].iter().any(|p|t.contains(p))
}
fn missing_predicate(q: &str) -> bool {
    let q=q.trim().trim_end_matches(|c:char|"。！？!?，, ".contains(c));
    ["为什么","为什么会","怎么","怎么会","如何","最近","最新"].iter().any(|p|q.ends_with(p))
}
fn incomplete_title(q: &str) -> bool {
    // Short edition/title fragments observed before the predicate arrives.
    // This changes only explicit search admission, never ordinary chat timing.
    ["基岩版","Java版","中国版","国际版","网易版"].iter().any(|s|q.ends_with(s))&&q.starts_with("我的世界")
}
fn repaired_replace(text: &str, active: bool) -> Option<String> {
    if !active {return None;}
    let q=text.trim().strip_prefix("改茶")?;
    if q.chars().count()<2 || ["具","叶","杯","壶","的","味","色","馆","水"].iter().any(|s|q.starts_with(s)) {return None;}
    Some(format!("改查{q}"))
}
fn predicate_tail(t: &str) -> bool {
    // A narrow adjacent ASR continuation, not a buffer for arbitrary chat.
    (2..=24).contains(&t.chars().count()) &&
        ["灭绝","会","能","要","是","不","没有","变","发","形成","出现","产生","生长","消失","吃","飞","转","掉","亮","正式更新","更新","有什么"].iter().any(|p|t.starts_with(p)) &&
        !["帮我","查","搜","取消","不用","不要","停","退出","聊","我们","你","我","天气","；",";"].iter().any(|p|t.contains(p))
}
pub struct SearchSession {
    resume_v1: bool,
    context_v1: bool,
    ack_v1: bool,
    closing: bool,
    dialogue: Option<Value>,
    dialogue_changed: Instant,
    receipts: Option<ReceiptBank>,
    receipt_epoch: Option<u64>,
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
    query_intent: RoutingSession,
    routing: Option<RoutingSnapshot>,
    last_route: Option<(String,Decision)>,
    routing_task: Option<JoinHandle<()>>,
    clarified_at: Option<Instant>,
    pending_topic: Option<PendingTopic>,
    last_resume_at: Option<Instant>,
    fragment_since: Option<Instant>,
}
pub fn enabled(enabled: &str, allowlist: &str, room: &str) -> bool {
    crate::search_enrollment::enabled(enabled, "allowlist", allowlist, room, "")
}
impl SearchSession {
    pub fn from_config(cfg: &LlmConfig, provider: &str, voice: &str) -> Option<Self> {
        if !crate::search_enrollment::for_room(&cfg.room) {
            return None;
        }
        let api = Api::new(cfg)?;
        let (tx, commands) = mpsc::channel(16);
        let (events, rx) = mpsc::channel(16);
        let routing_task=Some(tokio::spawn(pull_routing(api.clone(),events.clone())));
        let task = tokio::spawn(run(api.clone(), commands, events));
        Some(Self {
            resume_v1: flag("P003_SEARCH_RESUME_V1"),context_v1:flag("P003_SEARCH_CONTEXT_V1"),ack_v1:flag("P003_SEARCH_ACK_V1"),
            closing:false,dialogue:None,dialogue_changed:Instant::now(),
            receipts: ReceiptBank::from_env(provider, voice), receipt_epoch: None,
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
            query_intent: RoutingSession::default(),
            routing:None,last_route:None,routing_task,
            clarified_at:None,pending_topic:None,last_resume_at:None,fragment_since:None,
        })
    }
    pub fn interpret(&mut self, text: &str) -> Option<Intent> {
        self.fragment_since=None;
        let repaired=repaired_replace(text,self.dialogue_context().is_some());
        let text=repaired.as_deref().unwrap_or(text);
        let mut joined = None;
        let mut deferred = None;
        if let Some(pending) = self.pending_topic.take() {
            let tail=text.trim().trim_end_matches(|c:char|"。！？!?，, ".contains(c));
            let continues=if missing_predicate(&pending.query){predicate_tail(tail)}else{question_tail(tail)};
            if pending.since.elapsed() <= Duration::from_millis(pending.deadline_ms()) && continues {
                self.fragment_since=Some(pending.since);
                joined=Some(format!("{}{}{}",if pending.replace{"改查"}else{"帮我查一下"},pending.query,tail));
                self.clarified_at=None;
                tracing::info!("background search clarification fragments joined");
            } else {
                deferred=Some(pending);
            }
            // New explicit search/control supersedes the unsent fragment.
        }
        let text=joined.as_deref().unwrap_or(text);
        let version=self.routing.as_ref().map(|r|r.version.clone()).unwrap_or_default();
        let decision=self.query_intent.route(text,self.started.elapsed().as_millis() as u64,self.routing.as_ref().map(|r|&r.config),&version);
        let action=decision.intent();
        if action.is_none(){
            self.clarified_at=None;
            // Use the actual hot-configured route, including natural weather.
            // Unrelated chat continues immediately; new searches supersede the fragment.
            if let Some(pending)=deferred.filter(|p|!missing_predicate(&p.query)) {
                self.last_route=pending.route;
                self.submit(pending.query,false);
            }
        }
        tracing::info!(version,rule_id=%decision.rule_id,action=%decision.action,"background task route");
        self.last_route=Some((version.to_owned(),decision));
        action
    }
    pub fn take_history_handoff(&mut self)->Option<String>{self.query_intent.take_handoff()}
    /// Only the unsent search fragment may wait for audio/ASR already in flight.
    /// This never delays an ordinary commit or refreshes an absolute deadline.
    pub fn observe_input(&mut self, active: bool) {
        if let Some(p) = &mut self.pending_topic {
            if active && p.since.elapsed() <= Duration::from_millis(TOPIC_TAIL_MS) {
                p.tail_observed = true;
            }
        }
    }
    pub fn on_commit(&mut self) {
        self.generation += 1;
        self.speech.retain(|s| s.task.is_some());
    }
    pub fn command(&mut self, action: Intent) -> bool {
        match action {
            Intent::Clarify => {
                if self.last_route.as_ref().is_some_and(|(_,d)|d.action=="clarify_city") {self.notice("想查哪个城市的天气？请告诉我城市名。");}
                else {self.clarified_at=Some(Instant::now());if !self.receipt(ReceiptKind::Clarify) {self.notice("想查什么？");}}
            },
            Intent::Search(query) => {
                // One active query per session in v1.
                if self.busy {
                    self.notice("我还在查刚才的问题；要换一个，可以说“改查”。");
                    return false;
                }
                let clarified=self.clarified_at.take().is_some_and(|at|at.elapsed()<=Duration::from_secs(10));
                if missing_predicate(&query) || incomplete_title(&query) || (clarified && bare_topic(&query)) {
                    let origin=self.fragment_since.take();
                    self.pending_topic=Some(PendingTopic{query,replace:false,since:origin.unwrap_or_else(Instant::now),route:self.last_route.clone(),tail_observed:origin.is_some()});
                    return true;
                }
                return self.submit(query, false);
            }
            Intent::Replace(query) => { return self.replace_query(query); },
            Intent::Cancel => {
                self.pending_topic=None;self.clarified_at=None;
                self.suppress_auto_replay();
                self.epoch += 1;
                self.gate.cancel();
                self.speech.clear();
                self.remainder = None; self.dialogue=None;
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
                if self.last_resume_at.is_some_and(|at|at.elapsed()<=Duration::from_millis(1500)){return false;}
                self.last_resume_at=Some(Instant::now());
                self.auto_pending = false;
                if self.busy {
                    self.notice("还在查或准备播报，查到后我会告诉你。");
                    return false;
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
                        return false;
                    }
                }
                if self.resume_v1 {
                    self.epoch+=1;
                    if self.tx.try_send(Command::ResumeLatest{epoch:self.epoch,generation:self.generation,request:uuid::Uuid::new_v4().to_string()}).is_ok(){self.busy=true;}
                    else {self.notice("暂时没能确认这条结果是否仍有效。");}
                }else{self.notice("暂时没有可继续的搜索结果，可以重新查一下。");}
            }
        }
        false
    }
    pub fn replace_query(&mut self, query: String) -> bool {
        self.pending_topic=None;
        if missing_predicate(&query) || bare_topic(&query) {
            self.command(Intent::Cancel);
            let origin=self.fragment_since.take();
            self.pending_topic=Some(PendingTopic{query,replace:true,since:origin.unwrap_or_else(Instant::now),route:self.last_route.clone(),tail_observed:origin.is_some()});
            return true;
        }
        self.suppress_auto_replay();
        self.epoch += 1;
        self.gate.cancel();
        self.speech.clear();
        self.remainder = None;
        self.submit(query, true)
    }
    fn submit(&mut self, query: String, replace: bool) -> bool {
        self.epoch += 1; self.dialogue=None;
        let routing=self.last_route.as_ref().and_then(|(version,d)|{
            if version.is_empty(){return None;}
            let mut claim=json!({"version":version,"rule_id":d.rule_id});
            if let Some(w)=&d.weather {claim["weather"]=json!(w);}if let Some(w)=&d.auto_weather {claim["auto_weather"]=json!(w);}if let Some(w)=&d.place_weather {claim["place_weather"]=json!(w);}Some(claim)
        });
        let receipt_kind = if self.last_route.as_ref().is_some_and(|(_,d)|d.weather.is_some()||d.auto_weather.is_some()||d.place_weather.is_some()) || query.contains("天气") {
            ReceiptKind::Weather
        } else if query.contains("新闻") {ReceiptKind::News} else {ReceiptKind::Search};
        let cmd = Command::Submit {
            routing,
            query,
            turn: uuid::Uuid::new_v4().to_string(),
            replace,
            epoch: self.epoch,
            generation: self.generation,
        };
        if self.tx.try_send(cmd).is_ok() {
            self.busy = true;
            if self.receipt(receipt_kind) { self.receipt_epoch = Some(self.epoch); }
            true
        } else {
            self.notice("这次搜索没能接单，你可以继续和我聊。");
            false
        }
    }
    fn receipt(&mut self, kind: ReceiptKind) -> bool {
        let Some(bank)=&mut self.receipts else {return false;};
        let Some(clip)=bank.try_pick(kind) else {return false;};
        // Never leave an earlier preparation/clarification cue ahead of a new query.
        self.speech.retain(|s|s.receipt.is_none());
        self.speech.push_back(Speech{grant:None,revision:1,digest:String::new(),cursor:0,sequence:0,reported_cursor:0,text:clip.text.clone(),receipt:Some(clip),task:None,
            delivery:String::new(),expires:Instant::now()+Duration::from_secs(2),result_until:None,auto_replayed:false});
        true
    }
    /// Prepared, interruptible cue only; never retry the failing TTS provider.
    pub fn tts_unavailable(&mut self)->bool { self.auto_pending=false;self.receipt(ReceiptKind::Unavailable) }
    pub fn active_receipt_pcm(&self) -> Option<Vec<u8>> {
        self.active.as_ref()?.receipt.as_ref().map(|c|c.pcm.clone())
    }
    fn notice(&mut self, text: &str) {
        if self.speech.len() < 3 {
            self.speech.push_back(Speech {
                receipt: None,grant:None,revision:1,digest:String::new(),cursor:0,sequence:0,reported_cursor:0,
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
                Event::Context{id,revision,epoch} if epoch==self.epoch => {self.dialogue=Some(json!({"protocol":1,"task_id":id,"revision":revision,"phase":"running","dialogue_epoch":epoch}));self.dialogue_changed=Instant::now();},
                Event::Verified{id,epoch} if epoch==self.epoch => {self.verified.insert(id,Instant::now());},
                Event::Accepted {epoch,generation} if epoch==self.epoch && generation==self.generation => {
                    if self.receipt_epoch!=Some(epoch) { self.notice("好，我查一下。"); }
                }
                Event::Routing {snapshot} => {
                    if self.routing.as_ref().map(|r|&r.version)!=snapshot.as_ref().map(|r|&r.version) {self.query_intent.clear();self.pending_topic=None;self.clarified_at=None;}
                    self.routing=snapshot;
                    if let Some(r)=&self.routing {let _=self.tx.try_send(Command::RoutingAck{version:r.version.clone()});}
                },
                Event::Ack {
                    text,
                    epoch,
                    generation,
                } if epoch == self.epoch && generation == self.generation => {
                    self.speech.retain(|s|s.receipt.is_none());
                    self.notice(text);
                },
                Event::Ready { id, text, epoch } if epoch == self.epoch => {
                    // A ready answer outranks a not-yet-spoken preparation cue.
                    self.speech.retain(|s|s.receipt.is_none());
                    self.verified.insert(id.clone(), Instant::now());
                    self.set_phase("ready");
                    self.gate
                        .offer(id, text, self.started.elapsed().as_millis() as u64);
                }
                Event::Claimed { speech, epoch } if epoch == self.epoch => {
                    self.speech.retain(|s|s.receipt.is_none());
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
                    self.remainder = None; self.dialogue=None;
                    // An empty ledger after submit timeout invalidates results,
                    // not the explanation that no acknowledgement was received.
                    // Otherwise the next poll cuts that notice before its first audio.
                    let active_result = self.active.as_ref().is_some_and(|s| s.task.is_some());
                    if active_result { self.active = None; self.revoked = true; }
                    tracing::info!(active_result, "background search results revoked; diagnostic notices preserved");
                    self.auto_pending = false;
                }
                Event::Claimed { speech, .. } => {
                    if self.resume_v1 && !speech.digest.is_empty(){let mut s=speech;s.sequence+=1;let _=self.tx.try_send(Command::Progress{speech:s,final_outcome:Some("dropped")});}
                    else if let Some(id) = speech.task {let _ = self.tx.try_send(Command::Receipt { id, delivery: speech.delivery, outcome: "dropped" });}
                }
                _ => {}
            }
        }
        if self.pending_topic.as_ref().is_some_and(|p|p.since.elapsed()>=Duration::from_millis(p.deadline_ms())) {
            let p=self.pending_topic.take().unwrap();self.last_route=p.route;
            if missing_predicate(&p.query) {
                self.clarified_at=Some(Instant::now());
                if !self.receipt(ReceiptKind::Clarify){self.notice("刚才的问题还没说完整，你想查什么？");}
            } else {self.submit(p.query,false);}
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
            } else if self.resume_v1 && !speech.digest.is_empty(){self.busy=false;let mut s=speech;s.sequence+=1;let _=self.tx.try_send(Command::Progress{speech:s,final_outcome:Some("dropped")});
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
        // Prepared intent receipts can start at the committed-turn boundary.
        // Results and diagnostic notices keep the existing quiet-interval contract.
        let prepared_receipt=self.speech.front().is_some_and(|s|s.receipt.is_some());
        if !prepared_receipt && self.idle_since.map(|t| t.elapsed()).unwrap_or_default() < Duration::from_millis(800) {
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
        if let Some(clip)=&speech.receipt {tracing::info!(clip=%clip.id,pcm_ms=clip.pcm.len()/48,"background search prepared receipt scheduled");}
        if let Some(id)=&speech.task {self.dialogue=Some(json!({"protocol":1,"task_id":id,"revision":speech.revision,"phase":"playing","dialogue_epoch":self.epoch}));if let Some(grant)=&speech.grant {self.dialogue.as_mut().unwrap()["resume_grant"]=json!(grant);}self.dialogue_changed=Instant::now();}
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
        self.pending_topic=None;self.clarified_at=None;
        self.query_intent.clear();
        self.auto_pending = false;
        // Invalidate an automatic revalidation already in flight without blocking ordinary speech.
        if self.busy && self.remainder.is_some() { self.epoch += 1; self.busy = false; }
        self.speech.retain(|s| !s.auto_replayed && s.receipt.is_none());
    }
    pub fn is_result_active(&self)->bool {self.active.as_ref().is_some_and(|s|s.task.is_some()&&!s.digest.is_empty())}
    pub fn accepts_ack(&self,text:&str,first_pcm:bool,input_continues:bool)->bool {
        crate::search_dialogue::classify_search_ack(self.ack_v1,text,&crate::search_dialogue::SearchPlaybackContext{result_active:self.is_result_active(),first_pcm_seen:first_pcm,input_continues})==crate::search_dialogue::SearchAckDecision::ContinueResult
    }
    pub fn dialogue_context(&self)->Option<Value>{
        if self.context_v1 && self.dialogue_changed.elapsed()<Duration::from_secs(300) {self.dialogue.clone()}else{None}
    }
    fn set_phase(&mut self,phase:&str){if let Some(d)=&mut self.dialogue {if d["phase"]!=phase{d["phase"]=json!(phase);self.dialogue_changed=Instant::now();}}}
    pub fn sentence_progress_enabled(&self)->bool{self.resume_v1 && self.is_result_active()}
    pub fn record_sentences(&mut self,complete:usize,final_outcome:Option<&'static str>){
        if !self.resume_v1{return;}
        if let Some(s)=&mut self.active {
            if s.task.is_none()||s.digest.is_empty(){return;}
            let total=s.cursor+complete.min(crate::search_progress::sentences(&s.text).len());
            // Sequence is also a monotonic count of reports; repeated audio ticks do not emit HTTP.
            if final_outcome.is_none() && total<=s.reported_cursor{return;}
            s.reported_cursor=total;s.sequence+=1;
            let _=self.tx.try_send(Command::Progress{speech:s.clone(),final_outcome});
        }
    }
    pub fn finish_sentences(&mut self,interrupted:bool,complete:usize,played_ms:u64){
        self.record_sentences(complete,Some(if interrupted{"interrupted"}else{"completed"}));
        let Some(mut s)=self.active.take() else{return;};
        self.set_phase(if interrupted{"interrupted"}else{"ready"});self.busy=false;
        self.auto_pending=interrupted && played_ms<1000 && complete==0
            && !s.auto_replayed && !self.suppress_auto && Instant::now()<s.expires;
        let parts=crate::search_progress::sentences(&s.text);
        if interrupted {s.text=parts.iter().skip(complete).cloned().collect();s.cursor=s.reported_cursor;}
        else {s.cursor=0;s.reported_cursor=0;}
        tracing::info!(task_id=s.task.as_deref().unwrap_or("ack"),delivery_id=%s.delivery,complete_sentences=complete,played_ms,interrupted,"background search sentence delivery finished (device hearing unverified)");
        self.remainder=Some(s);
    }
    pub fn close(&mut self){
        if self.closing{return;} self.closing=true;
        if let Some(task)=&self.routing_task {task.abort();}
        let api=self.api.clone();let tx=self.tx.clone();let abort=self.task.abort_handle();let resume=self.resume_v1;
        if let Ok(rt)=tokio::runtime::Handle::try_current(){rt.spawn(async move{
            let (done,wait)=tokio::sync::oneshot::channel();
            let graceful=async {tx.send(Command::Close{resume,done}).await.map_err(|_|())?;wait.await.map_err(|_|())};
            if !matches!(tokio::time::timeout(Duration::from_secs(5),graceful).await,Ok(Ok(()))){abort.abort();let _=api.request(if resume{"/session/close"}else{"/session/cancel"},Some(json!({}))).await;}
        });}else{abort.abort();}
    }
    pub fn finish(&mut self, interrupted: bool, spoken_chars: usize) {
        self.finish_with_progress(interrupted, spoken_chars, u64::MAX, true);
    }
    pub fn finish_with_progress(&mut self, interrupted: bool, spoken_chars: usize, played_ms: u64, segment_complete: bool) {
        if let Some(speech) = self.active.take() {
            if speech.task.is_some() && !speech.digest.is_empty() {
                self.set_phase(if interrupted {"interrupted"} else {"ready"});
            }
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
impl Drop for SearchSession {fn drop(&mut self){self.close();}}
fn flag(name:&str)->bool{std::env::var(name).is_ok_and(|v|v=="1")}
fn text_digest(text:&str)->String{use sha2::{Digest,Sha256};format!("{:x}",Sha256::digest(text.as_bytes()))}
fn resumed_speech(v:&Value)->Option<Speech>{
    let valid=v["valid_for_ms"].as_u64()?.min(300_000);if valid==0{return None;}
    let text=result_text(&json!({"result":{"text":v["text"]}}))?;
    let grant=v["grant"].as_str()?;uuid::Uuid::parse_str(grant).ok()?;
    let id=v["task_id"].as_str()?;uuid::Uuid::parse_str(id).ok()?;
    let digest=v["text_digest"].as_str()?;if digest.len()!=64||!digest.bytes().all(|c|c.is_ascii_hexdigit()){return None;}
    let cursor=v["complete_sentences"].as_u64()? as usize;if cursor>150{return None;}
    Some(Speech{receipt:None,grant:Some(grant.into()),revision:v["revision"].as_u64()?,digest:digest.into(),cursor,reported_cursor:cursor,sequence:0,text,task:Some(id.into()),delivery:grant.into(),expires:Instant::now()+Duration::from_millis(valid),result_until:Some(Instant::now()+Duration::from_millis(valid)),auto_replayed:true})
}
async fn report_progress(api:&Api,speech:&Speech,outcome:Option<&str>){
    let Some(id)=&speech.task else{return;};
    let progress=json!({"protocol":1,"text_digest":speech.digest,"complete_sentences":speech.reported_cursor,"sequence":speech.sequence});
    let (suffix,body)=if let Some(grant)=&speech.grant {(format!("/resume/{grant}/receipt"),json!({"outcome":outcome.unwrap_or("progress"),"progress":progress}))}
    else if let Some(outcome)=outcome {(format!("/{id}/receipt"),json!({"delivery":speech.delivery,"outcome":outcome,"progress":progress}))}
    else {(format!("/{id}/progress"),json!({"delivery":speech.delivery,"progress":progress}))};
    let _=api.request(&suffix,Some(body)).await;
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
        receipt: None,grant:None,revision:task["revision"].as_u64().unwrap_or(1),digest:task["result"]["text"].as_str().map(text_digest).unwrap_or_default(),cursor:0,sequence:0,reported_cursor:0,
        text: result_text(task)?,
        task: Some(id),
        delivery,
        expires: now + Duration::from_millis(automatic),
        result_until: Some(now + Duration::from_millis(valid)),
        auto_replayed: false,
    })
}
// Separate from the submit actor: a slow config GET cannot delay cancellation or audio.
async fn pull_routing(api:Api,events:mpsc::Sender<Event>) {
    let mut tick=tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let Ok(value)=api.request("/routing",None).await else {continue;};
        if value["protocol"]!=1 || value.get("snapshot").is_none(){continue;}
        let snapshot=if value["snapshot"].is_null(){None}else{
            let Ok(s)=serde_json::from_value::<RoutingSnapshot>(value["snapshot"].clone()) else {continue;};
            if s.version.len()!=27 || !s.version.starts_with("r7-") || !s.version[3..].bytes().all(|b|b.is_ascii_hexdigit()) || s.config.validate().is_err(){continue;}
            Some(s)
        };
        if events.send(Event::Routing{snapshot}).await.is_err(){break;}
    }
}
async fn run(api: Api, mut commands: mpsc::Receiver<Command>, events: mpsc::Sender<Event>) {
    let mut current: Option<String> = None;
    let mut current_grant:Option<String>=None;
    let mut current_delivery:Option<String>=None;
    let mut progress_jobs=tokio::task::JoinSet::new();
    let mut epoch = 0;
    let mut polling = false;
    let mut replaying = false;
    let mut poll_until = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            Some(_) = progress_jobs.join_next(), if !progress_jobs.is_empty()=>{},
            command = commands.recv() => {
                let Some(command) = command else { break; };
                match command {
                    Command::Close{resume,done}=>{let _=tokio::time::timeout(Duration::from_secs(2),async{while progress_jobs.join_next().await.is_some(){}}).await;progress_jobs.abort_all();let _=api.request(if resume{"/session/close"}else{"/session/cancel"},Some(json!({}))).await;let _=done.send(());break;},
                    Command::Progress{speech,final_outcome}=>{
                        // Cursor packets are best effort and monotonic. A slow receipt must not
                        // hold cancellation/replacement behind a queue of sentence updates.
                        if final_outcome.is_some()||progress_jobs.len()<2 {
                            if progress_jobs.len()>=4 {progress_jobs.abort_all();}
                            let api=api.clone();let packet=speech.clone();
                            progress_jobs.spawn(async move {let _=tokio::time::timeout(Duration::from_secs(1),report_progress(&api,&packet,final_outcome)).await;});
                        }
                        if final_outcome.is_some()&&current==speech.task&&current_grant==speech.grant&&current_delivery.as_deref()==Some(speech.delivery.as_str()){polling=false;}},
                    Command::ResumeLatest{epoch:e,generation,request}=>{
                        epoch=e;
                        let response=tokio::time::timeout(Duration::from_secs(2),async {
                            let body=json!({"protocol":1,"request_id":request});
                            let mut r=api.request("/resume/latest",Some(body.clone())).await;
                            if r.as_ref().err().is_some_and(|e|e.to_string()=="search_http_409"){tokio::time::sleep(Duration::from_millis(500)).await;r=api.request("/resume/latest",Some(body)).await;}
                            r
                        }).await;
                        if let Ok(Ok(v))=response {if let Some(speech)=resumed_speech(&v["resume"]){current=speech.task.clone();current_grant=speech.grant.clone();current_delivery=Some(speech.delivery.clone());replaying=true;polling=true;poll_until=speech.expires;let _=events.send(Event::Claimed{speech,epoch}).await;continue;}}
                        let _=events.send(Event::Finished{epoch}).await;
                        let _=events.send(Event::Ack{text:"暂时没有可继续的搜索结果，可以重新查一下。",epoch,generation}).await;
                    },
                    Command::RoutingAck {version}=>{let ack_api=api.clone();tokio::spawn(async move {let _=ack_api.request("/routing/ack",Some(json!({"version":version}))).await;});},
                    Command::Submit { routing, query, turn, replace, epoch: e, generation } => {
                        epoch = e; replaying = false;
                        let resumed=current_grant.take().is_some();
                        if !replace || resumed { current = None; }
                        let mut body = json!({"protocol":1,"phase":"committed","query":query,"turn":turn});
                        if let Some(routing)=routing {body["routing"]=routing;}
                        if replace && !resumed { if let Some(id) = &current { body["replace"] = json!(id); } }
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
                        let mut accepted=false;let mut task_meta=None;
                        let text = match response {
                            Ok(Ok(v)) if v["task"]["id"].as_str().is_some() => { task_meta=Some((v["task"]["id"].as_str().unwrap().to_owned(),v["task"]["revision"].as_u64().unwrap_or(1))); accepted=true; current = v["task"]["id"].as_str().map(str::to_owned); "好，我查一下。" },
                            _ if rejected => "这次搜索没有接单，你可以继续和我聊。",
                            _ => "暂时没能确认搜索是否接单，你可以继续和我聊。",
                        };
                        // A rejected replacement must not revive the superseded query.
                        polling = !rejected; poll_until = Instant::now() + Duration::from_secs(80);
                        let event=if accepted {Event::Accepted{epoch,generation}} else {Event::Ack{text,epoch,generation}};
                        let _ = events.send(event).await;
                        if let Some((id,revision))=task_meta {let _=events.send(Event::Context{id,revision,epoch}).await;}
                        if !polling { let _ = events.send(Event::Finished { epoch }).await; }
                    }
                    Command::Cancel { epoch: e, generation } => {
                        epoch = e; replaying = false;
                        if current_grant.take().is_some(){
                            let ok=api.request("/resume/cancel",Some(json!({}))).await.is_ok();current=None;polling=false;
                            let _=events.send(Event::Ack{text:if ok{"好，已取消这次搜索。"}else{"暂时没能确认取消，请稍后再试。"},epoch,generation}).await;let _=events.send(Event::Finished{epoch}).await;continue;
                        }
                        let status = api.request("", None).await;
                        let mut ids: Vec<String> = status.as_ref().ok().and_then(|v| v["tasks"].as_array()).into_iter().flatten().filter_map(|t|t["id"].as_str().map(str::to_owned)).collect();
                        if let Some(id) = &current { if !ids.contains(id) { ids.push(id.clone()); } }
                        let text = if ids.len() > 1 { "现在有多个查询，请说明要取消哪一个。" }
                            else if let Some(id) = ids.first() {
                                if api.request(&format!("/{id}/cancel"),Some(json!({}))).await.is_ok() { current = None; polling = false; "好，已取消这次搜索。" }
                                else { "暂时没能确认取消，请稍后再试。" }
                            } else if status.is_ok() { polling = false; if flag("P003_SEARCH_RESUME_V1")&&api.request("/resume/cancel",Some(json!({}))).await.is_ok(){"好，已取消这次搜索。"}else{"当前没有进行中的搜索。"} } else { "暂时没能确认取消，请稍后再试。" };
                        let _ = events.send(Event::Ack { text, epoch, generation }).await;
                        if !polling { let _ = events.send(Event::Finished { epoch }).await; }
                    }
                    Command::Claim { id, delivery, epoch: e } => {
                        if e != epoch { continue; }
                        if let Ok(v) = api.request(&format!("/{id}/claim"),Some(json!({"delivery":delivery}))).await {
                            if let Some(speech) = claimed_speech(&v["task"], id, delivery) { current_delivery=Some(speech.delivery.clone());let _ = events.send(Event::Claimed { epoch, speech }).await; }
                        }
                    }
                    Command::Resume { mut speech, epoch: e, generation, automatic } => {
                        epoch = e;
                        let Some(id) = speech.task.clone() else { continue; };
                        if speech.grant.is_some(){
                            if let Ok(v)=api.request("/resume/latest",Some(json!({"protocol":1,"request_id":uuid::Uuid::new_v4().to_string()}))).await {if let Some(s)=resumed_speech(&v["resume"]){current=s.task.clone();current_grant=s.grant.clone();current_delivery=Some(s.delivery.clone());polling=true;replaying=true;poll_until=s.expires;let _=events.send(Event::Claimed{speech:s,epoch}).await;continue;}}
                            let _=events.send(Event::Revoked{epoch}).await;continue;
                        }
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
                                speech.delivery = delivery;current_delivery=Some(speech.delivery.clone());
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
                        if current.as_deref() == Some(id.as_str()) && current_delivery.as_deref()==Some(delivery.as_str()) { polling=false; }
                    }
                }
            }
            _ = tick.tick(), if polling => {
                if Instant::now() >= poll_until { polling = false; let _ = events.send(Event::Finished { epoch }).await; continue; }
                let suffix = if let Some(grant)=&current_grant {format!("/resume/{grant}/playback")} else if replaying { current.as_ref().map(|id| format!("/{id}/playback")).unwrap_or_default() } else { String::new() };
                let response = api.request(&suffix, None).await;
                if let Ok(mut v) = response {
                    if current_grant.is_some(){if v["resume"]["valid_for_ms"].as_u64().unwrap_or(0)>0 {if let Some(id)=&current{let _=events.send(Event::Verified{id:id.clone(),epoch}).await;}}else{polling=false;let _=events.send(Event::Revoked{epoch}).await;}continue;}
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
    #[tokio::test]
    async fn r17_verification_task_client_uses_the_real_background_path() {
        let _=rustls::crypto::ring::default_provider().install_default();
        let mut cfg=LlmConfig{base_url:"https://kidshub-ai.hahaxiong.cc/_canary/search-verification-20261026/v1".into(),
            api_key:"test".into(),model:"test".into(),instructions:String::new(),thinking:"off".into(),strip_leading_filler:false,
            url_query:"token=synthetic".into(),room:"sn-BJP00399999999999901-123".into()};
        let api=Api::new(&cfg).expect("verification must exercise search, not silently fall back to ordinary chat");
        assert_eq!(api.url.path(),"/_canary/search-verification-20261026/v1/internal/search-tasks");
        assert_eq!(api.url.query_pairs().find(|(k,_)|k=="room").unwrap().1,cfg.room);
        for base in ["https://kidshub-ai.hahaxiong.cc/v1",crate::search_canary::BASE] {
            cfg.base_url=base.into();assert!(Api::new(&cfg).is_some());
        }
        for base in ["http://kidshub-ai.hahaxiong.cc/_canary/search-verification-20261026/v1",
            "https://kidshub-ai.hahaxiong.cc/_canary/search-verification-20261026/v10",
            "https://kidshub-ai.hahaxiong.cc:444/_canary/search-verification-20261026/v1",
            "https://test:secret@kidshub-ai.hahaxiong.cc/_canary/search-verification-20261026/v1",
            "https://evil.test/_canary/search-verification-20261026/v1"] {
            cfg.base_url=base.into();assert!(Api::new(&cfg).is_none());
        }
    }
    #[tokio::test]
    async fn r14_preparation_cue_does_not_change_running_query_to_interrupted(){
        let(mut s,_,_)=test_session();s.context_v1=true;
        s.dialogue=Some(json!({"protocol":1,"task_id":"task","revision":1,"phase":"running","dialogue_epoch":0}));
        s.notice("好，我查一下。");s.idle_since=Some(Instant::now()-Duration::from_secs(1));s.poll(true);s.finish(false,4);
        assert_eq!(s.dialogue_context().unwrap()["phase"],"running","a receipt is not a result interruption");
        s.active=claimed_speech(&json!({"valid_for_ms":300000,"automatic_for_ms":60000,"result":{"text":"第一句。第二句。"}}),"task".into(),"d".into());
        s.finish(false,8);assert_eq!(s.dialogue_context().unwrap()["phase"],"ready","context-only rollout keeps a completed result truthful");
    }
    #[tokio::test]
    async fn r14_sentence_progress_keeps_the_existing_bounded_early_replay_contract(){
        for (played_ms,complete,already_replayed,suppressed,expected) in [(200,0,false,false,true),(1200,0,false,false,false),(200,1,false,false,false),(200,0,true,false,false),(200,0,false,true,false)]{
            let(mut s,_,_)=test_session();s.resume_v1=true;s.suppress_auto=suppressed;
            let mut speech=claimed_speech(&json!({"valid_for_ms":300000,"automatic_for_ms":60000,"result":{"text":"第一句。第二句。"}}),"task".into(),"d".into()).unwrap();
            speech.auto_replayed=already_replayed;s.active=Some(speech);
            s.finish_sentences(true,complete,played_ms);assert_eq!(s.auto_pending,expected,"early replay must remain bounded: played={played_ms}, complete={complete}");
        }
    }
    #[tokio::test]
    async fn r14_ack_and_sentence_cursor_are_scoped_to_real_active_result(){
        let(mut s,events,mut commands)=test_session();s.ack_v1=true;s.resume_v1=true;s.context_v1=true;
        s.notice("好，我查一下。");s.idle_since=Some(Instant::now()-Duration::from_secs(1));s.poll(true);
        assert!(!s.accepts_ack("嗯",true,false),"preparation cues must never swallow input");s.finish(false,4);
        let speech=claimed_speech(&json!({"id":"task","revision":2,"valid_for_ms":300000,"automatic_for_ms":60000,"result":{"text":"火星呈现红色。表面有氧化铁。"}}),"task".into(),"d1".into()).unwrap();
        events.send(Event::Claimed{speech,epoch:0}).await.unwrap();s.idle_since=Some(Instant::now()-Duration::from_secs(1));assert!(s.poll(true).is_some());
        assert!(!s.accepts_ack("嗯",false,false));assert!(s.accepts_ack("嗯",true,false));assert!(!s.accepts_ack("嗯我想聊猫",true,false));
        s.record_sentences(1,None);assert!(matches!(commands.try_recv(),Ok(Command::Progress{final_outcome:None,..})));
        s.record_sentences(1,None);assert!(commands.try_recv().is_err(),"repeated audio ticks do not create HTTP");
        s.finish_sentences(true,1,5390);assert_eq!(s.remainder.as_ref().unwrap().text,"表面有氧化铁。");
        assert_eq!(s.dialogue_context().unwrap()["phase"],"interrupted");assert!(!s.accepts_ack("嗯",true,false));
        assert!(matches!(commands.try_recv(),Ok(Command::Progress{final_outcome:Some("interrupted"),..})));
        s.command(Intent::Cancel);assert!(s.dialogue_context().is_none());assert!(s.remainder.is_none());
    }
    #[tokio::test]
    async fn r14_reconnect_is_silent_until_explicit_resume_and_late_grants_cannot_restart_audio(){
        let(mut s,events,mut commands)=test_session();s.resume_v1=true;
        assert!(s.poll(true).is_none());assert!(commands.try_recv().is_err());
        s.command(Intent::Resume);assert!(matches!(commands.try_recv(),Ok(Command::ResumeLatest{..})));
        let epoch=s.epoch;s.command(Intent::Cancel);commands.try_recv().unwrap();
        let v=json!({"valid_for_ms":270000,"text":"表面有氧化铁。","grant":"00000000-0000-4000-8000-000000000002","task_id":"00000000-0000-4000-8000-000000000001","revision":1,"text_digest":"a".repeat(64),"complete_sentences":1});
        let speech=resumed_speech(&v).unwrap();assert_eq!(speech.cursor,1);
        events.send(Event::Claimed{speech,epoch}).await.unwrap();assert!(s.poll(true).is_none());assert!(s.speech.is_empty());
        assert!(matches!(commands.try_recv(),Ok(Command::Progress{final_outcome:Some("dropped"),..})));
        assert!(resumed_speech(&json!({"valid_for_ms":0})).is_none());
    }
    #[tokio::test]
    async fn r14_slow_progress_http_does_not_queue_a_cancel_behind_sentence_reports(){
        use tokio::io::{AsyncReadExt,AsyncWriteExt};
        let _=rustls::crypto::ring::default_provider().install_default();
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap();
        let (seen,mut requests)=mpsc::channel(8);
        let server=tokio::spawn(async move {loop{let(mut socket,_)=listener.accept().await.unwrap();let seen=seen.clone();tokio::spawn(async move{
            let mut buf=[0u8;4096];let n=socket.read(&mut buf).await.unwrap();let raw=String::from_utf8_lossy(&buf[..n]);let first=raw.lines().next().unwrap().to_owned();let slow=first.contains("/progress?");let _=seen.send(first).await;
            if slow{tokio::time::sleep(Duration::from_secs(2)).await;}
            let body=if slow{"{}"}else{"{\"tasks\":[]}"};let _=socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await;
        });}});
        let api=Api{client:reqwest::Client::new(),url:format!("http://{addr}/tasks?room=synthetic").parse().unwrap(),token:"synthetic".into(),key:"synthetic".into()};
        let(tx,commands)=mpsc::channel(8);let(events,_)=mpsc::channel(8);let actor=tokio::spawn(run(api,commands,events));
        let mut speech=claimed_speech(&json!({"valid_for_ms":300000,"automatic_for_ms":60000,"result":{"text":"第一句。第二句。"}}),"task".into(),"d".into()).unwrap();speech.sequence=1;
        tx.send(Command::Progress{speech,final_outcome:None}).await.unwrap();assert!(requests.recv().await.unwrap().contains("/progress?"));
        tx.send(Command::Cancel{epoch:1,generation:1}).await.unwrap();
        let request=tokio::time::timeout(Duration::from_millis(200),requests.recv()).await.expect("cancel must bypass slow progress").unwrap();assert!(request.starts_with("GET"));
        actor.abort();server.abort();
    }
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
                resume_v1:false,context_v1:false,ack_v1:false,closing:false,dialogue:None,dialogue_changed:Instant::now(),
                receipts: None, receipt_epoch: None,
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
            query_intent: RoutingSession::default(),
            routing:None,last_route:None,routing_task:None,
            clarified_at:None,pending_topic:None,last_resume_at:None,fragment_since:None,
            },
            events,
            commands,
        )
    }
    #[tokio::test]
    async fn r21_word_explanation_does_not_submit_or_mutate_running_search() {
        let (mut s,_events,mut commands)=test_session();
        s.context_v1=true;s.dialogue=Some(json!({"phase":"running"}));s.dialogue_changed=Instant::now();s.busy=true;
        let epoch=s.epoch;let generation=s.generation;
        assert!(s.interpret("查查是啥").is_none());
        assert!(commands.try_recv().is_err());assert!(s.speech.is_empty());
        assert!(s.busy);assert_eq!(s.epoch,epoch);assert_eq!(s.generation,generation);
        assert_eq!(s.dialogue.as_ref().unwrap()["phase"],"running");
    }
    #[tokio::test]
    async fn r20_asr_replace_is_scoped_and_split_resume_is_idempotent() {
        let (mut s,_events,mut commands)=test_session();
        let query="改茶大鱼海棠里大鱼这首歌是谁唱的";
        assert!(s.interpret(query).is_none());
        s.context_v1=true;s.dialogue=Some(json!({"phase":"running"}));s.dialogue_changed=Instant::now();
        assert_eq!(s.interpret(query),Some(Intent::Replace("大鱼海棠里大鱼这首歌是谁唱的".into())));
        for text in ["改茶具的颜色", "改茶叶品种", "改茶的口味", "他说改茶大鱼", "不要改茶大鱼", "我想喝茶"] { assert!(s.interpret(text).is_none(),"{text}"); }
        s.resume_v1=true;
        let action=s.interpret("继续刚才的搜索").unwrap();s.command(action);
        assert!(matches!(commands.try_recv(),Ok(Command::ResumeLatest{..})));
        let action=s.interpret("结果").unwrap();s.command(action);
        assert!(commands.try_recv().is_err());assert!(s.speech.is_empty(),"split tail must not add a second notice");
    }
    #[tokio::test]
    async fn r20_incomplete_public_title_waits_only_in_search_lane() {
        let (mut s,_events,mut commands)=test_session();
        let action=s.interpret("帮我查一下我的世界基岩版").unwrap();s.command(action);
        assert!(commands.try_recv().is_err());
        let action=s.interpret("最近正式更新了什么").unwrap();s.command(action);
        assert!(matches!(commands.try_recv(),Ok(Command::Submit{query,..}) if query=="我的世界基岩版最近正式更新了什么"));
        let (mut s,_events,mut commands)=test_session();
        let action=s.interpret("帮我查一下我的世界基岩版").unwrap();s.command(action);
        let since=s.pending_topic.as_ref().unwrap().since;
        let action=s.interpret("最近").unwrap();s.command(action);
        assert!(commands.try_recv().is_err());assert_eq!(s.pending_topic.as_ref().unwrap().since,since);
        let action=s.interpret("正式更新了什么").unwrap();s.command(action);
        assert!(matches!(commands.try_recv(),Ok(Command::Submit{query,..}) if query=="我的世界基岩版最近正式更新了什么"));
        let (mut s,_events,mut commands)=test_session();
        let action=s.interpret("帮我查一下我的世界基岩版").unwrap();s.command(action);
        assert!(s.interpret("我今天打球赢了").is_none());
        assert!(matches!(commands.try_recv(),Ok(Command::Submit{query,..}) if query=="我的世界基岩版"));
    }
    #[tokio::test]
    async fn r22_tts_failure_notice_is_local_cancellable_and_never_submits_or_completes_search(){
        let (mut s,_events,mut commands)=test_session();
        assert!(!s.tts_unavailable());assert!(s.speech.is_empty());
        s.receipts=Some(ReceiptBank::synthetic());
        s.auto_pending=true;
        assert!(s.tts_unavailable());assert!(!s.auto_pending);assert!(commands.try_recv().is_err());assert!(!s.busy);
        assert_eq!(s.poll(true).unwrap(),"这次没播出来，等会儿再试。");
        assert!(s.active_receipt_pcm().is_some());s.finish(false,15);assert!(commands.try_recv().is_err());
        assert!(s.tts_unavailable());s.on_commit();assert!(s.poll(true).is_none(),"new speech supersedes failure cue");
    }
    #[tokio::test]
    async fn r13_receipt_is_ready_after_queue_acceptance_without_http_or_idle_wait() {
        let (mut s, _events, mut commands) = test_session();
        s.receipts=Some(ReceiptBank::synthetic());
        assert!(s.command(Intent::Search("火星为什么是红色".into())));
        assert!(matches!(commands.try_recv(), Ok(Command::Submit { .. })));
        // No HTTP acknowledgement and no 800ms idle timer: queue acceptance
        // is enough for an intent receipt, never a claim of completed search.
        assert!(s.poll(true).is_some(), "search should give a prepared intent receipt immediately");
    }

    #[tokio::test]
    async fn r13_receipt_success_ack_is_not_spoken_twice() {
        let (mut s, events, _commands) = test_session(); s.receipts=Some(ReceiptBank::synthetic());
        assert!(s.command(Intent::Search("火星为什么是红色".into())));
        assert!(s.poll(true).is_some()); assert!(s.active_receipt_pcm().is_some());s.finish(false,4);
        events.send(Event::Accepted{epoch:s.epoch,generation:s.generation}).await.unwrap();
        s.idle_since=Some(Instant::now()-Duration::from_secs(1));
        assert!(s.poll(true).is_none());assert!(s.speech.is_empty());
    }
    #[tokio::test]
    async fn r13_receipt_ready_answer_skips_unspoken_receipt_and_keeps_result_gate() {
        let (mut s, events, mut commands) = test_session();s.receipts=Some(ReceiptBank::synthetic());
        assert!(s.command(Intent::Search("北京天气".into())));commands.try_recv().unwrap();
        events.send(Event::Accepted{epoch:s.epoch,generation:s.generation}).await.unwrap();
        events.send(Event::Ready{id:"task".into(),text:"搜索结果。".into(),epoch:s.epoch}).await.unwrap();
        assert!(s.poll(false).is_none());assert!(s.speech.is_empty(),"ready must discard queued intent audio");
        let speech=claimed_speech(&json!({"valid_for_ms":10000,"automatic_for_ms":10000,"result":{"text":"搜索结果。"}}),"task".into(),"d".into()).unwrap();
        events.send(Event::Claimed{speech,epoch:s.epoch}).await.unwrap();
        assert!(s.poll(true).is_none(),"results retain the quiet safety gate");
        s.idle_since=Some(Instant::now()-Duration::from_secs(1));
        assert_eq!(s.poll(true),Some("搜索结果。".into()));assert!(s.active_receipt_pcm().is_none());
    }
    #[tokio::test]
    async fn r13_receipt_user_speech_cancel_replace_and_deadline_remove_stale_cues() {
        for action in ["speech","commit","cancel","replace","expiry"] {
            let (mut s, events, _commands) = test_session();s.receipts=Some(ReceiptBank::synthetic());
            assert!(s.command(Intent::Search("火星为什么是红色".into())));
            let old_epoch=s.epoch;let old_generation=s.generation;
            match action {
                "speech"=>s.suppress_auto_replay(),
                "commit"=>s.on_commit(),
                "cancel"=>{s.command(Intent::Cancel);},
                "replace"=>{s.command(Intent::Replace("北京天气".into()));},
                _=>s.speech.front_mut().unwrap().expires=Instant::now()-Duration::from_millis(1),
            }
            events.send(Event::Accepted{epoch:old_epoch,generation:old_generation}).await.unwrap();
            let out=s.poll(true);
            if action=="replace" {assert_eq!(out,Some("查查天气。".into()));}
            else {assert!(out.is_none(),"stale receipt after {action}");}
        }
    }
    #[tokio::test]
    async fn r13_receipt_does_not_claim_queue_rejection_or_unfinished_topic() {
        let (mut s, _, _commands) = test_session();s.receipts=Some(ReceiptBank::synthetic());
        for _ in 0..16 {s.tx.try_send(Command::RoutingAck{version:"v".into()}).unwrap();}
        assert!(!s.command(Intent::Search("火星".into())));assert!(s.speech.iter().all(|s|s.receipt.is_none()));
        let (mut s, _, mut commands)=test_session();s.receipts=Some(ReceiptBank::synthetic());
        s.command(Intent::Clarify);assert_eq!(s.poll(true),Some("想查什么？".into()));s.finish(false,5);
        s.command(Intent::Search("三角龙".into()));assert!(s.poll(true).is_none());assert!(commands.try_recv().is_err());
    }
    #[tokio::test]
    async fn r13_receipt_disabled_preserves_legacy_acceptance_and_idle_gate() {
        let (mut s,events, _commands)=test_session();s.command(Intent::Search("北京天气".into()));
        assert!(s.poll(true).is_none());events.send(Event::Accepted{epoch:s.epoch,generation:s.generation}).await.unwrap();
        assert!(s.poll(true).is_none());s.idle_since=Some(Instant::now()-Duration::from_secs(1));
        assert_eq!(s.poll(true),Some("好，我查一下。".into()));assert!(s.active_receipt_pcm().is_none());
    }

    #[tokio::test]
    async fn r14_incomplete_explicit_question_waits_for_adjacent_predicate_only() {
        for (head,tail,query) in [("帮我查一下恐龙为什么","灭绝","恐龙为什么灭绝"),("帮我查一下月亮为什么会","发光","月亮为什么会发光")] {
            let (mut s,_,mut commands)=test_session();
            let a=s.interpret(head).unwrap();s.command(a);
            assert!(commands.try_recv().is_err(),"incomplete question must not be dispatched");
            s.pending_topic.as_mut().unwrap().since=Instant::now()-Duration::from_millis(879);
            let a=s.interpret(tail).unwrap();s.command(a);
            assert!(matches!(commands.try_recv(),Ok(Command::Submit{query:q,..})if q==query));
            assert!(commands.try_recv().is_err());
        }
    }
    #[tokio::test]
    async fn r14_missing_predicate_expires_into_clarification_never_search() {
        let (mut s,_,mut commands)=test_session();
        let a=s.interpret("帮我查一下恐龙为什么").unwrap();s.command(a);
        s.observe_input(true);
        s.pending_topic.as_mut().unwrap().since=Instant::now()-Duration::from_millis(5001);
        s.poll(false);
        assert!(commands.try_recv().is_err());assert!(s.pending_topic.is_none());
        assert!(s.speech.iter().any(|s|s.text.contains("想查什么")));
        assert!(!s.busy);
    }
    #[tokio::test]
    async fn r14_incomplete_question_cannot_swallow_new_topic_or_control() {
        for next in ["我今天画了小猫","不用查了，我们聊别的","帮我查火星为什么是红色","今天北京的天气","停一下"] {
            let (mut s,_,mut commands)=test_session();
            s.routing=Some(RoutingSnapshot{version:"r7-aaaaaaaaaaaaaaaaaaaaaaaa".into(),config:RoutingConfig::default()});
            let a=s.interpret("帮我查一下恐龙为什么").unwrap();s.command(a);
            let action=s.interpret(next);
            if next.starts_with("我今天") {assert!(action.is_none());}
            if let Some(a)=action{s.command(a);}
            while let Ok(c)=commands.try_recv(){if let Command::Submit{query,..}=c{assert!(!query.contains("恐龙"));}}
            assert!(s.pending_topic.is_none());
        }
    }
    #[tokio::test]
    async fn r14_incomplete_replace_cancels_old_and_submits_complete_replacement_while_busy() {
        let (mut s,_,mut commands)=test_session();s.busy=true;
        let a=s.interpret("改查恐龙为什么").unwrap();s.command(a);
        assert!(matches!(commands.try_recv(),Ok(Command::Cancel{..})));
        assert!(commands.try_recv().is_err());
        let a=s.interpret("会灭绝").unwrap();s.command(a);
        assert!(matches!(commands.try_recv(),Ok(Command::Submit{query,replace:true,..})if query=="恐龙为什么会灭绝"));
    }
    #[tokio::test]
    async fn r14_complete_explicit_question_has_no_new_tail_wait() {
        let (mut s,_,mut commands)=test_session();
        let a=s.interpret("帮我查一下恐龙为什么会灭绝").unwrap();s.command(a);
        assert!(s.pending_topic.is_none());
        assert!(matches!(commands.try_recv(),Ok(Command::Submit{query,..})if query=="恐龙为什么会灭绝"));
    }
    #[tokio::test]
    async fn clarified_topic_split_by_asr_is_one_complete_search_not_foreground_chat() {
        let (mut s,_,mut commands)=test_session();
        let ask=s.interpret("帮我查一下").unwrap();s.command(ask);
        let topic=s.interpret("三角龙。").unwrap();s.command(topic);
        assert!(commands.try_recv().is_err(),"bare clarification topic needs a bounded tail window");
        s.pending_topic.as_mut().unwrap().since=Instant::now()-Duration::from_millis(600);
        let tail=s.interpret("主要吃什么？");
        assert_eq!(tail,Some(Intent::Search("三角龙主要吃什么".into())));
        s.command(tail.unwrap());
        match commands.try_recv().unwrap(){Command::Submit{query,..}=>assert_eq!(query,"三角龙主要吃什么"),_=>panic!("one query")}
        assert!(commands.try_recv().is_err(),"do not create then replace an incomplete task");
    }
    #[tokio::test]
    async fn clarification_topic_never_waits_unrelated_chat_or_survives_cancel() {
        for next in ["我今天画了小猫","不用查了，我们聊别的","帮我查火星为什么是红色"] {
            let (mut s,_,mut commands)=test_session();
            let ask=s.interpret("帮我查一下").unwrap();s.command(ask);
            let topic=s.interpret("三角龙").unwrap();s.command(topic);
            assert!(commands.try_recv().is_err());
            let action=s.interpret(next);
            if next.starts_with("我今天") {
                assert!(action.is_none(),"unrelated chat goes straight to foreground");
                assert!(matches!(commands.try_recv(),Ok(Command::Submit{query,..}) if query=="三角龙"));
            } else {
                s.command(action.unwrap());
                while let Ok(c)=commands.try_recv(){if let Command::Submit{query,..}=c{assert!(!query.contains("三角龙"));}}
            }
        }
    }
    #[tokio::test]
    async fn complete_clarification_question_is_submitted_without_tail_wait() {
        let (mut s,_,mut commands)=test_session();
        let ask=s.interpret("帮我查一下").unwrap();s.command(ask);
        let question=s.interpret("三角龙主要吃什么").unwrap();s.command(question);
        assert!(matches!(commands.try_recv(),Ok(Command::Submit{query,..}) if query=="三角龙主要吃什么"));
    }
    #[tokio::test]
    async fn ongoing_asr_tail_survives_soft_deadline_but_never_holds_normal_chat() {
        for next in ["主要吃什么","我今天画了小猫"] {
            let (mut s,_,mut commands)=test_session();
            let a=s.interpret("帮我查一下").unwrap();s.command(a);
            let a=s.interpret("三角龙").unwrap();s.command(a);
            s.pending_topic.as_mut().unwrap().since=Instant::now()-Duration::from_millis(600);
            s.observe_input(true);
            s.pending_topic.as_mut().unwrap().since=Instant::now()-Duration::from_millis(1851);
            s.poll(false);
            assert!(commands.try_recv().is_err(),"do not submit the topic while its observed tail is still being recognized");
            let a=s.interpret(next);
            if next=="主要吃什么" {
                assert_eq!(a,Some(Intent::Search("三角龙主要吃什么".into())));s.command(a.unwrap());
            } else {assert!(a.is_none(),"normal chat is never buffered");}
            assert!(matches!(commands.try_recv(),Ok(Command::Submit{..})));
            assert!(commands.try_recv().is_err());
        }
    }
    #[tokio::test]
    async fn noisy_or_missing_tail_cannot_hold_search_indefinitely() {
        let (mut s,_,mut commands)=test_session();
        let a=s.interpret("帮我查一下").unwrap();s.command(a);
        let a=s.interpret("三角龙").unwrap();s.command(a);s.observe_input(true);
        s.pending_topic.as_mut().unwrap().since=Instant::now()-Duration::from_millis(5001);
        s.poll(false);
        assert!(matches!(commands.try_recv(),Ok(Command::Submit{query,..})if query=="三角龙"));
        s.poll(false);assert!(commands.try_recv().is_err());
    }
    #[tokio::test]
    async fn hot_configured_weather_supersedes_unsent_clarification_topic() {
        let (mut s,_,mut commands)=test_session();
        s.routing=Some(RoutingSnapshot{version:"r7-aaaaaaaaaaaaaaaaaaaaaaaa".into(),config:RoutingConfig::default()});
        let ask=s.interpret("帮我查一下").unwrap();s.command(ask);
        let topic=s.interpret("三角龙").unwrap();s.command(topic);
        let weather=s.interpret("今天北京的天气").unwrap();
        assert!(commands.try_recv().is_err(),"natural weather must not submit the old topic first");
        s.command(weather);
        assert!(matches!(commands.try_recv(),Ok(Command::Submit{query,..}) if query.contains("北京")&&!query.contains("三角龙")));
        assert!(commands.try_recv().is_err());
    }
    #[tokio::test]
    async fn bare_topic_times_out_into_one_search_and_same_words_without_clarify_stay_chat() {
        let (mut s,_,_)=test_session();
        assert!(s.interpret("三角龙").is_none());
        assert!(s.interpret("主要吃什么").is_none());
        // A fresh session has no recent question eligible for a search handoff.
        let (mut s,_,mut commands)=test_session();
        let ask=s.interpret("帮我查一下").unwrap();s.command(ask);
        let topic=s.interpret("三角龙").unwrap();s.command(topic);
        assert!(commands.try_recv().is_err(),"a partial topic must not be submitted early");
        assert!(s.pending_topic.is_some(),"expected unsent topic");
        s.pending_topic.as_mut().unwrap().since=Instant::now()-Duration::from_millis(TOPIC_TAIL_MS+1);
        s.poll(false);
        assert!(matches!(commands.try_recv(),Ok(Command::Submit{query,..}) if query=="三角龙"));
        s.poll(false);assert!(commands.try_recv().is_err());
    }
    #[tokio::test]
    async fn search_handoff_queue_acceptance_and_busy_rejection() {
        let (mut s,_,mut commands)=test_session();
        assert!(s.interpret("故宫明天开放吗").is_none());
        let action=s.interpret("帮我查一下").unwrap();
        assert_eq!(s.take_history_handoff(),Some("故宫明天开放吗".into()));
        assert!(s.command(action));
        assert!(matches!(commands.try_recv(),Ok(Command::Submit{..})));
        assert!(!s.command(Intent::Search("另一个问题".into())));
        s.busy=false;drop(commands);
        assert!(!s.command(Intent::Search("无法接单".into())));
    }

    #[tokio::test]
    async fn routing_applies_on_audio_tick_and_snapshots_actual_applied_version() {
        let (mut s,events,mut commands)=test_session();
        assert!(s.interpret("今天北京的天气").is_none());
        let version="r7-aaaaaaaaaaaaaaaaaaaaaaaa".to_string();
        events.send(Event::Routing{snapshot:Some(RoutingSnapshot{version:version.clone(),config:RoutingConfig::default()})}).await.unwrap();
        assert!(commands.try_recv().is_err(),"received is not applied");
        s.poll(false);
        assert!(matches!(commands.recv().await,Some(Command::RoutingAck{version:v}) if v==version));
        let action=s.interpret("今天北京的天气").unwrap();s.command(action);
        match commands.recv().await.unwrap(){Command::Submit{routing:Some(r),..}=>{assert_eq!(r["version"],version);assert_eq!(r["weather"]["city_id"],2);},_=>panic!("missing immutable route claim")}
        events.send(Event::Routing{snapshot:None}).await.unwrap();s.poll(false);
        assert!(s.interpret("今天北京的天气").is_none(),"explicit removal returns to built-in fallback");
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
            routing:None,
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
        tx.send(Command::Submit{routing:None,query:"火星为什么是红色".into(),turn:"same-turn".into(),replace:false,epoch:1,generation:1}).await.unwrap();
        let started=Instant::now();let mut ticks=0;
        while started.elapsed()<Duration::from_millis(500) {tokio::time::sleep(Duration::from_millis(20)).await;ticks+=1;}
        assert!(ticks>=20,"foreground scheduling must remain available during HTTPS delay");
        let event=tokio::time::timeout(Duration::from_secs(5),rx.recv()).await.unwrap().unwrap();
        assert!(matches!(event,Event::Accepted{..}),"expected acceptance acknowledgement");
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
        tx.send(Command::Submit{routing:None,query:"火星".into(),turn:"first".into(),replace:false,epoch:0,generation:1}).await.unwrap();
        while !matches!(rx.recv().await,Some(Event::Accepted{epoch:0,..})){}
        tx.send(Command::Submit{routing:None,query:"恐龙".into(),turn:"second".into(),replace:true,epoch:1,generation:2}).await.unwrap();
        while !matches!(rx.recv().await,Some(Event::Ack{epoch:1,..})){}
        let next=tokio::time::timeout(Duration::from_secs(2),rx.recv()).await.unwrap().unwrap();
        assert!(matches!(next,Event::Finished{epoch:1}),"rejected replacement must release busy and not replay old result");
        actor.abort();server.abort();
    }

}
