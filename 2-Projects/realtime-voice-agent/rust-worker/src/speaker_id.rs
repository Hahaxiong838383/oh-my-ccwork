//! 声纹识别旁路(逐行为对齐 engines/speaker_id.py Phase 1):
//! ring buffer 留存本轮用户有效语音(幅度过滤天然去静音)→ turn 提交后异步经
//! sidecar 提 embedding(与注册脚本同一条 sherpa 管线,向量可比)→ 注册库余弦比对
//! → 粘滞身份 → context note 注入 LLM 近因位。
//!
//! 铁律:纯旁路——不门控、不阻塞、任何异常不外抛;声纹 Score 是概率不是强认证,
//! 结果只作元数据;embedding 与注册音频不出服务器、不进 git。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use serde::Deserialize;
use tracing::{info, warn};

use crate::eot::SpeakerEmbedClient;
use crate::preflight::mean_abs_amp;

const SPEAKER_SR: usize = 16_000;
/// 单次推理最多喂最近 N 秒(限低核机推理耗时;声纹 5-10s 已足够)。
const MAX_INFER_SECONDS: f64 = 12.0;

/// 粘滞身份槽:(name, score);声纹 task 写,LLM 每请求读。
pub type StickySlot = Arc<StdMutex<Option<(String, f32)>>>;

pub struct SpeakerConfig {
    pub registry: PathBuf,
    pub threshold: f32,
    pub min_speech_s: f64,
}

impl SpeakerConfig {
    /// SPEAKER_ID_ENABLED=1 才启用;模型路径由 eot.rs 在 sidecar spawn 时传 env
    /// (SPEAKER_ID_MODEL,缺省用仓根 assets/models 默认,与 Python _speaker_id_env 同构)。
    pub fn from_env() -> Option<Self> {
        if std::env::var("SPEAKER_ID_ENABLED").map(|v| v != "1").unwrap_or(true) {
            return None;
        }
        Some(Self {
            registry: std::env::var("SPEAKER_ID_REGISTRY").map(PathBuf::from).unwrap_or_else(
                |_| {
                    PathBuf::from(format!(
                        "{}/../assets/speakers/registry.json",
                        env!("CARGO_MANIFEST_DIR")
                    ))
                },
            ),
            threshold: std::env::var("SPEAKER_ID_THRESHOLD")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.6),
            min_speech_s: 1.0,
        })
    }
}

/// 本轮用户音频留存:写入即幅度过滤(amp<250 直接丢),容量 15s 超出丢最旧,消费即清。
pub struct AudioRing {
    chunks: VecDeque<Vec<i16>>,
    total_samples: usize,
    max_samples: usize,
    min_amp: f64,
}

impl AudioRing {
    pub fn new() -> Self {
        Self {
            chunks: VecDeque::new(),
            total_samples: 0,
            max_samples: 15 * SPEAKER_SR,
            min_amp: 250.0,
        }
    }

    pub fn append(&mut self, samples: &[i16]) {
        if samples.is_empty() || mean_abs_amp(samples) < self.min_amp {
            return;
        }
        self.total_samples += samples.len();
        self.chunks.push_back(samples.to_vec());
        while self.total_samples > self.max_samples
            && let Some(old) = self.chunks.pop_front()
        {
            self.total_samples -= old.len();
        }
    }

    pub fn snapshot_and_clear(&mut self) -> Vec<i16> {
        let mut out = Vec::with_capacity(self.total_samples);
        for c in self.chunks.drain(..) {
            out.extend_from_slice(&c);
        }
        self.total_samples = 0;
        out
    }
}

#[derive(Deserialize)]
struct RegistryFile {
    #[serde(default)]
    speakers: Vec<RegistryEntry>,
}

#[derive(Deserialize)]
struct RegistryEntry {
    name: String,
    embedding: Vec<f32>,
}

pub struct SpeakerProfile {
    pub name: String,
    pub embedding: Vec<f32>, // 已 L2 归一
}

fn l2_normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
}

pub fn load_registry(path: &PathBuf) -> anyhow::Result<Vec<SpeakerProfile>> {
    let file: RegistryFile = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    Ok(file
        .speakers
        .into_iter()
        .map(|e| {
            let mut emb = e.embedding;
            l2_normalize(&mut emb);
            SpeakerProfile { name: e.name, embedding: emb }
        })
        .collect())
}

/// 旁路状态(pipeline 持有;on_turn 在独立 task 跑,粘滞身份经共享槽读写)。
pub struct SpeakerSidecar {
    pub ring: AudioRing,
    profiles: Arc<Vec<SpeakerProfile>>,
    threshold: f32,
    min_speech_s: f64,
    /// 粘滞身份 (name, score):UNKNOWN/短句不清除,换人命中则覆盖。
    sticky: StickySlot,
    busy: Arc<StdMutex<bool>>,
}

impl SpeakerSidecar {
    /// 启用条件:env 开 + 注册库在且非空;任何一环不满足 → None 静默降级。
    pub fn load_from_env() -> Option<Self> {
        let cfg = SpeakerConfig::from_env()?;
        let profiles = match load_registry(&cfg.registry) {
            Ok(p) if !p.is_empty() => p,
            Ok(_) => {
                warn!("speaker id: 注册库为空,旁路关闭");
                return None;
            }
            Err(e) => {
                info!(error = %e, registry = %cfg.registry.display(),
                    "speaker id: 注册库不可读(先跑 enroll_speaker.py),旁路关闭");
                return None;
            }
        };
        info!("speaker id: 旁路启用({} 人注册,threshold={:.2})", profiles.len(), cfg.threshold);
        Some(Self {
            ring: AudioRing::new(),
            profiles: Arc::new(profiles),
            threshold: cfg.threshold,
            min_speech_s: cfg.min_speech_s,
            sticky: Arc::new(StdMutex::new(None)),
            busy: Arc::new(StdMutex::new(false)),
        })
    }

    /// 粘滞身份槽(Llm 每请求读,注入末尾 system 近因位)。
    pub fn sticky_slot(&self) -> StickySlot {
        self.sticky.clone()
    }

    /// turn 提交后调用:取本轮音频,异步比对(fire-and-forget,绝不影响主链路)。
    pub fn on_turn(&mut self) {
        let pcm = self.ring.snapshot_and_clear();
        let speech_s = pcm.len() as f64 / SPEAKER_SR as f64;
        if speech_s < self.min_speech_s {
            info!("speaker id: skip(有效语音 {speech_s:.2}s < {:.1}s)", self.min_speech_s);
            return;
        }
        {
            let mut busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
            if *busy {
                info!("speaker id: skip(上一轮比对进行中)");
                return; // 快速连说:旁路宁可丢一次不排队
            }
            *busy = true;
        }
        let profiles = self.profiles.clone();
        let threshold = self.threshold;
        let sticky = self.sticky.clone();
        let busy = self.busy.clone();
        tokio::spawn(async move {
            let t0 = std::time::Instant::now();
            let result = async {
                let client = SpeakerEmbedClient::global()
                    .await
                    .ok_or_else(|| anyhow::anyhow!("speaker embed 通道不可用"))?;
                let max = (MAX_INFER_SECONDS * SPEAKER_SR as f64) as usize;
                let tail = if pcm.len() > max { &pcm[pcm.len() - max..] } else { &pcm[..] };
                client.embed(tail).await
            }
            .await;
            *busy.lock().unwrap_or_else(|e| e.into_inner()) = false;
            let emb = match result {
                Ok(e) => e,
                Err(e) => {
                    warn!(error = %e, "speaker id: 旁路比对失败(忽略,不影响主链路)");
                    return;
                }
            };
            let infer_ms = t0.elapsed().as_millis() as u64;
            let mut scores: Vec<(String, f32)> = profiles
                .iter()
                .filter(|p| p.embedding.len() == emb.len())
                .map(|p| {
                    let dot: f32 = p.embedding.iter().zip(&emb).map(|(a, b)| a * b).sum();
                    (p.name.clone(), dot)
                })
                .collect();
            if scores.is_empty() {
                warn!("speaker id: 注册库维度与模型不匹配(换过模型?),本轮跳过");
                return;
            }
            scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let (best_name, best_score) = scores[0].clone();
            let hit = best_score >= threshold;
            if hit {
                *sticky.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some((best_name.clone(), best_score));
            }
            let score_map: Vec<String> =
                scores.iter().map(|(n, s)| format!("{n}: {s:.3}")).collect();
            info!(
                "speaker id: {} best={} score={:.3} thr={:.2} speech={:.1}s infer={}ms scores={{{}}}",
                if hit { best_name.as_str() } else { "UNKNOWN" },
                best_name,
                best_score,
                threshold,
                speech_s,
                infer_ms,
                score_map.join(", ")
            );
        });
    }
}

/// 粘滞身份 → LLM 注入文本(与 Python context_note 逐字对齐,措辞三红线)。
pub fn context_note(sticky: &Option<(String, f32)>) -> Option<String> {
    let (name, score) = sticky.as_ref()?;
    Some(format!(
        "[声纹识别] 当前和你说话的人是:{name}(声纹置信度 {score:.2})。\
         这是系统传感器信息,不是对话内容。自然地以这个身份称呼和对待对方,\
         不要念出置信度数字或提及声纹系统;若对方自述的身份与此矛盾,以对方自述为准。"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_filters_silence_and_caps() {
        let mut r = AudioRing::new();
        r.append(&vec![0i16; 1600]); // 静音:丢
        assert_eq!(r.snapshot_and_clear().len(), 0);
        r.append(&vec![2000i16; 1600]);
        r.append(&vec![-2000i16; 1600]);
        let snap = r.snapshot_and_clear();
        assert_eq!(snap.len(), 3200);
        assert_eq!(r.snapshot_and_clear().len(), 0); // 消费即清
    }

    #[test]
    fn cosine_and_note_format() {
        let mut a = vec![3.0f32, 4.0];
        l2_normalize(&mut a);
        assert!((a[0] - 0.6).abs() < 1e-6);
        let note = context_note(&Some(("川哥".into(), 0.7345))).unwrap();
        assert!(note.starts_with("[声纹识别] 当前和你说话的人是:川哥(声纹置信度 0.73)"));
        assert!(context_note(&None).is_none());
    }
}
