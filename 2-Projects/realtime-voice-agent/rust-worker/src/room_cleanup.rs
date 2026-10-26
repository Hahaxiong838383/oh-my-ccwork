//! Durable candidate room ownership, consumed by the independent reconciler.
//! Only identifiers/lifecycle state are stored; never credentials or dialogue.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::{Path, PathBuf}};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
struct Record {
    schema: u8, room: String, sid: String, generation: String, deadline_ms: u64,
    state: String, updated_at_ms: u64, pid: u32, process_start: String,
}

pub struct CloseIntent { path: PathBuf, record: Record }

fn valid_room(room: &str) -> bool {
    let Some(rest) = room.strip_prefix("sn-BJP003") else { return false; };
    let Some((serial, time)) = rest.split_once('-') else { return false; };
    serial.len() == 14 && serial.bytes().all(|v| v.is_ascii_digit())
        && !time.is_empty() && time.len() <= 20 && time.bytes().all(|v| v.is_ascii_digit())
}

fn atomic_record(path: &Path, record: &Record) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] options.mode(0o600);
    let result = (|| -> Result<()> {
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(record)?)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        fs::File::open(path.parent().context("cleanup_parent")?)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

impl CloseIntent {
    fn create(dir: &Path, room: &str, sid: &str, generation: &str, deadline_ms: u64,
              pid: u32, process_start: String, now: u64) -> Result<Self> {
        anyhow::ensure!(valid_room(room) && sid.starts_with("RM_") && sid.len() <= 103
            && sid[3..].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            && sid.len() > 3 && !generation.is_empty() && generation.len() <= 128
            && deadline_ms > 0 && pid > 0 && !process_start.is_empty()
            && process_start.bytes().all(|c| c.is_ascii_digit()), "invalid_cleanup_identity");
        anyhow::ensure!(dir.is_absolute() && fs::canonicalize(dir)? == dir, "cleanup_directory_must_be_real");
        #[cfg(unix)] anyhow::ensure!(fs::metadata(dir)?.permissions().mode() & 0o077 == 0, "cleanup_directory_must_be_private");
        let path = dir.join(format!("{:x}.json", Sha256::digest(sid.as_bytes())));
        // Never replace a different existing owner record.
        anyhow::ensure!(!path.exists(), "cleanup_intent_already_exists");
        let record = Record {schema:1, room:room.into(), sid:sid.into(), generation:generation.into(),
            deadline_ms, state:"active".into(), updated_at_ms:now, pid, process_start};
        atomic_record(&path, &record)?;
        Ok(Self {path, record})
    }

    pub fn begin(agent: &str, room: &str, sid: &str, metadata: &str) -> Result<Option<Self>> {
        if !crate::search_canary::is_candidate(agent)
            || !std::env::var("P003_ROOM_CLEANUP_V1").is_ok_and(|v| v == "1") { return Ok(None); }
        let dir = PathBuf::from(std::env::var("P003_ROOM_CLEANUP_DIR")?);
        let m: serde_json::Value = serde_json::from_str(metadata)?;
        let m = &m["search_canary"];
        let stat = fs::read_to_string("/proc/self/stat")?;
        let start = stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().nth(19))
            .context("cleanup_process_identity")?.to_owned();
        Self::create(&dir, room, sid, m["generation"].as_str().context("cleanup_generation")?,
            m["expires_at_ms"].as_u64().context("cleanup_deadline")?, std::process::id(), start,
            crate::search_canary::now_ms()).map(Some)
    }

    pub fn closing(&mut self) -> Result<()> {
        // The background reconciler can already have completed an expired room.
        if !self.path.exists() { return Ok(()); }
        let current: Record = serde_json::from_slice(&fs::read(&self.path)?)?;
        anyhow::ensure!(current == self.record, "cleanup_record_changed");
        let mut next = self.record.clone();
        next.state = "closing".into();
        next.updated_at_ms = crate::search_canary::now_ms();
        atomic_record(&self.path, &next)?;
        self.record = next;
        Ok(())
    }

}

impl Drop for CloseIntent {
    fn drop(&mut self) {
        // Also covers connect/publish failures and cancellation before the
        // normal job footer. A worker process crash is covered by owner PID.
        if self.record.state == "active" && self.closing().is_err() {
            tracing::error!(room=%self.record.room, "room cleanup intent transition failed");
        }
    }
}

/// A stale/missing reconciler cannot grant a fresh dispatch lease.
pub fn health(raw: &str, now: u64) -> serde_json::Value {
    let value: serde_json::Value=serde_json::from_str(raw).unwrap_or_default();
    let at=value["at_ms"].as_u64().unwrap_or(0);
    let remaining=value["remaining"].as_u64().unwrap_or(u64::MAX);
    let pending=["pending","invalid","record_changed"].iter()
        .map(|k|value["counts"][k].as_u64().unwrap_or(0)).fold(0u64,u64::saturating_add);
    let healthy=value["healthy"].as_bool()==Some(true)&&at>0&&at<=now&&now-at<=120_000
        &&remaining<=512&&pending==0;
    serde_json::json!({"healthy":healthy,"at_ms":at,"pending":pending,"remaining":remaining})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> PathBuf {
        let p = std::env::temp_dir().join(format!("r16-close-{}",uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        #[cfg(unix)] fs::set_permissions(&p,fs::Permissions::from_mode(0o700)).unwrap();
        fs::canonicalize(p).unwrap()
    }
    #[test]
    fn r16_cleanup_health_fails_closed_on_stale_missing_and_pending() {
        assert_eq!(health("{}",150000)["healthy"],false);
        let valid=r#"{"at_ms":150000,"remaining":2,"counts":{"active":2},"healthy":true}"#;
        assert_eq!(health(valid,150001)["healthy"],true);
        assert_eq!(health(valid,270001)["healthy"],false);
        assert_eq!(health(valid,149999)["healthy"],false);
        let pending=r#"{"at_ms":150000,"remaining":1,"counts":{"pending":1},"healthy":true}"#;
        assert_eq!(health(pending,150001)["healthy"],false);
    }
    #[test]
    fn r16_close_intent_survives_owner_drop_until_confirmed() {
        let dir=directory();
        let item=CloseIntent::create(&dir,"sn-BJP00326060100100004-123","RM_test","g1",90000,123,"12345".into(),1000).unwrap();
        let path=item.path.clone();drop(item);
        let record:Record=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(record.state,"closing");assert_eq!(record.deadline_ms,90000);
        // Only the independent API reconciliation may remove the durable record.
        assert!(path.exists());fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn r16_invalid_room_and_changed_record_are_not_overwritten() {
        let dir=directory();
        assert!(CloseIntent::create(&dir,"ordinary-room","RM_test","g1",90000,123,"12345".into(),1000).is_err());
        let mut item=CloseIntent::create(&dir,"sn-BJP00326060100100004-123","RM_test","g1",90000,123,"12345".into(),1000).unwrap();
        let mut newer=item.record.clone();newer.generation="g2".into();atomic_record(&item.path,&newer).unwrap();
        assert!(item.closing().is_err());assert!(item.path.exists());fs::remove_dir_all(dir).unwrap();
    }
}
