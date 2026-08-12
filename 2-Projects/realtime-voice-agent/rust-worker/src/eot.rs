//! 推理 sidecar 客户端(UDS,协议 v2 见 sidecar/eot_sidecar.py):
//! 请求 u8 op + u32le 字节数 + payload。
//! op=1 EOT 判停(i16le ≤19200 样本=1.2s@16k → f32le 概率);
//! op=2 声纹嵌入(i16le PCM → u32le dim + dim×f32le,已 L2 归一)。
//! EOT 与声纹各持一条连接:EOT 是判停热路径(每话轮),声纹比对数百 ms,共用会互相阻塞。
//!
//! 生命周期:进程级单例。EOT_SOCK(默认 /tmp/eot.sock)先直连;连不上且配了
//! EOT_SIDECAR_PYTHON 则 spawn sidecar 子进程再重试。全程失败 → 降级(None),
//! 判停走 min_delay(与框架 turn detector 预测失败的行为一致)、声纹旁路关闭。
//! 语义:概率 < unlikely_threshold(zh 0.3550,POC_EOU_UNLIKELY_THRESHOLD 可覆盖)
//! → 走 MAX_ENDPOINTING_DELAY,否则 MIN。

use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::Mutex;
use tracing::{info, warn};

/// EOT 模型输入窗口:1.2s @ 16k(livekit local_inference EOT_MAX_SAMPLES)。
pub const EOT_MAX_SAMPLES: usize = 19_200;
/// v1-mini zh 校准阈值(livekit agents inference/eot/languages.py LOCAL_LANGUAGES["zh"])。
pub const UNLIKELY_THRESHOLD_ZH: f32 = 0.3550;

const OP_EOT: u8 = 1;
const OP_SPEAKER_EMBED: u8 = 2;

pub struct EotClient {
    stream: Mutex<UnixStream>,
    _child: Option<tokio::process::Child>, // 持有=随 worker 退出回收
}

static GLOBAL: tokio::sync::OnceCell<Option<EotClient>> = tokio::sync::OnceCell::const_new();
static SPEAKER: tokio::sync::OnceCell<Option<SpeakerEmbedClient>> =
    tokio::sync::OnceCell::const_new();

fn marshal_req(op: u8, pcm: &[i16]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(5 + pcm.len() * 2);
    buf.push(op);
    buf.extend_from_slice(&(pcm.len() as u32 * 2).to_le_bytes());
    for s in pcm {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}

impl EotClient {
    /// 进程级单例;不可用时 None(判停降级 min_delay,不阻塞主链路)。
    pub async fn global() -> Option<&'static EotClient> {
        GLOBAL
            .get_or_init(|| async {
                match Self::connect_or_spawn().await {
                    Ok(c) => Some(c),
                    Err(e) => {
                        warn!(error = %e, "EOT sidecar 不可用,判停降级为纯 delay(min)");
                        None
                    }
                }
            })
            .await
            .as_ref()
    }

    async fn connect_or_spawn() -> Result<Self> {
        let sock = std::env::var("EOT_SOCK").unwrap_or_else(|_| "/tmp/eot.sock".into());
        if let Ok(s) = UnixStream::connect(&sock).await {
            info!(sock = %sock, "EOT sidecar connected (existing)");
            return Ok(Self { stream: Mutex::new(s), _child: None });
        }
        let python = std::env::var("EOT_SIDECAR_PYTHON")
            .context("EOT_SOCK 连不上且 EOT_SIDECAR_PYTHON 未配置")?;
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
        // 等模型加载(v1-mini ~1-2s;上限 15s)
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            match UnixStream::connect(&sock).await {
                Ok(s) => {
                    info!(sock = %sock, "EOT sidecar connected (spawned)");
                    return Ok(Self { stream: Mutex::new(s), _child: Some(child) });
                }
                Err(e) if tokio::time::Instant::now() >= deadline => {
                    return Err(anyhow::anyhow!("eot sidecar 15s 未就绪: {e}"));
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
    }

    /// 最近 ≤1.2s 用户音频 → P(话轮已结束)。串行(Mutex),整体超时 500ms。
    pub async fn predict(&self, pcm: &[i16]) -> Result<f32> {
        let take = pcm.len().min(EOT_MAX_SAMPLES);
        let buf = marshal_req(OP_EOT, &pcm[pcm.len() - take..]);
        let mut stream = self.stream.lock().await;
        tokio::time::timeout(Duration::from_millis(500), async {
            stream.write_all(&buf).await.context("eot write")?;
            let mut resp = [0u8; 4];
            stream.read_exact(&mut resp).await.context("eot read")?;
            Ok::<f32, anyhow::Error>(f32::from_le_bytes(resp))
        })
        .await
        .context("eot predict timeout")?
    }
}

/// 声纹嵌入客户端(独立连接:比对数百 ms,不与 EOT 热路径互卡)。
pub struct SpeakerEmbedClient {
    stream: Mutex<UnixStream>,
}

impl SpeakerEmbedClient {
    /// 进程级单例;要求 sidecar 已由 EotClient 拉起(EOT 不可用时声纹旁路一并关闭)。
    pub async fn global() -> Option<&'static SpeakerEmbedClient> {
        SPEAKER
            .get_or_init(|| async {
                EotClient::global().await?; // 确保 sidecar 进程已就绪
                let sock = std::env::var("EOT_SOCK").unwrap_or_else(|_| "/tmp/eot.sock".into());
                match UnixStream::connect(&sock).await {
                    Ok(s) => {
                        info!(sock = %sock, "speaker embed channel connected");
                        Some(SpeakerEmbedClient { stream: Mutex::new(s) })
                    }
                    Err(e) => {
                        warn!(error = %e, "speaker embed 连接失败,声纹旁路关闭");
                        None
                    }
                }
            })
            .await
            .as_ref()
    }

    /// 本轮用户有效语音 → L2 归一 embedding。超时 5s(CPU 推理 + 首次懒加载模型)。
    pub async fn embed(&self, pcm: &[i16]) -> Result<Vec<f32>> {
        let buf = marshal_req(OP_SPEAKER_EMBED, pcm);
        let mut stream = self.stream.lock().await;
        tokio::time::timeout(Duration::from_secs(5), async {
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
        .context("speaker embed timeout")?
    }
}
