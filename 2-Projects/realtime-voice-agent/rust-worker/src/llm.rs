//! OpenAI 兼容流式 LLM 客户端(行为对齐 fast_llm.py 主路:httpx 直发 SSE +
//! DeepSeek `thinking:{"type":"disabled"}` 关思考)。赛马/兜底/剥承接词 = P3b。

use anyhow::{Context, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{info, warn};

#[derive(Clone)]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub instructions: String,
    /// "disabled"/"enabled"/"adaptive" 传 thinking body;"off"=不传(非 DeepSeek 端点)。
    pub thinking: String,
}

impl LlmConfig {
    pub fn from_env() -> Option<Self> {
        let base_url = std::env::var("LLM_BASE_URL").ok()?;
        Some(Self {
            base_url,
            api_key: std::env::var("LLM_API_KEY").unwrap_or_else(|_| "sk-noauth".into()),
            model: std::env::var("LLM_MODEL").unwrap_or_else(|_| "deepseek-chat".into()),
            instructions: std::env::var("AGENT_INSTRUCTIONS").unwrap_or_else(|_| {
                "你是一个实时语音助手。回答口语化、简短,每句不超过20字,不用列表不用markdown。".into()
            }),
            thinking: std::env::var("LLM_THINKING").unwrap_or_else(|_| "disabled".into()),
        })
    }
}

pub struct Llm {
    cfg: LlmConfig,
    client: reqwest::Client,
    history: Vec<Value>, // {role, content}
}

impl Llm {
    pub fn new(cfg: LlmConfig) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        Self { cfg, client, history: Vec::new() }
    }

    /// 追加 user turn 并流式取回复。delta 经 `tx` 发出;完整回复文本返回并入历史。
    pub async fn chat(&mut self, user_text: &str, tx: mpsc::Sender<String>) -> Result<String> {
        self.history.push(json!({"role": "user", "content": user_text}));
        let mut messages = vec![json!({"role": "system", "content": self.cfg.instructions})];
        messages.extend(self.history.iter().cloned());

        let mut body = json!({
            "model": self.cfg.model,
            "messages": messages,
            "stream": true,
            "temperature": 0.7,
        });
        if matches!(self.cfg.thinking.as_str(), "disabled" | "enabled" | "adaptive") {
            body["thinking"] = json!({"type": self.cfg.thinking});
        }

        let url = format!("{}/chat/completions", self.cfg.base_url.trim_end_matches('/'));
        let t0 = std::time::Instant::now();
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.cfg.api_key)
            .json(&body)
            .send()
            .await
            .context("llm request")?;
        anyhow::ensure!(
            resp.status().is_success(),
            "llm http {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default().chars().take(300).collect::<String>()
        );

        let mut full = String::new();
        let mut ttft_ms: Option<u128> = None;
        let mut n_chunks: u64 = 0;
        let mut stream = resp.bytes_stream();
        let mut pending = String::new();
        'outer: while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("llm sse read")?;
            pending.push_str(&String::from_utf8_lossy(&chunk));
            // SSE 事件以空行分隔;逐个完整事件消费,残段留 pending
            while let Some(pos) = pending.find("\n\n") {
                let event: String = pending.drain(..pos + 2).collect();
                for line in event.lines() {
                    let Some(data) = line.strip_prefix("data:") else { continue };
                    let data = data.trim();
                    if data == "[DONE]" {
                        break 'outer;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                    let delta = &v["choices"][0]["delta"]["content"];
                    if let Some(text) = delta.as_str() {
                        if text.is_empty() {
                            continue;
                        }
                        if ttft_ms.is_none() {
                            ttft_ms = Some(t0.elapsed().as_millis());
                        }
                        n_chunks += 1;
                        full.push_str(text);
                        if tx.send(text.to_string()).await.is_err() {
                            // 下游(切句/TTS)已关=被打断,停拉流
                            warn!("llm consumer gone (interrupted), aborting stream");
                            break 'outer;
                        }
                    }
                }
            }
        }
        info!(
            ttft_ms = ttft_ms.unwrap_or(0) as u64,
            chunks = n_chunks,
            chars = full.chars().count(),
            "llm stream done"
        );
        if !full.is_empty() {
            self.history.push(json!({"role": "assistant", "content": full}));
        } else {
            self.history.pop(); // 空回复:回滚本轮 user,防污染历史
        }
        Ok(full)
    }

    /// 固定句(greeting/say)入历史(对齐 session.say add_to_chat_ctx=True)。
    pub fn push_assistant(&mut self, text: &str) {
        if !text.is_empty() {
            self.history.push(json!({"role": "assistant", "content": text}));
        }
    }

    /// 被打断:历史修正为真实播出的部分(对齐框架 transcript sync 截断语义,句级近似)。
    /// 末条是 assistant → 替换(LLM 流已完整落账);不是 → 追加(流被中断未落账)。
    /// 播出为空 → 移除末条 assistant(什么都没说出口,不留假话)。
    pub fn set_last_assistant(&mut self, actually_spoken: &str) {
        let last_is_assistant =
            self.history.last().map(|m| m["role"] == "assistant").unwrap_or(false);
        if actually_spoken.is_empty() {
            if last_is_assistant {
                self.history.pop();
            }
            return;
        }
        if last_is_assistant {
            if let Some(last) = self.history.last_mut() {
                last["content"] = json!(actually_spoken);
            }
        } else {
            self.history.push(json!({"role": "assistant", "content": actually_spoken}));
        }
    }
}
