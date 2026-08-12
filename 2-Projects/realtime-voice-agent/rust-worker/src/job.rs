//! job:进房 + 音轨装配,双向就绪后把音频流交给 cascade pipeline。
//!
//! 启动时序(P2 实测教训):greeting/回复要等**本地轨被订阅**(LocalTrackSubscribed,
//! 用户听得到)且**用户轨已订到**(TrackSubscribed,我们听得到)两个条件齐备,
//! 缺一开播都会丢头。生命周期:participant 断开 → 关 pipeline → 关房(与 Python 版
//! close_on_disconnect+delete_room_on_close 语义对齐,删房由 dispatch 配置负责)。

use anyhow::{Context, Result};
use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::prelude::*;
use livekit_protocol as proto;
use std::time::Instant;
use tokio::task::JoinHandle;
use tracing::info;

use crate::config::Config;
use crate::pipeline;
use crate::token::server_api_jwt;
use crate::tts_volc::TTS_SAMPLE_RATE;

pub async fn run_job(config: Config, job: proto::Job, url: String, token: String) -> Result<()> {
    let room_name = job.room.as_ref().map(|r| r.name.clone()).unwrap_or_default();
    let t0 = Instant::now();
    info!(job_id = %job.id, room = %room_name, "connecting to room");

    let (room, mut events) = Room::connect(&url, &token, RoomOptions::default())
        .await
        .context("room connect")?;
    info!(
        room = %room_name,
        connect_ms = t0.elapsed().as_millis() as u64,
        "job connected to room"
    );

    // agent 出声轨:24k mono(TTS 原生采样率直喂,RTC 内部重采样)。
    // 队列 200ms 对齐 Python room_io(queue_size_ms=200):pause 时排队尾音 ≤200ms
    // 自然放完(框架不 clear),硬打断才 clear_buffer。
    let source = NativeAudioSource::new(
        AudioSourceOptions::default(),
        TTS_SAMPLE_RATE,
        1,
        200,
    );
    let track = LocalAudioTrack::create_audio_track(
        "agent-voice",
        RtcAudioSource::Native(source.clone()),
    );
    room.local_participant()
        .publish_track(
            LocalTrack::Audio(track),
            TrackPublishOptions { source: TrackSource::Microphone, ..Default::default() },
        )
        .await
        .context("publish audio track")?;
    info!(room = %room_name, "agent audio track published");

    let mut local_subscribed = false;
    let mut mic_stream: Option<NativeAudioStream> = None;
    let mut pipeline_task: Option<JoinHandle<()>> = None;

    while let Some(ev) = events.recv().await {
        match ev {
            RoomEvent::ParticipantConnected(p) => {
                info!(room = %room_name, identity = %p.identity(), "participant connected");
            }
            RoomEvent::LocalTrackSubscribed { .. } => {
                info!(room = %room_name, "local track subscribed by remote");
                local_subscribed = true;
            }
            RoomEvent::TrackSubscribed { track: RemoteTrack::Audio(audio), participant, .. } => {
                info!(
                    room = %room_name,
                    identity = %participant.identity(),
                    "user audio track subscribed"
                );
                // 16k 拉流:pipeline 的 VAD/STT 全按 16k 契约
                mic_stream = Some(NativeAudioStream::new(audio.rtc_track(), 16_000, 1));
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
        // 双向就绪且未启动 → 起 cascade
        if pipeline_task.is_none()
            && local_subscribed
            && let Some(mic) = mic_stream.take()
        {
            info!(room = %room_name, "both directions ready, starting cascade pipeline");
            let src = source.clone();
            let rn = room_name.clone();
            let lp = room.local_participant();
            pipeline_task = Some(tokio::spawn(async move {
                if let Err(e) = pipeline::run_pipeline(mic, src, lp, rn.clone()).await {
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

async fn delete_room(config: &Config, ws_url: &str, room_name: &str) {
    if room_name.is_empty() {
        return;
    }
    let http_url = ws_url.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1);
    let jwt = match server_api_jwt(&config.api_key, &config.api_secret, room_name) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = %e, "delete room: 签发 server token 失败");
            return;
        }
    };
    let url = format!("{}/twirp/livekit.RoomService/DeleteRoom", http_url.trim_end_matches('/'));
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
