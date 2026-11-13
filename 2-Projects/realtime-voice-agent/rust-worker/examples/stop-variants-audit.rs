//! Actual production text functions, offline. This is NOT RTC/Android evidence.
//! Corpus/identity data stays on stdin; output reports ids and decisions only.
#[allow(dead_code)]
#[path = "../src/textproc.rs"] mod textproc;
#[allow(dead_code)]
#[path = "../src/stop_variants.rs"] mod stop_variants;
#[allow(dead_code)]
#[path = "../src/search_policy.rs"] mod search_policy;
use std::io::Read;
fn main() {
    let mut input=String::new();std::io::stdin().read_to_string(&mut input).unwrap();
    let v:serde_json::Value=serde_json::from_str(&input).unwrap();
    let table=|name:&str,default:&str| {
        let words=v[name].as_array().map(|x|x.iter().map(|w|w.as_str().unwrap()).collect::<Vec<_>>().join(","));
        textproc::parse_hotwords_with(words.as_deref(),default)
    };
    let exit=table("words",textproc::DEFAULT_EXIT_HOTWORDS);
    let stop=table("stop_words",textproc::DEFAULT_INTERRUPT_HOTWORDS);
    let cases=v["cases"].as_array().unwrap();
    let started=std::time::Instant::now();
    let rows:Vec<_>=cases.iter().enumerate().map(|(i,c)| {
        let text=c["text"].as_str().unwrap();let context=c["context"].as_str().unwrap_or("普通");
        let path=textproc::session_exit_path(&exit,text,true);
        let natural=stop_variants::intent(text);
        let actual=if context=="倾听" && natural==Some(stop_variants::Intent::ExitListening) {"mode_exit"}
            else if path.is_some(){"close"}
            else if textproc::is_turn_stop(&stop,text){"stop_turn"}
            else if context=="搜索" && matches!(search_policy::intent(text),Some(search_policy::Intent::Cancel)){"cancel_search"}
            else {"chat"};
        serde_json::json!({"index":i,"id":c["id"],"actual":actual,"expected":c["expected_action"],"passed":c["expected_action"]==actual,"path":path})
    }).collect();
    let passed=rows.iter().filter(|r|r["passed"]==true).count();
    println!("{}",serde_json::json!({"cases":cases.len(),"passed":passed,"failed":cases.len()-passed,"elapsed_us":started.elapsed().as_micros(),"results":rows}));
    if passed!=cases.len(){std::process::exit(1);}
}
