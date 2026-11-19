//! Explicit opt-in integration probe. Direct job invocation never registers a
//! Worker or accepts production dispatch. No device/Brain/analytics writes.
use anyhow::{ensure, Context, Result};
use livekit::{prelude::*, options::TrackPublishOptions};
use livekit::webrtc::{audio_source::native::NativeAudioSource, prelude::*};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use futures_util::StreamExt;
use sha2::Digest;
use serde_json::{json, Value};
use std::{borrow::Cow, time::{Duration, Instant}};

const SN: &str = "BJP00326110799999901";

fn join_token(cfg: &crate::config::Config, room: &str, identity: &str) -> Result<String> {
    let now=crate::search_canary::now_ms()/1000;
    Ok(jsonwebtoken::encode(&jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &json!({"iss":cfg.api_key,"sub":identity,"iat":now,"nbf":now,"exp":now+300,
            // SFU forwards legacy transcription only from Agent participants.
            // This is a room-join grant, not Worker registration or dispatch.
            "video":{"agent":identity=="business-probe-agent","roomJoin":true,"room":room,"canPublish":true,"canSubscribe":true,"canPublishData":true}}),
        &jsonwebtoken::EncodingKey::from_secret(cfg.api_secret.as_bytes()))?)
}

async fn api(cfg:&crate::config::Config, method:&str, body:Value, room:&str)->Result<Value> {
    let base=cfg.ws_url.replacen("wss://","https://",1);
    ensure!(base.starts_with("https://"),"probe requires TLS");
    let token=if method=="ListRooms" {crate::token::room_list_jwt(&cfg.api_key,&cfg.api_secret)?}
        else {crate::token::server_api_jwt(&cfg.api_key,&cfg.api_secret,room)?};
    let response=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build()?
        .post(format!("{}/twirp/livekit.RoomService/{method}",base.trim_end_matches('/')))
        .bearer_auth(token).json(&body).timeout(Duration::from_secs(8)).send().await
        .map_err(|_|anyhow::anyhow!("probe API transport failed"))?;
    ensure!(response.status().is_success(),"probe API status {}",response.status());
    response.json().await.map_err(|_|anyhow::anyhow!("probe API invalid JSON"))
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore = "real RTC/providers: explicit synthetic-only isolated process required"]
async fn actual_job_silence_and_first_turn_handoff() -> Result<()> {
    ensure!(std::env::var("P003_RTC_BUSINESS_PROBE").as_deref()==Ok("synthetic-only"),"explicit probe gate missing");
    ensure!(std::env::var("P003_BUSINESS_WATCHDOG_DEVICE_ALLOWLIST").as_deref()==Ok(SN),"synthetic-only allowlist required");
    let mode=std::env::var("P003_BUSINESS_WATCHDOG_MODE")?;
    ensure!(mode=="observe"||mode=="enforce","explicit probe mode required");
    let ordered=std::env::var("P003_RTC_PROBE_ORDERED").as_deref()==Ok("1");
    let speech=std::env::var("P003_RTC_PROBE_SPEECH").as_deref()==Ok("normal-short");
    // Reuse the prior A/B synthetic corpus, never a user's recorded audio.
    let pcm=if speech {
        let path="/root/p003-voice-ab-20261106/normal-short.wav";
        ensure!(format!("{:x}",sha2::Sha256::digest(std::fs::read(path)?))=="9ea46b2c12e570ab71a4b10283c733331d2048331b0b876df47b9a78b10f0b03","fixture hash mismatch");
        let mut wav=hound::WavReader::open(path)?;
        ensure!(wav.spec().sample_rate==16000 && wav.spec().channels==1 && wav.spec().bits_per_sample==16,"fixture format mismatch");
        wav.samples::<i16>().collect::<std::result::Result<Vec<_>,_>>()?
    } else {Vec::new()};
    let cfg=crate::config::Config::from_env()?;
    ensure!(cfg.agent_name=="rust-worker","main implementation only");
    let _=rustls::crypto::ring::default_provider().install_default();
    let _=tracing_subscriber::fmt().with_env_filter("info").with_target(false).try_init();
    crate::vad::preload(&crate::pipeline::PipelineConfig::vad_model_path_from_env())?;
    let name=format!("sn-{SN}-{}",crate::search_canary::now_ms());
    let existing=api(&cfg,"ListRooms",json!({"names":[name]}),&name).await?;
    ensure!(existing["rooms"].as_array().is_some_and(Vec::is_empty),"probe name already exists");
    let created=api(&cfg,"CreateRoom",json!({"name":name,"emptyTimeout":15,"departureTimeout":2,"maxParticipants":2,"agents":[]}),&name).await?;
    let sid=created["sid"].as_str().context("created SID missing")?.to_owned();
    let mut worker=None;
    let mut worker_joined=false;
    let mut sender=None;
    let mut client=None;
    let mut receiver=None;
    let audio_stats=std::sync::Arc::new(std::sync::Mutex::new((0u64,None::<Instant>,None::<Instant>)));
    let result:Result<Value>=async {
        let (room,mut events)=Room::connect(&cfg.ws_url,&join_token(&cfg,&name,&format!("dev-{SN}"))?,RoomOptions::default()).await?;
        client=Some(room);
        let room=client.as_ref().unwrap();
        let source=NativeAudioSource::new(AudioSourceOptions::default(),16_000,1,100);
        let track=LocalAudioTrack::create_audio_track("probe-silence",RtcAudioSource::Native(source.clone()));
        room.local_participant().publish_track(LocalTrack::Audio(track),TrackPublishOptions{source:TrackSource::Microphone,..Default::default()}).await?;
        let (speak_tx,speak_rx)=tokio::sync::watch::channel(false);
        sender=Some(tokio::spawn(async move {
            let mut offset=0;
            for _ in 0..4500 {
                let mut frame=vec![0;160];
                if *speak_rx.borrow() && offset<pcm.len() {
                    let n=(pcm.len()-offset).min(160);frame[..n].copy_from_slice(&pcm[offset..offset+n]);offset+=n;
                }
                source.capture_frame(&AudioFrame{data:Cow::Owned(frame),sample_rate:16_000,num_channels:1,samples_per_channel:160}).await?;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok::<(),anyhow::Error>(())
        }));
        let trace=uuid::Uuid::new_v4().to_string();
        let mut meta=json!({"trace_id":trace,"session_id":trace,"issue_ts_ms":crate::search_canary::now_ms(),
            "voice_idle":{"timeout_ms":5000,"revision":"cfg-900001"}});
        if speech {meta["filler_policy"]=json!({"version":1,"style":"chatty","probability":0.0});}
        if ordered {meta["input_mode"]=json!("ordered_pcm");meta["oneshot_first_turn"]=json!("v1");}
        let job=livekit_protocol::Job{id:format!("probe-{}",uuid::Uuid::new_v4()),
            room:Some(livekit_protocol::Room{name:name.clone(),sid:sid.clone(),..Default::default()}),
            metadata:meta.to_string(),..Default::default()};
        let started=Instant::now();
        worker=Some(tokio::spawn(crate::job::run_job(cfg.clone(),job,cfg.ws_url.clone(),join_token(&cfg,&name,"business-probe-agent")?)));
        let mut ready=None;
        let mut phase=None;
        let mut events_seen=Vec::new();
        let mut answers=Vec::new();
        let mut metric_kinds=Vec::new();
        let mut user_finals=0;
        let mut input_sent=None;
        loop {
            ensure!(started.elapsed()<Duration::from_secs(75),"probe exceeded total budget");
            tokio::select! {
                event=events.recv()=>{
                    match event {
                        Some(RoomEvent::DataReceived{payload,topic,..})=>{
                            if let Ok(v)=serde_json::from_slice::<Value>(&payload) {
                                if topic.as_deref()==Some("metrics") {
                                    if let Some(kind)=v["k"].as_str(){metric_kinds.push(kind.to_owned());}
                                }
                                if v["trace_id"]==trace {
                                    let kind=v["type"].as_str().unwrap_or("").to_owned();
                                    if kind=="session.input_ready" && ready.is_none(){
                                        ready=Some(Instant::now());
                                        if speech && !ordered {speak_tx.send(true)?;input_sent=Some(Instant::now());}
                                    }
                                    if kind=="session.input_phase" && v["payload"]["reason"]=="begin_timeout" {
                                        phase=Some(Instant::now());
                                        if speech {speak_tx.send(true)?;input_sent=Some(Instant::now());}
                                    }
                                    events_seen.push(kind);
                                }
                            }
                        },
                        Some(RoomEvent::TrackSubscribed{track:RemoteTrack::Audio(audio),participant,..})=>{
                            if participant.identity().as_str()=="business-probe-agent" && receiver.is_none() {
                                let mut stream=NativeAudioStream::new(audio.rtc_track(),24_000,1);
                                let stats=audio_stats.clone();
                                receiver=Some(tokio::spawn(async move {
                                    while let Some(frame)=stream.next().await {
                                        let sum:u64=frame.data.iter().map(|v|u64::from(v.unsigned_abs())).sum();
                                        if !frame.data.is_empty() && sum/frame.data.len() as u64>200 {
                                            let mut s=stats.lock().unwrap();s.0+=frame.data.len() as u64;
                                            s.1.get_or_insert(Instant::now());s.2=Some(Instant::now());
                                        }
                                    }
                                }));
                            }
                        },
                        Some(RoomEvent::TranscriptionReceived{participant,segments,..})=>{
                            let agent=participant.is_some_and(|p|p.identity().as_str()=="business-probe-agent");
                            for segment in segments {if segment.r#final && !segment.text.is_empty() {
                                if agent {answers.push(segment.text);}else{user_finals+=1;}
                            }}
                        },
                        Some(_)=>{},
                        None=>break,
                    }
                },
                _=tokio::time::sleep(Duration::from_millis(50))=>{},
            }
            if worker.as_ref().unwrap().is_finished(){break;}
            if mode=="observe" && ready.is_some_and(|at|at.elapsed()>=Duration::from_secs(9)) {
                let stats=*audio_stats.lock().unwrap();
                if !speech || (stats.0>=12_000 && stats.2.is_some_and(|at|at.elapsed()>=Duration::from_secs(5)) && !answers.is_empty()) {break;}
            }
        }
        let ready=ready.context("no actual input_ready received")?;
        let alive=!worker.as_ref().unwrap().is_finished();
        if mode=="observe" {ensure!(alive,"observe unexpectedly closed job");ensure!(ready.elapsed()>=Duration::from_secs(9),"observe too short");}
        else {
            tokio::time::timeout(Duration::from_secs(12),worker.as_mut().unwrap()).await.context("job did not finish cleanup")???;
            worker_joined=true;
            ensure!(ready.elapsed()>=Duration::from_secs(4),"closed before signed idle interval");
            // Foreground API has a short budget. Keep the client connected
            // while the independent 10s timer retries a persisted failure;
            // do not delete the room from the fixture before observing it.
            let until=Instant::now()+Duration::from_secs(35);
            loop {
                let gone=api(&cfg,"ListRooms",json!({"names":[name]}),&name).await
                    .is_ok_and(|v|v["rooms"].as_array().is_some_and(Vec::is_empty));
                if gone {break;}
                ensure!(Instant::now()<until,"original room remained after reconciliation budget");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
        if ordered {ensure!(phase.is_some(),"begin_timeout did not transition to RTC");}
        let stats=*audio_stats.lock().unwrap();
        if speech {
            println!("PROBE_OBSERVATION {}",json!({"user_finals":user_finals,"answers":answers,"audible_ms":stats.0/24,
                "first_audio_ms":stats.1.map(|p|p.duration_since(started).as_millis())}));
            ensure!(user_finals>0 && !answers.is_empty() && stats.0>=12_000,"normal question missing evidence: user_finals={} answers={} audible_ms={}",user_finals,answers.len(),stats.0/24);
            ensure!(!metric_kinds.is_empty(),"no actual metrics topic packets");
        }
        Ok(json!({"mode":mode,"ordered":ordered,"speech":speech,"room":name,"sid":sid,"ready_ms":ready.duration_since(started).as_millis(),
            "input_sent_ms":input_sent.map(|p|p.duration_since(started).as_millis()),"audible_ms":stats.0/24,
            "first_audio_ms":stats.1.map(|p|p.duration_since(started).as_millis()),"user_finals":user_finals,"answers":answers,
            "elapsed_ms":started.elapsed().as_millis(),"phase_ms":phase.map(|p|p.duration_since(started).as_millis()),
            "worker_alive_before_cleanup":alive,"events":events_seen,"metric_kinds":metric_kinds}))
    }.await;
    if let Some(handle)=sender {handle.abort();let _=handle.await;}
    if let Some(room)=client {let _=room.close().await;}
    if let Some(handle)=receiver {handle.abort();let _=handle.await;}
    if let Some(mut handle)=worker {
        if !worker_joined && tokio::time::timeout(Duration::from_secs(12),&mut handle).await.is_err() {
            handle.abort();let _=handle.await;
        }
    }
    let cleanup=crate::room_verify::delete_exact(&cfg,&cfg.ws_url,&name,&sid).await;
    ensure!(matches!(cleanup,crate::room_verify::Outcome::Gone),"probe cleanup not verified: {cleanup:?}");
    println!("PROBE_RESULT {}",result?);
    Ok(())
}
