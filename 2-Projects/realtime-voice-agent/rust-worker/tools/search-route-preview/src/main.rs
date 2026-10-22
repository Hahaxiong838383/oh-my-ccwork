#[allow(dead_code)]
#[path = "../../../src/search_policy.rs"]
mod search_policy;
#[allow(dead_code)]
#[path = "../../../src/search_routing.rs"]
mod search_routing;
use serde::Deserialize;
use std::io::{self, Read};
use search_routing::{RoutingConfig, RoutingSession};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input { config: Option<RoutingConfig>, utterances: Vec<Utterance> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Utterance {text:String,at_ms:u64,#[serde(default)]reset:bool}
fn run() -> Result<serde_json::Value, &'static str> {
    let mut bytes=Vec::new();io::stdin().take(65537).read_to_end(&mut bytes).map_err(|_|"invalid_input")?;
    if bytes.len()>65536 {return Err("input_too_large");}
    let i:Input=serde_json::from_slice(&bytes).map_err(|_|"invalid_input")?;
    if i.utterances.len()>64 || i.utterances.iter().any(|u|u.text.chars().count()>128) {return Err("input_too_large");}
    let cfg=i.config.unwrap_or_default();cfg.validate()?;
    let mut router=RoutingSession::default();
    let decisions:Vec<_>=i.utterances.iter().map(|u|{if u.reset{router.clear();}router.route(&u.text,u.at_ms,Some(&cfg),"preview")}).collect();
    Ok(serde_json::json!({"ok":true,"config":cfg,"decisions":decisions}))
}
fn main() {
    match run() {Ok(v)=>println!("{v}"),Err(e)=>{println!("{}",serde_json::json!({"ok":false,"error":e}));std::process::exit(1);}}
}
