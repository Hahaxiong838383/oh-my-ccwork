//! silero VAD(ort 推理)+ 门控状态机。
//!
//! 模型 = livekit-plugins-silero 同款 silero_vad.onnx(v5),喂法对齐其 onnx_model.py:
//! 每帧 [1, 64(上帧尾 context)+512(新样本)] f32 + state[2,1,128] 循环 + sr 标量。
//! 门控参数对齐 tier_a_cascade._load_vad:activation_threshold(0.6)/
//! min_speech_duration(0.15s)/min_silence_duration(0.3s)。

use anyhow::Result;
use ort::session::Session;
use ort::value::Tensor;

pub const SAMPLE_RATE: usize = 16_000;
pub const WINDOW: usize = 512; // 32ms @16k
const CONTEXT: usize = 64;

pub struct SileroVad {
    session: Session,
    context: [f32; CONTEXT],
    state: Vec<f32>, // [2,1,128]
    input_buf: Vec<f32>,
}

impl SileroVad {
    pub fn load(model_path: &str) -> Result<Self> {
        // ort 的错误类型带 builder 状态、非 Send+Sync,不能直接 `?` 进 anyhow → 逐步 map 成文本
        let b = Session::builder().map_err(|e| anyhow::anyhow!("ort builder: {e}"))?;
        let b = b.with_intra_threads(1).map_err(|e| anyhow::anyhow!("ort intra: {e}"))?;
        let mut b = b.with_inter_threads(1).map_err(|e| anyhow::anyhow!("ort inter: {e}"))?;
        let session = b
            .commit_from_file(model_path)
            .map_err(|e| anyhow::anyhow!("load silero onnx {model_path}: {e}"))?;
        Ok(Self {
            session,
            context: [0.0; CONTEXT],
            state: vec![0.0; 2 * 128],
            input_buf: vec![0.0; CONTEXT + WINDOW],
        })
    }

    /// P3b 多段会话复位时接线。
    #[allow(dead_code)]
    pub fn reset(&mut self) {
        self.context = [0.0; CONTEXT];
        self.state.iter_mut().for_each(|v| *v = 0.0);
    }

    /// 一帧 512 个 i16 样本 → P(speech)。
    pub fn predict(&mut self, pcm: &[i16]) -> Result<f32> {
        anyhow::ensure!(pcm.len() == WINDOW, "vad 帧长需 {WINDOW},实际 {}", pcm.len());
        self.input_buf[..CONTEXT].copy_from_slice(&self.context);
        for (dst, &s) in self.input_buf[CONTEXT..].iter_mut().zip(pcm) {
            *dst = f32::from(s) / 32768.0;
        }
        let next_context: [f32; CONTEXT] =
            self.input_buf[self.input_buf.len() - CONTEXT..].try_into()?;

        let input = Tensor::from_array(([1usize, CONTEXT + WINDOW], self.input_buf.clone()))?;
        let state = Tensor::from_array(([2usize, 1, 128], self.state.clone()))?;
        let sr = Tensor::from_array((Vec::<usize>::new(), vec![SAMPLE_RATE as i64]))?;
        let outputs = self.session.run(ort::inputs![
            "input" => input,
            "state" => state,
            "sr" => sr,
        ])?;
        let (_, prob) = outputs["output"].try_extract_tensor::<f32>()?;
        let p = prob.first().copied().unwrap_or(0.0);
        let (_, new_state) = outputs["stateN"].try_extract_tensor::<f32>()?;
        self.state.copy_from_slice(new_state);
        self.context = next_context;
        Ok(p)
    }
}

/// speech start/end 门控(帧级状态机,参数语义对齐 livekit silero plugin)。
pub struct VadGate {
    pub activation_threshold: f32,
    pub min_speech_frames: u32,
    pub min_silence_frames: u32,
    speaking: bool,
    speech_run: u32,
    silence_run: u32,
    segment_speech_frames: u32, // 本说话段累计语音帧(打断时长门 min_interruption_duration)
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum VadEvent {
    None,
    SpeechStart,
    SpeechEnd,
}

impl VadGate {
    pub fn new(activation_threshold: f32, min_speech_s: f32, min_silence_s: f32) -> Self {
        let frame_s = WINDOW as f32 / SAMPLE_RATE as f32; // 0.032
        Self {
            activation_threshold,
            min_speech_frames: (min_speech_s / frame_s).ceil() as u32,
            min_silence_frames: (min_silence_s / frame_s).ceil() as u32,
            speaking: false,
            speech_run: 0,
            silence_run: 0,
            segment_speech_frames: 0,
        }
    }

    pub fn speaking(&self) -> bool {
        self.speaking
    }

    const FRAME_S: f32 = WINDOW as f32 / SAMPLE_RATE as f32; // 0.032

    /// 本说话段累计语音时长(对齐 VADEvent.speech_duration,打断时长门用)。
    pub fn speech_dur_s(&self) -> f32 {
        self.segment_speech_frames as f32 * Self::FRAME_S
    }

    /// 当前连续静音时长(说话中累积 ≥200ms 触发 EOT 预测)。
    pub fn silence_dur_s(&self) -> f32 {
        self.silence_run as f32 * Self::FRAME_S
    }

    /// END_OF_SPEECH 触发时已含的静音窗(锚点回溯量,对齐框架 last_speaking_time 回算)。
    pub fn min_silence_s(&self) -> f32 {
        self.min_silence_frames as f32 * Self::FRAME_S
    }

    pub fn feed(&mut self, prob: f32) -> VadEvent {
        let active = prob >= self.activation_threshold;
        if active {
            self.speech_run += 1;
            self.silence_run = 0;
            if self.speaking {
                self.segment_speech_frames += 1;
            }
            if !self.speaking && self.speech_run >= self.min_speech_frames {
                self.speaking = true;
                self.segment_speech_frames = self.speech_run; // 起说前的 run-up 计入段时长
                return VadEvent::SpeechStart;
            }
        } else {
            self.silence_run += 1;
            self.speech_run = 0;
            if self.speaking && self.silence_run >= self.min_silence_frames {
                self.speaking = false;
                self.segment_speech_frames = 0;
                return VadEvent::SpeechEnd;
            }
        }
        VadEvent::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_requires_min_speech_then_min_silence() {
        // 0.15s/0.3s @32ms 帧 → 5 帧起说,10 帧收声
        let mut g = VadGate::new(0.6, 0.15, 0.3);
        for _ in 0..4 {
            assert_eq!(g.feed(0.9), VadEvent::None);
        }
        assert_eq!(g.feed(0.9), VadEvent::SpeechStart);
        assert!(g.speaking());
        for _ in 0..9 {
            assert_eq!(g.feed(0.1), VadEvent::None);
        }
        assert_eq!(g.feed(0.1), VadEvent::SpeechEnd);
        assert!(!g.speaking());
    }

    #[test]
    fn short_noise_burst_ignored() {
        let mut g = VadGate::new(0.6, 0.15, 0.3);
        for _ in 0..3 {
            assert_eq!(g.feed(0.95), VadEvent::None);
        }
        // 断掉:speech_run 归零,不触发 start
        assert_eq!(g.feed(0.1), VadEvent::None);
        assert!(!g.speaking());
    }

    /// 真模型冒烟:静音帧概率应显著低于 0.5(需 assets/silero_vad.onnx)。
    #[test]
    fn silero_silence_prob_low() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/silero_vad.onnx");
        let mut vad = SileroVad::load(path).expect("load model");
        let silence = vec![0i16; WINDOW];
        let mut last = 1.0;
        for _ in 0..5 {
            last = vad.predict(&silence).expect("predict");
        }
        assert!(last < 0.5, "silence prob should be low, got {last}");
    }
}
