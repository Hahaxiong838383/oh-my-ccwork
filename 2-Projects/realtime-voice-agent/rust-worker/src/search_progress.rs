//! Conservative sentence cursor. Captured audio is not proof of device hearing.
#[derive(Default,Debug)]
pub struct SearchProgress {pub sentences:Vec<String>,ends:Vec<u64>}
pub fn sentences(text:&str)->Vec<String>{
 let mut parts:Vec<String>=vec![];let mut pending=String::new();
 for c in text.chars(){pending.push(c);if "。！？!?；;\n".contains(c){parts.push(std::mem::take(&mut pending));}}
 if !pending.is_empty(){if pending.chars().count()<4&&!parts.is_empty(){parts.last_mut().unwrap().push_str(&pending);}else{parts.push(pending);}}
 parts
}
impl SearchProgress {
pub fn new(text:&str)->Self {Self{sentences:sentences(text),ends:vec![]}}
pub fn synthesized(&mut self,samples:u64){let end=self.ends.last().copied().unwrap_or(0)+samples;self.ends.push(end);}
pub fn complete(&self,captured:u64,drained:bool)->usize{let safe=if drained{captured}else{captured.saturating_sub(5280)};self.ends.iter().take_while(|&&end|end>0&&end<=safe).count()}
pub fn remaining(&self,complete:usize)->String{self.sentences.iter().skip(complete).cloned().collect()}
}
#[cfg(test)] mod tests {
use super::*;
#[test] fn r14_sentence_cursor_never_skips_an_unfinished_sentence(){
let mut p=SearchProgress::new("火星呈现红色。表面有氧化铁。");assert_eq!(p.sentences.len(),2);assert_eq!(p.remaining(0),"火星呈现红色。表面有氧化铁。");
p.synthesized(24000);assert_eq!(p.complete(24000,false),0);assert_eq!(p.complete(29280,false),1);assert_eq!(p.remaining(1),"表面有氧化铁。");
assert_eq!(p.complete(1000000,false),1,"unfinished streaming sentence has no end boundary");
p.synthesized(24000);assert_eq!(p.complete(48000,false),1);assert_eq!(p.complete(48000,true),2);
}
#[test] fn r14_pause_does_not_advance_by_wall_clock_and_short_tail_merges(){let p=SearchProgress::new("第一句。尾");assert_eq!(p.sentences,vec!["第一句。尾"]);assert_eq!(p.complete(0,false),0);}
}
