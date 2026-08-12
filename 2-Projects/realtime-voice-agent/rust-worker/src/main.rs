//! voice-rust-worker — realtime-voice-agent 的 Rust 数据面 worker(P2 骨架)。
//!
//! 定位:选项 A 全量 Rust worker 的第一阶段——worker 协议 + 进房 + 音频收发 E2E。
//! 生产 Python worker 不受影响:本进程用独立 AGENT_NAME 注册,dispatch 按名派单。

mod config;
mod contract;
mod eot;
mod job;
mod llm;
mod pipeline;
mod playout;
mod segmenter;
mod stt_volc;
mod textproc;
mod token;
mod tts_volc;
mod turn;
mod vad;
mod volc;
mod worker;

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let cfg = config::Config::from_env()?;
    tracing::info!(
        agent_name = %cfg.agent_name,
        url = %cfg.ws_url,
        max_jobs = cfg.max_jobs,
        "voice-rust-worker starting"
    );
    // EOT sidecar 预热:启动即拉起(spawn+模型加载 ~2-4s),避免首轮判停预测赶上冷启动
    tokio::spawn(async {
        let _ = eot::EotClient::global().await;
    });
    worker::run(cfg).await
}
