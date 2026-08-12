//! EOT 判停 sidecar 客户端(UDS,协议见 sidecar/eot_sidecar.py):
//! 请求 u32le 字节数 + i16le PCM(≤19200 样本=1.2s@16k),响应 f32le 概率。
//!
//! 生命周期:进程级单例。EOT_SOCK(默认 /tmp/eot.sock)先直连;连不上且配了
//! EOT_SIDECAR_PYTHON 则 spawn sidecar 子进程再重试。全程失败 → 降级(None),
//! 判停走 min_delay(与框架 turn detector 预测失败的行为一致)。
//! 语义:概率 < unlikely_threshold(zh 0.3550,POC_EOU_UNLIKELY_THRESHOLD 可覆盖)
//! → 走 MAX_ENDPOINTING_DELAY,否则 MIN。predict 每话轮一次,非帧级热路径。

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

pub struct EotClient {
    stream: Mutex<UnixStream>,
    _child: Option<tokio::process::Child>, // 持有=随 worker 退出回收
}

static GLOBAL: tokio::sync::OnceCell<Option<EotClient>> = tokio::sync::OnceCell::const_new();

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
        let child = tokio::process::Command::new(&python)
            .arg(&script)
            .arg(&sock)
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
        let tail = &pcm[pcm.len() - take..];
        let mut buf = Vec::with_capacity(4 + tail.len() * 2);
        buf.extend_from_slice(&(u32::try_from(tail.len() * 2)?).to_le_bytes());
        for s in tail {
            buf.extend_from_slice(&s.to_le_bytes());
        }
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
