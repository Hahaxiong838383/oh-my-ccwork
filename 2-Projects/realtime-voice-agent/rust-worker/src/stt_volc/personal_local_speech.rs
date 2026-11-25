//! 个人模式可选的飞牛本地中文语音。只在 AGENT_NAME 是个人助手且
//! PERSONAL_LOCAL_SPEECH_URL 指向私网 HTTP 时启用。未设置时调用方走原路径。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{info, warn};

pub const PILOT_PROVIDER: &str = "personal-local-pilot";
pub const PILOT_VOICE: &str = "piper-zh-huayan-medium";

pub fn endpoint() -> Option<String> {
    let raw = std::env::var("PERSONAL_LOCAL_SPEECH_URL").ok();
    let agent = std::env::var("AGENT_NAME").ok();
    match endpoint_from(raw.as_deref(), agent.as_deref()) {
        Some(url) => Some(url),
        None if raw.as_deref().is_some_and(|value| !value.trim().is_empty()) => {
            if agent.as_deref() != Some(crate::personal::AGENT) {
                warn_once(&AGENT_WARNED, "PERSONAL_LOCAL_SPEECH_URL ignored: agent is not personal");
            } else {
                warn_once(&URL_WARNED, "PERSONAL_LOCAL_SPEECH_URL ignored: endpoint is not private http");
            }
            None
        }
        None => None,
    }
}

pub fn endpoint_from(url: Option<&str>, agent: Option<&str>) -> Option<String> {
    let url = url.map(str::trim).filter(|value| !value.is_empty())?;
    if agent != Some(crate::personal::AGENT) || !private_http(url) {
        return None;
    }
    Some(url.trim_end_matches('/').to_string())
}

pub async fn prewarm(base: &str) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(3)).build() {
        Ok(client) => client,
        Err(error) => {
            warn!(%error, "personal local speech prewarm client");
            return;
        }
    };
    match client.get(format!("{base}/health")).send().await {
        Ok(response) if response.status().is_success() => {
            info!(provider = PILOT_PROVIDER, voice = PILOT_VOICE, "personal local speech pilot ready");
        }
        Ok(response) => warn!(status = %response.status(), "personal local speech health"),
        Err(error) => warn!(%error, "personal local speech health"),
    }
}

pub async fn synthesize(
    base: &str,
    text: &str,
    audio_tx: &mpsc::Sender<Vec<u8>>,
) -> Result<(u64, usize)> {
    let started = std::time::Instant::now();
    let text = text.trim();
    if text.is_empty() {
        return Ok((0, 0));
    }
    info!(provider = PILOT_PROVIDER, voice = PILOT_VOICE, chars = text.chars().count(), "personal local tts");
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(25)).build()?;
    let response = client
        .post(format!("{base}/v1/tts"))
        .json(&serde_json::json!({"text": text}))
        .send()
        .await
        .context("personal local tts")?;
    if !response.status().is_success() {
        bail!("personal local tts status {}", response.status());
    }
    let rate = response
        .headers()
        .get("x-sample-rate")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    if rate != 24_000 {
        bail!("personal local tts sample rate {rate}");
    }
    let body = response.bytes().await.context("personal local tts body")?;
    if body.is_empty() || body.len() > 4_000_000 || !nonzero_pcm(&body) {
        bail!("personal local tts audio size {}", body.len());
    }
    let mut sent = 0usize;
    for chunk in body.chunks(4800) {
        if audio_tx.send(chunk.to_vec()).await.is_err() {
            break;
        }
        sent += chunk.len();
    }
    Ok((started.elapsed().as_millis() as u64, sent))
}

pub async fn run_asr(
    base: &str,
    pcm_rx: &mut mpsc::Receiver<Vec<i16>>,
    event_tx: mpsc::Sender<super::SttEvent>,
) -> Result<super::AsrEnd> {
    if event_tx.is_closed() {
        return Ok(super::AsrEnd::Unused);
    }
    info!(provider = PILOT_PROVIDER, "personal local speech pilot asr");
    let connect = tokio_tungstenite::connect_async(ws_url(base));
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), connect)
        .await
        .context("personal local asr connect timeout")?
        .context("personal local asr connect")?;
    let mut ending = false;
    loop {
        if event_tx.is_closed() {
            return Ok(super::AsrEnd::Unused);
        }
        tokio::select! {
            chunk = pcm_rx.recv(), if !ending => {
                match chunk {
                    Some(pcm) => {
                        let mut bytes = Vec::with_capacity(pcm.len() * 2);
                        for sample in pcm {
                            bytes.extend_from_slice(&sample.to_le_bytes());
                        }
                        socket.send(WsMessage::Binary(bytes.into())).await?;
                    }
                    None => {
                        socket.send(WsMessage::Text(r#"{"event":"end"}"#.to_owned().into())).await?;
                        ending = true;
                    }
                }
            }
            message = socket.next() => {
                match message {
                    None => return Ok(if ending { super::AsrEnd::InputDone } else { super::AsrEnd::ServerClosed }),
                    Some(Err(error)) => return Err(error.into()),
                    Some(Ok(WsMessage::Text(text))) => {
                        if handle_text(text.as_str(), &event_tx).await? && ending {
                            return Ok(super::AsrEnd::InputDone);
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) => {
                        return Ok(if ending { super::AsrEnd::InputDone } else { super::AsrEnd::ServerClosed });
                    }
                    Some(Ok(_)) => {}
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(20)), if ending => {
                bail!("personal local asr flush timeout");
            }
        }
    }
}

async fn handle_text(text: &str, event_tx: &mpsc::Sender<super::SttEvent>) -> Result<bool> {
    let value: serde_json::Value = serde_json::from_str(text).context("personal local asr event")?;
    let transcript = value.get("text").and_then(|item| item.as_str()).unwrap_or("").trim();
    match value.get("type").and_then(|item| item.as_str()) {
        Some("interim") if !transcript.is_empty() => {
            if event_tx.send(super::SttEvent::Interim(transcript.to_string())).await.is_err() {
                return Ok(true);
            }
            Ok(false)
        }
        Some("final") => {
            if !transcript.is_empty()
                && event_tx.send(super::SttEvent::Final(transcript.to_string())).await.is_err()
            {
                return Ok(true);
            }
            Ok(true)
        }
        Some("error") => {
            let reason = value.get("error").and_then(|item| item.as_str()).unwrap_or("local asr error");
            bail!("{reason}");
        }
        _ => Ok(false),
    }
}

fn ws_url(base: &str) -> String {
    let http = format!("{}/v1/asr", base.trim_end_matches('/'));
    if let Some(rest) = http.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = http.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        http
    }
}

fn nonzero_pcm(body: &[u8]) -> bool {
    body.chunks(2).any(|sample| sample.len() == 2 && sample != [0, 0])
}

fn private_http(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    if url.query().is_some() || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    url.host_str().is_some_and(private_host)
}

fn private_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        let [first, second, _, _] = ip.octets();
        return ip.is_loopback() || first == 10 || (first == 172 && (16..=31).contains(&second)) || (first == 192 && second == 168);
    }
    !host.is_empty()
        && !host.contains('.')
        && host.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn warn_once(slot: &'static AtomicBool, message: &'static str) {
    if !slot.swap(true, Ordering::Relaxed) {
        warn!("{message}");
    }
}

static AGENT_WARNED: AtomicBool = AtomicBool::new(false);
static URL_WARNED: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
mod tests {
    use super::endpoint_from;

    #[test]
    fn only_private_personal_url_is_enabled() {
        let agent = crate::personal::AGENT;
        assert!(endpoint_from(None, Some(agent)).is_none());
        assert!(endpoint_from(Some("http://personal-local-speech:8091"), Some("p003")).is_none());
        assert!(endpoint_from(Some("https://example.com/speech"), Some(agent)).is_none());
        assert!(endpoint_from(Some("http://user:secret@personal-local-speech:8091"), Some(agent)).is_none());
        assert_eq!(
            endpoint_from(Some("http://personal-local-speech:8091/"), Some(agent)).as_deref(),
            Some("http://personal-local-speech:8091")
        );
        assert_eq!(
            endpoint_from(Some("http://192.168.1.115:18091"), Some(agent)).as_deref(),
            Some("http://192.168.1.115:18091")
        );
    }
}
