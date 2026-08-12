//! voice-rust-worker — realtime-voice-agent 的 Rust 数据面 worker(P2 骨架)。
//!
//! 定位:选项 A 全量 Rust worker 的第一阶段——worker 协议 + 进房 + 音频收发 E2E。
//! 生产 Python worker 不受影响:本进程用独立 AGENT_NAME 注册,dispatch 按名派单。

mod config;
mod contract;
mod eot;
mod filler;
mod job;
mod llm;
mod pipeline;
mod playout;
mod preflight;
mod segmenter;
mod speaker_id;
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
    // RSS 采样(对齐 tier_a _rss_monitor_loop,内存曲线=本次重写的核心验收指标):
    // Linux 读 /proc 零依赖;macOS 无 /proc 静默退出。注意口径:Python 是 per-job
    // 进程,Rust 是整 worker 进程(多路共享),数值=全机 worker 占用,更利容量核算。
    tokio::spawn(rss_monitor());
    worker::run(cfg).await
}

async fn rss_monitor() {
    let t0 = std::time::Instant::now();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let Ok(status) = tokio::fs::read_to_string("/proc/self/status").await else {
            return; // 非 Linux,停采样
        };
        if let Some(line) = status.lines().find(|l| l.starts_with("VmRSS:"))
            && let Some(kb) = line.split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok())
        {
            tracing::info!("job rss: {}MB (uptime {}s)", kb / 1024, t0.elapsed().as_secs());
        }
    }
}
