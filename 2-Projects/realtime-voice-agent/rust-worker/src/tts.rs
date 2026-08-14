//! TTS provider 分发层(2026-08-14 引入)。
//!
//! 在此之前 TTS 是硬编码火山的,`pipeline` 直接 `use crate::tts_volc`。
//! P003 读写台线要用讯飞聆小璇(`x6_lingxiaoxuan_pro`)与设备现有 demo 音色统一,
//! 故加这一层薄分发,**调用方不再感知 provider**。
//!
//! ⚠️ 两家的结构差异很大,别指望它们对称:
//! - 火山 = 双向流式长连 + 进程级连接池 + prewarm(首句零建连)
//! - 讯飞 = **严格一句一会话,连接不可复用**,故 `prewarm` 是空实现
//!   (原因与实测见 `tts_xfyun` 模块头,不要给讯飞加池)
//!
//! **STT 不在此列**:判停 401ms 依赖火山 ASR 的 B5 伪 final 机制,讯飞无此能力,
//! STT 保持火山不变。换 TTS 不影响判停——这是两条独立的链路。

use anyhow::{bail, Result};
use tokio::sync::mpsc;

use crate::{tts_volc, tts_xfyun};

/// ⚠️ **刻意不 derive `Debug`**:内含 `api_secret`/`access_token`,
/// 一旦有 Debug 实现,任何 `{:?}`(含 `unwrap_err`、panic 消息、tracing 字段)
/// 都可能把凭据打进日志。需要可读标识用 `provider_name()` / `voice()`。
#[derive(Clone)]
pub enum TtsCfg {
    Volc(tts_volc::TtsConfig),
    Xfyun(tts_xfyun::XfyunTtsConfig),
}

impl TtsCfg {
    /// 按 `TTS_PROVIDER` 选择;缺省 volc(保持既有行为,新线显式配置才切)。
    pub fn from_env() -> Result<Self> {
        Self::build(&std::env::var("TTS_PROVIDER").unwrap_or_else(|_| "volc".into()))
    }

    /// 真实分发逻辑。单独抽出来是为了让单测能直接喂 provider 名走同一条路径,
    /// 不必改进程级 env(并行测试会互相污染),也不必在测试里复述一遍错误文案。
    pub(crate) fn build(provider: &str) -> Result<Self> {
        match provider {
            "volc" => Ok(Self::Volc(tts_volc::TtsConfig::from_env())),
            "xfyun" => {
                let cfg = tts_xfyun::XfyunTtsConfig::from_env();
                // 启动期就报凭据缺失,别等用户说了第一句才在 job 里炸
                let missing = cfg.missing_keys();
                if !missing.is_empty() {
                    bail!("TTS_PROVIDER=xfyun 但凭据缺失 {missing:?}");
                }
                Ok(Self::Xfyun(cfg))
            }
            other => bail!("未知 TTS_PROVIDER={other:?}(支持:volc/xfyun)"),
        }
    }

    pub fn provider_name(&self) -> &'static str {
        match self {
            Self::Volc(_) => "volc",
            Self::Xfyun(_) => "xfyun",
        }
    }

    /// 音色标识(进启动日志,让"听到的声音不对"能一眼对账)
    pub fn voice(&self) -> &str {
        match self {
            Self::Volc(c) => &c.speaker,
            Self::Xfyun(c) => &c.vcn,
        }
    }

    /// job 启动时预热。火山=预建池连接;讯飞=空操作(协议不允许复用)。
    pub async fn prewarm(&self) {
        match self {
            Self::Volc(c) => tts_volc::prewarm_pool(c).await,
            Self::Xfyun(c) => tts_xfyun::prewarm_pool(c).await,
        }
    }

    /// 合成一句,PCM(24k i16le)分块经 `audio_tx` 发出。返回 (ttfb_ms, total_bytes)。
    pub async fn synthesize(
        &self,
        text: &str,
        audio_tx: &mpsc::Sender<Vec<u8>>,
    ) -> Result<(u64, usize)> {
        match self {
            Self::Volc(c) => tts_volc::synthesize(c, text, audio_tx).await,
            Self::Xfyun(c) => tts_xfyun::synthesize(c, text, audio_tx).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_rate_is_uniform_across_providers() {
        // playout/job/filler 直接用 tts_volc::TTS_SAMPLE_RATE 且不按 provider 分支,
        // 前提就是两家相同。任一家改了采样率,这里先红。
        assert_eq!(tts_volc::TTS_SAMPLE_RATE, tts_xfyun::TTS_SAMPLE_RATE);
        assert_eq!(tts_volc::TTS_SAMPLE_RATE, 24_000);
    }

    #[test]
    fn unknown_provider_is_rejected_not_silently_defaulted() {
        // 静默回落到 volc = 配错了却听到男声还查不出原因,必须 fail fast。
        // 走 build() 真实分发,不是在测试里复述错误文案。
        // 不用 unwrap_err():那要求 TtsCfg: Debug,而它握着凭据,不能有 Debug。
        let e = match TtsCfg::build("wenxin") {
            Ok(_) => panic!("未知 provider 必须被拒绝"),
            Err(e) => e,
        };
        assert!(e.to_string().contains("未知 TTS_PROVIDER"), "{e}");
        // 反向锚:合法 provider 必须不走这条分支,否则上面那条恒绿也看不出来
        assert!(TtsCfg::build("volc").is_ok(), "volc 应被接受");
    }

    #[test]
    fn xfyun_without_credentials_fails_at_startup() {
        let bare = tts_xfyun::XfyunTtsConfig {
            app_id: String::new(),
            api_key: String::new(),
            api_secret: String::new(),
            vcn: tts_xfyun::DEFAULT_VCN.into(),
            speed: 50,
            oral_level: "mid".into(),
        };
        assert_eq!(bare.missing_keys().len(), 3);
    }

    #[test]
    fn provider_name_and_voice_are_reported_for_log_reconciliation() {
        let x = TtsCfg::Xfyun(tts_xfyun::XfyunTtsConfig {
            app_id: "a".into(),
            api_key: "k".into(),
            api_secret: "s".into(),
            vcn: tts_xfyun::DEFAULT_VCN.into(),
            speed: 50,
            oral_level: "mid".into(),
        });
        assert_eq!(x.provider_name(), "xfyun");
        assert_eq!(x.voice(), "x6_lingxiaoxuan_pro");
    }
}

