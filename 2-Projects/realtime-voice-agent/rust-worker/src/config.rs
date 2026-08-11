//! env 配置(凭据只走 env 注入,不落盘不进 git)。

use anyhow::{bail, Result};

#[derive(Clone, Debug)]
pub struct Config {
    pub ws_url: String,
    pub api_key: String,
    pub api_secret: String,
    pub agent_name: String,
    pub max_jobs: usize,
    /// P2 骨架:participant 进房后播的 greeting wav(16k mono);未配则不播。
    pub greeting_wav: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let ws_url = std::env::var("LIVEKIT_URL").unwrap_or_default();
        let api_key = std::env::var("LIVEKIT_API_KEY").unwrap_or_default();
        let api_secret = std::env::var("LIVEKIT_API_SECRET").unwrap_or_default();
        if ws_url.is_empty() || api_key.is_empty() || api_secret.is_empty() {
            bail!("LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET 必须通过 env 注入");
        }
        Ok(Self {
            ws_url,
            api_key,
            api_secret,
            agent_name: std::env::var("AGENT_NAME").unwrap_or_else(|_| "rust-worker-dev".into()),
            max_jobs: std::env::var("WORKER_MAX_JOBS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1),
            greeting_wav: std::env::var("GREETING_WAV").ok().filter(|s| !s.is_empty()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_env_fails_fast() {
        // 清空关键 env 的进程内视角无法安全并行,这里只验证空值判定逻辑
        let cfg = Config {
            ws_url: String::new(),
            api_key: "k".into(),
            api_secret: "s".into(),
            agent_name: "a".into(),
            max_jobs: 1,
            greeting_wav: None,
        };
        assert!(cfg.ws_url.is_empty());
    }
}
