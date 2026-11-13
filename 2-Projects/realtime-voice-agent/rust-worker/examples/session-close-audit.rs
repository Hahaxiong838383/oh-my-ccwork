//! Offline corpus audit. Inputs remain outside Git; only aggregate counts print.
#[path = "../src/textproc.rs"]
mod textproc;
use std::io::Read;
fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let v: serde_json::Value = serde_json::from_str(&input).unwrap();
    let words = v["words"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect::<Vec<_>>().join(",");
    let words = textproc::parse_hotwords_with(Some(&words), "");
    let mut failed = Vec::new();
    let cases = v["cases"].as_array().unwrap();
    for (i, c) in cases.iter().enumerate() {
        let actual = textproc::session_exit_path(&words, c["text"].as_str().unwrap(), true);
        if actual.is_some() != c["close"].as_bool().unwrap() {
            failed.push(serde_json::json!({"index": i, "actual": actual}));
        }
    }
    println!("{}", serde_json::json!({"cases":cases.len(),"passed":cases.len()-failed.len(),"failed":failed}));
    if !failed.is_empty() { std::process::exit(1); }
}
