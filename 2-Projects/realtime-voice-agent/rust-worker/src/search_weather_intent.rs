// Pure, bounded weather intent helpers shared by Worker and admin preview.
fn weather_needs(t: &str) -> Vec<String> {
    let mut result=Vec::new();
    if ["冷不冷","热不热","冷吗","热吗"].iter().any(|x|t.contains(x)){result.push("comfort".into());}
    if ["带伞","拿伞","用伞"].iter().any(|x|t.contains(x)){result.push("umbrella".into());}
    if result.is_empty(){result.push("overview".into());}result
}
fn personal_ark_request(t:&str)->bool {
    ["补勤卡","补签卡","家族币","星尘"].iter().any(|x|t.contains(x))
      && ["我有","我的","几张","多少张","库存","余额","数量","还剩","有多少"].iter().any(|x|t.contains(x))
      && !["天文","黄金","比特币","原神","我的世界"].iter().any(|x|t.contains(x))
}
fn implicit_current_public(t:&str)->Option<&str>{
    let q=["我想知道","我想问问","想知道","我想了解"].iter().find_map(|p|t.strip_prefix(p))?;
    if protected(q)||["我的","我有","你喜欢","我家","我的账号"].iter().any(|p|q.contains(p)){return None;}
    let current=["今天","今日","现在","当前","最新","明天"].iter().any(|p|q.contains(p));
    let venue=["故宫","博物馆","科技馆","图书馆","动物园","景区","公园","展览"].iter().any(|p|q.contains(p));
    let operation=["开不开门","开放","开门","闭馆","营业","门票","票价"].iter().any(|p|q.contains(p));
    let public=["新闻","消息","汇率"].iter().any(|p|q.contains(p));
    (current&&(venue&&operation||public)).then_some(q)
}
fn city_fragment(t:&str)->Option<String>{
    let core=["今天","明天","后天"].iter().find_map(|p|t.strip_suffix(p)).unwrap_or(t);
    (known_weather_place(core)&&!ambiguous_weather_place(core)).then(||t.into())
}
fn weather_tail(t:&str)->bool {
    weather_topic(t)&&weather_parameters(t).is_some()&&weather_place_words(t).is_empty()
}
fn join_city_fragment(fragment:&str,t:&str)->String {
    let place=if ["今天","明天","后天"].iter().any(|d|t.contains(d)) {
        ["今天","明天","后天"].iter().find_map(|d|fragment.strip_suffix(d)).unwrap_or(fragment)
    } else {fragment};format!("{place}{t}")
}
fn ambiguous_weather_place(t:&str)->bool {
    static AMBIGUOUS:std::sync::OnceLock<HashSet<String>>=std::sync::OnceLock::new();
    AMBIGUOUS.get_or_init(||{
        let catalog:serde_json::Value=serde_json::from_str(include_str!("weather-places.json")).unwrap();
        let mut owner=std::collections::HashMap::<String,String>::new();let mut ambiguous=HashSet::new();
        for row in catalog["places"].as_array().unwrap(){
            let station=row[3].as_str().unwrap();
            for alias in weather_aliases(row){
                if let Some(old)=owner.get(&alias){if old!=station{ambiguous.insert(alias);}}
                else{owner.insert(alias,station.into());}
            }
        }ambiguous
    }).contains(t)
}
fn weather_aliases(row:&serde_json::Value)->Vec<String>{
    let p=row[0].as_str().unwrap();let c=row[1].as_str().unwrap();let n=row[2].as_str().unwrap();
    let full=match p{"北京"|"上海"|"天津"|"重庆"=>format!("{p}市"),"内蒙古"=>"内蒙古自治区".into(),"广西"=>"广西壮族自治区".into(),"宁夏"=>"宁夏回族自治区".into(),"新疆"=>"新疆维吾尔自治区".into(),"西藏"=>"西藏自治区".into(),"香港"|"澳门"=>format!("{p}特别行政区"),_=>format!("{p}省")};
    let ps=[p.to_string(),full];let aliases:Vec<String>=row[4].as_array().unwrap().iter().map(|v|v.as_str().unwrap().to_string()).collect();
    let mut cs=vec![c.to_string(),format!("{c}市")];cs.extend(aliases.clone());
    let mut ns=vec![n.to_string()];if n==c{ns.push(format!("{n}市"));ns.extend(aliases);}else{ns.extend([format!("{n}区"),format!("{n}县")]);}
    let mut out=Vec::new();for n in ns{out.push(n.clone());for p in &ps{out.push(format!("{p}{n}"));}for c in &cs{out.push(format!("{c}{n}"));for p in &ps{out.push(format!("{p}{c}{n}"));}}}out
}

fn weather_context_suffix(t:&str,day:u8)->Option<String>{
 let t=t.strip_prefix("那").unwrap_or(t).trim_end_matches(|c:char|"呢啊呀？?。 ".contains(c));
 if ["冷不冷","热不热","冷吗","热吗","要不要带伞","需不需要带伞","要带伞吗","带伞吗","需要带伞吗","要拿伞吗","需要拿伞吗"].contains(&t) {
  return Some(format!("{}{}",["今天","明天","后天"].get(day as usize)?,t));
 }
 for (d,label) in [(0,"今天"),(1,"明天"),(2,"后天")] {
  if t==label || t==format!("{label}呢") {return Some(format!("{}天气",["今天","明天","后天"][d]));}
 }None
}
