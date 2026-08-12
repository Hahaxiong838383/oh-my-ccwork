//! 火山流式 ASR 客户端(长连,行为对齐 volc_stt.py + _volc_asr.py):
//! init(gzip JSON,注入 end_window_size 判停窗)→ AudioOnlyClient 逐段 gzip PCM;
//! 响应按 utterances[].definite 逐句发 Final(证据日志 `stt final: <text>`),
//! 尾句非 definite 发 Interim。S1 投机/B5 interim 提交 = P3b。

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{info, warn};

use crate::volc::{gzip, Flags, Frame, MsgType, ASR_URL, COMP_GZIP, SER_JSON};

#[derive(Debug, Clone)]
pub enum SttEvent {
    Interim(String),
    Final(String),
    Closed,
}

#[derive(Clone)]
pub struct SttConfig {
    pub app_id: String,
    pub access_token: String,
    pub api_key: Option<String>,
    pub resource_id: String,
    pub end_window_ms: u32,
    pub enable_ddc: bool,
    /// preflight 开(生产默认)→ 转写全走 canonical(去标点,S1 投机命中的前提);
    /// 关 → 原样 trim(火山原始带标点行为)。对齐 volc_stt._canon。
    pub canon: bool,
}

impl SttConfig {
    pub fn from_env() -> Self {
        Self {
            app_id: std::env::var("VOLC_APP_ID").unwrap_or_default(),
            access_token: std::env::var("VOLC_ACCESS_TOKEN").unwrap_or_default(),
            api_key: std::env::var("VOLC_ASR_API_KEY").ok().filter(|s| !s.is_empty()),
            resource_id: std::env::var("VOLC_ASR_RESOURCE_ID")
                .unwrap_or_else(|_| "volc.bigasr.sauc.duration".into()),
            end_window_ms: std::env::var("VOLC_ASR_END_WINDOW_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(800),
            enable_ddc: std::env::var("VOLC_ASR_ENABLE_DDC").map(|v| v == "1").unwrap_or(true),
            canon: std::env::var("VOLC_PREFLIGHT_ENABLED").map(|v| v == "1").unwrap_or(true),
        }
    }
}

/// 一条 ASR 连接的结束方式(重连决策依据,Closed 事件由外层重连循环统一发)。
#[derive(Debug, PartialEq, Eq)]
pub enum AsrEnd {
    /// 输入结束且服务端 LastNoSeq 收尾——正常终局,不重连。
    InputDone,
    /// 服务端中途断开——外层重连(改进项:Python 版此处直接死流)。
    ServerClosed,
}

/// 起一条 ASR 长连:`pcm_rx` 收 16k i16 PCM 段,事件从 `event_tx` 发出。
/// pcm_rx 关闭 → 发尾段(NegativeSeq)收流。借用 receiver 以支持外层断线重连复用。
pub async fn run_asr_stream(
    cfg: SttConfig,
    pcm_rx: &mut mpsc::Receiver<Vec<i16>>,
    event_tx: mpsc::Sender<SttEvent>,
) -> Result<AsrEnd> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut req = ASR_URL.into_client_request()?;
    {
        let h = req.headers_mut();
        if let Some(key) = &cfg.api_key {
            // seedasr 2.0 单 key 鉴权(旧版组合对 seedasr 报 resourceId not allowed)
            h.insert("X-Api-Key", key.parse()?);
        } else {
            h.insert("X-Api-App-Id", cfg.app_id.parse()?);
            h.insert("X-Api-App-Key", cfg.app_id.parse()?);
            h.insert("X-Api-Access-Key", cfg.access_token.parse()?);
        }
        h.insert("X-Api-Resource-Id", cfg.resource_id.parse()?);
        h.insert("X-Api-Request-Id", request_id.parse()?);
        h.insert("X-Api-Connect-Id", uuid::Uuid::new_v4().to_string().parse()?);
    }
    let (ws, _) = tokio_tungstenite::connect_async(req).await.context("asr connect")?;
    let (mut tx, mut rx) = ws.split();
    info!(end_window_ms = cfg.end_window_ms, "asr: connected (seedasr bigmodel)");

    let init_payload = json!({
        "user": {"uid": request_id},
        "audio": {"format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1},
        "request": {
            "model_name": "bigmodel",
            "enable_itn": true,
            "enable_punc": true,
            "enable_ddc": cfg.enable_ddc,
            "show_utterances": true,
            "enable_nonstream": false,
            "end_window_size": cfg.end_window_ms,
        },
    });
    let mut seq: i32 = 1;
    let init = Frame {
        msg_type: MsgType::FullClientRequest,
        flag: Flags::PositiveSeq,
        serialization: SER_JSON,
        compression: COMP_GZIP,
        sequence: seq,
        payload: gzip(init_payload.to_string().as_bytes()),
        ..Default::default()
    };
    tx.send(WsMessage::Binary(init.marshal().into())).await?;

    // 已发 Final 的句子游标:utterances 是全量数组,靠计数防重发
    let mut finals_emitted = 0usize;
    let mut input_done = false;

    loop {
        tokio::select! {
            pcm = pcm_rx.recv(), if !input_done => match pcm {
                Some(samples) => {
                    seq += 1;
                    let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
                    let frame = Frame {
                        msg_type: MsgType::AudioOnlyClient,
                        flag: Flags::PositiveSeq,
                        serialization: SER_JSON,
                        compression: COMP_GZIP,
                        sequence: seq,
                        payload: gzip(&bytes),
                        ..Default::default()
                    };
                    tx.send(WsMessage::Binary(frame.marshal().into())).await?;
                }
                None => {
                    // 输入结束:空尾段 NegativeSeq 收流,之后只等服务端 LastNoSeq
                    input_done = true;
                    seq += 1;
                    let last = Frame {
                        msg_type: MsgType::AudioOnlyClient,
                        flag: Flags::NegativeSeq,
                        serialization: SER_JSON,
                        compression: COMP_GZIP,
                        sequence: -seq,
                        payload: gzip(b""),
                        ..Default::default()
                    };
                    tx.send(WsMessage::Binary(last.marshal().into())).await?;
                }
            },
            msg = rx.next() => match msg {
                Some(Ok(WsMessage::Binary(data))) => {
                    let frame = Frame::unmarshal(&data)?;
                    if frame.msg_type == MsgType::Error {
                        bail!("火山 ASR 流异常 code={} payload={}",
                            frame.error_code,
                            String::from_utf8_lossy(&frame.payload).chars().take(200).collect::<String>());
                    }
                    if frame.msg_type != MsgType::FullServerResponse {
                        continue;
                    }
                    let ended = frame.flag == Flags::LastNoSeq;
                    if let Some(payload) = frame.json_payload() {
                        handle_result(&payload, &mut finals_emitted, &event_tx, cfg.canon).await;
                    }
                    if ended {
                        return Ok(AsrEnd::InputDone);
                    }
                }
                Some(Ok(WsMessage::Close(_))) | None => {
                    warn!("asr ws closed by server");
                    return Ok(if input_done { AsrEnd::InputDone } else { AsrEnd::ServerClosed });
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(e.into()),
            }
        }
    }
}

async fn handle_result(
    payload: &serde_json::Value,
    finals_emitted: &mut usize,
    event_tx: &mpsc::Sender<SttEvent>,
    canon: bool,
) {
    let Some(result) = payload.get("result") else { return };
    let utterances = result.get("utterances").and_then(|u| u.as_array());
    let Some(utts) = utterances else { return };

    let norm = |raw: &str| -> String {
        if canon {
            crate::textproc::canon_transcript(raw)
        } else {
            raw.trim().to_string()
        }
    };
    // definite=true 的按序补发 Final;最后一个未定句发 Interim
    let mut definite_count = 0usize;
    let mut tail_interim: Option<String> = None;
    for u in utts {
        let raw = u.get("text").and_then(|t| t.as_str()).unwrap_or("");
        let text = norm(raw);
        let definite = u.get("definite").and_then(|d| d.as_bool()).unwrap_or(false);
        if definite {
            definite_count += 1;
            if definite_count > *finals_emitted {
                if text.is_empty() {
                    // 顺滑风险观测(对齐 volc_stt.py):definite 句被 ddc 清空,唯一证据日志
                    warn!("stt: definite 句段顺滑后为空(疑似 enable_ddc 清空纯语气词), raw_utterance={u}");
                } else {
                    info!("stt final: {text}"); // 证据日志,格式对齐 Python 版
                    let _ = event_tx.send(SttEvent::Final(text)).await;
                }
                *finals_emitted = definite_count;
            }
        } else {
            tail_interim = if text.is_empty() { None } else { Some(text) };
        }
    }
    if let Some(t) = tail_interim {
        let _ = event_tx.send(SttEvent::Interim(t)).await;
    }
}
