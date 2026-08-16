//! 火山双向流式 TTS 客户端 + 连接池(行为对齐 volc_tts.py + _volc_tts_pool.py R3b):
//!
//! 事件舞步:StartConnection→ConnectionStarted(连接级,一次)→ 每句
//! StartSession→SessionStarted→TaskRequest(text)→FinishSession→AudioOnlyServer…
//! →SessionFinished(不发 FinishConnection,连接回池)。
//! **复用铁律:收到 SessionFinished 才算干净可回池**;打断弃流/协议错/超时 → 连接
//! 内有残留帧,标 dead 丢弃。池路径异常 → 降级一次性连接保可用;TTS_POOL_ENABLED=0
//! 整体关闭。闲置被服务端断开靠"用时检测+丢弃重建"兜底(Python 同款)。

use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tracing::{info, warn};

use crate::volc::{event, Flags, Frame, MsgType, TTS_URL};

pub const TTS_SAMPLE_RATE: u32 = 24_000;
const POOL_MAX: usize = 4;
const RECV_TIMEOUT: Duration = Duration::from_secs(30);

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone)]
pub struct TtsConfig {
    pub app_id: String,
    pub access_token: String,
    pub resource_id: String,
    pub speaker: String,
    pub speed_ratio: f32,
    pub pool_enabled: bool,
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
            pool_enabled: std::env::var("TTS_POOL_ENABLED").map(|v| v == "1").unwrap_or(true),
        }
    }
}

pub struct TtsConn {
    ws: Ws,
}

/// 进程级连接池(跨 job 复用,凭据单一;随进程退出释放)。
static POOL: Mutex<Vec<TtsConn>> = Mutex::const_new(Vec::new());

fn event_frame(ev: i32, sid: &str, payload: Vec<u8>) -> Frame {
    Frame {
        msg_type: MsgType::FullClientRequest,
        flag: Flags::WithEvent,
        event: ev,
        session_id: sid.to_string(),
        payload,
        ..Default::default()
    }
}

impl TtsConn {
    /// 新建连接并完成 StartConnection 握手。
    pub async fn connect(cfg: &TtsConfig) -> Result<Self> {
        let mut req = TTS_URL.into_client_request()?;
        {
            let h = req.headers_mut();
            h.insert("X-Api-App-Id", cfg.app_id.parse()?);
            h.insert("X-Api-App-Key", cfg.app_id.parse()?);
            h.insert("X-Api-Access-Key", cfg.access_token.parse()?);
            h.insert("X-Api-Resource-Id", cfg.resource_id.parse()?);
            h.insert("X-Api-Request-Id", uuid::Uuid::new_v4().to_string().parse()?);
            h.insert("X-Api-Connect-Id", uuid::Uuid::new_v4().to_string().parse()?);
        }
        let (mut ws, _) =
            tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(req))
                .await
                .context("tts connect timeout")?
                .context("tts connect")?;
        ws.send(WsMessage::Binary(
            event_frame(event::START_CONNECTION, "", b"{}".to_vec()).marshal().into(),
        ))
        .await?;
        let mut conn = Self { ws };
        let frame = conn.recv().await?;
        if frame.event != event::CONNECTION_STARTED {
            bail!("tts expected ConnectionStarted, got event {}", frame.event);
        }
        Ok(conn)
    }

    async fn recv(&mut self) -> Result<Frame> {
        loop {
            let msg = tokio::time::timeout(RECV_TIMEOUT, self.ws.next())
                .await
                .context("tts recv timeout")?;
            match msg {
                Some(Ok(WsMessage::Binary(data))) => return Frame::unmarshal(&data),
                Some(Ok(WsMessage::Close(f))) => bail!("tts ws closed: {f:?}"),
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(e.into()),
                None => bail!("tts ws ended unexpectedly"),
            }
        }
    }

    /// 在既有连接上跑一个完整 session。返回 (ttfb_ms, bytes, clean);
    /// clean=false(打断弃流/未收 SessionFinished)→ 调用方按铁律丢弃连接。
    async fn run_session(
        &mut self,
        cfg: &TtsConfig,
        text: &str,
        audio_tx: &mpsc::Sender<Vec<u8>>,
    ) -> Result<(u64, usize, bool)> {
        let t0 = std::time::Instant::now();
        let session_id = uuid::Uuid::new_v4().to_string();
        // speed_ratio 乘数 → speech_rate 整数百分比增量 [-50,100]
        let speech_rate = (((cfg.speed_ratio - 1.0) * 100.0).round() as i32).clamp(-50, 100);
        let req_params = json!({
            "speaker": cfg.speaker,
            "audio_params": {"format": "pcm", "sample_rate": TTS_SAMPLE_RATE, "speech_rate": speech_rate},
        });
        let base = json!({
            "user": {"uid": session_id},
            "namespace": "BidirectionalTTS",
            "req_params": req_params,
        });

        let mut start_payload = base.clone();
        start_payload["event"] = json!(event::START_SESSION);
        self.ws
            .send(WsMessage::Binary(
                event_frame(event::START_SESSION, &session_id, start_payload.to_string().into_bytes())
                    .marshal()
                    .into(),
            ))
            .await?;
        let frame = self.recv().await?;
        if frame.event != event::SESSION_STARTED {
            bail!("tts expected SessionStarted, got event {}", frame.event);
        }

        let mut task_payload = base.clone();
        task_payload["event"] = json!(event::TASK_REQUEST);
        task_payload["req_params"]["text"] = json!(text);
        self.ws
            .send(WsMessage::Binary(
                event_frame(event::TASK_REQUEST, &session_id, task_payload.to_string().into_bytes())
                    .marshal()
                    .into(),
            ))
            .await?;
        self.ws
            .send(WsMessage::Binary(
                event_frame(event::FINISH_SESSION, &session_id, b"{}".to_vec()).marshal().into(),
            ))
            .await?;

        // 收音频;必须收到 SessionFinished 才算干净(TTSEnded 后继续等收尾帧)
        let mut ttfb_ms: Option<u64> = None;
        let mut total = 0usize;
        loop {
            let frame = self.recv().await?;
            match frame.msg_type {
                MsgType::AudioOnlyServer => {
                    if !frame.payload.is_empty() {
                        if ttfb_ms.is_none() {
                            ttfb_ms = Some(t0.elapsed().as_millis() as u64);
                        }
                        total += frame.payload.len();
                        if audio_tx.send(frame.payload).await.is_err() {
                            // 下游关闭=被打断:连接内有残留帧,不可复用(池铁律)
                            warn!("tts consumer gone (interrupted), dropping connection");
                            return Ok((ttfb_ms.unwrap_or(0), total, false));
                        }
                    }
                }
                MsgType::FullServerResponse => match frame.event {
                    event::SESSION_FINISHED => return Ok((ttfb_ms.unwrap_or(0), total, true)),
                    event::TTS_ENDED => continue, // 等 SessionFinished 收尾
                    event::SESSION_FAILED => bail!(
                        "tts session failed: {}",
                        String::from_utf8_lossy(&frame.payload).chars().take(200).collect::<String>()
                    ),
                    _ => {}
                },
                MsgType::Error => bail!("tts error code={}", frame.error_code),
                _ => {}
            }
        }
    }

    async fn close(mut self) {
        let _ = self
            .ws
            .send(WsMessage::Binary(
                event_frame(event::FINISH_CONNECTION, "", b"{}".to_vec()).marshal().into(),
            ))
            .await;
        let _ = self.ws.close(None).await;
    }
}

async fn pool_acquire(cfg: &TtsConfig) -> Result<TtsConn> {
    if let Some(conn) = POOL.lock().await.pop() {
        return Ok(conn);
    }
    TtsConn::connect(cfg).await
}

async fn pool_release(conn: TtsConn) {
    let mut pool = POOL.lock().await;
    if pool.len() < POOL_MAX {
        pool.push(conn);
    } else {
        drop(pool);
        conn.close().await;
    }
}

/// job 启动时预建连接(藏进用户说首句的窗口,首句 TTS 零建连)。静默失败。
pub async fn prewarm_pool(cfg: &TtsConfig) {
    if !cfg.pool_enabled {
        return;
    }
    match TtsConn::connect(cfg).await {
        Ok(conn) => {
            pool_release(conn).await;
            info!("tts pool: prewarmed 1 connection");
        }
        Err(e) => warn!(error = %e, "tts pool: prewarm failed(首句现场建连,不影响可用)"),
    }
}

/// 合成一句:PCM(24k i16le bytes)分块经 `audio_tx` 发出。返回 (ttfb_ms, total_bytes)。
/// 池路径异常 → 降级一次性连接重试一次(对齐 volc_tts.py 降级语义)。
pub async fn synthesize(
    cfg: &TtsConfig,
    text: &str,
    audio_tx: &mpsc::Sender<Vec<u8>>,
) -> Result<(u64, usize)> {
    // 证据日志:只落前 24 字+字数,不落全文(S2B1 canary 合同:完整文本不得进 journal;
    // 生产回复同策——排障按开头辨认句子,运维仍按 "tts synth" 关键词捞两条线)
    let head: String = text.chars().take(24).collect();
    info!("tts synth: {head}…({}字)", text.chars().count());
    if cfg.pool_enabled {
        match pool_acquire(cfg).await {
            Ok(mut conn) => match conn.run_session(cfg, text, audio_tx).await {
                Ok((ttfb, bytes, clean)) => {
                    if clean {
                        pool_release(conn).await;
                    } else {
                        conn.close().await; // 打断弃流:残留帧污染,不回池
                    }
                    return Ok((ttfb, bytes));
                }
                Err(e) => {
                    conn.close().await;
                    warn!(error = %e, "tts pool 路径失败,本句降级一次性连接");
                }
            },
            Err(e) => warn!(error = %e, "tts pool 建连失败,本句降级一次性连接"),
        }
    }
    // 一次性连接(池关闭/池路径降级)
    let mut conn = TtsConn::connect(cfg).await?;
    let out = conn.run_session(cfg, text, audio_tx).await;
    conn.close().await;
    let (ttfb, bytes, _clean) = out?;
    Ok((ttfb, bytes))
}
