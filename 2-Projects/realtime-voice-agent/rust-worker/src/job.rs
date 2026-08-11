//! P2 骨架 job:进房 + 音频双向收发。
//!
//! 行为(对齐 Python 版生命周期语义,P2 简化):
//! - assignment token 进房 → publish 16k mono 音轨
//! - participant 到达后播 greeting wav(GREETING_WAV;未配则跳过)
//! - subscribe 用户音轨,统计帧数/秒数(上行链路证明)
//! - participant 断开 → 关房退出(delete_room_on_close 语义由 server 侧 dispatch 配置负责)

use anyhow::{Context, Result};
use futures_util::StreamExt;
use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::prelude::*;
use livekit_protocol as proto;
use std::time::Instant;
use tracing::{info, warn};

use crate::config::Config;

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

    // publish 16k mono 音轨(与 Python 版 audio_sample_rate=16000 对齐)
    let source = NativeAudioSource::new(AudioSourceOptions::default(), 16_000, 1, 1_000);
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

    // greeting 触发点=本地音轨被远端**订阅完成**(LocalTrackSubscribed),不是 participant
    // 到达——对已在房的 participant 立即开播会赶在订阅协商完成前,音频头部整段丢失
    // (E2E 实测只录到尾 0.5s;Python 版 B8"用户没进房就 greeting 漏说"同款模式)。
    let mut greeted = false;

    while let Some(ev) = events.recv().await {
        match ev {
            RoomEvent::ParticipantConnected(p) => {
                info!(room = %room_name, identity = %p.identity(), "participant connected");
            }
            RoomEvent::LocalTrackSubscribed { .. } => {
                info!(room = %room_name, "local track subscribed by remote");
                if !greeted {
                    greeted = true;
                    spawn_greeting(&config, &source, &room_name);
                }
            }
            RoomEvent::TrackSubscribed { track: RemoteTrack::Audio(audio), participant, .. } => {
                info!(
                    room = %room_name,
                    identity = %participant.identity(),
                    "user audio track subscribed"
                );
                let rn = room_name.clone();
                let rtc_track = audio.rtc_track();
                tokio::spawn(async move {
                    let mut stream = NativeAudioStream::new(rtc_track, 16_000, 1);
                    let mut frames: u64 = 0;
                    let mut samples: u64 = 0;
                    while let Some(frame) = stream.next().await {
                        frames += 1;
                        samples += u64::from(frame.samples_per_channel);
                        if frames % 200 == 1 {
                            info!(
                                room = %rn,
                                frames,
                                secs = format!("{:.1}", samples as f64 / 16_000.0),
                                "user audio flowing"
                            );
                        }
                    }
                    info!(
                        room = %rn,
                        frames,
                        secs = format!("{:.1}", samples as f64 / 16_000.0),
                        "user audio stream ended"
                    );
                });
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
    }

    room.close().await.ok();
    info!(room = %room_name, uptime_s = t0.elapsed().as_secs(), "job closed");
    Ok(())
}

fn spawn_greeting(config: &Config, source: &NativeAudioSource, room_name: &str) {
    let Some(path) = config.greeting_wav.clone() else {
        info!(room = %room_name, "no GREETING_WAV configured, skip greeting");
        return;
    };
    let src = source.clone();
    let rn = room_name.to_string();
    tokio::spawn(async move {
        match play_wav(&src, &path).await {
            Ok(secs) => info!(room = %rn, wav = %path, secs = format!("{secs:.1}"), "greeting playback done"),
            Err(e) => warn!(room = %rn, wav = %path, error = %e, "greeting playback failed"),
        }
    });
}

/// 16k mono i16 wav → 10ms 帧逐帧 capture(NativeAudioSource 内部 1s 队列背压)。
async fn play_wav(source: &NativeAudioSource, path: &str) -> Result<f64> {
    let mut reader = hound::WavReader::open(path).context("open wav")?;
    let spec = reader.spec();
    anyhow::ensure!(
        spec.channels == 1 && spec.bits_per_sample == 16 && spec.sample_rate == 16_000,
        "greeting wav 需 16k/16bit/mono 与音源采样率一致(实际 rate={} channels={} bits={})",
        spec.sample_rate,
        spec.channels,
        spec.bits_per_sample
    );
    let samples: Vec<i16> = reader.samples::<i16>().collect::<Result<_, _>>()?;
    let frame_len = (spec.sample_rate / 100) as usize; // 10ms
    for chunk in samples.chunks(frame_len) {
        let frame = AudioFrame {
            data: chunk.into(),
            sample_rate: spec.sample_rate,
            num_channels: 1,
            samples_per_channel: chunk.len() as u32,
        };
        source
            .capture_frame(&frame)
            .await
            .map_err(|e| anyhow::anyhow!("capture_frame: {e}"))?;
    }
    Ok(samples.len() as f64 / f64::from(spec.sample_rate))
}
