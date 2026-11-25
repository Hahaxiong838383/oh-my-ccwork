//! OpenAI 兼容流式 LLM 客户端(行为对齐 fast_llm.py 主路:SSE 直发 + DeepSeek
//! `thinking:{"type":"disabled"}` + 句首承接词流式剥除 + 投机(preemptive)支持)。
//! Worker 外层按故障/首正文超时启动一次有界灾备，Brain 内部赛马独立。

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
    /// 当前 job 的房间名(sn-<SN>-<ts>),随 query 传给大脑做 per-device 身份路由
    /// (多设备防串号:大脑按 room 里的 SN 反查各自 brain 账号)。job 级赋值,进程级为空。
    pub room: String,
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
            room: String::new(),
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
        if get("LLM_FALLBACK_ENABLED").as_deref() != Some("1") { return None; }
        let base_url = get("LLM_FALLBACK_BASE_URL")?;
        let api_key = get("LLM_FALLBACK_API_KEY")?;
        let model = get("LLM_FALLBACK_MODEL")?;
        if [&base_url, &api_key, &model].iter().any(|v| v.trim().is_empty()) { return None; }
        Some(LlmConfig {
            base_url,
            api_key,
            model,
            instructions: main.instructions.clone(),
            thinking: get("LLM_FALLBACK_THINKING").unwrap_or_else(|| "disabled".into()),
            strip_leading_filler: main.strip_leading_filler,
            // 灾备裸模不带身份 query/room:兜底只保证「有回应」,不做记忆注入(also 少一处 secret 面)。
            url_query: String::new(),
            room: String::new(),
        })
    }

    pub fn fallback_from_env(main: &LlmConfig) -> Option<LlmConfig> {
        Self::fallback_from(|k| std::env::var(k).ok(), main)
    }

    /// /chat/completions 完整 URL(query = url_query + room 合并;都空则无 ?)。
    /// room 名 sn-<SN>-<unix> 仅含 [A-Za-z0-9-],无需 URL 编码;防御性过滤非常规字符。
    pub fn chat_url(&self) -> String {
        let base = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let mut parts: Vec<String> = Vec::new();
        if !self.url_query.trim().is_empty() {
            parts.push(self.url_query.trim().to_string());
        }
        let room_safe: String = self
            .room
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !room_safe.is_empty() {
            parts.push(format!("room={}", room_safe));
        }
        if parts.is_empty() {
            base
        } else {
            format!("{}?{}", base, parts.join("&"))
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

// --- LLM 设备意图标记剥离(Phase 2a 观察模式,2026-08-20) --------------------------

const DEV_HEAD: &str = "[[DEV:";
/// "[[DEV: 12345 ]]" 远短于此;超长=非法,整段放行防吞正文
const DEV_BUF_MAX: usize = 24;

/// 剥 `[[DEV:N]]` 标记(N=semantic label,冒号后容忍空格):标记绝不进 TTS/字幕/历史,
/// label 收集给 pipeline 观察打点。**剥离无条件**(worker 侧零开关):server 端 prompt
/// 未注入协议时 LLM 不输出标记、本剥离器零行为;注入后若放行标记=TTS 念给孩子听,
/// 故安全端必须在剥离侧。观察模式只记日志不执行——LLM→DEVICE commit 被 codex 标记
/// BLOCKED_PENDING_VAD_CANDIDATE_ID(CODEX_P003_ANDROID_VAD_FALLBACK_REPLY_20260819 §5),
/// 关联合同落地前禁止提交执行。格式错(未闭合/夹杂非数字)整段放行:宁念错半个标记
/// 也不误吞正文,格式错误率本身是观察指标(prompt 迭代依据)。
pub struct DevMarkStripper {
    buf: String,
    pub labels: Vec<u32>,
}

impl DevMarkStripper {
    pub fn new() -> Self {
        Self { buf: String::new(), labels: Vec::new() }
    }

    /// buf 是否仍可能长成合法标记("[[DEV:" 前缀形态,主体仅 空格/数字/']')
    fn viable(buf: &str) -> bool {
        if buf.len() < DEV_HEAD.len() {
            return DEV_HEAD.starts_with(buf);
        }
        buf.starts_with(DEV_HEAD)
            && buf.len() <= DEV_BUF_MAX
            && buf[DEV_HEAD.len()..].chars().all(|c| c.is_ascii_digit() || c == ' ' || c == ']')
    }

    /// 完整标记 "[[DEV:<sp*>digits<sp*>]]" → label
    fn complete(buf: &str) -> Option<u32> {
        let inner = buf.strip_prefix(DEV_HEAD)?.strip_suffix("]]")?.trim();
        if inner.is_empty() || !inner.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        inner.parse().ok()
    }

    pub fn feed(&mut self, chunk: &str) -> String {
        let mut out = String::new();
        for c in chunk.chars() {
            if self.buf.is_empty() {
                if c == '[' {
                    self.buf.push(c);
                } else {
                    out.push(c);
                }
                continue;
            }
            self.buf.push(c);
            if let Some(label) = Self::complete(&self.buf) {
                self.labels.push(label);
                self.buf.clear();
            } else if !Self::viable(&self.buf) {
                out.push_str(&self.buf);
                self.buf.clear();
            }
        }
        out
    }

    /// 流结束:未闭合疑似段原样放行(宁念不吞)。
    pub fn flush(&mut self) -> String {
        std::mem::take(&mut self.buf)
    }
}

// --- 流式调用核心(chat 与投机共用,不碰历史) -----------------------------------

/// 带内控制 token 分隔符(私有区码点,LLM 正文不会产出)。形态 `\u{E000}DEV:<label>\u{E000}`。
pub const DEV_INBAND_SEP: char = '\u{E000}';

pub fn dev_inband(label: u32) -> String {
    format!("{DEV_INBAND_SEP}DEV:{label}{DEV_INBAND_SEP}")
}

/// 消费方:把 delta 里的带内 token 剥出来(labels 按出现顺序),余下正文原样返回。
/// 非法/未闭合的 token 段原样放行(宁念不吞,与 DevMarkStripper 同口径)。
pub fn split_dev_inband(delta: &str) -> (Vec<u32>, String) {
    if !delta.contains(DEV_INBAND_SEP) {
        return (Vec::new(), delta.to_string());
    }
    let mut labels = Vec::new();
    let mut text = String::new();
    let mut rest = delta;
    while let Some(i) = rest.find(DEV_INBAND_SEP) {
        text.push_str(&rest[..i]);
        let after = &rest[i + DEV_INBAND_SEP.len_utf8()..];
        match after.find(DEV_INBAND_SEP) {
            Some(j) => {
                let body = &after[..j];
                match body.strip_prefix("DEV:").and_then(|d| d.parse::<u32>().ok()) {
                    Some(l) => labels.push(l),
                    None => text.push_str(&rest[i..i + DEV_INBAND_SEP.len_utf8() + j + DEV_INBAND_SEP.len_utf8()]),
                }
                rest = &after[j + DEV_INBAND_SEP.len_utf8()..];
            }
            None => {
                text.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    text.push_str(rest);
    (labels, text)
}

pub struct ChatOutcome {
    pub full: String,
    pub ttft_ms: u64,
    pub duration_ms: u64,
    /// 下游(切句/TTS)提前关闭=被打断,历史交由 set_last_assistant 收尾。
    pub interrupted: bool,
    /// Phase 2a 观察:本轮 LLM 输出中剥出的 [[DEV:N]] 标记(已从 full/流中移除)。
    pub dev_labels: Vec<u32>,
    pub personal: Option<crate::personal::Metadata>,
    pub done: bool,
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
pub async fn stream_chat(client:&reqwest::Client,cfg:&LlmConfig,messages:Vec<Value>,tx:mpsc::Sender<String>)->Result<ChatOutcome>{
    stream_chat_with_context(client,cfg,messages,tx,None).await
}
pub async fn stream_chat_with_context(
    client: &reqwest::Client,
    cfg: &LlmConfig,
    messages: Vec<Value>,
    tx: mpsc::Sender<String>,
    search_context: Option<Value>,
) -> Result<ChatOutcome> {
    stream_chat_inner(client, cfg, messages, tx, search_context, None).await
}

pub async fn stream_personal_text(
    client: &reqwest::Client, cfg: &LlmConfig, messages: Vec<Value>,
    tx: mpsc::Sender<String>, store: bool,
) -> Result<ChatOutcome> {
    stream_chat_inner(client, cfg, messages, tx, None, Some(store)).await
}

async fn stream_chat_inner(
    client: &reqwest::Client, cfg: &LlmConfig, messages: Vec<Value>,
    tx: mpsc::Sender<String>, search_context: Option<Value>, store: Option<bool>,
) -> Result<ChatOutcome> {
    if !crate::personal::llm_request_allowed(cfg) {
        anyhow::bail!("personal_llm_route_rejected");
    }
    let personal = store.is_some() || crate::personal::voice_brain(cfg);
    let mut body = json!({
        "model": cfg.model,
        "messages": messages,
        "stream": true,
        "temperature": 0.7,
    });
    if let Some(store) = store { body["store"] = json!(store); }
    if let Some(context)=search_context {body["search_dialogue_context"]=context;}
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
    if !resp.status().is_success() {
        let status = resp.status();
        if std::env::var("AGENT_NAME").ok().as_deref() == Some(crate::personal::AGENT) {
            anyhow::bail!("llm http {status}");
        }
        anyhow::bail!(
            "llm http {}: {}",
            status,
            resp.text().await.unwrap_or_default().chars().take(300).collect::<String>()
        );
    }

    let mut stripper = cfg.strip_leading_filler.then(LeadingFillerStripper::new);
    let mut dev = DevMarkStripper::new(); // Phase 2a:无条件剥 [[DEV:N]],标记绝不进流/历史
    // 2b(2026-09-03 M1 实证修):标记在回复最开头就解析出来了,却等整段回复合成完才派发→动作晚 3.3s。
    // 解析到即用带内控制 token 经 tx 推给消费方(赛马/投机转发的是同一条 delta 流,赢家的标记天然跟着赢家走);
    // token 不进 full(历史),消费方 split_dev_inband 剥掉后才进切句/TTS。
    let mut dev_sent = 0usize;
    let mut full = String::new();
    let mut ttft_ms: Option<u64> = None;
    let mut n_chunks: u64 = 0;
    let mut interrupted = false;
    let mut stream = resp.bytes_stream();
    let mut pending = Vec::new();
    let mut final_metadata = None;
    let mut done = false;
    'outer: while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("llm sse read")?;
        if personal {
            pending.extend_from_slice(&chunk);
            anyhow::ensure!(pending.len() <= 1_048_576, "personal SSE event too large");
        } else {
            pending.extend_from_slice(String::from_utf8_lossy(&chunk).as_bytes());
        }
        // Wait for a complete event before decoding personal UTF-8. A network
        // chunk can end in the middle of a Chinese character or a source title.
        while let Some(pos) = pending.windows(2).position(|pair| pair == b"\n\n") {
            let event: Vec<u8> = pending.drain(..pos + 2).collect();
            let event = String::from_utf8_lossy(&event);
            for line in event.lines() {
                let Some(data) = line.strip_prefix("data:") else { continue };
                let data = data.trim();
                if data == "[DONE]" {
                    done = true;
                    break 'outer;
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                if personal {
                    anyhow::ensure!(v.get("error").is_none(), "personal brain SSE failed");
                    if v["choices"][0]["finish_reason"] == "stop" {
                        final_metadata = crate::personal::Metadata::from_final(&v);
                    }
                }
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
                    let out = dev.feed(&out);
                    while dev_sent < dev.labels.len() {
                        let tok = dev_inband(dev.labels[dev_sent]);
                        dev_sent += 1;
                        if tx.send(tok).await.is_err() {
                            warn!("llm consumer gone (interrupted), aborting stream");
                            interrupted = true;
                            break 'outer;
                        }
                    }
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
    if !interrupted {
        let mut tail = match stripper.as_mut() {
            Some(s) => dev.feed(&s.flush()),
            None => String::new(),
        };
        tail.push_str(&dev.flush()); // dev 自己的未闭合疑似段:宁念不吞
        while dev_sent < dev.labels.len() {
            let _ = tx.send(dev_inband(dev.labels[dev_sent])).await;
            dev_sent += 1;
        }
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
        dev_labels: dev.labels,
        personal: if done && !interrupted { final_metadata } else { None },
        done,
    })
}

// --- Worker 外层有界灾备：首正文之前最多启动一次备用 -------------------------
#[derive(Clone, Copy)]
struct FallbackPolicy { trigger_ms: u64, deadline_ms: u64 }
impl FallbackPolicy {
    fn from_env() -> Self {
        let read=|key: &str| std::env::var(key).ok().and_then(|v| v.parse::<u64>().ok());
        let trigger_ms=read("LLM_FALLBACK_TRIGGER_MS").filter(|v| (500..=5000).contains(v)).unwrap_or(2000);
        let deadline_ms=read("LLM_FALLBACK_DEADLINE_MS").filter(|v| *v>=trigger_ms+2000 && *v<=15000).unwrap_or((trigger_ms+2000).max(6000));
        Self{trigger_ms,deadline_ms}
    }
}
// Dropping an outer future (barge-in/job close) must abort every owned HTTP task.
struct OwnedChat(tokio::task::JoinHandle<Result<ChatOutcome>>);
impl Drop for OwnedChat { fn drop(&mut self) { self.0.abort(); } }

async fn visible_delta(rx: &mut mpsc::Receiver<String>, prefix: &mut String) -> Option<String> {
    while let Some(d)=rx.recv().await {
        let (_,spoken)=split_dev_inband(&d);
        prefix.push_str(&d);
        if !spoken.trim().is_empty() { return Some(std::mem::take(prefix)); }
        // Control-only / whitespace streams cannot win or grow memory without bound.
        if prefix.len()>4096 { return None; }
    }
    None
}

pub async fn stream_chat_race(
    main: (&reqwest::Client, &LlmConfig),
    fallback: Option<(&reqwest::Client, &LlmConfig)>,
    messages: Vec<Value>, tx: mpsc::Sender<String>, search_context: Option<Value>,
) -> Result<ChatOutcome> {
    stream_chat_bounded(main,fallback,messages,tx,search_context,FallbackPolicy::from_env()).await
}

async fn stream_chat_bounded(
    main: (&reqwest::Client, &LlmConfig),
    fallback: Option<(&reqwest::Client, &LlmConfig)>,
    messages: Vec<Value>, tx: mpsc::Sender<String>, search_context: Option<Value>,
    policy: FallbackPolicy,
) -> Result<ChatOutcome> {
    let Some((fc,fcfg))=fallback else {
        return tokio::select! {
            biased;
            _=tx.closed()=>anyhow::bail!("llm cancelled"),
            r=stream_chat_with_context(main.0,main.1,messages,tx.clone(),search_context)=>r,
        };
    };
    anyhow::ensure!(!tx.is_closed(),"llm cancelled");
    let start=tokio::time::Instant::now();
    let trigger=start+std::time::Duration::from_millis(policy.trigger_ms);
    let deadline=start+std::time::Duration::from_millis(policy.deadline_ms);
    let (mt,mut mr)=mpsc::channel(128); let (ft,mut fr)=mpsc::channel(128);
    let (c,cfg,msgs)=(main.0.clone(),main.1.clone(),messages.clone());
    let mut mt=OwnedChat(tokio::spawn(async move {stream_chat_with_context(&c,&cfg,msgs,mt,search_context).await}));
    let mut mp=String::new();let mut fp=String::new();
    let mut main_open=true;
    let first_main=tokio::select! {
        biased;
        _=tx.closed()=>anyhow::bail!("llm cancelled"),
        _=tokio::time::sleep_until(deadline)=>anyhow::bail!("llm first content deadline"),
        d=visible_delta(&mut mr,&mut mp)=>{ if d.is_none(){main_open=false;} d },
        _=tokio::time::sleep_until(trigger)=>None,
    };
    let mut fb_task=None;
    let (won_by,first)=if let Some(d)=first_main { ("main",d) } else {
        anyhow::ensure!(!tx.is_closed(),"llm cancelled");
        info!(reason=if main_open {"first_content_timeout"} else {"main_failed_or_empty"}, trigger_ms=policy.trigger_ms, deadline_ms=policy.deadline_ms, "llm disaster started");
        if !main_open {mt.0.abort();}
        let (c,cfg)=(fc.clone(),fcfg.clone());
        fb_task=Some(OwnedChat(tokio::spawn(async move {stream_chat(&c,&cfg,messages,ft).await})));
        let mut fb_open=true;
        loop {
            anyhow::ensure!(main_open || fb_open,"llm disaster both failed or empty");
            tokio::select! {
                biased;
                _=tx.closed()=>anyhow::bail!("llm cancelled"),
                _=tokio::time::sleep_until(deadline)=>anyhow::bail!("llm first content deadline"),
                d=visible_delta(&mut mr,&mut mp), if main_open=>match d {Some(d)=>break ("main",d),None=>{main_open=false;mt.0.abort();}},
                d=visible_delta(&mut fr,&mut fp), if fb_open=>match d {Some(d)=>break ("fallback",d),None=>{fb_open=false;if let Some(t)=&fb_task{t.0.abort();}}},
            }
        }
    };
    let fallback_started=fb_task.is_some();
    info!(won_by,race_ttft_ms=start.elapsed().as_millis() as u64,fallback_started,mode="bounded", "llm race won");
    let (rx,task)=if won_by=="main" {
        if let Some(t)=fb_task.as_ref(){t.0.abort();}
        (&mut mr,&mut mt)
    } else {
        mt.0.abort(); (&mut fr,fb_task.as_mut().expect("started fallback"))
    };
    // Winner is fixed once text is emitted. Never splice an alternate reply mid-sentence.
    tx.send(first).await.context("llm consumer closed")?;
    loop {
        let d=tokio::select! {biased; _=tx.closed()=>anyhow::bail!("llm cancelled"), d=rx.recv()=>d};
        let Some(d)=d else {break};
        tx.send(d).await.context("llm consumer closed")?;
    }
    (&mut task.0).await.context("llm winner task")?
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

pub const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(if std::env::var("AGENT_NAME").is_ok_and(|v|crate::search_canary::is_candidate(&v)) { reqwest::redirect::Policy::none() } else { reqwest::redirect::Policy::default() })
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(REQUEST_TIMEOUT)
        .build()
        .expect("reqwest client")
}

impl Llm {
    pub fn new(cfg: LlmConfig) -> Self {
        // 个人 Worker 不持有、不发送大模型灾备厂商凭据。P003 仍按原环境变量决定。
        let personal = std::env::var("AGENT_NAME").ok().as_deref() == Some(crate::personal::AGENT);
        let fb = if personal { None } else { LlmConfig::fallback_from_env(&cfg).map(|f| {
            info!(model = %f.model, "llm bounded disaster configured");
            (build_client(), f)
        }) };
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
    pub async fn chat(&mut self, user_text: &str, tx: mpsc::Sender<String>) -> Result<ChatOutcome> {self.chat_with_context(user_text,tx,None).await}
    pub async fn chat_with_context(&mut self,user_text:&str,tx:mpsc::Sender<String>,search_context:Option<Value>)->Result<ChatOutcome> {
        let messages = self.build_messages(user_text);
        self.push_user(user_text);
        let outcome = stream_chat_race(
            (&self.client, &self.cfg),
            self.fb.as_ref().map(|(c, f)| (c, f)),
            messages,
            tx,
            search_context,
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

    /// A split ASR suffix explicitly transferred the immediately preceding public question.
    /// Remove only that trailing pair; web evidence and task outcomes stay outside chat memory.
    pub fn transfer_last_question_to_search(&mut self, question: &str) -> bool {
        let normalize = |s: &str| s.trim().trim_end_matches(|c: char| "。！!？?，,.；; ".contains(c)).to_owned();
        let question=normalize(question);
        if question.is_empty() { return false; }
        let Some(index)=self.history.iter().rposition(|m|m["role"]=="user") else { return false; };
        if normalize(self.history[index]["content"].as_str().unwrap_or(""))!=question
            || self.history[index+1..].iter().any(|m|m["role"]!="assistant") { return false; }
        self.history.truncate(index); self.version+=1; true
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

/// 本地音频回声对撞库拉取(2026-09-01):按会话向大脑侧拉该设备本地音频文案。
/// 端点=/internal/local-audio-texts,鉴权与 chat 同款(url_query 的 brain 通行证+room 路由),
/// server 返回该 SN 全部历史文案(revision 交界缝已在 server 侧焊住)。
/// fail-open:任何失败返回 None(没有对撞库=回到现状,绝不影响主链路)。3s 超时。
pub async fn fetch_local_audio_texts(cfg: &LlmConfig, room: &str) -> Option<Vec<(String, String)>> {
    let base = cfg.base_url.trim_end_matches('/');
    let mut url = format!("{base}/internal/local-audio-texts");
    let mut parts: Vec<String> = Vec::new();
    if !cfg.url_query.trim().is_empty() {
        parts.push(cfg.url_query.trim().to_string());
    }
    parts.push(format!("room={room}"));
    url.push('?');
    url.push_str(&parts.join("&"));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?;
    let resp = client.get(&url).bearer_auth(&cfg.api_key).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: Value = resp.json().await.ok()?;
    let texts = v.get("texts")?.as_array()?;
    Some(
        texts
            .iter()
            .filter_map(|t| {
                Some((
                    t.get("slot")?.as_str()?.to_string(),
                    t.get("text")?.as_str()?.to_string(),
                ))
            })
            .collect(),
    )
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

    fn dev_all(chunks: &[&str]) -> (String, Vec<u32>) {
        let mut d = DevMarkStripper::new();
        let mut out = String::new();
        for c in chunks {
            out.push_str(&d.feed(c));
        }
        out.push_str(&d.flush());
        (out, d.labels)
    }

    #[test]
    fn dev_mark_strip_table() {
        // 整标记单 chunk:剥净+收 label
        assert_eq!(dev_all(&["[[DEV:22]]好呀，给你换暖光"]), ("好呀，给你换暖光".into(), vec![22]));
        // 跨 chunk 切分
        assert_eq!(dev_all(&["你好[[DE", "V: 35 ]]啦"]), ("你好啦".into(), vec![35]));
        // 多标记
        assert_eq!(dev_all(&["[[DEV:2]]开灯[[DEV:37]]再大声"]), ("开灯再大声".into(), vec![2, 37]));
        // 正文方括号不受伤
        assert_eq!(dev_all(&["列表[[1]]和[[2]]"]), ("列表[[1]]和[[2]]".into(), vec![]));
        // 格式错(非数字/未闭合):整段放行,宁念不吞
        assert_eq!(dev_all(&["[[DEV:abc]]文"]), ("[[DEV:abc]]文".into(), vec![]));
        assert_eq!(dev_all(&["尾部残段[[DEV:9"]), ("尾部残段[[DEV:9".into(), vec![]));
        // 无标记直通
        assert_eq!(dev_all(&["今天天气不错。"]), ("今天天气不错。".into(), vec![]));
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
            room: String::new(),
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
    fn chat_url_merges_room_and_filters_unsafe_chars() {
        let mut c = main_cfg();
        c.url_query = "token=t1".into();
        c.room = "sn-BJP00326060100200003-1786980000".into();
        assert_eq!(
            c.chat_url(),
            "https://main.example/v1/chat/completions?token=t1&room=sn-BJP00326060100200003-1786980000"
        );
        // 仅 room 无 token 也成立
        c.url_query = String::new();
        assert_eq!(
            c.chat_url(),
            "https://main.example/v1/chat/completions?room=sn-BJP00326060100200003-1786980000"
        );
        // 非常规字符被过滤(防 query 注入)
        c.room = "evil&room=x?y#z".into();
        assert_eq!(c.chat_url(), "https://main.example/v1/chat/completions?room=evilroomxyz");
    }

    #[test]
    fn fallback_never_inherits_url_query() {
        let mut m = main_cfg();
        m.url_query = "token=secret".into();
        let f = LlmConfig::fallback_from(
            |k| match k {
                "LLM_FALLBACK_ENABLED" => Some("1".into()),
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
                "LLM_FALLBACK_ENABLED" => Some("1".into()),
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
                "LLM_FALLBACK_ENABLED" => Some("1".into()),
            "LLM_FALLBACK_BASE_URL" => Some("x".to_string()),
            "LLM_FALLBACK_API_KEY" => Some("y".to_string()),
            _ => None, // 缺 MODEL
        };
        assert!(LlmConfig::fallback_from(missing, &m).is_none());
        // THINKING 可覆盖
        let with_think = |k: &str| match k {
                "LLM_FALLBACK_ENABLED" => Some("1".into()),
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
            room: String::new(),
        };
        let mut llm = Llm::new(cfg);
        llm.push_user("你好");
        llm.settle(&ChatOutcome { full: "答".into(), ttft_ms: 1, duration_ms: 1, interrupted: false, dev_labels: vec![], personal: None, done: true });
        assert_eq!(llm.history.len(), 2);
        // 打断:不动,由 set_last_assistant 修正
        llm.push_user("再问");
        let v = llm.history_version();
        llm.settle(&ChatOutcome { full: "半截".into(), ttft_ms: 1, duration_ms: 1, interrupted: true, dev_labels: vec![], personal: None, done: true });
        assert_eq!(llm.history.len(), 3);
        assert!(llm.history_version() > v);
        llm.set_last_assistant("半");
        assert_eq!(llm.history.len(), 4);
        assert_eq!(llm.history[3]["content"], "半");
        // 空回复回滚 user
        llm.push_user("第三问");
        llm.settle(&ChatOutcome { full: String::new(), ttft_ms: 0, duration_ms: 0, interrupted: false, dev_labels: vec![], personal: None, done: true });
        assert_eq!(llm.history.len(), 4);
    }
    #[test]
    fn search_handoff_removes_only_the_exact_trailing_question_and_reply() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let cfg = LlmConfig { base_url:"http://x".into(),api_key:"k".into(),model:"m".into(),instructions:"i".into(),thinking:"off".into(),strip_leading_filler:false,url_query:String::new(),room:String::new() };
        for spoken in ["", "故宫通常", "完整回复"] {
            let mut llm=Llm::new(cfg.clone());
            llm.push_user("我喜欢小猫"); llm.push_assistant("小猫很可爱");
            let preserved=llm.history.clone();
            llm.push_user("故宫明天开放吗？"); llm.push_assistant("还在生成的回复");
            llm.set_last_assistant(spoken);
            let version=llm.history_version();
            assert!(llm.transfer_last_question_to_search("故宫明天开放吗"));
            assert_eq!(llm.history,preserved,"spoken={spoken}");
            assert!(llm.history_version()>version);
            assert!(!llm.transfer_last_question_to_search("故宫明天开放吗"));
            let messages=llm.build_messages("烤箱的温度怎么调");
            assert!(!messages.iter().any(|m|m["content"].as_str().unwrap_or("").contains("故宫")));
        }
        let mut llm=Llm::new(cfg);
        llm.push_user("故宫明天开放吗"); llm.push_assistant("旧的完整回答");
        llm.push_user("我喜欢小猫");
        let before=llm.history.clone();let version=llm.history_version();
        assert!(!llm.transfer_last_question_to_search("故宫明天开放吗"));
        assert_eq!(llm.history,before);assert_eq!(llm.history_version(),version);
        assert!(!llm.transfer_last_question_to_search(""));
    }

}

#[cfg(test)]
mod dev_inband_tests {
    use super::*;

    #[test]
    fn inband_roundtrip_and_text_untouched() {
        let d = format!("{}你好{}世界", dev_inband(6), dev_inband(12));
        let (labels, text) = split_dev_inband(&d);
        assert_eq!(labels, vec![6, 12]);
        assert_eq!(text, "你好世界");
        assert_eq!(split_dev_inband("没有标记的普通正文"), (vec![], "没有标记的普通正文".to_string()));
    }

    #[test]
    fn malformed_or_unclosed_passes_through() {
        let bad = format!("{}DEV:x{}尾", DEV_INBAND_SEP, DEV_INBAND_SEP);
        let (labels, text) = split_dev_inband(&bad);
        assert!(labels.is_empty());
        assert_eq!(text, bad);
        let open = format!("正文{}DEV:6", DEV_INBAND_SEP);
        assert_eq!(split_dev_inband(&open), (vec![], open.clone()));
    }
}

#[cfg(test)]
mod disaster_tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener, time::{sleep, Duration}};
    struct Endpoint { url: String, calls: Arc<AtomicUsize>, task: tokio::task::JoinHandle<()> }
    impl Drop for Endpoint { fn drop(&mut self) { self.task.abort(); } }
    async fn endpoint(delay: u64, status: u16, body: &'static str) -> Endpoint {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let calls=Arc::new(AtomicUsize::new(0)); let count=calls.clone();
        let task=tokio::spawn(async move {
            while let Ok((mut socket,_))=listener.accept().await {
                count.fetch_add(1,Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf=[0;8192]; let _=socket.read(&mut buf).await;
                    sleep(Duration::from_millis(delay)).await;
                    let response=format!("HTTP/1.1 {status} OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                    let _=socket.write_all(response.as_bytes()).await;
                });
            }
        });
        Endpoint{url,calls,task}
    }
    const ANSWER:&str="data: {\"choices\":[{\"delta\":{\"content\":\"正文。\"}}]}\n\ndata: [DONE]\n\n";
    fn config(e:&Endpoint)->LlmConfig { LlmConfig {base_url:e.url.clone(),api_key:"test".into(),model:"test".into(),instructions:"".into(),thinking:"off".into(),strip_leading_filler:false,url_query:"".into(),room:"".into()} }
    #[tokio::test]
    async fn personal_metadata_requires_terminal_choice_and_done() {
        const TERMINAL: &str = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"正文。\"}}],\"tool\":\"weather\"}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"tool\":\"search\",",
            "\"sources\":[{\"title\":\"Python 发布公告\",\"url\":\"https://www.python.org/downloads/\",\"date\":null}]}\n\n",
        );
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::new();
        for (complete, body) in [(true, concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"正文。\"}}],\"tool\":\"weather\"}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"tool\":\"search\",",
            "\"sources\":[{\"title\":\"Python 发布公告\",\"url\":\"https://www.python.org/downloads/\",\"date\":null}]}\n\n",
            "data: [DONE]\n\n",
        )), (false, TERMINAL)] {
            let server = endpoint(0, 200, body).await;
            let (tx, _rx) = mpsc::channel(16);
            let reply = stream_personal_text(&client, &config(&server), vec![], tx, false).await.unwrap();
            assert_eq!(reply.full, "正文。");
            assert_eq!(reply.done, complete);
            assert_eq!(reply.personal.is_some(), complete);
            if let Some(metadata) = reply.personal {
                let metadata = serde_json::to_value(metadata).unwrap();
                assert_eq!(metadata["tool"], "search");
                assert_eq!(metadata["sources"][0]["title"], "Python 发布公告");
            }
        }
    }
    #[tokio::test]
    async fn disaster_fast_main_never_calls_backup() {
        let m=endpoint(40,200,ANSWER).await; let f=endpoint(10,200,ANSWER).await;
        let _=rustls::crypto::ring::default_provider().install_default();
        let c=reqwest::Client::new();let (tx,_rx)=mpsc::channel(16);
        let outcome=stream_chat_race((&c,&config(&m)),Some((&c,&config(&f))),vec![],tx,None).await.unwrap();
        assert_eq!(outcome.full,"正文。");
        assert_eq!(f.calls.load(Ordering::SeqCst),0,"fast Brain must not start a second LLM");
    }
    async fn run_case(m:&Endpoint,f:&Endpoint,trigger:u64,deadline:u64)->Result<ChatOutcome> {
        let _=rustls::crypto::ring::default_provider().install_default();
        let c=reqwest::Client::new();let (tx,_rx)=mpsc::channel(16);
        stream_chat_bounded((&c,&config(m)),Some((&c,&config(f))),vec![],tx,None,FallbackPolicy{trigger_ms:trigger,deadline_ms:deadline}).await
    }
    #[tokio::test]
    async fn disaster_failure_and_empty_start_once_without_wait() {
        for (status,body) in [(503,""),(200,"data: [DONE]\n\n"),(200,"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"}}]}\n\ndata: [DONE]\n\n"),(200,"data: {\"choices\":[{\"delta\":{\"content\":\"[[DEV:1]]\"}}]}\n\ndata: [DONE]\n\n")] {
            let m=endpoint(0,status,body).await;let f=endpoint(5,200,ANSWER).await;
            let t=std::time::Instant::now();let r=run_case(&m,&f,500,1000).await.unwrap();
            assert_eq!(r.full,"正文。");assert!(t.elapsed().as_millis()<300);assert_eq!(f.calls.load(Ordering::SeqCst),1);
            assert!(r.dev_labels.is_empty(),"losing control token must not leak");
        }
    }
    #[tokio::test]
    async fn disaster_delayed_backup_and_slow_main_can_still_win() {
        const MAIN:&str="data: {\"choices\":[{\"delta\":{\"content\":\"主路。\"}}]}\n\ndata: [DONE]\n\n";
        for (md,fd,expected) in [(500,5,"正文。"),(100,200,"主路。")] {
            let m=endpoint(md,200,MAIN).await;let f=endpoint(fd,200,ANSWER).await;
            let t=std::time::Instant::now();let r=run_case(&m,&f,50,900).await.unwrap();
            assert_eq!(r.full,expected);assert!(t.elapsed().as_millis()>=50);assert_eq!(f.calls.load(Ordering::SeqCst),1);
        }
    }
    // A live HTTP stream that reports peer closure, so cancellation is observed at the socket.
    async fn hanging(prefix:&'static str)->(Endpoint,Arc<AtomicUsize>) {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}",listener.local_addr().unwrap());
        let calls=Arc::new(AtomicUsize::new(0));let count=calls.clone();let closed=Arc::new(AtomicUsize::new(0));let c2=closed.clone();
        let task=tokio::spawn(async move {
            while let Ok((mut socket,_))=listener.accept().await {
                count.fetch_add(1,Ordering::SeqCst);let c2=c2.clone();
                tokio::spawn(async move {
                    let mut request=Vec::new();let mut buf=[0;8192];
                    loop {
                        let n=socket.read(&mut buf).await.unwrap_or(0);if n==0{return;}request.extend_from_slice(&buf[..n]);
                        if let Some(pos)=request.windows(4).position(|v|v==b"\r\n\r\n") {
                            let headers=String::from_utf8_lossy(&request[..pos]).to_lowercase();
                            let len=headers.lines().find_map(|l|l.strip_prefix("content-length:").and_then(|v|v.trim().parse::<usize>().ok())).unwrap_or(0);
                            if request.len()>=pos+4+len {break;}
                        }
                    }
                    let _=socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{prefix}").as_bytes()).await;
                    if socket.read(&mut buf).await.unwrap_or(0)==0 {c2.fetch_add(1,Ordering::SeqCst);}
                });
            }
        });(Endpoint{url,calls,task},closed)
    }
    async fn wait_closed(c:&Arc<AtomicUsize>) {
        tokio::time::timeout(Duration::from_millis(500),async {while c.load(Ordering::SeqCst)==0{sleep(Duration::from_millis(5)).await;}}).await.expect("HTTP request survived cancellation");
    }
    #[tokio::test]
    async fn disaster_deadline_cancels_both_http_requests() {
        let (m,mc)=hanging("").await;let (f,fc)=hanging("").await;
        let t=std::time::Instant::now();assert!(run_case(&m,&f,30,120).await.is_err());
        assert!(t.elapsed().as_millis()<400);assert_eq!(f.calls.load(Ordering::SeqCst),1);wait_closed(&mc).await;wait_closed(&fc).await;
    }
    #[tokio::test]
    async fn disaster_parent_cancel_before_and_after_backup_cancels_sockets() {
        let _=rustls::crypto::ring::default_provider().install_default();
        for cancel_after in [20,100] {
            let (m,mc)=hanging("").await;let (f,fc)=hanging("").await;
            let c=reqwest::Client::new();let mcfg=config(&m);let fcfg=config(&f);let (tx,_rx)=mpsc::channel(16);
            let task=tokio::spawn(async move{stream_chat_bounded((&c,&mcfg),Some((&c,&fcfg)),vec![],tx,None,FallbackPolicy{trigger_ms:50,deadline_ms:900}).await});
            sleep(Duration::from_millis(cancel_after)).await;task.abort();let _=task.await;wait_closed(&mc).await;
            if cancel_after>50 {wait_closed(&fc).await;assert_eq!(f.calls.load(Ordering::SeqCst),1);}else{sleep(Duration::from_millis(80)).await;assert_eq!(f.calls.load(Ordering::SeqCst),0);}
        }
    }
    #[tokio::test]
    async fn disaster_text_then_stall_never_splices_backup_and_downstream_close_aborts() {
        let _=rustls::crypto::ring::default_provider().install_default();
        let (m,mc)=hanging("data: {\"choices\":[{\"delta\":{\"content\":\"主路开头。\"}}]}\n\n").await;
        let f=endpoint(0,200,ANSWER).await;let c=reqwest::Client::new();let mcfg=config(&m);let fcfg=config(&f);let (tx,mut rx)=mpsc::channel(16);
        let task=tokio::spawn(async move {stream_chat_bounded((&c,&mcfg),Some((&c,&fcfg)),vec![],tx,None,FallbackPolicy{trigger_ms:30,deadline_ms:100}).await});
        assert_eq!(rx.recv().await.unwrap(),"主路开头。");sleep(Duration::from_millis(150)).await;
        assert_eq!(f.calls.load(Ordering::SeqCst),0);drop(rx);assert!(task.await.unwrap().is_err());wait_closed(&mc).await;
    }
    #[tokio::test]
    async fn disaster_control_only_does_not_win_or_delay_deadline() {
        let (m,mc)=hanging("data: {\"choices\":[{\"delta\":{\"content\":\"[[DEV:1]]\"}}]}\n\n").await;
        let f=endpoint(5,200,ANSWER).await;
        let r=run_case(&m,&f,30,150).await.unwrap();assert_eq!(r.full,"正文。");wait_closed(&mc).await;
    }
    #[tokio::test]
    async fn disaster_disabled_config_and_closed_consumer_never_start_backup() {
        let m=endpoint(5,200,ANSWER).await;let f=endpoint(5,200,ANSWER).await;let cfg=config(&m);
        for enabled in [None,Some("0")] {
            let fb=LlmConfig::fallback_from(|k|match k {"LLM_FALLBACK_ENABLED"=>enabled.map(str::to_string),"LLM_FALLBACK_BASE_URL"=>Some(f.url.clone()),"LLM_FALLBACK_API_KEY"|"LLM_FALLBACK_MODEL"=>Some("test".into()),_=>None},&cfg);
            assert!(fb.is_none());let _=rustls::crypto::ring::default_provider().install_default();let c=reqwest::Client::new();let(tx,_rx)=mpsc::channel(16);
            stream_chat_race((&c,&cfg),None,vec![],tx,None).await.unwrap();
        }
        assert_eq!(f.calls.load(Ordering::SeqCst),0);
        let c=reqwest::Client::new();let(tx,rx)=mpsc::channel(16);drop(rx);
        assert!(stream_chat_race((&c,&cfg),Some((&c,&config(&f))),vec![],tx,None).await.is_err());
        assert_eq!(f.calls.load(Ordering::SeqCst),0);
    }

}
