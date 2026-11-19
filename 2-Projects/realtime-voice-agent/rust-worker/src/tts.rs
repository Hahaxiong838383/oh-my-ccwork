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
                let waiting = std::time::Instant::now();
                let (room,turn)=ctl.trace_identity();
                let mut timing=DispatchTiming{start:waiting,room:room.into(),turn,prewarm_ms:None,finished:false};
                let recovery = connection_recovery_mode();
                let conn = if recovery {
                    let acquired = warm.take_for_sentence(c).await;
                    // Preserve the pipeline for the following sentence even if
                    // this acquisition failed; the old candidate is already gone.
                    *warm = self.start_prewarm();
                    Some(acquired?)
                } else {
                    warm.take().await
                };
                let wait_ms = waiting.elapsed().as_millis() as u64;
                timing.prewarm_ms=Some(wait_ms);
                if !recovery { *warm = self.start_prewarm(); }
                let (provider_ms, bytes) = if recovery {
                    // No hidden cold reconnect after the shared acquisition budget.
                    tts_xfyun::synthesize_connected(c, text, audio_tx, ctl, conn.expect("acquired connection")).await?
                } else {
                    tts_xfyun::synthesize(c, text, audio_tx, ctl, conn).await?
                };
                // The caller starts its timer before take(): include the handshake
                // wait that used to disappear from body_ready_since_turn_ms.
                timing.finished=true;
                let first_pcm_ms = wait_ms.saturating_add(provider_ms);
                tracing::info!(prewarm_wait_ms=wait_ms,provider_ttfb_ms=provider_ms,first_pcm_ms,"tts dispatch timing");
                Ok((first_pcm_ms, bytes))
            }
        }
    }
}

/// Emits even when the synth future is dropped mid-handshake/provider streaming.
struct DispatchTiming {start:std::time::Instant,room:String,turn:u64,prewarm_ms:Option<u64>,finished:bool}
impl Drop for DispatchTiming {fn drop(&mut self){tracing::info!(room=%self.room,turn_id=self.turn,elapsed_ms=self.start.elapsed().as_millis() as u64,prewarm_wait_ms=self.prewarm_ms,finished=self.finished,stage=if self.prewarm_ms.is_none(){"prewarm"}else{"provider"},"tts dispatch end (includes aborted futures)");}}

/// `XFYUN_TTS_PRECONNECT=0` 关掉预建连(回到每句现连)。
/// 留这个开关是因为这条线正在被演示:出问题时改一行 env + 重启即可退回,
/// 不用换二进制。默认开。
fn preconnect_enabled() -> bool {
    preconnect_from(std::env::var("XFYUN_TTS_PRECONNECT").ok().as_deref())
}

pub fn latency_mode() -> bool {
    std::env::var("P003_TTS_LATENCY_V1").is_ok_and(|v|v=="1")
}

fn connection_recovery_mode() -> bool {
    std::env::var("P003_TTS_CONNECT_RECOVERY_V1").is_ok_and(|v|v=="1")
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
    /// B12：预建连任务是否已跑完（成功或失败）——只用于「跳垫句」决策，不取走连接。
    pub fn is_finished(&self) -> bool {
        self.0.as_ref().map(|h| h.is_finished()).unwrap_or(false)
    }

    /// 关闭态(火山线,或 `XFYUN_TTS_PRECONNECT=0`)
    pub(crate) const fn off() -> Self {
        Self(None)
    }

    fn arm(cfg: tts_xfyun::XfyunTtsConfig) -> Self {
        Self(Some(tokio::spawn(async move {
            static HEDGES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
            if latency_mode() && !connection_recovery_mode() {
                connect_hedged(||tts_xfyun::connect_warm(&cfg),std::time::Duration::from_millis(650),&HEDGES).await
            } else { tts_xfyun::connect_warm(&cfg).await }
        })))
    }

    async fn take_for_sentence(&mut self, cfg: &tts_xfyun::XfyunTtsConfig) -> Result<tts_xfyun::Warm> {
        static SPARES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
        // This local guard owns the JoinHandle even if the foreground is cancelled
        // or a spare wins. Dropping it aborts the unused prewarm, never detaches it.
        let mut pending = std::mem::replace(self, Self::off());
        // A completed failure or expired socket is not an in-flight primary.
        // Consume it first so a real cold primary never needs a spare permit.
        if pending.is_finished() {
            if let Some(ready) = pending.take().await.filter(tts_xfyun::Warm::fresh) {
                return Ok(ready);
            }
        }
        let primary = async {
            if pending.0.is_none() {
                return tts_xfyun::connect_warm(cfg).await;
            }
            pending.take().await.filter(tts_xfyun::Warm::fresh)
                .ok_or_else(||anyhow::anyhow!("prewarm_failed_or_expired"))
        };
        // Keep the original 10s connection tolerance, but share it across the
        // entire foreground acquisition. A 650ms spare removes the serial wait
        // when one connection stalls without turning 4s successes into failures.
        recover_connection(primary, ||tts_xfyun::connect_warm(cfg),
            std::time::Duration::from_millis(650),std::time::Duration::from_secs(10),&SPARES).await
    }

    /// 取走已建好的连接。建连失败/被取消**不算错误**——
    /// 返回 None,调用方现连即可,预热失败绝不能让整句合成失败。
    async fn take(&mut self) -> Option<tts_xfyun::Warm> {
        // Keep ownership while awaiting. Cancelling this future must run Drop
        // on the handle instead of detaching an in-flight socket handshake.
        let result = match self.0.as_mut() {
            None => None,
            Some(h) => match h.await {
                Ok(Ok(w)) => Some(w),
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "xfyun 预建连失败,本句改为现连");
                    None
                }
                Err(_) => None, // task 被 abort(turn 结束)
            },
        };
        self.0.take();
        result
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

// Connector seam for deterministic latency/cancellation regression tests.
// Only connection establishment races: no synthesis text is sent here.
// A failed primary releases its slot before a replacement starts. Concurrent
// spares require a permit; capacity exhaustion never queues or cancels primary.
pub(crate) async fn recover_connection<T, P, F, Fut>(
    primary: P, connect: F, delay: std::time::Duration,
    budget: std::time::Duration, limit: &tokio::sync::Semaphore,
) -> Result<T>
where P: std::future::Future<Output=Result<T>>, F: FnOnce() -> Fut,
      Fut: std::future::Future<Output=Result<T>> {
    tokio::time::timeout(budget, async {
        tokio::pin!(primary);
        tokio::select! {
            biased;
            result=&mut primary=>return match result {
                Ok(value)=>Ok(value),
                Err(_)=>connect().await,
            },
            _=tokio::time::sleep(delay)=>{}
        }
        let Ok(_permit)=limit.try_acquire() else {
            return match primary.await {
                Ok(value)=>Ok(value),
                Err(_)=>connect().await,
            };
        };
        tracing::info!("tts foreground slow connection: bounded spare started");
        let spare=connect();tokio::pin!(spare);
        tokio::select! {
            biased;
            result=&mut primary=>match result {Ok(value)=>Ok(value),Err(_)=>spare.await},
            result=&mut spare=>match result {Ok(value)=>Ok(value),Err(_)=>primary.await},
        }
    }).await.map_err(|_|anyhow::anyhow!("tts_foreground_connect_budget_exhausted"))?
}

async fn connect_hedged<T, F, Fut>(connect: F, delay: std::time::Duration, limit: &tokio::sync::Semaphore) -> Result<T>
where F: Fn() -> Fut, Fut: std::future::Future<Output=Result<T>> {
    let primary=connect();tokio::pin!(primary);
    tokio::select! {
        result=&mut primary=>return result,
        _=tokio::time::sleep(delay)=>{}
    }
    // Never queue for a spare: at most two extra handshakes process-wide.
    let Ok(_permit)=limit.try_acquire() else {return primary.await;};
    tracing::info!("tts slow preconnect: one bounded spare started");
    let spare=connect();tokio::pin!(spare);
    // Losing futures drop their sockets; failures cannot cancel a healthy peer.
    tokio::select! {
        result=&mut primary=>match result {Ok(w)=>Ok(w),Err(_)=>spare.await},
        result=&mut spare=>match result {Ok(w)=>Ok(w),Err(_)=>primary.await},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn priority_actual_foreground_owner_aborts_pending_prewarm_on_cancel() {
        let (started,ready)=tokio::sync::oneshot::channel();
        let (dropped,done)=tokio::sync::oneshot::channel();
        struct Notify(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Notify {fn drop(&mut self){if let Some(s)=self.0.take(){let _=s.send(());}}}
        let mut warm=Prewarm(Some(tokio::spawn(async move {
            let _guard=Notify(Some(dropped));let _=started.send(());
            std::future::pending::<Result<tts_xfyun::Warm>>().await
        })));
        let cfg=tts_xfyun::XfyunTtsConfig{app_id:String::new(),api_key:String::new(),api_secret:String::new(),
            vcn:tts_xfyun::DEFAULT_VCN.into(),speed:50,oral_level:"mid".into()};
        // Empty credentials guarantee even an unexpectedly late spare cannot
        // reach an external service. Exercise the real foreground owner method.
        let outer=tokio::spawn(async move {let _=warm.take_for_sentence(&cfg).await;});
        ready.await.unwrap();tokio::task::yield_now().await;outer.abort();let _=outer.await;
        assert!(tokio::time::timeout(std::time::Duration::from_millis(200),done).await.is_ok());
    }

    #[tokio::test]
    async fn priority_recovery_pending_primary_uses_spare_without_waiting_for_failure() {
        use std::sync::atomic::{AtomicUsize,Ordering};
        let calls=AtomicUsize::new(0);let limit=tokio::sync::Semaphore::new(1);
        let acquisition=recover_connection(
            std::future::pending::<Result<u8>>(),
            ||{calls.fetch_add(1,Ordering::SeqCst);async{Ok(42)}},
            std::time::Duration::from_millis(20),std::time::Duration::from_millis(150),&limit);
        let result=tokio::time::timeout(std::time::Duration::from_millis(300),acquisition).await;
        assert!(matches!(result,Ok(Ok(42))),"a healthy spare must bypass the hung prewarm");
        assert_eq!(calls.load(Ordering::SeqCst),1);assert_eq!(limit.available_permits(),1);
    }

    #[tokio::test]
    async fn priority_recovery_both_hung_share_one_deadline() {
        let limit=tokio::sync::Semaphore::new(1);
        let acquisition=recover_connection(std::future::pending::<Result<u8>>(),
            ||std::future::pending::<Result<u8>>(),std::time::Duration::from_millis(10),
            std::time::Duration::from_millis(60),&limit);
        let result=tokio::time::timeout(std::time::Duration::from_millis(250),acquisition).await;
        assert!(matches!(result,Ok(Err(_))),"the acquisition itself must enforce one shared deadline");
        assert_eq!(limit.available_permits(),1);
    }

    #[tokio::test]
    async fn priority_recovery_failed_primary_starts_spare_immediately() {
        let limit=tokio::sync::Semaphore::new(1);
        let acquisition=recover_connection(async{anyhow::bail!("primary failure")},
            ||async{Ok(7)},std::time::Duration::from_secs(1),
            std::time::Duration::from_millis(200),&limit);
        assert!(matches!(tokio::time::timeout(std::time::Duration::from_millis(150),acquisition).await,Ok(Ok(7))));
    }

    #[tokio::test]
    async fn priority_recovery_healthy_primary_never_opens_spare() {
        let limit=tokio::sync::Semaphore::new(1);
        let value=recover_connection(async{Ok(3)},||async{panic!("unnecessary connection")},
            std::time::Duration::from_millis(20),std::time::Duration::from_millis(100),&limit).await.unwrap();
        assert_eq!(value,3);assert_eq!(limit.available_permits(),1);
    }

    #[tokio::test]
    async fn priority_recovery_capacity_preserves_primary_and_failed_primary_can_replace() {
        use std::sync::atomic::{AtomicUsize,Ordering};
        for primary_ok in [false,true] {
            let limit=tokio::sync::Semaphore::new(0);let calls=AtomicUsize::new(0);
            let value=recover_connection(async{
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                if primary_ok{Ok(7)}else{anyhow::bail!("failed after spare capacity was denied")}
            },||{calls.fetch_add(1,Ordering::SeqCst);async{Ok(9)}},
            std::time::Duration::from_millis(5),std::time::Duration::from_millis(150),&limit).await.unwrap();
            assert_eq!(value,if primary_ok{7}else{9});
            assert_eq!(calls.load(Ordering::SeqCst),if primary_ok{0}else{1});
        }
    }

    #[tokio::test]
    async fn priority_recovery_spare_failure_does_not_cancel_primary_or_start_third() {
        use std::sync::atomic::{AtomicUsize,Ordering};
        let limit=tokio::sync::Semaphore::new(1);let calls=AtomicUsize::new(0);
        let value=recover_connection(async{
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;Ok(8)
        },||{calls.fetch_add(1,Ordering::SeqCst);async{anyhow::bail!("spare failed")}},
        std::time::Duration::from_millis(5),std::time::Duration::from_millis(150),&limit).await.unwrap();
        assert_eq!(value,8);assert_eq!(calls.load(Ordering::SeqCst),1);assert_eq!(limit.available_permits(),1);
    }

    #[tokio::test]
    async fn priority_recovery_cancels_losers_and_releases_spare_permit() {
        use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
        struct Guard(Arc<AtomicUsize>);
        impl Drop for Guard{fn drop(&mut self){self.0.fetch_add(1,Ordering::SeqCst);}}
        let drops=Arc::new(AtomicUsize::new(0));let limit=tokio::sync::Semaphore::new(1);
        let (started,ready)=tokio::sync::oneshot::channel();
        let acquisition=recover_connection(async{let _g=Guard(drops.clone());std::future::pending::<Result<()>>().await},
            ||async{let _g=Guard(drops.clone());let _=started.send(());std::future::pending::<Result<()>>().await},
            std::time::Duration::from_millis(5),std::time::Duration::from_secs(1),&limit);
        let acquisition=Box::pin(acquisition);
        let mut acquisition=acquisition;
        tokio::select!{_=&mut acquisition=>panic!("both connections should be pending"),_=ready=>{}}
        assert_eq!(limit.available_permits(),0);drop(acquisition);
        assert_eq!(drops.load(Ordering::SeqCst),2);assert_eq!(limit.available_permits(),1);
    }

    // Current behavior characterization: foreground remains attached to the
    // pending warm future; this is evidence, not an acceptance test for a fix.
    #[tokio::test]
    async fn priority_pending_prewarm_blocks_until_its_own_failure() {
        let (release, blocked)=tokio::sync::oneshot::channel::<()>();
        let mut warm=Prewarm(Some(tokio::spawn(async move {
            let _=blocked.await;
            anyhow::bail!("synthetic handshake failure")
        })));
        let take=warm.take();tokio::pin!(take);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(80),&mut take).await.is_err());
        release.send(()).unwrap();
        assert!(tokio::time::timeout(std::time::Duration::from_millis(200),&mut take).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn cancelled_warm_wait_drops_the_underlying_connection_task() {
        let (started,ready)=tokio::sync::oneshot::channel();
        let (dropped,done)=tokio::sync::oneshot::channel();
        struct Notify(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Notify {fn drop(&mut self){if let Some(s)=self.0.take(){let _=s.send(());}}}
        let mut warm=Prewarm(Some(tokio::spawn(async move {
            let _guard=Notify(Some(dropped));let _=started.send(());
            std::future::pending::<Result<tts_xfyun::Warm>>().await
        })));
        let outer=tokio::spawn(async move {warm.take().await;});
        ready.await.unwrap();tokio::task::yield_now().await;outer.abort();let _=outer.await;
        assert!(tokio::time::timeout(std::time::Duration::from_millis(150),done).await.is_ok(),"cancelled turn must not detach its in-flight preconnect");
    }

    #[tokio::test]
    async fn slow_preconnect_is_hedged_without_waiting_for_the_slow_socket() {
        use std::sync::atomic::{AtomicUsize,Ordering};
        let calls=AtomicUsize::new(0);let limit=tokio::sync::Semaphore::new(1);
        let t=std::time::Instant::now();
        let got=connect_hedged(||{
            let n=calls.fetch_add(1,Ordering::SeqCst);
            async move{tokio::time::sleep(std::time::Duration::from_millis(if n==0{600}else{15})).await;Ok(n)}
        },std::time::Duration::from_millis(40),&limit).await.unwrap();
        assert_eq!(got,1,"the one delayed spare must beat the slow initial handshake");
        assert!(t.elapsed()<std::time::Duration::from_millis(300));
        assert_eq!(calls.load(Ordering::SeqCst),2);assert_eq!(limit.available_permits(),1);
    }

    #[tokio::test]
    async fn healthy_preconnect_uses_one_socket_and_zero_extra_wait() {
        use std::sync::atomic::{AtomicUsize,Ordering};
        let calls=AtomicUsize::new(0);let limit=tokio::sync::Semaphore::new(1);
        let got=connect_hedged(||{calls.fetch_add(1,Ordering::SeqCst);async {Ok(7)}},std::time::Duration::from_millis(40),&limit).await.unwrap();
        assert_eq!(got,7);assert_eq!(calls.load(Ordering::SeqCst),1);
    }

    #[tokio::test]
    async fn spare_failure_keeps_primary_and_capacity_limit_never_queues() {
        use std::sync::atomic::{AtomicUsize,Ordering};
        for available in [0,1] {
            let calls=AtomicUsize::new(0);let limit=tokio::sync::Semaphore::new(available);
            let value=connect_hedged(|| {
                let n=calls.fetch_add(1,Ordering::SeqCst);
                async move {if n==1{anyhow::bail!("synthetic spare failure");}
                    tokio::time::sleep(std::time::Duration::from_millis(40)).await;Ok(42)}
            },std::time::Duration::from_millis(5),&limit).await.unwrap();
            assert_eq!(value,42);assert_eq!(calls.load(Ordering::SeqCst),available+1);
            assert_eq!(limit.available_permits(),available);
        }
    }

    #[tokio::test]
    async fn cancelling_hedged_connect_drops_both_attempts_and_releases_permit() {
        use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
        struct Count(Arc<AtomicUsize>);
        impl Drop for Count{fn drop(&mut self){self.0.fetch_sub(1,Ordering::SeqCst);}}
        let active=Arc::new(AtomicUsize::new(0));let limit=Arc::new(tokio::sync::Semaphore::new(1));
        let a=active.clone();let l=limit.clone();
        let task=tokio::spawn(async move {
            connect_hedged(||{let a=a.clone();async move {
                a.fetch_add(1,Ordering::SeqCst);let _count=Count(a);
                std::future::pending::<Result<usize>>().await
            }},std::time::Duration::from_millis(5),&l).await
        });
        tokio::time::timeout(std::time::Duration::from_secs(1),async {
            while active.load(Ordering::SeqCst)!=2 {tokio::task::yield_now().await;}
        }).await.unwrap();
        task.abort();let _=task.await;
        assert_eq!(active.load(Ordering::SeqCst),0);assert_eq!(limit.available_permits(),1);
    }

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
