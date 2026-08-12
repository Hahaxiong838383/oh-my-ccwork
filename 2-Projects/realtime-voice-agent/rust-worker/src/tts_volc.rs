//! 火山双向流式 TTS 客户端(每句一连,行为对齐 doubao_speech.tts_stream 事件舞步):
//! StartConnection→ConnectionStarted→StartSession→SessionStarted→TaskRequest(text)
//! →FinishSession→收 AudioOnlyServer(pcm 24k)直到 TTSEnded/SessionFinished。
//! 连接池复用(SessionFinished 才回池铁律)= P3b。

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{info, warn};

use crate::volc::{event, Flags, Frame, MsgType, TTS_URL};

pub const TTS_SAMPLE_RATE: u32 = 24_000;

#[derive(Clone)]
pub struct TtsConfig {
    pub app_id: String,
    pub access_token: String,
    pub resource_id: String,
    pub speaker: String,
    pub speed_ratio: f32,
}

impl TtsConfig {
    pub fn from_env() -> Self {
        Self {
            app_id: std::env::var("VOLC_APP_ID").unwrap_or_default(),
            access_token: std::env::var("VOLC_ACCESS_TOKEN").unwrap_or_default(),
            resource_id: std::env::var("VOLC_TTS_RESOURCE_ID")
                .unwrap_or_else(|_| "seed-tts-2.0".into()),
            speaker: std::env::var("VOLC_TTS_SPEAKER")
                .unwrap_or_else(|_| "zh_female_vv_uranus_bigtts".into()),
            speed_ratio: std::env::var("VOLC_TTS_SPEED")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1.0),
        }
    }
}

/// 合成一句:PCM(24k i16le bytes)分块经 `audio_tx` 发出。返回 (ttfb_ms, total_bytes)。
pub async fn synthesize(
    cfg: &TtsConfig,
    text: &str,
    audio_tx: &mpsc::Sender<Vec<u8>>,
) -> Result<(u64, usize)> {
    info!("tts synth: {text}"); // 证据日志,对齐 Python 版
    let t0 = std::time::Instant::now();
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut req = TTS_URL.into_client_request()?;
    {
        let h = req.headers_mut();
        h.insert("X-Api-App-Id", cfg.app_id.parse()?);
        h.insert("X-Api-App-Key", cfg.app_id.parse()?);
        h.insert("X-Api-Access-Key", cfg.access_token.parse()?);
        h.insert("X-Api-Resource-Id", cfg.resource_id.parse()?);
        h.insert("X-Api-Request-Id", request_id.parse()?);
        h.insert("X-Api-Connect-Id", uuid::Uuid::new_v4().to_string().parse()?);
    }
    let (ws, _) = tokio_tungstenite::connect_async(req).await.context("tts connect")?;
    let (mut tx, mut rx) = ws.split();

    // speed_ratio 乘数 → speech_rate 整数百分比增量 [-50,100]
    let speech_rate = (((cfg.speed_ratio - 1.0) * 100.0).round() as i32).clamp(-50, 100);
    let req_params = json!({
        "speaker": cfg.speaker,
        "audio_params": {"format": "pcm", "sample_rate": TTS_SAMPLE_RATE, "speech_rate": speech_rate},
    });
    let base = json!({
        "user": {"uid": request_id},
        "namespace": "BidirectionalTTS",
        "req_params": req_params,
    });
    let session_id = uuid::Uuid::new_v4().to_string();

    let send_event = |ev: i32, sid: &str, payload: Vec<u8>| Frame {
        msg_type: MsgType::FullClientRequest,
        flag: Flags::WithEvent,
        event: ev,
        session_id: sid.to_string(),
        payload,
        ..Default::default()
    };

    // 1. StartConnection → ConnectionStarted
    tx.send(WsMessage::Binary(
        send_event(event::START_CONNECTION, "", b"{}".to_vec()).marshal().into(),
    ))
    .await?;
    expect_event(&mut rx, event::CONNECTION_STARTED).await?;

    // 2. StartSession → SessionStarted
    let mut start_payload = base.clone();
    start_payload["event"] = json!(event::START_SESSION);
    tx.send(WsMessage::Binary(
        send_event(event::START_SESSION, &session_id, start_payload.to_string().into_bytes())
            .marshal()
            .into(),
    ))
    .await?;
    expect_event(&mut rx, event::SESSION_STARTED).await?;

    // 3. TaskRequest(带 text) + 立即 FinishSession(告知无更多文本)
    let mut task_payload = base.clone();
    task_payload["event"] = json!(event::TASK_REQUEST);
    task_payload["req_params"]["text"] = json!(text);
    tx.send(WsMessage::Binary(
        send_event(event::TASK_REQUEST, &session_id, task_payload.to_string().into_bytes())
            .marshal()
            .into(),
    ))
    .await?;
    tx.send(WsMessage::Binary(
        send_event(event::FINISH_SESSION, &session_id, b"{}".to_vec()).marshal().into(),
    ))
    .await?;

    // 4. 收音频直到 TTSEnded/SessionFinished
    let mut ttfb_ms: Option<u64> = None;
    let mut total = 0usize;
    let mut session_done = false;
    loop {
        let frame = recv_frame(&mut rx).await?;
        match frame.msg_type {
            MsgType::AudioOnlyServer => {
                if !frame.payload.is_empty() {
                    if ttfb_ms.is_none() {
                        ttfb_ms = Some(t0.elapsed().as_millis() as u64);
                    }
                    total += frame.payload.len();
                    if audio_tx.send(frame.payload).await.is_err() {
                        // 下游关闭=被打断:直接断连(取消的连接不复用,对齐池铁律)
                        warn!("tts consumer gone (interrupted), dropping connection");
                        return Ok((ttfb_ms.unwrap_or(0), total));
                    }
                }
            }
            MsgType::FullServerResponse => match frame.event {
                event::TTS_ENDED => break,
                event::SESSION_FINISHED => {
                    session_done = true;
                    break;
                }
                event::SESSION_FAILED => {
                    bail!(
                        "tts session failed: {}",
                        String::from_utf8_lossy(&frame.payload).chars().take(200).collect::<String>()
                    );
                }
                _ => {}
            },
            MsgType::Error => {
                bail!("tts error code={}", frame.error_code);
            }
            _ => {}
        }
    }

    // 5. 收尾(尽力而为,不阻塞回复链)
    if !session_done {
        let _ = tx
            .send(WsMessage::Binary(
                send_event(event::FINISH_SESSION, &session_id, b"{}".to_vec()).marshal().into(),
            ))
            .await;
    }
    let _ = tx
        .send(WsMessage::Binary(
            send_event(event::FINISH_CONNECTION, "", b"{}".to_vec()).marshal().into(),
        ))
        .await;
    Ok((ttfb_ms.unwrap_or(0), total))
}

async fn recv_frame(
    rx: &mut (impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> Result<Frame> {
    loop {
        match rx.next().await {
            Some(Ok(WsMessage::Binary(data))) => return Frame::unmarshal(&data),
            Some(Ok(WsMessage::Close(f))) => bail!("tts ws closed: {f:?}"),
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(e.into()),
            None => bail!("tts ws ended unexpectedly"),
        }
    }
}

async fn expect_event(
    rx: &mut (impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin),
    expected: i32,
) -> Result<()> {
    let frame = recv_frame(rx).await?;
    if frame.event != expected {
        bail!(
            "tts expected event {expected}, got {} payload={}",
            frame.event,
            String::from_utf8_lossy(&frame.payload).chars().take(200).collect::<String>()
        );
    }
    Ok(())
}
