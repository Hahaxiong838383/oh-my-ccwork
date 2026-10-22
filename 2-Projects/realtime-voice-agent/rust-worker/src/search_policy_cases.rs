use super::*;

// Independent acceptance corpus: remove natural-intent routing and these fail.
const TOPICS: &[&str] = &[
 "今天北京的天气", "火星为什么是红色的", "恐龙灭绝的原因", "故宫明天开放吗",
 "上海科技馆门票价格", "今年诺贝尔物理学奖", "最近的航天新闻", "三角龙吃什么",
 "中华人民共和国成立的时间", "月球距离地球多远", "水为什么会结冰", "人民币和美元的汇率",
 "明天北京会下雨吗", "2020年北京的人口", "我国空间站最新进展", "C++是什么",
];
#[test]
fn explicit_request_variants_preserve_topics_across_domains() {
 let mut errors=Vec::new();
 for prefix in ["帮我查一下", "帮我查查", "请帮我查一查", "查查", "查一查", "搜索一下", "搜一下", "帮我搜搜", "请查询", "帮我查询", "帮忙查一下", "能不能帮我查一下", "你能帮我搜一下", "可以帮我查查", "麻烦查一下", "小可，帮我查一下", "嗯，小可小可，帮我查查", "请上网查一下", "帮我在网上搜一下"] {
  for topic in TOPICS {
   let text=format!("{prefix}{topic}");
   if intent(&text)!=Some(Intent::Search((*topic).into())) { errors.push(text); }
  }
 }
 assert!(errors.is_empty(), "{} missed explicit queries: {:?}",errors.len(), &errors[..errors.len().min(12)]);
}
#[test]
fn contextual_suffix_and_politeness_do_not_become_part_of_query() {
 for (text,query) in [("故宫明天开放吗，帮我查一下","故宫明天开放吗"),("帮我查查三角龙吃什么，好吗？","三角龙吃什么"),("帮我搜索一下火星，行吗","火星"),("请帮我查一下C++是什么。","C++是什么")] {
  assert_eq!(intent(text),Some(Intent::Search(query.into())),"{text}");
 }
}
#[test]
fn negation_quotes_personal_chat_and_device_actions_do_not_search() {
 for text in ["不要搜索科技馆", "别查北京天气", "不用帮我查天气", "我自己去查一下天气", "我查一下天气就回来", "我说帮我查一下是什么意思", "他说帮我查查天气", "‘帮我查一下天气’这句话", "“查一下天气”是什么意思", "查查这个词是什么意思", "搜索引擎是什么", "搜索是什么意思", "查询是什么意思", "我今天画了一只小猫", "今天心情不好", "我想听恐龙的故事", "编一个关于搜索的故事", "把声音调大", "停一下", "继续讲故事", "你能不能讲个笑话", "帮我画一只小猫", "帮我查一下是什么意思", "不用查了是什么意思", "取消搜索这个词是什么意思"] {
  assert_eq!(intent(text),None,"must not create a task: {text}");
 }
}
#[test]
fn vague_or_missing_search_topic_requires_clarification_not_model_promise() {
 for text in ["帮我查查", "帮我查一下", "搜一下", "改查", "我查一下今天北京的天气", "帮我查一下那个", "帮我查一下刚才那个", "查一下这个", "查一下吧"] {
  assert_eq!(format!("{:?}",intent(text)),"Some(Clarify)","{text}");
 }
}
#[test]
fn natural_cancel_resume_and_replace_are_explicit_and_disjoint() {
 for text in ["取消刚才的查询", "不用搜索了", "别搜了", "不用查了，我们聊别的", "小可，取消搜索吧"] { assert_eq!(intent(text),Some(Intent::Cancel),"{text}"); }
 for text in ["继续播刚才的搜索结果", "刚才查的结果呢", "查好了吗", "搜到了吗", "接着说刚才查到的"] { assert_eq!(intent(text),Some(Intent::Resume),"{text}"); }
 for (text,query) in [("换查上海科技馆的门票","上海科技馆的门票"),("改为查询恐龙灭绝的原因","恐龙灭绝的原因"),("不查北京了，改查上海的天气","上海的天气")] {assert_eq!(intent(text),Some(Intent::Replace(query.into())),"{text}");}
}
#[test]
fn clarified_followups_cover_nonweather_topics_and_are_one_turn_only() {
 for topic in TOPICS {
  let mut r=QueryIntent::default();assert_eq!(r.route("帮我查查",0),Some(Intent::Clarify));
  assert_eq!(r.route(topic,4000),Some(Intent::Search((*topic).into())));
 }
 for text in ["我今天画了一只小猫", "我们聊点别的", "不要查", "算了", "讲个故事"] {
  let mut r=QueryIntent::default();r.route("帮我查查",0);assert_eq!(r.route(text,1000),None,"{text}");
  assert_eq!(r.route("火星",1500),None,"a rejected next turn must consume pending intent");
 }
 let mut r=QueryIntent::default();r.route("改查",0);assert_eq!(r.route("故宫门票",8000),Some(Intent::Replace("故宫门票".into())));
 r.route("帮我查查",10000);assert_eq!(r.route("恐龙",20001),None);
}
#[test]
fn held_out_requests_and_contradictions_do_not_depend_on_weather_words() {
 for (text,q) in [("麻烦你帮我查故宫的开放安排","故宫的开放安排"),("小可，帮我搜火星探测的最新进展","火星探测的最新进展"),("我想请你查一下三角龙吃什么","三角龙吃什么"),("请你帮忙查询上海科技馆门票","上海科技馆门票")] {assert_eq!(intent(text),Some(Intent::Search(q.into())),"{text}");}
 for text in ["帮我查一下新闻，不要真的查", "帮我搜一下新闻，但不用搜索", "查理和巧克力工厂讲什么", "搜救队是什么", "查询功能是怎么实现的"] {assert_eq!(intent(text),None,"{text}");}
}
#[test]
fn asr_missing_delimiters_keeps_suffix_cancel_and_replace_intents() {
 assert_eq!(intent("故宫明天开放吗帮我查一下"),Some(Intent::Search("故宫明天开放吗".into())));
 assert_eq!(intent("不用查了我们聊别的"),Some(Intent::Cancel));
 assert_eq!(intent("不查北京了改查上海的天气"),Some(Intent::Replace("上海的天气".into())));
 for text in ["如果我说故宫明天开放吗帮我查一下", "比如火星为什么红帮我查一下", "不用查了是什么意思"] {assert_eq!(intent(text),None,"{text}");}
}
