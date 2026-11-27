//! Personal-room data plane. Sender identity and SID come from LiveKit, never JSON.
use crate::{
    config::Config,
    llm::{self, LlmConfig},
    owned_task::OwnedTask,
};
use anyhow::{Result, ensure};
use livekit::{participant::ParticipantKind, prelude::*};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::mpsc,
    time::{Instant, timeout},
};

pub const AGENT: &str = "personal-xiaoke";
pub const RELAY: &str = "personal-text-relay";
pub const INPUT: &str = "personal.v1.input";
pub const OUTPUT: &str = "personal.v1.output";

/// Phone interaction policy. Each phrase stops a reply while retaining the microphone.
pub fn stop_words() -> HashSet<String> {
    crate::textproc::parse_hotwords_with(None,
        "退出,退出吧,退出对话,结束对话,结束聊天,不聊了,我不想聊了,停,停下,停一下,先停一下,别说了,别说话,闭嘴,小可退出,小可停一下")
}

const MAX_TEXT: usize = 4096;
const MAX_TURNS: usize = 256;
const MAX_PACKET: usize = 14_000;

fn slug(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn hex_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn personal_room(room: &str) -> bool {
    room.strip_prefix("pv-").is_some_and(hex_id)
}

pub(crate) fn is_room(room: &str) -> bool {
    personal_room(room)
}

pub fn audio_configured() -> bool {
    // 档案已挂上时，房间快照会在 prebuild 里失败可见；不要在这里静默关掉语音。
    if crate::personal_providers::engaged() {
        return true;
    }
    if crate::stt_volc::personal_local_speech::endpoint().is_some() { return true; }
    let has = |key| std::env::var(key).is_ok_and(|value| !value.trim().is_empty());
    let volc = has("VOLC_APP_ID") && has("VOLC_ACCESS_TOKEN");
    let asr = volc || has("VOLC_ASR_API_KEY");
    let tts = match std::env::var("TTS_PROVIDER").as_deref() {
        Ok("xfyun") => crate::tts::TtsCfg::from_env().is_ok(),
        Ok("volc") | Err(_) => volc,
        _ => false,
    };
    asr && tts
}

fn matches_owner(owner: &str) -> bool {
    let configured = std::env::var("PERSONAL_OWNER_ID").unwrap_or_else(|_| "owner".to_owned());
    slug(owner) && owner == configured
}

pub fn assigned_device(agent: &str, room: &str, metadata: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Binding {
        owner_id: String,
        device_id: String,
    }
    if agent != AGENT || !personal_room(room) {
        return None;
    }
    let binding: Binding = serde_json::from_str(metadata).ok()?;
    (matches_owner(&binding.owner_id) && slug(&binding.device_id))
        .then(|| format!("personal:{}:{}", binding.owner_id, binding.device_id))
}

fn device_identity(identity: &str) -> bool {
    identity
        .strip_prefix("personal:")
        .and_then(|id| id.split_once(':'))
        .is_some_and(|(owner, device)| matches_owner(owner) && slug(device))
}

#[derive(Serialize, Debug)]
pub struct Metadata {
    tool: Option<String>,
    sources: Vec<Source>,
}

#[derive(Serialize, Debug)]
struct Source {
    title: String,
    url: String,
    date: Option<String>,
}

impl Metadata {
    pub fn from_final(value: &Value) -> Option<Self> {
        let tool = value["tool"]
            .as_str()
            .filter(|tool| matches!(*tool, "search" | "weather" | "clock" | "search_cancel"));
        let mut urls = HashSet::new();
        let mut sources: Vec<_> = value["sources"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| {
                let url = item["url"].as_str()?;
                if url.len() > 1024 {
                    return None;
                }
                let parsed = reqwest::Url::parse(url).ok()?;
                if parsed.scheme() != "https"
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || !urls.insert(url)
                {
                    return None;
                }
                let title: String = item["title"]
                    .as_str()
                    .unwrap_or(url)
                    .chars()
                    .take(120)
                    .collect();
                let date = item["date"]
                    .as_str()
                    .filter(|s| s.len() <= 40)
                    .map(str::to_owned);
                Some(Source {
                    title,
                    url: url.to_owned(),
                    date,
                })
            })
            .take(5)
            .collect();
        while serde_json::to_vec(&sources).is_ok_and(|payload| payload.len() > 6500) {
            sources.pop();
        }
        (tool.is_some() || !sources.is_empty()).then(|| Self {
            tool: tool.map(str::to_owned),
            sources,
        })
    }
}

pub async fn send(lp: &LocalParticipant, target: &str, frame: Value) -> Result<()> {
    let payload = serde_json::to_vec(&frame)?;
    ensure!(payload.len() <= MAX_PACKET, "personal data frame too big");
    timeout(
        Duration::from_secs(2),
        lp.publish_data(DataPacket {
            payload,
            topic: Some(OUTPUT.into()),
            reliable: true,
            destination_identities: vec![target.into()],
        }),
    )
    .await??;
    Ok(())
}

#[derive(Deserialize)]
struct Request {
    recipient: String,
    id: String,
    #[serde(flatten)]
    action: Action,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Action {
    Hello,
    Text { text: String, store: bool },
    Cancel,
}

pub(crate) fn brain_route(config: &LlmConfig) -> bool {
    config.base_url.trim_end_matches('/') == "http://personal-brain:8080/v1"
        && config.model == "personal-brain"
        && config.url_query.is_empty()
}

/// 个人 Worker 的每一次语言模型请求都只能打到 personal-brain。其他 agent 保持原路由。
pub(crate) fn allow_llm_request(agent: Option<&str>, config: &LlmConfig) -> bool {
    agent != Some(AGENT) || brain_route(config)
}

pub(crate) fn llm_request_allowed(config: &LlmConfig) -> bool {
    allow_llm_request(std::env::var("AGENT_NAME").ok().as_deref(), config)
}

pub fn voice_brain(config: &LlmConfig) -> bool {
    personal_room(&config.room)
        && brain_route(config)
        && std::env::var("AGENT_NAME").is_ok_and(|v| v == AGENT)
}

fn brain_config(room: &str) -> Result<LlmConfig> {
    let mut config =
        LlmConfig::from_env().ok_or_else(|| anyhow::anyhow!("personal brain unavailable"))?;
    ensure!(brain_route(&config), "unexpected personal brain route");
    config.room = room.to_owned();
    config.strip_leading_filler = false;
    config.thinking = "off".into();
    Ok(config)
}

async fn answer(
    client: reqwest::Client,
    config: LlmConfig,
    messages: Vec<Value>,
    store: bool,
) -> Result<llm::ChatOutcome> {
    let (tx, mut rx) = mpsc::channel(32);
    let call = llm::stream_personal_text(&client, &config, messages, tx, store);
    let (reply, ()) = tokio::join!(call, async { while rx.recv().await.is_some() {} });
    reply
}

pub fn spawn(room: Arc<Room>, device: String) -> Option<OwnedTask<()>> {
    let config = match brain_config(&room.name()) {
        Ok(config) => config,
        Err(_) => {
            tracing::warn!(room = %room.name(), "personal room text unavailable: check brain route");
            return None;
        }
    };
    let events = room.subscribe();
    Some(OwnedTask::new(tokio::spawn(serve(
        room, events, device, config,
    ))))
}

async fn serve(
    room: Arc<Room>,
    mut events: mpsc::UnboundedReceiver<RoomEvent>,
    device: String,
    config: LlmConfig,
) {
    let lp = room.local_participant();
    let recipient = lp.identity().to_string();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(llm::REQUEST_TIMEOUT)
        .build()
        .expect("personal brain HTTP client");
    let mut seen = HashSet::new();
    let mut current: Option<(String, ParticipantSid, OwnedTask<Result<llm::ChatOutcome>>)> = None;
    let mut history: Vec<Value> = Vec::new();
    let mut history_mode = None;
    let mut user_msg = Value::Null;
    let mut last_text: Option<Instant> = None;
    let mut last_hello: Option<Instant> = None;
    loop {
        tokio::select! {
            biased;
            event = events.recv() => match event {
                Some(RoomEvent::DataReceived { payload, topic, kind: DataPacketKind::Reliable, participant: Some(p) })
                    if topic.as_deref() == Some(INPUT) && p.identity().as_str() == device
                    && p.kind() == ParticipantKind::Standard
                    && in_room(&room, &device, &p.sid()) && payload.len() <= MAX_PACKET =>
                {
                    let Ok(request) = serde_json::from_slice::<Request>(&payload) else { continue };
                    if request.recipient != recipient || !hex_id(&request.id) { continue; }
                    let id = request.id;
                    match request.action {
                        Action::Hello => {
                            if last_hello.is_some_and(|t| t.elapsed() < Duration::from_millis(450)) { continue; }
                            last_hello = Some(Instant::now());
                            let voice = lp.identity().as_str() != RELAY && audio_configured();
                            let _ = send(&lp, &device, json!({"type":"ready", "id":id, "voice":voice})).await;
                        }
                        Action::Cancel => {
                            if current.as_ref().is_some_and(|(running, sid, _)| running == &id && *sid == p.sid()) {
                                current.take();
                                let _ = send(&lp, &device, json!({"type":"cancelled", "id":id})).await;
                            }
                        }
                        Action::Text { text, store } => {
                            let text = text.trim();
                            if text.is_empty() || text.len() > MAX_TEXT || seen.contains(&id) { continue; }
                            if seen.len() == MAX_TURNS || current.is_some()
                                || last_text.is_some_and(|t| t.elapsed() < Duration::from_millis(500)) {
                                let _ = send(&lp, &device, json!({"type":"busy", "id":id})).await;
                                continue;
                            }
                            seen.insert(id.clone());
                            last_text = Some(Instant::now());
                            if history_mode != Some(store) {
                                history.clear();
                                history_mode = Some(store);
                            }
                            user_msg = json!({"role":"user", "content":text});
                            let mut messages = history.clone();
                            messages.push(user_msg.clone());
                            let task = tokio::spawn(answer(client.clone(), config.clone(), messages, store));
                            current = Some((id, p.sid(), OwnedTask::new(task)));
                        }
                    }
                }
                Some(RoomEvent::ParticipantDisconnected(p)) => {
                    if p.identity().as_str() == device {
                        history.clear();
                        if current.as_ref().is_some_and(|(_, sid, _)| *sid == p.sid()) { current.take(); }
                    }
                }
                Some(RoomEvent::Disconnected { .. }) | None => break,
                _ => {}
            },
            result = async { (&mut current.as_mut().unwrap().2).await }, if current.is_some() => {
                let (id, sid, _) = current.take().unwrap();
                if !in_room(&room, &device, &sid) { continue; }
                let frame = match result {
                    Ok(Ok(outcome)) if !outcome.full.trim().is_empty() && outcome.done => {
                        let mut text: String = outcome.full.chars().take(1800).collect();
                        while serde_json::to_vec(&text).is_ok_and(|payload| payload.len() > 7000) {
                            text.pop();
                        }
                        if history.len() == 8 { history.drain(..2); }
                        history.push(std::mem::take(&mut user_msg));
                        history.push(json!({"role":"assistant", "content":text}));
                        json!({"type":"text_result", "id":id, "text":text, "metadata":outcome.personal})
                    }
                    _ => json!({"type":"error", "id":id}),
                };
                let _ = send(&lp, &device, frame).await;
            }
        }
    }
}

pub fn in_room(room: &Room, device: &str, sid: &ParticipantSid) -> bool {
    room.remote_participants()
        .get(&ParticipantIdentity::from(device))
        .is_some_and(|p| p.sid() == *sid)
}

// Temporary data-only participant. Uses the existing ListRooms grant on the NAS;
// each RTC ticket is limited to data publication in one personal room.
pub async fn relay(config: Config) -> Result<()> {
    ensure!(
        config.agent_name == AGENT,
        "relay requires the personal agent configuration"
    );
    brain_config("")?;
    let url = reqwest::Url::parse(&config.ws_url)?;
    ensure!(
        url.scheme() == "wss" && url.path() == "/" && url.query().is_none(),
        "relay requires a WSS origin"
    );
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()?;
    let endpoint = format!(
        "{}/twirp/livekit.RoomService/ListRooms",
        config
            .ws_url
            .trim_end_matches('/')
            .replacen("wss:", "https:", 1)
    );
    let mut rooms: HashMap<String, OwnedTask<()>> = HashMap::new();
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tracing::info!("personal text relay started");
    loop {
        interval.tick().await;
        rooms.retain(|_, task| !task.is_finished());
        let token = crate::token::room_list_jwt(&config.api_key, &config.api_secret)?;
        let listed = async {
            Ok::<Value, reqwest::Error>(
                http.post(&endpoint)
                    .bearer_auth(token)
                    .json(&json!({}))
                    .send()
                    .await?
                    .error_for_status()?
                    .json()
                    .await?,
            )
        }
        .await;
        let Ok(listed) = listed else {
            tracing::warn!("personal text relay could not list rooms");
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        };
        for room in listed["rooms"].as_array().into_iter().flatten() {
            if rooms.len() >= 4 {
                break;
            }
            let (Some(name), Some(sid)) = (room["name"].as_str(), room["sid"].as_str()) else {
                continue;
            };
            let count = room["numParticipants"]
                .as_u64()
                .or_else(|| room["num_participants"].as_u64())
                .unwrap_or(0);
            if !personal_room(name) || count == 0 || rooms.contains_key(name) {
                continue;
            }
            let join =
                crate::token::personal_relay_jwt(&config.api_key, &config.api_secret, name, RELAY)?;
            let url = config.ws_url.clone();
            let sid = sid.to_owned();
            let task = tokio::spawn(async move {
                if let Err(err) = relay_room(&url, &join, &sid).await {
                    tracing::warn!(reason = %err, "personal text relay room ended");
                }
            });
            rooms.insert(name.into(), OwnedTask::new(task));
        }
    }
}

async fn relay_room(url: &str, token: &str, sid: &str) -> Result<()> {
    let mut options = RoomOptions::default();
    options.auto_subscribe = false;
    let (room, _) = timeout(Duration::from_secs(8), Room::connect(url, token, options)).await??;
    let room = Arc::new(room);
    if room.sid().await.as_str() == sid {
        let devices: Vec<_> = room
            .remote_participants()
            .keys()
            .filter(|id| device_identity(id.as_str()))
            .cloned()
            .collect();
        if let [device] = devices.as_slice()
            && let Some(mut text) = spawn(room.clone(), device.to_string())
        {
            loop {
                tokio::select! {
                    _ = &mut text => break,
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {
                        if !room.remote_participants().contains_key(device) { break; }
                    }
                }
            }
        }
    }
    let _ = timeout(Duration::from_secs(3), room.close()).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_stops_only_on_an_explicit_request() {
        let words = stop_words();
        for text in ["退出。", "嗯，退出吧", "先停一下", "小可，退出"] {
            assert!(crate::textproc::is_stop_only(&words, text), "{text}");
        }
        for text in ["不要退出", "退出是什么意思", "晚安", "我要睡觉了", "先停一下，现在北京时间几点"] {
            assert!(!crate::textproc::is_stop_only(&words, text), "{text}");
        }
    }

    #[test]
    fn personal_worker_rejects_vendor_llm_endpoint() {
        let brain = LlmConfig {
            base_url: "http://personal-brain:8080/v1".into(),
            api_key: "brain-auth".into(),
            model: "personal-brain".into(),
            instructions: String::new(),
            thinking: "off".into(),
            strip_leading_filler: false,
            url_query: String::new(),
            room: "pv-0123456789abcdef0123456789abcdef".into(),
        };
        assert!(allow_llm_request(Some(AGENT), &brain));
        assert!(brain_route(&brain));
        let mut vendor = brain.clone();
        vendor.base_url = "https://api.deepseek.com".into();
        vendor.model = "deepseek-v4".into();
        assert!(!allow_llm_request(Some(AGENT), &vendor));
        assert!(allow_llm_request(Some("voice-worker-rust"), &vendor));
        vendor.base_url = "http://personal-brain:8080/v1".into();
        vendor.model = "personal-brain".into();
        vendor.url_query = "token=forward".into();
        assert!(!allow_llm_request(Some(AGENT), &vendor));
    }

    #[test]
    fn binding_requires_personal_dispatch_and_signed_ticket_shape() {
        let room = "pv-1234567890abcdef1234567890abcdef";
        let meta = r#"{"owner_id":"owner","device_id":"test-1"}"#;
        assert_eq!(
            assigned_device(AGENT, room, meta).as_deref(),
            Some("personal:owner:test-1")
        );
        assert!(assigned_device("voice-worker-rust", room, meta).is_none());
        assert!(assigned_device(AGENT, room, r#"{"owner_id":"other","device_id":"test-1"}"#).is_none());
        assert!(!device_identity("personal:other:test-1"));
        assert!(assigned_device(AGENT, "pv-other", meta).is_none());
        assert!(
            assigned_device(
                AGENT,
                room,
                r#"{"owner_id":"owner","device_id":"bad:device"}"#
            )
            .is_none()
        );
    }

    #[test]
    fn filters_links_and_preserves_valid_sources() {
        let metadata = Metadata::from_final(&json!({"tool":"search", "sources":[
            {"url":"javascript:alert(1)"},
            {"url":"https://name:pass@example.org"},
            {"url":"https://www.python.org/downloads/", "title":"Python", "date":null},
            {"url":"https://www.python.org/downloads/"}
        ]}))
        .unwrap();
        assert_eq!(metadata.tool.as_deref(), Some("search"));
        assert_eq!(metadata.sources.len(), 1);
        assert_eq!(metadata.sources[0].title, "Python");
    }
}
