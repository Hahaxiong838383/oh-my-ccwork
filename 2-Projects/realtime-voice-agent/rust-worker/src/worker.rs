//! agent worker 协议状态机(参照实现 = livekit-agents worker.py,协议 = livekit_agent.proto)。
//!
//! 流程:ws 连 `{LIVEKIT_URL}/agent`(Bearer agent-JWT) → Register → 等 RegisterWorkerResponse
//! → 消息循环(Availability 应答 / Assignment 起 job / Termination / Pong) + 定时 Ping 与
//! UpdateWorkerStatus。job 计数门与 Python 版 `_capped_load_fnc` 同语义:active >= max_jobs
//! 时 Availability 直接回 unavailable。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use livekit_protocol as proto;
use prost::Message as _;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::job;

/// Python 侧 ATTRIBUTE_AGENT_NAME 同值(livekit/agents/types.py)。
const ATTR_AGENT_NAME: &str = "lk.agent.name";
const PING_INTERVAL: Duration = Duration::from_secs(30);
const STATUS_INTERVAL: Duration = Duration::from_secs(30);
/// /agent 重连：自上次注册成功起连续失败超过此数才放弃（退出交给 systemd Restart 拉起）。
/// LiveKit 持续不可达时每次尝试 ≈ 连接超时 + 退避，走到放弃约需 25–30 min，此时房间本就已死。
const MAX_CONSECUTIVE_RECONNECT_FAILURES: u32 = 12;
const RECONNECT_BACKOFF_MAX_SECS: u32 = 10;

pub struct WorkerState {
    pub active_jobs: AtomicUsize,
    /// 自上次注册成功（收到 RegisterWorkerResponse）起的连续 /agent 连接失败数。
    /// 2026-09-16 事故：旧计数只在「服务端干净关闭」时清零、重连成功不清零，09-12 LiveKit 机下电
    /// 25 min 攒下 12 次后一直背着，09-16 nginx 自动升级重启硬切 1 次即凑满 13 次 → 进程退出。
    pub reconnect_failures: AtomicU32,
}

/// 记一次 /agent 连接失败；返回自上次注册成功起的连续失败数。
pub(crate) fn note_reconnect_failure(state: &WorkerState) -> u32 {
    state.reconnect_failures.fetch_add(1, Ordering::SeqCst) + 1
}

/// 注册成功 → 连续失败数清零；返回清零前的值（>0 说明这次是断线后重连成功）。
pub(crate) fn note_registered(state: &WorkerState) -> u32 {
    state.reconnect_failures.swap(0, Ordering::SeqCst)
}

pub(crate) fn should_give_up(consecutive_failures: u32) -> bool {
    consecutive_failures > MAX_CONSECUTIVE_RECONNECT_FAILURES
}

/// 退避：2s × 连续失败数，封顶 10s（与改前一致）。
pub(crate) fn reconnect_backoff(consecutive_failures: u32) -> Duration {
    Duration::from_secs(u64::from((consecutive_failures * 2).clamp(1, RECONNECT_BACKOFF_MAX_SECS)))
}

async fn report_personal_status(state: Arc<WorkerState>, capacity: usize, path: std::path::PathBuf) {
    let temporary = path.with_extension("next");
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    loop {
        interval.tick().await;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default().as_millis() as u64;
        let status = serde_json::json!({
            "service": "personal-xiaoke",
            "sampled_ms": now,
            "registered": crate::search_canary::recent_registration(now),
            "jobs": state.active_jobs.load(Ordering::Relaxed),
            "capacity": capacity,
        });
        let write = async {
            tokio::fs::write(&temporary, status.to_string()).await?;
            tokio::fs::rename(&temporary, &path).await
        }.await;
        if let Err(error) = write {
            warn!(%error, "could not update personal worker status");
        }
    }
}

pub async fn run(config: Config) -> Result<()> {
    let state = Arc::new(WorkerState {
        active_jobs: AtomicUsize::new(0),
        reconnect_failures: AtomicU32::new(0),
    });
    if config.agent_name == crate::personal::AGENT {
        if let Some(path) = std::env::var_os("PERSONAL_STATUS_FILE") {
            tokio::spawn(report_personal_status(state.clone(), config.max_jobs, path.into()));
        }
    }
    tokio::spawn(crate::search_canary::health_loop(config.agent_name.clone(),state.clone()));
    loop {
        crate::search_canary::signal(false);
        let connection = run_connection(&config, state.clone()).await;
        if config.agent_name == crate::personal::AGENT {
            crate::search_canary::signal(false);
        }
        match connection {
            Ok(()) => {
                info!("worker connection closed");
                note_registered(&state);
            }
            Err(e) => {
                let n = note_reconnect_failure(&state);
                error!(error = %e, consecutive_failures = n, "worker connection failed");
                if should_give_up(n) {
                    bail!("自上次注册成功起连续 {n} 次连接失败,放弃(交给 systemd 拉起): {e}");
                }
            }
        }
        let n = state.reconnect_failures.load(Ordering::SeqCst);
        tokio::time::sleep(reconnect_backoff(n)).await;
        info!(consecutive_failures = n, "reconnecting to livekit /agent ...");
    }
}

fn worker_msg(m: proto::worker_message::Message) -> proto::WorkerMessage {
    proto::WorkerMessage { message: Some(m) }
}

async fn run_connection(config: &Config, state: Arc<WorkerState>) -> Result<()> {
    let agent_url = format!("{}/agent", config.ws_url.trim_end_matches('/'));
    let jwt = crate::token::agent_join_jwt(&config.api_key, &config.api_secret)?;
    let mut request = agent_url.clone().into_client_request()?;
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {jwt}").parse()?);

    let (ws, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .context("connect ws /agent")?;
    let (mut tx, mut rx) = ws.split();
    info!(url = %agent_url, agent_name = %config.agent_name, "connected to livekit /agent");

    // register(照 Python:type/allowed_permissions/agent_name/deployment/version)
    #[allow(deprecated)] // agent 字段 proto 标 deprecated,但 Python 参照实现仍设置,行为对齐
    let register = worker_msg(proto::worker_message::Message::Register(
        proto::RegisterWorkerRequest {
            r#type: proto::JobType::JtRoom as i32,
            agent_name: config.agent_name.clone(),
            version: format!("rust-{}", env!("CARGO_PKG_VERSION")),
            ping_interval: 0,
            namespace: None,
            allowed_permissions: Some(proto::ParticipantPermission {
                can_subscribe: true,
                can_publish: true,
                can_publish_data: true,
                can_update_metadata: true,
                hidden: false,
                agent: true,
                ..Default::default()
            }),
            deployment: String::new(),
        },
    ));
    tx.send(WsMessage::Binary(register.encode_to_vec().into()))
        .await?;

    // 第一条消息必须是 register response(照 Python 语义)
    let first = loop {
        match rx.next().await {
            Some(Ok(WsMessage::Binary(data))) => break data,
            Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_))) => continue,
            Some(Ok(other)) => bail!("register 前收到非二进制消息: {other:?}"),
            Some(Err(e)) => return Err(e.into()),
            None => bail!("register 前连接被关闭"),
        }
    };
    let first_msg = proto::ServerMessage::decode(first.as_ref())?;
    let Some(proto::server_message::Message::Register(reg)) = first_msg.message else {
        bail!("expected register response as first message, got {first_msg:?}");
    };
    info!(
        worker_id = %reg.worker_id,
        server = ?reg.server_info.as_ref().map(|s| s.version.clone()),
        "registered worker"
    );
    crate::search_canary::signal(true);
    let recovered_after = note_registered(&state);
    if recovered_after > 0 {
        info!(failures_before = recovered_after, "reconnected & registered, consecutive failure count reset");
    }

    // job task → 主循环的出站消息通道
    let (msg_tx, mut msg_rx) = tokio::sync::mpsc::channel::<proto::WorkerMessage>(64);
    let mut ping_timer = tokio::time::interval(PING_INTERVAL);
    let mut status_timer = tokio::time::interval(STATUS_INTERVAL);

    loop {
        tokio::select! {
            Some(out) = msg_rx.recv() => {
                tx.send(WsMessage::Binary(out.encode_to_vec().into())).await?;
                // Running/completed jobs change capacity immediately. Waiting
                // for the 30s heartbeat can strand a newly recreated room while
                // the SFU still considers this worker full. Read the current
                // count here, not a potentially stale snapshot queued by a job.
                let active = state.active_jobs.load(Ordering::SeqCst);
                let status = capacity_status(active, config.max_jobs);
                tx.send(WsMessage::Binary(worker_msg(
                    proto::worker_message::Message::UpdateWorker(status)
                ).encode_to_vec().into())).await?;
                info!(active_jobs = active, max_jobs = config.max_jobs,
                    available = active < config.max_jobs, "worker capacity advertised after job status");
            }
            _ = ping_timer.tick() => {
                let ping = worker_msg(proto::worker_message::Message::Ping(proto::WorkerPing {
                    timestamp: unix_ms(),
                }));
                tx.send(WsMessage::Binary(ping.encode_to_vec().into())).await?;
            }
            _ = status_timer.tick() => {
                let active = state.active_jobs.load(Ordering::SeqCst);
                let status = worker_msg(proto::worker_message::Message::UpdateWorker(
                    capacity_status(active, config.max_jobs),
                ));
                tx.send(WsMessage::Binary(status.encode_to_vec().into())).await?;
            }
            msg = rx.next() => match msg {
                Some(Ok(WsMessage::Binary(data))) => {
                    let server_msg = proto::ServerMessage::decode(data.as_ref())?;
                    handle_server_message(server_msg, config, &state, &msg_tx);
                }
                Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Frame(_) | WsMessage::Text(_))) => {}
                Some(Ok(WsMessage::Close(frame))) => {
                    info!(?frame, "server closed connection");
                    return Ok(());
                }
                Some(Err(e)) => return Err(e.into()),
                None => return Ok(()),
            }
        }
    }
}

fn handle_server_message(
    msg: proto::ServerMessage,
    config: &Config,
    state: &Arc<WorkerState>,
    msg_tx: &tokio::sync::mpsc::Sender<proto::WorkerMessage>,
) {
    use proto::server_message::Message;
    match msg.message {
        Some(Message::Availability(req)) => {
            let job = req.job.unwrap_or_default();
            let room_name = job.room.as_ref().map(|r| r.name.clone()).unwrap_or_default();
            let active = state.active_jobs.load(Ordering::SeqCst);
            let available = active < config.max_jobs && crate::search_canary::job_allowed(&config.agent_name,&room_name,&job.metadata);
            if !available {
                warn!(job_id = %job.id, room = %room_name, active, "at full capacity, declining job");
            } else {
                info!(job_id = %job.id, room = %room_name, "received job request, accepting");
            }
            let resp = availability_response(&job.id, available, &config.agent_name);
            let tx = msg_tx.clone();
            tokio::spawn(async move {
                let _ = tx.send(resp).await;
            });
        }
        Some(Message::Assignment(assign)) => {
            let job = assign.job.unwrap_or_default();
            let url = assign
                .url
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| config.ws_url.clone());
            let token = assign.token;
            let job_id = job.id.clone();
            state.active_jobs.fetch_add(1, Ordering::SeqCst);
            info!(job_id = %job_id, "job assignment received, spawning job task");
            let st = state.clone();
            let tx = msg_tx.clone();
            let cfg = config.clone();
            tokio::spawn(async move {
                let running = worker_msg(proto::worker_message::Message::UpdateJob(
                    proto::UpdateJobStatus {
                        job_id: job_id.clone(),
                        status: proto::JobStatus::JsRunning as i32,
                        error: String::new(),
                    },
                ));
                let _ = tx.send(running).await;

                let result = job::run_job(cfg, job, url, token).await;
                st.active_jobs.fetch_sub(1, Ordering::SeqCst);
                let (status, err) = match &result {
                    Ok(()) => (proto::JobStatus::JsSuccess, String::new()),
                    Err(e) => {
                        error!(job_id = %job_id, error = %e, "job failed");
                        (proto::JobStatus::JsFailed, e.to_string())
                    }
                };
                let done = worker_msg(proto::worker_message::Message::UpdateJob(
                    proto::UpdateJobStatus {
                        job_id: job_id.clone(),
                        status: status as i32,
                        error: err,
                    },
                ));
                let _ = tx.send(done).await;
                info!(job_id = %job_id, "process exiting");
            });
        }
        Some(Message::Termination(term)) => {
            // P2 骨架:job 靠 participant disconnect 自然收尾;termination 仅记录。
            warn!(job_id = %term.job_id, "job termination requested (P2: relying on room close)");
        }
        Some(Message::Pong(_)) => crate::search_canary::signal(true),
        Some(Message::Register(_)) | None => {}
    }
}

fn capacity_status(active: usize, max_jobs: usize) -> proto::UpdateWorkerStatus {
    let full = active >= max_jobs;
    proto::UpdateWorkerStatus {
        status: Some(if full { proto::WorkerStatus::WsFull } else { proto::WorkerStatus::WsAvailable } as i32),
        load: if full { 1.0 } else { 0.0 },
        job_count: active as u32,
    }
}

fn availability_response(
    job_id: &str,
    available: bool,
    agent_name: &str,
) -> proto::WorkerMessage {
    let mut attrs = HashMap::new();
    attrs.insert(ATTR_AGENT_NAME.to_string(), agent_name.to_string());
    worker_msg(proto::worker_message::Message::Availability(
        proto::AvailabilityResponse {
            job_id: job_id.to_string(),
            available,
            supports_resume: false,
            terminate: false,
            participant_name: agent_name.to_string(),
            participant_identity: format!("agent-{job_id}"),
            participant_metadata: String::new(),
            participant_attributes: attrs,
        },
    ))
}

fn unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn availability_response_carries_agent_attrs() {
        let msg = availability_response("job1", true, "rust-worker-dev");
        let Some(proto::worker_message::Message::Availability(a)) = msg.message else {
            panic!("wrong variant");
        };
        assert!(a.available);
        assert_eq!(a.job_id, "job1");
        assert_eq!(a.participant_identity, "agent-job1");
        assert_eq!(
            a.participant_attributes.get(ATTR_AGENT_NAME).map(String::as_str),
            Some("rust-worker-dev")
        );
    }

    #[test]
    fn full_capacity_declines() {
        let msg = availability_response("job2", false, "x");
        let Some(proto::worker_message::Message::Availability(a)) = msg.message else {
            panic!("wrong variant");
        };
        assert!(!a.available);
    }

    fn fresh_state() -> WorkerState {
        WorkerState { active_jobs: AtomicUsize::new(0), reconnect_failures: AtomicU32::new(0) }
    }

    /// 2026-09-16 事故回放：09-12 断网 12 次失败 → 第 12 次重连注册成功 → 三天后 nginx 重启再失败 1 次。
    /// 改前：累计 13 次 → 放弃退出；改后：注册成功已清零，这 1 次只是第 1 次，必须继续重连。
    #[test]
    fn incident_20260916_reconnect_after_registration_must_not_give_up() {
        let st = fresh_state();
        for _ in 0..12 {
            let n = note_reconnect_failure(&st);
            assert!(!should_give_up(n), "12 次以内不放弃 n={n}");
        }
        assert_eq!(note_registered(&st), 12, "注册成功应返回清零前的连续失败数");
        assert_eq!(st.reconnect_failures.load(Ordering::SeqCst), 0);
        let n = note_reconnect_failure(&st);
        assert_eq!(n, 1);
        assert!(!should_give_up(n), "注册成功后再失败 1 次不得放弃（改前会 13 次退出）");
        assert_eq!(reconnect_backoff(n), Duration::from_secs(2));
    }

    /// 真正连续 13 次（中间从未注册成功）才放弃 —— 放弃语义保留，只是「连续」名副其实。
    #[test]
    fn thirteen_consecutive_failures_without_registration_gives_up() {
        let st = fresh_state();
        for _ in 0..12 {
            let n = note_reconnect_failure(&st);
            assert!(!should_give_up(n));
        }
        let last = note_reconnect_failure(&st);
        assert_eq!(last, 13);
        assert!(should_give_up(last));
    }

    /// 干净关闭（Ok 路径）同样清零，与改前语义一致。
    #[test]
    fn clean_close_resets_counter_too() {
        let st = fresh_state();
        note_reconnect_failure(&st);
        note_reconnect_failure(&st);
        assert_eq!(note_registered(&st), 2);
        assert_eq!(note_registered(&st), 0, "已清零时再清零返回 0（非重连恢复，不打日志）");
    }

    #[test]
    fn backoff_table_unchanged() {
        assert_eq!(reconnect_backoff(0), Duration::from_secs(1));
        assert_eq!(reconnect_backoff(1), Duration::from_secs(2));
        assert_eq!(reconnect_backoff(4), Duration::from_secs(8));
        assert_eq!(reconnect_backoff(5), Duration::from_secs(10));
        assert_eq!(reconnect_backoff(12), Duration::from_secs(10));
    }
}
