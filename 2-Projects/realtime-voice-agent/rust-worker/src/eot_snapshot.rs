//! EOT 判停快照采集口(上线前置① D1,方案 a;立项 tasks/voice-eot-上线前置.md)。
//!
//! 目的:在生产触发点(静音累积 200ms、旧模型被调用那一刻)采集 8s 窗音频 + 行为事件流,
//! 为 smart-turn 迁移的阈值重标定攒**自家真实对话分布**的数据。
//!
//! 开关:`EOT_SNAPSHOT_DIR` 未设 = 完全关闭,**零行为变化**(ring 容量、快照、事件全部不发生)。
//! 设了 = 该目录下:
//!   events.jsonl                     全局事件流(append;job/speech/eot/final/commit)
//!   <UTCts>-<rand6>/t{seq:04}.wav    每个触发点的 8s 窗(16k mono s16;尾 1.2s 即旧模型入参)
//!
//! 隐私边界(立项文件同款,违者事故):音频与文本都是用户语音内容——**只存本机、
//! 只在私有环境标注、禁外派任何外部引擎**。事件流不含 room 原名(sha256 前 12 位)、
//! 不含 participant 身份。
//!
//! 失败语义:采集是旁路,任何 IO 失败只 WARN(计数节流),**绝不影响判停主链路**。
//! 容量护栏:每 job ≤ EOT_SNAPSHOT_MAX_PER_JOB(默认 50);全局 ≤ EOT_SNAPSHOT_MAX_TOTAL_MB
//! (默认 2048,启动时量存量+进程内累计,超限停采并 WARN 一次)。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use tracing::{info, warn};

/// 快照窗:8s @16k(smart-turn 输入窗;尾 19200 样本=旧模型 1.2s 窗,离线切尾即得)。
pub const SNAP_WINDOW: usize = 128_000;
const SR: u32 = 16_000;

/// 全局已写字节累计(跨 job 共享;WORKER_MAX_JOBS 个 pipeline 并发各持一个 Sink)。
static GLOBAL_WRITTEN: AtomicU64 = AtomicU64::new(0);
/// 存量已盘点标记(首个 Sink 构造时 walk 一次目录)。
static GLOBAL_PRIMED: std::sync::Once = std::sync::Once::new();

pub struct SnapshotSink {
    root: PathBuf,
    job_dir: PathBuf,
    job_key: String,
    seq: u32,
    max_per_job: u32,
    max_total_bytes: u64,
    io_errors: u32,
    /// 超限停采只告警一次
    capped_warned: bool,
}

fn rand6() -> String {
    // 不引 rand 依赖路径:时间低位+进程 id 混合,同秒并发 job 也不撞(pid 不同)
    let ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let mix = ns ^ (std::process::id() as u64) << 20;
    format!("{mix:06x}").chars().rev().take(6).collect()
}

fn walk_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                total += walk_size(&p);
            } else if let Ok(m) = e.metadata() {
                total += m.len();
            }
        }
    }
    total
}

impl SnapshotSink {
    /// `EOT_SNAPSHOT_DIR` 未设 → None(采集完全关闭)。
    pub fn from_env(room_name: &str) -> Option<Self> {
        let root = PathBuf::from(std::env::var("EOT_SNAPSHOT_DIR").ok()?);
        let max_per_job: u32 = std::env::var("EOT_SNAPSHOT_MAX_PER_JOB")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(50);
        let max_total_mb: u64 = std::env::var("EOT_SNAPSHOT_MAX_TOTAL_MB")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2048);

        let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S");
        let job_key = format!("{ts}-{}", rand6());
        let job_dir = root.join(&job_key);
        if let Err(e) = std::fs::create_dir_all(&job_dir) {
            warn!(error = %e, dir = %job_dir.display(), "eot snapshot 目录创建失败,本 job 采集关闭");
            return None;
        }
        GLOBAL_PRIMED.call_once(|| {
            let existing = walk_size(&root);
            GLOBAL_WRITTEN.store(existing, Ordering::Relaxed);
            info!(existing_mb = existing / 1024 / 1024, "eot snapshot 存量盘点");
        });

        let room_hash = {
            let mut h = Sha256::new();
            h.update(room_name.as_bytes());
            h.finalize()[..6].iter().map(|b| format!("{b:02x}")).collect::<String>()
        };
        let mut s = Self {
            root,
            job_dir,
            job_key,
            seq: 0,
            max_per_job,
            max_total_bytes: max_total_mb * 1024 * 1024,
            io_errors: 0,
            capped_warned: false,
        };
        s.event("job_start", &[("room_hash", room_hash.as_str())]);
        info!(job = %s.job_key, "eot snapshot 采集开启");
        Some(s)
    }

    /// 采集开关决定 eot ring 的保留长度(开=8s,关=1.2s 维持原状)。
    pub fn ring_keep(enabled: bool, default_keep: usize) -> usize {
        if enabled { SNAP_WINDOW } else { default_keep }
    }

    fn format_event(job_key: &str, kind: &str, fields: &[(&str, &str)]) -> String {
        let ts_ms = chrono::Utc::now().timestamp_millis();
        let mut line = format!(r#"{{"ts_ms":{ts_ms},"job":"{job_key}","ev":"{kind}""#);
        for (k, v) in fields {
            line.push_str(&format!(r#","{k}":"{}""#, json_escape(v)));
        }
        line.push_str("}\n");
        line
    }

    /// B34-C:事件行走**后台**写。`event()` 是同步 open+write,挂在 ASR 判决路径上就是
    /// 热路径阻塞——B33 声称「整条路径不占热路径」只对 WAV 成立,对事件行不成立,codex 指出属实。
    /// 本轮新增的打断取证事件量很小(每房 ≤3),直接交后台即可,不改造历史日志系统。
    pub fn event_bg(&mut self, kind: &str, fields: &[(&str, &str)]) {
        let line = Self::format_event(&self.job_key, kind, fields);
        let path = self.root.join("events.jsonl");
        GLOBAL_WRITTEN.fetch_add(line.len() as u64, Ordering::Relaxed);
        tokio::task::spawn_blocking(move || {
            let r = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut f| f.write_all(line.as_bytes()));
            if let Err(e) = r {
                warn!(error = %e, "interrupt snapshot 事件落盘失败(旁路,不影响判停)");
            }
        });
    }

    /// 事件流 append 一行 JSON。字段值做最小转义(文本里引号/反斜杠/控制符)。
    pub fn event(&mut self, kind: &str, fields: &[(&str, &str)]) {
        let line = Self::format_event(&self.job_key, kind, fields);
        let path = self.root.join("events.jsonl");
        let r = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| f.write_all(line.as_bytes()));
        if let Err(e) = r {
            self.note_io_error("events.jsonl append", &e);
        } else {
            GLOBAL_WRITTEN.fetch_add(line.len() as u64, Ordering::Relaxed);
        }
    }

    /// 触发点快照:8s 窗 PCM 落 wav(后台 blocking 线程,不占判停热路径)。
    /// 返回本快照 seq(调用方把它写进 eot_request 事件对齐概率)。
    pub fn snapshot(&mut self, pcm: &[i16]) -> Option<u32> {
        if self.seq >= self.max_per_job {
            if !self.capped_warned {
                warn!(job = %self.job_key, cap = self.max_per_job, "eot snapshot 达到单 job 上限,停采");
                self.capped_warned = true;
            }
            return None;
        }
        let est = pcm.len() as u64 * 2 + 44;
        if GLOBAL_WRITTEN.load(Ordering::Relaxed) + est > self.max_total_bytes {
            if !self.capped_warned {
                warn!(job = %self.job_key, "eot snapshot 达到全局容量上限,停采(清目录或调 EOT_SNAPSHOT_MAX_TOTAL_MB)");
                self.capped_warned = true;
            }
            return None;
        }
        let seq = self.seq;
        self.seq += 1;
        GLOBAL_WRITTEN.fetch_add(est, Ordering::Relaxed);
        let path = self.job_dir.join(format!("t{seq:04}.wav"));
        let data: Arc<[i16]> = Arc::from(pcm);
        tokio::task::spawn_blocking(move || {
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: SR,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let write = || -> Result<(), hound::Error> {
                let mut w = hound::WavWriter::create(&path, spec)?;
                let mut sw = w.get_i16_writer(data.len() as u32);
                for &s in data.iter() {
                    sw.write_sample(s);
                }
                sw.flush()?;
                w.finalize()
            };
            if let Err(e) = write() {
                warn!(error = %e, path = %path.display(), "eot snapshot wav 落盘失败");
            }
        });
        Some(seq)
    }

    fn note_io_error(&mut self, what: &str, e: &std::io::Error) {
        self.io_errors += 1;
        if self.io_errors <= 3 || self.io_errors.is_power_of_two() {
            warn!(error = %e, what, count = self.io_errors, "eot snapshot IO 失败(旁路,不影响判停)");
        }
    }
}

/// B32-B/B34-C:ASR **打断判决点**的短窗取证。
///
/// 为什么要单开一个:EOT 快照只在**判停路径**(`eot_request`)落盘,而被吞掉的碎片与
/// 被打断 commit 的那一段上行**永远不经过判停路径**,于是没有任何音频本体。B31 里
/// 「是的」到底是真人还是回声判不了,就是栽在这。
///
/// **默认关**:`INTERRUPT_SNAPSHOT_ENABLED` 未设或非 `1` → `None`,零行为变化、
/// 不新增任何文件、不分配取证环。开启还需 `EOT_SNAPSHOT_DIR` 已配(复用同一 sink
/// 的目录、配额与全局字节上限)。
pub struct InterruptSnap {
    max_per_room: u32,
    taken: u32,
}

/// 闸门结果。`Capped` 也必须被**写进事件流**——否则「没有文件」会被读成
/// 「没有这次 ASR」,那正是 B31 判不了的根源的另一种形态(codex B34 §2 P0-C)。
#[derive(Debug, PartialEq, Eq)]
pub enum Capture {
    Go,
    Capped,
}

impl InterruptSnap {
    pub fn from_env() -> Option<Self> {
        let enabled = std::env::var("INTERRUPT_SNAPSHOT_ENABLED").ok().as_deref() == Some("1");
        let max = std::env::var("INTERRUPT_SNAPSHOT_MAX_PER_ROOM")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3);
        Self::from_flag(enabled, max)
    }

    /// 纯构造(测试用:不碰进程环境。Rust 2024 起 set_var 是 unsafe,且并行测试互相污染)。
    pub fn from_flag(enabled: bool, max_per_room: u32) -> Option<Self> {
        if !enabled {
            return None;
        }
        info!(max_per_room, "打断取证快照已开启(默认关,本次由 INTERRUPT_SNAPSHOT_ENABLED=1 显式打开)");
        Some(Self { max_per_room, taken: 0 })
    }

    /// 配额的**唯一执行点**。曾经在两处各拦一道,把 `>=` 改成 `>` 注入真 bug 后测试
    /// 照样全绿——两道守卫互相遮蔽,谁都测不出来。守卫只留一处,判据才有区分力。
    pub fn try_take(&mut self) -> Capture {
        if self.taken >= self.max_per_room {
            return Capture::Capped;
        }
        self.taken += 1;
        Capture::Go
    }

    pub fn taken(&self) -> u32 {
        self.taken
    }

    pub fn max_per_room(&self) -> u32 {
        self.max_per_room
    }
}

/// 判决那一刻的播放上下文。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlaybackCtx {
    pub turn_id: u64,
    pub playing: &'static str,
    pub at_ms: i64,
}

/// B34-B:判决点要的是「判决**之前**在播什么」。
///
/// 而 `hard_abort_current` 会先 `agent_turn.take()`,普通 commit 与 STOP/EXIT 吞句
/// 都是**先 abort 再登记**——等登记时 turn 已经没了,现算只会得到 `none`/turn_id=0,
/// **恰好在 B31「是的」那类新轮上失真**,而那正是下一轮要查的字段。故 abort 前闩住。
pub struct CtxLatch {
    pre_abort: Option<PlaybackCtx>,
}

impl Default for CtxLatch {
    fn default() -> Self {
        Self::new()
    }
}

impl CtxLatch {
    pub fn new() -> Self {
        Self { pre_abort: None }
    }

    /// abort 掉旧 turn 之前调用。**不改变任何中断/吞词/commit 决策顺序**,只抄一份上下文。
    pub fn stash(&mut self, c: PlaybackCtx) {
        self.pre_abort = Some(c);
    }

    /// live 有真 turn 就用 live;否则用 `max_age_ms` 内闩住的那份。
    /// 两者都没有 → `unknown`,**不猜**(codex B34 §2 P0-B:无法确定就 unknown)。
    /// 返回值第二项是来源标签,写进事件流供对账,不让推断冒充观测。
    pub fn resolve(
        &self,
        live: Option<PlaybackCtx>,
        now_ms: i64,
        max_age_ms: i64,
    ) -> (PlaybackCtx, &'static str) {
        if let Some(l) = live {
            return (l, "live");
        }
        if let Some(pre) = self.pre_abort
            && now_ms.saturating_sub(pre.at_ms) <= max_age_ms
        {
            return (pre, "pre_abort");
        }
        (
            PlaybackCtx { turn_id: 0, playing: "unknown", at_ms: now_ms },
            "unavailable",
        )
    }
}

impl Drop for SnapshotSink {
    fn drop(&mut self) {
        self.event("job_end", &[("snapshots", &self.seq.to_string())]);
    }
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_dir<F: FnOnce(&Path)>(f: F) {
        let dir = std::env::temp_dir().join(format!("eot-snap-test-{}", rand6()));
        std::fs::create_dir_all(&dir).unwrap();
        f(&dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disabled_without_env_dir() {
        // 串行担忧:测试进程并发跑其它 case 设置了 env?本 crate 测试无处设置该变量,
        // 此断言依赖环境干净(cargo test 默认继承 shell env,CI 上无此变量)。
        if std::env::var("EOT_SNAPSHOT_DIR").is_err() {
            assert!(SnapshotSink::from_env("room-x").is_none());
        }
    }

    #[test]
    fn ring_keep_switches_on_flag() {
        assert_eq!(SnapshotSink::ring_keep(false, 19_200), 19_200);
        assert_eq!(SnapshotSink::ring_keep(true, 19_200), SNAP_WINDOW);
    }

    #[test]
    fn json_escape_covers_quotes_and_control() {
        assert_eq!(json_escape(r#"a"b\c"#), r#"a\"b\\c"#);
        assert_eq!(json_escape("x\ny"), r"x\ny");
    }

    #[tokio::test]
    async fn snapshot_writes_wav_and_respects_per_job_cap() {
        let dir = std::env::temp_dir().join(format!("eot-snap-test-{}", rand6()));
        let job_dir = dir.join("jobA");
        std::fs::create_dir_all(&job_dir).unwrap();
        // 直接构造(不经 from_env,避免测试进程改全局 env 影响并行测试)
        let mut s = SnapshotSink {
            root: dir.clone(),
            job_dir: job_dir.clone(),
            job_key: "jobA".into(),
            seq: 0,
            max_per_job: 2,
            max_total_bytes: u64::MAX,
            io_errors: 0,
            capped_warned: false,
        };
        let pcm = vec![100i16; 32_000];
        assert_eq!(s.snapshot(&pcm), Some(0));
        assert_eq!(s.snapshot(&pcm), Some(1));
        assert_eq!(s.snapshot(&pcm), None, "per-job cap");
        s.event("user_final", &[("text", "你好\"世界\"")]);

        // 行为级断言:轮询等 spawn_blocking 真把 wav 落盘,读回验内容
        let wav0 = job_dir.join("t0000.wav");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if wav0.exists()
                && let Ok(mut r) = hound::WavReader::open(&wav0)
                && r.duration() == 32_000
            {
                let first = r.samples::<i16>().next().unwrap().unwrap();
                assert_eq!(first, 100);
                break;
            }
            assert!(std::time::Instant::now() < deadline, "wav 未在 3s 内落盘");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        // events.jsonl 行是合法 JSON 且转义正确
        let events = std::fs::read_to_string(dir.join("events.jsonl")).unwrap();
        let line = events.lines().last().unwrap();
        let v: serde_json::Value = serde_json::from_str(line).expect("event line must be valid JSON");
        assert_eq!(v["ev"], "user_final");
        assert_eq!(v["text"], "你好\"世界\"");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wav_roundtrip_via_hound() {
        with_dir(|dir| {
            let path = dir.join("t.wav");
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: SR,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut w = hound::WavWriter::create(&path, spec).unwrap();
            for i in 0..1000i16 {
                w.write_sample(i).unwrap();
            }
            w.finalize().unwrap();
            let mut r = hound::WavReader::open(&path).unwrap();
            let back: Vec<i16> = r.samples::<i16>().map(|x| x.unwrap()).collect();
            assert_eq!(back.len(), 1000);
            assert_eq!(back[999], 999);
        });
    }
}

#[cfg(test)]
mod interrupt_snap_tests {
    use super::*;

    /// 默认关是这条特性的安全根基:关 = 连对象都不存在,不可能落盘。
    #[test]
    fn disabled_by_default_yields_none() {
        assert!(InterruptSnap::from_flag(false, 3).is_none(), "未显式开启时必须是 None");
        assert!(InterruptSnap::from_flag(true, 3).is_some(), "正锚:开启路径确实能构造");
    }

    /// 断言**端到端不变量**(跑满 10 轮只许放行 3 次),不是某一处守卫的写法。
    #[test]
    fn never_exceeds_cap_whatever_the_pattern() {
        let mut s = InterruptSnap::from_flag(true, 3).unwrap();
        let mut go = 0;
        let mut capped = 0;
        for _ in 0..10 {
            match s.try_take() {
                Capture::Go => go += 1,
                Capture::Capped => capped += 1,
            }
        }
        assert_eq!(go, 3, "10 次请求只许放行 3 次");
        assert_eq!(capped, 7, "其余必须显式 Capped——不能静默消失");
        assert_eq!(s.taken(), 3);
    }

    /// B34-B 最小回归(codex 点名):旧 turn=1/worker_body → abort 后登记 → 仍带旧 turn=1/worker_body。
    #[test]
    fn ctx_survives_abort_before_registration() {
        let mut latch = CtxLatch::new();
        // abort 之前闩住
        latch.stash(PlaybackCtx { turn_id: 1, playing: "worker_body", at_ms: 1_000 });
        // 判决登记时 agent_turn 已被 take → live 为 None
        let (ctx, src_tag) = latch.resolve(None, 1_010, 200);
        assert_eq!(ctx.turn_id, 1, "必须仍是旧 turn,不能变 0");
        assert_eq!(ctx.playing, "worker_body", "必须仍是旧正文来源,不能变 none");
        assert_eq!(src_tag, "pre_abort", "来源标签要说实话");
    }

    /// live 优先:没 abort 的路径不许被陈旧闩值污染。
    #[test]
    fn live_ctx_wins_over_stale_latch() {
        let mut latch = CtxLatch::new();
        latch.stash(PlaybackCtx { turn_id: 1, playing: "worker_body", at_ms: 1_000 });
        let live = PlaybackCtx { turn_id: 2, playing: "worker_filler", at_ms: 2_000 };
        let (ctx, tag) = latch.resolve(Some(live), 2_000, 200);
        assert_eq!(ctx.turn_id, 2);
        assert_eq!(tag, "live");
    }

    /// 闩值过期必须退化成 unknown,**不能拿几秒前的旧轮冒充「判决时在播」**。
    #[test]
    fn stale_latch_degrades_to_unknown_not_a_guess() {
        let mut latch = CtxLatch::new();
        latch.stash(PlaybackCtx { turn_id: 1, playing: "worker_body", at_ms: 1_000 });
        let (ctx, tag) = latch.resolve(None, 9_999, 200);
        assert_eq!(ctx.playing, "unknown", "过期必须 unknown");
        assert_eq!(ctx.turn_id, 0);
        assert_eq!(tag, "unavailable");
    }

    /// 从没闩过也没 live → unknown,不 panic、不编造。
    #[test]
    fn empty_latch_is_unknown() {
        let latch = CtxLatch::new();
        let (ctx, tag) = latch.resolve(None, 5, 200);
        assert_eq!(ctx.playing, "unknown");
        assert_eq!(tag, "unavailable");
    }
}
