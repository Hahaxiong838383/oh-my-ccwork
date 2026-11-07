//! 讯飞超拟人 TTS 客户端(聆小璇线,2026-08-14)。
//!
//! 协议(移植自 Python `engines/xfyun_tts.py` + `xfyun_common.py`,并于 64.90 实测复核):
//! - `wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6?<hmac-sha256 鉴权 query>`
//! - 签名原文 `"host: {host}\ndate: {date}\nGET {path} HTTP/1.1"` → HmacSHA256(api_secret)
//!   → base64 → 拼进 authorization 明文 → **整体再 base64** 进 query。
//! - 请求 `payload.text.text` 必须是 **base64(utf-8)**;发明文会被拒(10009)。
//! - 响应 `payload.audio.audio` 为 base64 PCM(encoding=raw);`payload.audio.status==2` 为末帧;
//!   `header.code != 0` 为错误帧。
//!
//! ## 会话模型(2026-08-14 实测 + 官方文档双向确认,措辞几经修正,别再凭一次实验改写)
//!
//! **一条 WS = 一次合成任务;但一次任务内可以流式喂入多段文本。**
//!
//! - 任务结束(收到 `audio.status==2`)后,同连接再开新任务 → `26016 intput channel is
//!   closed`。故**用过的连接不可复用,没有进程级池**。
//! - ⚠️ **但这不等于"协议不支持复用"**。`payload.text.status` 支持 0/1/2,
//!   实测 `0→2` 与 `0→1→2` 分段流式喂文本**均成功**。我最初只试了 `status=2`
//!   (=告诉服务端"文本到此为止",输入通道随即关闭——错误消息字面就在说这件事),
//!   却把结论写成了"协议不支持复用",判据作用域过宽。
//! - 硬约束是 **14 秒无上行数据**(实测:间隔 3/8/11s 均成功,15s 报
//!   `26005 No active up data within 14000 ms`)。文档写的 10s 与"前 20 字需 25 字/秒"
//!   均**非硬约束**——实测 2 字/秒照样跑通。**计时器从建连起算**(2026-08-15 实测),
//!   这正是预建连(`Warm`)可行的依据。
//! - **无取消/中止指令**(官方文档确认)。整句一次性发出后服务端一定吐完,
//!   打断时 worker 只能丢弃,停不了上游 → 见 `send_or_abort`。
//!
//! ## 为什么最终没做「一条 WS 流式喂多段」(2026-08-15 实测否掉)
//!
//! 该设想的目的是省掉句间建连。但实测下行 `payload.audio.seq` 是**帧序号**
//! (1..52 连续递增)、`id` 恒为 `"0"`,**不带任何文本段标识**——一条 WS 喂多段时,
//! 音频无法归属回是哪一句。而 `pipeline` 靠 `synthesize` 每句返回的 bytes 建
//! `progress[(累计字, 累计样本)]`,**字幕逐句推进**与**打断后历史截断**全依赖它。
//! 换言之那个设想会拿两个行为资产去换延迟。
//!
//! 改用 `Warm` 预建连:每句仍是独立会话(归属关系一字节未动),
//! 建连挪到上一句合成期间的后台完成,省下的时间一样。
//!
//! 首包:**含建连 515–562ms**(Rust 线生产实测) / **不含建连 248–275ms**。
//! 对照火山 Rust 线生产 400–550ms(带池)。

use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::SendTimeoutError;

use crate::playout::PlayoutControl;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{info, Instrument};

pub const TTS_SAMPLE_RATE: u32 = 24_000;
/// 超拟人 endpoint(path 含产品固定路由段,勿改)
const TTS_URL: &str = "wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6";
pub const DEFAULT_VCN: &str = "x6_lingxiaoxuan_pro";
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RECV_TIMEOUT: Duration = Duration::from_secs(30);

/// One absolute deadline, starting when speakable text is ready. Once PCM has
/// arrived, the existing inter-frame timeout owns long-answer liveness instead.
pub(crate) struct FirstAudioBudget(Option<tokio::time::Instant>);
#[derive(Debug)]
struct FirstAudioTimeout(&'static str);
impl std::fmt::Display for FirstAudioTimeout {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {write!(f,"xfyun first PCM budget exhausted at {}",self.0)}
}
impl std::error::Error for FirstAudioTimeout {}
pub(crate) fn first_audio_timed_out(error:&anyhow::Error)->bool {error.is::<FirstAudioTimeout>()}
impl FirstAudioBudget {
    pub(crate) fn new(duration: Option<Duration>) -> Self {
        Self(duration.map(|d|tokio::time::Instant::now()+d))
    }
    pub(crate) async fn wait<F: std::future::Future>(&self, stage: &'static str, future: F) -> Result<F::Output> {
        match self.0 {
            None => Ok(future.await),
            Some(deadline) => {
                if tokio::time::Instant::now()>=deadline {return Err(FirstAudioTimeout(stage).into());}
                tokio::time::timeout_at(deadline,future).await
                    .map_err(|_|FirstAudioTimeout(stage).into())
            }
        }
    }
    fn received_pcm(&mut self) {self.0=None;}
}

#[derive(Clone)]
pub struct XfyunTtsConfig {
    pub app_id: String,
    pub api_key: String,
    pub api_secret: String,
    pub vcn: String,
    /// 讯飞语速刻度 0–100,50 为常速(与火山的 speed_ratio 乘数不是一套刻度)
    pub speed: i64,
    pub oral_level: String,
}

impl XfyunTtsConfig {
    pub fn from_env() -> Self {
        Self {
            app_id: std::env::var("XFYUN_TTS_APP_ID").unwrap_or_default(),
            api_key: std::env::var("XFYUN_TTS_API_KEY").unwrap_or_default(),
            api_secret: std::env::var("XFYUN_TTS_API_SECRET").unwrap_or_default(),
            vcn: std::env::var("XFYUN_TTS_VCN").unwrap_or_else(|_| DEFAULT_VCN.into()),
            speed: std::env::var("XFYUN_TTS_SPEED")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(50),
            oral_level: std::env::var("XFYUN_TTS_ORAL_LEVEL").unwrap_or_else(|_| "mid".into()),
        }
    }

    /// 凭据齐备性(缺一即不可用;由 preflight 在启动期报警,别等首句才炸)
    pub fn missing_keys(&self) -> Vec<&'static str> {
        let mut m = Vec::new();
        if self.app_id.is_empty() {
            m.push("XFYUN_TTS_APP_ID");
        }
        if self.api_key.is_empty() {
            m.push("XFYUN_TTS_API_KEY");
        }
        if self.api_secret.is_empty() {
            m.push("XFYUN_TTS_API_SECRET");
        }
        m
    }
}

/// RFC1123 GMT 日期(签名原文与 query 必须用同一个值,故只取一次向下传)。
fn rfc1123_now() -> String {
    chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

/// 构造带 hmac-sha256 鉴权 query 的握手 URL。纯函数,可单测。
fn build_auth_url(api_key: &str, api_secret: &str, endpoint: &str, date: &str) -> Result<String> {
    let url = reqwest::Url::parse(endpoint).context("xfyun endpoint 解析失败")?;
    let host = url.host_str().context("xfyun endpoint 缺 host")?;
    let path = url.path();

    let signature_origin = format!("host: {host}\ndate: {date}\nGET {path} HTTP/1.1");
    let mut mac = <Hmac<Sha256>>::new_from_slice(api_secret.as_bytes())
        .context("xfyun hmac key 非法")?;
    mac.update(signature_origin.as_bytes());
    let signature = B64.encode(mac.finalize().into_bytes());

    let authorization_origin = format!(
        "api_key=\"{api_key}\", algorithm=\"hmac-sha256\", \
         headers=\"host date request-line\", signature=\"{signature}\""
    );
    let authorization = B64.encode(authorization_origin.as_bytes());

    let signed = reqwest::Url::parse_with_params(
        endpoint,
        &[("host", host), ("date", date), ("authorization", authorization.as_str())],
    )
    .context("xfyun 鉴权 URL 拼装失败")?;
    Ok(signed.to_string())
}

/// 单帧完整合成请求(status 全 2 = 一句一会话)。
/// ⚠️ `payload.text.text` **必须 base64**;发明文报 10009(Python 侧 2026-07-27 实测教训)。
fn build_request(cfg: &XfyunTtsConfig, text: &str) -> Value {
    json!({
        "header": {"app_id": cfg.app_id, "status": 2},
        "parameter": {
            "oral": {"oral_level": cfg.oral_level},
            "tts": {
                "vcn": cfg.vcn,
                "speed": cfg.speed,
                "volume": 50,
                "pitch": 50,
                "audio": {
                    "encoding": "raw",           // raw = PCM16,对话链路免解码
                    "sample_rate": TTS_SAMPLE_RATE,
                    "channels": 1,
                    "bit_depth": 16,
                    "frame_size": 0,
                },
            },
        },
        "payload": {
            "text": {
                "encoding": "utf8",
                "compress": "raw",
                "format": "plain",
                "status": 2,
                "seq": 1,
                "text": B64.encode(text.as_bytes()),
            }
        },
    })
}

/// 下行帧解析结果。
#[derive(Debug, PartialEq)]
enum Downlink {
    Audio { pcm: Vec<u8>, last: bool },
    /// 无音频载荷但可能是末帧(如纯状态帧)
    Ignore { last: bool },
    Error(String),
}

/// 下行帧 → Downlink。纯函数,可单测。
fn parse_frame(raw: &str) -> Downlink {
    let obj: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Downlink::Ignore { last: false },
    };
    // code 缺省视为 0(部分帧不带 header.code)
    let code = obj.pointer("/header/code").and_then(Value::as_i64).unwrap_or(0);
    if code != 0 {
        let msg = obj
            .pointer("/header/message")
            .and_then(Value::as_str)
            .unwrap_or("");
        return Downlink::Error(format!("code={code} message={msg}"));
    }
    let last = obj.pointer("/payload/audio/status").and_then(Value::as_i64) == Some(2);
    match obj.pointer("/payload/audio/audio").and_then(Value::as_str) {
        Some(b64) if !b64.is_empty() => match B64.decode(b64) {
            Ok(pcm) => Downlink::Audio { pcm, last },
            Err(_) => Downlink::Ignore { last },
        },
        _ => Downlink::Ignore { last },
    }
}

/// 与 `tts_volc::prewarm_pool` 同名占位:讯飞连接不可跨任务复用,进程级池无意义。
/// (**turn 内的预建连是另一回事**,见 `Warm`——那是提前握手,不是复用已用过的连接。)
pub async fn prewarm_pool(_cfg: &XfyunTtsConfig) {}

type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// 预建连的安全窗。14s 是硬上限,留 2s 余量。
/// 超龄直接丢弃重连,不赌它还活着——赌输的表现是**整句合成失败**,
/// 代价远大于一次 267ms 建连。
const WARM_MAX_AGE: Duration = Duration::from_secs(12);

/// 已完成握手、**一个字都还没发**的连接。
///
/// 为什么可以这么做:2026-08-15 实测(同轮跑了正反双锚)——
/// 建连后干等 **10s** 再发首帧成功,干等 **15s** 被服务端关闭。
/// 即 `26005 No active up data within 14000 ms` 的计时器**从建连起算**,
/// 不是从首帧起算。故取用前必须查龄期,见 `WARM_MAX_AGE`。
///
/// 为什么不是「一个 turn 一条 WS 流式喂多段」(原第二步设想):
/// 实测下行 `payload.audio.seq` 是**帧序号**(1..52 连续)、`id` 恒为 "0",
/// **不带文本段标识**。而 pipeline 靠 `synthesize` 每句返回的 bytes 建
/// `progress[(累计字, 累计样本)]`,字幕逐句推进与打断后历史截断都依赖它。
/// 一条 WS 喂多段 = 这两个行为资产失去依据。预建连拿到同样的省时,
/// 且**每句仍是独立会话**,归属关系一个字节都没动。
pub struct Warm {
    ws: Ws,
    opened: std::time::Instant,
    connect_ms: u64,
    connect_id: u64,
}

impl Warm {
    pub(crate) fn fresh(&self) -> bool {
        warm_is_fresh(self.opened.elapsed())
    }
}

/// 龄期判定抽成纯函数,好让「安全窗必须真的小于协议上限」这条能被单测钉住。
fn warm_is_fresh(age: Duration) -> bool {
    age < WARM_MAX_AGE
}

/// 服务端实测的硬上限:建连后 14 秒无上行数据即被关闭(`26005`)。
/// 仅供单测对账 `WARM_MAX_AGE`,运行期不读。
#[cfg(test)]
const PROTOCOL_IDLE_LIMIT: Duration = Duration::from_secs(14);

fn async_dns_enabled(agent: &str, flag: Option<&str>, host: &str) -> bool {
    flag == Some("1")
        && (agent == "rust-worker" || crate::search_canary::is_candidate(agent))
        && host.eq_ignore_ascii_case("cbm01.cn-huabei-1.xf-yun.com")
}

#[test]
fn r28_main_dns_requires_explicit_flag_and_expected_provider() {
    let host = "cbm01.cn-huabei-1.xf-yun.com";
    assert!(async_dns_enabled("rust-worker", Some("1"), host));
    assert!(async_dns_enabled("p003-search-verification-20261026", Some("1"), host));
    for flag in [None, Some("0"), Some("true")] {
        assert!(!async_dns_enabled("rust-worker", flag, host));
    }
    assert!(!async_dns_enabled("another-worker", Some("1"), host));
    for host in ["localhost", "internal.local", "cbm01.cn-huabei-1.xf-yun.com.evil"] {
        assert!(!async_dns_enabled("rust-worker", Some("1"), host));
        assert!(!async_dns_enabled("p003-search-verification-20261026", Some("1"), host));
    }
}

async fn connect_observed(url: String) -> Result<Warm> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let mut trace = ConnectTiming {
        id: NEXT.fetch_add(1, Ordering::Relaxed), start: std::time::Instant::now(),
        stage: "request", dns_ms: None, tcp_ms: None, tls_ws_ms: None, outcome: "cancelled",
        dns_path: Some("system_os"), local: None, peer: None,reason:"owner_dropped",
    };
    // Explicitly opt in for the known TTS host only. Independent A/AAAA lookups
    // let an available address connect without waiting for the other family.
    // System DNS remains the default. Both retain
    // TCP defaults, TLS/SNI/certificate validation and one overall 10s budget.
    // TLS and WebSocket stay one measured stage; do not invent separate timings.
    let result = tokio::time::timeout(CONNECT_TIMEOUT, async {
        let request = url.into_client_request().map_err(|_| anyhow::anyhow!("invalid_request"))?;
        let host = request.uri().host().ok_or_else(|| anyhow::anyhow!("invalid_host"))?.to_owned();
        let port = request.uri().port_u16().unwrap_or(if request.uri().scheme_str() == Some("wss") {443} else {80});
        let socket = if async_dns_enabled(
            &std::env::var("AGENT_NAME").unwrap_or_default(),
            std::env::var("P003_ASYNC_DNS_V1").ok().as_deref(),
            &host,
        ) {
            trace.stage="resolve_tcp";
            let connected=crate::voice_connect::connect(&host,port)
                .instrument(tracing::info_span!("voice_connection",provider="tts",connect_id=trace.id)).await?;
            trace.dns_ms=Some(connected.dns_ms);trace.tcp_ms=Some(connected.tcp_ms);
            trace.dns_path=Some(connected.dns_path);
            connected.socket
        } else {
            trace.stage = "dns"; let t = std::time::Instant::now();
            let addresses: Vec<_> = tokio::net::lookup_host((host.as_str(), port)).await
                .map_err(|_| anyhow::anyhow!("resolve_failed"))?.collect();
            trace.dns_ms = Some(t.elapsed().as_millis() as u64);
            trace.dns_path=Some("system_os");
            trace.stage = "tcp"; let t = std::time::Instant::now();
            let socket = tokio::net::TcpStream::connect(addresses.as_slice()).await
                .map_err(|_| anyhow::anyhow!("connect_failed"))?;
            trace.tcp_ms = Some(t.elapsed().as_millis() as u64);
            socket
        };
        trace.local = socket.local_addr().ok();
        trace.peer = socket.peer_addr().ok();
        trace.stage = "tls_ws"; let t = std::time::Instant::now();
        let (ws, _) = tokio_tungstenite::client_async_tls_with_config(request, socket, None, None).await
            .map_err(|e| {
                use tokio_tungstenite::tungstenite::Error;
                match e {
                    Error::Http(response) => anyhow::anyhow!("http_{}", response.status().as_u16()),
                    Error::Tls(_) => anyhow::anyhow!("tls_failed"),
                    Error::Io(_) => anyhow::anyhow!("io_failed"),
                    _ => anyhow::anyhow!("handshake_failed"),
                }
            })?;
        trace.tls_ws_ms = Some(t.elapsed().as_millis() as u64);
        Ok::<_, anyhow::Error>(ws)
    }).await;
    match result {
        Ok(Ok(ws)) => {
            trace.outcome = "connected";
            trace.reason = "none";
            Ok(Warm { ws, opened: trace.start, connect_ms: trace.start.elapsed().as_millis() as u64, connect_id: trace.id })
        }
        other => {
            trace.outcome = if other.is_err() {"timeout"} else {"failed"};
            let reason = match other {
                Ok(Err(e)) => {trace.reason=crate::voice_connect::safe_failure_reason(&e);e.to_string()},
                _ => {trace.reason="connect_budget";"timeout".into()},
            };
            bail!("xfyun connect stage={} reason={}", trace.stage, reason)
        }
    }
}

struct ConnectTiming {
    id: u64, start: std::time::Instant, stage: &'static str,
    dns_ms: Option<u64>, tcp_ms: Option<u64>, tls_ws_ms: Option<u64>, outcome: &'static str,
    dns_path: Option<&'static str>,
    reason: &'static str,
    local: Option<std::net::SocketAddr>, peer: Option<std::net::SocketAddr>,
}
impl Drop for ConnectTiming {
    fn drop(&mut self) {
        info!(connect_id=self.id, stage=self.stage, outcome=self.outcome,reason=self.reason,
            elapsed_ms=self.start.elapsed().as_millis() as u64,
            dns_ms=self.dns_ms, tcp_ms=self.tcp_ms, tls_ws_ms=self.tls_ws_ms,
            dns_path=self.dns_path, local=?self.local, peer=?self.peer,
            "tts connection timing");
    }
}

/// One bounded record per synthesis, including cancellation/error exits.
/// Read waits include scheduler delay; observed PCM gaps can include downstream
/// backpressure. Keep these separate instead of calling either a network RTT.
struct StreamTiming<'a> {
    room: &'a str, turn_id: u64, connect_id: u64,
    started: std::time::Instant, phase: &'static str,
    pending_since: Option<std::time::Instant>, last_pcm: Option<std::time::Instant>,
    read_wait_ms: u64, max_read_wait_ms: u64,
    send_wait_ms: u64, max_send_wait_ms: u64, max_pcm_gap_ms: u64,
    pcm_frames: u64, completed: bool,
}
impl Drop for StreamTiming<'_> {
    fn drop(&mut self) {
        info!(room=self.room, turn_id=self.turn_id, connect_id=self.connect_id,
            phase=self.phase, completed=self.completed, pcm_frames=self.pcm_frames,
            elapsed_ms=self.started.elapsed().as_millis() as u64,
            ws_read_wait_ms=self.read_wait_ms, max_ws_read_wait_ms=self.max_read_wait_ms,
            channel_send_wait_ms=self.send_wait_ms, max_channel_send_wait_ms=self.max_send_wait_ms,
            max_observed_pcm_gap_ms=self.max_pcm_gap_ms,
            pending_wait_ms=self.pending_since.map(|t|t.elapsed().as_millis() as u64),
            "tts stream timing");
    }
}

/// 只握手,不发文本。给 turn 开始时/上一句合成期间的后台预建连用。
pub async fn connect_warm(cfg: &XfyunTtsConfig) -> Result<Warm> {
    let missing = cfg.missing_keys();
    if !missing.is_empty() {
        bail!("xfyun TTS 凭据缺失 {missing:?}");
    }
    let url = build_auth_url(&cfg.api_key, &cfg.api_secret, TTS_URL, &rfc1123_now())?;
    connect_observed(url).await
}

/// 打断时把音频交给下游:**不能裸 `send().await`**。
///
/// 打断走 `PlayoutControl::pause()`,receiver 并没有被 drop,所以 channel 满了之后
/// `send().await` 会一直阻塞(不是返回 Err),而讯飞服务端**不知道被打断、会一路吐到
/// `status=2`**(协议无取消指令)。结果是整个 turn 的收尾被拖住——用户现象是
/// 「打断后声音停了,但字幕过好一会儿才出来」(2026-08-14 川哥实测,长回复必现)。
///
/// 火山侧同样是裸 send,但它吐流 6.5 倍实时、且能 `FinishSession` 中途停服务端,
/// 32 格 channel 填满前整句早吐完,所以窗口小到观察不到。**这是继承的缺陷被慢速放大。**
///
/// 这里用 `send_timeout` 的超时值**只作轮询间隔,不作判定阈值**——超时了就回去
/// 重查一次 `ctl.aborted()`,没打断就继续等。正常长句本来就会短暂阻塞(生产端
/// 1.9 倍实时快于消费端),那种情况下循环几圈自然通过,不会误判成打断。
async fn send_or_abort(
    audio_tx: &mpsc::Sender<Vec<u8>>,
    mut pcm: Vec<u8>,
    ctl: &PlayoutControl,
) -> std::result::Result<(), &'static str> {
    const POLL: Duration = Duration::from_millis(200);
    loop {
        if ctl.aborted() {
            return Err("aborted");
        }
        match audio_tx.send_timeout(pcm, POLL).await {
            Ok(()) => return Ok(()),
            Err(SendTimeoutError::Timeout(back)) => pcm = back, // 拿回所有权,回去重查 abort
            Err(SendTimeoutError::Closed(_)) => return Err("consumer gone"),
        }
    }
}

/// 合成一句:PCM(24k i16le bytes)分块经 `audio_tx` 发出。返回 (ttfb_ms, total_bytes)。
/// 每句独立 WS 会话——见 `Warm` 的说明,预建连不改变这一点。
///
/// `warm` = 上一句合成期间后台建好的连接。给了就直接用(建连不在关键路径上),
/// 没给或已超龄就现连。**首包口径随之改变**:用了预建连时 `tts_ttft_ms`
/// 从发文本起算、`tts_connect_ms=0`,日志里 `warm=true` 标明,别把两种口径混着比。
pub(crate) async fn synthesize_budgeted(
    cfg: &XfyunTtsConfig, text: &str, audio_tx: &mpsc::Sender<Vec<u8>>,
    ctl: &PlayoutControl, warm: Option<Warm>, budget: FirstAudioBudget,
) -> Result<(u64, usize)> {
    synthesize_inner(cfg, text, audio_tx, ctl, warm, true, budget).await
}

/// Foreground recovery already acquired a socket under a shared deadline.
/// Never reset that deadline by silently creating another cold connection.
#[cfg(test)]
pub async fn synthesize_connected(
    cfg: &XfyunTtsConfig, text: &str, audio_tx: &mpsc::Sender<Vec<u8>>,
    ctl: &PlayoutControl, warm: Warm,
) -> Result<(u64, usize)> {
    synthesize_connected_budgeted(cfg, text, audio_tx, ctl, warm, FirstAudioBudget::new(None)).await
}

pub(crate) async fn synthesize_connected_budgeted(
    cfg: &XfyunTtsConfig, text: &str, audio_tx: &mpsc::Sender<Vec<u8>>,
    ctl: &PlayoutControl, warm: Warm, budget: FirstAudioBudget,
) -> Result<(u64, usize)> {
    synthesize_inner(cfg, text, audio_tx, ctl, Some(warm), false, budget).await
}

async fn synthesize_inner(
    cfg: &XfyunTtsConfig, text: &str, audio_tx: &mpsc::Sender<Vec<u8>>,
    ctl: &PlayoutControl, warm: Option<Warm>, allow_cold_connect: bool, mut budget: FirstAudioBudget,
) -> Result<(u64, usize)> {
    // 证据日志:只落前 24 字+字数,不落全文(S2B1 canary 合同:完整文本不得进 journal;
    // 生产回复同策——排障按开头辨认句子,运维仍按 "tts synth" 关键词捞两条线)
    let head: String = text.chars().take(24).collect();
    info!("tts synth: {head}…({}字)", text.chars().count());
    let missing = cfg.missing_keys();
    if !missing.is_empty() {
        bail!("xfyun TTS 凭据缺失 {missing:?}");
    }

    // 超龄的预建连直接丢:14s 窗口从建连起算,过期后发文本会撞 26005 整句失败
    let usable = warm.filter(Warm::fresh);
    // 预建连自己花掉的握手时间:不在关键路径上,但要能对账「预热是不是真生效了」
    let warm_connect_ms = usable.as_ref().map(|w| w.connect_ms).unwrap_or(0);
    let used_warm = usable.is_some();
    let t0 = std::time::Instant::now();
    let (mut ws, connect_ms, connect_id) = match usable {
        Some(w) => (w.ws, 0, w.connect_id),
        None if !allow_cold_connect => bail!("tts_acquired_connection_expired"),
        None => {
            let url = build_auth_url(&cfg.api_key, &cfg.api_secret, TTS_URL, &rfc1123_now())?;
            let w = budget.wait("connect",connect_observed(url)).await??;
            (w.ws, w.connect_ms, w.connect_id)
        }
    };
    let (room,turn_id)=ctl.trace_identity();
    info!(room,turn_id,connect_id,used_warm,warm_connect_ms,connect_ms,"tts connection assigned");
    let send_start=std::time::Instant::now();
    let mut stream = StreamTiming {
        room, turn_id, connect_id, started: send_start, phase: "request_send",
        pending_since: Some(send_start), last_pcm: None, read_wait_ms: 0, max_read_wait_ms: 0,
        send_wait_ms: 0, max_send_wait_ms: 0, max_pcm_gap_ms: 0, pcm_frames: 0, completed: false,
    };

    budget.wait("send",ws.send(WsMessage::Text(build_request(cfg, text).to_string().into()))).await??;
    info!(room,turn_id,connect_id,send_ms=send_start.elapsed().as_millis() as u64,"tts request sent");
    stream.pending_since = None;
    let mut ttfb_ms: Option<u64> = None;
    let mut total = 0usize;
    let mut frames = 0usize;
    let mut cancelled = false;
    loop {
        stream.phase = "receive";
        let waiting = std::time::Instant::now();
        stream.pending_since = Some(waiting);
        let result = budget.wait("receive",tokio::time::timeout(RECV_TIMEOUT, ws.next())).await?;
        let waited = waiting.elapsed().as_millis() as u64;
        stream.pending_since = None;
        stream.read_wait_ms += waited;
        stream.max_read_wait_ms = stream.max_read_wait_ms.max(waited);
        let msg = result.context("xfyun tts recv timeout")?;
        let raw = match msg {
            Some(Ok(WsMessage::Text(t))) => t,
            Some(Ok(WsMessage::Close(f))) => bail!("xfyun tts ws closed: {f:?}"),
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(e.into()),
            None => bail!("xfyun tts ws ended unexpectedly"),
        };
        match parse_frame(&raw) {
            Downlink::Error(e) => bail!("xfyun tts 错误帧 {e}"),
            Downlink::Audio { pcm, last } => {
                if !pcm.is_empty() {budget.received_pcm();}
                let observed = std::time::Instant::now();
                if let Some(previous) = stream.last_pcm {
                    stream.max_pcm_gap_ms = stream.max_pcm_gap_ms.max(observed.duration_since(previous).as_millis() as u64);
                }
                stream.last_pcm = Some(observed);
                stream.pcm_frames += 1;
                if ttfb_ms.is_none() {
                    ttfb_ms = Some(t0.elapsed().as_millis() as u64);
                    let (room,turn_id)=ctl.trace_identity();
                    info!(room,turn_id,provider_ttfb_ms=ttfb_ms,connect_ms,used_warm,"tts provider first PCM observed");
                }
                total += pcm.len();
                frames += 1;
                stream.phase = "channel_send";
                let waiting = std::time::Instant::now();
                stream.pending_since = Some(waiting);
                let result = send_or_abort(audio_tx, pcm, ctl).await;
                let waited = waiting.elapsed().as_millis() as u64;
                stream.pending_since = None;
                stream.send_wait_ms += waited;
                stream.max_send_wait_ms = stream.max_send_wait_ms.max(waited);
                if let Err(why) = result {
                    // 打断/下游消失:主动收摊,不陪服务端把剩下的吐完(它停不了)
                    info!(reason = why, sent_bytes = total, "xfyun tts 中止本句,丢弃剩余音频");
                    cancelled = true;
                    let _ = ws.close(None).await;
                    emit_metrics(M { connect_ms, warm_connect_ms, used_warm, ttfb: ttfb_ms,
                                     frames, bytes: total, cancelled });
                    return Ok((ttfb_ms.unwrap_or(0), total));
                }
                if last {
                    break;
                }
            }
            Downlink::Ignore { last } => {
                if last {
                    break;
                }
            }
        }
    }
    stream.completed = true;
    stream.phase = "close";
    let _ = ws.close(None).await;
    emit_metrics(M { connect_ms, warm_connect_ms, used_warm, ttfb: ttfb_ms,
                     frames, bytes: total, cancelled });
    Ok((ttfb_ms.unwrap_or(0), total))
}

/// 脱敏遥测(Android 联调按此对账)。**绝不记**签名 URL / Authorization /
/// APPID / APIKey / APISecret / 音频正文 / 用户原文。
///
/// ⚠️ `buffered_audio_ms` 与 `underrun_count` **不在这里**——它们属播放侧,
/// 由 `playout.rs` 的 `BufferWatch` 每 turn 出一行 `playout metrics`。
/// TTS 模块看不到播放进度,不在这儿编一个假的。
struct M {
    connect_ms: u64,
    warm_connect_ms: u64,
    used_warm: bool,
    ttfb: Option<u64>,
    frames: usize,
    bytes: usize,
    cancelled: bool,
}

fn emit_metrics(m: M) {
    info!(
        tts_connect_ms = m.connect_ms,
        // warm=true 时 tts_connect_ms=0 且 tts_ttft_ms 从发文本起算,
        // 与 warm=false 的口径不同,对账时别混着比
        warm = m.used_warm,
        warm_connect_ms = m.warm_connect_ms,
        tts_ttft_ms = m.ttfb.unwrap_or(0),
        audio_frames = m.frames,
        // 24kHz PCM16 单声道:1ms = 48 bytes
        audio_duration_ms = (m.bytes / 48) as u64,
        cancelled = m.cancelled,
        "tts metrics"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn r22_first_pcm_deadline_is_shared_by_prewarm_connect_and_receive() {
        let b = FirstAudioBudget::new(Some(Duration::from_millis(100)));
        b.wait("prewarm",tokio::time::sleep(Duration::from_millis(60))).await.unwrap();
        let start=std::time::Instant::now();
        assert!(b.wait("connect",tokio::time::sleep(Duration::from_millis(80))).await.is_err());
        assert!(start.elapsed()<Duration::from_millis(75),"second stage cannot get a new budget");
    }

    #[tokio::test]
    async fn r22_status_frames_cannot_extend_first_pcm_but_long_audio_continues() {
        for delay_first in [true,false] {
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address=listener.local_addr().unwrap();
            let server=tokio::spawn(async move {
                let (socket,_)=listener.accept().await.unwrap();
                let mut ws=tokio_tungstenite::accept_async(socket).await.unwrap();
                ws.next().await.unwrap().unwrap();
                let frame=|last|WsMessage::Text(json!({"payload":{"audio":{"status":if last{2}else{1},"audio":B64.encode([0,1,0,2])}}}).to_string().into());
                if !delay_first {ws.send(frame(false)).await.unwrap();}
                for _ in 0..6 {
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    if ws.send(WsMessage::Text("{}".into())).await.is_err(){return;}
                }
                let _=ws.send(frame(true)).await;
                let _=ws.next().await;
            });
            let warm=connect_observed(format!("ws://{address}/")).await.unwrap();
            let (_rx,ctl)=crate::playout::test_control();let (tx,mut rx)=mpsc::channel(4);
            let result=synthesize_budgeted(&cfg(),"合成测试",&tx,&ctl,Some(warm),FirstAudioBudget::new(Some(Duration::from_millis(120)))).await;
            if delay_first {assert!(result.is_err());assert!(rx.try_recv().is_err());}
            else {assert_eq!(result.unwrap().1,8);assert_eq!(rx.try_recv().unwrap().len(),4);assert_eq!(rx.try_recv().unwrap().len(),4);}
            tokio::time::timeout(Duration::from_secs(1),server).await.unwrap().unwrap();
        }
    }

    #[tokio::test]
    async fn r15_connect_failure_reports_stage_without_response_headers_or_signed_url() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut input = [0; 2048]; socket.read(&mut input).await.unwrap();
            socket.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nX-Private: DO_NOT_LOG\r\n\r\n").await.unwrap();
        });
        let error = match connect_observed(format!("ws://{addr}/?authorization=DO_NOT_LOG")).await {
            Ok(_) => panic!("403 must reject the socket"), Err(e) => e,
        };
        server.await.unwrap();
        assert!(error.to_string().contains("stage=tls_ws"), "missing failure stage");
        assert!(error.to_string().contains("http_403"), "missing bounded status code");
        assert!(!format!("{error:?}").contains("DO_NOT_LOG"), "raw response or signed URL retained");
    }

    #[tokio::test]
    async fn r15_cancelled_handshake_releases_the_socket_without_detached_retry() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (sent, received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut input = [0; 2048]; socket.read(&mut input).await.unwrap();
            sent.send(()).unwrap();
            assert_eq!(socket.read(&mut input).await.unwrap(), 0, "cancelled handshake socket must close");
        });
        let attempt = tokio::spawn(connect_observed(format!("ws://{addr}/")));
        received.await.unwrap(); attempt.abort(); let _ = attempt.await;
        tokio::time::timeout(Duration::from_secs(1), server).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn r15_measured_connector_preserves_websocket_payload_and_freshness() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap(), "synthetic");
        });
        let mut warm = connect_observed(format!("ws://{addr}/")).await.unwrap();
        assert!(warm.fresh()); assert!(warm.connect_id > 0);
        warm.ws.send(WsMessage::Text("synthetic".into())).await.unwrap();
        server.await.unwrap();
    }

    fn cfg() -> XfyunTtsConfig {
        XfyunTtsConfig {
            app_id: "APPID".into(),
            api_key: "KEY".into(),
            api_secret: "SECRET".into(),
            vcn: DEFAULT_VCN.into(),
            speed: 50,
            oral_level: "mid".into(),
        }
    }

    #[test]
    fn auth_url_has_three_signed_params_and_is_deterministic() {
        let date = "Thu, 14 Aug 2026 17:48:53 GMT";
        let a = build_auth_url("KEY", "SECRET", TTS_URL, date).unwrap();
        let b = build_auth_url("KEY", "SECRET", TTS_URL, date).unwrap();
        assert_eq!(a, b, "同 date 必须签出同一 URL");
        let u = reqwest::Url::parse(&a).unwrap();
        let keys: Vec<_> = u.query_pairs().map(|(k, _)| k.to_string()).collect();
        for want in ["host", "date", "authorization"] {
            assert!(keys.contains(&want.to_string()), "缺 query 参数 {want}");
        }
        // path 不能被 query 拼装改写(endpoint 的产品路由段是协议一部分)
        assert_eq!(u.path(), "/v1/private/mcd9m97e6");
    }

    #[test]
    fn auth_signature_changes_with_date() {
        let a = build_auth_url("KEY", "SECRET", TTS_URL, "Thu, 14 Aug 2026 17:48:53 GMT").unwrap();
        let b = build_auth_url("KEY", "SECRET", TTS_URL, "Thu, 14 Aug 2026 17:48:54 GMT").unwrap();
        assert_ne!(a, b, "date 变了签名必须跟着变");
    }

    #[test]
    fn rfc1123_shape_is_gmt_not_offset() {
        let d = rfc1123_now();
        assert!(d.ends_with(" GMT"), "HTTP date 必须以 GMT 结尾,拿到 {d}");
        assert!(d.contains(", "), "缺星期几分隔,拿到 {d}");
    }

    #[test]
    fn request_text_is_base64_not_plaintext() {
        // 这条是回归锁:发明文会被讯飞拒(10009),曾在 Python 侧踩过
        let r = build_request(&cfg(), "你好");
        let t = r.pointer("/payload/text/text").unwrap().as_str().unwrap();
        assert_ne!(t, "你好", "text 不能是明文");
        assert_eq!(B64.decode(t).unwrap(), "你好".as_bytes());
    }

    #[test]
    fn request_audio_params_match_downlink_contract() {
        let r = build_request(&cfg(), "x");
        assert_eq!(r.pointer("/parameter/tts/audio/encoding").unwrap(), "raw");
        assert_eq!(r.pointer("/parameter/tts/audio/sample_rate").unwrap(), 24000);
        assert_eq!(r.pointer("/parameter/tts/audio/channels").unwrap(), 1);
        assert_eq!(r.pointer("/parameter/tts/audio/bit_depth").unwrap(), 16);
        // status 全 2 = 一句一会话,改了就不是这个协议了
        assert_eq!(r.pointer("/header/status").unwrap(), 2);
        assert_eq!(r.pointer("/payload/text/status").unwrap(), 2);
    }

    #[test]
    fn parse_audio_frame_and_last_flag() {
        let raw = json!({
            "header": {"code": 0},
            "payload": {"audio": {"audio": B64.encode([1u8, 2, 3]), "status": 1}}
        })
        .to_string();
        assert_eq!(parse_frame(&raw), Downlink::Audio { pcm: vec![1, 2, 3], last: false });

        let last = json!({
            "header": {"code": 0},
            "payload": {"audio": {"audio": B64.encode([9u8]), "status": 2}}
        })
        .to_string();
        assert_eq!(parse_frame(&last), Downlink::Audio { pcm: vec![9], last: true });
    }

    #[test]
    fn parse_error_frame_carries_code_and_message() {
        // 26016/25002 是实测撞到的复用错误码,解析必须能原样带出来供排障
        let raw = json!({"header": {"code": 26016, "message": "intput channel is closed"}})
            .to_string();
        match parse_frame(&raw) {
            Downlink::Error(e) => {
                assert!(e.contains("26016"), "错误码丢了: {e}");
                assert!(e.contains("intput channel is closed"), "错误消息丢了: {e}");
            }
            other => panic!("应判为错误帧,拿到 {other:?}"),
        }
    }

    #[test]
    fn parse_ignores_garbage_without_panicking() {
        assert_eq!(parse_frame("not json"), Downlink::Ignore { last: false });
        assert_eq!(parse_frame("{}"), Downlink::Ignore { last: false });
        // 末帧可以不带音频载荷,last 仍要被识别出来
        let tail = json!({"header": {"code": 0}, "payload": {"audio": {"status": 2}}}).to_string();
        assert_eq!(parse_frame(&tail), Downlink::Ignore { last: true });
    }

    /// 打断分支必须被真正执行过一次——编译通过证明不了它会退出。
    /// 构造:channel 塞满 + 下游不消费(= pause 期间的真实形态),然后置 abort。
    #[tokio::test]
    async fn send_or_abort_bails_when_aborted_instead_of_blocking_forever() {
        let (tx, _rx) = mpsc::channel::<Vec<u8>>(1);
        let (_guard, ctl) = crate::playout::test_control();
        tx.send(vec![0u8; 8]).await.unwrap(); // 占满容量 1
        ctl.abort();
        let r = tokio::time::timeout(
            Duration::from_secs(2),
            send_or_abort(&tx, vec![1u8; 8], &ctl),
        )
        .await;
        assert!(r.is_ok(), "abort 后必须返回,不能一直阻塞");
        assert_eq!(r.unwrap(), Err("aborted"));
    }

    /// 反向锚:没打断时不能误判成打断,否则上面那条恒绿也看不出来。
    /// ⚠️ `rx` 必须活到断言之后——若在 send 完成前被 drop,撞到的是 `Closed`
    /// 而不是正常送达,测出来的就是另一条分支(第一版就栽在这)。
    #[tokio::test]
    async fn send_or_abort_delivers_normally_when_not_aborted() {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(1);
        let (_guard, ctl) = crate::playout::test_control();
        tx.send(vec![0u8; 8]).await.unwrap(); // 占满容量 1,逼 send_or_abort 进等待循环
        let drain = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            rx.recv().await // 腾出一格,模拟下游恢复消费
        };
        let (sent, got) = tokio::join!(send_or_abort(&tx, vec![7u8; 8], &ctl), drain);
        assert_eq!(sent, Ok(()), "未打断时必须正常送达");
        assert!(got.is_some());
    }

    #[test]
    fn warm_max_age_must_stay_under_protocol_idle_limit() {
        // 这条是防腐:14s 是服务端实测的硬上限(建连后无上行即 26005)。
        // 谁要是把 WARM_MAX_AGE 调到 >=14s,预建连就会在取用时刚好撞上关闭,
        // 表现是**整句合成失败**而不是慢一点——必须在这里先红。
        assert!(
            WARM_MAX_AGE < PROTOCOL_IDLE_LIMIT,
            "预建连安全窗 {WARM_MAX_AGE:?} 必须小于协议上限 {PROTOCOL_IDLE_LIMIT:?}"
        );
        // 也别留太少余量,否则预建连基本每次都被判超龄=白建
        assert!(WARM_MAX_AGE >= Duration::from_secs(8), "余量留太多就等于没预热");
    }

    #[test]
    fn stale_warm_is_rejected_fresh_one_kept() {
        assert!(warm_is_fresh(Duration::from_secs(0)), "刚建的必须可用");
        assert!(warm_is_fresh(WARM_MAX_AGE - Duration::from_millis(1)));
        // 反向锚:到点必须判死,否则上面几条恒绿
        assert!(!warm_is_fresh(WARM_MAX_AGE), "到龄必须丢弃");
        assert!(!warm_is_fresh(PROTOCOL_IDLE_LIMIT), "超协议上限更要丢弃");
    }

    #[test]
    fn missing_keys_reports_each_absent_credential() {
        let mut c = cfg();
        assert!(c.missing_keys().is_empty());
        c.api_secret.clear();
        assert_eq!(c.missing_keys(), vec!["XFYUN_TTS_API_SECRET"]);
        c.app_id.clear();
        assert_eq!(c.missing_keys(), vec!["XFYUN_TTS_APP_ID", "XFYUN_TTS_API_SECRET"]);
    }
}

// Characterization fixtures for the unresolved production transport incident.
// These exercise the real WebSocket synthesis path, but do NOT prove the
// historical supplier/network fault or count as a production fix.
#[cfg(test)]
mod priority_transport_diagnostics {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

    #[tokio::test]
    async fn priority_real_handshake_hang_recovers_one_request_and_closes_loser() {
        use tokio::io::AsyncReadExt;
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url=format!("ws://{}/synthetic",listener.local_addr().unwrap());
        let requests=Arc::new(AtomicUsize::new(0));let count=requests.clone();
        let server=tokio::spawn(async move {
            let (mut hung,_) = listener.accept().await.unwrap();
            let loser=tokio::spawn(async move {
                let mut buf=[0;4096];assert!(hung.read(&mut buf).await.unwrap()>0);
                assert_eq!(hung.read(&mut buf).await.unwrap(),0,"losing handshake must close");
            });
            let (socket,_) = listener.accept().await.unwrap();
            let mut ws=tokio_tungstenite::accept_async(socket).await.unwrap();
            assert!(ws.next().await.unwrap().unwrap().is_text());count.fetch_add(1,Ordering::SeqCst);
            ws.send(WsMessage::Text(json!({"header":{"code":0},"payload":{"audio":{"audio":B64.encode(vec![1;4800]),"status":2}}}).to_string().into())).await.unwrap();
            let _=ws.next().await;
            loser.await.unwrap();
        });
        let limit=tokio::sync::Semaphore::new(1);let start=std::time::Instant::now();
        let warm=crate::tts::recover_connection(connect_observed(url.clone()),||connect_observed(url),
            Duration::from_millis(30),Duration::from_secs(2),&limit).await.unwrap();
        assert!(start.elapsed()<Duration::from_secs(1));
        let (_guard,ctl)=crate::playout::test_control();let (tx,mut rx)=mpsc::channel(32);
        let (_,bytes)=synthesize_connected(&config(),"隔离测试。",&tx,&ctl,warm).await.unwrap();
        assert_eq!(bytes,4800);assert_eq!(rx.try_recv().unwrap().len(),4800);assert!(rx.try_recv().is_err());
        tokio::time::timeout(Duration::from_secs(2),server).await.unwrap().unwrap();
        assert_eq!(requests.load(Ordering::SeqCst),1);assert_eq!(limit.available_permits(),1);
    }

    #[tokio::test]
    async fn priority_connected_expired_socket_fails_without_hidden_cold_connection() {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url=format!("ws://{}/",listener.local_addr().unwrap());
        let server=tokio::spawn(async move {
            let (socket,_)=listener.accept().await.unwrap();
            let mut ws=tokio_tungstenite::accept_async(socket).await.unwrap();
            assert!(!matches!(ws.next().await,Some(Ok(WsMessage::Text(_)))),"expired socket must receive no text");
        });
        let mut warm=connect_observed(url).await.unwrap();
        warm.opened=std::time::Instant::now()-Duration::from_secs(13);
        let (_guard,ctl)=crate::playout::test_control();let (tx,mut rx)=mpsc::channel(32);
        let result=tokio::time::timeout(Duration::from_millis(100),synthesize_connected(&config(),"隔离测试。",&tx,&ctl,warm)).await.unwrap();
        assert!(result.unwrap_err().to_string().contains("tts_acquired_connection_expired"));
        assert!(rx.try_recv().is_err());server.await.unwrap();
    }

    async fn fixture(mode: &'static str) -> (Warm, tokio::task::JoinHandle<()>, Arc<AtomicUsize>) {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = server.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let task = tokio::spawn(async move {
            let (socket, _) = server.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let request = ws.next().await.unwrap().unwrap();
            assert!(request.is_text());
            count.fetch_add(1, Ordering::SeqCst);
            let pcm = vec![1_u8; 4800]; // 100 ms at 24 kHz PCM16; synthetic bytes.
            let frame = |last| WsMessage::Text(json!({"header":{"code":0},"payload":{"audio":{"audio":B64.encode(&pcm),"status":if last {2}else{1}}}}).to_string().into());
            if mode != "zero_pcm_close" { ws.send(frame(false)).await.unwrap(); }
            if mode == "midstream_stall" || mode == "two_second_stall" {
                tokio::time::sleep(Duration::from_millis(if mode == "two_second_stall" {2000}else{500})).await;
                ws.send(frame(true)).await.unwrap();
                let _ = tokio::time::timeout(Duration::from_secs(1),ws.next()).await;
            } else { let _ = ws.close(None).await; }
        });
        let socket = tokio::net::TcpStream::connect(address).await.unwrap();
        let (ws, _) = tokio_tungstenite::client_async(
            format!("ws://{address}/synthetic"), tokio_tungstenite::MaybeTlsStream::Plain(socket)
        ).await.unwrap();
        (Warm {ws,opened:std::time::Instant::now(),connect_ms:0,connect_id:990001},task,requests)
    }
    fn config() -> XfyunTtsConfig {
        XfyunTtsConfig {app_id:"fixture".into(),api_key:"fixture".into(),api_secret:"fixture".into(),vcn:DEFAULT_VCN.into(),speed:50,oral_level:"mid".into()}
    }
    #[tokio::test]
    async fn priority_real_ws_midstream_gap_is_not_channel_backpressure() {
        let (warm, server, count) = fixture("midstream_stall").await;
        let (_guard, ctl) = crate::playout::test_control();
        let (tx,mut rx) = mpsc::channel(32);
        let task=tokio::spawn(async move { synthesize_connected(&config(),"隔离测试。",&tx,&ctl,warm).await });
        let first=tokio::time::timeout(Duration::from_secs(2),rx.recv()).await.unwrap().unwrap();
        let start=std::time::Instant::now();
        assert_eq!(first.len(),4800);assert_eq!(rx.capacity(),32);
        let second=tokio::time::timeout(Duration::from_secs(2),rx.recv()).await.unwrap().unwrap();
        assert_eq!(second.len(),4800);assert!(start.elapsed()>=Duration::from_millis(400));
        let (_, bytes)=task.await.unwrap().unwrap();assert_eq!(bytes,9600);
        server.await.unwrap();assert_eq!(count.load(Ordering::SeqCst),1);
    }
    #[tokio::test]
    async fn priority_real_ws_partial_close_has_delivered_pcm_and_no_replay() {
        let (warm,server,count)=fixture("partial_close").await;
        let (_guard,ctl)=crate::playout::test_control();let (tx,mut rx)=mpsc::channel(32);
        let result=synthesize_connected(&config(),"隔离测试。",&tx,&ctl,warm).await;
        assert!(result.is_err());assert_eq!(rx.try_recv().unwrap().len(),4800);
        assert!(rx.try_recv().is_err());server.await.unwrap();assert_eq!(count.load(Ordering::SeqCst),1);
    }
    #[tokio::test]
    async fn priority_real_ws_zero_pcm_close_is_distinct_from_partial_output() {
        let (warm,server,count)=fixture("zero_pcm_close").await;
        let (_guard,ctl)=crate::playout::test_control();let (tx,mut rx)=mpsc::channel(32);
        assert!(synthesize_connected(&config(),"隔离测试。",&tx,&ctl,warm).await.is_err());
        assert!(rx.try_recv().is_err());server.await.unwrap();assert_eq!(count.load(Ordering::SeqCst),1);
    }

    #[tokio::test]
    async fn priority_real_ws_two_second_supply_gap_reaches_native_playout() {
        use livekit::webrtc::audio_source::native::NativeAudioSource;
        let (warm,server,count)=fixture("two_second_stall").await;
        let source=NativeAudioSource::new(Default::default(),24000,1,200);
        let (tx,rx)=mpsc::channel(32);
        let (playout,ctl)=crate::playout::spawn_playout(source,rx,"isolated-supply-gap".into(),1,None);
        let (_,bytes)=synthesize_connected(&config(),"隔离测试。",&tx,&ctl,warm).await.unwrap();
        assert_eq!(bytes,9600);drop(tx);
        tokio::time::timeout(Duration::from_secs(3),playout).await.unwrap().unwrap();
        let stats=ctl.final_stats_handle().lock().unwrap().clone().unwrap();
        assert!(stats.completed);assert_eq!(stats.played_frames,20);
        assert!(stats.underrun_count>=1);assert!(stats.underrun_ms>=1700);
        server.await.unwrap();assert_eq!(count.load(Ordering::SeqCst),1);
    }

    #[tokio::test]
    async fn priority_real_ws_full_channel_waits_without_reconnect_or_losing_pcm() {
        let (warm,server,count)=fixture("midstream_stall").await;
        let (_guard,ctl)=crate::playout::test_control();let (tx,mut rx)=mpsc::channel(1);
        let task=tokio::spawn(async move{synthesize_connected(&config(),"隔离测试。",&tx,&ctl,warm).await});
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert!(!task.is_finished(),"second PCM should be waiting for channel capacity");
        let mut bytes=0;
        while let Some(pcm)=tokio::time::timeout(Duration::from_secs(2),rx.recv()).await.unwrap(){bytes+=pcm.len();}
        assert_eq!(bytes,9600);assert_eq!(task.await.unwrap().unwrap().1,bytes);
        server.await.unwrap();assert_eq!(count.load(Ordering::SeqCst),1);
    }
    #[tokio::test]
    async fn candidate_recovery_keeps_first_pcm_deadline_and_never_replays_text() {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {
            let (socket,_)=listener.accept().await.unwrap();
            let mut ws=tokio_tungstenite::accept_async(socket).await.unwrap();
            let request=ws.next().await.unwrap().unwrap();
            assert!(request.is_text());
            // The remaining first-PCM budget expires here. No second request.
            assert!(!matches!(ws.next().await,Some(Ok(WsMessage::Text(_)))));
        });
        let warm=connect_observed(format!("ws://{addr}/")).await.unwrap();
        let budget=FirstAudioBudget::new(Some(Duration::from_millis(160)));
        let limit=tokio::sync::Semaphore::new(1);
        let connection=budget.wait("connect_recovery",crate::tts::recover_connection(
            async {tokio::time::sleep(Duration::from_millis(90)).await;Ok(warm)},
            ||async {panic!("healthy primary must not open a spare")},
            Duration::from_millis(650),Duration::from_secs(10),&limit)).await.unwrap().unwrap();
        let (_rx,ctl)=crate::playout::test_control();let (tx,mut rx)=mpsc::channel(4);
        let start=std::time::Instant::now();
        let error=synthesize_connected_budgeted(&config(),"合成测试",&tx,&ctl,connection,budget).await.unwrap_err();
        assert!(first_audio_timed_out(&error),"pipeline must retain the typed first-audio failure");
        assert!(start.elapsed()<Duration::from_millis(140),"acquisition cannot reset the first-PCM budget");
        assert!(rx.try_recv().is_err());assert_eq!(limit.available_permits(),1);
        tokio::time::timeout(Duration::from_secs(1),server).await.unwrap().unwrap();
    }

}
