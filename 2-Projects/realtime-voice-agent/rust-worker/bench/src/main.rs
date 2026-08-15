//! EOT ONNX 迁移原型 bench(独立 crate,不接生产链路,任务书
//! docs/EOT-ONNX-MIGRATION-BRIEF.md §十;报告 docs/EOT-ONNX-PROTOTYPE-REPORT.md)。
//!
//! 两个构建 variant(step 0 单 ORT 对拍的两侧):
//! - 默认:ort bundled(编译期下载的 ORT,rc.13 → 1.28.0)
//! - `--features ort-load-dynamic`:运行时 dlopen `ORT_DYLIB_PATH`
//!   (指 sherpa 自带 libonnxruntime.so.1.24.4 即单 ORT 方案的运行时)
//!
//! 子命令:
//!   info                                   打印 variant/ORT 加载证据(/proc/self/maps)
//!   silero-parity --model M --frames N [--wav W] --out F
//!                                          silero 概率序列位精确输出(两 variant 对拍)
//!   mel-parity --refs D --models D         三绿②:mel 与概率对拍 python reference
//!   infer --model M --wav W                单发推理打印概率
//!   bench --model M --wav W [--n N]        三绿③:延迟分布(mel/infer 拆开)+loadavg
//!   eval --model M --manifest F --out F    评测集批量出概率(step 2)

mod whisper_mel;

use std::io::Write as _;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use ort::session::Session;
use ort::value::Tensor;
use whisper_mel::{N_FRAMES, N_MELS, N_SAMPLES_8S, SR, WhisperMel, pad_or_trunc_8s};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("help");
    match cmd {
        "info" => info(),
        "silero-parity" => silero_parity(&args[2..]),
        "mel-parity" => mel_parity(&args[2..]),
        "infer" => infer(&args[2..]),
        "bench" => bench(&args[2..]),
        "eval" => eval(&args[2..]),
        _ => {
            eprintln!("usage: eotbench <info|silero-parity|mel-parity|infer|bench|eval> ...");
            std::process::exit(2);
        }
    }
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
}

fn variant() -> &'static str {
    if cfg!(feature = "ort-load-dynamic") { "load-dynamic" } else { "bundled" }
}

/// 加载证据:实际映射进进程的 onnxruntime so(Linux)。bundled(静态链入)则无独立 so 行。
fn loaded_ort_libs() -> Vec<String> {
    if cfg!(target_os = "linux") {
        std::fs::read_to_string("/proc/self/maps")
            .map(|m| {
                let mut libs: Vec<String> = m
                    .lines()
                    .filter(|l| l.contains("onnxruntime"))
                    .filter_map(|l| l.split_whitespace().last().map(String::from))
                    .collect();
                libs.dedup();
                libs
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    }
}

fn info() -> Result<()> {
    println!("variant: {}", variant());
    println!("ORT_DYLIB_PATH: {:?}", std::env::var("ORT_DYLIB_PATH").ok());
    // 触发 ort 惰性初始化(load-dynamic 下即 dlopen;失败会 panic,这正是我们要的信号)
    let _ = ort::api();
    println!("ort api: initialized");
    for l in loaded_ort_libs() {
        println!("mapped: {l}");
    }
    Ok(())
}

fn read_wav_16k_mono(path: &str) -> Result<Vec<i16>> {
    let mut r = hound::WavReader::open(path).with_context(|| format!("open wav {path}"))?;
    let spec = r.spec();
    anyhow::ensure!(
        spec.sample_rate == SR as u32 && spec.channels == 1 && spec.bits_per_sample == 16,
        "expect 16k mono s16 wav, got {spec:?} ({path})"
    );
    Ok(r.samples::<i16>().collect::<std::result::Result<Vec<_>, _>>()?)
}

fn pcm_to_f32(pcm: &[i16]) -> Vec<f32> {
    pcm.iter().map(|&s| f32::from(s) / 32768.0).collect()
}

// ---------- smart-turn ----------

struct SmartTurn {
    session: Session,
    mel: WhisperMel,
}

impl SmartTurn {
    fn load(model_path: &str) -> Result<Self> {
        let b = Session::builder().map_err(|e| anyhow::anyhow!("ort builder: {e}"))?;
        let b = b.with_intra_threads(1).map_err(|e| anyhow::anyhow!("ort intra: {e}"))?;
        let mut b = b.with_inter_threads(1).map_err(|e| anyhow::anyhow!("ort inter: {e}"))?;
        let session = b
            .commit_from_file(model_path)
            .map_err(|e| anyhow::anyhow!("load smart-turn onnx {model_path}: {e}"))?;
        Ok(Self { session, mel: WhisperMel::new() })
    }

    /// 任意长 f32 PCM → (P(complete), mel 耗时, 推理耗时)。管线与 Pipecat
    /// _predict_endpoint 对齐:pad/trunc 8s → log-mel(normalize) → onnx。
    fn predict(&mut self, pcm_f32: &[f32]) -> Result<(f32, Duration, Duration)> {
        let t0 = Instant::now();
        let padded = pad_or_trunc_8s(pcm_f32);
        let mel = self.mel.compute(&padded, true);
        let t_mel = t0.elapsed();

        let t1 = Instant::now();
        let input = Tensor::from_array(([1usize, N_MELS, N_FRAMES], mel))?;
        let outputs = self.session.run(ort::inputs!["input_features" => input])?;
        let (_, data) = outputs["logits"].try_extract_tensor::<f32>()?;
        let prob = *data.first().context("empty logits output")?;
        Ok((prob, t_mel, t1.elapsed()))
    }
}

fn infer(args: &[String]) -> Result<()> {
    let model = flag(args, "--model").context("--model required")?;
    let wav = flag(args, "--wav").context("--wav required")?;
    let pcm = read_wav_16k_mono(wav)?;
    let mut st = SmartTurn::load(model)?;
    let (prob, t_mel, t_inf) = st.predict(&pcm_to_f32(&pcm))?;
    println!(
        "prob={prob:.6} hex={:#010x} mel={:.2}ms infer={:.2}ms variant={}",
        prob.to_bits(),
        t_mel.as_secs_f64() * 1e3,
        t_inf.as_secs_f64() * 1e3,
        variant()
    );
    Ok(())
}

// ---------- mel parity(三绿②) ----------

fn mel_parity(args: &[String]) -> Result<()> {
    let refs_dir = flag(args, "--refs").context("--refs required")?;
    let models_dir = flag(args, "--models").context("--models required")?;
    let refs: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{refs_dir}/refs.json"))?)?;
    let mel_engine = WhisperMel::new();
    let mut st_official = SmartTurn::load(&format!("{models_dir}/smart-turn-v3.2-cpu.onnx"))?;
    let mut st_zh = SmartTurn::load(&format!("{models_dir}/smart-turn-zh-cpu.onnx"))?;

    let mut all_pass = true;
    let mut worst_mel = 0.0f32;
    let mut worst_prob = 0.0f32;
    let cases = refs.as_object().context("refs.json not an object")?;
    anyhow::ensure!(!cases.is_empty(), "refs.json has zero cases");
    println!("case                mel_max_abs_diff  d_prob_official  d_prob_zh  verdict");
    for (name, meta) in cases {
        let pcm = read_wav_16k_mono(&format!("{refs_dir}/{name}.wav"))?;
        let f = pcm_to_f32(&pcm);
        let padded = pad_or_trunc_8s(&f);
        let mel = mel_engine.compute(&padded, true);

        let ref_bytes = std::fs::read(format!("{refs_dir}/{name}.mel.f32"))?;
        anyhow::ensure!(ref_bytes.len() == N_MELS * N_FRAMES * 4, "ref mel size mismatch {name}");
        let ref_mel: Vec<f32> = ref_bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        let mel_diff = mel
            .iter()
            .zip(&ref_mel)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);

        let (p_off, _, _) = st_official.predict(&f)?;
        let (p_zh, _, _) = st_zh.predict(&f)?;
        let ref_off = meta["official"]["prob"].as_f64().context("ref prob official")? as f32;
        let ref_zh = meta["zh"]["prob"].as_f64().context("ref prob zh")? as f32;
        let d_off = (p_off - ref_off).abs();
        let d_zh = (p_zh - ref_zh).abs();

        // 门:mel 1e-4(f32 管线 vs f64-内核 reference 的浮点噪声上限)、prob 1e-3
        // (int8 量化图对输入扰动的放大上限,实测远低于此;报告记实际值)
        let pass = mel_diff < 1e-4 && d_off < 1e-3 && d_zh < 1e-3;
        all_pass &= pass;
        worst_mel = worst_mel.max(mel_diff);
        worst_prob = worst_prob.max(d_off).max(d_zh);
        println!(
            "{name:<20} {mel_diff:>14.3e} {d_off:>16.3e} {d_zh:>10.3e}  {}",
            if pass { "PASS" } else { "FAIL" }
        );
    }
    println!(
        "overall: {} (worst mel diff {worst_mel:.3e}, worst prob diff {worst_prob:.3e}, variant {})",
        if all_pass { "PASS" } else { "FAIL" },
        variant()
    );
    if !all_pass {
        std::process::exit(1);
    }
    Ok(())
}

// ---------- silero parity(step 0) ----------

/// 确定性伪随机(xorshift64*):两 variant/两机器上逐位相同的输入序列。
struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn next_i16_quiet(&mut self) -> i16 {
        // 低幅噪声(±2048)混合正弦,概率轨迹更有起伏
        (self.next() % 4096) as i16 - 2048
    }
}

/// 复刻 src/vad.rs SileroVad 的调用序列(builder/intra1/inter1/context64/state128)。
/// 不复用主 crate 模块(无 lib target);对拍对象是 ort 运行时行为,调用序列一致即可。
struct Silero {
    session: Session,
    context: [f32; 64],
    state: Vec<f32>,
    input_buf: Vec<f32>,
}

impl Silero {
    const WINDOW: usize = 512;
    fn load(model_path: &str) -> Result<Self> {
        let b = Session::builder().map_err(|e| anyhow::anyhow!("ort builder: {e}"))?;
        let b = b.with_intra_threads(1).map_err(|e| anyhow::anyhow!("ort intra: {e}"))?;
        let mut b = b.with_inter_threads(1).map_err(|e| anyhow::anyhow!("ort inter: {e}"))?;
        let session = b
            .commit_from_file(model_path)
            .map_err(|e| anyhow::anyhow!("load silero onnx {model_path}: {e}"))?;
        Ok(Self { session, context: [0.0; 64], state: vec![0.0; 2 * 128], input_buf: vec![0.0; 64 + 512] })
    }

    fn predict(&mut self, pcm: &[i16]) -> Result<f32> {
        anyhow::ensure!(pcm.len() == Self::WINDOW);
        self.input_buf[..64].copy_from_slice(&self.context);
        for (dst, &s) in self.input_buf[64..].iter_mut().zip(pcm) {
            *dst = f32::from(s) / 32768.0;
        }
        let next_context: [f32; 64] = self.input_buf[self.input_buf.len() - 64..].try_into()?;
        let input = Tensor::from_array(([1usize, 64 + 512], self.input_buf.clone()))?;
        let state = Tensor::from_array(([2usize, 1, 128], self.state.clone()))?;
        let sr = Tensor::from_array((Vec::<usize>::new(), vec![SR as i64]))?;
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

fn silero_parity(args: &[String]) -> Result<()> {
    let model = flag(args, "--model").context("--model required")?;
    let n_frames: usize = flag(args, "--frames").unwrap_or("500").parse()?;
    let out_path = flag(args, "--out").context("--out required")?;
    let mut vad = Silero::load(model)?;
    let mut out = std::io::BufWriter::new(std::fs::File::create(out_path)?);

    writeln!(out, "# variant={} model={model}", variant())?;
    let mut rng = XorShift(0x20260815);
    for i in 0..n_frames {
        let frame: Vec<i16> = (0..Silero::WINDOW)
            .map(|j| {
                let t = (i * Silero::WINDOW + j) as f32 / SR as f32;
                let tone = if (i / 50) % 2 == 0 {
                    (2.0 * std::f32::consts::PI * 220.0 * t).sin() * 6000.0
                } else {
                    0.0
                };
                (tone as i16).saturating_add(rng.next_i16_quiet())
            })
            .collect();
        let p = vad.predict(&frame)?;
        writeln!(out, "{i}\t{:#010x}\t{p:.6}", p.to_bits())?;
    }
    if let Some(wav) = flag(args, "--wav") {
        let pcm = read_wav_16k_mono(wav)?;
        for (i, chunk) in pcm.chunks_exact(Silero::WINDOW).enumerate() {
            let p = vad.predict(chunk)?;
            writeln!(out, "wav{i}\t{:#010x}\t{p:.6}", p.to_bits())?;
        }
    }
    println!("wrote {out_path} ({} synthetic frames, variant {})", n_frames, variant());
    Ok(())
}

// ---------- bench(三绿③) ----------

fn percentile(sorted_ms: &[f64], p: f64) -> f64 {
    let idx = ((sorted_ms.len() as f64) * p / 100.0).ceil() as usize;
    sorted_ms[idx.clamp(1, sorted_ms.len()) - 1]
}

fn bench(args: &[String]) -> Result<()> {
    let model = flag(args, "--model").context("--model required")?;
    let wav = flag(args, "--wav").context("--wav required")?;
    let n: usize = flag(args, "--n").unwrap_or("100").parse()?;
    let pcm = pcm_to_f32(&read_wav_16k_mono(wav)?);
    let mut st = SmartTurn::load(model)?;

    let (p, _, _) = st.predict(&pcm)?; // warmup(session 首跑含图优化/内存分配)
    let mut mel_ms = Vec::with_capacity(n);
    let mut inf_ms = Vec::with_capacity(n);
    let mut tot_ms = Vec::with_capacity(n);
    for _ in 0..n {
        let t0 = Instant::now();
        let (_, m, i) = st.predict(&pcm)?;
        tot_ms.push(t0.elapsed().as_secs_f64() * 1e3);
        mel_ms.push(m.as_secs_f64() * 1e3);
        inf_ms.push(i.as_secs_f64() * 1e3);
    }
    for v in [&mut mel_ms, &mut inf_ms, &mut tot_ms] {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    }
    println!("model={model} n={n} warmup_prob={p:.6} variant={}", variant());
    for (label, v) in [("mel  ", &mel_ms), ("infer", &inf_ms), ("total", &tot_ms)] {
        println!(
            "{label}: p50={:.2}ms p95={:.2}ms p99={:.2}ms max={:.2}ms",
            percentile(v, 50.0),
            percentile(v, 95.0),
            percentile(v, 99.0),
            v.last().unwrap()
        );
    }
    if let Ok(load) = std::fs::read_to_string("/proc/loadavg") {
        println!("loadavg: {}", load.trim());
    }
    Ok(())
}

// ---------- eval(step 2) ----------

fn eval(args: &[String]) -> Result<()> {
    let model = flag(args, "--model").context("--model required")?;
    let manifest = flag(args, "--manifest").context("--manifest required")?;
    let out_path = flag(args, "--out").context("--out required")?;
    let mut st = SmartTurn::load(model)?;
    let mut out = std::io::BufWriter::new(std::fs::File::create(out_path)?);
    writeln!(out, "# model={model} variant={} window=8s", variant())?;
    writeln!(out, "case\tlabel\tprob\tmel_ms\tinfer_ms")?;
    let mut n = 0usize;
    for line in std::fs::read_to_string(manifest)?.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split('\t');
        let (wav, label) = (
            it.next().context("manifest: wav col")?,
            it.next().context("manifest: label col")?,
        );
        let case = it.next().unwrap_or(wav);
        let pcm = pcm_to_f32(&read_wav_16k_mono(wav)?);
        let (prob, m, i) = st.predict(&pcm)?;
        writeln!(
            out,
            "{case}\t{label}\t{prob:.6}\t{:.2}\t{:.2}",
            m.as_secs_f64() * 1e3,
            i.as_secs_f64() * 1e3
        )?;
        n += 1;
    }
    println!("evaluated {n} cases -> {out_path}");
    anyhow::ensure!(n > 0, "manifest had zero usable rows");
    Ok(())
}

// 编译期防呆:8s 窗常量彼此自洽
const _: () = assert!(N_SAMPLES_8S == 128_000 && N_FRAMES == 800);
