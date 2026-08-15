//! TTS provider 分发层(2026-08-14 引入)。
//!
//! 在此之前 TTS 是硬编码火山的,`pipeline` 直接 `use crate::tts_volc`。
//! P003 读写台线要用讯飞聆小璇(`x6_lingxiaoxuan_pro`)与设备现有 demo 音色统一,
//! 故加这一层薄分发,**调用方不再感知 provider**。
//!
//! ⚠️ 两家的结构差异很大,别指望它们对称:
//! - 火山 = 双向流式长连 + **进程级连接池** + prewarm(首句零建连)
//! - 讯飞 = 一句一会话,**用过的连接不可复用**,所以没有进程级池;
//!   省建连靠 **turn 级预建连流水线**(`Prewarm`):turn 一开始就握手,
//!   之后每句在合成的同时为下一句握好手。两者不是一回事,别把讯飞塞进池语义里。
//!
//! **STT 不在此列**:判停 401ms 依赖火山 ASR 的 B5 伪 final 机制,讯飞无此能力,
//! STT 保持火山不变。换 TTS 不影响判停——这是两条独立的链路。

use anyhow::{bail, Result};
use tokio::sync::mpsc;

use crate::playout::PlayoutControl;
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

    /// 起一条 turn 级预建连流水线。**turn 一开始就调**(与 LLM 并行),
    /// 这样第一句拿到的是已经握好手的连接。
    ///
    /// 火山有进程级池,不需要,返回 `Off`。
    pub fn start_prewarm(&self) -> Prewarm {
        match self {
            Self::Volc(_) => Prewarm::off(),
            // 环境开关:置 0 即退回「每句现连」的旧行为,不必换二进制
            Self::Xfyun(c) if preconnect_enabled() => Prewarm::arm(c.clone()),
            Self::Xfyun(_) => Prewarm::off(),
        }
    }

    /// 合成一句,PCM(24k i16le)分块经 `audio_tx` 发出。返回 (ttfb_ms, total_bytes)。
    ///
    /// `ctl` 用于在**打断期间**及时收摊:打断走 `pause()` 而非 drop receiver,
    /// 裸 `send().await` 会一直阻塞。详见 `tts_xfyun::send_or_abort` 的说明。
    /// ⚠️ **volc 侧本次不接**——它有同款隐患但被高吐流速度掩盖着,
    /// 改它属于行为变更,留到单独一轮(届时要列变更清单)。
    ///
    /// `warm` 取走本句要用的预建连,并**立刻为下一句重新预建**——
    /// 于是下一句的握手与本句的合成同时进行。
    pub async fn synthesize(
        &self,
        text: &str,
        audio_tx: &mpsc::Sender<Vec<u8>>,
        ctl: &PlayoutControl,
        warm: &mut Prewarm,
    ) -> Result<(u64, usize)> {
        match self {
            Self::Volc(c) => tts_volc::synthesize(c, text, audio_tx).await,
            Self::Xfyun(c) => {
                let conn = warm.take().await;
                *warm = self.start_prewarm(); // 先为下一句排队,再开始本句合成
                tts_xfyun::synthesize(c, text, audio_tx, ctl, conn).await
            }
        }
    }
}

/// `XFYUN_TTS_PRECONNECT=0` 关掉预建连(回到每句现连)。
/// 留这个开关是因为这条线正在被演示:出问题时改一行 env + 重启即可退回,
/// 不用换二进制。默认开。
fn preconnect_enabled() -> bool {
    preconnect_from(std::env::var("XFYUN_TTS_PRECONNECT").ok().as_deref())
}

/// 纯函数版,单测走这条(进程级 env 会被并行测试互相污染)。
fn preconnect_from(v: Option<&str>) -> bool {
    v != Some("0")
}

/// turn 级预建连句柄:后台正在握手的那条连接。
///
/// ⚠️ 内部用 `Option` 而不是 `enum { Off, On(handle) }`:本类型有 `Drop`,
/// 带 `Drop` 的类型不允许解构移出字段(E0509),`Option::take` 才能拿走 handle。
pub struct Prewarm(Option<tokio::task::JoinHandle<Result<tts_xfyun::Warm>>>);

impl Prewarm {
    /// 关闭态(火山线,或 `XFYUN_TTS_PRECONNECT=0`)
    const fn off() -> Self {
        Self(None)
    }

    fn arm(cfg: tts_xfyun::XfyunTtsConfig) -> Self {
        Self(Some(tokio::spawn(async move { tts_xfyun::connect_warm(&cfg).await })))
    }

    /// 取走已建好的连接。建连失败/被取消**不算错误**——
    /// 返回 None,调用方现连即可,预热失败绝不能让整句合成失败。
    async fn take(&mut self) -> Option<tts_xfyun::Warm> {
        match self.0.take() {
            None => None,
            Some(h) => match h.await {
                Ok(Ok(w)) => Some(w),
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "xfyun 预建连失败,本句改为现连");
                    None
                }
                Err(_) => None, // task 被 abort(turn 结束)
            },
        }
    }
}

impl Drop for Prewarm {
    /// turn 最后一句之后还会预建一条,没人用。abort 掉,别让它挂着占 fd。
    fn drop(&mut self) {
        if let Some(h) = &self.0 {
            h.abort();
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
    fn preconnect_defaults_on_and_only_literal_zero_turns_it_off() {
        assert!(preconnect_from(None), "缺省必须是开");
        assert!(preconnect_from(Some("1")));
        assert!(!preconnect_from(Some("0")), "写 0 必须关,这是不换二进制的回滚路径");
        // 写错值不该静默关掉预热(那是性能悄悄退化,没人会发现)
        assert!(preconnect_from(Some("false")), "只认字面 0,别的值一律当开");
    }

    #[tokio::test]
    async fn volc_never_arms_a_prewarm_xfyun_does() {
        // 火山有进程级池,起预建连就是白建连接。这条同时是 xfyun 那条的反向锚。
        let mut volc = TtsCfg::build("volc").unwrap().start_prewarm();
        assert!(volc.0.is_none(), "火山线不该起预建连");
        assert!(volc.take().await.is_none());

        let x = TtsCfg::Xfyun(tts_xfyun::XfyunTtsConfig {
            app_id: "a".into(),
            api_key: "k".into(),
            api_secret: "s".into(),
            vcn: tts_xfyun::DEFAULT_VCN.into(),
            speed: 50,
            oral_level: "mid".into(),
        });
        let w = x.start_prewarm();
        assert!(w.0.is_some(), "讯飞线必须真的起了一条后台建连");
        // drop 必须把它 abort 掉,不留悬空 task 占 fd
    }

    #[tokio::test]
    async fn prewarm_failure_degrades_to_none_not_error() {
        // 凭据是假的,建连必失败。判据:take() 回 None(调用方现连),而不是把错误抛上去
        // ——预热失败绝不能让整句合成失败。
        let x = TtsCfg::Xfyun(tts_xfyun::XfyunTtsConfig {
            app_id: "bad".into(),
            api_key: "bad".into(),
            api_secret: "bad".into(),
            vcn: tts_xfyun::DEFAULT_VCN.into(),
            speed: 50,
            oral_level: "mid".into(),
        });
        let mut w = x.start_prewarm();
        assert!(w.take().await.is_none(), "建连失败必须降级为 None");
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

