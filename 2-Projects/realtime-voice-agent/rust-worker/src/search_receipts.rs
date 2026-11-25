//! Predecoded search intent receipts. Loaded once per candidate session, never on a turn.
use std::path::Path;
use anyhow::{ensure, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Search, Weather, News, Clarify }
#[derive(Clone)]
pub struct Clip { pub id: String, pub text: String, pub pcm: Vec<u8>, pub kind: Kind }
pub struct Bank { clips: Vec<Clip>, next: usize }

pub const CATALOG: &[(&str, &str, Kind)] = &[
    ("lookup", "我查查。", Kind::Search),
    ("find", "我找找。", Kind::Search),
    ("search", "我搜搜。", Kind::Search),
    ("weather", "查查天气。", Kind::Weather),
    ("news", "看看新闻。", Kind::News),
    ("clarify", "想查什么？", Kind::Clarify),
];
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest { version: u8, provider: String, voice: String, clips: Vec<Entry> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry { id: String, file: String, text: String, sha256: String }
impl Bank {
    pub fn from_env(provider: &str, voice: &str) -> Option<Self> {
        // 个人本地音色由服务当场选择。固定标签或上一轮音色都不能打开旧预录。
        if voice == crate::stt_volc::personal_local_speech::VOICE_UNREPORTED
            || crate::stt_volc::personal_local_speech::endpoint().is_some()
        {
            tracing::info!("search receipt bank skipped: personal speech selects the voice");
            return None;
        }
        if std::env::var("P003_SEARCH_RECEIPTS_V1").ok().as_deref()!=Some("1") { return None; }
        let path=std::env::var("P003_SEARCH_RECEIPTS_DIR").ok()?;
        match Self::load(Path::new(&path),provider,voice) {
            Ok(bank)=>{tracing::info!(clips=bank.clips.len(),"search receipt bank verified");Some(bank)},
            Err(_)=>{tracing::warn!("search receipt bank invalid; using existing TTS acknowledgement");None},
        }
    }
    pub fn load(dir: &Path, provider: &str, voice: &str) -> Result<Self> {
        ensure!(std::fs::metadata(dir.join("manifest.json"))?.len()<=8192,"manifest size");
        let m:Manifest=serde_json::from_slice(&std::fs::read(dir.join("manifest.json"))?)?;
        ensure!(m.version==1 && m.provider==provider && m.voice==voice,"voice/version mismatch");
        ensure!(m.clips.len()==CATALOG.len(),"incomplete catalog");
        let mut clips=Vec::new();
        let mut seen=std::collections::HashSet::new();
        for e in m.clips {
            let (_,text,kind)=CATALOG.iter().find(|(id,_,_)|*id==e.id).ok_or_else(||anyhow::anyhow!("unknown clip"))?;
            ensure!(seen.insert(e.id.clone()) && e.file==format!("{}.wav",e.id) && e.text==*text,"clip metadata");
            let path=dir.join(&e.file);
            ensure!(std::fs::symlink_metadata(&path)?.file_type().is_file(),"regular asset required");
            ensure!(std::fs::metadata(&path)?.len()<=100_000,"asset size");
            let bytes=std::fs::read(path)?;
            ensure!(format!("{:x}",Sha256::digest(&bytes))==e.sha256,"asset hash");
            let mut wav=hound::WavReader::new(std::io::Cursor::new(bytes))?;
            let s=wav.spec();
            ensure!(s.channels==1 && s.sample_rate==24000 && s.bits_per_sample==16 && s.sample_format==hound::SampleFormat::Int,"PCM format");
            let samples:Vec<i16>=wav.samples::<i16>().collect::<std::result::Result<_,_>>()?;
            ensure!((2400..=43200).contains(&samples.len()),"receipt must be 100..1800ms");
            ensure!(samples.iter().any(|v|v.unsigned_abs()>200),"silent receipt");
            clips.push(Clip{id:e.id,text:e.text,pcm:samples.into_iter().flat_map(i16::to_le_bytes).collect(),kind:*kind});
        }
        Ok(Self{clips,next:0})
    }
    pub fn pick(&mut self,kind:Kind)->Clip {
        // Catalog completeness is established before activation; no per-turn disk/network.
        let pool:Vec<_>=self.clips.iter().filter(|c|c.kind==kind).collect();
        let clip=pool[self.next%pool.len()].clone();self.next=self.next.wrapping_add(1);clip
    }
    #[cfg(test)]
    pub fn synthetic()->Self {
        Self{clips:CATALOG.iter().map(|(id,text,kind)|Clip{id:(*id).into(),text:(*text).into(),pcm:vec![1,4].repeat(2400),kind:*kind}).collect(),next:0}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->(std::path::PathBuf,serde_json::Value) {
        let dir=std::env::temp_dir().join(format!("p003-search-receipt-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&dir).unwrap();
        let entries:Vec<_>=CATALOG.iter().map(|(id,text,_)|{
            let file=format!("{id}.wav");let mut wav=hound::WavWriter::create(dir.join(&file),hound::WavSpec{channels:1,sample_rate:24000,bits_per_sample:16,sample_format:hound::SampleFormat::Int}).unwrap();
            for _ in 0..2400 {wav.write_sample(1000i16).unwrap();}wav.finalize().unwrap();
            serde_json::json!({"id":id,"file":file,"text":text,"sha256":format!("{:x}",Sha256::digest(std::fs::read(dir.join(file)).unwrap()))})
        }).collect();
        let m=serde_json::json!({"version":1,"provider":"xfyun","voice":"synthetic-voice","clips":entries});(dir,m)
    }
    fn save(dir:&Path,m:&serde_json::Value){std::fs::write(dir.join("manifest.json"),m.to_string()).unwrap();}
    #[test]
    fn r13_receipt_assets_require_hash_format_voice_and_complete_catalog(){
        let(dir,mut m)=fixture();save(&dir,&m);assert!(Bank::load(&dir,"xfyun","synthetic-voice").is_ok());
        assert!(Bank::load(&dir,"xfyun","other-voice").is_err());
        m["clips"][0]["file"]=serde_json::json!("../escape.wav");save(&dir,&m);assert!(Bank::load(&dir,"xfyun","synthetic-voice").is_err());
        m["clips"][0]["file"]=serde_json::json!("lookup.wav");m["clips"][0]["sha256"]=serde_json::json!("0".repeat(64));save(&dir,&m);assert!(Bank::load(&dir,"xfyun","synthetic-voice").is_err());
        m["clips"].as_array_mut().unwrap().pop();save(&dir,&m);assert!(Bank::load(&dir,"xfyun","synthetic-voice").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn historical_voice_cache_does_not_bind_when_the_service_has_not_named_a_voice(){
        let (dir, mut m)=fixture();
        m["provider"]=serde_json::json!("personal-local-pilot");
        m["voice"]=serde_json::json!("piper-zh-huayan-medium");
        save(&dir,&m);
        assert!(Bank::load(&dir,"personal-local-pilot","piper-zh-huayan-medium").is_ok());
        assert!(Bank::load(&dir,"personal-local-pilot",crate::stt_volc::personal_local_speech::VOICE_UNREPORTED).is_err());
        assert!(Bank::from_env("personal-local-pilot",crate::stt_volc::personal_local_speech::VOICE_UNREPORTED).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn r13_receipt_rotates_only_within_requested_module(){
        let mut b=Bank::synthetic();let a=b.pick(Kind::Search);let c=b.pick(Kind::Search);assert_ne!(a.id,c.id);
        assert_eq!(b.pick(Kind::Weather).id,"weather");assert_eq!(b.pick(Kind::News).id,"news");assert_eq!(b.pick(Kind::Clarify).id,"clarify");
    }
}
