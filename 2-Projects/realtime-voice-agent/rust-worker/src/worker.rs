//! agent worker 协议状态机(参照实现 = livekit-agents worker.py,协议 = livekit_agent.proto)。
//!
//! 流程:ws 连 `{LIVEKIT_URL}/agent`(Bearer agent-JWT) → Register → 等 RegisterWorkerResponse
//! → 消息循环(Availability 应答 / Assignment 起 job / Termination / Pong) + 定时 Ping 与
//! UpdateWorkerStatus。job 计数门与 Python 版 `_capped_load_fnc` 同语义:active >= max_jobs
//! 时 Availability 直接回 unavailable。

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
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

pub struct WorkerState {
    pub active_jobs: AtomicUsize,
}

pub async fn run(config: Config) -> Result<()> {
    let state = Arc::new(WorkerState { active_jobs: AtomicUsize::new(0) });
    let mut retry: u32 = 0;
    loop {
        match run_connection(&config, state.clone()).await {
            Ok(()) => {
                info!("worker connection closed");
                retry = 0;
            }
            Err(e) => {
                error!(error = %e, "worker connection failed");
                retry += 1;
                if retry > 12 {
                    bail!("连续 {} 次连接失败,放弃: {}", retry, e);
                }
            }
        }
        let backoff = u64::from((retry * 2).clamp(1, 10));
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        info!("reconnecting to livekit /agent ...");
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

    // job task → 主循环的出站消息通道
    let (msg_tx, mut msg_rx) = tokio::sync::mpsc::channel::<proto::WorkerMessage>(64);
    let mut ping_timer = tokio::time::interval(PING_INTERVAL);
    let mut status_timer = tokio::time::interval(STATUS_INTERVAL);

    loop {
        tokio::select! {
            Some(out) = msg_rx.recv() => {
                tx.send(WsMessage::Binary(out.encode_to_vec().into())).await?;
            }
            _ = ping_timer.tick() => {
                let ping = worker_msg(proto::worker_message::Message::Ping(proto::WorkerPing {
                    timestamp: unix_ms(),
                }));
                tx.send(WsMessage::Binary(ping.encode_to_vec().into())).await?;
            }
            _ = status_timer.tick() => {
                let active = state.active_jobs.load(Ordering::SeqCst);
                let load = if active >= config.max_jobs { 1.0 } else { 0.0 };
                let status = worker_msg(proto::worker_message::Message::UpdateWorker(
                    proto::UpdateWorkerStatus {
                        status: Some(if active >= config.max_jobs {
                            proto::WorkerStatus::WsFull as i32
                        } else {
                            proto::WorkerStatus::WsAvailable as i32
                        }),
                        load,
                        job_count: active as u32,
                    },
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
            let available = active < config.max_jobs;
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
        Some(Message::Pong(_)) | Some(Message::Register(_)) | None => {}
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
}
