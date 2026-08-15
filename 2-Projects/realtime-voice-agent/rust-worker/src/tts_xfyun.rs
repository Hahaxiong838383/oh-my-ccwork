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
//!   closed`。故**本模块当前不做连接池、也没有 prewarm**(每句一条 WS,建连约 267ms)。
//! - ⚠️ **但这不等于"协议不支持复用"**。`payload.text.status` 支持 0/1/2,
//!   实测 `0→2` 与 `0→1→2` 分段流式喂文本**均成功**。我最初只试了 `status=2`
//!   (=告诉服务端"文本到此为止",输入通道随即关闭——错误消息字面就在说这件事),
//!   却把结论写成了"协议不支持复用",判据作用域过宽。
//! - 硬约束是 **14 秒无上行数据**(实测:间隔 3/8/11s 均成功,15s 报
//!   `26005 No active up data within 14000 ms`)。文档写的 10s 与"前 20 字需 25 字/秒"
//!   均**非硬约束**——实测 2 字/秒照样跑通。
//! - **无取消/中止指令**(官方文档确认)。整句一次性发出后服务端一定吐完,
//!   打断时 worker 只能丢弃,停不了上游 → 见 `send_or_abort`。
//!
//! 首包:**含建连 527ms**(Rust 线生产实测) / **不含建连 248–275ms**。
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
use tracing::info;

pub const TTS_SAMPLE_RATE: u32 = 24_000;
/// 超拟人 endpoint(path 含产品固定路由段,勿改)
const TTS_URL: &str = "wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6";
pub const DEFAULT_VCN: &str = "x6_lingxiaoxuan_pro";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RECV_TIMEOUT: Duration = Duration::from_secs(30);

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

/// 与 `tts_volc::prewarm_pool` 同名占位:讯飞不可复用连接,预热无意义。
/// 保留空实现是为了让 provider 分发层形状一致,调用方无需分支。
pub async fn prewarm_pool(_cfg: &XfyunTtsConfig) {}

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
/// 每句独立 WS 会话——见模块头,不要给它加池。
pub async fn synthesize(
    cfg: &XfyunTtsConfig,
    text: &str,
    audio_tx: &mpsc::Sender<Vec<u8>>,
    ctl: &PlayoutControl,
) -> Result<(u64, usize)> {
    info!("tts synth: {text}"); // 证据日志,与 volc 线同措辞(运维按同一关键词捞两条线)
    let missing = cfg.missing_keys();
    if !missing.is_empty() {
        bail!("xfyun TTS 凭据缺失 {missing:?}");
    }

    let t0 = std::time::Instant::now();
    let url = build_auth_url(&cfg.api_key, &cfg.api_secret, TTS_URL, &rfc1123_now())?;
    let (mut ws, _) = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async(url.into_client_request()?),
    )
    .await
    .context("xfyun tts connect timeout")?
    .context("xfyun tts connect(检查 api_key/api_secret)")?;
    let connect_ms = t0.elapsed().as_millis() as u64;

    ws.send(WsMessage::Text(build_request(cfg, text).to_string().into())).await?;

    let mut ttfb_ms: Option<u64> = None;
    let mut total = 0usize;
    let mut frames = 0usize;
    let mut cancelled = false;
    loop {
        let msg = tokio::time::timeout(RECV_TIMEOUT, ws.next())
            .await
            .context("xfyun tts recv timeout")?;
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
                if ttfb_ms.is_none() {
                    ttfb_ms = Some(t0.elapsed().as_millis() as u64);
                }
                total += pcm.len();
                frames += 1;
                if let Err(why) = send_or_abort(audio_tx, pcm, ctl).await {
                    // 打断/下游消失:主动收摊,不陪服务端把剩下的吐完(它停不了)
                    info!(reason = why, sent_bytes = total, "xfyun tts 中止本句,丢弃剩余音频");
                    cancelled = true;
                    let _ = ws.close(None).await;
                    emit_metrics(connect_ms, ttfb_ms, frames, total, cancelled);
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
    let _ = ws.close(None).await;
    emit_metrics(connect_ms, ttfb_ms, frames, total, cancelled);
    Ok((ttfb_ms.unwrap_or(0), total))
}

/// 脱敏遥测(Android 联调按此对账)。**绝不记**签名 URL / Authorization /
/// APPID / APIKey / APISecret / 音频正文 / 用户原文。
///
/// ⚠️ 七项指标里这里只出五项:`buffered_audio_ms` 与 `underrun_count` 属**播放侧**
/// (`playout.rs` 的 RTC 喂帧循环),TTS 模块看不到播放进度,不能在这里编。
fn emit_metrics(connect_ms: u64, ttfb: Option<u64>, frames: usize, bytes: usize, cancelled: bool) {
    info!(
        tts_connect_ms = connect_ms,
        tts_ttft_ms = ttfb.unwrap_or(0),
        audio_frames = frames,
        // 24kHz PCM16 单声道:1ms = 48 bytes
        audio_duration_ms = (bytes / 48) as u64,
        cancelled,
        "tts metrics"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn missing_keys_reports_each_absent_credential() {
        let mut c = cfg();
        assert!(c.missing_keys().is_empty());
        c.api_secret.clear();
        assert_eq!(c.missing_keys(), vec!["XFYUN_TTS_API_SECRET"]);
        c.app_id.clear();
        assert_eq!(c.missing_keys(), vec!["XFYUN_TTS_APP_ID", "XFYUN_TTS_API_SECRET"]);
    }
}
