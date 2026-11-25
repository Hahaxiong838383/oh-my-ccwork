//! 个人房间的 ASR/TTS 快照。
//!
//! 每个 `pv-` 房间在进房时读一次 `PERSONAL_PROVIDERS_FILE`，把识别和合成钉死在这次任务里。
//! 语言模型不在这里选择：Worker 不读取、不改写、不发送大模型厂商密钥或地址，请求仍走既有 personal-brain。
//! `active` 为 null 时使用飞牛本地识别和本地五音色。档案按房间独立，不进进程级连接池、预录或别的房间。
//! 读不到、语音档案不存在或字段非法时返回诊断码，调用方不得把这种情况记成语音成功。
//! P003 不读取这个文件。无关的 LLM 条目不会让语音失效。

use crate::stt_volc::{PersonalAsrRoute, SttConfig, ASYNC_ASR_URL};
use crate::tts::TtsCfg;
use crate::tts_volc::TtsConfig;
use crate::tts_xfyun::XfyunTtsConfig;
use anyhow::Result;
use serde_json::{Map, Value};
use std::path::Path;

const MAX_BYTES: u64 = 262_144;
const DEFAULT_END_WINDOW_MS: u32 = 150;

#[derive(Debug)]
pub struct ProvidersError {
    pub code: &'static str,
    detail: String,
}

impl std::fmt::Display for ProvidersError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.detail.is_empty() {
            write!(formatter, "personal providers {}", self.code)
        } else {
            write!(formatter, "personal providers {}: {}", self.code, self.detail)
        }
    }
}

impl std::error::Error for ProvidersError {}

impl ProvidersError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }
}

/// 一个房间的语音选择。不含 Debug：里面有这次任务的语音密钥。
#[derive(Clone)]
pub struct SpeechPlan {
    pub revision: u64,
    pub asr_id: String,
    pub tts_id: String,
    pub llm_id: String,
    pub stt: SttConfig,
    pub tts: TtsCfg,
}

impl SpeechPlan {
    /// 语音房间的语言模型只走内网 personal-brain。这里没有厂商地址或密钥可以套用。
    pub fn llm_route(&self) -> &'static str {
        "personal-brain"
    }

    pub fn tts_pool_enabled(&self) -> bool {
        match &self.tts {
            TtsCfg::Volc(config) | TtsCfg::SnapshotVolc(config) => config.pool_enabled,
            TtsCfg::Xfyun(_) | TtsCfg::SnapshotXfyun { .. } | TtsCfg::PersonalLocal(_) => false,
        }
    }

    pub fn view(&self) -> PublicView {
        PublicView {
            state: "ok",
            reason: String::new(),
            revision: Some(self.revision),
            asr: self.asr_id.clone(),
            tts: self.tts_id.clone(),
            llm: self.llm_id.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicView {
    pub state: &'static str,
    pub reason: String,
    pub revision: Option<u64>,
    pub asr: String,
    pub tts: String,
    pub llm: String,
}

impl PublicView {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "state": self.state,
            "reason": self.reason,
            "revision": self.revision,
            "asr": self.asr,
            "tts": self.tts,
            "llm": self.llm,
            "llm_route": "personal-brain",
        })
    }
}

pub fn engaged() -> bool {
    std::env::var("PERSONAL_PROVIDERS_FILE").is_ok_and(|value| !value.trim().is_empty())
}

pub(crate) fn in_scope(agent: Option<&str>, room: &str) -> bool {
    agent == Some(crate::personal::AGENT) && crate::personal::is_room(room)
}

pub fn prepare(room: &str, metadata: &str) -> Result<Option<SpeechPlan>, ProvidersError> {
    if !in_scope(std::env::var("AGENT_NAME").ok().as_deref(), room) {
        return Ok(None);
    }
    let Some(path) = std::env::var_os("PERSONAL_PROVIDERS_FILE").filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    prepare_file(Path::new(&path), metadata, local_base()).map(Some)
}

fn local_base() -> Option<String> {
    crate::stt_volc::personal_local_speech::endpoint()
}

pub fn prepare_file(path: &Path, metadata: &str, local_base: Option<String>) -> Result<SpeechPlan, ProvidersError> {
    let document = read_document(path)?;
    resolve_document(&document, metadata, local_base.as_deref())
}

fn read_document(path: &Path) -> Result<Value, ProvidersError> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound { "absent" } else { "io" };
        ProvidersError::new("unreadable", code)
    })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BYTES {
        return Err(ProvidersError::new("illegal", "size"));
    }
    let bytes = std::fs::read(path).map_err(|_| ProvidersError::new("unreadable", "io"))?;
    serde_json::from_slice(&bytes).map_err(|_| ProvidersError::new("illegal", "json"))
}

fn resolve_document(document: &Value, metadata: &str, local_base: Option<&str>) -> Result<SpeechPlan, ProvidersError> {
    let root = object(document, "root")?;
    require_keys(root, &["version", "revision", "profiles", "active"], "root")?;
    if root.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(ProvidersError::new("illegal", "version"));
    }
    let revision = root.get("revision").and_then(Value::as_u64)
        .ok_or_else(|| ProvidersError::new("illegal", "revision"))?;
    let profiles = root.get("profiles").and_then(Value::as_array)
        .ok_or_else(|| ProvidersError::new("illegal", "profiles"))?;
    if profiles.len() > 32 {
        return Err(ProvidersError::new("illegal", "profiles"));
    }
    let mut parsed = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut llm_ids = std::collections::HashSet::new();
    for profile in profiles {
        match parse_profile(profile)? {
            Parsed::IgnoreLlm => {}
            Parsed::Llm(id) => {
                if !seen.insert(id.clone()) {
                    return Err(ProvidersError::new("illegal", "duplicate_id"));
                }
                llm_ids.insert(id);
            }
            Parsed::Speech(item) => {
                if !seen.insert(item.id.clone()) {
                    return Err(ProvidersError::new("illegal", "duplicate_id"));
                }
                parsed.push(item);
            }
        }
    }
    let active = object(root.get("active").unwrap_or(&Value::Null), "active")?;
    require_keys(active, &["llm", "asr", "tts"], "active")?;
    let request = parse_metadata(metadata)?;
    let llm_pick = request.llm.or_else(|| loose_pick(active, "llm"));
    let asr_pick = request.asr.unwrap_or(pick(active, "asr")?);
    let tts_pick = request.tts.unwrap_or(pick(active, "tts")?);
    let llm_id = match llm_pick {
        Some(Pick::Id(id)) if llm_ids.contains(&id) => id,
        _ => "cpa".to_owned(),
    };
    let (asr_id, stt) = resolve_asr(&parsed, asr_pick, local_base)?;
    let (tts_id, tts) = resolve_tts(&parsed, tts_pick, local_base)?;
    Ok(SpeechPlan { revision, asr_id, tts_id, llm_id, stt, tts })
}

struct RoomRequest {
    llm: Option<Pick>,
    asr: Option<Pick>,
    tts: Option<Pick>,
}

fn parse_metadata(metadata: &str) -> Result<RoomRequest, ProvidersError> {
    if metadata.trim().is_empty() {
        return Ok(RoomRequest { llm: None, asr: None, tts: None });
    }
    let value: Value = serde_json::from_str(metadata).map_err(|_| ProvidersError::new("illegal", "metadata_json"))?;
    let Some(object) = value.as_object() else {
        return Err(ProvidersError::new("illegal", "metadata_json"));
    };
    Ok(RoomRequest {
        llm: object.get("llm").and_then(|value| pick_value(value).ok()),
        asr: optional_pick(object, "asr")?,
        tts: optional_pick(object, "tts")?,
    })
}

fn optional_pick(object: &Map<String, Value>, key: &str) -> Result<Option<Pick>, ProvidersError> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => pick_value(value).map(Some),
    }
}

fn pick(object: &Map<String, Value>, key: &str) -> Result<Pick, ProvidersError> {
    pick_value(object.get(key).ok_or_else(|| ProvidersError::new("illegal", key))?)
}

fn loose_pick(object: &Map<String, Value>, key: &str) -> Option<Pick> {
    object.get(key).and_then(|value| pick_value(value).ok())
}

fn pick_value(value: &Value) -> Result<Pick, ProvidersError> {
    match value {
        Value::Null => Ok(Pick::Default),
        Value::String(id) => Ok(Pick::Id(profile_id(id)?)),
        _ => Err(ProvidersError::new("illegal", "selection_type")),
    }
}

#[derive(Clone)]
enum Pick {
    Default,
    Id(String),
}

struct Profile {
    id: String,
    kind: String,
    driver: String,
    config: Map<String, Value>,
    secrets: Map<String, Value>,
}

enum Parsed {
    Llm(String),
    Speech(Profile),
    /// 缺 id 的语言模型条目不能参与选择，也不让整份语音配置失效。
    IgnoreLlm,
}

fn parse_profile(value: &Value) -> Result<Parsed, ProvidersError> {
    let object = object(value, "profile")?;
    if object.get("kind").and_then(Value::as_str) == Some("llm") {
        let id = object.get("id").and_then(Value::as_str).unwrap_or("");
        return match profile_id(id) {
            Ok(id) => Ok(Parsed::Llm(id)),
            Err(_) => Ok(Parsed::IgnoreLlm),
        };
    }
    require_keys(object, &["id", "kind", "driver", "name", "config", "secrets"], "profile")?;
    let id = profile_id(object.get("id").and_then(Value::as_str).unwrap_or(""))?;
    let kind = enum_value(object, "kind", &["asr", "tts"])?;
    let driver = enum_value(object, "driver", &["doubao_asr", "doubao_tts", "xfyun_tts"])?;
    let driver_matches = match kind.as_str() {
        "asr" => driver == "doubao_asr",
        "tts" => driver == "doubao_tts" || driver == "xfyun_tts",
        _ => false,
    };
    if !driver_matches {
        return Err(ProvidersError::new("illegal", "driver_kind"));
    }
    let name = object.get("name").and_then(Value::as_str).unwrap_or("");
    if name.chars().count() == 0 || name.chars().count() > 80 || name.chars().any(|item| item.is_control()) {
        return Err(ProvidersError::new("illegal", "name"));
    }
    Ok(Parsed::Speech(Profile {
        id,
        kind,
        driver,
        config: owned_object(object, "config")?,
        secrets: owned_object(object, "secrets")?,
    }))
}

fn resolve_asr(profiles: &[Profile], pick: Pick, local_base: Option<&str>) -> Result<(String, SttConfig), ProvidersError> {
    let Some(profile) = selected(profiles, pick, "asr")? else { return Ok(("local".into(), local_stt(local_base)?)) };
    if profile.driver != "doubao_asr" { return Err(ProvidersError::new("illegal", "asr_driver")); }
    split_keys(
        &profile.config,
        &profile.secrets,
        &["VOLC_ASR_RESOURCE_ID", "VOLC_ASR_URL", "VOLC_ASR_END_WINDOW_MS", "VOLC_ASR_ENABLE_DDC"],
        &["VOLC_APP_ID", "VOLC_ACCESS_TOKEN", "VOLC_ASR_API_KEY"],
    )?;
    let resource_id = required_config(&profile.config, "VOLC_ASR_RESOURCE_ID")?;
    let url = match optional_config(&profile.config, "VOLC_ASR_URL")? {
        None => ASYNC_ASR_URL.to_owned(),
        Some(value) => allow_asr_url(&value)?,
    };
    let end_window_ms = match optional_config(&profile.config, "VOLC_ASR_END_WINDOW_MS")? {
        None => DEFAULT_END_WINDOW_MS,
        Some(value) => parse_end_window(&value)?,
    };
    let enable_ddc = match optional_config(&profile.config, "VOLC_ASR_ENABLE_DDC")? {
        None => true,
        Some(value) if value == "1" => true,
        Some(value) if value == "0" => false,
        Some(_) => return Err(ProvidersError::new("illegal", "VOLC_ASR_ENABLE_DDC")),
    };
    let api_key = optional_secret(&profile.secrets, "VOLC_ASR_API_KEY")?;
    let app_id = optional_secret(&profile.secrets, "VOLC_APP_ID")?;
    let access_token = optional_secret(&profile.secrets, "VOLC_ACCESS_TOKEN")?;
    if app_id.is_some() != access_token.is_some() {
        return Err(ProvidersError::new("illegal", "asr_auth"));
    }
    let pair = app_id.is_some() && access_token.is_some();
    if api_key.is_none() && !pair {
        return Err(ProvidersError::new("illegal", "asr_auth"));
    }
    let (app_id, access_token) = if api_key.is_some() {
        (String::new(), String::new())
    } else {
        (app_id.unwrap_or_default(), access_token.unwrap_or_default())
    };
    Ok((profile.id.clone(), SttConfig {
        async_connect: false,
        app_id,
        access_token,
        api_key,
        resource_id,
        end_window_ms,
        enable_ddc,
        canon: true,
        hotwords: Vec::new(),
        boosting_table_id: None,
        nonstream: url.trim_end_matches('/').ends_with("/api/v3/sauc/bigmodel_async"),
        url,
        personal_route: PersonalAsrRoute::Online,
    }))
}

fn resolve_tts(profiles: &[Profile], pick: Pick, local_base: Option<&str>) -> Result<(String, TtsCfg), ProvidersError> {
    let Some(profile) = selected(profiles, pick, "tts")? else {
        return Ok(("local".into(), TtsCfg::PersonalLocal(require_local(local_base)?)));
    };
    match profile.driver.as_str() {
        "doubao_tts" => {
            split_keys(
                &profile.config,
                &profile.secrets,
                &["VOLC_TTS_RESOURCE_ID", "VOLC_TTS_SPEAKER", "VOLC_TTS_SPEED"],
                &["VOLC_APP_ID", "VOLC_ACCESS_TOKEN"],
            )?;
            let speed_ratio = match optional_config(&profile.config, "VOLC_TTS_SPEED")? {
                None => 1.0,
                Some(value) => parse_volc_speed(&value)?,
            };
            Ok((profile.id.clone(), TtsCfg::SnapshotVolc(TtsConfig {
                app_id: required_secret(&profile.secrets, "VOLC_APP_ID")?,
                access_token: required_secret(&profile.secrets, "VOLC_ACCESS_TOKEN")?,
                resource_id: required_config(&profile.config, "VOLC_TTS_RESOURCE_ID")?,
                speaker: required_config(&profile.config, "VOLC_TTS_SPEAKER")?,
                speed_ratio,
                pool_enabled: false,
            })))
        }
        "xfyun_tts" => {
            split_keys(
                &profile.config,
                &profile.secrets,
                &["XFYUN_TTS_VCN", "XFYUN_TTS_SPEED", "XFYUN_TTS_ORAL_LEVEL", "XFYUN_TTS_PRECONNECT"],
                &["XFYUN_TTS_APP_ID", "XFYUN_TTS_API_KEY", "XFYUN_TTS_API_SECRET"],
            )?;
            let speed = match optional_config(&profile.config, "XFYUN_TTS_SPEED")? {
                None => 50,
                Some(value) => parse_xfyun_speed(&value)?,
            };
            let oral_level = match optional_config(&profile.config, "XFYUN_TTS_ORAL_LEVEL")? {
                None => "mid".to_owned(),
                Some(value) if matches!(value.as_str(), "low" | "mid" | "high") => value,
                Some(_) => return Err(ProvidersError::new("illegal", "XFYUN_TTS_ORAL_LEVEL")),
            };
            let preconnect = match optional_config(&profile.config, "XFYUN_TTS_PRECONNECT")? {
                None => crate::tts::preconnect_from_env(),
                Some(value) if value == "1" => true,
                Some(value) if value == "0" => false,
                Some(_) => return Err(ProvidersError::new("illegal", "XFYUN_TTS_PRECONNECT")),
            };
            Ok((profile.id.clone(), TtsCfg::SnapshotXfyun {
                config: XfyunTtsConfig {
                    app_id: required_secret(&profile.secrets, "XFYUN_TTS_APP_ID")?,
                    api_key: required_secret(&profile.secrets, "XFYUN_TTS_API_KEY")?,
                    api_secret: required_secret(&profile.secrets, "XFYUN_TTS_API_SECRET")?,
                    vcn: required_config(&profile.config, "XFYUN_TTS_VCN")?,
                    speed,
                    oral_level,
                },
                preconnect,
            }))
        }
        _ => Err(ProvidersError::new("illegal", "tts_driver")),
    }
}

fn selected<'a>(profiles: &'a [Profile], pick: Pick, kind: &str) -> Result<Option<&'a Profile>, ProvidersError> {
    let Pick::Id(id) = pick else { return Ok(None) };
    let profile = profiles.iter().find(|item| item.id == id)
        .ok_or_else(|| ProvidersError::new("illegal", "missing_profile"))?;
    if profile.kind != kind {
        return Err(ProvidersError::new("illegal", "profile_kind"));
    }
    Ok(Some(profile))
}

fn local_stt(local_base: Option<&str>) -> Result<SttConfig, ProvidersError> {
    let base = require_local(local_base)?;
    Ok(SttConfig {
        async_connect: false,
        app_id: String::new(),
        access_token: String::new(),
        api_key: None,
        resource_id: String::new(),
        end_window_ms: DEFAULT_END_WINDOW_MS,
        enable_ddc: true,
        canon: true,
        hotwords: Vec::new(),
        boosting_table_id: None,
        nonstream: false,
        url: String::new(),
        personal_route: PersonalAsrRoute::Local { base },
    })
}

fn require_local(local_base: Option<&str>) -> Result<String, ProvidersError> {
    local_base.filter(|value| !value.is_empty()).map(str::to_owned)
        .ok_or_else(|| ProvidersError::new("illegal", "local_speech_unavailable"))
}

fn allow_asr_url(value: &str) -> Result<String, ProvidersError> {
    let url = reqwest::Url::parse(value).map_err(|_| ProvidersError::new("illegal", "asr_url_rejected"))?;
    if url.scheme() != "wss" || url.host_str() != Some("openspeech.bytedance.com")
        || url.query().is_some() || !url.username().is_empty() || url.password().is_some()
        || url.port().is_some()
    {
        return Err(ProvidersError::new("illegal", "asr_url_rejected"));
    }
    let path = url.path().trim_end_matches('/');
    if path != "/api/v3/sauc/bigmodel_async" && path != "/api/v3/sauc/bigmodel" {
        return Err(ProvidersError::new("illegal", "asr_url_rejected"));
    }
    Ok(format!("wss://openspeech.bytedance.com{path}"))
}

fn parse_end_window(value: &str) -> Result<u32, ProvidersError> {
    let parsed = value.parse::<u32>().map_err(|_| ProvidersError::new("illegal", "VOLC_ASR_END_WINDOW_MS"))?;
    if (20..=2000).contains(&parsed) { Ok(parsed) } else { Err(ProvidersError::new("illegal", "VOLC_ASR_END_WINDOW_MS")) }
}

fn parse_volc_speed(value: &str) -> Result<f32, ProvidersError> {
    let bytes = value.as_bytes();
    let ok = match bytes {
        [b'0', b'.', b'5'..=b'9'] => true,
        [b'0', b'.', digit @ b'5'..=b'9', extra] => extra.is_ascii_digit() && *digit >= b'5',
        [b'1'] => true,
        [b'1', b'.', first] if first.is_ascii_digit() => true,
        [b'1', b'.', first, second] if first.is_ascii_digit() && second.is_ascii_digit() => true,
        [b'2'] => true,
        [b'2', b'.', b'0'] => true,
        [b'2', b'.', b'0', b'0'] => true,
        _ => false,
    };
    if !ok {
        return Err(ProvidersError::new("illegal", "VOLC_TTS_SPEED"));
    }
    value.parse::<f32>().map_err(|_| ProvidersError::new("illegal", "VOLC_TTS_SPEED"))
}

fn parse_xfyun_speed(value: &str) -> Result<i64, ProvidersError> {
    let ok = value == "100" || value.parse::<u8>().ok().filter(|_| value.len() == 1 || (value.len() == 2 && value.as_bytes()[0] != b'0')).is_some_and(|number| number <= 100);
    let parsed = value.parse::<i64>().map_err(|_| ProvidersError::new("illegal", "XFYUN_TTS_SPEED"))?;
    if ok && (0..=100).contains(&parsed) { Ok(parsed) } else { Err(ProvidersError::new("illegal", "XFYUN_TTS_SPEED")) }
}

fn split_keys(config: &Map<String, Value>, secrets: &Map<String, Value>, config_keys: &[&str], secret_keys: &[&str]) -> Result<(), ProvidersError> {
    for key in config.keys() {
        if secret_keys.contains(&key.as_str()) { return Err(ProvidersError::new("illegal", "secret_in_config")); }
        if !config_keys.contains(&key.as_str()) { return Err(ProvidersError::new("illegal", "unknown_config")); }
    }
    for key in secrets.keys() {
        if config_keys.contains(&key.as_str()) { return Err(ProvidersError::new("illegal", "config_in_secrets")); }
        if !secret_keys.contains(&key.as_str()) { return Err(ProvidersError::new("illegal", "unknown_secret")); }
    }
    Ok(())
}

fn required_config(config: &Map<String, Value>, key: &str) -> Result<String, ProvidersError> {
    plain_string(config.get(key), key)
}

fn optional_config(config: &Map<String, Value>, key: &str) -> Result<Option<String>, ProvidersError> {
    match config.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        Some(_) => required_config(config, key).map(Some),
    }
}

fn required_secret(secrets: &Map<String, Value>, key: &str) -> Result<String, ProvidersError> {
    plain_string(secrets.get(key), key)
}

fn optional_secret(secrets: &Map<String, Value>, key: &str) -> Result<Option<String>, ProvidersError> {
    match secrets.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        Some(_) => required_secret(secrets, key).map(Some),
    }
}

fn plain_string(value: Option<&Value>, key: &str) -> Result<String, ProvidersError> {
    let text = value.and_then(Value::as_str).ok_or_else(|| ProvidersError::new("illegal", key))?;
    if text.trim().is_empty() || text.len() > 256 || text.chars().any(|item| item.is_control() || item.is_whitespace()) {
        return Err(ProvidersError::new("illegal", key));
    }
    Ok(text.to_owned())
}

fn object<'a>(value: &'a Value, code: &'static str) -> Result<&'a Map<String, Value>, ProvidersError> {
    value.as_object().ok_or_else(|| ProvidersError::new("illegal", code))
}

fn owned_object(object: &Map<String, Value>, key: &str) -> Result<Map<String, Value>, ProvidersError> {
    object.get(key).and_then(Value::as_object).cloned().ok_or_else(|| ProvidersError::new("illegal", key))
}

fn require_keys(object: &Map<String, Value>, keys: &[&str], code: &'static str) -> Result<(), ProvidersError> {
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(ProvidersError::new("illegal", code));
    }
    Ok(())
}

fn enum_value(object: &Map<String, Value>, key: &str, allowed: &[&str]) -> Result<String, ProvidersError> {
    let value = object.get(key).and_then(Value::as_str).unwrap_or("");
    allowed.iter().find(|item| **item == value).map(|item| (*item).to_owned())
        .ok_or_else(|| ProvidersError::new("illegal", key))
}

fn profile_id(value: &str) -> Result<String, ProvidersError> {
    let bytes = value.as_bytes();
    if (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-' || *byte == b'_')
    {
        Ok(value.to_owned())
    } else {
        Err(ProvidersError::new("illegal", "profile_id"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANARY: &str = "CANARY-SECRET-DO-NOT-LEAK";
    const LOCAL: &str = "http://personal-local-speech:8090";

    fn document() -> Value {
        serde_json::json!({
            "version": 1,
            "revision": 7,
            "profiles": [
                {"id":"ds","kind":"llm","driver":"deepseek","name":"官方","config":{"DEEPSEEK_MODEL":"deepseek-v4","DEEPSEEK_BASE_URL":"https://api.deepseek.com"},"secrets":{"DEEPSEEK_API_KEY":CANARY}},
                {"id":"asr-a","kind":"asr","driver":"doubao_asr","name":"甲","config":{"VOLC_ASR_RESOURCE_ID":"resource-a","VOLC_ASR_END_WINDOW_MS":"150","VOLC_ASR_ENABLE_DDC":"1"},"secrets":{"VOLC_APP_ID":"app-a","VOLC_ACCESS_TOKEN":CANARY}},
                {"id":"asr-b","kind":"asr","driver":"doubao_asr","name":"乙","config":{"VOLC_ASR_RESOURCE_ID":"resource-b","VOLC_ASR_URL":"wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"},"secrets":{"VOLC_ASR_API_KEY":"key-b"}},
                {"id":"tts-v","kind":"tts","driver":"doubao_tts","name":"豆包","config":{"VOLC_TTS_RESOURCE_ID":"seed-tts-2.0","VOLC_TTS_SPEAKER":"speaker-a","VOLC_TTS_SPEED":"1.25"},"secrets":{"VOLC_APP_ID":"app-tts","VOLC_ACCESS_TOKEN":"token-tts"}},
                {"id":"tts-x","kind":"tts","driver":"xfyun_tts","name":"讯飞","config":{"XFYUN_TTS_VCN":"vcn-a","XFYUN_TTS_SPEED":"40","XFYUN_TTS_ORAL_LEVEL":"high","XFYUN_TTS_PRECONNECT":"0"},"secrets":{"XFYUN_TTS_APP_ID":"xf-app","XFYUN_TTS_API_KEY":"xf-key","XFYUN_TTS_API_SECRET":CANARY}}
            ],
            "active": {"llm": null, "asr": null, "tts": null}
        })
    }

    fn resolve(document: &Value, metadata: &str) -> SpeechPlan {
        match resolve_document(document, metadata, Some(LOCAL)) {
            Ok(plan) => plan,
            Err(error) => panic!("resolve failed: {error}"),
        }
    }

    fn expect_err(result: Result<SpeechPlan, ProvidersError>) -> ProvidersError {
        match result {
            Err(error) => error,
            Ok(_) => panic!("expected provider error"),
        }
    }

    #[test]
    fn null_active_uses_local_speech_and_keeps_brain_route() {
        let plan = resolve(&document(), "{}");
        assert_eq!(plan.asr_id, "local");
        assert_eq!(plan.tts_id, "local");
        assert_eq!(plan.llm_id, "cpa");
        assert_eq!(plan.llm_route(), "personal-brain");
        assert!(matches!(plan.stt.personal_route, PersonalAsrRoute::Local { .. }));
        assert!(matches!(plan.tts, TtsCfg::PersonalLocal(_)));
        assert!(!plan.tts_pool_enabled());
        let rendered = plan.view().to_json().to_string();
        assert!(rendered.contains("personal-brain"));
        assert!(!rendered.contains(CANARY));
        assert!(!rendered.contains("api.deepseek.com"));
        assert!(!rendered.contains("deepseek-v4"));
    }

    #[test]
    fn malformed_llm_entry_does_not_disable_asr_or_tts() {
        let mut broken = document();
        broken["profiles"][0] = serde_json::json!({
            "id":"ds","kind":"llm","driver":"not-a-model","name":"坏掉的模型",
            "config":{"DEEPSEEK_BASE_URL":"https://api.deepseek.com","DEEPSEEK_API_KEY":CANARY},
            "secrets":{"DEEPSEEK_API_KEY":CANARY},"extra":CANARY
        });
        broken["active"]["llm"] = serde_json::json!(7);
        broken["active"]["asr"] = Value::String("asr-a".into());
        broken["active"]["tts"] = Value::String("tts-v".into());
        let plan = resolve_document(&broken, r#"{"llm":"https://api.deepseek.com"}"#, None).unwrap();
        assert_eq!(plan.asr_id, "asr-a");
        assert_eq!(plan.llm_id, "cpa");
        assert_eq!(plan.llm_route(), "personal-brain");
        assert_eq!(plan.stt.end_window_ms, 150);
        assert!(plan.stt.enable_ddc);
        assert!(plan.stt.nonstream);
        assert_eq!(plan.stt.url, ASYNC_ASR_URL);
        match &plan.tts {
            TtsCfg::SnapshotVolc(config) => {
                assert_eq!(config.speaker, "speaker-a");
                assert!((config.speed_ratio - 1.25).abs() < 0.001);
                assert!(!config.pool_enabled);
            }
            _ => panic!("doubao tts snapshot"),
        }
        let rendered = plan.view().to_json().to_string();
        assert!(!rendered.contains(CANARY));
        assert!(!rendered.contains("api.deepseek.com"));
    }

    #[test]
    fn asr_and_tts_select_independently_and_do_not_cross_rooms() {
        let mut active = document();
        active["active"]["asr"] = Value::String("asr-a".into());
        active["active"]["tts"] = Value::String("tts-x".into());
        let room_a = resolve(&active, r#"{"asr":"asr-b","tts":null}"#);
        let room_b = resolve(&active, "{}");
        assert_eq!(room_a.stt.resource_id, "resource-b");
        assert_eq!(room_a.stt.url, "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel");
        assert!(!room_a.stt.nonstream);
        assert_eq!(room_a.stt.end_window_ms, 150);
        assert!(room_a.stt.enable_ddc);
        assert!(matches!(room_a.tts, TtsCfg::PersonalLocal(_)));
        assert_eq!(room_b.stt.resource_id, "resource-a");
        assert_eq!(room_b.stt.url, ASYNC_ASR_URL);
        assert!(room_b.stt.nonstream);
        assert_eq!(room_b.stt.end_window_ms, 150);
        assert!(room_b.stt.enable_ddc);
        assert!(matches!(room_b.stt.personal_route, PersonalAsrRoute::Online));
        match &room_b.tts {
            TtsCfg::SnapshotXfyun { config, preconnect } => {
                assert_eq!(config.vcn, "vcn-a");
                assert_eq!(config.speed, 40);
                assert_eq!(config.oral_level, "high");
                assert!(!preconnect);
            }
            _ => panic!("xfyun snapshot"),
        }
        assert_ne!(room_a.stt.api_key, room_b.stt.api_key);
        assert!(!room_a.tts_pool_enabled());
        assert!(!room_b.tts_pool_enabled());
    }

    #[test]
    fn explicit_asr_window_and_async_nonstream_are_consumed() {
        let mut active = document();
        active["profiles"][2]["config"] = serde_json::json!({
            "VOLC_ASR_RESOURCE_ID":"resource-b",
            "VOLC_ASR_URL":"wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
            "VOLC_ASR_END_WINDOW_MS":"200",
            "VOLC_ASR_ENABLE_DDC":"0"
        });
        let plan = resolve(&active, r#"{"asr":"asr-b"}"#);
        assert_eq!(plan.stt.end_window_ms, 200);
        assert!(!plan.stt.enable_ddc);
        assert!(plan.stt.nonstream);
        assert_eq!(plan.stt.url, ASYNC_ASR_URL);
    }

    #[test]
    fn doubao_tts_never_enters_the_shared_pool() {
        let plan = resolve(&document(), r#"{"tts":"tts-v"}"#);
        assert!(!plan.tts_pool_enabled());
        match &plan.tts {
            TtsCfg::SnapshotVolc(config) => {
                assert_eq!(config.speaker, "speaker-a");
                assert!(!config.pool_enabled);
            }
            _ => panic!("doubao tts"),
        }
    }

    #[test]
    fn rejected_url_and_secret_placement_are_diagnosed_without_echo() {
        let mut forwarded = document();
        forwarded["profiles"][1]["config"]["VOLC_ASR_URL"] = Value::String("https://evil.example/take?key=CANARY-SECRET-DO-NOT-LEAK".into());
        forwarded["active"]["asr"] = Value::String("asr-a".into());
        let error = expect_err(resolve_document(&forwarded, "{}", Some(LOCAL)));
        assert_eq!(error.code, "illegal");
        assert_eq!(error.detail, "asr_url_rejected");
        assert!(!error.to_string().contains(CANARY));
        assert!(!error.to_string().contains("evil.example"));

        let mut explicit = document();
        explicit["profiles"][1]["config"] = serde_json::json!({"VOLC_ASR_RESOURCE_ID":"resource-a","VOLC_ASR_URL":"https://collector.example/asr"});
        explicit["active"]["asr"] = Value::String("asr-a".into());
        let error = expect_err(resolve_document(&explicit, "{}", Some(LOCAL)));
        assert_eq!(error.detail, "asr_url_rejected");
        assert!(!error.to_string().contains("collector.example"));
        assert!(!error.to_string().contains(CANARY));

        let mut misplaced = document();
        misplaced["profiles"][1]["config"]["VOLC_APP_ID"] = Value::String(CANARY.into());
        misplaced["active"]["asr"] = Value::String("asr-a".into());
        let error = expect_err(resolve_document(&misplaced, "{}", Some(LOCAL)));
        assert_eq!(error.detail, "secret_in_config");
        assert!(!error.to_string().contains(CANARY));
    }

    #[test]
    fn missing_file_and_illegal_selection_name_the_reason() {
        let directory = std::env::temp_dir().join(format!("personal-providers-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let missing = directory.join("providers.json");
        let error = expect_err(prepare_file(&missing, "{}", Some(LOCAL.into())));
        assert_eq!(error.code, "unreadable");
        assert_eq!(error.detail, "absent");
        std::fs::write(&missing, b"{").unwrap();
        let error = expect_err(prepare_file(&missing, "{}", Some(LOCAL.into())));
        assert_eq!(error.detail, "json");
        let error = expect_err(resolve_document(&document(), r#"{"asr":"missing"}"#, Some(LOCAL)));
        assert_eq!(error.detail, "missing_profile");
        let error = expect_err(resolve_document(&document(), r#"{"asr":"tts-v"}"#, Some(LOCAL)));
        assert_eq!(error.detail, "profile_kind");
        let error = expect_err(resolve_document(&document(), "{}", None));
        assert_eq!(error.detail, "local_speech_unavailable");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn p003_room_is_outside_the_personal_contract() {
        assert!(!in_scope(Some("realtime-voice-agent"), "sn-BJP00326070803800006-1"));
        assert!(!in_scope(Some(crate::personal::AGENT), "sn-BJP00326070803800006-1"));
        assert!(in_scope(Some(crate::personal::AGENT), "pv-0123456789abcdef0123456789abcdef"));
    }
}
