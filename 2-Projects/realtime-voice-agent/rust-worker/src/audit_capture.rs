//! B50 §5:**一次性 30 秒上行取证窗口**——为「自打断是回声还是孩子说话」取一份声学证据。
//!
//! 川哥本轮授权:只在指定设备的一次会话里保存**最多 30 秒**上行音频,私有目录,不入仓、
//! 不公开,24 小时内删除。授权**没有**扩大到其它设备、其它会话、永久采集。
//!
//! ## 为什么不复用 `eot_snapshot`
//!
//! `SnapshotSink` 是「每个判停事件切一段」的形态:单 job 默认 50 份、每份 8 秒窗口,
//! **没有任何总时长门**——50×8s 远超 30 秒授权。codex B50 §5 点名了这点:
//! 「只设 max_per_job 或 24h 清理不等于满足 30 秒录音限制」。所以这里另起一个
//! **单份、连续、硬顶 480000 样本**的窗口,而不是去改那套配额语义。
//!
//! ## 护栏(每一条都是 fail-closed)
//!
//! 1. **默认不存在**:三个条件全满足才 `Some`——开关开、目录已配、本 job 是真实的
//!    首句 ordered_pcm 轮。自动欢迎 / presence_return 房结构性不具备首句标志,
//!    **抢不到这次授权**。
//! 2. **一次性**:用 `O_EXCL` 原子创建 claim 文件占坑。已存在 → 直接放弃,**不录第二次**。
//!    worker 重启也不会复活(claim 落在磁盘上)。要再录一次必须由人删掉 claim ——
//!    这是一次可审计的重新授权,不是自动续期。
//! 3. **硬顶 30 秒**:`MAX_SAMPLES` 是常量 480000(16kHz 单声道 = 30.0s),env 只能调小不能调大。
//!    满了就停止接收,不覆盖、不轮转。
//! 4. **旁路**:`push` 只做一次 `extend_from_slice`,不阻塞 ASR / 播放 / 媒体。
//! 5. **退出即收口**:写盘在 `Drop` 里——job 正常结束、fatal 早退、panic 展开,**每条路径都会走到**。
//!    只写一次(`wrote` 幂等)。
//! 6. **未用授权零文件**:没有合格 job 出现过 → 目录都不会建。
//!
//! ## 取证锚点(codex §5:`check_hotword` 的 interim 分支也要有取证点)
//!
//! 不再开第二个采集口——本窗口是**连续**的,那一刻本来就在窗口里。需要的是**索引**:
//! `marker()` 返回当前样本偏移,调用方把它写进 journal(只记事件名与偏移,**不带转写正文**),
//! 事后拿偏移去 WAV 里定位即可。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tracing::{info, warn};

/// 上行采样率:`NativeAudioStream::new(track, 16_000, 1)`,与 codex §5 规格一致。
pub const SR: u32 = 16_000;
/// 授权硬顶:30.0 秒 × 16000 = 480000 样本(s16 = 960000 音频字节,不含头)。
pub const MAX_SAMPLES: usize = 480_000;
/// 占坑文件名:`O_EXCL` 创建成功才算拿到这次授权。
pub const CLAIM_FILE: &str = "CLAIMED";

pub struct AuditCapture {
    dir: PathBuf,
    trace: String,
    max_samples: usize,
    /// 单调时间上限(codex §5:开始/停止绑定会话与单调时间)。上行卡顿时样本涨不动,
    /// 只有墙钟能兜住「窗口拖很久」——两个条件哪个先到都停。
    max_wall: Duration,
    buf: Vec<i16>,
    started: Instant,
    wrote: bool,
    dropped_after_full: u64,
}

impl AuditCapture {
    /// 武装判据(纯函数,单测锁死矩阵)。四个条件**全**满足才给出 (目录, trace)。
    /// 抽出来是因为:混在 `arm_from_env` 里时前一道 env 门会遮蔽后面的门——测试进程本来
    /// 就没设 env,于是「删掉 first_turn 门」这种注入照样全绿(2026-09-12 负向验证实撞)。
    pub fn should_arm(
        enabled: bool,
        first_turn: bool,
        dir: Option<&str>,
        job_trace: Option<&str>,
    ) -> Option<(String, String)> {
        if !enabled || !first_turn {
            return None;
        }
        let d = dir.filter(|d| !d.is_empty())?;
        let t = job_trace.filter(|t| !t.is_empty())?;
        Some((d.to_string(), t.to_string()))
    }

    /// 四个条件全满足才武装。`first_turn` = 本 job 是真实首句 ordered_pcm 轮
    /// (自动欢迎房为 false,结构性抢不到授权)。
    pub fn arm_from_env(job_trace: Option<&str>, first_turn: bool) -> Option<Self> {
        let enabled = std::env::var("ONESHOT_AUDIT_CAPTURE_ENABLED").ok().as_deref() == Some("1");
        let dir_env = std::env::var("ONESHOT_AUDIT_CAPTURE_DIR").ok();
        let (dir, trace) = Self::should_arm(enabled, first_turn, dir_env.as_deref(), job_trace)?;
        let max_ms: usize = std::env::var("ONESHOT_AUDIT_CAPTURE_MAX_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30_000);
        Self::arm(Path::new(&dir), trace, max_ms)
    }

    /// 实际武装:建根目录(0700)→ `O_EXCL` 占坑 → 成功才返回窗口。
    pub fn arm(dir: &Path, trace: String, max_ms: usize) -> Option<Self> {
        // env 只能把 30 秒调小,调大无效——授权上限是常量
        let max_samples = (max_ms.saturating_mul(SR as usize) / 1000).min(MAX_SAMPLES);
        if max_samples == 0 {
            return None;
        }
        if let Err(e) = std::fs::create_dir_all(dir) {
            warn!(error = %e, "audit capture: 建目录失败,放弃(不录)");
            return None;
        }
        Self::harden_dir(dir);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(CLAIM_FILE)) {
            Ok(mut f) => {
                let _ = writeln!(f, "{trace}");
            }
            Err(e) => {
                // 已占坑 = 这次授权用过了。不录第二次,也不报错刷屏。
                info!(error = %e, "audit capture: 授权已被上一次会话消费,本 job 不录");
                return None;
            }
        }
        info!(max_samples, max_ms = max_samples * 1000 / SR as usize,
              "audit capture 武装:单份连续上行,硬顶 30s,退出即写一次");
        Some(Self {
            dir: dir.to_path_buf(),
            trace,
            max_samples,
            max_wall: Duration::from_millis(max_ms.min(30_000) as u64),
            buf: Vec::with_capacity(max_samples.min(MAX_SAMPLES)),
            started: Instant::now(),
            wrote: false,
            dropped_after_full: 0,
        })
    }

    /// 已到停止条件:样本满 **或** 单调时间到,哪个先到算哪个。
    pub fn is_full(&self) -> bool {
        self.buf.len() >= self.max_samples || self.started.elapsed() >= self.max_wall
    }

    /// 停止原因(进 Drop 日志,便于事后判断这份 WAV 为什么是这个长度)。
    pub fn stop_reason(&self) -> &'static str {
        if self.buf.len() >= self.max_samples {
            "samples_cap"
        } else if self.started.elapsed() >= self.max_wall {
            "wall_cap"
        } else {
            "session_end"
        }
    }

    /// 旁路收音。到顶就停,不覆盖、不轮转。
    pub fn push(&mut self, samples: &[i16]) {
        if self.is_full() {
            self.dropped_after_full += samples.len() as u64;
            return;
        }
        let room = self.max_samples - self.buf.len();
        let take = room.min(samples.len());
        self.buf.extend_from_slice(&samples[..take]);
        if self.buf.len() >= self.max_samples {
            info!(samples = self.buf.len(), "audit capture 已达 30s 硬顶,停止收音(不轮转)");
        }
    }

    pub fn samples(&self) -> usize {
        self.buf.len()
    }

    /// 取证锚点:当前样本偏移(毫秒)。调用方只把事件名+偏移写进 journal,不带转写正文。
    pub fn marker_ms(&self) -> u64 {
        self.buf.len() as u64 * 1000 / SR as u64
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// 写一份 WAV(幂等)。返回 (路径, 样本数)。
    fn write_once(&mut self) -> Option<(PathBuf, usize)> {
        if self.wrote {
            return None;
        }
        self.wrote = true;
        if self.buf.is_empty() {
            info!("audit capture: 零样本,不产生音频文件");
            return None;
        }
        let path = self.dir.join(format!("uplink-{}.wav", &self.trace));
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SR,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        match hound::WavWriter::create(&path, spec) {
            Ok(mut w) => {
                for s in &self.buf {
                    if w.write_sample(*s).is_err() {
                        break;
                    }
                }
                if let Err(e) = w.finalize() {
                    warn!(error = %e, "audit capture: 收尾失败");
                    return None;
                }
                Self::harden_file(&path);
                Some((path, self.buf.len()))
            }
            Err(e) => {
                warn!(error = %e, "audit capture: 建 WAV 失败");
                None
            }
        }
    }

    #[cfg(unix)]
    fn harden_dir(dir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(unix)]
    fn harden_file(p: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    fn harden_dir(_d: &Path) {}
    #[cfg(not(unix))]
    fn harden_file(_p: &Path) {}
}

/// 退出即收口:job 正常结束 / fatal 早退 / panic 展开,每条路径都会走到这里。
impl Drop for AuditCapture {
    fn drop(&mut self) {
        let dur_ms = self.buf.len() as u64 * 1000 / SR as u64;
        let dropped = self.dropped_after_full;
        let reason = self.stop_reason();
        let wall_ms = self.elapsed_ms();
        match self.write_once() {
            Some((p, n)) => info!(
                samples = n,
                duration_ms = dur_ms,
                bytes_audio = n * 2,
                dropped_after_full = dropped,
                stop_reason = reason,
                window_wall_ms = wall_ms,
                path_name = %p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                "audit capture 收口:已写一份 WAV(0600)"
            ),
            None => info!(dropped_after_full = dropped, stop_reason = reason,
                          window_wall_ms = wall_ms, "audit capture 收口:未产生文件"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("audit-cap-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// 一次性:第一次拿到授权,第二次必须拿不到——`O_EXCL` 占坑是这条的载体。
    #[test]
    fn claim_is_one_shot() {
        let d = tmp("oneshot");
        let a = AuditCapture::arm(&d, "trace-a".into(), 30_000);
        assert!(a.is_some(), "首次必须拿到授权");
        drop(a);
        let b = AuditCapture::arm(&d, "trace-b".into(), 30_000);
        assert!(b.is_none(), "第二次必须拿不到:一次授权只录一次");
        assert!(d.join(CLAIM_FILE).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 30 秒是常量硬顶:env 只能调小,调大无效。
    #[test]
    fn max_is_hard_capped_at_30s() {
        let d = tmp("cap");
        let mut c = AuditCapture::arm(&d, "t".into(), 600_000).expect("arm");
        assert_eq!(c.max_samples, MAX_SAMPLES, "要 10 分钟也只给 30 秒");
        // 灌 40 秒,只应留下 30 秒
        let chunk = vec![7i16; 16_000];
        for _ in 0..40 {
            c.push(&chunk);
        }
        assert_eq!(c.samples(), MAX_SAMPLES);
        assert!(c.is_full());
        assert_eq!(c.marker_ms(), 30_000);
        drop(c);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 调小有效(不是只认常量)——否则「硬顶」与「压根不读 env」不可区分。
    #[test]
    fn smaller_max_is_honored() {
        let d = tmp("small");
        let mut c = AuditCapture::arm(&d, "t".into(), 5_000).expect("arm");
        assert_eq!(c.max_samples, 5 * SR as usize);
        c.push(&vec![1i16; 16_000 * 10]);
        assert_eq!(c.samples(), 5 * SR as usize);
        drop(c);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 退出即写一份,且只写一份;权限 0600。
    #[test]
    fn drop_writes_exactly_one_wav_0600() {
        let d = tmp("write");
        {
            let mut c = AuditCapture::arm(&d, "tr1".into(), 30_000).expect("arm");
            c.push(&vec![3i16; 1_600]); // 100ms
            assert_eq!(c.marker_ms(), 100);
        } // Drop 在这里写盘
        let wavs: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".wav"))
            .collect();
        assert_eq!(wavs.len(), 1, "只能有一份 WAV");
        assert_eq!(wavs[0], "uplink-tr1.wav");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let m = std::fs::metadata(d.join(&wavs[0])).unwrap().permissions().mode() & 0o777;
            assert_eq!(m, 0o600, "音频必须 0600");
            let dm = std::fs::metadata(&d).unwrap().permissions().mode() & 0o777;
            assert_eq!(dm, 0o700, "根目录必须 0700");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 零样本 → 不产生音频文件(「未用授权不创建音频文件」的载体)。
    #[test]
    fn zero_samples_writes_no_file() {
        let d = tmp("empty");
        {
            let _c = AuditCapture::arm(&d, "tr0".into(), 30_000).expect("arm");
        }
        let wavs = std::fs::read_dir(&d)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".wav"))
            .count();
        assert_eq!(wavs, 0, "没收到样本就不该有音频文件");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 满了之后继续喂:只计数,不覆盖、不轮转(授权是 30 秒,不是「最近 30 秒」)。
    #[test]
    fn full_window_does_not_rotate() {
        let d = tmp("norotate");
        let mut c = AuditCapture::arm(&d, "t".into(), 1_000).expect("arm");
        // ⚠️ 样本必须**逐个可分辨**:第一版用了全 1 的缓冲,轮转注入 drain+extend 之后
        // 长度和首样本都不变,测试照样全绿(2026-09-12 负向验证实撞)。
        let ramp: Vec<i16> = (0..SR as usize).map(|i| (i % 4096) as i16).collect();
        c.push(&ramp); // 灌满 1s,样本值成斜坡
        assert!(c.is_full());
        c.push(&vec![-9i16; 1_000]);
        assert_eq!(c.samples(), SR as usize, "长度不变");
        assert_eq!(c.buf, ramp, "整个窗口逐样本原封不动:轮转会让它整体左移");
        assert!(!c.buf.contains(&-9), "满之后的新数据一个样本都不许进来");
        assert_eq!(c.dropped_after_full, 1_000);
        drop(c);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 武装判据矩阵:四条缺任一都不武装,**且每一条单独失效都要被抓到**。
    /// 打纯函数而不是 `arm_from_env`——后者里 env 门会遮蔽 first_turn 门。
    #[test]
    fn should_arm_matrix() {
        assert_eq!(
            AuditCapture::should_arm(true, true, Some("/d"), Some("tr")),
            Some(("/d".into(), "tr".into())),
            "正锚:四条齐全必须武装,否则「全不武装」与「判据坏了」不可区分"
        );
        assert!(AuditCapture::should_arm(false, true, Some("/d"), Some("tr")).is_none(), "开关未开");
        assert!(
            AuditCapture::should_arm(true, false, Some("/d"), Some("tr")).is_none(),
            "非首句轮(自动欢迎/presence_return 房)必须抢不到这次授权"
        );
        assert!(AuditCapture::should_arm(true, true, None, Some("tr")).is_none(), "目录未配");
        assert!(AuditCapture::should_arm(true, true, Some(""), Some("tr")).is_none(), "目录空串");
        assert!(AuditCapture::should_arm(true, true, Some("/d"), None).is_none(), "无 trace");
        assert!(AuditCapture::should_arm(true, true, Some("/d"), Some("")).is_none(), "trace 空串");
    }

    /// 真实入口也要 fail-closed:测试进程没设 env,任何组合都不得武装。
    #[test]
    fn arm_from_env_is_fail_closed_without_env() {
        assert!(AuditCapture::arm_from_env(Some("t"), true).is_none());
        assert!(AuditCapture::arm_from_env(Some("t"), false).is_none());
        assert!(AuditCapture::arm_from_env(None, true).is_none());
    }

    /// 单调时间到也停(codex §5「绑定单调时间」):上行不卡时样本先满,卡了靠墙钟兜底。
    /// 用 backdate 起点而不是 sleep——sleep 会让测试变慢且抖。
    #[test]
    fn wall_clock_also_stops_the_window() {
        let d = tmp("wall");
        let mut c = AuditCapture::arm(&d, "t".into(), 30_000).expect("arm");
        c.push(&vec![1i16; 1_600]);
        assert!(!c.is_full(), "刚开始既没满样本也没到墙钟");
        assert_eq!(c.stop_reason(), "session_end");
        c.started = Instant::now() - Duration::from_millis(31_000); // 起点挪到 31 秒前
        assert!(c.is_full(), "墙钟到了也算满");
        assert_eq!(c.stop_reason(), "wall_cap");
        c.push(&vec![2i16; 1_600]);
        assert_eq!(c.samples(), 1_600, "墙钟到点后一个样本都不许再进");
        assert!(!c.buf.contains(&2));
        assert_eq!(c.dropped_after_full, 1_600);
        drop(c);
        let _ = std::fs::remove_dir_all(&d);
    }
}
