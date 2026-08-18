//! job:进房 + 音轨装配,把音频流交给 cascade pipeline。
//!
//! 启动门(input_ready 合同 2026-08-18 重构,细节见 gate.rs):输入/输出解耦——
//! 用户轨订到即启输入链(不再等 LocalTrackSubscribed,旧耦合白等 ~950ms 吞用户首句);
//! 输出方向仍守「本地轨被订阅才出声」(P2 实测教训:缺它开播丢头),经 watch 传给
//! pipeline 的 OutputGate(首个待播 PCM 起 5s fail-closed)。生命周期:participant
//! 断开 → 关 pipeline → 关房(与 Python 版 close_on_disconnect+delete_room_on_close
//! 语义对齐,删房由 dispatch 配置负责)。
//!
//! 结构化打点(合同 §5.1):本文件的英文短语日志行就是事件名(job_assignment_received /
//! worker_room_connected / user_track_subscribed / agent_track_subscribed_by_android
//! / output_ready …),每行带 elapsed_ms(相对 assignment 到达)。

use anyhow::{Context, Result};
use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::prelude::*;
use livekit_protocol as proto;
use std::time::Instant;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::config::Config;
use crate::control;
use crate::gate::StartupGates;
use crate::pipeline;
use crate::token::server_api_jwt;
use crate::transcript_pub;
use crate::tts_volc::TTS_SAMPLE_RATE;

/// Session API 经 token agents[0].metadata → LiveKit 派单透传的受信元数据
/// (input_ready 合同:trace 绑定不信设备 payload 自述)。老 token 无此字段 →
/// 全 None,ready 事件降级不发(fail-visible,error 日志),Android 走超时兜底。
#[derive(serde::Deserialize, Default)]
struct JobMeta {
    trace_id: Option<String>,
    #[allow(dead_code)] // 回交对账用,当前事件只带 trace
    session_id: Option<String>,
}

/// room 名 `sn-<SN>-<unix秒>` 的尾秒 = Session API 签发时刻(合同定死格式)。
/// issue_to_assignment 观测用(秒级+跨机 NTP 误差,不进任何门禁)。
fn issue_to_assignment_ms(room_name: &str) -> Option<i64> {
    let sec: i64 = room_name.rsplit('-').next()?.parse().ok()?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    let delta = now_ms - sec * 1000;
    // 负值/超 10 分钟 = 非签发秒(web 房间等自定义 room 名),不产出误导数字
    (0..600_000).contains(&delta).then_some(delta)
}

pub async fn run_job(config: Config, job: proto::Job, url: String, token: String) -> Result<()> {
    let room_name = job
        .room
        .as_ref()
        .map(|r| r.name.clone())
        .unwrap_or_default();
    let t0 = Instant::now();
    let meta: JobMeta = serde_json::from_str(&job.metadata).unwrap_or_default();
    let issue_ms = issue_to_assignment_ms(&room_name);
    info!(
        job_id = %job.id,
        room = %room_name,
        elapsed_ms = 0u64,
        issue_to_assignment_ms = issue_ms,
        has_trace = meta.trace_id.is_some(),
        "job_assignment_received"
    );
    if meta.trace_id.is_none() {
        // 老 token / 非 Session API 房(web 调试直连):ready 事件无 trace 可绑,降级不发
        warn!(room = %room_name, "job.metadata 无 trace_id,session.input_ready 将不发(fail-visible)");
    }
    info!(job_id = %job.id, room = %room_name, elapsed_ms = t0.elapsed().as_millis() as u64, "worker_room_connect_start");

    let (room, mut events) = Room::connect(&url, &token, RoomOptions::default())
        .await
        .context("room connect")?;
    let connect_ms = t0.elapsed().as_millis() as u64;
    info!(
        room = %room_name,
        elapsed_ms = connect_ms,
        connect_ms,
        "worker_room_connected"
    );

    // agent 出声轨:24k mono(TTS 原生采样率直喂,RTC 内部重采样)。
    // 队列 200ms 对齐 Python room_io(queue_size_ms=200):pause 时排队尾音 ≤200ms
    // 自然放完(框架不 clear),硬打断才 clear_buffer。
    let source = NativeAudioSource::new(AudioSourceOptions::default(), TTS_SAMPLE_RATE, 1, 200);
    let track =
        LocalAudioTrack::create_audio_track("agent-voice", RtcAudioSource::Native(source.clone()));
    let agent_pub = room
        .local_participant()
        .publish_track(
            LocalTrack::Audio(track),
            TrackPublishOptions {
                source: TrackSource::Microphone,
                ..Default::default()
            },
        )
        .await
        .context("publish audio track")?;
    info!(room = %room_name, elapsed_ms = t0.elapsed().as_millis() as u64, "agent_track_published");
    let agent_identity = room.local_participant().identity().to_string();
    let agent_track_sid = agent_pub.sid().to_string();

    // 启动门解耦(gate.rs):决策归状态机,资源(mic/pipeline task)仍归本函数
    let mut gates = StartupGates::new();
    // 输出方向就绪信号 → pipeline OutputGate(首个待播 PCM 起 5s fail-closed)
    let (out_tx, out_rx) = tokio::sync::watch::channel(false);
    let mut out_rx = Some(out_rx);
    // user 轨订到时刻(track_to_input_loop 打点基准)
    let mut t_user_track: Option<Instant> = None;
    let mut mic_stream: Option<NativeAudioStream> = None;
    // 字幕路由:用户侧 (identity, 麦克风轨 sid),订阅到轨时采集
    let mut user_info: Option<(String, String)> = None;
    let mut pipeline_task: Option<JoinHandle<()>> = None;
    // 入站控制通道(S2-B1):设备 → worker 的 cancel/旁路事件。容量给足,
    // 满了宁可丢新包也不能阻塞 room 事件循环(那会连带卡住音频轨事件)。
    let (ctrl_tx, ctrl_rx) =
        mpsc::channel::<(control::Envelope, control::Inbound, Option<String>)>(64);
    let mut ctrl_rx = Some(ctrl_rx);
    // S2-B2 设备命令结果通道(android → worker,独立 topic 独立管道)
    let (devres_tx, devres_rx) = mpsc::channel::<control::DeviceResult>(16);
    let mut devres_rx = Some(devres_rx);
    // pipeline 主循环心跳(watchdog):0=未启动;主循环每 50ms tick 写 epoch ms。
    // 卡死实证(2026-08-16 voice-test-rust):主循环等 llm 锁僵死,job 层事件循环仍活
    // ——所以看门狗放这里,5s 无心跳即 break 走统一收尾(abort+关房删房),用户重连即新房。
    let beat = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut watchdog = tokio::time::interval(std::time::Duration::from_secs(1));
    watchdog.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        let ev = tokio::select! {
            ev = events.recv() => match ev {
                Some(ev) => ev,
                None => break,
            },
            _ = watchdog.tick() => {
                if let Some(t) = &pipeline_task
                    && !t.is_finished()
                {
                    let last = beat.load(std::sync::atomic::Ordering::Relaxed);
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    if last > 0 && now_ms.saturating_sub(last) > 5_000 {
                        tracing::error!(
                            room = %room_name,
                            stalled_ms = now_ms - last,
                            "pipeline 主循环卡死(watchdog 5s 无心跳)→ abort+关房自愈;已知诱因=主循环等 llm 锁(查 speculation/preemptive 与 pause 悬置)"
                        );
                        break;
                    }
                }
                continue;
            }
        };
        match ev {
            // 设备控制包。⚠️ worker 自己的 ack 也走 control topic,
            // 过滤在 control::parse 里(只认 src=android),不然会自己取消自己。
            RoomEvent::DataReceived {
                payload,
                topic,
                participant,
                ..
            } => {
                if topic.as_deref() == Some(control::TOPIC)
                    && let Some((ev, kind)) = control::parse(&payload)
                {
                    // participant identity 随包透传:canary.say 的白名单认它,不认 payload 自述
                    let identity = participant.as_ref().map(|p| p.identity().to_string());
                    if ctrl_tx.try_send((ev, kind, identity)).is_err() {
                        warn!(room = %room_name, "control 队列满,丢弃一个控制包");
                    }
                } else if topic.as_deref() == Some(control::DEVICE_RESULT_TOPIC) {
                    // S2-B2:result 只认 android 参与者实体(payload src 自述在 parse 里二验)
                    let from_agent = participant
                        .as_ref()
                        .map(|p| p.identity().as_str().starts_with("agent-"))
                        .unwrap_or(true);
                    if !from_agent
                        && let Some(r) = control::parse_device_result(&payload)
                    {
                        if devres_tx.try_send(r).is_err() {
                            warn!(room = %room_name, "device result 队列满,丢弃");
                        }
                    } else {
                        tracing::debug!(room = %room_name, "丢弃非法 device result 包");
                    }
                } else {
                    tracing::debug!(room = %room_name, ?topic, "丢弃无法解析的 data packet");
                }
            }
            RoomEvent::ParticipantConnected(p) => {
                info!(room = %room_name, identity = %p.identity(), "participant connected");
            }
            RoomEvent::LocalTrackSubscribed { .. } => {
                info!(room = %room_name, elapsed_ms = t0.elapsed().as_millis() as u64, "agent_track_subscribed_by_android");
                if gates.on_local_subscribed() {
                    let _ = out_tx.send(true);
                    info!(room = %room_name, elapsed_ms = t0.elapsed().as_millis() as u64, "output_ready");
                    // session.output_ready(合同 §5.4 仅诊断):无 trace 不发,与 input_ready 同纪律
                    if let Some(trace) = meta.trace_id.as_deref() {
                        publish_control(&room, control::output_ready(trace, unix_ms(), &room_name));
                    }
                }
            }
            RoomEvent::TrackSubscribed {
                track: RemoteTrack::Audio(audio),
                publication,
                participant,
            } => {
                info!(
                    room = %room_name,
                    identity = %participant.identity(),
                    elapsed_ms = t0.elapsed().as_millis() as u64,
                    "user_track_subscribed"
                );
                if gates.on_user_track() {
                    t_user_track = Some(Instant::now());
                    user_info = Some((
                        participant.identity().to_string(),
                        publication.sid().to_string(),
                    ));
                    // 16k 拉流:pipeline 的 VAD/STT 全按 16k 契约
                    mic_stream = Some(NativeAudioStream::new(audio.rtc_track(), 16_000, 1));
                }
                // 重复订阅(同 trace 重发)幂等:不重建流、不二次启动(合同 9.4)
            }
            // 输入侧观测(2026-08-12 聋窗排查加装):移动端息屏/切后台会 mute 上行轨,
            // 表现=worker 全聋且零报错;这两行是那类故障的第一现场证据。
            RoomEvent::TrackMuted {
                participant,
                publication,
            } => {
                warn!(
                    room = %room_name,
                    identity = %participant.identity(),
                    track = %publication.sid(),
                    "user track MUTED(疑似息屏/切后台,上行音频停)"
                );
            }
            RoomEvent::TrackUnmuted {
                participant,
                publication,
            } => {
                info!(
                    room = %room_name,
                    identity = %participant.identity(),
                    track = %publication.sid(),
                    "user track unmuted(上行音频恢复)"
                );
            }
            RoomEvent::ParticipantDisconnected(p) => {
                info!(
                    room = %room_name,
                    identity = %p.identity(),
                    "participant disconnected → closing job"
                );
                break;
            }
            RoomEvent::Disconnected { reason } => {
                info!(room = %room_name, ?reason, "room disconnected");
                break;
            }
            _ => {}
        }
        // input gate:用户轨就绪即启输入链(不等输出方向,解耦见 gate.rs 头注)
        if pipeline_task.is_none()
            && let Some(mic) = mic_stream.take()
        {
            info!(room = %room_name, elapsed_ms = t0.elapsed().as_millis() as u64, "input gate open, starting cascade pipeline");
            let src = source.clone();
            let rn = room_name.clone();
            let lp = room.local_participant();
            let (user_identity, user_track_sid) = user_info.clone().unwrap_or_default();
            let route = transcript_pub::Route {
                agent_identity: agent_identity.clone(),
                agent_track_sid: agent_track_sid.clone(),
                user_identity,
                user_track_sid,
            };
            let crx = ctrl_rx.take().expect("pipeline 只启动一次");
            let drx = devres_rx.take().expect("pipeline 只启动一次");
            let beat2 = beat.clone();
            let ready = pipeline::ReadyCtx {
                trace_id: meta.trace_id.clone(),
                out_rx: out_rx.take().expect("pipeline 只启动一次"),
                t_assign: t0,
                t_user_track: t_user_track.unwrap_or_else(Instant::now),
                connect_ms,
                issue_to_assignment_ms: issue_ms,
            };
            pipeline_task = Some(tokio::spawn(async move {
                if let Err(e) =
                    pipeline::run_pipeline(mic, src, lp, rn.clone(), route, crx, drx, beat2, ready)
                        .await
                {
                    tracing::warn!(room = %rn, error = %e, "pipeline exited with error");
                }
            }));
        }
    }

    if let Some(t) = pipeline_task.take() {
        t.abort();
    }
    room.close().await.ok();
    // 删房(对齐 Python delete_room_on_close=True):房间不删,空房存活 300s,
    // 用户重连会进"无 agent 的旧房"(dispatch 只在建房时发生)。删房=再连必新房必新 agent。
    delete_room(&config, &url, &room_name).await;
    info!(room = %room_name, uptime_s = t0.elapsed().as_secs(), "job closed");
    Ok(())
}

/// control topic 出站(reliable):session.output_ready 等 job 层事件。
/// 失败只记不抛——ready 事件是优化信号,Android 有超时兜底,不值得拖垮 job。
fn publish_control(room: &Room, v: serde_json::Value) {
    let p = room.local_participant();
    tokio::spawn(async move {
        let packet = livekit::DataPacket {
            payload: v.to_string().into_bytes(),
            topic: Some(control::TOPIC.to_string()),
            reliable: true,
            ..Default::default()
        };
        if let Err(e) = p.publish_data(packet).await {
            warn!(error = %e, "publish control event failed");
        }
    });
}

fn unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn delete_room(config: &Config, ws_url: &str, room_name: &str) {
    if room_name.is_empty() {
        return;
    }
    let http_url = ws_url
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1);
    let jwt = match server_api_jwt(&config.api_key, &config.api_secret, room_name) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = %e, "delete room: 签发 server token 失败");
            return;
        }
    };
    let url = format!(
        "{}/twirp/livekit.RoomService/DeleteRoom",
        http_url.trim_end_matches('/')
    );
    let client = reqwest::Client::new();
    match client
        .post(&url)
        .bearer_auth(jwt)
        .json(&serde_json::json!({"room": room_name}))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            info!(room = %room_name, "room deleted (delete_room_on_close)");
        }
        Ok(resp) => {
            tracing::warn!(room = %room_name, status = %resp.status(), "delete room 非 2xx");
        }
        Err(e) => tracing::warn!(room = %room_name, error = %e, "delete room 请求失败"),
    }
}
