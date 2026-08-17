//! OpenAI 兼容流式 LLM 客户端(行为对齐 fast_llm.py 主路:SSE 直发 + DeepSeek
//! `thinking:{"type":"disabled"}` + 句首承接词流式剥除 + 投机(preemptive)支持)。
//! 赛马/兜底(LLM_FALLBACK_*)生产未配,未实现——接入时对齐 _run_race。

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
    /// 剥回复开头承接词(承接音启用时开——承接音已"嗯"过,正文再"嗯"是结巴)。
    pub strip_leading_filler: bool,
    /// 附加到 /chat/completions 后的 query(如 `token=<brain JWT>`,大脑侧据此注入
    /// 该设备的记忆/per-device prompt 配置;空=不附加)。仅主路;灾备裸模不带身份。
    pub url_query: String,
}

impl LlmConfig {
    pub fn from_env() -> Option<Self> {
        let base_url = std::env::var("LLM_BASE_URL").ok()?;
        let filler_on = std::env::var("FILLER_ENABLED").map(|v| v == "1").unwrap_or(true);
        Some(Self {
            base_url,
            api_key: std::env::var("LLM_API_KEY").unwrap_or_else(|_| "sk-noauth".into()),
            model: std::env::var("LLM_MODEL").unwrap_or_else(|_| "deepseek-chat".into()),
            instructions: std::env::var("AGENT_INSTRUCTIONS").unwrap_or_else(|_| {
                // 「不输出舞台指示」是 TTS 语域约束(2026-08-16 川哥实测:「（笑）」「（假装
                // 认真）」被整句念出)。代码层 strip_stage_directions 仍兜底——prompt 只降频。
                "你是一个简洁、自然、可被打断的中文实时语音助手。你的话会被直接转成语音播出，只输出要说的口语本身，绝不要输出括号或星号包裹的动作、表情、神态描述。"
                    .into()
            }),
            thinking: std::env::var("LLM_THINKING").unwrap_or_else(|_| "disabled".into()),
            strip_leading_filler: std::env::var("LLM_STRIP_LEADING_FILLER")
                .map(|v| v == "1")
                .unwrap_or(filler_on),
            url_query: std::env::var("LLM_URL_QUERY").unwrap_or_default(),
        })
    }

    /// 兜底路配置(_run_race 移植,2026-08-17 川哥拍板):LLM_FALLBACK_* 三件套配齐即开、
    /// 缺任一=None 零变化(Python FastLLM 同款开关语义)。instructions/剥承接词继承主路;
    /// thinking 独立(默认 disabled——火山 doubao-seed-2.0-lite 默认开思考,不关则
    /// speakable 首声被 reasoning 拖长,2026-08-17 实测)。
    pub fn fallback_from(
        get: impl Fn(&str) -> Option<String>,
        main: &LlmConfig,
    ) -> Option<LlmConfig> {
        let base_url = get("LLM_FALLBACK_BASE_URL")?;
        let api_key = get("LLM_FALLBACK_API_KEY")?;
        let model = get("LLM_FALLBACK_MODEL")?;
        Some(LlmConfig {
            base_url,
            api_key,
            model,
            instructions: main.instructions.clone(),
            thinking: get("LLM_FALLBACK_THINKING").unwrap_or_else(|| "disabled".into()),
            strip_leading_filler: main.strip_leading_filler,
            // 灾备裸模不带身份 query:兜底只保证「有回应」,不做记忆注入(also 少一处 secret 面)。
            url_query: String::new(),
        })
    }

    pub fn fallback_from_env(main: &LlmConfig) -> Option<LlmConfig> {
        Self::fallback_from(|k| std::env::var(k).ok(), main)
    }

    /// /chat/completions 完整 URL(url_query 非空时附加 ?query——brain 身份走这里)。
    pub fn chat_url(&self) -> String {
        let base = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        if self.url_query.trim().is_empty() {
            base
        } else {
            format!("{}?{}", base, self.url_query.trim())
        }
    }
}

// --- 句首承接词流式剥除(对齐 fast_llm.LeadingFillerStripper R2 v2) --------------

/// 承接词表(长词在前=匹配优先级;嗯/哦 为贪婪 run)。
const FILLER_WORDS: &[&str] = &[
    "让我想一想", "让我想想", "我想想", "这个嘛", "好的", "好嘞", "好呀", "好啊",
];
const FILLER_SINGLE: &[char] = &['哈', '唔', '好', '行'];
const FILLER_RUN: &[char] = &['嗯', '哦'];
const FILLER_PUNCT: &[char] = &[',', '，', '。', '、', '…', '～', '~', '!', '！', '?', '？'];
const FILLER_FIRST_CHARS: &[char] = &['让', '我', '这', '好', '嗯', '哦', '哈', '唔', '行'];
const FILLER_BUF_MAX: usize = 8;

pub struct LeadingFillerStripper {
    buf: Vec<char>,
    passthrough: bool,
    strips: u32,
}

impl LeadingFillerStripper {
    pub fn new() -> Self {
        Self { buf: Vec::new(), passthrough: false, strips: 0 }
    }

    /// 开头匹配「承接词 + \s* + 标点串 + \s*」,返回消费的字符数;标点串可能未取满
    /// (跨 chunk)时返回 Some(len==buf.len()) 由调用方继续缓冲。
    fn match_prefix(buf: &[char]) -> Option<usize> {
        let mut i = 0usize;
        // 词
        let word_len = FILLER_WORDS
            .iter()
            .find(|w| {
                let wc: Vec<char> = w.chars().collect();
                buf.len() >= wc.len() && buf[..wc.len()] == wc[..]
            })
            .map(|w| w.chars().count())
            .or_else(|| {
                // 嗯+/哦+ 贪婪 run
                FILLER_RUN.iter().find(|&&c| buf.first() == Some(&c)).map(|&c| {
                    buf.iter().take_while(|&&x| x == c).count()
                })
            })
            .or_else(|| {
                FILLER_SINGLE.iter().find(|&&c| buf.first() == Some(&c)).map(|_| 1)
            })?;
        i += word_len;
        while i < buf.len() && buf[i].is_whitespace() {
            i += 1;
        }
        let punct_start = i;
        while i < buf.len() && FILLER_PUNCT.contains(&buf[i]) {
            i += 1;
        }
        if i == punct_start {
            // 无标点跟随:词可能只是正文开头("好的开始是成功一半")→ 不剥;
            // 若正好在 buf 尾,调用方按首字集继续缓冲等下一 chunk 的标点
            None
        } else {
            while i < buf.len() && buf[i].is_whitespace() {
                i += 1;
            }
            Some(i)
        }
    }

    pub fn feed(&mut self, chunk: &str) -> String {
        if self.passthrough {
            return chunk.to_string();
        }
        self.buf.extend(chunk.chars());
        while self.strips < 3 {
            match Self::match_prefix(&self.buf) {
                Some(end) if end == self.buf.len() => return String::new(), // 标点串未取满,继续缓冲
                Some(end) => {
                    self.buf.drain(..end);
                    self.strips += 1;
                }
                None => break,
            }
        }
        if self.buf.is_empty() {
            return String::new();
        }
        if !FILLER_FIRST_CHARS.contains(&self.buf[0])
            || self.buf.len() >= FILLER_BUF_MAX
            || self.strips >= 3
        {
            self.passthrough = true;
            return std::mem::take(&mut self.buf).into_iter().collect();
        }
        String::new()
    }

    /// 流结束:吐出未判定缓冲(整回复="好的。"类短句原样保留,结构上不剥空)。
    pub fn flush(&mut self) -> String {
        self.passthrough = true;
        std::mem::take(&mut self.buf).into_iter().collect()
    }
}

// --- 流式调用核心(chat 与投机共用,不碰历史) -----------------------------------

pub struct ChatOutcome {
    pub full: String,
    pub ttft_ms: u64,
    pub duration_ms: u64,
    /// 下游(切句/TTS)提前关闭=被打断,历史交由 set_last_assistant 收尾。
    pub interrupted: bool,
}

impl ChatOutcome {
    /// 字符/秒(诚实口径:SSE chunk≠token,web 面板 tps 位的近似值)。
    pub fn tps(&self) -> f64 {
        if self.duration_ms == 0 {
            return 0.0;
        }
        let chars = self.full.chars().count() as f64;
        (chars * 1000.0 / self.duration_ms as f64 * 10.0).round() / 10.0
    }
}

/// SSE 流式补全:deltas(剥承接词后)经 `tx` 发出,全文返回。**不碰历史**。
pub async fn stream_chat(
    client: &reqwest::Client,
    cfg: &LlmConfig,
    messages: Vec<Value>,
    tx: mpsc::Sender<String>,
) -> Result<ChatOutcome> {
    let mut body = json!({
        "model": cfg.model,
        "messages": messages,
        "stream": true,
        "temperature": 0.7,
    });
    if matches!(cfg.thinking.as_str(), "disabled" | "enabled" | "adaptive") {
        body["thinking"] = json!({"type": cfg.thinking});
    }
    let url = cfg.chat_url();
    let t0 = std::time::Instant::now();
    let resp = client
        .post(&url)
        .bearer_auth(&cfg.api_key)
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

    let mut stripper = cfg.strip_leading_filler.then(LeadingFillerStripper::new);
    let mut full = String::new();
    let mut ttft_ms: Option<u64> = None;
    let mut n_chunks: u64 = 0;
    let mut interrupted = false;
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
                        ttft_ms = Some(t0.elapsed().as_millis() as u64);
                    }
                    n_chunks += 1;
                    let out = match stripper.as_mut() {
                        Some(s) => s.feed(text),
                        None => text.to_string(),
                    };
                    if out.is_empty() {
                        continue;
                    }
                    full.push_str(&out);
                    if tx.send(out).await.is_err() {
                        warn!("llm consumer gone (interrupted), aborting stream");
                        interrupted = true;
                        break 'outer;
                    }
                }
            }
        }
    }
    if !interrupted && let Some(s) = stripper.as_mut() {
        let tail = s.flush();
        if !tail.is_empty() {
            full.push_str(&tail);
            let _ = tx.send(tail).await;
        }
    }
    info!(
        ttft_ms = ttft_ms.unwrap_or(0),
        chunks = n_chunks,
        chars = full.chars().count(),
        "llm stream done"
    );
    Ok(ChatOutcome {
        full,
        ttft_ms: ttft_ms.unwrap_or(0),
        duration_ms: t0.elapsed().as_millis() as u64,
        interrupted,
    })
}

// --- LLM 双路赛马(_run_race 移植,2026-08-17) -----------------------------------

/// 主+兜底并发,**首个产出可见 delta 的流 claim 胜**(败者 abort),全败才抛;
/// 未配兜底=单路零变化。胜者 delta(含首个)转发外层 tx;外层断(下游打断)→
/// drop 胜者 rx → 其 inner send 失败 → stream_chat 按 interrupted 收尾,级联干净。
/// 解 DeepSeek 晚高峰 ttft 抖动(Python 线 1.3-40s 实测),filler 只能盖 ~2s。
pub async fn stream_chat_race(
    main: (&reqwest::Client, &LlmConfig),
    fallback: Option<(&reqwest::Client, &LlmConfig)>,
    messages: Vec<Value>,
    tx: mpsc::Sender<String>,
) -> Result<ChatOutcome> {
    let Some((fb_client, fb_cfg)) = fallback else {
        return stream_chat(main.0, main.1, messages, tx).await;
    };
    // 主路让步窗(2026-08-17 P1 接大脑):兜底先出首 delta 时再等主路至多 grace_ms,
    // 主路窗内出 token 则主路胜。默认 0=公平赛马(裸模互备场景);主路=大脑(带人设
    // 记忆)、兜底=裸模时必须配(否则裸 doubao ~550ms 常胜大脑 ~830ms,人设丢失
    // ——「字节跳动的人工智能」就是这么来的),生产 800ms。
    let grace_ms: u64 = std::env::var("LLM_RACE_MAIN_GRACE_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let t0 = std::time::Instant::now();
    let (m_tx, mut m_rx) = mpsc::channel::<String>(1024);
    let (f_tx, mut f_rx) = mpsc::channel::<String>(1024);
    let m_task = {
        let (c, cfg, msgs) = (main.0.clone(), main.1.clone(), messages.clone());
        tokio::spawn(async move { stream_chat(&c, &cfg, msgs, m_tx).await })
    };
    let f_task = {
        let (c, cfg) = (fb_client.clone(), fb_cfg.clone());
        tokio::spawn(async move { stream_chat(&c, &cfg, messages, f_tx).await })
    };
    // 首个可见 delta 定胜负;一路 rx 关闭(失败/空回复)→ 串行等另一路;双败合并抛
    let (won_by, mut win_rx, win_task, lose_task, first) = tokio::select! {
        m = m_rx.recv() => match m {
            Some(d) => ("main", m_rx, m_task, f_task, d),
            None => match f_rx.recv().await {
                Some(d) => ("fallback", f_rx, f_task, m_task, d),
                None => {
                    let me = m_task.await.map_err(anyhow::Error::from).and_then(|r| r.map(|_| ()));
                    let fe = f_task.await.map_err(anyhow::Error::from).and_then(|r| r.map(|_| ()));
                    anyhow::bail!("llm race 双路全败: main={me:?} fallback={fe:?}");
                }
            },
        },
        f = f_rx.recv() => match f {
            Some(d) => {
                if grace_ms > 0 {
                    // 兜底先出:给主路一个让步窗;窗内主路出 delta → 主路胜(兜底首 delta
                    // 丢弃,兜底 task 随 lose_task.abort 终止);超时/主路流关闭 → 兜底胜
                    match tokio::time::timeout(
                        std::time::Duration::from_millis(grace_ms),
                        m_rx.recv(),
                    )
                    .await
                    {
                        Ok(Some(md)) => {
                            info!(grace_ms, "llm race: main within grace window(兜底让位)");
                            ("main", m_rx, m_task, f_task, md)
                        }
                        _ => ("fallback", f_rx, f_task, m_task, d),
                    }
                } else {
                    ("fallback", f_rx, f_task, m_task, d)
                }
            }
            None => match m_rx.recv().await {
                Some(d) => ("main", m_rx, m_task, f_task, d),
                None => {
                    let me = m_task.await.map_err(anyhow::Error::from).and_then(|r| r.map(|_| ()));
                    let fe = f_task.await.map_err(anyhow::Error::from).and_then(|r| r.map(|_| ()));
                    anyhow::bail!("llm race 双路全败: main={me:?} fallback={fe:?}");
                }
            },
        },
    };
    info!(won_by, race_ttft_ms = t0.elapsed().as_millis() as u64, "llm race won");
    lose_task.abort();
    let mut fwd_broken = false;
    if tx.send(first).await.is_err() {
        fwd_broken = true;
    }
    if !fwd_broken {
        while let Some(d) = win_rx.recv().await {
            if tx.send(d).await.is_err() {
                fwd_broken = true;
                break;
            }
        }
    }
    if fwd_broken {
        drop(win_rx); // 级联:胜者流 inner send 失败 → interrupted 收尾
    }
    match win_task.await {
        Ok(r) => r,
        Err(e) => Err(anyhow::anyhow!("race winner join: {e}")),
    }
}

// --- 带历史的会话客户端 ---------------------------------------------------------

pub struct Llm {
    cfg: LlmConfig,
    client: reqwest::Client,
    /// 赛马兜底路(client+cfg;None=未配,单路零变化)。独立 Client=独立连接池,
    /// 与主路互不抢连接。
    fb: Option<(reqwest::Client, LlmConfig)>,
    history: Vec<Value>, // {role, content}
    version: u64,        // 历史变更计数(投机有效性校验)
    /// 声纹粘滞身份槽(每请求读,注入末尾 system=近因位;None=旁路关闭零变化)。
    speaker_slot: Option<crate::speaker_id::StickySlot>,
}

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("reqwest client")
}

impl Llm {
    pub fn new(cfg: LlmConfig) -> Self {
        let fb = LlmConfig::fallback_from_env(&cfg).map(|f| {
            info!(model = %f.model, "llm race 兜底路已配置");
            (build_client(), f)
        });
        Self { cfg, client: build_client(), fb, history: Vec::new(), version: 0, speaker_slot: None }
    }

    pub fn set_speaker_slot(&mut self, slot: crate::speaker_id::StickySlot) {
        self.speaker_slot = Some(slot);
    }

    pub fn history_version(&self) -> u64 {
        self.version
    }

    /// prewarm 用:job 自己这个 client(连接池随之被预热)+ 配置克隆。
    pub fn prewarm_parts(&self) -> (reqwest::Client, LlmConfig) {
        (self.client.clone(), self.cfg.clone())
    }

    /// 兜底路 prewarm 用(对齐 Python「兜底路同 prewarm」;未配=None)。
    pub fn fallback_prewarm_parts(&self) -> Option<(reqwest::Client, LlmConfig)> {
        self.fb.as_ref().map(|(c, f)| (c.clone(), f.clone()))
    }

    /// 投机用:当前历史 + user 文本的请求快照(client/cfg 克隆,请求不经本对象)。
    pub fn speculation_request(
        &self,
        user_text: &str,
    ) -> (reqwest::Client, LlmConfig, Vec<Value>, u64) {
        (self.client.clone(), self.cfg.clone(), self.build_messages(user_text), self.version)
    }

    fn build_messages(&self, user_text: &str) -> Vec<Value> {
        let mut messages = vec![json!({"role": "system", "content": self.cfg.instructions})];
        messages.extend(self.history.iter().cloned());
        messages.push(json!({"role": "user", "content": user_text}));
        // 声纹身份注入末尾 system=近因位(放前面会被 LLM 无视);每轮身份不变时
        // 投机与正式请求注入内容一致,不破坏投机复用(fast_llm 同款设计)。
        if let Some(slot) = &self.speaker_slot {
            let sticky = slot.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(note) = crate::speaker_id::context_note(&sticky) {
                info!("llm ctx note 注入: {}…", note.chars().take(24).collect::<String>());
                messages.push(json!({"role": "system", "content": note}));
            }
        }
        messages
    }

    /// 追加 user turn 并流式取回复(常规路,走赛马;兜底未配=单路)。
    /// 被打断时历史留给 set_last_assistant。投机(speculation_request)保持主路单发:
    /// 投机 miss 时常规轮的 race 自然兜底,不为预生成双倍烧钱。
    pub async fn chat(&mut self, user_text: &str, tx: mpsc::Sender<String>) -> Result<ChatOutcome> {
        let messages = self.build_messages(user_text);
        self.push_user(user_text);
        let outcome = stream_chat_race(
            (&self.client, &self.cfg),
            self.fb.as_ref().map(|(c, f)| (c, f)),
            messages,
            tx,
        )
        .await?;
        self.settle(&outcome);
        Ok(outcome)
    }

    pub fn push_user(&mut self, text: &str) {
        self.history.push(json!({"role": "user", "content": text}));
        self.version += 1;
    }

    /// 流结束后的历史落账:完整→push assistant;空回复→回滚 user;打断→不动
    /// (真实播出部分由 set_last_assistant 修正)。
    pub fn settle(&mut self, outcome: &ChatOutcome) {
        self.version += 1;
        if outcome.interrupted {
            return;
        }
        if !outcome.full.is_empty() {
            self.history.push(json!({"role": "assistant", "content": outcome.full}));
        } else {
            self.history.pop(); // 空回复:回滚本轮 user,防污染历史
        }
    }

    /// 固定句(greeting/say)入历史(对齐 session.say add_to_chat_ctx=True)。
    pub fn push_assistant(&mut self, text: &str) {
        if !text.is_empty() {
            self.history.push(json!({"role": "assistant", "content": text}));
            self.version += 1;
        }
    }

    /// 被打断:历史修正为真实播出的部分(对齐框架 transcript sync 截断语义,句级近似)。
    /// 末条是 assistant → 替换;不是 → 追加(流被中断未落账);播出为空 → 移除。
    pub fn set_last_assistant(&mut self, actually_spoken: &str) {
        self.version += 1;
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

/// job 开头预热:最小 dummy 请求建 TLS 连接(对齐 fast_llm.prewarm_openai,
/// 藏进「用户说首句+判停」窗口,首句请求复用暖连接)。静默失败。
pub async fn prewarm(cfg: LlmConfig, client: reqwest::Client) {
    let url = cfg.chat_url();
    let mut body = json!({
        "model": cfg.model,
        "messages": [{"role": "user", "content": "hi"}],
        "stream": true,
        "max_tokens": 8,
    });
    if matches!(cfg.thinking.as_str(), "disabled" | "enabled" | "adaptive") {
        body["thinking"] = json!({"type": cfg.thinking});
    }
    let t0 = std::time::Instant::now();
    match client.post(&url).bearer_auth(&cfg.api_key).json(&body).send().await {
        Ok(resp) => {
            let mut stream = resp.bytes_stream();
            let _ = stream.next().await; // 首 chunk=连接已建,够了
            info!(ms = t0.elapsed().as_millis() as u64, "llm prewarm done");
        }
        Err(e) => info!(error = %e, "llm prewarm failed(首句现场建连,不影响可用)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(s: &mut LeadingFillerStripper, chunks: &[&str]) -> String {
        let mut out = String::new();
        for c in chunks {
            out.push_str(&s.feed(c));
        }
        out.push_str(&s.flush());
        out
    }

    fn main_cfg() -> LlmConfig {
        LlmConfig {
            base_url: "https://main.example/v1".into(),
            api_key: "k1".into(),
            model: "deepseek-v4-flash".into(),
            instructions: "指令A".into(),
            thinking: "disabled".into(),
            strip_leading_filler: true,
            url_query: String::new(),
        }
    }

    #[test]
    fn chat_url_appends_query_only_when_set() {
        let mut c = main_cfg();
        assert_eq!(c.chat_url(), "https://main.example/v1/chat/completions");
        c.url_query = "token=abc.def.ghi".into();
        assert_eq!(c.chat_url(), "https://main.example/v1/chat/completions?token=abc.def.ghi");
        // 尾斜杠/空白 query 归一
        c.base_url = "https://main.example/v1/".into();
        c.url_query = "  ".into();
        assert_eq!(c.chat_url(), "https://main.example/v1/chat/completions");
    }

    #[test]
    fn fallback_never_inherits_url_query() {
        let mut m = main_cfg();
        m.url_query = "token=secret".into();
        let f = LlmConfig::fallback_from(
            |k| match k {
                "LLM_FALLBACK_BASE_URL" => Some("https://fb.example/v1".into()),
                "LLM_FALLBACK_API_KEY" => Some("k2".into()),
                "LLM_FALLBACK_MODEL" => Some("doubao".into()),
                _ => None,
            },
            &m,
        )
        .unwrap();
        assert!(f.url_query.is_empty(), "灾备不得继承身份 query");
    }

    #[test]
    fn fallback_cfg_requires_all_three_and_inherits() {
        let m = main_cfg();
        let full = |k: &str| match k {
            "LLM_FALLBACK_BASE_URL" => Some("https://ark.example/api/coding/v3".to_string()),
            "LLM_FALLBACK_API_KEY" => Some("k2".to_string()),
            "LLM_FALLBACK_MODEL" => Some("doubao-seed-2.0-lite".to_string()),
            _ => None,
        };
        let f = LlmConfig::fallback_from(full, &m).expect("三件套齐=开");
        assert_eq!(f.model, "doubao-seed-2.0-lite");
        assert_eq!(f.instructions, "指令A"); // 继承主路
        assert!(f.strip_leading_filler);
        assert_eq!(f.thinking, "disabled"); // 默认关思考(doubao 默认开,不关拖 speakable)
        // 缺任一件=None(不开赛马,零变化)
        let missing = |k: &str| match k {
            "LLM_FALLBACK_BASE_URL" => Some("x".to_string()),
            "LLM_FALLBACK_API_KEY" => Some("y".to_string()),
            _ => None, // 缺 MODEL
        };
        assert!(LlmConfig::fallback_from(missing, &m).is_none());
        // THINKING 可覆盖
        let with_think = |k: &str| match k {
            "LLM_FALLBACK_BASE_URL" => Some("x".to_string()),
            "LLM_FALLBACK_API_KEY" => Some("y".to_string()),
            "LLM_FALLBACK_MODEL" => Some("z".to_string()),
            "LLM_FALLBACK_THINKING" => Some("off".to_string()),
            _ => None,
        };
        assert_eq!(LlmConfig::fallback_from(with_think, &m).unwrap().thinking, "off");
    }

    #[test]
    fn strips_leading_filler_word_with_punct() {
        let mut s = LeadingFillerStripper::new();
        assert_eq!(feed_all(&mut s, &["嗯，今天天气不错"]), "今天天气不错");
        let mut s = LeadingFillerStripper::new();
        assert_eq!(feed_all(&mut s, &["好的。", "开始吧"]), "开始吧");
        // 多层剥除
        let mut s = LeadingFillerStripper::new();
        assert_eq!(feed_all(&mut s, &["嗯，好的，其实是这样"]), "其实是这样");
    }

    #[test]
    fn keeps_word_without_punct() {
        // "好的开始是成功的一半":好的后面不是标点 → 不剥
        let mut s = LeadingFillerStripper::new();
        assert_eq!(feed_all(&mut s, &["好的开始是成功的一半"]), "好的开始是成功的一半");
    }

    #[test]
    fn whole_reply_is_filler_kept_via_flush() {
        let mut s = LeadingFillerStripper::new();
        assert_eq!(feed_all(&mut s, &["好的。"]), "好的。");
    }

    #[test]
    fn cross_chunk_word_and_punct() {
        let mut s = LeadingFillerStripper::new();
        assert_eq!(feed_all(&mut s, &["让我想", "想，", "答案是三"]), "答案是三");
    }

    #[test]
    fn non_filler_first_char_passthrough_immediately() {
        let mut s = LeadingFillerStripper::new();
        assert_eq!(s.feed("今天讲个故事"), "今天讲个故事");
    }

    #[test]
    fn history_settle_paths() {
        // Llm::new 建 reqwest Client,rustls-no-provider 下须先装 provider(main 同款)
        let _ = rustls::crypto::ring::default_provider().install_default();
        let cfg = LlmConfig {
            base_url: "http://x".into(),
            api_key: "k".into(),
            model: "m".into(),
            instructions: "i".into(),
            thinking: "off".into(),
            strip_leading_filler: false,
            url_query: String::new(),
        };
        let mut llm = Llm::new(cfg);
        llm.push_user("你好");
        llm.settle(&ChatOutcome { full: "答".into(), ttft_ms: 1, duration_ms: 1, interrupted: false });
        assert_eq!(llm.history.len(), 2);
        // 打断:不动,由 set_last_assistant 修正
        llm.push_user("再问");
        let v = llm.history_version();
        llm.settle(&ChatOutcome { full: "半截".into(), ttft_ms: 1, duration_ms: 1, interrupted: true });
        assert_eq!(llm.history.len(), 3);
        assert!(llm.history_version() > v);
        llm.set_last_assistant("半");
        assert_eq!(llm.history.len(), 4);
        assert_eq!(llm.history[3]["content"], "半");
        // 空回复回滚 user
        llm.push_user("第三问");
        llm.settle(&ChatOutcome { full: String::new(), ttft_ms: 0, duration_ms: 0, interrupted: false });
        assert_eq!(llm.history.len(), 4);
    }
}
