//! 语义分桶承接音库(逐行为对齐 engines/fillers.py C1 v2):
//! turn 提交后按用户文本选桶,预解码 wav(24k mono s16,与播放通道同率直喂)零合成
//! 延迟先出声,盖住 LLM+TTS 首音窗口。greet/thanks 桶级概率 0.5,其余走全局(默认
//! 0.9);打断轮(5s 窗)boost 必播且优先专用 barge 桶;滑窗 3 防重复;资产缺失静默降级 None。

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use rand::Rng;
use tracing::{info, warn};

// 桶判定线索(与 Python 常量逐字对齐;顺序=优先级)
const GREET_HINTS: &[&str] = &[
    "你好", "您好", "哈喽", "嗨", "早上好", "中午好", "下午好", "晚上好", "在吗", "在不在",
    "早啊", "早呀",
];
const THANKS_HINTS: &[&str] = &["谢谢", "感谢", "多谢", "辛苦", "谢啦", "谢了"];
const EMO_NEG_HINTS: &[&str] = &[
    "难过", "伤心", "想哭", "哭了", "委屈", "郁闷", "烦死", "好烦", "太烦", "气死", "生气",
    "好累", "累死", "太累", "害怕", "焦虑", "压力好大", "不开心", "心情不好", "无聊",
];
const EMO_POS_HINTS: &[&str] = &["开心", "高兴", "兴奋", "太棒", "太好了", "太好啦", "好爽", "哈哈"];
const TASK_HINTS: &[&str] = &[
    "讲个", "讲一", "讲讲", "说个", "说一", "给我讲", "给我说", "给我来", "给我放", "帮我",
    "来个", "来一", "唱个", "唱首", "唱一", "背个", "背一", "背首", "念个", "念一", "念首",
    "推荐", "介绍", "教我", "陪我", "翻译", "写个", "写一",
];
const STORY_STRONG_HINTS: &[&str] = &["跟你说", "告诉你", "你猜"];
const STORY_HINTS: &[&str] = &[
    "我今天", "我昨天", "我刚才", "我上次", "我们老师", "我们班", "我妈", "我爸", "我朋友",
];
const ASK_HINTS: &[&str] = &[
    "怎么", "为什么", "什么", "哪", "几", "多少", "是不是", "吗", "呢", "好不好", "行不行",
    "对不对", "谁", "难道", "?", "？",
];
const OPINION_HINTS: &[&str] = &["我觉得", "我认为", "我感觉"];

/// 按用户 turn 文本选桶(优先级与 Python pick_bucket 一致)。
pub fn pick_bucket(user_text: &str) -> &'static str {
    let t = user_text.trim();
    let n = t.chars().count();
    let has = |hints: &[&str]| hints.iter().any(|h| t.contains(h));
    if n <= 10 && has(GREET_HINTS) {
        return "greet";
    }
    if n <= 10 && has(THANKS_HINTS) {
        return "thanks";
    }
    if has(EMO_NEG_HINTS) {
        return "emo_neg";
    }
    if has(EMO_POS_HINTS) {
        return "emo_pos";
    }
    if has(STORY_STRONG_HINTS) {
        return "story";
    }
    if has(TASK_HINTS) {
        return "task";
    }
    if has(STORY_HINTS) {
        return "story";
    }
    if has(ASK_HINTS) {
        return "ask";
    }
    if has(OPINION_HINTS) {
        return "opinion";
    }
    "gen"
}

pub struct FillerClip {
    pub text: String,
    /// 24k mono s16le 原始字节(播放通道同率直喂)
    pub pcm: Vec<u8>,
    /// 时长毫秒(从 pcm 长度算:24k s16 = 48 字节/ms)。打断轮短条偏好用。
    pub duration_ms: u64,
}

pub struct FillerBank {
    clips: std::collections::HashMap<String, Vec<FillerClip>>,
    probability: f64,
    /// 打断轮短条上限(ms):boost 时只从池内 ≤此时长 的条里选(专用 barge 桶同样过滤,
    /// 当合成超长的保险丝),没有才回退全池。打断后用户要的是"快点接上",慢悠悠的
    /// 长承接火上浇油(2026-08-16 川哥定;生产 env 1500)。
    barge_max_ms: u64,
    recent: VecDeque<String>, // 最近 3 条文案滑窗防重复
}

impl FillerBank {
    /// FILLER_ENABLED=0 / 资产缺失 → None(静默降级,不影响主链路)。
    pub fn load_from_env() -> Option<Self> {
        if std::env::var("FILLER_ENABLED").map(|v| v != "1").unwrap_or(false) {
            return None;
        }
        let dir = std::env::var("FILLER_DIR").map(PathBuf::from).unwrap_or_else(|_| {
            // 默认:仓内 assets/fillers(rust-worker/ 的上一级);生产以 env 显式指
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../assets/fillers")
        });
        let probability = std::env::var("FILLER_PROBABILITY")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.9)
            .min(1.0);
        let barge_max_ms = std::env::var("FILLER_BARGE_MAX_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(1200);
        match Self::load(&dir, probability, barge_max_ms) {
            Ok(Some(bank)) => Some(bank),
            Ok(None) => {
                info!(dir = %dir.display(), "filler bank 资产缺失,承接音关闭");
                None
            }
            Err(e) => {
                warn!(error = %e, "filler bank 加载失败(承接音降级关闭,不影响主链路)");
                None
            }
        }
    }

    fn load(dir: &Path, probability: f64, barge_max_ms: u64) -> anyhow::Result<Option<Self>> {
        let manifest_path = dir.join("manifest.json");
        if !manifest_path.exists() {
            return Ok(None);
        }
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path)?)?;
        let Some(entries) = manifest.as_object() else { return Ok(None) };
        let mut clips: std::collections::HashMap<String, Vec<FillerClip>> =
            std::collections::HashMap::new();
        for (fname, meta) in entries {
            let wav_path = dir.join(fname);
            if !wav_path.exists() {
                continue;
            }
            let mut reader = match hound::WavReader::open(&wav_path) {
                Ok(r) => r,
                Err(e) => {
                    warn!(file = %fname, error = %e, "filler wav 读取失败,跳过");
                    continue;
                }
            };
            let spec = reader.spec();
            if spec.sample_rate != crate::tts_volc::TTS_SAMPLE_RATE
                || spec.channels != 1
                || spec.bits_per_sample != 16
            {
                warn!(file = %fname, ?spec, "filler wav 非 24k/mono/s16,跳过");
                continue;
            }
            let samples: Vec<i16> = reader.samples::<i16>().filter_map(|s| s.ok()).collect();
            if samples.is_empty() {
                continue;
            }
            let pcm: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
            let duration_ms = (pcm.len() / 48) as u64; // 24k s16 = 48 B/ms
            let bucket = meta.get("bucket").and_then(|b| b.as_str()).unwrap_or("gen").to_string();
            let text = meta.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
            clips.entry(bucket).or_default().push(FillerClip { text, pcm, duration_ms });
        }
        if clips.is_empty() {
            return Ok(None);
        }
        let total: usize = clips.values().map(|v| v.len()).sum();
        let mut buckets: Vec<&String> = clips.keys().collect();
        buckets.sort();
        info!("filler bank loaded: {total} clips buckets={buckets:?}");
        Ok(Some(Self { clips, probability, barge_max_ms, recent: VecDeque::with_capacity(3) }))
    }

    /// 桶级概率覆盖(greet/thanks 0.5,结构性重复场景降频;其余全局)。
    fn bucket_prob(&self, bucket: &str) -> f64 {
        match bucket {
            "greet" | "thanks" => 0.5,
            _ => self.probability,
        }
    }

    /// 语义桶(空桶回退 gen)+ 概率门控 + 滑窗防重复;boost=打断轮必播。
    /// 返回 (文案, pcm 24k bytes)。room 只用于日志——picked/skip 行历史上不带 room,
    /// 按房 grep 数它们必得 0,两次误判(2026-08-16/17)后补上;skip 结构化日志为
    /// codex trace 对撞要求(无它则"没看到 picked"区分不了概率跳过/资产缺/功能关)。
    pub fn pick(&mut self, user_text: &str, boost: bool, room: &str) -> Option<(String, Vec<u8>)> {
        let bucket = pick_bucket(user_text);
        let prob = if boost { 1.0 } else { self.bucket_prob(bucket) };
        if rand::rng().random::<f64>() >= prob {
            info!("filler skip room={room} bucket={bucket} prob={prob} boost={boost} reason=probability");
            return None;
        }
        // 打断轮优先专用 barge 桶(2026-08-16 川哥定):打断衔接的合适性是语义不是时长,
        // 桶内是人工圈定的"收住+转向"腔(pick_bucket 永不返回 barge,普通轮碰不到);
        // 桶缺失/为空(资产事故)才回退语义桶短条——保住静默降级链。
        let barge_pool =
            if boost { self.clips.get("barge").filter(|p| !p.is_empty()) } else { None };
        let (pool_name, pool) = match barge_pool {
            Some(p) => ("barge", p),
            None => match self.clips.get(bucket).or_else(|| self.clips.get("gen")) {
                Some(p) => (bucket, p),
                None => {
                    info!("filler skip room={room} bucket={bucket} prob={prob} boost={boost} reason=no_pool");
                    return None;
                }
            },
        };
        if pool.is_empty() {
            info!("filler skip room={room} bucket={pool_name} prob={prob} boost={boost} reason=no_pool");
            return None;
        }
        // 打断轮只选 ≤barge_max_ms 的条(barge 桶同样过滤,当合成超长的保险丝);滤空回退全池。
        let base: Vec<&FillerClip> = if boost {
            let short: Vec<&FillerClip> =
                pool.iter().filter(|c| c.duration_ms <= self.barge_max_ms).collect();
            if short.is_empty() { pool.iter().collect() } else { short }
        } else {
            pool.iter().collect()
        };
        let cands: Vec<&FillerClip> =
            base.iter().copied().filter(|c| !self.recent.contains(&c.text)).collect();
        let cands = if cands.is_empty() { base } else { cands };
        let clip = cands[rand::rng().random_range(0..cands.len())];
        if self.recent.len() == 3 {
            self.recent.pop_front();
        }
        self.recent.push_back(clip.text.clone());
        info!(
            "filler picked room={room} bucket={pool_name} dur_ms={} boost={boost} text='{}'",
            clip.duration_ms, clip.text
        );
        Some((clip.text.clone(), clip.pcm.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(text: &str, ms: u64) -> FillerClip {
        // pcm 长度按 48B/ms 反推,与加载路径的换算共用同一常数
        FillerClip { text: text.into(), pcm: vec![0u8; (ms * 48) as usize], duration_ms: ms }
    }

    fn bank_with(clips: Vec<FillerClip>) -> FillerBank {
        let mut m = std::collections::HashMap::new();
        m.insert("gen".to_string(), clips);
        FillerBank { clips: m, probability: 1.0, barge_max_ms: 1200, recent: VecDeque::new() }
    }

    #[test]
    fn boost_prefers_short_clips_only() {
        let mut b = bank_with(vec![clip("长条一", 2000), clip("短条", 900), clip("长条二", 1800)]);
        for _ in 0..20 {
            let (text, _) = b.pick("随便聊聊", true, "t").expect("boost 必播");
            assert_eq!(text, "短条", "打断轮必须只从 ≤barge_max_ms 的条里选");
            b.recent.clear(); // 隔离滑窗影响,单验候选集
        }
    }

    #[test]
    fn boost_falls_back_when_no_short_clip() {
        let mut b = bank_with(vec![clip("长条一", 2000), clip("长条二", 1800)]);
        let got = b.pick("随便聊聊", true, "t");
        assert!(got.is_some(), "桶内无短条必须回退全桶,不能不播");
    }

    #[test]
    fn normal_turn_uses_full_pool() {
        let mut b = bank_with(vec![clip("长条", 2000), clip("短条", 900)]);
        let mut seen = std::collections::HashSet::new();
        for _ in 0..60 {
            if let Some((t, _)) = b.pick("随便聊聊", false, "t") {
                seen.insert(t);
            }
            b.recent.clear();
        }
        assert_eq!(seen.len(), 2, "普通轮长短条都该被选到(无短条偏好)");
    }

    fn bank_with_barge(sem: Vec<FillerClip>, barge: Vec<FillerClip>) -> FillerBank {
        let mut m = std::collections::HashMap::new();
        m.insert("gen".to_string(), sem);
        m.insert("barge".to_string(), barge);
        FillerBank { clips: m, probability: 1.0, barge_max_ms: 1500, recent: VecDeque::new() }
    }

    #[test]
    fn boost_uses_barge_bucket_when_present() {
        let mut b = bank_with_barge(
            vec![clip("语义桶短条", 900)],
            vec![clip("哦，我打住。", 1300), clip("嗯嗯，来。", 1200)],
        );
        for _ in 0..20 {
            let (text, _) = b.pick("随便聊聊", true, "t").expect("boost 必播");
            assert_ne!(text, "语义桶短条", "打断轮有 barge 桶时不得选语义桶");
            b.recent.clear();
        }
    }

    #[test]
    fn boost_barge_bucket_still_filters_overlong() {
        let mut b = bank_with_barge(
            vec![clip("语义条", 900)],
            vec![clip("超长条", 2000), clip("合规条", 1400)],
        );
        for _ in 0..20 {
            let (text, _) = b.pick("随便聊聊", true, "t").expect("boost 必播");
            assert_eq!(text, "合规条", "barge 桶内也要过 ≤barge_max_ms 保险丝");
            b.recent.clear();
        }
    }

    #[test]
    fn normal_turn_never_picks_barge() {
        let mut b =
            bank_with_barge(vec![clip("语义条", 900)], vec![clip("哦，我打住。", 1300)]);
        for _ in 0..40 {
            if let Some((text, _)) = b.pick("随便聊聊", false, "t") {
                assert_eq!(text, "语义条", "普通轮永不选 barge 桶");
            }
            b.recent.clear();
        }
    }

    #[test]
    fn bucket_priority_matches_python() {
        assert_eq!(pick_bucket("你好呀"), "greet");
        assert_eq!(pick_bucket("谢谢你"), "thanks");
        // 长句里的问候只是开场,不落 greet
        assert_eq!(pick_bucket("你好我想问一下明天的天气怎么样"), "ask");
        assert_eq!(pick_bucket("我今天好难过"), "emo_neg");
        // task 先于 ask:"给我讲个故事好不好"
        assert_eq!(pick_bucket("给我讲个故事好不好"), "task");
        // 强叙述先于 task:"跟你说个事儿"
        assert_eq!(pick_bucket("跟你说个事儿"), "story");
        assert_eq!(pick_bucket("我觉得还行"), "opinion");
        assert_eq!(pick_bucket("随便聊聊"), "gen");
    }
}
