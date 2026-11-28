//! The owner publishes a small file beside the personal provider catalog.
//! A room reads one immutable configuration when its private pipeline is built.
use crate::{backchannel::BackchannelCfg, pipeline::PipelineConfig, textproc::normalize_utterance};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs, io,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Default, Deserialize)]
pub struct WordSnapshot {
    pub revision: u64,
    #[serde(default)]
    words: BTreeMap<String, Vec<String>>,
}

impl WordSnapshot {
    pub fn read(path: &Path) -> io::Result<Self> {
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e),
        };
        if file.metadata()?.len() > 512 * 1024 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        #[derive(Deserialize)]
        struct Published {
            current: WordSnapshot,
        }
        let current = serde_json::from_reader::<_, Published>(file)?.current;
        Ok(current)
    }

    pub fn recognition(&self) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        ["asr", "device_asr"]
            .iter()
            .filter_map(|k| self.words.get(*k))
            .flatten()
            .filter(|w| seen.insert(w.as_str()))
            .cloned()
            .collect()
    }

    pub fn apply_controls(&self, config: &mut PipelineConfig) {
        if let Some(words) = self.words.get("interrupt") {
            config
                .hotwords
                .extend(words.iter().map(|w| normalize_utterance(w)));
        }
        if let Some(words) = self.words.get("exit") {
            config
                .exit_hotwords
                .extend(words.iter().map(|w| normalize_utterance(w)));
        }
        if let Some(words) = self.words.get("backchannel") {
            config.backchannel.words =
                BackchannelCfg::from_values(Some(&words.join(",")), None, None).words;
        }
    }
}

pub fn receipt(room: &str, revision: Option<u64>, cloud_asr: bool) -> io::Result<()> {
    let Some(status) = std::env::var_os("PERSONAL_STATUS_FILE") else {
        return Ok(());
    };
    let path = Path::new(&status).with_file_name("words-receipt.json");
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let value = serde_json::json!({"at":at,"revision":revision,"cloudAsr":cloud_asr,"room":room});
    let result = fs::write(&tmp, value.to_string()).and_then(|_| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_room_keeps_builtins_and_deduplicates_asr() {
        let s: WordSnapshot = serde_json::from_str(r#"{"revision":3,"words":{"interrupt":["让我说"],"exit":["歇一会"],"asr":["飞牛"],"device_asr":["飞牛","青枫"],"backchannel":["嗯","停"]}}"#).unwrap();
        assert_eq!(s.recognition(), ["飞牛", "青枫"]);
        let mut cfg = PipelineConfig::from_env();
        cfg.hotwords = crate::personal::stop_words();
        cfg.exit_hotwords = cfg.hotwords.clone();
        s.apply_controls(&mut cfg);
        assert!(cfg.hotwords.contains("让我说") && cfg.hotwords.contains("停"));
        assert!(cfg.exit_hotwords.contains("歇一会") && !cfg.exit_hotwords.contains("让我说"));
        assert!(cfg.backchannel.words.contains("嗯") && !cfg.backchannel.words.contains("停"));
    }
}
