//! 启动门解耦(input_ready 合同,codex 冻结 2026-08-18)。
//!
//! 旧双门耦合(local_subscribed && mic_stream)让输入链白等 LocalTrackSubscribed
//! ~950ms(2026-08-18 生产 6 job 实测 919–995ms,极稳),用户在 wake filler 里说的
//! 首句整段被吞。拆成两道独立门:
//! - **input gate**:user 音轨订到即启输入链(VAD/ASR),不等输出方向;
//! - **output gate**:agent 轨被 Android 订阅(LocalTrackSubscribed)才准出声。
//!   首个待播 PCM 起 5s 未就绪 → fail-closed 关房(冻结值;正常 ~950ms 就绪,5 倍余量)。
//!
//! StartupGates 是纯决策状态机(资源仍归 job.rs 持有),为的是把 9.1–9.5 合同
//! 单测写成无 IO 的纯逻辑测试。

use std::time::Duration;

use tokio::sync::{mpsc, watch};
use tokio::time::timeout;

/// 门决策状态机:只回答「此刻该不该做 X」,幂等由内部标志保证。
#[derive(Debug, Default)]
pub struct StartupGates {
    input_started: bool,
    output_event_sent: bool,
}

impl StartupGates {
    pub fn new() -> Self {
        Self::default()
    }

    /// user 音轨订到(TrackSubscribed)。返回 true = 应启动输入 pipeline。
    /// 重复订阅事件(同 trace 重发)幂等:只有第一次返回 true(合同 9.4)。
    pub fn on_user_track(&mut self) -> bool {
        if self.input_started {
            return false;
        }
        self.input_started = true;
        true
    }

    /// Android 订阅了 agent 输出轨(LocalTrackSubscribed)。
    /// 返回 true = 首次 output ready(应置 watch 并发 session.output_ready 事件)。
    pub fn on_local_subscribed(&mut self) -> bool {
        if self.output_event_sent {
            return false;
        }
        self.output_event_sent = true;
        true
    }

    /// 合同 9.2 的测试观察口:仅输出就绪时输入链必须未启动。
    /// 生产路径的等价保证=mic_stream 只在 on_user_track 首次放行时创建。
    #[cfg(test)]
    pub fn input_started(&self) -> bool {
        self.input_started
    }
}

/// 输出门:门未过时包装 turn 的 PCM 管道,首段 PCM 到达起倒计时;超时经 fatal
/// 通道通知 pipeline 主循环 fail-closed(关房删房,设备走既有重连路径=新房新 job)。
/// 门已过(进程内一次性)后 `wrap` 直接原样返回,后续 turn 零开销。
pub struct OutputGate {
    rx: watch::Receiver<bool>,
    passed: bool,
    timeout: Duration,
}

/// PCM 管道容量与 start_turn 的 pcm channel 同深(32),包装层不改变背压语义。
const WRAP_CAPACITY: usize = 32;

impl OutputGate {
    pub fn new(rx: watch::Receiver<bool>) -> Self {
        Self { rx, passed: false, timeout: Duration::from_secs(5) }
    }

    #[cfg(test)]
    pub fn with_timeout(rx: watch::Receiver<bool>, timeout: Duration) -> Self {
        Self { rx, passed: false, timeout }
    }

    /// 门是否已开(开过即恒开)。start_turn 每轮先问:开了就不包装。
    pub fn is_open(&mut self) -> bool {
        if self.passed {
            return true;
        }
        if *self.rx.borrow() {
            self.passed = true;
            return true;
        }
        false
    }

    /// 包装 PCM 管道:首段 PCM 到达时若门未开,等 `timeout`;开了透传,超时(或 job 侧
    /// watch sender 已亡=永远不会开)发 fatal 并丢弃本轮全部 PCM——绝不让半聋房间出声。
    pub fn wrap(
        &self,
        mut pcm_rx: mpsc::Receiver<Vec<u8>>,
        fatal_tx: mpsc::Sender<String>,
    ) -> mpsc::Receiver<Vec<u8>> {
        let mut rx_watch = self.rx.clone();
        let wait = self.timeout;
        let (tx2, rx2) = mpsc::channel::<Vec<u8>>(WRAP_CAPACITY);
        tokio::spawn(async move {
            let mut open = *rx_watch.borrow();
            while let Some(chunk) = pcm_rx.recv().await {
                if !open {
                    // matches! 就地消费 watch::Ref(非 Send,不能跨 await 持有)
                    // 非 Ok(Ok):外层 Err=超时;内层 Err=watch sender 亡(job 事件循环已退)
                    let opened =
                        matches!(timeout(wait, rx_watch.wait_for(|v| *v)).await, Ok(Ok(_)));
                    if !opened {
                        let _ = fatal_tx
                            .send(format!(
                                "output gate {}s 未就绪(Android 未订阅 agent 轨),fail-closed",
                                wait.as_secs()
                            ))
                            .await;
                        return;
                    }
                    open = true;
                }
                if tx2.send(chunk).await.is_err() {
                    return; // playout 已收摊(turn 结束/打断),包装层跟着退
                }
            }
        });
        rx2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 合同 9.1:用户音轨先到、输出轨未订阅 → 输入 pipeline 仍启动 ──
    #[test]
    fn user_track_first_starts_input_without_output() {
        let mut g = StartupGates::new();
        // 全程不调 on_local_subscribed:输入启动决策必须与输出方向零耦合
        assert!(g.on_user_track(), "user 轨到即应启动输入链,不等输出方向");
        assert!(g.input_started());
    }

    // ── 合同 9.2:输出轨先到、用户音轨未到 → 不得启动输入/不得发 input_ready ──
    #[test]
    fn output_first_never_starts_input() {
        let mut g = StartupGates::new();
        assert!(g.on_local_subscribed(), "首次 output ready 应发事件");
        assert!(!g.input_started(), "仅输出就绪绝不启动输入链");
    }

    // ── 合同 9.4:同一 trace 重复 TrackSubscribed → 启动/ready 只生效一次 ──
    #[test]
    fn duplicate_track_subscribed_is_idempotent() {
        let mut g = StartupGates::new();
        assert!(g.on_user_track());
        assert!(!g.on_user_track(), "重复 user 轨订阅不得二次启动");
        assert!(g.on_local_subscribed());
        assert!(!g.on_local_subscribed(), "重复 local 订阅不得二次发 output_ready");
    }

    // ── 合同 9.6:input ready 后 output 晚到 → 首个 PCM 不丢头(等门开后完整透传) ──
    // (真实时间缩尺:生产 5s 超时/~950ms 就绪 → 测试 500ms 超时/20ms 就绪,比例同构)
    #[tokio::test]
    async fn late_output_ready_keeps_first_pcm() {
        let (wtx, wrx) = watch::channel(false);
        let gate = OutputGate::with_timeout(wrx, Duration::from_millis(500));
        let (ptx, prx) = mpsc::channel::<Vec<u8>>(8);
        let (ftx, mut frx) = mpsc::channel::<String>(1);
        let mut wrapped = gate.wrap(prx, ftx);

        ptx.send(vec![1, 2, 3]).await.unwrap();
        ptx.send(vec![4, 5]).await.unwrap();
        // 门 20ms 后才开(< 超时)
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = wtx.send(true);
        });
        let first = wrapped.recv().await.expect("首段 PCM 必须完整到达");
        assert_eq!(first, vec![1, 2, 3], "首段不得被丢弃或截断");
        assert_eq!(wrapped.recv().await.unwrap(), vec![4, 5]);
        assert!(frx.try_recv().is_err(), "门开了不该有 fatal");
    }

    // ── 冻结条款:首个待播 PCM 起超时未就绪 → fatal(fail-closed),PCM 全部丢弃 ──
    #[tokio::test]
    async fn output_gate_timeout_is_fail_closed() {
        let (_wtx, wrx) = watch::channel(false); // 永不置 true(sender 活着,纯超时路径)
        let gate = OutputGate::with_timeout(wrx, Duration::from_millis(50));
        let (ptx, prx) = mpsc::channel::<Vec<u8>>(8);
        let (ftx, mut frx) = mpsc::channel::<String>(1);
        let mut wrapped = gate.wrap(prx, ftx);

        ptx.send(vec![9, 9]).await.unwrap();
        let fatal = frx.recv().await.expect("必须收到 fatal");
        assert!(fatal.contains("fail-closed"), "fatal 文案要可 grep: {fatal}");
        drop(ptx);
        assert!(wrapped.recv().await.is_none(), "超时后不得有任何 PCM 泄出");
    }

    // ── watch sender 亡(job 事件循环退出)= 永不就绪,同样 fail-closed 不悬挂 ──
    #[tokio::test]
    async fn dead_watch_sender_also_fails_closed() {
        let (wtx, wrx) = watch::channel(false);
        drop(wtx);
        let gate = OutputGate::with_timeout(wrx, Duration::from_millis(200));
        let (ptx, prx) = mpsc::channel::<Vec<u8>>(8);
        let (ftx, mut frx) = mpsc::channel::<String>(1);
        let _wrapped = gate.wrap(prx, ftx);
        ptx.send(vec![7]).await.unwrap();
        assert!(frx.recv().await.is_some(), "sender 亡应立即 fatal 而非悬挂");
    }

    // ── 门已开时 is_open 恒真,start_turn 据此跳过包装(零开销路径) ──
    #[test]
    fn is_open_latches_after_ready() {
        let (wtx, wrx) = watch::channel(false);
        let mut gate = OutputGate::new(wrx);
        assert!(!gate.is_open());
        wtx.send(true).unwrap();
        assert!(gate.is_open());
        // watch 之后再翻 false(不会发生,但门语义=开过即恒开)
        wtx.send(false).unwrap();
        assert!(gate.is_open(), "门开过必须锁存");
    }
}
