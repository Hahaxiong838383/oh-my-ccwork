//! Anonymous stage measurements use a bounded queue, separate from audio publication.
use serde::Serialize;
use std::{
    fs,
    io::{self, Write},
    path::Path,
    sync::{
        mpsc::{sync_channel, SyncSender},
        OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};
#[derive(Serialize)]
struct Sample {
    at: u64,
    room: String,
    turn: u64,
    stage: &'static str,
    ms: u64,
}
static WRITER: OnceLock<Option<SyncSender<Sample>>> = OnceLock::new();
pub fn record(room: &str, turn: u64, stage: &'static str, ms: u64) {
    if !crate::personal::is_room(room)
        || std::env::var("AGENT_NAME").ok().as_deref() != Some(crate::personal::AGENT)
    {
        return;
    }
    let writer = WRITER.get_or_init(|| {
        let status = std::env::var_os("PERSONAL_STATUS_FILE")?;
        let path = Path::new(&status).with_file_name("turn-timing.jsonl");
        let (sender, receiver) = sync_channel(128);
        std::thread::Builder::new()
            .name("private-timing".into())
            .spawn(move || {
                for value in receiver {
                    if append(&path, &value).is_err() {
                        tracing::warn!("private timing sample not saved");
                    }
                }
            })
            .ok()?;
        Some(sender)
    });
    if let Some(sender) = writer {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let _ = sender.try_send(Sample {
            at,
            room: room.to_owned(),
            turn,
            stage,
            ms,
        });
    }
}
fn append(path: &Path, value: &Sample) -> io::Result<()> {
    if fs::metadata(path).is_ok_and(|m| m.len() >= 256 * 1024) {
        fs::rename(path, path.with_extension("previous"))?;
    }
    let mut line = serde_json::to_vec(value)?;
    line.push(b'\n');
    fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)?
        .write_all(&line)
}
