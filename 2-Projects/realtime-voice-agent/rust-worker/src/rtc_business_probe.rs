//! Explicit opt-in integration probe. Direct job invocation never registers a
//! Worker or accepts production dispatch. No device/Brain/analytics writes.
use anyhow::{ensure, Context, Result};
use livekit::{prelude::*, options::TrackPublishOptions};
use livekit::webrtc::{audio_source::native::NativeAudioSource, prelude::*};
use serde_json::{json, Value};
use std::{borrow::Cow, time::{Duration, Instant}};

const SN: &str = "BJP00326110799999901";

fn join_token(cfg: &crate::config::Config, room: &str, identity: &str) -> Result<String> {
    let now=crate::search_canary::now_ms()/1000;
    Ok(jsonwebtoken::encode(&jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &json!({"iss":cfg.api_key,"sub":identity,"iat":now,"nbf":now,"exp":now+300,
            "video":{"roomJoin":true,"room":room,"canPublish":true,"canSubscribe":true,"canPublishData":true}}),
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
    let result:Result<Value>=async {
        let (room,mut events)=Room::connect(&cfg.ws_url,&join_token(&cfg,&name,&format!("dev-{SN}"))?,RoomOptions::default()).await?;
        client=Some(room);
        let room=client.as_ref().unwrap();
        let source=NativeAudioSource::new(AudioSourceOptions::default(),16_000,1,100);
        let track=LocalAudioTrack::create_audio_track("probe-silence",RtcAudioSource::Native(source.clone()));
        room.local_participant().publish_track(LocalTrack::Audio(track),TrackPublishOptions{source:TrackSource::Microphone,..Default::default()}).await?;
        sender=Some(tokio::spawn(async move {
            for _ in 0..4500 {
                source.capture_frame(&AudioFrame{data:Cow::Owned(vec![0;160]),sample_rate:16_000,num_channels:1,samples_per_channel:160}).await?;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok::<(),anyhow::Error>(())
        }));
        let trace=uuid::Uuid::new_v4().to_string();
        let mut meta=json!({"trace_id":trace,"session_id":trace,"issue_ts_ms":crate::search_canary::now_ms(),
            "voice_idle":{"timeout_ms":5000,"revision":"cfg-900001"}});
        if ordered {meta["input_mode"]=json!("ordered_pcm");meta["oneshot_first_turn"]=json!("v1");}
        let job=livekit_protocol::Job{id:format!("probe-{}",uuid::Uuid::new_v4()),
            room:Some(livekit_protocol::Room{name:name.clone(),sid:sid.clone(),..Default::default()}),
            metadata:meta.to_string(),..Default::default()};
        let started=Instant::now();
        worker=Some(tokio::spawn(crate::job::run_job(cfg.clone(),job,cfg.ws_url.clone(),join_token(&cfg,&name,"business-probe-agent")?)));
        let mut ready=None;
        let mut phase=None;
        let mut events_seen=Vec::new();
        loop {
            ensure!(started.elapsed()<Duration::from_secs(75),"probe exceeded total budget");
            tokio::select! {
                event=events.recv()=>{
                    match event {
                        Some(RoomEvent::DataReceived{payload,..})=>{
                            if let Ok(v)=serde_json::from_slice::<Value>(&payload) {
                                if v["trace_id"]==trace {
                                    let kind=v["type"].as_str().unwrap_or("").to_owned();
                                    if kind=="session.input_ready" && ready.is_none(){ready=Some(Instant::now());}
                                    if kind=="session.input_phase" && v["payload"]["reason"]=="begin_timeout" {phase=Some(Instant::now());}
                                    events_seen.push(kind);
                                }
                            }
                        },
                        Some(_)=>{},
                        None=>break,
                    }
                },
                _=tokio::time::sleep(Duration::from_millis(50))=>{},
            }
            if worker.as_ref().unwrap().is_finished(){break;}
            if mode=="observe" && ready.is_some_and(|at|at.elapsed()>=Duration::from_secs(9)){break;}
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
        Ok(json!({"mode":mode,"ordered":ordered,"room":name,"sid":sid,"ready_ms":ready.duration_since(started).as_millis(),
            "elapsed_ms":started.elapsed().as_millis(),"phase_ms":phase.map(|p|p.duration_since(started).as_millis()),
            "worker_alive_before_cleanup":alive,"events":events_seen}))
    }.await;
    if let Some(handle)=sender {handle.abort();let _=handle.await;}
    if let Some(room)=client {let _=room.close().await;}
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
