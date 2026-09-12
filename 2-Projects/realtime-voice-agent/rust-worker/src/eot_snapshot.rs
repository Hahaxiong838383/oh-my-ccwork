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

    /// 事件流 append 一行 JSON。字段值做最小转义(文本里引号/反斜杠/控制符)。
    pub fn event(&mut self, kind: &str, fields: &[(&str, &str)]) {
        let ts_ms = chrono::Utc::now().timestamp_millis();
        let mut line = format!(r#"{{"ts_ms":{ts_ms},"job":"{}","ev":"{kind}""#, self.job_key);
        for (k, v) in fields {
            line.push_str(&format!(r#","{k}":"{}""#, json_escape(v)));
        }
        line.push_str("}\n");
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

/// B32-B(codex §3B):ASR **打断判决点**的短窗取证。
///
/// 为什么要单开一个:EOT 快照只在**判停路径**(`eot_request`)落盘,而被吞掉的碎片与
/// 被打断 commit 的那一段上行**永远不经过判停路径**,于是没有任何音频本体。B31 里
/// 「是的」到底是真人还是回声判不了,就是栽在这——文本级回声门对「回声被 ASR 错转成
/// 别的字」结构性无效,而唯一能裁决的音频恰好从不落盘。
///
/// **默认关**:`INTERRUPT_SNAPSHOT_ENABLED` 未设或非 `1` → `None`,零行为变化、
/// 不新增任何文件、不多占一字节环。开启还需 `EOT_SNAPSHOT_DIR` 已配(复用同一 sink
/// 的目录、配额与全局字节上限)。
pub struct InterruptSnap {
    max_per_room: u32,
    taken: u32,
    pending: Option<PendingSnap>,
}

/// 判决点登记的取证意图。**只登记,不做 IO**——真正落盘在输入环下一帧(≤20ms),
/// 8s 窗内容等价,且不把文件写入塞进判决热路径。
pub struct PendingSnap {
    pub decision: &'static str,
    pub reason: String,
    pub playing: &'static str,
    pub turn_id: u64,
    pub at_ms: i64,
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

    /// 纯构造(测试用:不碰进程环境。Rust 2024 起 set_var 是 unsafe,且并行测试会互相污染)。
    pub fn from_flag(enabled: bool, max_per_room: u32) -> Option<Self> {
        if !enabled {
            return None;
        }
        info!(max_per_room, "打断取证快照已开启(默认关,本次由 INTERRUPT_SNAPSHOT_ENABLED=1 显式打开)");
        Some(Self { max_per_room, taken: 0, pending: None })
    }

    /// 登记一次取证请求。同一帧内多次判决只留第一次——codex §3B 明确要求
    /// 「不能每 interim 反复存盘」。
    ///
    /// **这里不查配额**:配额的唯一执行点是 `take_pending`。曾经两处各拦一道,
    /// 结果是把 `>=` 改成 `>` 注入真 bug 后测试照样全绿——两道守卫互相遮蔽,
    /// 谁都测不出来。守卫只留一处,判据才有区分力。
    pub fn request(&mut self, p: PendingSnap) {
        if self.pending.is_none() {
            self.pending = Some(p);
        }
    }

    pub fn take_pending(&mut self) -> Option<PendingSnap> {
        if self.taken >= self.max_per_room {
            self.pending = None;
            return None;
        }
        let p = self.pending.take()?;
        self.taken += 1;
        Some(p)
    }

    pub fn taken(&self) -> u32 {
        self.taken
    }

    pub fn max_per_room(&self) -> u32 {
        self.max_per_room
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

    fn p(reason: &str) -> PendingSnap {
        PendingSnap {
            decision: "swallowed",
            reason: reason.to_string(),
            playing: "worker_body",
            turn_id: 1,
            at_ms: 0,
        }
    }

    /// 默认关是这条特性的安全根基:关 = 连对象都不存在,不可能落盘。
    #[test]
    fn disabled_by_default_yields_none() {
        assert!(InterruptSnap::from_flag(false, 3).is_none(), "未显式开启时必须是 None");
        // 正锚:开启路径确实能造出来,否则「永远 None」和「构造函数坏了」不可区分
        assert!(InterruptSnap::from_flag(true, 3).is_some());
    }

    /// 每房 3 段封顶。断言的是**端到端不变量**(跑满 10 轮只许落 3 段),不是
    /// 某一处守卫的写法——单点断言会被另一处守卫遮蔽而恒绿(实测过)。
    #[test]
    fn never_exceeds_cap_whatever_the_request_pattern() {
        let mut s = InterruptSnap::from_flag(true, 3).unwrap();
        let mut landed = 0;
        for i in 0..10 {
            s.request(p(&format!("r{i}")));
            if s.take_pending().is_some() {
                landed += 1;
            }
        }
        assert_eq!(landed, 3, "10 轮请求只许落 3 段");
        assert_eq!(s.taken(), 3, "计数必须与实际落盘段数一致");
    }

    /// 配额到顶后不得把请求挂着不放——否则测试结束时还留着一个永不落盘的 pending。
    #[test]
    fn clears_pending_once_capped() {
        let mut s = InterruptSnap::from_flag(true, 1).unwrap();
        s.request(p("first"));
        assert!(s.take_pending().is_some());
        s.request(p("after-cap"));
        assert!(s.take_pending().is_none(), "到顶后不得再落盘");
        assert!(s.take_pending().is_none(), "重复调用仍不得落盘");
    }

    /// 同一帧内 ASR 可能连发多个判决;只落第一个,不做每 interim 存盘。
    #[test]
    fn coalesces_multiple_requests_in_one_frame() {
        let mut s = InterruptSnap::from_flag(true, 3).unwrap();
        s.request(p("first"));
        s.request(p("second"));
        s.request(p("third"));
        let got = s.take_pending().expect("应有一段");
        assert_eq!(got.reason, "first", "同帧多次请求只保留第一次");
        assert!(s.take_pending().is_none(), "同帧不得落第二段");
        assert_eq!(s.taken(), 1);
    }
}
