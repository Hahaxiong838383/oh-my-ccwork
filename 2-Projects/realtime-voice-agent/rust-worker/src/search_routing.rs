//! One bounded routing engine for the Worker and the offline admin preview.
use crate::search_policy::{Intent, QueryIntent, intent, search_term_question};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
include!("search_weather_intent.rs");

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RoutingConfig { pub schema: u8, pub weather_enabled: bool, #[serde(default)] pub auto_location_enabled: bool, #[serde(default)] pub baidu_weather_enabled: bool, pub rules: Vec<Rule> }
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
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AutoWeatherRequest {pub day_offset:u8,pub metric:String}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlaceWeatherRequest {pub place:String,pub day_offset:u8,pub metric:String}
#[derive(Clone, Debug, Serialize)]
pub struct Decision {
    pub action: String, pub rule_id: String, pub reason: String,
    pub query: Option<String>, pub weather: Option<WeatherRequest>,
    #[serde(skip_serializing_if="Vec::is_empty")] pub requested_info: Vec<String>,
    #[serde(skip_serializing_if="Option::is_none")] pub auto_weather: Option<AutoWeatherRequest>,
    #[serde(skip_serializing_if="Option::is_none")] pub place_weather: Option<PlaceWeatherRequest>,
}
impl Decision {
    fn new(action: &str, rule: &str, reason: &str) -> Self { Self {action:action.into(),rule_id:rule.into(),reason:reason.into(),query:None,weather:None,auto_weather:None,place_weather:None,requested_info:Vec::new()} }
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
fn ark_resource_question(t: &str) -> bool {
    let domain = ["方舟", "星尘", "家族币", "补勤卡", "补签卡"].iter().any(|w| t.contains(w));
    let usage = ["什么用", "作用", "干嘛", "怎么用", "用来", "用途"].iter().any(|w| t.contains(w));
    domain && usage && !["取消", "继续", "改查", "原神", "我的世界", "哆啦", "王者荣耀", "天文", "恒星", "星空", "天上的", "黄金", "金价", "金店", "比特币"].iter().any(|w| t.contains(w))
}

fn protected(t: &str) -> bool {
    search_term_question(t) || ["他让我","她让我","妈妈说","爸爸说","老师说","如果","假如","例如","比如","不要","不用","别","我自己","我说","他说","她说","你说","我今天","我现在","我们","“","‘","\"","'"].iter().any(|p| t.starts_with(p))
        || ["不要真的查","但不用搜索","心情","编一个","讲个故事"].iter().any(|p|t.contains(p))
        || ["搜索引擎","搜索算法","搜索功能","查询功能"].iter().any(|p|t.starts_with(p))
}
fn page_read_request(t: &str) -> bool {
    let mut rest=t;
    for _ in 0..3 {
        if let Some(next)=["请","帮我","给我"].iter().find_map(|p|rest.strip_prefix(p)){rest=next;}else{break;}
    }
    ["读一下","读一读","读读","打开","看看","看一下","看一看"].iter().any(|p|rest.starts_with(p))
        && ["网站","网页","官网","网址","新闻页面","https://","http://"].iter().any(|w|rest.contains(w))
}
fn weather_topic(q: &str) -> bool {
    let ordinary=["天气","气温","温度","下雨","降雨","空气质量","带伞","拿伞","多少度","几度"].iter().any(|p|q.contains(p));
    let comfort=["冷不冷","热不热","冷吗","热吗"].iter().any(|p|q.contains(p))
        && (["今天","明天","后天","外面","出门"].iter().any(|p|q.contains(p)) || known_weather_place(&weather_place_words(q)));
    (ordinary||comfort) && !["为什么","原理","形成","是什么意思","什么是","心情","故事","烤箱","体温","发烧","开水","水温","空调","冰箱","显卡","电脑","室内","屋里","房间","身体","手脚","冷笑话","冷知识","冷战","冰淇淋"].iter().any(|p|q.contains(p))
}
fn weather_parameters(q: &str) -> Option<AutoWeatherRequest> {
    if !weather_topic(q) || ["后后天","大后天","下周","周末","昨天","去年","小时","几点","今晚","早上","上午","下午","晚上","一周","未来","星期","周一","周二","周三","周四","周五","周六","周日","日出","日落","穿衣"].iter().any(|p|q.contains(p)) || q.chars().any(|c|c.is_ascii_digit()) {return None;}
    if ["今天", "明天", "后天"].iter().filter(|day| q.contains(**day)).count() > 1 { return None; }
    let day=if q.contains("后天"){2}else if q.contains("明天"){1}else{0};
    let metric=if q.contains("空气质量") {if day!=0{return None;} "aqi"}else if q.contains("现在")||q.contains("实时"){if day!=0{return None;} "current"}else{"forecast"};
    Some(AutoWeatherRequest{day_offset:day,metric:metric.into()})
}
fn supported_weather(q: &str) -> Option<WeatherRequest> {
    let params=weather_parameters(q)?;
    let found: Vec<_>=CITIES.iter().filter(|(_,name)|q.contains(name)).collect();
    if found.len()!=1 {return None;}
    let (id,name)=found[0];
    // A known city name inside a district/foreign place is not an exact city match.
    let remainder=q.replace(&format!("{name}市"),"").replace(name,"");
    if !weather_without_place(&remainder) {return None;}
    Some(WeatherRequest{city_id:*id,city_name:format!("{name}市"),day_offset:params.day_offset,metric:params.metric})
}
fn weather_without_place(q: &str) -> bool {
    weather_place_words(q).is_empty()
}
// Only a complete, bounded weather postscript may be removed. Keep the original
// query for the task; this view is solely for extracting its location.
fn weather_request_core(q: &str) -> &str {
    let q = trim(q);
    for suffix in [
        "再告诉我需不需要带伞", "再告诉我要不要带伞",
        "再说一下需不需要带伞", "再说一下要不要带伞",
        "告诉我需不需要带伞", "告诉我要不要带伞",
        "告诉我会不会下雨", "告诉我下不下雨", "告诉我",
    ] {
        if let Some(core) = q.strip_suffix(suffix) {
            let core = trim(core);
            if weather_topic(core) { return core; }
        }
    }
    q
}
fn multiple_weather_places(place: &str) -> bool {
    ["以及", "还有", "和", "与", "、"].iter().any(|sep| {
        place.split_once(sep).is_some_and(|(a, b)|
            known_weather_place(a.trim()) && known_weather_place(b.trim()))
    })
}
fn weather_followup_question(params: &AutoWeatherRequest) -> String {
    let day = match params.day_offset { 1 => "明天", 2 => "后天", _ => "今天" };
    let topic = match params.metric.as_str() { "aqi" => "空气质量", "current" => "现在的天气", _ => "天气" };
    format!("{day}{topic}")
}
fn weather_followup_with_needs(q:&str,params:&AutoWeatherRequest)->String {
    let mut question=weather_followup_question(params);
    for need in weather_needs(q) {match need.as_str(){"comfort"=>question.push_str("冷不冷"),"umbrella"=>question.push_str("要不要带伞"),_=>{}}}
    question
}
fn weather_place_words(q: &str) -> String {
    let q=weather_request_core(q);
    // Only peel the weather grammar at the edges: global replacement corrupts
    // real names (e.g. 冷水江) and leaves 下 from 下不下雨 as a fake city.
    // A secondary activity question is not a place; retain it in d.query for
    // evidence-backed answering, but do not feed it to the city resolver.
    let end=q.char_indices().filter_map(|(i,_)| {
        let tail=&q[i..];
        (["放学","出门","上学","适合","适不适合","能不能"].iter().any(|s|tail.trim_start_matches(|c:char|"，,？?。 ".contains(c)).starts_with(s))
            && weather_topic(&q[..i])).then_some(i)
    }).next().unwrap_or(q.len());
    let mut rest=&q[..end];
    const WORDS:&[&str]=&["冷不冷","热不热","冷吗","热吗","几度","多少","外面","出门","天气预报","天气情况","需不需要带伞","要不要带伞","需要拿伞","要带伞","要拿伞","会不会下雨","下不下雨","会下雨","空气质量","会不会","怎么样","是多少","多少度","这里","这边","本地","当地","实时","现在","今天","明天","后天","天气","气温","温度","下雨","降雨","带伞","需要","怎么","如何","好不好","好么","不会","一下","小可","啊","的","会","吗","么","呢","呀","好","不","冷","热","有","没","？","?","。","，"," "];
    const PREFIXES:&[&str]=&["能不能告诉我","可以告诉我","能告诉我","哎","我想查一下","我想查","我要查询","我要查","我想问","我想知道","我想问问","我想了解","想知道","帮我查查","帮我查询","帮我查一下","帮我查","请你告诉我","请你提供一下","请你提供","请告诉我","请提供一下","请提供","你只说说","请查一下","请查查","请查询","请查","告诉我","提供一下","只说说","就查","查一下","查一查","查查","查询","查","呃","额"];
    const SUFFIXES:&[&str]=&["你找不着","你查不到","快一点","快点","吧"];
    loop {
        if weather_place_names().contains(rest) {break;}
        if let Some(next)=WORDS.iter().chain(SUFFIXES).filter_map(|w|rest.strip_suffix(w).map(|next|(w.len(),next))).max_by_key(|(n,_)|*n).map(|(_,next)|next) {rest=next;continue;}
        if let Some(next)=WORDS.iter().chain(PREFIXES).filter_map(|w|rest.strip_prefix(w).map(|next|(w.len(),next))).max_by_key(|(n,_)|*n).map(|(_,next)|next) {rest=next;continue;}
        break;
    }
    rest.into()
}
fn expanded_weather(q:&str)->Option<PlaceWeatherRequest>{
    let p=weather_parameters(q)?;let place=weather_place_words(q);
    if place.is_empty()||place.chars().count()>40||!place.chars().all(|c|('\u{4e00}'..='\u{9fff}').contains(&c)){return None;}
    // A leftover request clause is not a location; never silently pick its first city.
    if !known_weather_place(&place) && ["告诉我","天气","帮我","要不要","需不需要","今天","明天","后天"].iter().any(|s|place.contains(s)) { return None; }
    Some(PlaceWeatherRequest{place,day_offset:p.day_offset,metric:p.metric})
}
pub fn truncated_place_prefix(q: &str) -> bool {
    matches!(q, "深"|"北"|"上"|"广"|"杭"|"成"|"重"|"沈")
}
pub fn completed_place_tail(head: &str, tail: &str) -> bool {
    if !truncated_place_prefix(head) || tail.chars().count()>40 || protected(tail) {return false;}
    let joined=format!("{head}{tail}");
    let place=weather_place_words(&joined);
    known_weather_place(&place) && !ambiguous_weather_place(&place)
}
fn known_weather_place(t:&str)->bool {
    weather_place_names().contains(t.strip_prefix('啊').unwrap_or(t))
}
pub fn prepare_weather_places() -> usize { let n=weather_place_names().len(); ambiguous_weather_place(""); n }
fn weather_place_names() -> &'static HashSet<String> {
    static NAMES: std::sync::OnceLock<HashSet<String>> = std::sync::OnceLock::new();
    NAMES.get_or_init(|| {
        let catalog: serde_json::Value = serde_json::from_str(include_str!("weather-places.json")).expect("weather catalog");
        let mut names = HashSet::new();
        for row in catalog["places"].as_array().expect("weather places") {
            let p = row[0].as_str().unwrap(); let c = row[1].as_str().unwrap(); let n = row[2].as_str().unwrap();
            // Match Brain's authoritative aliases. Station resolution stays in Brain.
            let full = match p {
                "北京" | "上海" | "天津" | "重庆" => format!("{p}市"),
                "内蒙古" => "内蒙古自治区".into(), "广西" => "广西壮族自治区".into(),
                "宁夏" => "宁夏回族自治区".into(), "新疆" => "新疆维吾尔自治区".into(),
                "西藏" => "西藏自治区".into(), "香港" | "澳门" => format!("{p}特别行政区"),
                _ => format!("{p}省"),
            };
            let ps = [p.to_string(), full];
            let aliases: Vec<String> = row[4].as_array().unwrap().iter().map(|v|v.as_str().unwrap().to_string()).collect();
            let mut cs = vec![c.to_string(), format!("{c}市")]; cs.extend(aliases.clone());
            let mut ns = vec![n.to_string()];
            if n == c { ns.push(format!("{n}市")); ns.extend(aliases); }
            else { ns.extend([format!("{n}区"), format!("{n}县")]); }
            for n in ns {
                names.insert(n.clone());
                for p in &ps { names.insert(format!("{p}{n}")); }
                for c in &cs {
                    names.insert(format!("{c}{n}"));
                    for p in &ps { names.insert(format!("{p}{c}{n}")); }
                }
            }
        }
        names
    })
}
#[derive(Default)]
pub struct RoutingSession { legacy: QueryIntent, pending_weather: Option<(u64,String,bool)>, pending_place: Option<(u64,String)>, recent_weather: Option<(u64,String,u8)>, version: String }
impl RoutingSession {
    pub fn take_handoff(&mut self)->Option<String>{self.legacy.take_handoff()}
    pub fn clear(&mut self) {self.legacy.clear();self.pending_weather=None;self.pending_place=None;self.recent_weather=None;}
    pub fn route(&mut self,text:&str,now:u64,config:Option<&RoutingConfig>,version:&str) -> Decision {
        self.legacy.take_handoff();
        if self.version!=version {self.clear();self.version=version.into();}
        let pending=self.pending_weather.take();
        let place_fragment=self.pending_place.take();
        let recent_weather=self.recent_weather.take();
        // Known first-party game mechanics use the local Brain knowledge; no web task needed.
        if (ark_resource_question(text)||personal_ark_request(text)) && !matches!(intent(addressed(text)), Some(Intent::Cancel | Intent::Resume | Intent::Replace(_))) { self.clear(); return Decision::new("chat", "ark-local-knowledge", "方舟资源用途由本地知识回答"); }
        let Some(config)=config else {return self.legacy_decision(text,now,None);};
        let t=addressed(text);
        // Control commands retain authority even if all editable rules are disabled.
        if let Some(control @ (Intent::Cancel|Intent::Resume|Intent::Replace(_)))=intent(t) {
            self.legacy.clear();let control=self.legacy.route(text,now).unwrap_or(control);
            return self.from_intent(control,"builtin-control",now,Some(config));
        }
        if t.is_empty() || t.chars().count()>128 || t.chars().any(char::is_control) || protected(t) {self.clear();return Decision::new("chat","protected","普通聊天或保护表达");}
        if page_read_request(t) {
            self.legacy.clear();
            return self.from_intent(Intent::Search(t.into()),"builtin-explicit",now,Some(config));
        }
        if config.weather_enabled && config.baidu_weather_enabled {
            if let Some(q)=["该插","改插","该查"].iter().find_map(|p|t.strip_prefix(p)) {
                if expanded_weather(q).is_some_and(|w|known_weather_place(&w.place)) {
                    self.legacy.clear();return self.from_intent(Intent::Replace(q.into()),"builtin-control",now,Some(config));
                }
            }
        }
        if config.weather_enabled {
            if let Some((at,place,day))=recent_weather {
                if now.saturating_sub(at)<=10000 {
                    if let Some(suffix)=weather_context_suffix(t,day) {
                        return self.from_intent(Intent::Search(format!("{place}{suffix}")),"weather-city-followup",now,Some(config));
                    }
                }
            }
            if let Some((at,fragment))=place_fragment {
                if weather_tail(t) {
                    if now.saturating_sub(at)>2000 {
                        self.pending_weather=Some((now,t.into(),false));return Decision::new("clarify_city","weather-city-followup","城市片段已过期，请确认城市");
                    }
                    return self.from_intent(Intent::Search(join_city_fragment(&fragment,t)),"weather-city-followup",now,Some(config));
                }
            }
        }
        if let Some((at,question,replace))=pending {
            if now.saturating_sub(at)<=10000 {
                let city=CITIES.iter().find(|(_,name)| t==*name || t==format!("{name}市") || t==format!("啊{name}") );
                if let Some((_,name))=city {
                    let q=format!("{name}{question}");
                    return self.from_intent(if replace{Intent::Replace(q)}else{Intent::Search(q)},"weather-city-followup",now,Some(config));
                }
                if config.baidu_weather_enabled&&known_weather_place(t){let q=format!("{}{question}",t.strip_prefix('啊').unwrap_or(t));return self.from_intent(if replace{Intent::Replace(q)}else{Intent::Search(q)},"weather-city-followup",now,Some(config));}
            }
        }
        if let Some(action)=self.legacy.route(text,now) {return self.from_intent(action,"builtin-explicit",now,Some(config));}
        if config.weather_enabled {
            if let Some(fragment)=city_fragment(t){self.pending_place=Some((now,fragment));}
        }
        let mut rules:Vec<_>=config.rules.iter().filter(|r|r.enabled).collect();
        rules.sort_by(|a,b|b.priority.cmp(&a.priority).then(a.id.cmp(&b.id)));
        for r in rules {
            if r.exclude.iter().any(|x|t.contains(x)) {continue;}
            let hit=match r.mode.as_str(){"prefix"=>r.triggers.iter().any(|x|t.starts_with(x)),"contains_all"=>r.triggers.iter().all(|x|t.contains(x)),_=>r.triggers.iter().any(|x|t.contains(x))};
            let implicit=if r.id=="current-public-facts"&&r.action=="search" {implicit_current_public(t)}else{None};
            if !hit && implicit.is_none() {continue;}
            if r.action=="chat" {return Decision::new("chat",&r.id,"命中普通聊天规则");}
            let q=if let Some(q)=implicit {q} else if r.mode=="prefix" {r.triggers.iter().filter_map(|p|t.strip_prefix(p).map(|rest|(p.len(),rest))).max_by_key(|(len,_)|*len).map(|(_,s)|trim(s)).unwrap_or(t)} else {t};
            if r.action=="weather"&&!weather_topic(q){continue;}
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
                d.requested_info=weather_needs(q);
                if config.is_some_and(|c|c.weather_enabled&&c.baidu_weather_enabled) {
                    let place=weather_place_words(q);
                    if ambiguous_weather_place(&place)||["明","后","天","多少","你那里","你那边","那里"].contains(&place.as_str()) {
                        self.pending_weather=Some((now,weather_parameters(q).map(|p|weather_followup_with_needs(q,&p)).unwrap_or_else(||"天气".into()),name=="replace"));
                        d.action="clarify_city".into();d.reason="地点有歧义或输入不完整，请确认城市".into();d.query=None;return d;
                    }
                }
                if config.is_some_and(|c| c.weather_enabled) && multiple_weather_places(&weather_place_words(q)) {
                    if let Some(params) = weather_parameters(q) {
                        self.pending_weather = Some((now, weather_followup_with_needs(q,&params), name == "replace"));
                        d.action = "clarify_city".into(); d.reason = "包含多个地点，请确认要查的城市".into();
                        d.query = None; return d;
                    }
                }
                // An ASR fragment must not become the invented place "天预报".
                if ["天天气","天天气预报"].contains(&addressed(q)) {
                    self.pending_weather=Some((now,"天气".into(),name=="replace"));d.action="clarify_city".into();d.reason="天气片段不完整，请确认城市".into();d.query=None;return d;
                }
                if weather_without_place(q) {
                    let automatic=config.is_some_and(|c|c.weather_enabled&&c.auto_location_enabled);
                    if automatic {d.auto_weather=weather_parameters(q);d.reason="后台按本轮设备网络定位城市，不等待前台聊天".into();}
                    if d.auto_weather.is_none(){self.pending_weather=Some((now,q.clone(),name=="replace"));d.action="clarify_city".into();d.reason="天气查询缺少城市".into();d.query=None;}
                }
                else if config.is_some_and(|c|c.baidu_weather_enabled&&c.weather_enabled){d.place_weather=expanded_weather(q);if d.place_weather.is_some(){d.reason="后台校验省市与天气站后查询百度天气".into();}else{d.reason="日期或指标未由天气适配器支持，使用通用搜索".into();}}
                else {d.weather=supported_weather(q);if d.weather.is_none(){d.reason="城市或日期未由天气适配器支持，使用通用搜索".into();}}
            }
        }
        if d.action=="search"||d.action=="replace" {
            if let Some(p)=&d.place_weather {self.recent_weather=Some((now,p.place.clone(),p.day_offset));}
            else if let Some(p)=&d.weather {self.recent_weather=Some((now,p.city_name.clone(),p.day_offset));}
            else if let Some(p)=&d.auto_weather {self.recent_weather=Some((now,String::new(),p.day_offset));}
        }
        d
    }
}

#[cfg(test)]
mod style_ark_tests {
    use super::*;
    #[test]
    fn style_ark_resource_usage_never_starts_web_search() {
        for config in [None, Some(RoutingConfig::default())] {
            for text in ["帮我查方舟里的星尘有什么用", "搜索补勤卡怎么用", "家族币有什么作用"] {
                let d = RoutingSession::default().route(text, 0, config.as_ref(), "test");
                assert_eq!(d.action, "chat", "{text}");
                assert!(d.query.is_none());
            }
            for (text, expected) in [("不要查了，聊聊星尘有什么用", "cancel"), ("不用查了 我们聊星尘有什么用", "cancel"), ("换查星尘有什么用", "replace"), ("改为查询星尘有什么用", "replace")] {
                assert_eq!(RoutingSession::default().route(text,0,config.as_ref(),"test").action,expected,"{text}");
            }
            assert_eq!(RoutingSession::default().route("帮我查天文学里星尘有什么作用",0,config.as_ref(),"test").action,"search");
            assert_eq!(RoutingSession::default().route("帮我查火星为什么是红色的",0,config.as_ref(),"test").action,"search");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn r27_explicit_page_reading_routes_without_changing_chat() {
        let config=RoutingConfig::default();
        for text in ["帮我读一下央视网国内新闻页面挑一条能核实日期的新闻讲两句重点告诉我来源", "帮我读一下央视往国内新闻页面", "请打开科普中国网站看看恐龙的资料", "帮我看看https://news.cctv.com/china/页面上的新闻"] {
            let d=RoutingSession::default().route(text,0,Some(&config),"r27");
            assert_eq!(d.action,"search","{text}");assert!(d.query.is_some());
            assert_eq!(d.rule_id,"builtin-explicit","reuse the Brain-approved explicit-query claim");
        }
        for text in ["帮我读一下这首诗", "网站是什么", "他说帮我读一下央视网页面", "不要打开央视网新闻页面", "如果打开央视网页会怎样", "帮我编一个打开新闻网页的故事", "我今天看了央视新闻", "小可我们聊聊小猫吧"] {
            assert_eq!(RoutingSession::default().route(text,0,Some(&config),"r27").action,"chat","{text}");
        }
    }
    #[test] fn r26_continued_weather_imperative_keeps_verified_place() {
        let c=RoutingConfig{weather_enabled:true,auto_location_enabled:true,baidu_weather_enabled:true,..RoutingConfig::default()};
        for (text,place) in [("查北京今天的天气","北京"),("查成都今天的天气","成都"),("请查一下北京市明天天气","北京市"),("小可，查深圳现在多少度","深圳")] {
            let d=RoutingSession::default().route(text,0,Some(&c),"r26-continued");
            assert_eq!(d.action,"search","{text}");
            assert_eq!(d.place_weather.as_ref().map(|w|w.place.as_str()),Some(place),"{text}: {d:?}");
            assert!(d.auto_weather.is_none(),"explicit place must not become device location");
        }
        for text in ["查北京下周的天气"] {
            let d=RoutingSession::default().route(text,0,Some(&c),"r26-continued");
            assert!(d.place_weather.is_none(),"{text}: {d:?}");
            assert!(d.auto_weather.is_none(),"unsupported explicit place/date must not become local");
        }
        for text in ["不要查北京今天的天气","如果查北京今天的天气会怎样","我今天查北京天气","查是什么意思"] {
            assert_eq!(RoutingSession::default().route(text,0,Some(&c),"r26-continued").action,"chat","{text}");
        }
    }
    #[test] fn r23_weather_question_and_activity_tail_do_not_become_places() {
        let c=RoutingConfig{weather_enabled:true,auto_location_enabled:true,baidu_weather_enabled:true,..RoutingConfig::default()};
        for text in ["帮我查一下今天这里下不下雨", "帮我查一下今天这里下不下雨，放学适合打球吗", "今天这里下不下雨放学适合打球吗", "这里明天会不会下雨，出门要带伞吗", "帮我查今天这里天气，放学适合打球吗", "今天这里要不要带伞"] {
            let d=RoutingSession::default().route(text,0,Some(&c),"r23");
            assert_eq!(d.action,"search","{text}");assert!(d.auto_weather.is_some(),"{text}: {d:?}");assert!(d.place_weather.is_none());
        }
        for (text,place) in [("成都今天下不下雨，放学适合打球吗","成都"),("冷水江今天天气","冷水江"),("北京海淀明天会下雨吗","北京海淀")] {
            let d=RoutingSession::default().route(text,0,Some(&c),"r23");assert_eq!(d.place_weather.unwrap().place,place,"{text}");assert!(d.auto_weather.is_none());
        }
        for text in ["帮我查巴黎天气","帮我查火星市天气","新加坡北京天气"] {
            let d=RoutingSession::default().route(text,0,Some(&c),"r23");assert!(d.auto_weather.is_none(),"unknown explicit place must not become local: {text}");assert!(d.place_weather.is_some(),"explicit unknown place must reach server catalog validation, never IP: {text}");
        }
        for text in ["天气为什么会变化","不要查北京天气","今天本地适合打球吗","他说改查成都天气","该插哪个插座"] {assert_eq!(RoutingSession::default().route(text,0,Some(&c),"r23").action,"chat","{text}");}
    }
    #[test] fn r23_weather_asr_replace_is_scoped_to_verified_weather_place() {
        let c=RoutingConfig{weather_enabled:true,auto_location_enabled:true,baidu_weather_enabled:true,..RoutingConfig::default()};
        for text in ["该插成都今天的天气","改插上海明天天气","该查北京今天的天气","改查成都今天的天气"] {
            let d=RoutingSession::default().route(text,0,Some(&c),"r23");assert_eq!(d.action,"replace","{text}");assert!(d.place_weather.is_some(),"{text}");
        }
        for text in ["该插成都是什么意思","该插北京电源吗","不要该插成都天气","他说该插成都天气"] {assert_eq!(RoutingSession::default().route(text,0,Some(&c),"r23").action,"chat","{text}");}
    }
    #[test] fn r21_word_explanations_override_editable_search_keywords(){
        let mut c=RoutingConfig::default();
        c.rules.push(Rule{id:"broad-search".into(),enabled:true,priority:1000,action:"search".into(),mode:"contains_any".into(),triggers:vec!["查查".into(),"搜索".into()],exclude:vec![]});
        for config in [None,Some(&c)] {
            for text in ["查查是啥","搜索是什么意思","小可，查查这个词啥意思？"] {
                let mut r=RoutingSession::default();
                r.route("帮我查一下",0,config,"v1");
                let d=r.route(text,500,config,"v1");
                assert_eq!(d.action,"chat","{text}");assert!(d.query.is_none());
                assert_eq!(r.route("恐龙",700,config,"v1").action,"chat");
            }
            assert_eq!(RoutingSession::default().route("帮我查查光合作用是啥",0,config,"v1").action,"search");
        }
    }
    #[test] fn r17_result_resume_survives_reconnect_config_and_pending_clarification(){
        let mut c=RoutingConfig::default();
        c.rules=vec![Rule{id:"broad-chat".into(),enabled:true,priority:1000,action:"chat".into(),mode:"contains_any".into(),triggers:vec!["继续".into()],exclude:vec![]}];
        let mut r=RoutingSession::default();
        assert_eq!(r.route("明天天气",0,Some(&RoutingConfig::default()),"old").action,"clarify_city");
        r.clear(); // A new room must not need old in-memory routing state.
        let d=r.route("从继续刚才的搜索结果",1000,Some(&c),"new");
        assert_eq!(d.action,"resume");assert_eq!(d.rule_id,"builtin-control");
        assert_eq!(d.intent(),Some(Intent::Resume));assert!(d.query.is_none());
        assert_eq!(r.route("请把刚才查的结果继续播报",1100,None,"fallback").action,"resume");
        for t in ["请不要继续刚才的搜索结果","他说继续刚才的搜索结果","继续刚才的小猫故事","奶茶中国","加微信叫什么"] {
            assert_eq!(r.route(t,1200,Some(&c),"new").action,"chat","{t}");
        }
        assert_eq!(r.route("北京",1300,Some(&c),"new").action,"chat");
    }
    #[test] fn r10_expanded_weather_preserves_places_and_control_without_stealing_chat(){
        let mut value=serde_json::to_value(RoutingConfig::default()).unwrap();value["baidu_weather_enabled"]=serde_json::json!(true);value["weather_enabled"]=serde_json::json!(true);
        let config:Result<RoutingConfig,_>=serde_json::from_value(value);
        assert!(config.is_ok(),"new source switch must be accepted by the actual routing engine");let config=config.unwrap();
        for (text,place,day) in [("成都明天天气","成都",1),("北京市朝阳区后天天气","北京市朝阳区",2),("辽宁朝阳今天天气","辽宁朝阳",0),("泉州现在多少度","泉州",0)] {
            let d=RoutingSession::default().route(text,0,Some(&config),"r10");let j=serde_json::to_value(d).unwrap();
            assert_eq!(j["action"],"search","{text}");assert_eq!(j["place_weather"]["place"],place,"{text}");assert_eq!(j["place_weather"]["day_offset"],day);
        }
        let mut s=RoutingSession::default();assert_eq!(s.route("明天天气",0,Some(&config),"r10").action,"clarify_city");
        assert_eq!(serde_json::to_value(s.route("成都",1000,Some(&config),"r10")).unwrap()["place_weather"]["place"],"成都");
        for t in ["天气为什么变化","烤箱温度怎么调","我今天画了一只猫","我今天看了新闻"]{assert_eq!(RoutingSession::default().route(t,0,Some(&config),"r10").action,"chat","{t}");}
        assert_eq!(RoutingSession::default().route("改查成都明天天气",0,Some(&config),"r10").action,"replace");
        assert!(serde_json::to_value(RoutingSession::default().route("成都明天天气",0,Some(&RoutingConfig::default()),"old")).unwrap()["place_weather"].is_null());
        let mut disabled=config.clone();disabled.weather_enabled=false;
        assert!(serde_json::to_value(RoutingSession::default().route("成都明天天气",0,Some(&disabled),"off")).unwrap()["place_weather"].is_null());
    }
    #[test] fn r8_implicit_city_uses_background_device_location_and_explicit_city_wins(){
        let mut value=serde_json::to_value(RoutingConfig::default()).unwrap();value["auto_location_enabled"]=serde_json::json!(true);value["weather_enabled"]=serde_json::json!(true);
        let c:RoutingConfig=serde_json::from_value(value).expect("R8 auto location configuration");
        for (text,day) in [("今天天气怎么样",0),("明天会下雨吗",1),("这里后天天气怎么样",2)] {
            let d=RoutingSession::default().route(text,0,Some(&c),"r8");assert_eq!(d.action,"search","{text}");assert!(d.weather.is_none());
            assert_eq!(serde_json::to_value(d).unwrap()["auto_weather"]["day_offset"],day);
        }
        let explicit=RoutingSession::default().route("改查上海明天天气",0,Some(&c),"r8");assert_eq!(explicit.action,"replace");assert_eq!(explicit.weather.as_ref().unwrap().city_id,39);assert!(serde_json::to_value(explicit).unwrap()["auto_weather"].is_null());
        for text in ["天气为什么会变化","不要查天气","我今天心情像阴天"] {assert_eq!(RoutingSession::default().route(text,0,Some(&c),"r8").action,"chat");}
        assert_eq!(RoutingSession::default().route("取消搜索",0,Some(&c),"r8").action,"cancel");
    }
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
    #[test] fn r20_configured_router_keeps_adjacent_resume_tail(){
        let c=RoutingConfig::default();let mut r=RoutingSession::default();
        assert_eq!(r.route("继续刚才的搜索",0,Some(&c),"v1").action,"resume");
        assert_eq!(r.route("结果",700,Some(&c),"v1").action,"resume");
        assert_eq!(r.route("结果",900,Some(&c),"v1").action,"chat");
    }
    #[test] fn no_config_keeps_old_contract_and_does_not_enable_natural_route(){
        let mut r=RoutingSession::default();assert_eq!(r.route("北京天气",0,None,"").action,"chat");assert_eq!(r.route("帮我查北京天气",1,None,"").action,"search");
    }
}

#[cfg(test)]
mod p1_weather_hotfix_tests {
    use super::*;
    fn route(text: &str) -> Decision {
        let mut config=RoutingConfig::default();
        config.weather_enabled=true;config.baidu_weather_enabled=true;config.auto_location_enabled=true;
        RoutingSession::default().route(text,0,Some(&config),"p1-weather-hotfix")
    }
    #[test]
    fn p1_weather_spoken_requests_extract_only_the_place() {
        for (text,place) in [
            ("请你告诉我今天北京经开区的天气","北京经开区"),
            ("小可请你提供一下北京的天气预报","北京"),
            ("就查哈尔滨的天气吧","哈尔滨"),
            ("你只说说北京的天气吧快点","北京"),
            ("呃北京天气你找不着","北京"),
            ("请查查冷水江今天的天气","冷水江"),
            ("请查会同县天气","会同县"),
            ("查北京今天的天气","北京"),
            ("啊北京天气","北京"),
            ("啊哈尔滨天气","哈尔滨"),
            ("北京市朝阳区后天天气预报","北京市朝阳区"),
        ] {
            let d=route(text);assert_eq!(d.action,"search","{text}");
            assert_eq!(d.place_weather.as_ref().map(|p|p.place.as_str()),Some(place),"{text}");
            assert!(d.auto_weather.is_none(),"{text}");
        }
    }
    #[test]
    fn p1_weather_forecast_without_city_uses_location() {
        for text in ["天气预报","今天天气预报","请你告诉我明天的天气预报","这里今天会不会下雨"] {
            let d=route(text);assert_eq!(d.action,"search","{text}");
            assert!(d.auto_weather.is_some(),"{text}");assert!(d.place_weather.is_none(),"{text}");
        }
        assert_eq!(route("天天气预报").action,"clarify_city");
    }
    #[test]
    fn p1_weather_never_replaces_unknown_or_multiple_places_with_local_weather() {
        assert_eq!(route("北京和上海天气").action,"clarify_city");
        for (text,place) in [("东京天气预报","东京"),("查北京大学天气","北京大学"),("天预报天气","天预报")] {
            let d=route(text);assert!(d.auto_weather.is_none(),"{text}");
            assert_eq!(d.place_weather.as_ref().map(|p|p.place.as_str()),Some(place),"{text}");
        }
        for text in ["不要查北京天气","他说查北京天气","天气预报是什么意思","我今天心情像阴天"] {
            let d=route(text);assert_eq!(d.action,"chat","{text}");assert!(d.auto_weather.is_none());
        }
        assert_eq!(route("取消搜索").action,"cancel");
        assert_eq!(route("改查哈尔滨天气").action,"replace");
    }
}


#[cfg(test)]
mod routing_weather_regression_tests {
    use super::*;
    fn config() -> RoutingConfig {
        let mut c = RoutingConfig::default();
        c.weather_enabled = true;
        c.baidu_weather_enabled = true;
        c
    }
    #[test]
    fn routing_weather_catalog_contract_matches_authoritative_names() {
        let fixture:serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/weather-place-contract.json")).unwrap();
        for c in fixture["cases"].as_array().unwrap() {
            let place=c["input"].as_str().unwrap();
            let known=!c["stations"].as_array().unwrap().is_empty();
            assert_eq!(known_weather_place(place),known,"{place}");
            if known { assert_eq!(weather_place_words(&format!("{place}明天天气")),place); }
        }
    }
    #[test]
    fn routing_weather_compound_clause_preserves_place_and_day() {
        let c = config();
        for (text, place, day) in [
            ("帮我查一下深圳今天的天气告诉我要不要带伞", "深圳", 0),
            ("深圳今天的天气，告诉我要不要带伞", "深圳", 0),
            ("深圳明天的天气，再说一下需不需要带伞", "深圳", 1),
            ("深圳今天的天气告诉我", "深圳", 0),
            ("告诉我深圳今天的天气", "深圳", 0),
            ("深圳明天要不要带伞", "深圳", 1),
            ("冷水江今天的天气，告诉我会不会下雨", "冷水江", 0),
            ("会同县后天的天气告诉我", "会同县", 2),
        ] {
            let d = RoutingSession::default().route(text, 0, Some(&c), "weather-fix");
            assert_eq!(d.action, "search", "{text}");
            assert_eq!(d.place_weather, Some(PlaceWeatherRequest { place: place.into(), day_offset: day, metric: "forecast".into() }), "{text}");
            assert!(d.query.as_deref().is_some_and(|q| q.contains("天气") || q.contains("带伞")), "original intent retained");
            assert!(d.auto_weather.is_none());
        }
        let mut legacy = c.clone(); legacy.baidu_weather_enabled = false;
        let d = RoutingSession::default().route("深圳明天的天气告诉我要不要带伞", 0, Some(&legacy), "legacy");
        assert_eq!(d.weather.unwrap().city_id, 892);
    }
    #[test]
    fn routing_weather_conflicting_days_and_multiple_places_do_not_choose_one() {
        let c = config();
        for text in ["深圳今天明天的天气", "深圳明天后天天气", "现在深圳明天多少度"] {
            let d = RoutingSession::default().route(text, 0, Some(&c), "weather-fix");
            assert!(d.place_weather.is_none() && d.weather.is_none() && d.auto_weather.is_none(), "{text}");
        }
        let mut s = RoutingSession::default();
        let d = s.route("北京和上海明天天气告诉我", 0, Some(&c), "weather-fix");
        assert_eq!(d.action, "clarify_city");
        assert!(d.query.is_none() && d.place_weather.is_none());
        let next = s.route("深圳", 1, Some(&c), "weather-fix");
        assert_eq!(next.place_weather, Some(PlaceWeatherRequest { place: "深圳".into(), day_offset: 1, metric: "forecast".into() }));
        assert!(!next.query.unwrap().contains("北京"));
    }
    #[test]
    fn routing_weather_suffix_does_not_strip_other_requests_or_negation() {
        let c = config();
        for text in ["不要查深圳天气", "他说查深圳天气告诉我", "天气预报是什么意思", "空调多少度", "体温多少度", "为什么会下雨"] {
            assert_eq!(RoutingSession::default().route(text, 0, Some(&c), "weather-fix").action, "chat", "{text}");
        }
        for text in ["深圳今天的天气告诉我北京要不要带伞", "深圳今天天气告诉我北京冷不冷", "深圳明天的天气告诉我后天要不要带伞", "深圳天气告诉我为什么会下雨", "深圳天气告诉我别的故事", "深圳下周天气告诉我"] {
            let d = RoutingSession::default().route(text, 0, Some(&c), "weather-fix");
            assert!(d.place_weather.is_none() && d.weather.is_none() && d.auto_weather.is_none(), "{text}");
        }
    }
}


#[cfg(test)]
mod phase1_design_tests {
    use super::*;
    fn config() -> RoutingConfig {
        let mut c=RoutingConfig::default();c.weather_enabled=true;c.baidu_weather_enabled=true;c.auto_location_enabled=true;
        c.rules.iter_mut().find(|r|r.id=="natural-weather").unwrap().triggers.extend(["冷不冷","热不热","冷吗","热吗","几度"].map(str::to_string));c
    }
    fn d(text:&str)->serde_json::Value { serde_json::to_value(RoutingSession::default().route(text,0,Some(&config()),"lab")).unwrap() }
    #[test] fn cold_questions_use_real_weather_and_keep_need(){
        for text in ["今天冷不冷","我想知道今天冷不冷","明天热不热"] {
            let v=d(text);assert_eq!(v["action"],"search","{text}");assert!(v["auto_weather"].is_object(),"{text}");assert!(v["requested_info"].as_array().unwrap_or(&vec![]).contains(&serde_json::json!("comfort")),"{text}");
        }
    }
    #[test] fn request_prefix_does_not_become_place(){
        for text in ["我想知道深圳今天的天气","呃帮我查深圳天气","上海今天冷不冷"] {let v=d(text);assert_eq!(v["place_weather"]["place"],if text.starts_with("上海"){"上海"}else{"深圳"},"{text}");}
    }
    #[test] fn implicit_public_current_request_is_bounded(){
        assert_eq!(d("我想知道故宫今天开不开门")["action"],"search");
        for t in ["我想知道恐龙为什么灭绝","我想知道你喜欢什么","我想知道我有几张补勤卡","帮我查我有几张补勤卡","他让我查上海天气","我感觉有点冷","妈妈说今天冷不冷","今天室内冷不冷"] {assert_eq!(d(t)["action"],"chat","{t}");}
    }
    #[test] fn city_fragment_is_next_turn_only_not_global_wait(){
        let c=config();let mut s=RoutingSession::default();
        assert_eq!(s.route("上海今天",0,Some(&c),"lab").action,"chat");
        let v=serde_json::to_value(s.route("天气温度多少",650,Some(&c),"lab")).unwrap();assert_eq!(v["place_weather"]["place"],"上海");
        s.route("上海",1000,Some(&c),"lab");assert_eq!(s.route("别查了",1100,Some(&c),"lab").action,"cancel");
        assert!(s.route("天气怎么样",1200,Some(&c),"lab").auto_weather.is_some());
        s.route("上海",2000,Some(&c),"lab");assert_eq!(s.route("天气怎么样",4001,Some(&c),"lab").action,"clarify_city");
    }
    #[test] fn requested_advice_survives_weather_extraction(){
        let v=d("深圳今天的天气告诉我要不要带伞");assert_eq!(v["place_weather"]["place"],"深圳");assert!(v["requested_info"].as_array().unwrap_or(&vec![]).contains(&serde_json::json!("umbrella")));
    }
    #[test] fn uncertain_location_is_not_an_ip_guess(){
        assert_eq!(d("朝阳今天的天气")["action"],"clarify_city");
        assert_eq!(d("明明天会下雨吗")["action"],"clarify_city");
        assert_eq!(d("北京市朝阳区天气")["place_weather"]["place"],"北京市朝阳区");
    }
}

#[cfg(test)] mod phase1_config_guard_tests {
 use super::*;
 #[test] fn implicit_public_route_respects_disable_exclusion_and_priority(){
  let q="我想知道故宫今天开不开门";
  let mut c=RoutingConfig::default();
  c.rules.iter_mut().find(|r|r.id=="current-public-facts").unwrap().enabled=false;
  assert_eq!(RoutingSession::default().route(q,0,Some(&c),"x").action,"chat");
  c.rules.iter_mut().find(|r|r.id=="current-public-facts").unwrap().enabled=true;
  c.rules.iter_mut().find(|r|r.id=="current-public-facts").unwrap().exclude.push("故宫".into());
  assert_eq!(RoutingSession::default().route(q,0,Some(&c),"x").action,"chat");
  c.rules.iter_mut().find(|r|r.id=="current-public-facts").unwrap().exclude.clear();
  c.rules.push(Rule{id:"operator-protect".into(),enabled:true,priority:1000,action:"chat".into(),mode:"contains_any".into(),triggers:vec!["故宫".into()],exclude:vec![]});
  assert_eq!(RoutingSession::default().route(q,0,Some(&c),"x").rule_id,"operator-protect");
 }
}

#[cfg(test)] mod phase1_followup_guard_tests {
 use super::*;
 #[test] fn weather_context_is_one_adjacent_turn_and_expires(){
  let mut c=RoutingConfig::default();c.weather_enabled=true;c.baidu_weather_enabled=true;c.auto_location_enabled=true;
  let mut r=RoutingSession::default();r.route("深圳今天的天气",0,Some(&c),"x");
  let d=r.route("冷不冷",1000,Some(&c),"x");assert_eq!(d.action,"search");assert_eq!(d.place_weather.unwrap().place,"深圳");assert!(d.requested_info.iter().any(|n|n=="comfort"));
  let d=r.route("那后天呢",2000,Some(&c),"x");assert_eq!(d.place_weather.unwrap().day_offset,2);
  r.route("我有点冷",2500,Some(&c),"x");assert_eq!(r.route("冷不冷",3000,Some(&c),"x").action,"chat");
  r.route("深圳天气",4000,Some(&c),"x");assert_eq!(r.route("冷不冷",14001,Some(&c),"x").action,"chat");
  r.route("深圳天气",15000,Some(&c),"x");r.route("取消搜索",15001,Some(&c),"x");assert_eq!(r.route("那明天呢",15002,Some(&c),"x").action,"chat");
 }
}

#[cfg(test)] mod phase1_web_prefix_tests {
 use super::*;
 #[test] fn web_examples_do_not_become_places(){
  let mut c=RoutingConfig::default();c.weather_enabled=true;c.baidu_weather_enabled=true;c.auto_location_enabled=true;
  for (q,city,day) in [("我要查北京的天气","北京",0),("我想问后天杭州的天气","杭州",2)] {
   let d=RoutingSession::default().route(q,0,Some(&c),"x");let w=d.place_weather.unwrap();assert_eq!(w.place,city);assert_eq!(w.day_offset,day);
  }
  for q in ["我想查一下今天的天气","我要查今天天气"]{assert!(RoutingSession::default().route(q,0,Some(&c),"x").auto_weather.is_some());}
  assert_eq!(RoutingSession::default().route("我想知道你那里天气",0,Some(&c),"x").action,"clarify_city");
 }
}

#[cfg(test)]
mod lexicon_phase1_acceptance {
 use super::*;
 fn config()->RoutingConfig{let mut c=RoutingConfig::default();c.weather_enabled=true;c.auto_location_enabled=true;c.baidu_weather_enabled=true;c}
 #[test] fn lexicon_common_requests_keep_exact_city(){
  let c=config();for (text,city,day) in [("哎查上海天气","上海",0),("上海天气好么","上海",0),("能告诉我上海明天的天气吗","上海",1),("明天杭州的天气情况","杭州",1),("冷水江今天冷不冷","冷水江",0),("会同天气怎么样","会同",0)]{
   let d=RoutingSession::default().route(text,0,Some(&c),"x");assert_eq!(d.action,"search","{text}");let w=d.place_weather.expect(text);assert_eq!(w.place,city,"{text}");assert_eq!(w.day_offset,day);
  }
 }
 #[test] fn lexicon_umbrella_followup_keeps_city_day(){
  let c=config();for q in ["要带伞吗","要不要带伞呢","那要不要带伞","需要拿伞吗"] {
   let mut r=RoutingSession::default();r.route("深圳明天的天气",0,Some(&c),"x");
   let d=r.route(q,1000,Some(&c),"x");let w=d.place_weather.expect(q);assert_eq!(w.place,"深圳");assert_eq!(w.day_offset,1);assert!(d.requested_info.contains(&"umbrella".into()));
  }
 }
}
