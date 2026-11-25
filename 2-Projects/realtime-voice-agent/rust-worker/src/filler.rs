//! 语义分桶承接音库(逐行为对齐 engines/fillers.py C1 v2):
//! turn 提交后按用户文本选桶,预解码 wav(24k mono s16,与播放通道同率直喂)零合成
//! 延迟先出声,盖住 LLM+TTS 首音窗口。greet/thanks 桶级概率 0.5,其余走全局(默认
//! 0.9);打断轮(5s 窗)旧票据 boost 必播；风格票据优先概率门控，barge 桶;滑窗 3 防重复;资产缺失静默降级 None。

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

// ── 设备句线索(D1 W3a,2026-09-22 方案 v1.1 川哥拍板):命中 → `device` 桶(「好嘞,这就调」类,概率 1.0)。
// 判定在 greet/thanks 之后、emo 之前(「帮我把灯调亮」的「帮我」不能先落 task)。两级:强线索整词单独即判;
// 弱线索须「设备对象 ∧ 调节词」同现——单字「亮/暗/高/大」太泛(「月亮的故事」「我今年长高了一点」「你的声音真好听」
// 都不该听到「这就调」)。快路命中的命令句(≤20 字)走命令句单出口不播承接音(pipeline cmd_single_exit),与此无关。
// 无 device 桶资产时 pick 自动回退 gen(既有降级链)。
const DEVICE_STRONG_HINTS: &[&str] = &[
    "开灯", "关灯", "灯光", "台灯", "亮度", "调亮", "调暗", "太亮", "太暗", "最亮", "最暗", "变亮", "变暗",
    "亮一点", "暗一点", "亮一些", "暗一些", "色温", "光谱", "暖光", "冷光", "中性光", "暖一点", "冷一点",
    "夜读", "绘画模式", "常规模式", "阅读模式", "护眼模式",
    "音量", "静音", "大声一点", "小声一点", "大声点", "小声点", "声音大", "声音小", "声音太", "声音调",
    "声音关掉", "声音关了", "声音打开",
    "读写台", "虚像", "画面", "升高", "降低", "抬高", "调高", "调低", "拉远", "拉近", "调远", "调近", "远一点", "近一点",
];
const DEVICE_OBJECT_HINTS: &[&str] =
    &["灯", "光线", "亮度", "色温", "光谱", "音量", "声音", "读写台", "虚像", "画面", "设备"];
const DEVICE_ADJUST_HINTS: &[&str] = &[
    "调", "开", "关", "亮", "暗", "大", "小", "高", "低", "远", "近", "暖", "冷", "模式", "一点", "一些", "太", "最", "变",
];

pub(crate) fn is_device_text(t: &str) -> bool {
    let has = |hints: &[&str]| hints.iter().any(|h| t.contains(h));
    has(DEVICE_STRONG_HINTS) || (has(DEVICE_OBJECT_HINTS) && has(DEVICE_ADJUST_HINTS))
}

/// 按用户 turn 文本选桶(优先级与 Python pick_bucket 一致;device 桶为 D1 新增)。
/// `allow_device=false`(灰度名单外的房/非 sn- 房)时 device 判定整段跳过,句子按原优先级落桶——名单外设备行为零变化。
pub fn pick_bucket_with(user_text: &str, allow_device: bool) -> &'static str {
    let t = user_text.trim();
    let n = t.chars().count();
    let has = |hints: &[&str]| hints.iter().any(|h| t.contains(h));
    if n <= 10 && has(GREET_HINTS) {
        return "greet";
    }
    if n <= 10 && has(THANKS_HINTS) {
        return "thanks";
    }
    if allow_device && is_device_text(t) {
        return "device";
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

/// Only server-signed device-session metadata may override the legacy environment.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FillerStyle { Default, Chatty, Quiet, Funny }
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FillerPolicy { version: u8, style: FillerStyle, probability: f64 }
impl FillerPolicy {
    pub fn from_metadata(value: Option<&serde_json::Value>, room: &str) -> Option<Self> {
        let (sn, suffix) = room.strip_prefix("sn-")?.rsplit_once('-')?;
        if sn.len() != 20 || !sn.starts_with("BJP003") || !sn.as_bytes()[6..].iter().all(u8::is_ascii_digit)
            || suffix.is_empty() || !suffix.bytes().all(|c| c.is_ascii_digit()) { return None; }
        let policy: Self = serde_json::from_value(value?.clone()).ok()?;
        (policy.version == 1 && policy.probability.is_finite() && (0.0..=1.0).contains(&policy.probability)).then_some(policy)
    }
}

pub struct FillerBank {
    clips: std::collections::HashMap<String, Vec<FillerClip>>,
    probability: f64,
    style_probability: Option<f64>,
    /// 打断轮短条上限(ms):boost 时只从池内 ≤此时长 的条里选(专用 barge 桶同样过滤,
    /// 当合成超长的保险丝),没有才回退全池。打断后用户要的是"快点接上",慢悠悠的
    /// 长承接火上浇油(2026-08-16 川哥定;生产 env 1500)。
    barge_max_ms: u64,
    recent: VecDeque<String>, // 最近 3 条文案滑窗防重复
}

/// 个人本地语音的问候和承接必须走当次合成。预录 wav 没有音色身份，会把旧音色播出去。
pub(crate) fn skip_prerecorded_fillers(personal_local: bool, filler_enabled: Option<&str>) -> bool {
    personal_local || filler_enabled.is_some_and(|value| value != "1")
}

impl FillerBank {
    /// FILLER_ENABLED=0 / 资产缺失 → None(静默降级,不影响主链路)。
    pub fn load_from_env() -> Option<Self> {
        let personal_local = crate::stt_volc::personal_local_speech::endpoint().is_some();
        if skip_prerecorded_fillers(personal_local, std::env::var("FILLER_ENABLED").ok().as_deref()) {
            if personal_local {
                info!("prerecorded filler bank skipped: personal speech selects the voice");
            }
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
        Ok(Some(Self { clips, probability, style_probability: None, barge_max_ms, recent: VecDeque::with_capacity(3) }))
    }

    pub fn apply_policy(&mut self, policy: FillerPolicy, room: &str) {
        self.style_probability = Some(policy.probability);
        info!(room = room, style = ?policy.style, probability = policy.probability, version = policy.version, "filler_policy_applied");
    }
    fn effective_probability(&self, bucket: &str, boost: bool) -> f64 {
        self.style_probability.unwrap_or_else(|| if boost { 1.0 } else { self.bucket_prob(bucket) })
    }

    /// 桶级概率覆盖(greet/thanks 0.5,结构性重复场景降频;device 1.0=设备句必出承接音(D1);其余全局)。
    fn bucket_prob(&self, bucket: &str) -> f64 {
        match bucket {
            "greet" | "thanks" => 0.5,
            "device" => 1.0,
            _ => self.probability,
        }
    }

    /// 语义桶(空桶回退 gen)+ 概率门控 + 滑窗防重复;boost=打断轮优先短资产，新风格策略不强制播。
    /// 返回 (文案, pcm 24k bytes)。room 只用于日志——picked/skip 行历史上不带 room,
    /// 按房 grep 数它们必得 0,两次误判(2026-08-16/17)后补上;skip 结构化日志为
    /// codex trace 对撞要求(无它则"没看到 picked"区分不了概率跳过/资产缺/功能关)。
    pub fn pick(&mut self, user_text: &str, boost: bool, room: &str, turn_id: u64) -> Option<(String, Vec<u8>)> {
        let bucket = pick_bucket_with(user_text, crate::device_intent::device_filler_enabled_for(room));
        let prob = self.effective_probability(bucket, boost);
        if rand::rng().random::<f64>() >= prob {
            info!("filler skip room={room} turn_id={turn_id} bucket={bucket} prob={prob} boost={boost} reason=probability");
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
                    info!("filler skip room={room} turn_id={turn_id} bucket={bucket} prob={prob} boost={boost} reason=no_pool");
                    return None;
                }
            },
        };
        if pool.is_empty() {
            info!("filler skip room={room} turn_id={turn_id} bucket={pool_name} prob={prob} boost={boost} reason=no_pool");
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
            "filler picked room={room} turn_id={turn_id} bucket={pool_name} dur_ms={} boost={boost} text='{}'",
            clip.duration_ms, clip.text
        );
        Some((clip.text.clone(), clip.pcm.clone()))
    }

    /// B(2026-09-09 codex GO):ordered 首句专用——语义桶(空回退 gen)取时长最短的完整条;
    /// 概率门与普通轮相同(本来不播的不强补),遵守滑窗防重复,不碰 barge/greet 语义,不裁不截。
    /// 只在 ORDERED_FILLER_SHORTEST=1 且 commit 来自 ordered 终局时由 pipeline 调用。
    pub fn pick_shortest(&mut self, user_text: &str, room: &str, turn_id: u64) -> Option<(String, Vec<u8>)> {
        let bucket = pick_bucket_with(user_text, crate::device_intent::device_filler_enabled_for(room));
        let prob = self.effective_probability(bucket, false);
        if rand::rng().random::<f64>() >= prob {
            info!("filler skip room={room} turn_id={turn_id} bucket={bucket} prob={prob} boost=false policy=shortest reason=probability");
            return None;
        }
        let (pool_name, pool) = match self.clips.get(bucket).filter(|p| !p.is_empty()) {
            Some(p) => (bucket, p),
            None => match self.clips.get("gen").filter(|p| !p.is_empty()) {
                Some(p) => ("gen", p),
                None => {
                    info!("filler skip room={room} turn_id={turn_id} bucket={bucket} prob={prob} boost=false policy=shortest reason=no_pool");
                    return None;
                }
            },
        };
        let clip = pool.iter().filter(|c| !self.recent.contains(&c.text)).min_by_key(|c| c.duration_ms)
            .or_else(|| pool.iter().min_by_key(|c| (self.recent.iter().rposition(|t| t == &c.text).unwrap_or(0), c.duration_ms)))?;
        if self.recent.len() == 3 {
            self.recent.pop_front();
        }
        self.recent.push_back(clip.text.clone());
        info!(
            "filler picked room={room} turn_id={turn_id} bucket={pool_name} dur_ms={} boost=false policy=shortest text='{}'",
            clip.duration_ms, clip.text
        );
        Some((clip.text.clone(), clip.pcm.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEVICE_ROOM: &str = "sn-BJP00326070803800006-123";
    #[test]
    fn personal_local_never_plays_prerecorded_fillers() {
        assert!(skip_prerecorded_fillers(true, None));
        assert!(skip_prerecorded_fillers(true, Some("1")));
        assert!(skip_prerecorded_fillers(false, Some("0")));
        assert!(!skip_prerecorded_fillers(false, None));
        assert!(!skip_prerecorded_fillers(false, Some("1")));
    }
    #[test]
    fn style_ark_metadata_validation_and_room_boundary() {
        let valid = serde_json::json!({"version":1,"style":"quiet","probability":0.1});
        assert!(FillerPolicy::from_metadata(Some(&valid), DEVICE_ROOM).is_some());
        assert!(FillerPolicy::from_metadata(Some(&valid), "web-room").is_none());
        for v in [serde_json::json!({"version":2,"style":"quiet","probability":0.1}),
            serde_json::json!({"version":1,"style":"other","probability":0.1}),
            serde_json::json!({"version":1,"style":"quiet","probability":1.1}),
            serde_json::json!({"version":1,"style":"quiet","probability":-0.1}),
            serde_json::json!({"version":1,"style":"quiet","probability":"0"}),
            serde_json::json!({"version":1,"style":"quiet","probability":null}), serde_json::json!(false)] {
            assert!(FillerPolicy::from_metadata(Some(&v), DEVICE_ROOM).is_none(), "{v}");
        }
        assert!(FillerPolicy::from_metadata(None, DEVICE_ROOM).is_none());
    }
    #[test]
    fn style_ark_zero_blocks_boost_and_all_buckets() {
        let mut b = bank_with(vec![clip("好呀", 200)]);
        b.apply_policy(FillerPolicy { version:1, style:FillerStyle::Quiet, probability:0.0 }, DEVICE_ROOM);
        for bucket in ["greet","thanks","device","gen"] { assert_eq!(b.effective_probability(bucket,true),0.0); }
        for i in 0..20 {
            assert!(b.pick("你好",true,DEVICE_ROOM,i).is_none());
            assert!(b.pick_shortest("谢谢",DEVICE_ROOM,i).is_none());
        }
        b.apply_policy(FillerPolicy { version:1, style:FillerStyle::Chatty, probability:1.0 }, DEVICE_ROOM);
        assert!(b.pick("你好",false,DEVICE_ROOM,30).is_some());
        assert!(b.pick_shortest("谢谢",DEVICE_ROOM,31).is_some());
    }
    #[test]
    fn style_ark_legacy_and_probabilities_are_preserved() {
        let mut b = bank_with(vec![clip("好呀",200)]);
        assert_eq!(b.effective_probability("greet",false),0.5);
        assert_eq!(b.effective_probability("gen",true),1.0);
        for p in [0.1,0.25,0.35,0.45] {
            b.apply_policy(FillerPolicy {version:1,style:FillerStyle::Default,probability:p}, DEVICE_ROOM);
            for bucket in ["greet","thanks","device","gen"] {
                assert_eq!(b.effective_probability(bucket,false),p);
                assert_eq!(b.effective_probability(bucket,true),p);
            }
        }
    }

    fn clip(text: &str, ms: u64) -> FillerClip {
        // pcm 长度按 48B/ms 反推,与加载路径的换算共用同一常数
        FillerClip { text: text.into(), pcm: vec![0u8; (ms * 48) as usize], duration_ms: ms }
    }

    fn bank_with(clips: Vec<FillerClip>) -> FillerBank {
        let mut m = std::collections::HashMap::new();
        m.insert("gen".to_string(), clips);
        FillerBank { clips: m, probability: 1.0, style_probability: None, barge_max_ms: 1200, recent: VecDeque::new() }
    }

    #[test]
    fn style_ark_shortest_avoids_consecutive_repeat() {
        let mut b = bank_with(vec![clip("长条", 2000), clip("短条", 960), clip("中条", 1480)]);
        let first = b.pick_shortest("随便聊聊", "t", 1).unwrap().0;
        let second = b.pick_shortest("随便聊聊", "t", 2).unwrap().0;
        assert_eq!(first, "短条");
        assert_ne!(first, second);
    }

    #[test]
    fn style_ark_two_clips_alternate_after_recent_window_fills() {
        let mut b = bank_with(vec![clip("短条", 200), clip("中条", 300)]);
        let mut last = String::new();
        for i in 0..12 {
            let chosen = b.pick_shortest("随便聊聊", "t", i).unwrap().0;
            assert_ne!(chosen, last);
            last = chosen;
        }
        let mut one = bank_with(vec![clip("唯一",200)]);
        for i in 0..6 { assert_eq!(one.pick_shortest("随便聊聊","t",i).unwrap().0,"唯一"); }
    }

    /// B:语义桶优先(问句→ask 最短),无命中回退 gen 最短;普通 pick 不受影响。
    #[test]
    fn shortest_policy_uses_semantic_bucket_then_gen() {
        let mut m = std::collections::HashMap::new();
        m.insert("gen".to_string(), vec![clip("gen短", 960), clip("gen长", 2000)]);
        m.insert("ask".to_string(), vec![clip("ask长", 2200), clip("ask短", 1000)]);
        let mut b = FillerBank { clips: m, probability: 1.0, style_probability: None, barge_max_ms: 1500, recent: VecDeque::new() };
        let (t, _) = b.pick_shortest("一加一等于几", "t", 1).unwrap();
        assert_eq!(t, "ask短", "问句走 ask 桶最短");
        let (t2, _) = b.pick_shortest("随便聊聊", "t", 2).unwrap();
        assert_eq!(t2, "gen短", "无语义命中回退 gen 最短");
        let mut seen = std::collections::HashSet::new();
        for _ in 0..60 {
            if let Some((t3, _)) = b.pick("一加一等于几", false, "t", 3) {
                seen.insert(t3);
            }
            b.recent.clear();
        }
        assert_eq!(seen.len(), 2, "普通轮仍全池随机(旧策略未变)");
    }

    #[test]
    fn boost_prefers_short_clips_only() {
        let mut b = bank_with(vec![clip("长条一", 2000), clip("短条", 900), clip("长条二", 1800)]);
        for _ in 0..20 {
            let (text, _) = b.pick("随便聊聊", true, "t", 1).expect("boost 必播");
            assert_eq!(text, "短条", "打断轮必须只从 ≤barge_max_ms 的条里选");
            b.recent.clear(); // 隔离滑窗影响,单验候选集
        }
    }

    #[test]
    fn boost_falls_back_when_no_short_clip() {
        let mut b = bank_with(vec![clip("长条一", 2000), clip("长条二", 1800)]);
        let got = b.pick("随便聊聊", true, "t", 1);
        assert!(got.is_some(), "桶内无短条必须回退全桶,不能不播");
    }

    #[test]
    fn normal_turn_uses_full_pool() {
        let mut b = bank_with(vec![clip("长条", 2000), clip("短条", 900)]);
        let mut seen = std::collections::HashSet::new();
        for _ in 0..60 {
            if let Some((t, _)) = b.pick("随便聊聊", false, "t", 1) {
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
        FillerBank { clips: m, probability: 1.0, style_probability: None, barge_max_ms: 1500, recent: VecDeque::new() }
    }

    #[test]
    fn boost_uses_barge_bucket_when_present() {
        let mut b = bank_with_barge(
            vec![clip("语义桶短条", 900)],
            vec![clip("哦，我打住。", 1300), clip("嗯嗯，来。", 1200)],
        );
        for _ in 0..20 {
            let (text, _) = b.pick("随便聊聊", true, "t", 1).expect("boost 必播");
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
            let (text, _) = b.pick("随便聊聊", true, "t", 1).expect("boost 必播");
            assert_eq!(text, "合规条", "barge 桶内也要过 ≤barge_max_ms 保险丝");
            b.recent.clear();
        }
    }

    #[test]
    fn normal_turn_never_picks_barge() {
        let mut b =
            bank_with_barge(vec![clip("语义条", 900)], vec![clip("哦，我打住。", 1300)]);
        for _ in 0..40 {
            if let Some((text, _)) = b.pick("随便聊聊", false, "t", 1) {
                assert_eq!(text, "语义条", "普通轮永不选 barge 桶");
            }
            b.recent.clear();
        }
    }

    /// 测试面保留旧签名:默认允许 device 桶(生产由 device_filler_enabled_for(room) 决定)。
    fn pick_bucket(user_text: &str) -> &'static str {
        pick_bucket_with(user_text, true)
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

    /// D1 W3a:设备句落 device 桶;greet/thanks 仍优先;名单外(allow_device=false)按原优先级落桶;
    /// 负例=D0 实录误判句 + 含单字线索的闲聊,不得听到「这就调」。
    #[test]
    fn device_bucket_hints_and_gate() {
        for t in [
            "把灯弄亮一点吧", "太暗了看不清", "声音再大一点", "读写台升高一点", "帮我把灯调亮", "画面拉远一点",
            "灯光调暗一些", "调成夜读模式", "有点吵把音量调小", "虚像太近了", "光线太暗", "设备升高一点",
        ] {
            assert_eq!(pick_bucket(t), "device", "「{t}」");
        }
        for (t, expect) in [
            ("讲个月亮的故事", "task"), ("你的声音真好听", "gen"), ("我今年长高了一点", "gen"), ("班长", "gen"),
            ("对有一点像这个", "gen"), ("我今天好难过", "emo_neg"), ("给我讲个故事好不好", "task"), ("你好呀", "greet"),
            ("谢谢你", "thanks"), ("为什么天会黑", "ask"), ("我觉得还行", "opinion"), ("灯笼是什么", "ask"),
        ] {
            assert_eq!(pick_bucket(t), expect, "「{t}」");
        }
        // 名单外的房:device 判定整段跳过,原优先级不变
        assert_eq!(pick_bucket_with("帮我把灯调亮", false), "task");
        assert_eq!(pick_bucket_with("把灯弄亮一点吧", false), "gen");
        assert_eq!(pick_bucket_with("太暗了看不清", false), "gen");
        // device 桶概率恒 1.0(设备句必出承接音),与全局概率无关
        let b = FillerBank {
            clips: std::collections::HashMap::new(),
            probability: 0.1,
            style_probability: None,
            barge_max_ms: 1500,
            recent: VecDeque::new(),
        };
        assert_eq!(b.bucket_prob("device"), 1.0);
        assert_eq!(b.bucket_prob("gen"), 0.1);
        assert_eq!(b.bucket_prob("greet"), 0.5);
    }
}
