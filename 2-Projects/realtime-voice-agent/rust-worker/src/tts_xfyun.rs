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
//! ⚠️ **与 `tts_volc` 的核心结构差异:严格一句一会话,连接不可复用,因此本模块没有连接池、
//! 也没有 prewarm。** 2026-08-14 四场景实测:
//! | 场景 | 结果 |
//! |---|---|
//! | 句1 收尾后**无空闲**立刻发句2 | `code=26016 intput channel is closed` |
//! | 空闲 5s 后发句2 | `code=25002 task is not found in cache` |
//! | 空闲 15s 后发句2 | 服务端主动 CLOSE |
//! | 空闲 35s 后发句2 | 连接已关闭中,send 直接失败 |
//!
//! 关键是第一行——**连空闲都没有就已被拒**,所以这不是空闲超时问题,是协议设计如此;
//! 请求体里也没有任何超时字段,不存在"调高"的余地。别再尝试给它加池(那是 volc 的形状)。
//!
//! 裸协议首包实测 **260–266ms**(已含每句建连成本),对照火山 Rust 线生产 400–550ms。

use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use tokio::sync::mpsc;
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

/// 合成一句:PCM(24k i16le bytes)分块经 `audio_tx` 发出。返回 (ttfb_ms, total_bytes)。
/// 每句独立 WS 会话——见模块头,不要给它加池。
pub async fn synthesize(
    cfg: &XfyunTtsConfig,
    text: &str,
    audio_tx: &mpsc::Sender<Vec<u8>>,
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

    ws.send(WsMessage::Text(build_request(cfg, text).to_string().into())).await?;

    let mut ttfb_ms: Option<u64> = None;
    let mut total = 0usize;
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
                if audio_tx.send(pcm).await.is_err() {
                    // 下游关闭=被打断。讯飞无连接池,直接收摊即可,无残留污染问题。
                    let _ = ws.close(None).await;
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
    Ok((ttfb_ms.unwrap_or(0), total))
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
