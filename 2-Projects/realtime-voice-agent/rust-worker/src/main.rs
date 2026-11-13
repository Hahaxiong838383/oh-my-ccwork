//! voice-rust-worker — realtime-voice-agent 的 Rust 数据面 worker(P2 骨架)。
//!
//! 定位:选项 A 全量 Rust worker 的第一阶段——worker 协议 + 进房 + 音频收发 E2E。
//! 生产 Python worker 不受影响:本进程用独立 AGENT_NAME 注册,dispatch 按名派单。

mod config;
mod contract;
mod candidate;
mod say_defer;
mod search_canary;
mod search_enrollment;
mod search_policy;
mod search_routing;
mod search_tasks;
mod search_dialogue;
mod search_progress;
mod search_receipts;
mod control;
mod device_grammar;
mod device_intent;
mod device_ledger;
mod eot;
mod eot_snapshot;
mod filler;
mod gate;
mod job;
mod startup_participant;
mod business_watchdog;
mod business_runtime;
mod owned_task;
mod room_cleanup;
mod room_verify;
mod voice_connect;
mod llm;
mod ordered_pcm;
mod pipeline;
mod playout;
mod preflight;
mod audit_capture;
mod backchannel;
mod caption_gate;
mod ready_confirm;
mod segmenter;
mod speaker_id;
mod stt_volc;
mod textproc;
mod stop_variants;
mod session_close;
mod token;
mod transcript_pub;
mod tts;
mod tts_volc;
mod tts_xfyun;
mod turn;
mod vad;
mod volc;
mod worker;
#[cfg(test)]
mod rtc_business_probe;

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // rustls 进程级 crypto provider(ring):运行时 TLS 全链 rustls——libwebrtc 静态库
    // 自带 BoringSSL 符号,链 openssl 会在 Linux 撞 duplicate symbol(dev198 实证);
    // reqwest rustls-no-provider 要求建 Client 前显式安装默认 provider。
    let _ = rustls::crypto::ring::default_provider().install_default();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let cfg = config::Config::from_env()?;
    search_canary::validate_startup(&cfg.agent_name,cfg.max_jobs)?;
    // Build the shared place dictionary before accepting jobs, including P1.
    // First-turn weather parsing must not allocate it on the audio event loop.
    search_routing::prepare_weather_places();
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
    // VAD 权重预加载(input_ready 合同:job 级 load 降为 new 状态,加载挪出输入链关键
    // 路径)。路径解析与 PipelineConfig::from_env 同源;失败 fail fast——模型缺失的
    // worker 接了单也是必挂,不如启动就死在带日志的地方。
    vad::preload(&pipeline::PipelineConfig::vad_model_path_from_env())?;
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
