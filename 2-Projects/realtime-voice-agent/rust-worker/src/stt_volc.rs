//! 火山流式 ASR 客户端(长连,行为对齐 volc_stt.py + _volc_asr.py):
//! init(gzip JSON,注入 end_window_size 判停窗)→ AudioOnlyClient 逐段 gzip PCM;
//! 响应按 utterances[].definite 逐句发 Final(证据日志 `stt final: <text>`),
//! 尾句非 definite 发 Interim。S1 投机/B5 interim 提交 = P3b。

use std::time::Duration;

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
    /// 一条连接非正常结束(服务端中途断开/协议错误/收流后未见 LastNoSeq 即 EOF)。现役路径只记日志(重连由 stt 任务负责);
    /// ordered_pcm 代次据此作废——不得把已 hold 的半段 final 当完整提交(codex 2026-09-08 §2)。
    Interrupted,
    Closed,
}

#[derive(Clone)]
pub struct SttConfig {
    /// Independent DNS families/address racing; bounded connect applies to
    /// both paths. Opt-in is separate from TTS and restricted to the ASR host.
    pub async_connect: bool,
    pub app_id: String,
    pub access_token: String,
    pub api_key: Option<String>,
    pub resource_id: String,
    pub end_window_ms: u32,
    pub enable_ddc: bool,
    /// preflight 开(生产默认)→ 转写全走 canonical(去标点,S1 投机命中的前提);
    /// 关 → 原样 trim(火山原始带标点行为)。对齐 volc_stt._canon。
    pub canon: bool,
    /// 热词表(request.corpus.context.hotwords):火山话语检测对孤立短指令(停/好/对)
    /// 经常整段丢弃(2026-08-12 矩阵实验:ddc/force_to_speech_time/增益全无效,唯热词
    /// 能捞回);语气词(嗯/啊)不配热词=保留环境音免疫。空=不传(火山默认行为)。
    /// ⚠️ 一遍流式链路热词总预算 100 tokens(官方口径,直传+词表合并从前向后截断),
    /// 且大模型热词=prompt 注入无权重概念,词多即稀释(2026-08-18 剂量实验:3 词能翻
    /// 声母、20 词不能)——一遍链路只配核心短词;二遍(nonstream)链路升 5000 词。
    pub hotwords: Vec<String>,
    /// 火山控制台热词词表 ID。⚠️ 2026-08-18 A/B 实证:bigmodel 与 bigmodel_async
    /// 两端点、一遍与二遍两模式下均零生效(直传阳性对照可翻/词表不可),疑火山侧
    /// 账号/端点缺陷,待工单。字段保留:None=不传,修复后填 env 即启用。
    pub boosting_table_id: Option<String>,
    /// 二遍识别(enable_nonstream):VAD 判停后用非流式模型整段重识别,definite 只在
    /// 二遍结果上(现有 Final=definite 消费逻辑天然兼容)。实测弱音频识别力代差
    /// (「调光谱」流式 0 命中/二遍 3/3),延迟中位数较生产 +30~76ms(20260818 矩阵)。
    /// ⚠️ 仅 bigmodel_async 端点真实支持——老 bigmodel 静默忽略本参数,须与 url 同调。
    pub nonstream: bool,
    /// ASR websocket 端点。默认老 bigmodel(生产现状);nonstream 灰度命中时由
    /// pipeline 改写为 ASYNC_ASR_URL(bigmodel_async,官方现行推荐端点)。
    pub url: String,
}

/// 双向流式新端点(官方现行文档唯一出现的双向流式地址;老 bigmodel 已从文档消失)。
pub const ASYNC_ASR_URL: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

impl SttConfig {
    /// Candidate-only: retain short backchannels instead of asking DDC to
    /// delete them. Does not change model, endpoint, endpointing or hotwords.
    pub fn preserve_search_ack(&mut self, candidate: bool, enabled: bool) {
        if candidate && enabled { self.enable_ddc=false; }
    }
    pub fn from_env() -> Self {
        Self {
            async_connect: std::env::var("P003_ASR_CONNECT_RECOVERY_V1").is_ok_and(|v| v == "1"),
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
            hotwords: {
                // 会话热词 + S2-B2 设备词(P003_DEVICE_ASR_HOTWORDS)合并去重——
                // 火山只有一张热词表;管理面两个 env 键分开存(运营台各自编辑),此处汇流。
                // 铁律:boost 只提高识别概率,与执行判定(device_intent 确定性匹配)无关。
                let mut ws: Vec<String> = std::env::var("VOLC_ASR_HOTWORDS")
                    .map(|v| {
                        v.split(',')
                            .map(|w| w.trim().to_string())
                            .filter(|w| !w.is_empty())
                            .collect()
                    })
                    .unwrap_or_default();
                for w in crate::device_intent::device_asr_hotwords() {
                    if !ws.contains(&w) {
                        ws.push(w);
                    }
                }
                ws
            },
            boosting_table_id: std::env::var("VOLC_ASR_BOOSTING_TABLE_ID")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty()),
            nonstream: false,
            url: ASR_URL.to_string(),
        }
    }
}

/// init 请求载荷(独立函数供单测:热词注入形状与直连实验一致)。
fn build_init_payload(cfg: &SttConfig, request_id: &str) -> serde_json::Value {
    let mut request = json!({
        "model_name": "bigmodel",
        "enable_itn": true,
        "enable_punc": true,
        "enable_ddc": cfg.enable_ddc,
        "show_utterances": true,
        "enable_nonstream": cfg.nonstream,
        "end_window_size": cfg.end_window_ms,
    });
    if !cfg.hotwords.is_empty() || cfg.boosting_table_id.is_some() {
        let mut corpus = json!({});
        if !cfg.hotwords.is_empty() {
            // corpus.context 是 JSON 字符串(非嵌套对象),形状经 2026-08-12 直连实验验证
            let words: Vec<serde_json::Value> =
                cfg.hotwords.iter().map(|w| json!({"word": w})).collect();
            corpus["context"] =
                json!(serde_json::to_string(&json!({"hotwords": words})).unwrap_or_default());
        }
        // 控制台词表(253 词全量底座):与直传并存,直传优先级更高(火山语义)
        if let Some(id) = &cfg.boosting_table_id {
            corpus["boosting_table_id"] = json!(id);
        }
        request["corpus"] = corpus;
    }
    json!({
        "user": {"uid": request_id},
        "audio": {"format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1},
        "request": request,
    })
}

/// 服务端「最后一帧」判定:火山把 LastNoSeq(0b0010)当**位**用——带序号的最后一帧 flag=0b0011(NegativeSeq)。
/// Python 版是 `msg.flag & Flags.LastNoSeq`(位与);此前 Rust 用 `== LastNoSeq` 只认 0b0010,收流后的
/// 最后一帧(0b0011)永远不被识别,只能等服务端关 socket(表现=每个 job 末尾一条「asr ws closed by server」WARN)。
/// 2026-09-08 ordered_pcm POC 首跑实证(正常 LastNoSeq 被判成意外 EOF)。
fn is_last_frame(flag: Flags) -> bool {
    matches!(flag, Flags::LastNoSeq | Flags::NegativeSeq)
}

/// 一条 ASR 连接的结束方式(重连决策依据,Closed 事件由外层重连循环统一发)。
#[derive(Debug, PartialEq, Eq)]
pub enum AsrEnd {
    /// Unused preconnection closed locally, without requesting recognition of
    /// an empty recording. No provider final acknowledgement is implied.
    Unused,
    /// 输入结束且服务端 LastNoSeq 收尾——正常终局,不重连。
    InputDone,
    /// 输入结束(已发 NegativeSeq)但服务端未回 LastNoSeq 就关闭了连接——意外 EOF:不重连,但不是正常终局。
    InputDoneEof,
    /// 服务端中途断开——外层重连(改进项:Python 版此处直接死流)。
    ServerClosed,
}

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
type AsrWs = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Debug)]
pub struct ConnectFailure;
impl std::fmt::Display for ConnectFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("asr connection failed within bounded episode") }
}
impl std::error::Error for ConnectFailure {}

struct ConnectTiming<'a> {
    request_id: &'a str, started: std::time::Instant, stage: &'static str,
    outcome: &'static str, dns_ms: Option<u64>, tcp_ms: Option<u64>, tls_ws_ms: Option<u64>,
}
impl Drop for ConnectTiming<'_> {
    fn drop(&mut self) {
        info!(request_id=self.request_id, stage=self.stage, outcome=self.outcome,
            elapsed_ms=self.started.elapsed().as_millis() as u64, dns_ms=self.dns_ms,
            tcp_ms=self.tcp_ms, tls_ws_ms=self.tls_ws_ms, "asr connection timing");
    }
}

async fn connect_observed(request: tokio_tungstenite::tungstenite::handshake::client::Request,
                          request_id: &str, async_connect: bool) -> Result<AsrWs> {
    let mut timing = ConnectTiming { request_id, started: std::time::Instant::now(), stage:"request",
        outcome:"cancelled", dns_ms:None, tcp_ms:None, tls_ws_ms:None };
    let result = tokio::time::timeout(CONNECT_TIMEOUT, async {
        let host = request.uri().host().ok_or_else(|| anyhow::anyhow!("invalid_host"))?.to_owned();
        let port = request.uri().port_u16().unwrap_or(if request.uri().scheme_str()==Some("wss") {443} else {80});
        let socket = if async_connect && host == "openspeech.bytedance.com" {
            timing.stage="resolve_tcp";
            let c=crate::voice_connect::connect(&host,port).await?;
            timing.dns_ms=Some(c.dns_ms);timing.tcp_ms=Some(c.tcp_ms);c.socket
        } else {
            timing.stage="dns";let at=std::time::Instant::now();
            let addresses:Vec<_>=tokio::net::lookup_host((host.as_str(),port)).await
                .map_err(|_|anyhow::anyhow!("resolve_failed"))?.collect();
            timing.dns_ms=Some(at.elapsed().as_millis() as u64);
            timing.stage="tcp";let at=std::time::Instant::now();
            let socket=tokio::net::TcpStream::connect(addresses.as_slice()).await
                .map_err(|_|anyhow::anyhow!("connect_failed"))?;
            timing.tcp_ms=Some(at.elapsed().as_millis() as u64);socket
        };
        timing.stage="tls_ws";let at=std::time::Instant::now();
        // Pass the original request unchanged: Host, auth headers, path and
        // TLS hostname/certificate verification retain their existing contract.
        let (ws,_) = tokio_tungstenite::client_async_tls_with_config(request,socket,None,None).await
            .map_err(|_|anyhow::anyhow!("handshake_failed"))?;
        timing.tls_ws_ms=Some(at.elapsed().as_millis() as u64);
        Ok::<_,anyhow::Error>(ws)
    }).await;
    match result {
        Ok(Ok(ws)) => {timing.outcome="connected";Ok(ws)},
        other => {timing.outcome=if other.is_err(){"timeout"}else{"failed"};Err(ConnectFailure.into())}
    }
}

/// 起一条 ASR 长连:`pcm_rx` 收 16k i16 PCM 段,事件从 `event_tx` 发出。
/// pcm_rx 关闭 → 发尾段(NegativeSeq)收流。借用 receiver 以支持外层断线重连复用。
pub async fn run_asr_stream(
    cfg: SttConfig,
    pcm_rx: &mut mpsc::Receiver<Vec<i16>>,
    event_tx: mpsc::Sender<SttEvent>,
) -> Result<AsrEnd> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut req = cfg.url.as_str().into_client_request()?;
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
    let ws = tokio::select! {
        result = connect_observed(req, &request_id, cfg.async_connect) => result?,
        _ = event_tx.closed() => return Ok(AsrEnd::Unused),
    };
    let (mut tx, mut rx) = ws.split();
    info!(
        %request_id,
        end_window_ms = cfg.end_window_ms,
        hotwords = cfg.hotwords.len(),
        "asr: connected (seedasr bigmodel)"
    );

    let init_payload = build_init_payload(&cfg, &request_id);
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
    let mut audio_sent = false;
    // WS 应用层心跳(对齐 Python websockets ping_interval=20):跨境长连的死链检测——
    // 无心跳时黑洞连接表现为永久静默(2026-08-12 聋窗排查加装);死链 → send Err → 外层重连。
    let mut ping_tick = tokio::time::interval(Duration::from_secs(20));
    ping_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping_tick.reset(); // 首跳从 20s 后开始,不在连接建立瞬间发

    loop {
        tokio::select! {
            _ = ping_tick.tick() => {
                tx.send(WsMessage::Ping(Vec::new().into())).await.context("asr keepalive ping")?;
            }
            pcm = pcm_rx.recv(), if !input_done => match pcm {
                Some(samples) => {
                    if samples.is_empty() { continue; }
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
                    audio_sent = true;
                }
                None => {
                    if !audio_sent {
                        // First-turn timeout abandons this preconnection before
                        // the replacement RTC stream starts receiving audio.
                        // bigmodel_async rejects a zero-audio NegativeSeq with
                        // 45000002. Close the unused socket instead, bounded so
                        // a peer cannot hold an abandoned stream indefinitely.
                        let _ = tokio::time::timeout(Duration::from_millis(500),
                            tx.send(WsMessage::Close(None))).await;
                        info!(%request_id, "unused asr preconnection closed without recognition");
                        return Ok(AsrEnd::Unused);
                    }
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
                    let ended = is_last_frame(frame.flag);
                    if let Some(payload) = frame.json_payload() {
                        handle_result(&payload, &mut finals_emitted, &event_tx, cfg.canon, ended)
                            .await;
                    }
                    if ended {
                        return Ok(AsrEnd::InputDone);
                    }
                }
                Some(Ok(WsMessage::Close(_))) | None => {
                    warn!("asr ws closed by server");
                    // 收流后未见 LastNoSeq 即被关闭 = 意外 EOF(与 LastNoSeq 正常终局区分;ordered_pcm 据此不提交半段 final)
                    return Ok(if input_done { AsrEnd::InputDoneEof } else { AsrEnd::ServerClosed });
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
    ended: bool,
) {
    let Some(result) = payload.get("result") else { return };
    let norm = |raw: &str| -> String {
        if canon {
            crate::textproc::canon_transcript(raw)
        } else {
            raw.trim().to_string()
        }
    };
    let utterances = result.get("utterances").and_then(|u| u.as_array());
    let Some(utts) = utterances else {
        // 无 utterances 的响应:顶层 text 兜底发 Interim(对齐 volc_stt.py `elif not utts`)
        let top = norm(result.get("text").and_then(|t| t.as_str()).unwrap_or(""));
        if !top.is_empty() {
            let _ = event_tx.send(SttEvent::Interim(top)).await;
        }
        return;
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
        } else if ended {
            // 整流结束(LastNoSeq):剩余尾句提升为 Final(对齐 volc_stt.py is_final 路径),
            // 否则尾句只停留在 interim,永不提交
            if !text.is_empty() {
                info!("stt final(流尾提升): {text}");
                let _ = event_tx.send(SttEvent::Final(text)).await;
            }
        } else {
            tail_interim = if text.is_empty() { None } else { Some(text) };
        }
    }
    if let Some(t) = tail_interim {
        let _ = event_tx.send(SttEvent::Interim(t)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A TCP peer that never finishes the WS handshake must not keep the
    // recognition task alive indefinitely (the 01:08 production failure).
    #[tokio::test]
    async fn stalled_handshake_has_a_bounded_connection_budget() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut c = cfg(vec![]); c.url = format!("ws://{}", listener.local_addr().unwrap());
        let (tx, mut rx) = mpsc::channel(128);
        tx.send(vec![7; 3200]).await.unwrap();
        let (events, _ev_rx) = mpsc::channel(2);
        let mut client = tokio::spawn(async move { run_asr_stream(c, &mut rx, events).await });
        let (_socket, _) = listener.accept().await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(11), &mut client).await;
        client.abort();
        assert!(result.is_ok(), "ASR connect remained pending beyond its 10s budget");
        assert!(result.unwrap().unwrap().is_err());
    }

    #[tokio::test]
    async fn abandoned_event_consumer_cancels_pending_handshake() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut c = cfg(vec![]); c.url = format!("ws://{}", listener.local_addr().unwrap());
        let (_tx, mut rx) = mpsc::channel(2);
        let (events, ev_rx) = mpsc::channel(2);
        let mut client = tokio::spawn(async move { run_asr_stream(c, &mut rx, events).await });
        let (_socket, _) = listener.accept().await.unwrap();
        drop(ev_rx);
        let result = tokio::time::timeout(Duration::from_millis(500), &mut client).await;
        client.abort();
        assert!(result.is_ok(), "orphan ASR handshake survived its event owner");
        assert_eq!(result.unwrap().unwrap().unwrap(), AsrEnd::Unused);
    }

    #[tokio::test]
    async fn delayed_handshake_preserves_auth_and_first_pcm_exactly_once() {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr=listener.local_addr().unwrap();
        let expected:Vec<i16>=(0..3200).map(|i|(i%601-300) as i16).collect();
        let pcm=expected.clone();
        let server=tokio::spawn(async move {
            let (socket,_)=listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_millis(150)).await;
            let mut ws=tokio_tungstenite::accept_hdr_async(socket,|req:&tokio_tungstenite::tungstenite::handshake::server::Request,response| {
                assert_eq!(req.uri().path(),"/asr-test");
                assert_eq!(req.headers()["X-Api-Key"],"test-key");
                assert_eq!(req.headers()["X-Api-Resource-Id"],"r");
                assert!(req.headers().contains_key("X-Api-Request-Id"));
                Ok(response)
            }).await.unwrap();
            let mut got=Vec::new();let mut init_count=0;
            while let Some(msg)=ws.next().await {
                let frame=Frame::unmarshal(&msg.unwrap().into_data()).unwrap();
                if frame.msg_type==MsgType::FullClientRequest {init_count+=1;continue;}
                if frame.flag==Flags::NegativeSeq {
                    let response=Frame{msg_type:MsgType::FullServerResponse,flag:Flags::LastNoSeq,
                        payload:br#"{"result":{"utterances":[]}}"#.to_vec(),..Default::default()};
                    ws.send(WsMessage::Binary(response.marshal().into())).await.unwrap();break;
                }
                use std::io::Read;let mut bytes=Vec::new();
                flate2::read::GzDecoder::new(frame.payload.as_slice()).read_to_end(&mut bytes).unwrap();
                got.extend(bytes.chunks_exact(2).map(|b|i16::from_le_bytes([b[0],b[1]])));
            }
            assert_eq!(init_count,1);assert_eq!(got,expected);
        });
        let mut c=cfg(vec![]);c.url=format!("ws://{addr}/asr-test");c.api_key=Some("test-key".into());
        let (tx,mut rx)=mpsc::channel(128);let (events,_ev_rx)=mpsc::channel(2);
        tx.send(pcm).await.unwrap();drop(tx);
        assert_eq!(tokio::time::timeout(Duration::from_secs(2),run_asr_stream(c,&mut rx,events)).await.unwrap().unwrap(),AsrEnd::InputDone);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn delayed_six_second_handshake_delivers_final_before_recognition_hold_expires() {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {
            let (socket,_)=listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_millis(6500)).await;
            let mut ws=tokio_tungstenite::accept_async(socket).await.unwrap();
            let init=Frame::unmarshal(&ws.next().await.unwrap().unwrap().into_data()).unwrap();
            assert_eq!(init.msg_type,MsgType::FullClientRequest);
            let audio=Frame::unmarshal(&ws.next().await.unwrap().unwrap().into_data()).unwrap();
            assert_eq!(audio.msg_type,MsgType::AudioOnlyClient);
            let response=Frame{msg_type:MsgType::FullServerResponse,flag:Flags::LastNoSeq,
                payload:serde_json::to_vec(&json!({"result":{"utterances":[{"text":"合成验证","definite":true}]}})).unwrap(),..Default::default()};
            ws.send(WsMessage::Binary(response.marshal().into())).await.unwrap();
        });
        let t=std::time::Instant::now();
        let w=crate::business_runtime::Runtime::from_settings("enforce","BJP00326110799999901",
            "sn-BJP00326110799999901-123",Some(&json!({"timeout_ms":5000,"revision":"cfg-1"})),t).unwrap();
        w.input_frame(t,160);w.asr_speech(t);
        let mut c=cfg(vec![]);c.url=format!("ws://{addr}");
        let (tx,mut rx)=mpsc::channel(128);let (events,mut ev_rx)=mpsc::channel(2);
        tx.send(vec![31;3200]).await.unwrap();
        let client=tokio::spawn(async move {run_asr_stream(c,&mut rx,events).await});
        let mut tick=tokio::time::interval(Duration::from_millis(25));
        loop {
            tokio::select! {
                event=ev_rx.recv()=>{
                    assert!(matches!(event,Some(SttEvent::Final(ref s)) if s=="合成验证"));
                    w.asr_final(std::time::Instant::now());break;
                },
                _=tick.tick()=>{
                    assert!(t.elapsed()<Duration::from_secs(9),"bounded final not delivered");
                    assert_eq!(w.evaluate(std::time::Instant::now()),crate::business_watchdog::Decision::Keep,
                        "ordinary 5s idle must not overtake a live recognition episode");
                }
            }
        }
        assert!(t.elapsed()>=Duration::from_secs(6));
        assert_eq!(client.await.unwrap().unwrap(),AsrEnd::InputDone);server.await.unwrap();
    }

    // The async provider rejects an empty recognition terminator with
    // 45000002. Reproduce its wire behavior, including a positive control:
    // real PCM that happens to contain silence still needs normal final ACK.
    async fn empty_preconnect_case(pcm: Option<Vec<i16>>) -> (Result<AsrEnd>, usize, bool) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (initialized, ready) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let init = ws.next().await.unwrap().unwrap().into_data();
            assert_eq!(Frame::unmarshal(&init).unwrap().msg_type, MsgType::FullClientRequest);
            initialized.send(()).unwrap();
            let mut samples = 0;
            let mut terminator = false;
            while let Some(message) = ws.next().await {
                match message.unwrap() {
                    WsMessage::Binary(data) => {
                        let f = Frame::unmarshal(&data).unwrap();
                        assert_eq!(f.msg_type, MsgType::AudioOnlyClient);
                        if f.flag == Flags::NegativeSeq {
                            terminator = true;
                            let response = if samples == 0 {
                                Frame { msg_type: MsgType::Error, error_code: 45000002,
                                    payload: b"No audio was received".to_vec(), ..Default::default() }
                            } else {
                                Frame { msg_type: MsgType::FullServerResponse, flag: Flags::LastNoSeq,
                                    payload: br#"{"result":{"utterances":[]}}"#.to_vec(), ..Default::default() }
                            };
                            ws.send(WsMessage::Binary(response.marshal().into())).await.unwrap();
                            break;
                        }
                        use std::io::Read;
                        assert_eq!(f.compression, COMP_GZIP);
                        let mut pcm = Vec::new();
                        flate2::read::GzDecoder::new(f.payload.as_slice()).read_to_end(&mut pcm).unwrap();
                        samples += pcm.len() / 2;
                    }
                    WsMessage::Close(_) => break,
                    _ => {}
                }
            }
            (samples, terminator)
        });
        let mut c = cfg(vec![]); c.url = format!("ws://{addr}");
        let (tx, mut rx) = mpsc::channel(2);
        let (events, _ev_rx) = mpsc::channel(2);
        let client = tokio::spawn(async move { run_asr_stream(c, &mut rx, events).await });
        ready.await.unwrap();
        if let Some(pcm) = pcm { tx.send(pcm).await.unwrap(); }
        drop(tx);
        let result = tokio::time::timeout(Duration::from_secs(2), client).await.unwrap().unwrap();
        let (samples, terminator) = tokio::time::timeout(Duration::from_secs(2), server).await.unwrap().unwrap();
        (result, samples, terminator)
    }

    #[tokio::test]
    async fn unused_preconnect_does_not_submit_empty_recognition() {
        let (result, samples, terminator) = empty_preconnect_case(None).await;
        assert_eq!(result.unwrap(), AsrEnd::Unused);
        assert_eq!(samples, 0);
        assert!(!terminator, "no audio means no recognition to finalize");
    }

    #[tokio::test]
    async fn empty_pcm_chunk_is_not_a_recognition_session() {
        let (result, samples, terminator) = empty_preconnect_case(Some(vec![])).await;
        assert_eq!(result.unwrap(), AsrEnd::Unused);
        assert_eq!(samples, 0);
        assert!(!terminator);
    }

    #[tokio::test]
    async fn genuine_silent_pcm_still_waits_for_provider_final_ack() {
        let (result, samples, terminator) = empty_preconnect_case(Some(vec![0; 320])).await;
        assert_eq!(result.unwrap(), AsrEnd::InputDone);
        assert_eq!(samples, 320);
        assert!(terminator);
    }

    fn cfg(hotwords: Vec<String>) -> SttConfig {
        SttConfig {
            async_connect: false,
            app_id: "a".into(),
            access_token: "t".into(),
            api_key: None,
            resource_id: "r".into(),
            end_window_ms: 150,
            enable_ddc: true,
            canon: true,
            hotwords,
            boosting_table_id: None,
            nonstream: false,
            url: ASR_URL.to_string(),
        }
    }

    /// 二遍识别开关进 init payload(灰度命中时 pipeline 置 true+切 async 端点)。
    #[test]
    fn r16_search_ack_preservation_keeps_ordinary_asr_configuration() {
        for (candidate, enabled) in [(false,false),(false,true),(true,false),(true,true)] {
            let mut c=cfg(vec!["停".into(),"对".into()]);c.enable_ddc=true;
            let before=build_init_payload(&c,"test");c.preserve_search_ack(candidate,enabled);
            let after=build_init_payload(&c,"test");let mut expected=before;
            if candidate&&enabled {expected["request"]["enable_ddc"]=false.into();}
            assert_eq!(after,expected);
        }
    }
    #[test]
    fn init_payload_nonstream_flag() {
        let c = cfg(vec![]);
        let p = build_init_payload(&c, "rid");
        assert_eq!(p["request"]["enable_nonstream"], false, "默认关(生产现状)");
        let mut c2 = cfg(vec![]);
        c2.nonstream = true;
        let p2 = build_init_payload(&c2, "rid");
        assert_eq!(p2["request"]["enable_nonstream"], true);
        assert_eq!(p2["request"]["end_window_size"], 150, "二遍模式判停窗保留");
    }

    /// 词表 ID(2026-08-18 川哥控制台建表):与直传并存,corpus 同级字段。
    #[test]
    fn init_payload_boosting_table_id_shapes() {
        // 只有词表无直传:corpus 仅含 id
        let mut c = cfg(vec![]);
        c.boosting_table_id = Some("bt-test-id".into());
        let p = build_init_payload(&c, "req");
        assert_eq!(p["request"]["corpus"]["boosting_table_id"], "bt-test-id");
        assert!(p["request"]["corpus"].get("context").is_none(), "无直传不应有 context");
        // 并存:两字段同现(直传优先级由火山服务端语义保证)
        let mut c2 = cfg(vec!["停".into()]);
        c2.boosting_table_id = Some("bt-test-id".into());
        let p2 = build_init_payload(&c2, "req");
        assert_eq!(p2["request"]["corpus"]["boosting_table_id"], "bt-test-id");
        assert!(p2["request"]["corpus"]["context"].as_str().unwrap_or("").contains("停"));
    }

    /// 火山最后一帧 flag 位语义:0b0010(LastNoSeq)与 0b0011(带序号的最后一帧)都是流结束;0b0001 不是。
    #[test]
    fn last_frame_flag_is_bitwise_like_python() {
        assert!(is_last_frame(Flags::LastNoSeq));
        assert!(is_last_frame(Flags::NegativeSeq));
        assert!(!is_last_frame(Flags::PositiveSeq));
        assert!(!is_last_frame(Flags::NoSeq));
    }

    #[test]
    fn init_payload_without_hotwords_has_no_corpus() {
        let p = build_init_payload(&cfg(vec![]), "rid");
        assert!(p["request"].get("corpus").is_none());
        assert_eq!(p["request"]["end_window_size"], 150);
    }

    #[test]
    fn init_payload_hotwords_shape_matches_experiment() {
        // 形状=直连实验验证过的:corpus.context 是 JSON 字符串,内含 {"hotwords":[{"word":..}]}
        let p = build_init_payload(&cfg(vec!["停".into(), "好".into()]), "rid");
        let ctx = p["request"]["corpus"]["context"].as_str().expect("context 必须是字符串");
        let parsed: serde_json::Value = serde_json::from_str(ctx).expect("context 内容是合法 JSON");
        assert_eq!(parsed["hotwords"][0]["word"], "停");
        assert_eq!(parsed["hotwords"][1]["word"], "好");
    }

    #[test]
    fn hotwords_env_parsing_trims_and_drops_empty() {
        // from_env 的解析逻辑等价复现(不动真实 env):split/trim/滤空
        let v = "停, 好的 ,,对";
        let words: Vec<String> =
            v.split(',').map(|w| w.trim().to_string()).filter(|w| !w.is_empty()).collect();
        assert_eq!(words, vec!["停", "好的", "对"]);
    }
}
