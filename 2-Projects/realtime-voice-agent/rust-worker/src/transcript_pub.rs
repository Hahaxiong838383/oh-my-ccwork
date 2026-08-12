//! 字幕发布(对齐 Python room_io `_ParticipantLegacyTranscriptionOutput` 语义)。
//!
//! 走 legacy `publish_transcription` 数据包而非 lk.transcription 文本流:线上测试页
//! 的 livekit-client bundle(2.19.2, 47.239 /var/www/voice)零 lk.transcription 字符串,
//! `TranscriptionReceived` 只由 legacy 包触发(2026-08-12 实证)。
//!
//! 段语义(与 Python 逐项对齐):
//! - 段 id `SG_` 前缀;interim=同 id 全文 final=false;final=同 id final=true 后轮换新 id;
//! - start/end_time 恒 0,language 恒空;
//! - 包体 participant_identity/track_id = **被转写者**(用户句→用户 identity+用户麦克风轨,
//!   agent 句→agent identity+agent 出声轨),页面靠 participant.isAgent 分左右气泡;
//! - agent 侧按播出位置逐句发布(interim=句进入播出,final=句播完/打断截断),对齐
//!   TranscriptSynchronizer 的"字幕跟音频"体感;打断轮 final 文本=截断后的真实播出部分
//!   (Python flush 已推送部分同义)。与 Python 的微差:句内不做逐词爬行,整句一次出现。

use livekit::prelude::*;
use uuid::Uuid;

/// 字幕路由:被转写者三元组(identity+track sid),job 装配期采集。
#[derive(Clone)]
pub struct Route {
    pub agent_identity: String,
    pub agent_track_sid: String,
    pub user_identity: String,
    pub user_track_sid: String,
}

pub struct TranscriptPub {
    lp: LocalParticipant,
    route: Route,
    user_seg: String,
}

fn new_seg_id() -> String {
    let hex = Uuid::new_v4().simple().to_string();
    format!("SG_{}", &hex[..12])
}

impl TranscriptPub {
    pub fn new(lp: LocalParticipant, route: Route) -> Self {
        Self { lp, route, user_seg: new_seg_id() }
    }

    /// fire-and-forget 发布(与 metrics publish 同款:失败只 debug 不抛,不阻塞热路径)。
    fn publish(&self, identity: &str, track_sid: &str, id: &str, text: &str, fin: bool) {
        let lp = self.lp.clone();
        let packet = Transcription {
            participant_identity: identity.to_string(),
            track_id: track_sid.to_string(),
            segments: vec![TranscriptionSegment {
                id: id.to_string(),
                text: text.to_string(),
                start_time: 0,
                end_time: 0,
                r#final: fin,
                language: String::new(),
            }],
        };
        tokio::spawn(async move {
            if let Err(e) = lp.publish_transcription(packet).await {
                tracing::debug!(error = %e, "publish_transcription failed");
            }
        });
    }

    /// 用户 interim:同一段 id 上全文替换(火山 interim=当前句段完整快照,非增量)。
    pub fn user_interim(&mut self, text: &str) {
        self.publish(&self.route.user_identity, &self.route.user_track_sid, &self.user_seg, text, false);
    }

    /// 用户 definite:当前段收尾(final=true)并轮换段 id。
    pub fn user_final(&mut self, text: &str) {
        self.publish(&self.route.user_identity, &self.route.user_track_sid, &self.user_seg, text, true);
        self.user_seg = new_seg_id();
    }

    /// agent 句段:id 由调用方按 (turn, 句序) 稳定生成,interim/final 同 id。
    pub fn agent_segment(&self, turn_id: u64, idx: usize, text: &str, fin: bool) {
        let id = format!("SG_a{turn_id}_{idx}");
        self.publish(&self.route.agent_identity, &self.route.agent_track_sid, &id, text, fin);
    }
}

/// 一个 agent 句段:文本 + 在 synth_text 里的字符起点 + 播出样本区间。
#[derive(Debug, PartialEq)]
pub struct SentenceSpan {
    pub text: String,
    pub char_start: usize,
    pub start_samples: u64,
    pub end_samples: u64,
}

/// synth_text + progress(累计字符,累计样本) → 逐句 span。
/// 空文本条目(filler 只登记样本偏移)被跳过,但样本推进保留。
pub fn sentence_spans(synth: &str, progress: &[(usize, u64)]) -> Vec<SentenceSpan> {
    let chars: Vec<char> = synth.chars().collect();
    let mut out = Vec::new();
    let mut prev_chars = 0usize;
    let mut prev_samples = 0u64;
    for &(chars_cum, samples_cum) in progress {
        if chars_cum > prev_chars && chars_cum <= chars.len() {
            out.push(SentenceSpan {
                text: chars[prev_chars..chars_cum].iter().collect(),
                char_start: prev_chars,
                start_samples: prev_samples,
                end_samples: samples_cum,
            });
        }
        prev_chars = chars_cum;
        prev_samples = samples_cum;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_basic_two_sentences() {
        let synth = "你好呀今天天气不错";
        let progress = vec![(3, 2400), (9, 7200)];
        let spans = sentence_spans(synth, &progress);
        assert_eq!(spans.len(), 2);
        assert_eq!(
            spans[0],
            SentenceSpan { text: "你好呀".into(), char_start: 0, start_samples: 0, end_samples: 2400 }
        );
        assert_eq!(
            spans[1],
            SentenceSpan {
                text: "今天天气不错".into(),
                char_start: 3,
                start_samples: 2400,
                end_samples: 7200
            }
        );
    }

    #[test]
    fn spans_skip_filler_offset_entry() {
        // filler:track("", n) 只推进样本,句边界照常映射
        let synth = "回答正文";
        let progress = vec![(0, 12000), (4, 20000)];
        let spans = sentence_spans(synth, &progress);
        assert_eq!(spans.len(), 1);
        assert_eq!(
            spans[0],
            SentenceSpan {
                text: "回答正文".into(),
                char_start: 0,
                start_samples: 12000,
                end_samples: 20000
            }
        );
    }

    #[test]
    fn spans_empty_inputs() {
        assert!(sentence_spans("", &[(1, 100)]).is_empty());
        assert!(sentence_spans("文本", &[]).is_empty());
    }

    #[test]
    fn seg_id_shape() {
        let id = new_seg_id();
        assert!(id.starts_with("SG_") && id.len() == 15);
    }
}
