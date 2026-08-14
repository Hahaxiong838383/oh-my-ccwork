//! 推理 sidecar 客户端(UDS,协议 v2 见 sidecar/eot_sidecar.py):
//! 请求 u8 op + u32le 字节数 + payload。
//! op=1 EOT 判停(i16le ≤19200 样本=1.2s@16k → f32le 概率);
//! op=2 声纹嵌入(i16le PCM → u32le dim + dim×f32le,已 L2 归一)。
//! EOT 与声纹各持一条连接:EOT 是判停热路径(每话轮),声纹比对数百 ms,共用会互相阻塞。
//!
//! 生命周期:进程级单例 + **连接级自愈**。EOT_SOCK(默认 /tmp/eot.sock)先直连;连不上且配了
//! EOT_SIDECAR_PYTHON 则 spawn sidecar 子进程再重试。
//!
//! ⚠️ 为什么必须自愈(2026-08-14 实证,灰度线静默降级近两天):
//! 旧实现把「客户端」整体放进 OnceCell——一旦初始化为 None 或握着一条后来断掉的连接,
//! **整个 worker 生命周期不再重试**,判停永久退化为 min_delay、声纹旁路永久关闭,
//! 而对话仍能进行,只有两条 WARN,从体感只是「变钝」,没有任何红灯。
//! 更坑的是 `systemctl restart` 自己就会造出这个状态:老 worker 的 sidecar 子进程
//! (kill_on_drop)尚未死透,新 worker 已经启动并连上它 → 走 `(existing)` 分支因而
//! **不 spawn 自己的子进程**;数百 ms 后老 sidecar 真死,新 worker 只剩一条死连接。
//! 故这里改为:OnceCell 只存**客户端外壳**(必定存在),连接可为空;每次请求失败即丢弃连接
//! 并触发**后台**重连/重拉(热路径不等待),下一轮自动恢复。
//! 设计取向沿用 [[agent 生命周期宁可简单重建,不要状态复用]]。
//!
//! 降级语义不变:拿不到连接 → 判停走 min_delay(与框架 turn detector 预测失败一致)、
//! 声纹旁路本轮跳过。概率 < unlikely_threshold(zh 0.3550,POC_EOU_UNLIKELY_THRESHOLD 可覆盖)
//! → 走 MAX_ENDPOINTING_DELAY,否则 MIN。

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::Mutex;
use tokio::time::Instant;
use tracing::{info, warn};

/// EOT 模型输入窗口:1.2s @ 16k(livekit local_inference EOT_MAX_SAMPLES)。
pub const EOT_MAX_SAMPLES: usize = 19_200;
/// v1-mini zh 校准阈值(livekit agents inference/eot/languages.py LOCAL_LANGUAGES["zh"])。
pub const UNLIKELY_THRESHOLD_ZH: f32 = 0.3550;

const OP_EOT: u8 = 1;
const OP_SPEAKER_EMBED: u8 = 2;
/// 两次 spawn 之间的最小间隔:sidecar 反复崩溃时防 spawn 风暴(每次 spawn 要加载模型 ~300MB)。
const SPAWN_COOLDOWN: Duration = Duration::from_secs(10);
/// spawn 后等模型加载就绪的上限(v1-mini ~1-2s)。
const READY_TIMEOUT: Duration = Duration::from_secs(15);

static GLOBAL: tokio::sync::OnceCell<EotClient> = tokio::sync::OnceCell::const_new();
static SPEAKER: tokio::sync::OnceCell<Option<SpeakerEmbedClient>> =
    tokio::sync::OnceCell::const_new();

fn sock_path() -> String {
    std::env::var("EOT_SOCK").unwrap_or_else(|_| "/tmp/eot.sock".into())
}

fn marshal_req(op: u8, pcm: &[i16]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(5 + pcm.len() * 2);
    buf.push(op);
    buf.extend_from_slice(&(pcm.len() as u32 * 2).to_le_bytes());
    for s in pcm {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}

pub struct EotClient {
    /// None = 当前无可用连接(降级中);后台自愈会填回。
    stream: Mutex<Option<UnixStream>>,
    /// 持有 sidecar 子进程=随 worker 退出回收;替换旧值即 kill_on_drop 掉旧进程。
    child: Mutex<Option<tokio::process::Child>>,
    last_spawn: Mutex<Option<Instant>>,
    /// 自愈任务在途标记:避免每轮请求都 spawn 一个修复任务。
    repairing: AtomicBool,
}

impl EotClient {
    /// 进程级单例。**恒返回 Some**——外壳必定存在,可用性体现在每次请求上。
    /// 启动时同步做一次 connect_or_spawn(保持原有预热语义:模型在 setup 期加载完)。
    pub async fn global() -> Option<&'static EotClient> {
        let c = GLOBAL
            .get_or_init(|| async {
                let c = EotClient {
                    stream: Mutex::new(None),
                    child: Mutex::new(None),
                    last_spawn: Mutex::new(None),
                    repairing: AtomicBool::new(false),
                };
                match c.dial().await {
                    Ok(s) => *c.stream.lock().await = Some(s),
                    Err(e) => warn!(error = %e, "EOT sidecar 首次连接失败,本轮降级;将在后续请求触发自愈"),
                }
                c
            })
            .await;
        Some(c)
    }

    /// 建立一条可用连接:先直连;连不上则(节流后)spawn sidecar 再等就绪。
    async fn dial(&self) -> Result<UnixStream> {
        let sock = sock_path();
        if let Ok(s) = UnixStream::connect(&sock).await {
            info!(sock = %sock, "EOT sidecar connected (existing)");
            return Ok(s);
        }
        let python = std::env::var("EOT_SIDECAR_PYTHON")
            .context("EOT_SOCK 连不上且 EOT_SIDECAR_PYTHON 未配置")?;
        {
            let mut last = self.last_spawn.lock().await;
            if let Some(t) = *last
                && t.elapsed() < SPAWN_COOLDOWN
            {
                anyhow::bail!("sidecar spawn 冷却中({}s 内已试过)", SPAWN_COOLDOWN.as_secs());
            }
            *last = Some(Instant::now());
        }
        let script = std::env::var("EOT_SIDECAR_SCRIPT").unwrap_or_else(|_| {
            format!("{}/sidecar/eot_sidecar.py", env!("CARGO_MANIFEST_DIR"))
        });
        // 声纹模型路径显式传给 sidecar(op=2 懒加载消费);未配走仓根默认
        let speaker_model = std::env::var("SPEAKER_ID_MODEL").unwrap_or_else(|_| {
            format!(
                "{}/../assets/models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
                env!("CARGO_MANIFEST_DIR")
            )
        });
        let child = tokio::process::Command::new(&python)
            .arg(&script)
            .arg(&sock)
            .env("SPEAKER_ID_MODEL", &speaker_model)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("spawn eot sidecar: {python} {script}"))?;
        // 存住新 child(旧的在此被 drop → kill_on_drop 回收,不留孤儿)
        *self.child.lock().await = Some(child);
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            match UnixStream::connect(&sock).await {
                Ok(s) => {
                    info!(sock = %sock, "EOT sidecar connected (spawned)");
                    return Ok(s);
                }
                Err(e) if Instant::now() >= deadline => {
                    return Err(anyhow::anyhow!("eot sidecar {}s 未就绪: {e}", READY_TIMEOUT.as_secs()));
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
    }

    /// 触发**后台**自愈。热路径不等待——spawn 要等模型加载十几秒,不能占判停预算。
    fn schedule_repair(&'static self) {
        if self.repairing.swap(true, Ordering::SeqCst) {
            return; // 已有修复任务在途
        }
        tokio::spawn(async move {
            match self.dial().await {
                Ok(s) => {
                    *self.stream.lock().await = Some(s);
                    info!("EOT sidecar 连接已自愈");
                }
                Err(e) => warn!(error = %e, "EOT sidecar 自愈失败,下轮再试"),
            }
            self.repairing.store(false, Ordering::SeqCst);
        });
    }

    /// 最近 ≤1.2s 用户音频 → P(话轮已结束)。串行(Mutex),整体超时 500ms。
    /// 无连接/请求失败 → 丢弃连接 + 触发后台自愈,本轮返回 Err(调用方降级 min_delay)。
    pub async fn predict(&'static self, pcm: &[i16]) -> Result<f32> {
        let take = pcm.len().min(EOT_MAX_SAMPLES);
        let buf = marshal_req(OP_EOT, &pcm[pcm.len() - take..]);
        let mut guard = self.stream.lock().await;
        let Some(stream) = guard.as_mut() else {
            drop(guard);
            self.schedule_repair();
            anyhow::bail!("EOT sidecar 无可用连接(自愈中)");
        };
        let r = tokio::time::timeout(Duration::from_millis(500), async {
            stream.write_all(&buf).await.context("eot write")?;
            let mut resp = [0u8; 4];
            stream.read_exact(&mut resp).await.context("eot read")?;
            Ok::<f32, anyhow::Error>(f32::from_le_bytes(resp))
        })
        .await
        .context("eot predict timeout")
        .and_then(|inner| inner);
        if r.is_err() {
            *guard = None; // 连接已不可信,丢弃
            drop(guard);
            self.schedule_repair();
        }
        r
    }
}

/// 声纹嵌入客户端(独立连接:比对数百 ms,不与 EOT 热路径互卡)。
pub struct SpeakerEmbedClient {
    stream: Mutex<Option<UnixStream>>,
    repairing: AtomicBool,
}

impl SpeakerEmbedClient {
    /// 进程级单例;sidecar 子进程由 EotClient 负责拉起与自愈,本端只管自己那条连接。
    pub async fn global() -> Option<&'static SpeakerEmbedClient> {
        SPEAKER
            .get_or_init(|| async {
                EotClient::global().await?; // 确保 sidecar 进程已就绪(或已在自愈)
                let c = SpeakerEmbedClient {
                    stream: Mutex::new(None),
                    repairing: AtomicBool::new(false),
                };
                match UnixStream::connect(sock_path()).await {
                    Ok(s) => {
                        info!(sock = %sock_path(), "speaker embed channel connected");
                        *c.stream.lock().await = Some(s);
                    }
                    Err(e) => warn!(error = %e, "speaker embed 首次连接失败,将随请求自愈"),
                }
                Some(c)
            })
            .await
            .as_ref()
    }

    fn schedule_repair(&'static self) {
        if self.repairing.swap(true, Ordering::SeqCst) {
            return;
        }
        tokio::spawn(async move {
            // sidecar 进程本身由 EotClient 保活;这里只重建自己这条连接
            match UnixStream::connect(sock_path()).await {
                Ok(s) => {
                    *self.stream.lock().await = Some(s);
                    info!("speaker embed 连接已自愈");
                }
                Err(e) => warn!(error = %e, "speaker embed 自愈失败,下轮再试"),
            }
            self.repairing.store(false, Ordering::SeqCst);
        });
    }

    /// 本轮用户有效语音 → L2 归一 embedding。超时 5s(CPU 推理 + 首次懒加载模型)。
    pub async fn embed(&'static self, pcm: &[i16]) -> Result<Vec<f32>> {
        let buf = marshal_req(OP_SPEAKER_EMBED, pcm);
        let mut guard = self.stream.lock().await;
        let Some(stream) = guard.as_mut() else {
            drop(guard);
            self.schedule_repair();
            anyhow::bail!("speaker embed 通道不可用(自愈中)");
        };
        let r = tokio::time::timeout(Duration::from_secs(5), async {
            stream.write_all(&buf).await.context("speaker write")?;
            let mut dim_buf = [0u8; 4];
            stream.read_exact(&mut dim_buf).await.context("speaker read dim")?;
            let dim = u32::from_le_bytes(dim_buf) as usize;
            anyhow::ensure!(dim > 0 && dim <= 4096, "speaker dim 异常: {dim}");
            let mut emb_buf = vec![0u8; dim * 4];
            stream.read_exact(&mut emb_buf).await.context("speaker read emb")?;
            Ok(emb_buf.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
        })
        .await
        .context("speaker embed timeout")
        .and_then(|inner| inner);
        if r.is_err() {
            *guard = None;
            drop(guard);
            self.schedule_repair();
        }
        r
    }
}
