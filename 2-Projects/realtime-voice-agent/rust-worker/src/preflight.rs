//! S1 v3 投机重叠触发器(逐语义对齐 volc_stt._pf_on_frame/_pf_should_fire):
//! 触发时钟挂用户音频——「连续静音 ≥ silence_ms」+「尾句 interim 文本静止 ≥ quiet_ms」
//! +「interim 最后一次更新落在静音期内」三条件即 fire,提前跑 LLM 藏进判停。
//! 每句段一次(definite 提交后重置);VOLC_PREFLIGHT_ENABLED=0 整体关闭。

pub struct PreflightConfig {
    pub enabled: bool,
    pub silence_ms: f64,
    pub text_quiet_ms: f64,
    pub silence_amp: f64,
}

impl PreflightConfig {
    pub fn from_env() -> Self {
        let f = |k: &str, d: f64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        Self {
            enabled: std::env::var("VOLC_PREFLIGHT_ENABLED").map(|v| v == "1").unwrap_or(true),
            silence_ms: f("VOLC_PREFLIGHT_SILENCE_MS", 180.0),
            text_quiet_ms: f("VOLC_PREFLIGHT_TEXT_QUIET_MS", 150.0),
            silence_amp: f("VOLC_PREFLIGHT_SILENCE_AMP", 250.0),
        }
    }
}

/// PCM16 帧平均绝对幅度(说话 ~1000+,底噪/静音 <~200)。
pub fn mean_abs_amp(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: u64 = samples.iter().map(|&s| (i32::from(s)).unsigned_abs() as u64).sum();
    sum as f64 / samples.len() as f64
}

/// 触发判定(纯函数,对齐 _pf_should_fire 四条件)。
pub fn should_fire(
    tail_nonempty: bool,
    silence_since_ms: Option<f64>,
    last_change_ms: f64,
    now_ms: f64,
    silence_ms: f64,
    text_quiet_ms: f64,
) -> bool {
    let Some(since) = silence_since_ms else { return false };
    tail_nonempty
        && (now_ms - since) >= silence_ms
        && (now_ms - last_change_ms) >= text_quiet_ms
        && last_change_ms >= since
}

pub struct PreflightGate {
    cfg: PreflightConfig,
    silence_since_ms: Option<f64>,
    last_text: String,
    last_change_ms: f64,
    sent: bool,
}

impl PreflightGate {
    pub fn new(cfg: PreflightConfig) -> Self {
        Self { cfg, silence_since_ms: None, last_text: String::new(), last_change_ms: 0.0, sent: false }
    }

    /// interim 更新(canonical 文本)。
    pub fn on_interim(&mut self, text: &str, now_ms: f64) {
        if !self.cfg.enabled || text.is_empty() || text == self.last_text {
            return;
        }
        self.last_text = text.to_string();
        self.last_change_ms = now_ms;
    }

    /// definite 提交后:下个句段重新允许投机,静音起点清零(防 definite 间隙误触发)。
    pub fn reset(&mut self) {
        self.last_text.clear();
        self.last_change_ms = 0.0;
        self.silence_since_ms = None;
        self.sent = false;
    }

    /// 逐帧喂音频;fire 时返回 (投机文本, 静音时长ms, 文本静止时长ms)。
    pub fn on_frame(&mut self, samples: &[i16], now_ms: f64) -> Option<(String, f64, f64)> {
        if !self.cfg.enabled || self.sent {
            return None;
        }
        if mean_abs_amp(samples) >= self.cfg.silence_amp {
            self.silence_since_ms = None; // 出声中,静音计时清零
            return None;
        }
        let since = *self.silence_since_ms.get_or_insert(now_ms);
        if since == now_ms {
            return None;
        }
        if should_fire(
            !self.last_text.is_empty(),
            self.silence_since_ms,
            self.last_change_ms,
            now_ms,
            self.cfg.silence_ms,
            self.cfg.text_quiet_ms,
        ) {
            self.sent = true;
            return Some((self.last_text.clone(), now_ms - since, now_ms - self.last_change_ms));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> PreflightConfig {
        PreflightConfig { enabled: true, silence_ms: 180.0, text_quiet_ms: 150.0, silence_amp: 250.0 }
    }

    #[test]
    fn fires_after_silence_and_text_quiet() {
        let mut g = PreflightGate::new(cfg());
        let loud = vec![2000i16; 160];
        let quiet = vec![10i16; 160];
        g.on_frame(&loud, 0.0); // 说话中
        g.on_interim("今天天气", 100.0);
        // 静音从 110ms 起累积;interim 更新落在静音期内(120ms)
        assert!(g.on_frame(&quiet, 110.0).is_none());
        g.on_interim("今天天气怎么样", 120.0);
        assert!(g.on_frame(&quiet, 200.0).is_none()); // 静音 90ms 不够
        let fired = g.on_frame(&quiet, 300.0); // 静音 190ms + 文本静止 180ms
        let (text, sil, quiet_ms) = fired.expect("fire");
        assert_eq!(text, "今天天气怎么样");
        assert!(sil >= 180.0 && quiet_ms >= 150.0);
        // 每句段只 fire 一次
        assert!(g.on_frame(&vec![10i16; 160], 400.0).is_none());
    }

    #[test]
    fn stale_interim_before_silence_never_fires() {
        // Python 条件④:interim 最后更新早于静音起点=火山滞后半句,不可信
        let mut g = PreflightGate::new(cfg());
        g.on_interim("半句", 50.0);
        let quiet = vec![0i16; 160];
        g.on_frame(&quiet, 100.0); // 静音起点 100ms > last_change 50ms
        assert!(g.on_frame(&quiet, 400.0).is_none());
    }

    #[test]
    fn speech_resets_silence_clock() {
        let mut g = PreflightGate::new(cfg());
        g.on_interim("你好", 10.0);
        let quiet = vec![0i16; 160];
        let loud = vec![3000i16; 160];
        g.on_frame(&quiet, 20.0);
        g.on_frame(&loud, 100.0); // 又出声:静音计时清零
        assert!(g.on_frame(&quiet, 120.0).is_none()); // 新静音窗起点 120
        // 火山停说后补回调的尾字更新落在静音期内(条件④)
        g.on_interim("你好呀", 130.0);
        assert!(g.on_frame(&quiet, 250.0).is_none()); // 静音仅 130ms 不够
        assert!(g.on_frame(&quiet, 310.0).is_some()); // 静音 190ms+文本静止 180ms
    }
}
