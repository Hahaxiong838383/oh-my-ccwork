//! Local search-only acknowledgment gate; never performs I/O.
#[derive(Debug,PartialEq,Eq)]
pub enum SearchAckDecision { ContinueResult, NormalInput }
pub struct SearchPlaybackContext {pub result_active:bool,pub first_pcm_seen:bool,pub input_continues:bool}
pub fn classify_search_ack(enabled:bool,text:&str,ctx:&SearchPlaybackContext)->SearchAckDecision {
    if !enabled||!ctx.result_active||!ctx.first_pcm_seen||ctx.input_continues {return SearchAckDecision::NormalInput;}
    let text=text.trim().trim_matches(|c:char|c.is_whitespace()||"，。！？,.!?".contains(c));
    if ["嗯","嗯嗯","哦","哦哦","噢","唔","对","对对","是","是的"].contains(&text) {SearchAckDecision::ContinueResult} else {SearchAckDecision::NormalInput}
}
#[cfg(test)] mod tests {
use super::*;
#[test] fn r14_short_ack_continues_real_result_after_pcm_only(){
let ctx=SearchPlaybackContext{result_active:true,first_pcm_seen:true,input_continues:false};
for text in ["嗯"," 嗯嗯。","哦","噢","对对","是的！"]{assert_eq!(classify_search_ack(true,text,&ctx),SearchAckDecision::ContinueResult);}
for text in ["嗯我想聊小猫","是吗","好","停","退出","取消搜索","改查火星","我想聊","继续刚才的搜索"]{assert_eq!(classify_search_ack(true,text,&ctx),SearchAckDecision::NormalInput);}
assert_eq!(classify_search_ack(false,"嗯",&ctx),SearchAckDecision::NormalInput);
for ctx in [SearchPlaybackContext{result_active:false,first_pcm_seen:true,input_continues:false},SearchPlaybackContext{result_active:true,first_pcm_seen:false,input_continues:false},SearchPlaybackContext{result_active:true,first_pcm_seen:true,input_continues:true}]{assert_eq!(classify_search_ack(true,"嗯",&ctx),SearchAckDecision::NormalInput);}
}
}
