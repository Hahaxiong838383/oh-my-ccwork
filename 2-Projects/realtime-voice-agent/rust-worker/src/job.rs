//! job:进房 + 音轨装配,把音频流交给 cascade pipeline。
//!
//! 启动门(input_ready 合同 2026-08-18 重构,细节见 gate.rs):输入/输出解耦——
//! 用户轨订到即启输入链(不再等 LocalTrackSubscribed,旧耦合白等 ~950ms 吞用户首句);
//! 输出方向仍守「本地轨被订阅才出声」(P2 实测教训:缺它开播丢头),经 watch 传给
//! pipeline 的 OutputGate(首个待播 PCM 起 5s fail-closed)。生命周期:participant
//! 已开输入的参与者断开 → 关 pipeline → 关房；尚未开输入的设备房可在有界窗口内
//! 接纳同身份新 SID，避免旧连接退出误删正在恢复的房间。
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
use crate::owned_task::OwnedTask;
use crate::startup_participant::{Departure, StartupParticipant};
use crate::token::server_api_jwt;
use crate::transcript_pub;
use crate::tts_volc::TTS_SAMPLE_RATE;

/// Session API 经 token agents[0].metadata → LiveKit 派单透传的受信元数据
/// (input_ready 合同:trace 绑定不信设备 payload 自述)。老 token 无此字段 →
/// 全 None,ready 事件降级不发(fail-visible,error 日志),Android 走超时兜底。
#[derive(serde::Deserialize, Default)]
struct JobMeta {
    voice_idle: Option<serde_json::Value>,
    filler_policy: Option<serde_json::Value>,
    trace_id: Option<String>,
    #[allow(dead_code)] // 回交对账用,当前事件只带 trace
    session_id: Option<String>,
    /// 签发时刻毫秒级(READY_LATENCY 合同 2026-08-18,server 侧 Date.now() 直传)。
    /// 优先口径;缺省回退房名尾秒——秒级口径自带 ±1s 量化噪声,曾把真实 ~300ms 的
    /// assignment 观测成 p95=1290ms(50 轮 journal 实证,分布与噪声模型吻合)。
    issue_ts_ms: Option<i64>,
    /// One-shot v0.3(2026-09-08):受信输入模式。`ordered_pcm`=实验(RTC 帧不进识别,只吃有序 PCM 代次);
    /// 缺省/其它=现役。只认服务端签发的 job.metadata,设备 payload 自述不算;job 第一帧前固定,房中途不可改。
    input_mode: Option<String>,
    /// 本地承接 v1（2026-09-09）：签发 metadata `"local_receipt":"v1"` 的房才允许 begin 声明本地承接（与 input_mode 同源受信）。
    local_receipt: Option<String>,
    /// B23 产品首句 v1（2026-09-11）：签发 metadata `"oneshot_first_turn":"v1"` → 首句代次终态后同房切回 RTC 多轮；
    /// 缺省 = POC 一房一代旧语义。只认 job.metadata。
    oneshot_first_turn: Option<String>,
}

/// issue→assignment 观测(不进任何门禁)。毫秒口径优先(残余=两机 NTP 偏差,几十 ms 量级);
/// 回退 room 名 `sn-<SN>-<unix秒>` 尾秒(合同定死格式,±1s 量化噪声)。
fn issue_to_assignment_ms(room_name: &str, issue_ts_ms: Option<i64>) -> Option<i64> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    // 负值/超 10 分钟 = 时钟异常或非签发值,不产出误导数字
    let valid = |d: i64| (0..600_000).contains(&d).then_some(d);
    if let Some(t) = issue_ts_ms
        && let Some(d) = valid(now_ms - t)
    {
        return Some(d);
    }
    let sec: i64 = room_name.rsplit('-').next()?.parse().ok()?;
    valid(now_ms - sec * 1000)
}

// A finished pipeline no longer updates its heartbeat. Observe its JoinHandle
// directly so a silent connected device cannot keep a dead job/room alive.
enum JobWake<E> {
    Room(Option<E>),
    Pipeline(std::result::Result<Result<()>, tokio::task::JoinError>),
    Watchdog,
}

async fn next_job_wake<E>(
    room_event: impl std::future::Future<Output = Option<E>>,
    pipeline: &mut Option<JoinHandle<Result<()>>>,
    watchdog: &mut tokio::time::Interval,
) -> JobWake<E> {
    tokio::select! {
        biased;
        result = async {
            match pipeline.as_mut() {
                Some(task) => task.await,
                None => std::future::pending().await,
            }
        } => {
            pipeline.take(); // already joined; cleanup must not poll it again
            JobWake::Pipeline(result)
        },
        _ = watchdog.tick() => JobWake::Watchdog,
        event = room_event => JobWake::Room(event),
    }
}

pub async fn run_job(config: Config, job: proto::Job, url: String, token: String) -> Result<()> {
    let t0 = Instant::now();
    let room_name = job
        .room
        .as_ref()
        .map(|r| r.name.clone())
        .unwrap_or_default();
    anyhow::ensure!(crate::search_canary::job_allowed(&config.agent_name,&room_name,&job.metadata), "canary_job_rejected");
    let sid = job.room.as_ref().map(|r| r.sid.as_str()).unwrap_or_default();
    let mut close_intent = match crate::room_cleanup::CloseIntent::begin(&config.agent_name, &room_name, sid, &job.metadata) {
        Ok(intent) => intent,
        Err(_) => {
            let _ = delete_room(&config, &url, &room_name).await;
            anyhow::bail!("candidate room cleanup registration failed");
        }
    };
    let meta: JobMeta = serde_json::from_str(&job.metadata).unwrap_or_default();
    let business = crate::business_runtime::Runtime::from_env(&room_name, meta.voice_idle.as_ref(), t0);
    let mut business_last_decision = None;
    if let Some(w) = &business { info!(room=%room_name, room_sid=%sid, revision=w.revision().unwrap_or("missing"), "business watchdog attached"); }
    let filler_policy = crate::filler::FillerPolicy::from_metadata(meta.filler_policy.as_ref(), &room_name);
    if meta.filler_policy.is_some() && filler_policy.is_none() { warn!(room = %room_name, "invalid filler policy ignored; legacy fallback"); }
    let issue_ms = issue_to_assignment_ms(&room_name, meta.issue_ts_ms);
    info!(
        job_id = %job.id,
        room = %room_name,
        room_sid = %sid,
        trace = meta.trace_id.as_deref().unwrap_or("-"),
        elapsed_ms = 0u64,
        issue_to_assignment_ms = issue_ms,
        issue_clock = if meta.issue_ts_ms.is_some() { "ms" } else { "sec" },
        has_trace = meta.trace_id.is_some(),
        "job_assignment_received"
    );
    if meta.trace_id.is_none() {
        // 老 token / 非 Session API 房(web 调试直连):ready 事件无 trace 可绑,降级不发
        warn!(room = %room_name, "job.metadata 无 trace_id,session.input_ready 将不发(fail-visible)");
    }
    // 预组装(2026-09-07):ASR 预连 + VAD 模型/填充语库/声纹库/LLM·TTS 客户端与预热/回声库拉取,全部与建房/发布出声轨/
    // 等用户音轨并行;订到轨后 pipeline 直接接管。OwnedTask 保证提前退出/未接管结果被丢弃时取消 ASR。
    let mut prebuilt_task = Some(OwnedTask::new(tokio::spawn(pipeline::prebuild(room_name.clone()))));
    info!(job_id = %job.id, room = %room_name, elapsed_ms = t0.elapsed().as_millis() as u64, "worker_room_connect_start");

    let startup_deadline = business.as_ref().and_then(|w| w.startup_deadline());
    let connected = crate::business_runtime::within_startup(startup_deadline,
        async { Room::connect(&url, &token, RoomOptions::default()).await.map_err(Into::into) }).await;
    let (room, mut events) = match connected {
        Ok(value) => value,
        Err(error) => {
            if business.is_some() {
                drop(prebuilt_task.take());
                let cleanup = crate::room_verify::delete_exact(&config,&url,&room_name,sid).await;
                warn!(room=%room_name,room_sid=%sid,?cleanup,"startup connect failed; cleanup readback");
            }
            return Err(error.context("room connect"));
        }
    };
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
    let mut agent_pub = match crate::business_runtime::within_startup(startup_deadline, publish_output_track(&room, &source)).await {
        Ok(value) => value,
        Err(error) => {
            if business.is_some() {
                drop(prebuilt_task.take());
                let _=tokio::time::timeout(std::time::Duration::from_secs(2),room.close()).await;
                let cleanup=crate::room_verify::delete_exact(&config,&url,&room_name,sid).await;
                warn!(room=%room_name,room_sid=%sid,?cleanup,"startup publish failed; cleanup readback");
            }
            return Err(error.context("publish audio track"));
        }
    };
    info!(job_id = %job.id, room = %room_name, room_sid = %sid,
        trace = meta.trace_id.as_deref().unwrap_or("-"), agent_track_sid = %agent_pub.sid(),
        elapsed_ms = t0.elapsed().as_millis() as u64, "agent_track_published");
    let agent_identity = room.local_participant().identity().to_string();
    let mut agent_track_sid = agent_pub.sid().to_string();

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
    let mut pipeline_task: Option<JoinHandle<Result<()>>> = None;
    let (close_tx,close_rx)=tokio::sync::oneshot::channel();
    let mut pipeline_close_tx=Some(close_tx);let mut pipeline_close_rx=Some(close_rx);
    let graceful_search_close=std::env::var("P003_SEARCH_RESUME_V1").is_ok_and(|v|v=="1");
    // 入站控制通道(S2-B1):设备 → worker 的 cancel/旁路事件。容量给足,
    // 满了宁可丢新包也不能阻塞 room 事件循环(那会连带卡住音频轨事件)。
    let (ctrl_tx, ctrl_rx) =
        mpsc::channel::<(control::Envelope, control::Inbound, Option<String>)>(64);
    let mut ctrl_rx = Some(ctrl_rx);
    // S2-B2 设备命令结果通道(android → worker,独立 topic 独立管道)
    let (devres_tx, devres_rx) = mpsc::channel::<(control::DeviceResult, Option<String>)>(16);
    let mut devres_rx = Some(devres_rx);
    // One-shot v0.3:有序 PCM 入口(默认关;只有受信 metadata 声明 ordered_pcm 的房才消费)。
    // 容量 256:设备按 40 ms 片(640 样本)发 6 s 历史=150 片也放得下;满则丢包→该代因缺片终态失败(fail-closed)。
    let input_mode = crate::ordered_pcm::InputMode::from_meta(meta.input_mode.as_deref());
    let ordered_local_receipt = meta.local_receipt.as_deref() == Some("v1");
    let ordered_first_turn = input_mode == crate::ordered_pcm::InputMode::OrderedPcm && meta.oneshot_first_turn.as_deref() == Some("v1");
    let ordered_ctx = pipeline::OrderedCtx { local_receipt: ordered_local_receipt, first_turn_rtc: ordered_first_turn, session_id: meta.session_id.clone() };
    let expected_device = crate::ordered_pcm::expected_device_identity(&room_name);
    let mut participant_lifecycle = StartupParticipant::new(expected_device.clone());
    // Participants present at Room::connect need not emit ParticipantConnected.
    for p in room.remote_participants().values() {
        participant_lifecycle.connected(&p.identity().to_string(), &p.sid().to_string(), t0.elapsed().as_millis() as u64);
    }
    let (hist_tx, hist_rx) = mpsc::channel::<crate::ordered_pcm::Packet>(256);
    let mut hist_rx = Some(hist_rx);
    if input_mode == crate::ordered_pcm::InputMode::OrderedPcm {
        info!(room = %room_name, expected_device = expected_device.as_deref().unwrap_or("-"), local_receipt = ordered_local_receipt,
              first_turn_rtc = ordered_first_turn, "input_mode=ordered_pcm(受信 metadata):RTC 音频不进识别");
    }
    // pipeline 主循环心跳(watchdog):0=未启动;主循环每 50ms tick 写 assignment 起单调毫秒。
    // 卡死实证(2026-08-16 voice-test-rust):主循环等 llm 锁僵死,job 层事件循环仍活
    // ——所以看门狗放这里,5s 无心跳即 break 走统一收尾(abort+关房删房),用户重连即新房。
    let beat = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut watchdog = tokio::time::interval(std::time::Duration::from_secs(1));
    watchdog.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        let ev = match next_job_wake(events.recv(), &mut pipeline_task, &mut watchdog).await {
            JobWake::Room(Some(ev)) => ev,
            JobWake::Room(None) => break,
            JobWake::Pipeline(result) => {
                match result {
                    Ok(Ok(())) => info!(job_id = %job.id, room = %room_name, room_sid = %sid, "pipeline ended → closing job"),
                    Ok(Err(e)) => warn!(job_id = %job.id, room = %room_name, room_sid = %sid, error = %e, "pipeline failed → closing job"),
                    Err(e) => warn!(job_id = %job.id, room = %room_name, room_sid = %sid, panic = e.is_panic(), cancelled = e.is_cancelled(), "pipeline join failed → closing job"),
                }
                break;
            }
            JobWake::Watchdog => {
                if let Some(w) = &business {
                    let decision = w.evaluate(Instant::now());
                    if business_last_decision != Some(decision) {
                        info!(room=%room_name, room_sid=%sid, trace=meta.trace_id.as_deref().unwrap_or("-"), ?decision,
                            elapsed_ms=t0.elapsed().as_millis() as u64, "business watchdog decision");
                        business_last_decision = Some(decision);
                    }
                    if matches!(decision, crate::business_watchdog::Decision::Close(_)) { break; }
                }
                if participant_lifecycle.expired(t0.elapsed().as_millis() as u64) {
                    info!(room=%room_name, "startup participant recovery expired → closing job");
                    break;
                }
                if !crate::search_canary::job_allowed(&config.agent_name,&room_name,&job.metadata) {
                    info!(room=%room_name,"canary window closed: closing room, reconnect returns baseline");
                    break;
                }
                if let Some(t) = &pipeline_task
                    && !t.is_finished()
                {
                    let last = beat.load(std::sync::atomic::Ordering::Relaxed);
                    let now_ms = t0.elapsed().as_millis() as u64;
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
        if participant_lifecycle.expired(t0.elapsed().as_millis() as u64) { break; }
        match ev {
            // 设备控制包。⚠️ worker 自己的 ack 也走 control topic,
            // 过滤在 control::parse 里(只认 src=android),不然会自己取消自己。
            RoomEvent::DataReceived {
                payload,
                topic,
                participant,
                ..
            } => {
                // Ignore queued data from an obsolete device connection.
                if expected_device.is_some() && !participant.as_ref().is_some_and(|p|
                    current_remote(&room, p) && participant_lifecycle.accepts(&p.identity().to_string(), &p.sid().to_string())) { continue; }
                if topic.as_deref() == Some(control::TOPIC)
                    && let Some((ev, kind)) = control::parse(&payload)
                {
                    // participant identity 随包透传:canary.say 的白名单认它,不认 payload 自述
                    let identity = participant.as_ref().map(|p| p.identity().to_string());
                    if ctrl_tx.try_send((ev, kind, identity)).is_err() {
                        warn!(room = %room_name, "control 队列满,丢弃一个控制包");
                    }
                } else if topic.as_deref() == Some(control::DEVICE_RESULT_TOPIC) {
                    // S2-B2 + v3.1 R4(codex 复核 §5):result 只认**本房绑定的设备 participant**(用户轨订阅时记下的身份),
                    // 不再只排除 agent- 前缀;payload src 自述在 parse 里二验。身份随包透传给 pipeline 记日志。
                    let ident = participant.as_ref().map(|p| p.identity().to_string());
                    let bound = user_info.as_ref().map(|(i, _)| i.as_str());
                    if bound.is_some()
                        && ident.as_deref() == bound
                        && let Some(r) = control::parse_device_result(&payload)
                    {
                        if devres_tx.try_send((r, ident)).is_err() {
                            warn!(room = %room_name, "device result 队列满,丢弃");
                        }
                    } else {
                        tracing::debug!(room = %room_name, identity = ident.as_deref().unwrap_or("-"),
                            bound = bound.unwrap_or("-"), "丢弃 device result 包(非绑定设备身份或畸形)");
                    }
                } else if topic.as_deref() == Some(crate::ordered_pcm::TOPIC) {
                    // One-shot v0.3:有序 PCM 包。只在受信 ordered 模式 + 发包者身份 == 房名推导的设备身份(dev-<SN>)
                    // 时进管道(begin 可早于用户轨订阅到达,故不用 user_info 绑定);其它一律丢弃(现役房零参与)。
                    let ident = participant.as_ref().map(|p| p.identity().to_string());
                    if input_mode == crate::ordered_pcm::InputMode::OrderedPcm
                        && expected_device.is_some()
                        && ident.as_deref() == expected_device.as_deref()
                    {
                        match crate::ordered_pcm::parse_packet(&payload) {
                            Ok(pkt) => {
                                if hist_tx.try_send(pkt).is_err() {
                                    warn!(room = %room_name, "ordered_pcm 入站队列满,丢弃一个包(该代将因缺片终态失败)");
                                }
                            }
                            Err(e) => warn!(room = %room_name, error = ?e, "ordered_pcm 包解析失败,丢弃"),
                        }
                    } else {
                        tracing::debug!(room = %room_name, mode = ?input_mode, identity = ident.as_deref().unwrap_or("-"),
                            "丢弃 ordered_pcm 包(非实验模式或非设备身份)");
                    }
                } else {
                    tracing::debug!(room = %room_name, ?topic, "丢弃无法解析的 data packet");
                }
            }
            RoomEvent::ParticipantConnected(p) => {
                info!(room = %room_name, identity = %p.identity(), participant_sid = %p.sid(), "participant connected");
                if current_remote(&room, &p) && participant_lifecycle.connected(
                    &p.identity().to_string(), &p.sid().to_string(), t0.elapsed().as_millis() as u64) {
                    // No pipeline has started: there is no search/ordered state to reuse.
                    discard_pending(&mut ctrl_rx);
                    discard_pending(&mut devres_rx);
                    discard_pending(&mut hist_rx);
                    gates = StartupGates::new();
                    let _ = out_tx.send(false);
                    mic_stream = None;
                    user_info = None;
                    drop(prebuilt_task.take());
                    prebuilt_task = Some(OwnedTask::new(tokio::spawn(pipeline::prebuild(room_name.clone()))));
                    // LocalTrackSubscribed is a one-shot per publication in the
                    // SDK. Republish before input starts so the new SID must
                    // establish its own output readiness, not inherit the old one.
                    let renewed = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                        room.local_participant().unpublish_track(&agent_pub.sid()).await?;
                        publish_output_track(&room, &source).await
                    }).await;
                    match renewed {
                        Ok(Ok(publication)) => {
                            agent_pub = publication;
                            agent_track_sid = agent_pub.sid().to_string();
                        },
                        Ok(Err(e)) => { warn!(room=%room_name, error=%e, "replacement output publish failed"); break; },
                        Err(_) => { warn!(room=%room_name, "replacement output publish timed out"); break; },
                    }
                    info!(room=%room_name, participant_sid=%p.sid(), agent_track_sid=%agent_track_sid, "startup participant replacement accepted");
                }
            }
            RoomEvent::LocalTrackSubscribed { track } => {
                if track.sid() != agent_pub.sid() {
                    info!(job_id = %job.id, room = %room_name, room_sid = %sid,
                        trace = meta.trace_id.as_deref().unwrap_or("-"),
                        event_track_sid = %track.sid(), agent_track_sid = %agent_pub.sid(),
                        decision = "discard_sid_mismatch", "output subscription discarded");
                    continue;
                }
                let first_subscription = gates.on_local_subscribed();
                info!(job_id = %job.id, room = %room_name, room_sid = %sid,
                    trace = meta.trace_id.as_deref().unwrap_or("-"),
                    event_track_sid = %track.sid(), agent_track_sid = %agent_pub.sid(),
                    decision = if first_subscription { "accept" } else { "discard_already_open" },
                    elapsed_ms = t0.elapsed().as_millis() as u64, "agent_track_subscribed_by_android");
                if first_subscription {
                    let _ = out_tx.send(true);
                    info!(job_id = %job.id, room = %room_name, room_sid = %sid,
                        agent_track_sid = %agent_pub.sid(), elapsed_ms = t0.elapsed().as_millis() as u64, "output_ready");
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
                if !current_remote(&room, &participant) || !participant_lifecycle.accepts(
                    &participant.identity().to_string(), &participant.sid().to_string()) {
                    info!(job_id = %job.id, room = %room_name, room_sid = %sid,
                        participant_sid = %participant.sid(), user_track_sid = %publication.sid(),
                        reason = "obsolete_or_unbound_participant", "input subscription discarded");
                    continue;
                }
                info!(
                    job_id = %job.id,
                    room = %room_name,
                    room_sid = %sid,
                    participant_sid = %participant.sid(),
                    user_track_sid = %publication.sid(),
                    identity = %participant.identity(),
                    elapsed_ms = t0.elapsed().as_millis() as u64,
                    "user_track_subscribed"
                );
                if gates.on_user_track() {
                    participant_lifecycle.started(&participant.identity().to_string(), &participant.sid().to_string());
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
                let action = participant_lifecycle.disconnected(&p.identity().to_string(), &p.sid().to_string(), t0.elapsed().as_millis() as u64);
                info!(room=%room_name, identity=%p.identity(), participant_sid=%p.sid(), ?action, "participant disconnected");
                match action {
                    Departure::Ignore => {},
                    Departure::AwaitReplacement => {
                        discard_pending(&mut ctrl_rx);
                        discard_pending(&mut devres_rx);
                        discard_pending(&mut hist_rx);
                        gates = StartupGates::new();
                        let _ = out_tx.send(false);
                        mic_stream = None;
                        user_info = None;
                        drop(prebuilt_task.take());
                        info!(room=%room_name, "startup participant replacement grace armed");
                    },
                    Departure::Close => break,
                }
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
            let hrx = hist_rx.take().expect("pipeline 只启动一次");
            let beat2 = beat.clone();
            let ready = pipeline::ReadyCtx {
                business: business.clone(),
                trace_id: meta.trace_id.clone(),
                out_rx: out_rx.take().expect("pipeline 只启动一次"),
                t_assign: t0,
                t_user_track: t_user_track.unwrap_or_else(Instant::now),
                connect_ms,
                issue_to_assignment_ms: issue_ms,
            };
            let prebuild = prebuilt_task.take();
            let octx = ordered_ctx.clone();
            let shutdown=if graceful_search_close{pipeline_close_rx.take()}else{None};
            pipeline_task = Some(spawn_after_prebuild(prebuild, room_name.clone(), move |prebuilt| async move {
                pipeline::run_pipeline(mic, src, lp, rn, route, crx, drx, hrx, input_mode, octx, beat2, ready, prebuilt, filler_policy, shutdown).await
            }).await);
        }
    }

    // Both a still-running prebuild and a completed result own their ASR task.
    drop(prebuilt_task.take());
    if let Some(t) = pipeline_task.take() {
        close_pipeline(t,if graceful_search_close{pipeline_close_tx.take()}else{None}).await;
    }
    if let Some(intent) = close_intent.as_mut() {
        if intent.closing().is_err() {
            tracing::error!(room=%room_name, "room cleanup closing record failed");
        }
    }
    // 删房(对齐 Python delete_room_on_close=True):房间不删,空房存活 300s,
    // 用户重连会进"无 agent 的旧房"(dispatch 只在建房时发生)。删房=再连必新房必新 agent。
    if business.is_some() {
        let _=tokio::time::timeout(std::time::Duration::from_secs(2),room.close()).await;
        let cleanup=crate::room_verify::delete_exact(&config,&url,&room_name,sid).await;
        if matches!(cleanup,crate::room_verify::Outcome::Gone|crate::room_verify::Outcome::Superseded) {
            info!(room=%room_name,room_sid=%sid,?cleanup,"room cleanup verified");
        } else { warn!(room=%room_name,room_sid=%sid,?cleanup,"room cleanup unverified; reconciliation required"); }
    } else {
        let _ = close_room_and_delete(&room_name,
            async { room.close().await.map_err(Into::into) },
            delete_room(&config, &url, &room_name)).await;
    }
    // A 2xx is not the device's disconnect receipt. Keep the durable intent
    // until the independent reconciler verifies that this exact SID is gone.
    info!(job_id = %job.id, room = %room_name, room_sid = %sid,
        agent_track_sid = %agent_track_sid, uptime_s = t0.elapsed().as_secs(), "job closed");
    Ok(())
}

/// Keep prebuild ownership with its pipeline. Awaiting it in the room event
/// loop would prevent startup deadline checks and disconnect handling.
async fn spawn_after_prebuild<F, Fut>(
    prebuild: Option<OwnedTask<Result<pipeline::Prebuilt>>>, room: String, run: F,
) -> JoinHandle<Result<()>>
where F: FnOnce(Option<pipeline::Prebuilt>) -> Fut + Send + 'static,
      Fut: std::future::Future<Output=Result<()>> + Send + 'static {
    tokio::spawn(async move {
        let prebuilt = match prebuild {
            Some(h) => match h.await {
                Ok(Ok(p)) => Some(p),
                Ok(Err(e)) => { warn!(room=%room,error=%e,"pipeline prebuild failed; falling back to inline build"); None },
                Err(e) => { warn!(room=%room,error=%e,"pipeline prebuild join failed; falling back to inline build"); None },
            },
            None => None,
        };
        run(prebuilt).await
    })
}

async fn publish_output_track(room: &Room, source: &NativeAudioSource) -> Result<LocalTrackPublication> {
    let track = LocalAudioTrack::create_audio_track("agent-voice", RtcAudioSource::Native(source.clone()));
    Ok(room.local_participant().publish_track(LocalTrack::Audio(track), TrackPublishOptions {
        source: TrackSource::Microphone, ..Default::default()
    }).await?)
}

// Before the input gate opens, an ordered begin or cancel can already be
// queued. A new SID must never inherit those packets from the old connection.
fn discard_pending<T>(receiver: &mut Option<mpsc::Receiver<T>>) {
    if let Some(rx) = receiver { while rx.try_recv().is_ok() {} }
}

fn current_remote(room: &Room, participant: &RemoteParticipant) -> bool {
    room.remote_participants().get(&participant.identity())
        .is_some_and(|current| current.sid() == participant.sid())
}

/// Give an exiting candidate one bounded opportunity to freeze playback progress.
/// Ordinary jobs preserve their immediate-abort behavior.
async fn close_pipeline(mut task: JoinHandle<Result<()>>, shutdown: Option<tokio::sync::oneshot::Sender<()>>) {
    if let Some(tx) = shutdown {
        let _ = tx.send(());
        if tokio::time::timeout(std::time::Duration::from_millis(500), &mut task).await.is_ok() { return; }
    }
    task.abort();
    if tokio::time::timeout(std::time::Duration::from_millis(500), &mut task).await.is_err() {
        warn!("pipeline abort acknowledgement timed out; proceeding with room cleanup");
    }
}

// A stuck RTC close must not prevent DeleteRoom from disconnecting the device
// and allowing a new dispatch. The HTTP operation has its own bounded deadline.
async fn close_room_and_delete(
    room_name: &str,
    close: impl std::future::Future<Output = Result<()>>,
    delete: impl std::future::Future<Output = bool>,
) -> (bool, bool) {
    let closed = matches!(tokio::time::timeout(std::time::Duration::from_secs(3), close).await, Ok(Ok(())));
    if !closed { warn!(room = %room_name, "room close failed or timed out; still attempting DeleteRoom"); }
    (closed, delete.await)
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

async fn delete_room(config: &Config, ws_url: &str, room_name: &str) -> bool {
    if room_name.is_empty() {
        return false;
    }
    let http_url = ws_url
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1);
    let jwt = match server_api_jwt(&config.api_key, &config.api_secret, room_name) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = %e, "delete room: 签发 server token 失败");
            return false;
        }
    };
    let url = format!(
        "{}/twirp/livekit.RoomService/DeleteRoom",
        http_url.trim_end_matches('/')
    );
    // A candidate must not strand an otherwise healthy RTC client after one
    // transient control-plane failure. Reuse the client and bound the whole
    // attempt, including DNS; ordinary workers retain their single 5s attempt.
    let candidate = crate::search_canary::is_candidate(&config.agent_name);
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = CLIENT.get_or_init(|| reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build().expect("room cleanup HTTP client"));
    let attempts = if candidate { 3 } else { 1 };
    for attempt in 1..=attempts {
    let result = client
        .post(&url)
        .bearer_auth(&jwt)
        .json(&serde_json::json!({"room": room_name}))
        .timeout(std::time::Duration::from_secs(if candidate { 2 } else { 5 }))
        .send()
        .await;
    let retryable = match result {
        Ok(resp) if resp.status().is_success() => {
            info!(room = %room_name, attempt, "room deleted (delete_room_on_close)");
            return true;
        }
        Ok(resp) => {
            let status = resp.status();
            tracing::warn!(room = %room_name, attempt, status = %status, "delete room 非 2xx");
            status.is_server_error() || status.as_u16() == 429 || status.as_u16() == 408
        }
        Err(e) => {
            // Never log the request or error chain: either can contain secrets.
            tracing::warn!(room = %room_name, attempt, timeout = e.is_timeout(),
                connect = e.is_connect(), "delete room 请求失败");
            !e.is_builder()
        }
    };
    if !retryable || attempt == attempts { break; }
    tokio::time::sleep(std::time::Duration::from_millis(250 * attempt)).await;
    }
    tracing::error!(room = %room_name, "room cleanup incomplete; client disconnect not confirmed");
    false
}

#[cfg(test)]
mod tests {
    use super::issue_to_assignment_ms;

    // Real HTTP boundary: keep transport/status behavior in the production path.
    async fn cleanup_responses(statuses: &[u16], candidate: bool) -> (usize, bool) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let attempts = Arc::new(AtomicUsize::new(0));
        let observed = attempts.clone();
        let statuses = statuses.to_vec();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0; 2048];
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0 && request.len() + n <= 8192);
                    request.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&request);
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let len = head.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length: ").and_then(|v| v.parse::<usize>().ok())).unwrap();
                        if body.len() >= len { break; }
                    }
                }
                let request = String::from_utf8_lossy(&request);
                assert!(request.starts_with("POST /twirp/livekit.RoomService/DeleteRoom "));
                assert!(request.contains("\"room\":\"r16-test-room\""));
                let i = observed.fetch_add(1, Ordering::SeqCst);
                let status = statuses[i.min(statuses.len() - 1)];
                if status == 0 { continue; } // peer drops the connection
                let response = format!("HTTP/1.1 {status} Test\r\nContent-Length: 2\r\nConnection: close\r\nLocation: /unexpected\r\n\r\n{{}}");
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let cfg = crate::config::Config { ws_url: url.clone(), api_key: "test-key".into(),
            api_secret: "test-secret".into(), agent_name: if candidate {crate::search_canary::AGENT} else {"rust-worker"}.into(), max_jobs: 1 };
        let success = super::delete_room(&cfg, &url, "r16-test-room").await;
        server.abort();
        let end = server.await;
        assert!(end.is_err_and(|e| e.is_cancelled()));
        (attempts.load(Ordering::SeqCst), success)
    }
    #[tokio::test]
    async fn r16_delete_room_recovers_transient_http_failure() {
        assert_eq!(cleanup_responses(&[503, 503, 200], true).await, (3, true));
        assert_eq!(cleanup_responses(&[0, 200], true).await, (2, true));
    }
    #[tokio::test]
    async fn r16_delete_room_bounds_failure_and_never_retries_auth_or_redirect() {
        assert_eq!(cleanup_responses(&[503], true).await, (3, false));
        assert_eq!(cleanup_responses(&[401], true).await, (1, false));
        assert_eq!(cleanup_responses(&[403], true).await, (1, false));
        assert_eq!(cleanup_responses(&[302], true).await, (1, false));
    }
    #[tokio::test]
    async fn r16_ordinary_worker_keeps_single_attempt() {
        assert_eq!(cleanup_responses(&[503, 200], false).await, (1, false));
    }
    #[tokio::test]
    async fn r14_job_close_notifies_cleanup_and_still_bounds_a_stuck_pipeline(){
        let(tx,rx)=tokio::sync::oneshot::channel();let(done,proof)=tokio::sync::oneshot::channel();
        let task=tokio::spawn(async move{rx.await.unwrap();let _=done.send(());Ok(())});
        super::close_pipeline(task,Some(tx)).await;assert!(proof.await.is_ok());
        let(tx,_rx)=tokio::sync::oneshot::channel();let task=tokio::spawn(std::future::pending());let at=std::time::Instant::now();
        super::close_pipeline(task,Some(tx)).await;assert!(at.elapsed()<std::time::Duration::from_secs(1));
    }

    #[test]
    fn malformed_idle_policy_does_not_erase_other_trusted_metadata() {
        for policy in [serde_json::json!("invalid"),serde_json::json!({"timeout_ms":"bad"}),serde_json::json!(null)] {
            let raw=serde_json::json!({"trace_id":"synthetic-trace","voice_idle":policy,"oneshot_first_turn":"v1"}).to_string();
            let meta:super::JobMeta=serde_json::from_str(&raw).unwrap();
            assert_eq!(meta.trace_id.as_deref(),Some("synthetic-trace"));
            assert_eq!(meta.oneshot_first_turn.as_deref(),Some("v1"));
        }
    }
    #[tokio::test]
    async fn business_startup_prebuild_cannot_block_room_loop_or_escape_pipeline_abort() {
        let (held, dropped) = tokio::sync::oneshot::channel::<()>();
        let (signal, started) = tokio::sync::oneshot::channel();
        let prebuild = crate::owned_task::OwnedTask::new(tokio::spawn(async move {
            let _resource = held; let _=signal.send(());
            std::future::pending::<anyhow::Result<crate::pipeline::Prebuilt>>().await
        }));
        started.await.unwrap();
        let created = tokio::time::timeout(std::time::Duration::from_millis(200),
            super::spawn_after_prebuild(Some(prebuild), "synthetic-room".into(), |_| async { Ok(()) })).await;
        assert!(created.is_ok(), "a stuck prebuild must not block job watchdog/disconnect handling");
        super::close_pipeline(created.unwrap(), None).await;
        assert!(tokio::time::timeout(std::time::Duration::from_secs(1),dropped).await.unwrap().is_err(),
            "aborting the pipeline must cancel the owned prebuild and its resources");
    }

    #[tokio::test]
    async fn business_startup_failed_prebuild_preserves_single_inline_fallback() {
        let prebuild=crate::owned_task::OwnedTask::new(tokio::spawn(async { Err(anyhow::anyhow!("synthetic prebuild error")) }));
        let task=super::spawn_after_prebuild(Some(prebuild),"synthetic-room".into(),|built|async move {
            assert!(built.is_none());Ok(())
        }).await;
        assert!(task.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn job_lifecycle_pipeline_completion_wakes_without_room_events() {
        for outcome in ["normal", "error", "panic"] {
            let mut task = Some(tokio::spawn(async move {
                match outcome {
                    "normal" => Ok(()),
                    "error" => Err(anyhow::anyhow!("listening_session_paused_close_required")),
                    _ => panic!("synthetic pipeline panic"),
                }
            }));
            let mut watchdog = tokio::time::interval_at(
                tokio::time::Instant::now() + std::time::Duration::from_secs(60),
                std::time::Duration::from_secs(1),
            );
            let wake = tokio::time::timeout(std::time::Duration::from_millis(200),
                super::next_job_wake(std::future::pending::<Option<()>>(), &mut task, &mut watchdog)).await;
            assert!(wake.is_ok(), "{outcome}: completed pipeline must wake job cleanup");
            let super::JobWake::Pipeline(result) = wake.unwrap() else { panic!("wrong wake"); };
            match outcome {
                "normal" => assert!(result.unwrap().is_ok()),
                "error" => assert!(result.unwrap().is_err()),
                _ => assert!(result.unwrap_err().is_panic()),
            }
            assert!(task.is_none(), "joined task must not be polled a second time during cleanup");
        }
    }

    #[tokio::test]
    async fn job_lifecycle_abort_waits_for_owned_resources_to_drop() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        struct Owned(Arc<AtomicBool>);
        impl Drop for Owned { fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); } }
        let dropped = Arc::new(AtomicBool::new(false));
        let owned = Owned(dropped.clone());
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _owned = owned;
            let _ = started.send(());
            std::future::pending::<anyhow::Result<()>>().await
        });
        ready.await.unwrap();
        super::close_pipeline(task, None).await;
        assert!(dropped.load(Ordering::SeqCst), "room cleanup must not race a live aborted pipeline");
    }

    #[tokio::test]
    async fn job_lifecycle_stuck_room_close_still_attempts_delete() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        let deleted = Arc::new(AtomicBool::new(false));
        let proof = deleted.clone();
        let result = tokio::time::timeout(std::time::Duration::from_secs(4),
            super::close_room_and_delete("synthetic-room",
                std::future::pending::<anyhow::Result<()>>(),
                async move { proof.store(true, Ordering::SeqCst); true })).await;
        assert!(result.is_ok(), "stuck Room::close must not prevent bounded DeleteRoom");
        assert_eq!(result.unwrap(), (false, true));
        assert!(deleted.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn job_lifecycle_close_error_still_deletes_and_keeps_failure_visible() {
        let result = super::close_room_and_delete("synthetic-room",
            async { anyhow::bail!("synthetic RTC close failure") }, async { true }).await;
        assert_eq!(result, (false, true));
        let result = super::close_room_and_delete("synthetic-room",
            async { Ok(()) }, async { false }).await;
        assert_eq!(result, (true, false));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn job_lifecycle_uncooperative_abort_cannot_block_room_cleanup() {
        let (release, blocked) = std::sync::mpsc::channel();
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = started.send(());
            // Synthetic non-cooperative dependency, released by the test itself.
            let _ = blocked.recv_timeout(std::time::Duration::from_secs(2));
            Ok(())
        });
        ready.await.unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_millis(900),
            super::close_pipeline(task, None)).await;
        let _ = release.send(());
        assert!(result.is_ok(), "abort acknowledgement must be bounded before room cleanup");
    }

    #[tokio::test]
    async fn job_lifecycle_wait_preserves_room_events_and_watchdog() {
        use super::{JobWake, next_job_wake};
        let mut watchdog = tokio::time::interval_at(tokio::time::Instant::now()
            + std::time::Duration::from_secs(60), std::time::Duration::from_secs(1));
        let mut task = None;
        assert!(matches!(next_job_wake(async { Some(17) }, &mut task, &mut watchdog).await,
            JobWake::Room(Some(17))));
        task = Some(tokio::spawn(std::future::pending::<anyhow::Result<()>>()));
        assert!(matches!(next_job_wake(async { Some(18) }, &mut task, &mut watchdog).await,
            JobWake::Room(Some(18))));
        assert!(task.is_some());
        // Tokio timers round to milliseconds; a newly created "now" interval
        // need not be ready on its first poll. Use an unambiguously elapsed tick.
        let mut due = tokio::time::interval_at(tokio::time::Instant::now()
            - std::time::Duration::from_secs(1), std::time::Duration::from_secs(1));
        assert!(matches!(next_job_wake(async { Some(19) }, &mut task, &mut due).await,
            JobWake::Watchdog), "queued room traffic must not starve the canary/heartbeat watchdog");
        super::close_pipeline(task.take().unwrap(), None).await;
    }

    #[tokio::test]
    async fn job_lifecycle_completion_precedes_queued_packets_and_watchdog() {
        for cancel in [false, true] {
            let handle = if cancel {
                let t = tokio::spawn(std::future::pending::<anyhow::Result<()>>());
                t.abort(); t
            } else { tokio::spawn(async { Ok(()) }) };
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                while !handle.is_finished() { tokio::task::yield_now().await; }
            }).await.unwrap();
            let mut task = Some(handle);
            let mut due = tokio::time::interval_at(tokio::time::Instant::now()
                - std::time::Duration::from_secs(1), std::time::Duration::from_secs(1));
            let wake = super::next_job_wake(async { Some(19) }, &mut task, &mut due).await;
            let super::JobWake::Pipeline(result) = wake else { panic!("completed job consumed another packet"); };
            if cancel { assert!(result.unwrap_err().is_cancelled()); }
            else { assert!(result.unwrap().is_ok()); }
            assert!(task.is_none());
        }
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    /// READY_LATENCY 口径:毫秒 issue_ts 优先(消 ±1s 量化噪声);缺省回退房名尾秒;异常值不出数。
    #[test]
    fn issue_clock_precedence_and_fallback() {
        let t = now_ms();
        // 毫秒口径优先:350ms 前签发 → 观测 ≈350(容忍执行耗时)
        let d = issue_to_assignment_ms("sn-X-0", Some(t - 350)).expect("ms 口径出数");
        assert!((350..600).contains(&d), "d={d}");
        // 毫秒值异常(未来时刻)→ 回退房名秒
        let sec = t / 1000 - 2;
        let d2 = issue_to_assignment_ms(&format!("sn-X-{sec}"), Some(t + 99_000)).expect("回退秒口径");
        assert!((2000..3600).contains(&d2), "d2={d2}");
        // 两口径全无效 → None(web 房自定义名)
        assert_eq!(issue_to_assignment_ms("web-room", None), None);
        assert_eq!(issue_to_assignment_ms("web-room", Some(t - 700_000)), None);
    }
}

#[cfg(test)]
mod style_ark_metadata_tests {
    use super::*;
    #[test]
    fn style_ark_invalid_policy_keeps_other_metadata() {
        let meta: JobMeta = serde_json::from_str(r#"{"trace_id":"trace-test","input_mode":"ordered_pcm","filler_policy":"bad"}"#).unwrap();
        assert_eq!(meta.trace_id.as_deref(),Some("trace-test"));
        assert_eq!(meta.input_mode.as_deref(),Some("ordered_pcm"));
        assert!(crate::filler::FillerPolicy::from_metadata(meta.filler_policy.as_ref(),"sn-BJP00326070803800006-123").is_none());
    }
}

#[cfg(test)]
mod startup_queue_tests {
    use super::*;
    #[tokio::test]
    async fn replacement_discards_old_begin_and_cancel_without_closing_channel() {
        let (tx, rx)=mpsc::channel(8);let mut rx=Some(rx);
        tx.send("old-ordered-begin").await.unwrap();tx.send("old-cancel").await.unwrap();
        discard_pending(&mut rx);
        tx.send("new-ordered-begin").await.unwrap();
        assert_eq!(rx.as_mut().unwrap().recv().await,Some("new-ordered-begin"));
        assert!(rx.as_mut().unwrap().try_recv().is_err());
    }
}
