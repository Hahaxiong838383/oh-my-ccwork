//! 语义分桶承接音库(逐行为对齐 engines/fillers.py C1 v2):
//! turn 提交后按用户文本选桶,预解码 wav(24k mono s16,与播放通道同率直喂)零合成
//! 延迟先出声,盖住 LLM+TTS 首音窗口。greet/thanks 桶级概率 0.5,其余走全局(默认
//! 0.9);打断轮(5s 窗)boost 必播;滑窗 3 防重复;资产缺失静默降级 None。

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
}

pub struct FillerBank {
    clips: std::collections::HashMap<String, Vec<FillerClip>>,
    probability: f64,
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
        match Self::load(&dir, probability) {
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

    fn load(dir: &Path, probability: f64) -> anyhow::Result<Option<Self>> {
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
            let bucket = meta.get("bucket").and_then(|b| b.as_str()).unwrap_or("gen").to_string();
            let text = meta.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
            clips.entry(bucket).or_default().push(FillerClip { text, pcm });
        }
        if clips.is_empty() {
            return Ok(None);
        }
        let total: usize = clips.values().map(|v| v.len()).sum();
        let mut buckets: Vec<&String> = clips.keys().collect();
        buckets.sort();
        info!("filler bank loaded: {total} clips buckets={buckets:?}");
        Ok(Some(Self { clips, probability, recent: VecDeque::with_capacity(3) }))
    }

    /// 桶级概率覆盖(greet/thanks 0.5,结构性重复场景降频;其余全局)。
    fn bucket_prob(&self, bucket: &str) -> f64 {
        match bucket {
            "greet" | "thanks" => 0.5,
            _ => self.probability,
        }
    }

    /// 语义桶(空桶回退 gen)+ 概率门控 + 滑窗防重复;boost=打断轮必播。
    /// 返回 (文案, pcm 24k bytes)。
    pub fn pick(&mut self, user_text: &str, boost: bool) -> Option<(String, Vec<u8>)> {
        let bucket = pick_bucket(user_text);
        let prob = if boost { 1.0 } else { self.bucket_prob(bucket) };
        if rand::rng().random::<f64>() >= prob {
            return None;
        }
        let pool = self.clips.get(bucket).or_else(|| self.clips.get("gen"))?;
        if pool.is_empty() {
            return None;
        }
        let cands: Vec<&FillerClip> =
            pool.iter().filter(|c| !self.recent.contains(&c.text)).collect();
        let cands = if cands.is_empty() { pool.iter().collect() } else { cands };
        let clip = cands[rand::rng().random_range(0..cands.len())];
        if self.recent.len() == 3 {
            self.recent.pop_front();
        }
        self.recent.push_back(clip.text.clone());
        info!("filler picked bucket={bucket} text='{}'", clip.text);
        Some((clip.text.clone(), clip.pcm.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
