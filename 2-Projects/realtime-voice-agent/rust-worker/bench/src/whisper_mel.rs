//! Whisper 风格 log-mel(Smart Turn v3 预处理)——逐行移植 Pipecat vendored
//! `_whisper_features.py`(其自身 vendored 自 transformers WhisperFeatureExtractor,
//! chunk_length=8, do_normalize=True)。
//!
//! 数值口径与 reference 严格对齐,这是三绿②(mel 数值对拍)的被测侧:
//! - 波形 zero-mean/unit-var 归一化在 **f32** 做(reference 注释明确其精度层),
//!   但 mean/var 的累加用 f64(numpy pairwise 累加精度与 f64 同量级);
//! - STFT 起全程 **f64**(reference "promotes to float64 internally"),最后才转 f32;
//! - periodic hann(np.hanning(N+1)[:-1]),reflect pad n_fft/2,center 式分帧;
//! - Slaney mel 刻度 + Slaney 面积归一化(⚠️ 不是 HTK——错了不报错只错标定);
//! - log10 → 丢最后一帧(801→800) → clamp(max-8) → (x+4)/4。
//!
//! 没用 mel-spec crate:它是流式 f32 设计,无波形归一化/无 Whisper 后处理,
//! 「配置对」达不到 reference 口径;此处 176 行 reference 全透明,移植面更小,
//! 正确性由数值对拍闭环兜住(见 bench/gen_parity_refs.py)。

use std::sync::Arc;

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};

pub const SR: usize = 16_000;
pub const N_FFT: usize = 400;
pub const HOP: usize = 160;
pub const N_MELS: usize = 80;
pub const N_SAMPLES_8S: usize = SR * 8; // 128000
pub const N_FRAMES: usize = N_SAMPLES_8S / HOP; // 800(drop 尾帧后)
const N_FREQ: usize = N_FFT / 2 + 1; // 201
const MEL_FLOOR: f64 = 1e-10;
const NORM_VAR_EPS: f32 = 1e-7;

/// >8s 取尾、<8s 左 pad 零(local_smart_turn_v3.truncate_audio_to_last_n_seconds 同款)。
pub fn pad_or_trunc_8s(f32in: &[f32]) -> Vec<f32> {
    let n = f32in.len();
    if n >= N_SAMPLES_8S {
        f32in[n - N_SAMPLES_8S..].to_vec()
    } else {
        let mut out = vec![0.0f32; N_SAMPLES_8S];
        out[N_SAMPLES_8S - n..].copy_from_slice(f32in);
        out
    }
}

fn hertz_to_mel_slaney(freq: f64) -> f64 {
    let min_log_hertz = 1000.0;
    let min_log_mel = 15.0;
    let logstep = 27.0 / 6.4f64.ln();
    if freq >= min_log_hertz {
        min_log_mel + (freq / min_log_hertz).ln() * logstep
    } else {
        3.0 * freq / 200.0
    }
}

fn mel_to_hertz_slaney(mel: f64) -> f64 {
    let min_log_hertz = 1000.0;
    let min_log_mel = 15.0;
    let logstep = 6.4f64.ln() / 27.0;
    if mel >= min_log_mel {
        min_log_hertz * (logstep * (mel - min_log_mel)).exp()
    } else {
        200.0 * mel / 3.0
    }
}

fn linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
    (0..n).map(|i| a + (b - a) * i as f64 / (n - 1) as f64).collect()
}

/// Slaney 归一化三角滤波器组,`filters[m][k]`(m=mel 0..80, k=freq bin 0..201)。
/// reference 存 (n_freq, n_mels) 再 `filters.T @ mag`;这里直接存转置后的布局。
fn build_mel_filterbank() -> Vec<[f64; N_FREQ]> {
    let mel_min = hertz_to_mel_slaney(0.0);
    let mel_max = hertz_to_mel_slaney(SR as f64 / 2.0);
    let mel_freqs = linspace(mel_min, mel_max, N_MELS + 2);
    let filter_freqs: Vec<f64> = mel_freqs.into_iter().map(mel_to_hertz_slaney).collect();
    let fft_freqs = linspace(0.0, (SR / 2) as f64, N_FREQ);

    let mut filters = vec![[0.0f64; N_FREQ]; N_MELS];
    for m in 0..N_MELS {
        let left = filter_freqs[m];
        let center = filter_freqs[m + 1];
        let right = filter_freqs[m + 2];
        let enorm = 2.0 / (right - left);
        for k in 0..N_FREQ {
            let down = (fft_freqs[k] - left) / (center - left);
            let up = (right - fft_freqs[k]) / (right - center);
            filters[m][k] = down.min(up).max(0.0) * enorm;
        }
    }
    filters
}

pub struct WhisperMel {
    fft: Arc<dyn RealToComplex<f64>>,
    window: Vec<f64>, // periodic hann, len 400
    filters: Vec<[f64; N_FREQ]>,
}

impl Default for WhisperMel {
    fn default() -> Self {
        Self::new()
    }
}

impl WhisperMel {
    pub fn new() -> Self {
        let mut planner = RealFftPlanner::<f64>::new();
        // periodic hann = np.hanning(N+1)[:-1]:w[n] = 0.5 - 0.5*cos(2πn/N)
        let window: Vec<f64> = (0..N_FFT)
            .map(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / N_FFT as f64).cos())
            .collect();
        Self { fft: planner.plan_fft_forward(N_FFT), window, filters: build_mel_filterbank() }
    }

    /// 输入恰好 128000 样本(f32,调用方先过 pad_or_trunc_8s)→ [80*800] f32(行主序)。
    pub fn compute(&self, audio_8s: &[f32], do_normalize: bool) -> Vec<f32> {
        assert_eq!(audio_8s.len(), N_SAMPLES_8S, "caller must pad/trunc to 8s first");

        // 波形归一化(f32 层,mean/var 用 f64 累加对齐 numpy pairwise 精度)
        let x: Vec<f32> = if do_normalize {
            let mean = (audio_8s.iter().map(|&v| v as f64).sum::<f64>() / audio_8s.len() as f64) as f32;
            let var = (audio_8s.iter().map(|&v| (v - mean) as f64 * (v - mean) as f64).sum::<f64>()
                / audio_8s.len() as f64) as f32;
            let denom = (var + NORM_VAR_EPS).sqrt();
            audio_8s.iter().map(|&v| (v - mean) / denom).collect()
        } else {
            audio_8s.to_vec()
        };

        // reflect pad n_fft/2 两侧(numpy 'reflect':不重复端点)
        let pad = N_FFT / 2;
        let n = x.len();
        let mut padded = vec![0.0f64; n + 2 * pad];
        for i in 0..pad {
            padded[i] = x[pad - i] as f64;
            padded[n + pad + i] = x[n - 2 - i] as f64;
        }
        for i in 0..n {
            padded[pad + i] = x[i] as f64;
        }

        // 分帧 STFT:801 帧 |rfft|²
        let n_frames_full = (padded.len() - N_FFT) / HOP + 1; // 801
        let mut power = vec![0.0f64; N_FREQ * n_frames_full]; // [k][t] 布局:k*n_frames+t
        let mut buf = vec![0.0f64; N_FFT];
        let mut spec = vec![Complex::default(); N_FREQ];
        let mut scratch = self.fft.make_scratch_vec();
        for t in 0..n_frames_full {
            let start = t * HOP;
            for i in 0..N_FFT {
                buf[i] = padded[start + i] * self.window[i];
            }
            self.fft.process_with_scratch(&mut buf, &mut spec, &mut scratch).expect("rfft");
            for k in 0..N_FREQ {
                power[k * n_frames_full + t] = spec[k].norm_sqr();
            }
        }

        // mel 投影 + floor + log10(f64),drop 尾帧 → [80][800]
        let mut log_mel = vec![0.0f64; N_MELS * N_FRAMES];
        for m in 0..N_MELS {
            let fr = &self.filters[m];
            for t in 0..N_FRAMES {
                let mut acc = 0.0f64;
                for k in 0..N_FREQ {
                    acc += fr[k] * power[k * n_frames_full + t];
                }
                log_mel[m * N_FRAMES + t] = acc.max(MEL_FLOOR).log10();
            }
        }

        // clamp(max-8) → (x+4)/4 → f32
        let max = log_mel.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        log_mel.iter().map(|&v| ((v.max(max - 8.0) + 4.0) / 4.0) as f32).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filterbank_rows_are_nonnegative_and_mostly_nonzero() {
        let f = build_mel_filterbank();
        assert_eq!(f.len(), N_MELS);
        let nonzero_rows = f.iter().filter(|row| row.iter().any(|&v| v > 0.0)).count();
        assert_eq!(nonzero_rows, N_MELS, "every mel filter must have support");
        assert!(f.iter().flatten().all(|&v| v >= 0.0));
    }

    #[test]
    fn pad_left_and_trunc_tail() {
        let short = vec![1.0f32; 100];
        let p = pad_or_trunc_8s(&short);
        assert_eq!(p.len(), N_SAMPLES_8S);
        assert_eq!(p[N_SAMPLES_8S - 1], 1.0);
        assert_eq!(p[0], 0.0);

        let long = (0..N_SAMPLES_8S + 50).map(|i| i as f32).collect::<Vec<_>>();
        let t = pad_or_trunc_8s(&long);
        assert_eq!(t[0], 50.0, "keep the tail");
    }
}
