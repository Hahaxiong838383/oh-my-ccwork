//! One bounded routing engine for the Worker and the offline admin preview.
use crate::search_policy::{Intent, QueryIntent, intent};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RoutingConfig { pub schema: u8, pub weather_enabled: bool, pub rules: Vec<Rule> }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub id: String, pub enabled: bool, pub priority: u16,
    pub action: String, pub mode: String, pub triggers: Vec<String>, pub exclude: Vec<String>,
}
impl Default for RoutingConfig {
    fn default() -> Self { serde_json::from_str(include_str!("search-routing-defaults.json")).expect("built-in routing config") }
}
impl RoutingConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema != 1 || self.rules.len() > 32 { return Err("invalid_schema_or_size"); }
        let mut ids = HashSet::new();
        for r in &self.rules {
            if r.id.is_empty() || r.id.len() > 40 || !r.id.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)) || !ids.insert(&r.id)
                || r.priority > 1000 || !["search","weather","chat"].contains(&r.action.as_str())
                || !["prefix","contains_any","contains_all"].contains(&r.mode.as_str())
                || r.triggers.is_empty() || r.triggers.len() > 32 || r.exclude.len() > 32 { return Err("invalid_rule"); }
            for t in r.triggers.iter().chain(&r.exclude) {
                if t.trim()!=t || t.is_empty() || t.chars().count()>32 || t.chars().any(char::is_control) { return Err("invalid_phrase"); }
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WeatherRequest { pub city_id: u32, pub city_name: String, pub day_offset: u8, pub metric: String }
#[derive(Clone, Debug, Serialize)]
pub struct Decision {
    pub action: String, pub rule_id: String, pub reason: String,
    pub query: Option<String>, pub weather: Option<WeatherRequest>,
}
impl Decision {
    fn new(action: &str, rule: &str, reason: &str) -> Self { Self {action:action.into(),rule_id:rule.into(),reason:reason.into(),query:None,weather:None} }
    pub fn intent(&self) -> Option<Intent> {
        match self.action.as_str() {
            "search" => self.query.clone().map(Intent::Search), "replace" => self.query.clone().map(Intent::Replace),
            "cancel" => Some(Intent::Cancel), "resume" => Some(Intent::Resume), "clarify"|"clarify_city" => Some(Intent::Clarify), _=>None,
        }
    }
}
const CITIES: &[(u32,&str)] = &[(2,"北京"),(39,"上海"),(94,"沈阳"),(104,"大连"),(886,"广州"),(892,"深圳"),(1185,"杭州")];
fn trim(t: &str) -> &str { t.trim().trim_end_matches(|c: char| "。！!？?，,.；; ".contains(c)) }
fn addressed(t: &str) -> &str {
    let mut t=trim(t);
    for _ in 0..4 {
        if let Some(rest)=["小可小可","小可","嗯，","嗯,","那个，","那个,"].iter().find_map(|p|t.strip_prefix(p)) {t=rest.trim_start_matches(|c:char|"，,:： ".contains(c));} else {break;}
    } t
}
fn protected(t: &str) -> bool {
    ["如果","假如","例如","比如","不要","不用","别","我自己","我说","他说","她说","你说","我今天","我现在","我们","“","‘","\"","'"].iter().any(|p| t.starts_with(p))
        || ["不要真的查","但不用搜索","心情","编一个","讲个故事"].iter().any(|p|t.contains(p))
        || ["搜索引擎","搜索算法","搜索功能","查询功能"].iter().any(|p|t.starts_with(p))
}
fn weather_topic(q: &str) -> bool {
    ["天气","气温","温度","下雨","降雨","空气质量","带伞","多少度"].iter().any(|p|q.contains(p))
        && !["为什么","原理","形成","是什么意思","什么是","心情","故事"].iter().any(|p|q.contains(p))
}
fn supported_weather(q: &str) -> Option<WeatherRequest> {
    if !weather_topic(q) || ["后后天","大后天","下周","周末","昨天","去年","小时","几点","今晚","早上","上午","下午","晚上","一周","未来","星期","周一","周二","周三","周四","周五","周六","周日","日出","日落","穿衣"].iter().any(|p|q.contains(p)) || q.chars().any(|c|c.is_ascii_digit()) {return None;}
    let found: Vec<_>=CITIES.iter().filter(|(_,name)|q.contains(name)).collect();
    if found.len()!=1 {return None;}
    let (id,name)=found[0];
    // A known city name inside a district/foreign place is not an exact city match.
    let remainder=q.replace(&format!("{name}市"),"").replace(name,"");
    if !weather_without_place(&remainder) {return None;}
    let day=if q.contains("后天"){2}else if q.contains("明天"){1}else{0};
    let metric=if q.contains("空气质量") {if day!=0{return None;} "aqi"}else if q.contains("现在")||q.contains("实时"){if day!=0{return None;} "current"}else{"forecast"};
    Some(WeatherRequest{city_id:*id,city_name:format!("{name}市"),day_offset:day,metric:metric.into()})
}
fn weather_without_place(q: &str) -> bool {
    let mut rest=q.to_string();
    for word in ["怎么样","会不会","是多少","多少度","空气质量","实时","现在","今天","明天","后天","天气","气温","温度","下雨","降雨","带伞","需要","怎么","如何","好不好","不会","一下","小可","啊","的","会","吗","呢","呀","好","不","冷","热","有","没","？","?","。","，"," "] {rest=rest.replace(word,"");}
    rest.is_empty()
}
#[derive(Default)]
pub struct RoutingSession { legacy: QueryIntent, pending_weather: Option<(u64,String,bool)>, version: String }
impl RoutingSession {
    pub fn clear(&mut self) {self.legacy.clear();self.pending_weather=None;}
    pub fn route(&mut self,text:&str,now:u64,config:Option<&RoutingConfig>,version:&str) -> Decision {
        if self.version!=version {self.clear();self.version=version.into();}
        let pending=self.pending_weather.take();
        let Some(config)=config else {return self.legacy_decision(text,now,None);};
        let t=addressed(text);
        // Control commands retain authority even if all editable rules are disabled.
        if let Some(control @ (Intent::Cancel|Intent::Resume|Intent::Replace(_)))=intent(t) {
            self.legacy.clear();return self.from_intent(control,"builtin-control",now,Some(config));
        }
        if t.is_empty() || t.chars().count()>128 || t.chars().any(char::is_control) || protected(t) {self.clear();return Decision::new("chat","protected","普通聊天或保护表达");}
        if let Some((at,question,replace))=pending {
            if now.saturating_sub(at)<=10000 {
                let city=CITIES.iter().find(|(_,name)| t==*name || t==format!("{name}市") || t==format!("啊{name}") );
                if let Some((_,name))=city {
                    let q=format!("{name}{question}");
                    return self.from_intent(if replace{Intent::Replace(q)}else{Intent::Search(q)},"weather-city-followup",now,Some(config));
                }
            }
        }
        if let Some(action)=self.legacy.route(text,now) {return self.from_intent(action,"builtin-explicit",now,Some(config));}
        let mut rules:Vec<_>=config.rules.iter().filter(|r|r.enabled).collect();
        rules.sort_by(|a,b|b.priority.cmp(&a.priority).then(a.id.cmp(&b.id)));
        for r in rules {
            if r.exclude.iter().any(|x|t.contains(x)) {continue;}
            let hit=match r.mode.as_str(){"prefix"=>r.triggers.iter().any(|x|t.starts_with(x)),"contains_all"=>r.triggers.iter().all(|x|t.contains(x)),_=>r.triggers.iter().any(|x|t.contains(x))};
            if !hit {continue;}
            if r.action=="chat" {return Decision::new("chat",&r.id,"命中普通聊天规则");}
            let q=if r.mode=="prefix" {r.triggers.iter().filter_map(|p|t.strip_prefix(p).map(|rest|(p.len(),rest))).max_by_key(|(len,_)|*len).map(|(_,s)|trim(s)).unwrap_or(t)} else {t};
            if q.is_empty() {self.legacy.route("帮我查一下",now);return Decision::new("clarify",&r.id,"缺少具体查询主题");}
            return self.from_intent(Intent::Search(q.into()),&r.id,now,Some(config));
        }
        Decision::new("chat","default-chat","未命中查询规则")
    }
    fn legacy_decision(&mut self,t:&str,now:u64,config:Option<&RoutingConfig>)->Decision {
        match self.legacy.route(t,now){Some(i)=>self.from_intent(i,"builtin-fallback",now,config),None=>Decision::new("chat","builtin-fallback","使用保守内置规则")}
    }
    fn from_intent(&mut self,action:Intent,rule:&str,now:u64,config:Option<&RoutingConfig>)->Decision {
        let (name,query)=match action {Intent::Search(q)=>("search",Some(q)),Intent::Replace(q)=>("replace",Some(q)),Intent::Cancel=>("cancel",None),Intent::Resume=>("resume",None),Intent::Clarify=>("clarify",None)};
        let mut d=Decision::new(name,rule,"命中路由");d.query=query;
        if let Some(q)=d.query.as_ref() {
            if config.is_some() && weather_topic(q) {
                if weather_without_place(q) {self.pending_weather=Some((now,q.clone(),name=="replace"));d.action="clarify_city".into();d.reason="天气查询缺少城市".into();d.query=None;}
                else {d.weather=supported_weather(q);if d.weather.is_none(){d.reason="城市或日期未由天气适配器支持，使用通用搜索".into();}}
            }
        } d
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn route(t:&str)->Decision{RoutingSession::default().route(t,0,Some(&RoutingConfig::default()),"v1")}
    #[test] fn r7_natural_weather_must_create_task_without_explicit_search_verb(){
        for text in ["今天北京的天气","北京明天会下雨吗","小可，上海现在多少度","杭州的空气质量"] {
            let d=route(text);assert_eq!(d.action,"search","{text}");assert!(d.weather.is_some(),"{text}");
        }
        assert_eq!(route("北京明天会下雨吗").weather.unwrap().day_offset,1);
    }
    #[test] fn clarification_preserves_day_but_does_not_capture_chat_or_expired_reply(){
        let c=RoutingConfig::default();let mut r=RoutingSession::default();
        assert_eq!(r.route("明天天气",0,Some(&c),"v1").action,"clarify_city");
        assert_eq!(r.route("北京",1000,Some(&c),"v1").weather.unwrap().day_offset,1);
        for next in ["我画了一只猫","不用查了","天气为什么会变化"] {
            r.route("天气",2000,Some(&c),"v1");assert!(r.route(next,2100,Some(&c),"v1").weather.is_none());
            assert_eq!(r.route("北京",2200,Some(&c),"v1").action,"chat");
        }
        r.route("天气",3000,Some(&c),"v1");assert_eq!(r.route("北京",13001,Some(&c),"v1").action,"chat");
        r.route("天气",15000,Some(&c),"v1");assert_eq!(r.route("北京",15001,Some(&c),"v2").action,"chat");
    }
    #[test] fn hard_controls_and_negatives_survive_editable_rules(){
        for t in ["我今天心情像阴天","天气为什么会变化","不要查北京天气","他说查北京天气","如果北京下雨怎么办","查询功能怎么实现","我今天看了最新新闻","帮我查一下天气，不要真的查"] {assert_eq!(route(t).action,"chat","{t}");}
        for(t,a)in[("取消搜索","cancel"),("继续刚才的搜索结果","resume"),("改查上海天气","replace"),("帮我查火星为什么是红色的","search")] {assert_eq!(route(t).action,a,"{t}");}
        assert!(route("帮我查天气为什么变化").weather.is_none());
    }
    #[test] fn unsupported_places_dates_and_metrics_never_borrow_supported_city_weather(){
        for t in ["北京海淀天气","北京大学天气","北京和上海天气","成都明天天气","北京昨天的天气","北京下周天气","北京明天的空气质量","北京晚上天气","北京2026年10月23日天气"] {let d=route(t);assert_eq!(d.action,"search","{t}");assert!(d.weather.is_none(),"{t}");}
    }
    #[test] fn config_is_bounded_and_new_rule_really_changes_decision(){
        let mut c=RoutingConfig::default();c.validate().unwrap();
        assert_eq!(route("打听一下故宫开放时间").action,"chat");
        c.rules.push(Rule{id:"custom".into(),enabled:true,priority:200,action:"search".into(),mode:"prefix".into(),triggers:vec!["打听一下".into()],exclude:vec![]});
        let d=RoutingSession::default().route("打听一下故宫开放时间",0,Some(&c),"v2");assert_eq!(d.query.unwrap(),"故宫开放时间");
        c.rules[0].mode="regex".into();assert!(c.validate().is_err());
        c=RoutingConfig::default();c.rules[0].triggers=vec![" ".into()];assert!(c.validate().is_err());
    }
    #[test] fn no_config_keeps_old_contract_and_does_not_enable_natural_route(){
        let mut r=RoutingSession::default();assert_eq!(r.route("北京天气",0,None,"").action,"chat");assert_eq!(r.route("帮我查北京天气",1,None,"").action,"search");
    }
}
