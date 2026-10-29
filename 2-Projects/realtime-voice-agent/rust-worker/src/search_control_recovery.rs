//! Search-only recovery of a voiced utterance with no primary ASR text.
//! No additional wait or provider work is added to an ordinary chat turn.
use std::future::Future;
use tokio::{sync::oneshot,task::JoinHandle};

#[derive(Default)]
pub struct Recovery {
    onset:Option<u64>, attempts:u8, last_attempt:Option<u64>,
    task:Option<JoinHandle<()>>, result:Option<oneshot::Receiver<Option<String>>>,
    recovered:Option<String>, delivered:Option<String>,
}
impl Recovery {
    pub fn speech_start(&mut self,now:u64,active_search:bool){self.cancel();self.recovered=None;self.delivered=None;self.onset=active_search.then_some(now);}
    pub fn primary_text(&mut self,text:&str)->bool {
        self.cancel();self.onset=None;
        self.recovered.as_deref()!=Some(text) && self.delivered.as_deref()!=Some(text)
    }
    pub fn speech_end(&mut self,now:u64)->Option<u64>{
        let duration=now.saturating_sub(self.onset.take()?);
        if !(700..=6000).contains(&duration) || self.attempts>=3
            || self.last_attempt.is_some_and(|t|now.saturating_sub(t)<5000){return None;}
        self.attempts+=1;self.last_attempt=Some(now);Some(duration+300)
    }
    pub fn start(&mut self,future:impl Future<Output=Option<String>>+Send+'static){
        self.cancel();let(tx,rx)=oneshot::channel();self.result=Some(rx);
        self.task=Some(tokio::spawn(async move{let _=tx.send(future.await);}));
    }
    pub fn blocked(&self)->bool{self.result.is_some()}
    pub fn reject_result(&mut self){self.recovered=None;self.delivered=None;}
    pub fn delivered_as(&mut self,text:&str){self.delivered=Some(text.to_owned());}
    pub fn poll(&mut self)->Option<String>{
        let r=self.result.as_mut()?.try_recv();
        match r {
            Ok(text)=>{self.result=None;self.task=None;self.recovered=text.clone();text},
            Err(oneshot::error::TryRecvError::Closed)=>{self.cancel();None},
            Err(oneshot::error::TryRecvError::Empty)=>None,
        }
    }
    pub fn cancel(&mut self){if let Some(t)=self.task.take(){t.abort();}self.result=None;self.onset=None;}
}
impl Drop for Recovery {fn drop(&mut self){self.cancel();}}

/// Retry only against the already configured speech provider. It runs outside
/// the audio loop, has a hard budget, and never promotes an interim transcript.
pub async fn recognize(mut cfg:crate::stt_volc::SttConfig,pcm:Vec<i16>)->Option<String>{
    use crate::stt_volc::{self,SttEvent};
    use std::time::Duration;
    use tracing::Instrument;
    if pcm.is_empty()||pcm.len()>7*16000{return None;}
    cfg.nonstream=true;cfg.url=stt_volc::ASYNC_ASR_URL.into();cfg.enable_ddc=false;
    // Let an ordinary trailing final win before opening another connection.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let work=async move {
        let(tx,mut rx)=tokio::sync::mpsc::channel(40);
        let(events,mut ev)=tokio::sync::mpsc::channel(32);
        let feed=async move{for c in pcm.chunks(3200){if tx.send(c.to_vec()).await.is_err(){break;}}};
        let collect=async move{
            let mut text=String::new();
            while let Some(event)=ev.recv().await{if let SttEvent::Final(t)=event{text.push_str(&t);if text.chars().count()>128{return None;}}}
            (!text.is_empty()).then_some(text)
        };
        let (status,(),text)=tokio::join!(stt_volc::run_asr_stream(cfg,&mut rx,events),feed,collect);
        if matches!(status,Ok(stt_volc::AsrEnd::InputDone)){text}else{None}
    };
    tokio::time::timeout(Duration::from_millis(2500),work.instrument(tracing::info_span!("search_control_retry"))).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn r25_only_voiced_search_without_transcript_retries_with_a_bound(){
        let mut r=Recovery::default();r.speech_start(0,false);assert_eq!(r.speech_end(2000),None);
        r.speech_start(3000,true);assert!(r.primary_text("改查成都今天的天气"));assert_eq!(r.speech_end(5000),None);
        r.speech_start(6000,true);assert_eq!(r.speech_end(6200),None);
        r.speech_start(7000,true);assert_eq!(r.speech_end(9000),Some(2300));
        r.speech_start(10000,true);assert_eq!(r.speech_end(12000),None);
        for (start,end)in [(15000,17000),(23000,25000)]{r.speech_start(start,true);assert!(r.speech_end(end).is_some());}
        r.speech_start(31000,true);assert_eq!(r.speech_end(33000),None);
    }
    #[tokio::test]
    async fn r25_primary_or_new_speech_cancels_recovery_and_late_control_cannot_publish(){
        let mut r=Recovery::default();let(tx,rx)=oneshot::channel();r.start(async{rx.await.ok()});assert!(r.blocked());
        r.primary_text("我画了一只猫");assert!(!r.blocked());let _=tx.send("改查成都".into());tokio::task::yield_now().await;assert_eq!(r.poll(),None);
        r.start(async{Some("改查成都今天的天气".into())});tokio::task::yield_now().await;
        assert_eq!(r.poll().as_deref(),Some("改查成都今天的天气"));assert!(!r.blocked());
        assert!(!r.primary_text("改查成都今天的天气"));
        r.delivered_as("该查成都今天的天气");assert!(!r.primary_text("该查成都今天的天气"));
        r.speech_start(10000,true);assert!(r.primary_text("改查成都今天的天气"));
        r.start(std::future::pending());r.speech_start(12000,false);assert!(!r.blocked());
    }
}
