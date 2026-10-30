//! One bounded routing engine for the Worker and the offline admin preview.
use crate::search_policy::{Intent, QueryIntent, intent, search_term_question};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

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
    #[serde(skip_serializing_if="Option::is_none")] pub auto_weather: Option<AutoWeatherRequest>,
    #[serde(skip_serializing_if="Option::is_none")] pub place_weather: Option<PlaceWeatherRequest>,
}
impl Decision {
    fn new(action: &str, rule: &str, reason: &str) -> Self { Self {action:action.into(),rule_id:rule.into(),reason:reason.into(),query:None,weather:None,auto_weather:None,place_weather:None} }
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
    search_term_question(t) || ["如果","假如","例如","比如","不要","不用","别","我自己","我说","他说","她说","你说","我今天","我现在","我们","“","‘","\"","'"].iter().any(|p| t.starts_with(p))
        || ["不要真的查","但不用搜索","心情","编一个","讲个故事"].iter().any(|p|t.contains(p))
        || ["搜索引擎","搜索算法","搜索功能","查询功能"].iter().any(|p|t.starts_with(p))
}
fn weather_topic(q: &str) -> bool {
    ["天气","气温","温度","下雨","降雨","空气质量","带伞","多少度"].iter().any(|p|q.contains(p))
        && !["为什么","原理","形成","是什么意思","什么是","心情","故事","烤箱","体温","发烧","开水","水温","空调","冰箱","显卡","电脑"].iter().any(|p|q.contains(p))
}
fn weather_parameters(q: &str) -> Option<AutoWeatherRequest> {
    if !weather_topic(q) || ["后后天","大后天","下周","周末","昨天","去年","小时","几点","今晚","早上","上午","下午","晚上","一周","未来","星期","周一","周二","周三","周四","周五","周六","周日","日出","日落","穿衣"].iter().any(|p|q.contains(p)) || q.chars().any(|c|c.is_ascii_digit()) {return None;}
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
fn weather_place_words(q: &str) -> String {
    // Only peel the weather grammar at the edges: global replacement corrupts
    // real names (e.g. 冷水江) and leaves 下 from 下不下雨 as a fake city.
    // A secondary activity question is not a place; retain it in d.query for
    // evidence-backed answering, but do not feed it to the city resolver.
    let end=q.char_indices().filter_map(|(i,_)| {
        let tail=&q[i..];
        (["，",",","？","?","。","放学","出门","上学","适合","适不适合","能不能"].iter().any(|s|tail.starts_with(s))
            && weather_topic(&q[..i])).then_some(i)
    }).next().unwrap_or(q.len());
    let mut rest=&q[..end];
    const WORDS:&[&str]=&["需不需要带伞","要不要带伞","下不下雨","会不会下雨","会不会","会下雨","空气质量","怎么样","是多少","多少度","这里","这边","本地","当地","实时","现在","今天","明天","后天","天气","气温","温度","下雨","降雨","带伞","需要","怎么","如何","好不好","不会","一下","小可","啊","的","会","吗","呢","呀","好","不","冷","热","有","没","？","?","。","，"," "];
    loop {
        if known_weather_place(rest) {break;}
        if let Some(next)=WORDS.iter().find_map(|w|rest.strip_suffix(w)){rest=next;continue;}
        if let Some(next)=WORDS.iter().find_map(|w|rest.strip_prefix(w)){rest=next;continue;}
        // Natural-weather rules can retain the imperative (e.g. 查北京今天的天气).
        // Peel only leading request grammar; preserve the original query and
        // still require an exact catalog place before selecting a weather tool.
        if let Some(next)=["请查一下","请查查","请查询","请查","查一下","查一查","查查","查询","查"].iter().find_map(|w|rest.strip_prefix(w)){rest=next;continue;}
        break;
    }
    rest.into()
}
fn expanded_weather(q:&str)->Option<PlaceWeatherRequest>{
    let p=weather_parameters(q)?;let place=weather_place_words(q);
    if place.is_empty()||place.chars().count()>40||!known_weather_place(&place){return None;}
    Some(PlaceWeatherRequest{place,day_offset:p.day_offset,metric:p.metric})
}
fn known_weather_place(t:&str)->bool {
    weather_place_names().contains(t.strip_prefix('啊').unwrap_or(t))
}
// Build the unchanged exact-match catalog before candidate registration, never
// on the first user's weather commit while the 100 ms microphone queue fills.
pub fn prepare_weather_places() -> usize { weather_place_names().len() }
fn weather_place_names() -> &'static HashSet<String> {
    static NAMES:std::sync::OnceLock<HashSet<String>>=std::sync::OnceLock::new();
    NAMES.get_or_init(||{
        let catalog:serde_json::Value=serde_json::from_str(include_str!("weather-places.json")).expect("weather catalog");let mut names=HashSet::new();
        for row in catalog["places"].as_array().expect("weather places"){
            let p=row[0].as_str().unwrap();let c=row[1].as_str().unwrap();let n=row[2].as_str().unwrap();
            for ps in [p.to_string(),format!("{p}省"),format!("{p}市")] {
                for cs in [c.to_string(),format!("{c}市")] {
                    for ns in [n.to_string(),format!("{n}市"),format!("{n}区"),format!("{n}县")] {
                        for s in [ns.clone(),format!("{ps}{ns}"),format!("{cs}{ns}"),format!("{ps}{cs}{ns}")] {names.insert(s);}
                    }
                }
            }
            for alias in row[4].as_array().unwrap(){names.insert(alias.as_str().unwrap().to_string());}
        }names
    })
}
#[derive(Default)]
pub struct RoutingSession { legacy: QueryIntent, pending_weather: Option<(u64,String,bool)>, version: String }
impl RoutingSession {
    pub fn take_handoff(&mut self)->Option<String>{self.legacy.take_handoff()}
    pub fn clear(&mut self) {self.legacy.clear();self.pending_weather=None;}
    pub fn route(&mut self,text:&str,now:u64,config:Option<&RoutingConfig>,version:&str) -> Decision {
        self.legacy.take_handoff();
        if self.version!=version {self.clear();self.version=version.into();}
        let pending=self.pending_weather.take();
        // Known first-party game mechanics use the local Brain knowledge; no web task needed.
        if ark_resource_question(text) && !matches!(intent(addressed(text)), Some(Intent::Cancel | Intent::Resume | Intent::Replace(_))) { self.clear(); return Decision::new("chat", "ark-local-knowledge", "方舟资源用途由本地知识回答"); }
        let Some(config)=config else {return self.legacy_decision(text,now,None);};
        let t=addressed(text);
        // Control commands retain authority even if all editable rules are disabled.
        if let Some(control @ (Intent::Cancel|Intent::Resume|Intent::Replace(_)))=intent(t) {
            self.legacy.clear();let control=self.legacy.route(text,now).unwrap_or(control);
            return self.from_intent(control,"builtin-control",now,Some(config));
        }
        if t.is_empty() || t.chars().count()>128 || t.chars().any(char::is_control) || protected(t) {self.clear();return Decision::new("chat","protected","普通聊天或保护表达");}
        if config.weather_enabled && config.baidu_weather_enabled {
            if let Some(q)=["该插","改插","该查"].iter().find_map(|p|t.strip_prefix(p)) {
                if expanded_weather(q).is_some() {
                    self.legacy.clear();return self.from_intent(Intent::Replace(q.into()),"builtin-control",now,Some(config));
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
        let mut rules:Vec<_>=config.rules.iter().filter(|r|r.enabled).collect();
        rules.sort_by(|a,b|b.priority.cmp(&a.priority).then(a.id.cmp(&b.id)));
        for r in rules {
            if r.exclude.iter().any(|x|t.contains(x)) {continue;}
            let hit=match r.mode.as_str(){"prefix"=>r.triggers.iter().any(|x|t.starts_with(x)),"contains_all"=>r.triggers.iter().all(|x|t.contains(x)),_=>r.triggers.iter().any(|x|t.contains(x))};
            if !hit {continue;}
            if r.action=="chat" {return Decision::new("chat",&r.id,"命中普通聊天规则");}
            let q=if r.mode=="prefix" {r.triggers.iter().filter_map(|p|t.strip_prefix(p).map(|rest|(p.len(),rest))).max_by_key(|(len,_)|*len).map(|(_,s)|trim(s)).unwrap_or(t)} else {t};
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
                if weather_without_place(q) {
                    let automatic=config.is_some_and(|c|c.weather_enabled&&c.auto_location_enabled);
                    if automatic {d.auto_weather=weather_parameters(q);d.reason="后台按本轮设备网络定位城市，不等待前台聊天".into();}
                    if d.auto_weather.is_none(){self.pending_weather=Some((now,q.clone(),name=="replace"));d.action="clarify_city".into();d.reason="天气查询缺少城市".into();d.query=None;}
                }
                else if config.is_some_and(|c|c.baidu_weather_enabled&&c.weather_enabled){d.place_weather=expanded_weather(q);if d.place_weather.is_some(){d.reason="后台校验省市与天气站后查询百度天气".into();}else{d.reason="日期或指标未由天气适配器支持，使用通用搜索".into();}}
                else {d.weather=supported_weather(q);if d.weather.is_none(){d.reason="城市或日期未由天气适配器支持，使用通用搜索".into();}}
            }
        } d
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
    #[test] fn r26_continued_weather_imperative_keeps_verified_place() {
        let c=RoutingConfig{weather_enabled:true,auto_location_enabled:true,baidu_weather_enabled:true,..RoutingConfig::default()};
        for (text,place) in [("查北京今天的天气","北京"),("查成都今天的天气","成都"),("请查一下北京市明天天气","北京市"),("小可，查深圳现在多少度","深圳")] {
            let d=RoutingSession::default().route(text,0,Some(&c),"r26-continued");
            assert_eq!(d.action,"search","{text}");
            assert_eq!(d.place_weather.as_ref().map(|w|w.place.as_str()),Some(place),"{text}: {d:?}");
            assert!(d.auto_weather.is_none(),"explicit place must not become device location");
        }
        for text in ["查我家附近今天的天气","查北京大学今天的天气","查北京下周的天气","查北京和上海今天的天气"] {
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
        for text in ["帮我查巴黎天气","帮我查火星市天气","北京和上海天气","新加坡北京天气"] {
            let d=RoutingSession::default().route(text,0,Some(&c),"r23");assert!(d.auto_weather.is_none(),"unknown explicit place must not become local: {text}");assert!(d.place_weather.is_none(),"unverified place must use general search: {text}");
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
