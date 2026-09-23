//! 语法层 L1g（D2，2026-09-23 川哥拍板）：词表精确匹配之后、大模型慢路之前的确定性匹配。
//!
//! 设计（人话）：一句设备请求在结构上是「对象 + 方向 + 程度」。本层只认结构、不猜语义：
//! 1. 先挡后认（宁漏勿误）：超长句、否定、假设、转述讨论、叙述、第三人称、疑问、数字、感受抱怨、闲聊义、
//!    陈述句（「的」结尾 / 带「是」「有」）一律不认；
//! 2. 找对象：灯光 / 色温 / 音量 / 读写台电机 / 设备电机 / 虚像，两个域同时出现不认；没有对象只认少数不歧义动词；
//! 3. 找方向与程度：最值 > 明确开关动词 > 抱怨现状（方向取反）> 一级方向词；
//! 4. 标签号、动作名全部查现有 389 条词表（`device_intent::command_by_label`），本层不发明标签。
//!
//! 证据：`P003-product-definition/docs/2026-09-23-语音控设备语法匹配验证.md`（两机 11,156 句真实语料：
//! 比词表多接住 77 句、闲聊 0 误开火、历史慢路 3 条误触发全拦、389 条词表回放 0 冲突）。
//! 原型（Python，同规则）：`rust-worker/scripts/device_grammar_proto.py`；本文件是它的逐条移植，测试数据同源。
//!
//! 开关 `DEVICE_GRAMMAR_MODE=off|observe|execute`（默认 observe：只记日志不执行；execute 走与 L1 完全相同的
//! `start_device_command` 链路，lane 标 `L1g`）。回退 = 置 off，无需换装。

use crate::device_intent::{self, DeviceCommand};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off,
    Observe,
    Execute,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Observe => "observe",
            Mode::Execute => "execute",
        }
    }
}

/// env 每次读取（与 `device_filler_enabled_for` 同纪律；env-only 重启即生效）。未设/未知值 = observe。
pub fn mode() -> Mode {
    parse_mode(std::env::var("DEVICE_GRAMMAR_MODE").ok().as_deref())
}

pub fn parse_mode(v: Option<&str>) -> Mode {
    match v.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("off") | Some("0") | Some("false") => Mode::Off,
        Some("execute") | Some("exec") | Some("on") => Mode::Execute,
        _ => Mode::Observe,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GrammarHit {
    pub label: u32,
    pub action: &'static str,
    /// LIGHT / CT / VOL / RW / MOTOR / DIST
    pub domain: &'static str,
    /// 剥完语气词后的句子（进日志 / normalized_text）
    pub peeled: String,
}

impl GrammarHit {
    /// 与 L1 同构的命令对象（标签反查同一张表；match_type 标 grammar）。
    pub fn command(&self) -> Option<DeviceCommand> {
        device_intent::command_by_label(self.label).map(|mut c| {
            c.match_type = "grammar";
            c.normalized_text = self.peeled.clone();
            c
        })
    }
}

/// 纯函数：不看 mode。命中 → Ok(hit)；不认 → Err(原因)。原因只进日志与测试。
pub fn judge(text: &str) -> Result<GrammarHit, String> {
    let t = device_intent::peel_polite(text);
    if t.is_empty() {
        return Err("empty".into());
    }
    let n = t.chars().count();
    if n > MAX_LEN {
        return Err("too_long".into());
    }
    for (name, ws) in [
        ("chat_sense", CHAT_SENSE),
        ("third_party", THIRD),
        ("narrative", NARR),
        ("discuss", DISCUSS),
        ("perception", PERCEPT),
        ("negation", NEG),
    ] {
        if let Some(w) = has(&t, ws) {
            // 感受词（看不清/听不清）与说清物理量的抱怨（太暗/太亮/刺眼）同句时，按物理量走
            if name == "perception" && has(&t, PHYSICAL_COMPLAINT).is_some() {
                continue;
            }
            return Err(format!("{name}:{w}"));
        }
    }
    if neg_adj(&t) {
        return Err("negation_adj".into());
    }
    if has_number(&t) {
        return Err("number".into());
    }
    if has(&t, DONE).is_some() {
        return Err("done_action".into());
    }
    if t.ends_with('的') {
        return Err("statement_de".into());
    }
    let req = has(&t, REQ).is_some();
    if let Some(q) = has(&t, QWORDS)
        && !((q == "吗" || q == "呢") && req)
    {
        return Err(format!("question:{q}"));
    }
    if t.contains('是') && !req {
        return Err("statement_shi".into());
    }
    if you_statement(&t) {
        return Err("statement_you".into());
    }
    if t.starts_with('我') && has(&t, SELF_REQ).is_none() {
        return Err("self_narrative".into());
    }
    let dom = domain(&t)?;
    let label = match dom {
        "LIGHT" => rule_light(&t),
        "CT" => rule_ct(&t),
        "RW" => rule_motor(&t, true),
        "MOTOR" => rule_motor(&t, false),
        "DIST" => rule_dist(&t),
        "VOL" => rule_vol(&t),
        _ => None,
    };
    match label {
        Some(label) => match device_intent::command_by_label(label) {
            Some(c) => Ok(GrammarHit {
                label,
                action: c.action,
                domain: dom,
                peeled: t,
            }),
            None => Err(format!("label_not_in_table:{label}")),
        },
        None => Err(format!("no_direction:{dom}")),
    }
}

/// 命中即 Some（不看 mode）。
pub fn grammar_match(text: &str) -> Option<GrammarHit> {
    judge(text).ok()
}

/// 只在 execute 档返回命中（pipeline 命令分支 / 回声窗豁免用）。
pub fn executable(text: &str) -> Option<GrammarHit> {
    if mode() == Mode::Execute {
        grammar_match(text)
    } else {
        None
    }
}

// ---------------- 词表（与原型 v4 逐条同源）----------------
const MAX_LEN: usize = 14;
const NEG: &[&str] = &[
    "不要",
    "不用",
    "别",
    "不是",
    "没有",
    "没",
    "不能",
    "不会",
    "不想",
    "不许",
    "不准",
    "不可以",
    "不行",
    "不知道",
];
const NEG_ADJ_TAIL: &[char] = &[
    '高', '亮', '暗', '大', '小', '远', '近', '暖', '冷', '开', '关', '响',
];
const NARR: &[&str] = &[
    "刚才", "刚刚", "刚", "昨天", "已经", "之前", "以前", "然后", "后来", "一直", "总是", "忘了",
    "忘记", "曾经", "上次", "昨晚", "又", "着",
];
const DISCUSS: &[&str] = &[
    "如果", "要是", "假如", "万一", "但是", "不过", "可是", "因为", "所以", "或者", "还是", "到底",
    "同时", "效果", "米数", "数值", "参数", "也", "用", "说", "你看", "看看", "挺", "比较", "怕",
    "它", "这样", "那样", "一种", "会", "应该", "可能", "好像", "感觉", "觉得", "其实", "反正",
    "而且",
];
const PERCEPT: &[&str] = &[
    "听不到",
    "听不见",
    "听不清",
    "看不清",
    "看不见",
    "太吵",
    "好吵",
    "啰嗦",
    "安静",
];
const PHYSICAL_COMPLAINT: &[&str] = &["太暗", "太亮", "刺眼", "晃眼", "太黑"];
const QWORDS: &[&str] = &[
    "为什么",
    "为啥",
    "怎么",
    "什么",
    "哪",
    "几",
    "多少",
    "会不会",
    "是不是",
    "有没有",
    "吗",
    "呢",
];
const REQ: &[&str] = &[
    "可以",
    "能不能",
    "能",
    "帮我",
    "请",
    "麻烦",
    "要",
    "想",
    "给我",
    "让",
    "需要",
    "希望",
    "来",
    "得",
];
const THIRD: &[&str] = &[
    "他", "她", "妈妈", "爸爸", "老师", "同学", "别人", "大家", "小明", "朋友", "哥哥", "姐姐",
    "弟弟", "妹妹", "爷爷", "奶奶", "外公", "外婆", "叔叔", "阿姨", "他们", "她们", "你们", "咱们",
];
const CHAT_SENSE: &[&str] = &[
    "空调",
    "灯会",
    "灯笼",
    "灯谜",
    "红绿灯",
    "路灯",
    "车灯",
    "闪光灯",
    "灯塔",
    "花灯",
    "神灯",
    "灯火",
    "灯泡",
    "灯节",
    "点灯",
    "灯下",
    "开心",
    "开始",
    "开学",
    "开门",
    "开车",
    "开会",
    "开玩笑",
    "离开",
    "开水",
    "开花",
    "关系",
    "关心",
    "关于",
    "关门",
    "关注",
    "关键",
    "海关",
    "机关",
    "好看",
    "好听",
    "漂亮",
    "真美",
    "好美",
    "真好",
    "喜欢",
    "讨厌",
    "害怕",
    "故事",
    "唱",
    "歌",
    "游戏",
    "电影",
    "视频",
    "动画",
    "比赛",
    "太阳",
    "月亮",
    "星星",
    "天气",
    "外面",
    "屋里",
    "房间",
    "教室",
    "学校",
    "画面感",
    "音量键",
    "声音像",
    "声音好",
    "声音真",
    "声音很",
];
const SELF_REQ: &[&str] = &[
    "我要",
    "我想",
    "我得",
    "我需要",
    "我希望",
    "给我",
    "让我",
    "我来",
];
const DONE: &[&str] = &["关了灯", "开了灯", "调了灯", "关了光", "开了光", "调了光"];
const CN_NUM: &[char] = &[
    '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '两',
];
const UNITS: &[&str] = &["厘米", "分米", "米", "度", "格"];

const LIGHT_OBJ: &[&str] = &["灯光", "台灯", "灯", "光线", "亮度"];
const CT_OBJ: &[&str] = &[
    "色温",
    "光谱",
    "暖光",
    "冷光",
    "中性光",
    "暖色",
    "冷色",
    "中性",
    "绘画模式",
    "夜读",
    "阅读模式",
    "常规",
    "普通模式",
    "画画",
];
const MOTOR_OBJ: &[&str] = &["台子", "高度"];
const DIST_OBJ: &[&str] = &["虚像", "画面", "显示", "距离", "趋向"];
const VOL_OBJ: &[&str] = &["音量", "声音", "大声", "小声", "点声", "静音", "声"];

const VERB_VOL: &[&str] = &["大声", "小声", "点声"];
const VERB_LIGHT: &[&str] = &[
    "调亮",
    "调暗",
    "变亮",
    "变暗",
    "弄亮",
    "弄暗",
    "亮一点",
    "暗一点",
    "亮一些",
    "暗一些",
    "开灯",
    "关灯",
    "太亮",
    "太暗",
    "刺眼",
    "晃眼",
    "最亮",
    "最暗",
    "调到柔和",
    "调到标准",
    "调到明亮",
];
const VERB_CT: &[&str] = &[
    "调暖",
    "调冷",
    "暖一点",
    "冷一点",
    "暖一些",
    "冷一些",
    "暖一级",
    "冷一级",
    "最冷",
    "最暖",
];
const VERB_MOTOR: &[&str] = &[
    "往上一点",
    "往下一点",
    "高一点点",
    "低一点点",
    "升到最高",
    "降到最低",
    "升到顶",
    "降到底",
];
const VERB_DIST: &[&str] = &[
    "拉远",
    "拉近",
    "调远",
    "调近",
    "调到最远",
    "调到最近",
    "再远一些",
    "再近一些",
    "拉到最远",
    "拉到最近",
];

// ---------------- 小工具（无 regex 依赖，按字符位置判邻接）----------------
fn has<'a>(t: &str, ws: &[&'a str]) -> Option<&'a str> {
    ws.iter().copied().find(|w| t.contains(w))
}

fn any(t: &str, ws: &[&str]) -> bool {
    has(t, ws).is_some()
}

fn positions(t: &[char], pat: &str) -> Vec<usize> {
    let p: Vec<char> = pat.chars().collect();
    if p.is_empty() || p.len() > t.len() {
        return vec![];
    }
    (0..=t.len() - p.len())
        .filter(|&i| t[i..i + p.len()] == p[..])
        .collect()
}

/// `a` 后面隔 ≤ max_gap 个字出现 `b`（regex `a.{0,gap}b` 的等价）。
fn near(t: &[char], a: &str, b: &str, max_gap: usize) -> bool {
    let alen = a.chars().count();
    let pa = positions(t, a);
    if pa.is_empty() {
        return false;
    }
    let pb = positions(t, b);
    pa.iter().any(|&i| {
        pb.iter()
            .any(|&j| j >= i + alen && j - (i + alen) <= max_gap)
    })
}

fn any_near(t: &[char], aa: &[&str], bb: &[&str], max_gap: usize) -> bool {
    aa.iter().any(|a| bb.iter().any(|b| near(t, a, b, max_gap)))
}

fn preceded_by(t: &[char], pat: &str, prev: &[char]) -> bool {
    let plen = pat.chars().count();
    positions(t, pat)
        .iter()
        .any(|&i| i > 0 && prev.contains(&t[i - 1]) && plen > 0)
}

fn not_preceded_by(t: &[char], pat: &str, prev: &[char]) -> bool {
    positions(t, pat)
        .iter()
        .any(|&i| i == 0 || !prev.contains(&t[i - 1]))
}

fn neg_adj(t: &str) -> bool {
    let c: Vec<char> = t.chars().collect();
    c.windows(2)
        .any(|w| w[0] == '不' && NEG_ADJ_TAIL.contains(&w[1]))
}

fn has_number(t: &str) -> bool {
    if t.chars().any(|c| c.is_ascii_digit()) {
        return true;
    }
    let c: Vec<char> = t.chars().collect();
    for &i in &positions(&c, "百分之") {
        if c.get(i + 3) != Some(&'百') {
            return true;
        }
    }
    // 中文数字 + 单位（米/厘米/分米/度/格）
    for u in UNITS {
        for &j in &positions(&c, u) {
            if j > 0 && CN_NUM.contains(&c[j - 1]) {
                return true;
            }
        }
    }
    false
}

/// 「有」不接 点/些/一点/一些 → 陈述（有冷光 / 有灯）
fn you_statement(t: &str) -> bool {
    let c: Vec<char> = t.chars().collect();
    positions(&c, "有").iter().any(|&i| {
        let n1 = c.get(i + 1).copied();
        let n2 = c.get(i + 2).copied();
        !(n1 == Some('点')
            || n1 == Some('些')
            || (n1 == Some('一') && (n2 == Some('点') || n2 == Some('些'))))
    })
}

/// 灯光对象里的裸「光」：前不是 暖/冷/性，后不是 谱/线（在剔除色温、音量词后的串上判）。
fn lone_guang(t2: &[char]) -> bool {
    positions(t2, "光").iter().any(|&i| {
        let prev_ok = i == 0 || !['暖', '冷', '性'].contains(&t2[i - 1]);
        let next_ok = t2.get(i + 1).is_none_or(|n| !['谱', '线'].contains(n));
        prev_ok && next_ok
    })
}

fn domain(t: &str) -> Result<&'static str, String> {
    if t.contains("静音") {
        return Ok("VOL");
    }
    let mut d: Vec<&'static str> = Vec::new();
    if any(t, CT_OBJ) {
        d.push("CT");
    }
    if any(t, DIST_OBJ) {
        d.push("DIST");
    }
    if any(t, VOL_OBJ) {
        d.push("VOL");
    }
    if t.contains("读写台") {
        d.push("RW");
    } else if any(t, MOTOR_OBJ) {
        d.push("MOTOR");
    }
    let mut t2 = t.to_string();
    for w in CT_OBJ.iter().chain(VOL_OBJ.iter()) {
        t2 = t2.replace(w, "");
    }
    let t2c: Vec<char> = t2.chars().collect();
    let light = any(&t2, LIGHT_OBJ) || lone_guang(&t2c);
    if light {
        d.push("LIGHT");
    }
    if d.is_empty() && t.contains("设备") {
        d.push("MOTOR");
    }
    // 灯光对象 + 暖/冷 → 色温域（「灯光调暖一点」「最冷的光」）
    if d.contains(&"LIGHT") && !d.contains(&"CT") && (t.contains('暖') || t.contains('冷')) {
        d.retain(|x| *x != "LIGHT");
        d.push("CT");
    }
    if d.is_empty() {
        let c: Vec<char> = t.chars().collect();
        let motor_verb = any_near(&c, &["升高", "抬高", "降低"], &["一点", "一些", "点"], 0)
            || any(t, VERB_MOTOR);
        let inferred = if any(t, VERB_VOL) {
            Some("VOL")
        } else if any(t, VERB_LIGHT) {
            Some("LIGHT")
        } else if any(t, VERB_CT) {
            Some("CT")
        } else if motor_verb {
            Some("MOTOR")
        } else if any(t, VERB_DIST) {
            Some("DIST")
        } else {
            None
        };
        return inferred.ok_or_else(|| "no_domain".to_string());
    }
    if d.contains(&"CT") && d.contains(&"LIGHT") {
        d.retain(|x| *x != "LIGHT");
    }
    if d.len() > 1 {
        d.sort_unstable();
        return Err(format!("ambiguous_domain:{}", d.join("+")));
    }
    Ok(d[0])
}

fn rule_light(t: &str) -> Option<u32> {
    let c: Vec<char> = t.chars().collect();
    if any(
        t,
        &[
            "最亮",
            "最高亮度",
            "最大亮度",
            "亮度最大",
            "亮度调到最大",
            "开到最大",
            "调满",
            "全亮",
        ],
    ) {
        return Some(5);
    }
    if any(
        t,
        &[
            "最暗",
            "最低亮度",
            "亮度最低",
            "亮度最小",
            "亮度调到最小",
            "调到最低",
        ],
    ) {
        return Some(7);
    }
    if any(t, &["一档", "柔和"]) {
        return Some(8);
    }
    if any(t, &["二档", "标准"]) {
        return Some(9);
    }
    if any(t, &["三档", "明亮"]) {
        return Some(10);
    }
    if any(t, &["关", "熄", "灭"]) {
        return Some(3);
    }
    if any(
        t,
        &[
            "打开",
            "开启",
            "开灯",
            "灯开",
            "开一下",
            "开着",
            "开光",
            "光开",
            "亮起来",
        ],
    ) || not_preceded_by(&c, "点亮", &['一'])
    {
        return Some(2);
    }
    if any(t, &["太亮", "刺眼", "晃眼", "好亮", "亮死"]) {
        return Some(6);
    }
    if any(t, &["太暗", "好暗", "暗死", "太黑", "好黑"]) {
        return Some(4);
    }
    let up = any(
        t,
        &["调亮", "变亮", "弄亮", "亮一点", "亮一些", "再亮", "亮一亮"],
    ) || preceded_by(&c, "亮点", &['调', '再', '灯', '光'])
        || near(&c, "提高", "亮度", 2)
        || any_near(
            &c,
            &["亮度"],
            &["提高", "调高", "高", "大", "加", "上", "增"],
            2,
        );
    let dn = any(t, &["调暗", "变暗", "弄暗", "暗一点", "暗一些", "再暗"])
        || preceded_by(&c, "暗点", &['调', '再', '灯', '光'])
        || near(&c, "降低", "亮度", 2)
        || any_near(&c, &["亮度"], &["降低", "调低", "低", "小", "减", "下"], 2);
    match (up, dn) {
        (true, true) => None,
        (true, false) => Some(4),
        (false, true) => Some(6),
        _ => None,
    }
}

fn rule_ct(t: &str) -> Option<u32> {
    let c: Vec<char> = t.chars().collect();
    if t.contains("最暖") {
        return Some(17);
    }
    if t.contains("最冷") {
        return Some(16);
    }
    if any(t, &["正常", "默认", "恢复"]) && any(t, &["色温", "光谱", "光"]) {
        return Some(18);
    }
    if any(t, &["绘画", "画画"]) {
        return Some(19);
    }
    let preset_verb = any(
        t,
        &["调", "换", "切", "开", "到", "成", "用", "要", "来", "给"],
    );
    if any(t, &["常规", "普通"]) {
        return if preset_verb || any(t, &["恢复", "模式"]) {
            Some(20)
        } else {
            None
        };
    }
    if any(t, &["夜读", "阅读"]) {
        return if preset_verb || t.contains("模式") {
            Some(21)
        } else {
            None
        };
    }
    if any_near(&c, &["暖"], &["一级", "一档"], 3) {
        return Some(12);
    }
    if any_near(&c, &["冷"], &["一级", "一档"], 3) {
        return Some(13);
    }
    if any(t, &["暖光", "暖色"]) {
        return if preset_verb { Some(22) } else { None };
    }
    if any(t, &["冷光", "冷色"]) {
        return if preset_verb { Some(23) } else { None };
    }
    if t.contains("中性") {
        return if preset_verb { Some(24) } else { None };
    }
    if any(t, &["太暖", "好暖"]) {
        return Some(15);
    }
    if any(t, &["太冷", "好冷"]) {
        return Some(14);
    }
    if t.contains('暖') {
        return Some(14);
    }
    if t.contains('冷') {
        return Some(15);
    }
    if any_near(
        &c,
        &["换", "切", "跳", "掉", "调整", "调"],
        &["色温", "光谱"],
        2,
    ) || any_near(&c, &["色温", "光谱"], &["换", "切", "调"], 2)
    {
        return Some(11);
    }
    None
}

fn rule_motor(t: &str, rw: bool) -> Option<u32> {
    let (up_max, dn_max, up, dn) = if rw {
        (31, 32, 27, 28)
    } else {
        (29, 30, 25, 26)
    };
    if any(t, &["最高", "到顶", "升到顶"]) {
        return Some(up_max);
    }
    if any(t, &["最低", "到底", "降到底"]) {
        return Some(dn_max);
    }
    if t.contains("太高") {
        return Some(dn);
    }
    if any(t, &["太低", "太矮"]) {
        return Some(up);
    }
    if any(
        t,
        &[
            "升",
            "抬",
            "高一点",
            "高点",
            "往上",
            "上去",
            "上来",
            "高一些",
        ],
    ) {
        return Some(up);
    }
    if any(
        t,
        &["降", "低一点", "低点", "往下", "下来", "下去", "低一些"],
    ) {
        return Some(dn);
    }
    None
}

fn rule_dist(t: &str) -> Option<u32> {
    if any(t, &["最远", "最高"]) {
        return Some(35);
    }
    if any(t, &["最近", "最低"]) {
        return Some(36);
    }
    if t.contains("太远") {
        return Some(34);
    }
    if t.contains("太近") {
        return Some(33);
    }
    if t.contains('远') {
        return Some(33);
    }
    if t.contains('近') {
        return Some(34);
    }
    None
}

fn rule_vol(t: &str) -> Option<u32> {
    let c: Vec<char> = t.chars().collect();
    if any_near(&c, &["取消", "解除", "关闭", "关掉", "不要"], &["静音"], 0) {
        return Some(45);
    }
    if t.contains("静音") {
        return Some(44);
    }
    if any(t, &["最大", "百分之百", "最高"]) {
        return Some(42);
    }
    if any(t, &["最小", "最低"]) {
        return Some(43);
    }
    if any_near(
        &c,
        &["关掉", "关了", "关闭", "不要", "没有", "去掉"],
        &["声音", "音量"],
        0,
    ) || any_near(
        &c,
        &["声音", "音量"],
        &["关掉", "关了", "关闭", "关", "去掉"],
        0,
    ) {
        return Some(44);
    }
    if any_near(&c, &["打开", "恢复", "开启"], &["声音", "音量"], 0)
        || any_near(&c, &["声音", "音量"], &["打开", "开启", "恢复"], 0)
    {
        return Some(45);
    }
    let degs = ["太", "好", "很", "有点", "有些"];
    let big: Vec<String> = degs
        .iter()
        .flat_map(|d| ["大", "响", "吵"].iter().map(move |a| format!("{d}{a}")))
        .collect();
    let small: Vec<String> = degs
        .iter()
        .flat_map(|d| ["小", "轻", "低"].iter().map(move |a| format!("{d}{a}")))
        .collect();
    let objs = ["声音", "音量", "声"];
    if objs.iter().any(|o| big.iter().any(|b| near(&c, o, b, 3))) || any(t, &["太大声", "太响"])
    {
        return Some(38);
    }
    if objs.iter().any(|o| small.iter().any(|b| near(&c, o, b, 3))) || t.contains("太小声") {
        return Some(37);
    }
    let up = any(t, &["大", "加", "提高", "调高", "高", "响", "大声"]);
    let dn = any(t, &["小", "减", "降低", "调低", "低", "轻", "小声"]);
    match (up, dn) {
        (true, true) => None,
        (true, false) => Some(37),
        (false, true) => Some(38),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(l: u32) -> &'static str {
        device_intent::command_by_label(l)
            .map(|c| c.action)
            .unwrap_or("?")
    }

    /// E1：389 条词表逐条喂语法（不经精确匹配）——绝不能与表冲突（同动作即算一致）；
    /// 大部分要能自己判出来（原型 370/389；19 条是识别错转别名与裸词，由精确匹配接住）。
    #[test]
    fn e1_alias_table_never_contradicted() {
        let mut hit = 0;
        let mut miss = vec![];
        let mut wrong = vec![];
        for (alias, label) in device_intent::alias_entries() {
            match grammar_match(&alias) {
                Some(h) if h.label == label || action(h.label) == action(label) => hit += 1,
                Some(h) => wrong.push(format!(
                    "{alias}: 应 {label}/{} 得 {}/{}",
                    action(label),
                    h.label,
                    h.action
                )),
                None => miss.push(alias),
            }
        }
        eprintln!(
            "E1 alias replay: hit={hit} miss={} wrong={}",
            miss.len(),
            wrong.len()
        );
        assert!(wrong.is_empty(), "语法与词表冲突: {wrong:?}");
        assert!(hit >= 365, "语法自判命中 {hit} < 365；漏={miss:?}");
        assert!(miss.len() <= 24, "漏太多 {}: {miss:?}", miss.len());
    }

    /// E3：两机 11,156 句真实语料里词表没有、语法认了的 64 句（验证报告 §5）——逐句标签必须不变。
    #[test]
    fn e3_corpus_hits_64_stable() {
        for (t, l) in CORPUS_HITS_64 {
            let h = grammar_match(t).unwrap_or_else(|| {
                panic!("「{t}」应命中 {l}，得 None（{}）", judge(t).unwrap_err())
            });
            assert_eq!(h.label, *l, "「{t}」标签漂移");
        }
    }

    /// E6：历史慢路 12 条提案回放（验证报告 §6）：3 条误触发必须为 None，真意图按表。
    #[test]
    fn e6_llm_replay_12() {
        for (t, expect) in REPLAY_12 {
            let got = grammar_match(t).map(|h| h.label);
            assert_eq!(
                got,
                *expect,
                "「{t}」回放不符（{}）",
                judge(t).err().unwrap_or_default()
            );
        }
        for t in [
            "嗯",
            "比较低够劲",
            "这个呢这本身没啥这个那我们这个产品是是别人代工的",
        ] {
            assert!(grammar_match(t).is_none(), "真误触发「{t}」必须拦住");
        }
    }

    /// E2：13 条慢路测试句 + 真模型用例正例 + 手写口语变体（同动作即算对；「空调暗一点」按闲聊词故意不认）。
    #[test]
    fn e2_natural_positives_35() {
        let mut bad = vec![];
        for (t, l) in POSITIVES_35 {
            let got = device_intent::match_command(t)
                .and_then(|m| match m {
                    device_intent::DeviceMatch::Command(c) => Some(c.semantic_label),
                    _ => None,
                })
                .or_else(|| grammar_match(t).map(|h| h.label));
            let ok = match got {
                Some(g) => g == *l || action(g) == action(*l),
                None => *t == "空调暗一点",
            };
            if !ok {
                bad.push(format!("「{t}」期望 {l} 得 {got:?}"));
            }
        }
        assert!(bad.is_empty(), "{bad:?}");
    }

    /// E4：手写负例（数值/附和/叙述/疑问/假设/第三人称/歧义名词/感受抱怨/否定）一律不认。
    #[test]
    fn e4_negatives_never_fire() {
        let fired: Vec<String> = NEGATIVES
            .iter()
            .filter_map(|t| grammar_match(t).map(|h| format!("「{t}」→{}", h.label)))
            .collect();
        assert!(fired.is_empty(), "负例误开火: {fired:?}");
    }

    /// 守卫演进（验证报告 §7）：v1 曾把这些成人讨论句当命令，v4 必须全拦。
    #[test]
    fn e7_discussion_sentences_blocked() {
        for t in [
            "现在声音比较小了",
            "如果把音量调大一些",
            "对我说小点声就听不到了",
            "到底是冷光还是冷光",
            "你现在是冷光",
            "有冷光",
            "冷光还原度100哦",
            "拉远的同时会放大",
            "近看拉远的这样一种效果",
            "你开着灯",
            "新亮点是",
            "亮度不高的",
            "关了灯",
            "来啦关灯刚打了个盹",
            "因为声音太小",
            "如果再升高一点",
            "所以整体它会暗一点",
            "或者太暗了",
            "降低90啊",
            "你看冷光",
            "这个距离还是挺远的",
            "冷光这样可以去调的",
            "你要是进校园灯光一关",
            "说你离你八月近一点",
            "这个也也能调亮啊",
            "往下走",
            "靠近一点",
        ] {
            assert!(
                grammar_match(t).is_none(),
                "讨论句「{t}」必须拦住，得 {:?}",
                grammar_match(t)
            );
        }
    }

    /// 结构判定的几个关键顺序（09-23 09:16 讲给川哥的例子）。
    #[test]
    fn worked_examples() {
        let h = grammar_match("把灯弄亮一点吧").unwrap();
        assert_eq!(
            (h.label, h.domain, h.peeled.as_str()),
            (4, "LIGHT", "灯弄亮一点")
        );
        assert_eq!(
            grammar_match("灯太刺眼了关掉吧").unwrap().label,
            3,
            "明确动词优先于抱怨词"
        );
        assert_eq!(
            grammar_match("读写台太低了").unwrap().label,
            27,
            "读写台专用标签，不是设备通用 25"
        );
        assert_eq!(
            grammar_match("太暗了看不清").unwrap().label,
            4,
            "看不清与太暗同句按物理量走"
        );
        assert!(
            grammar_match("看不清").is_none(),
            "纯感受抱怨不认（09-23 决定）"
        );
        assert!(grammar_match("太吵了").is_none());
        assert!(grammar_match("听不清").is_none());
        assert!(grammar_match("安静点").is_none());
        assert_eq!(
            grammar_match("可以关灯吗").unwrap().label,
            3,
            "请求语气的吗不算疑问"
        );
        assert!(grammar_match("灯关了吗").is_none(), "状态疑问");
        assert!(grammar_match("我刚才把灯关了").is_none(), "叙述");
        assert!(grammar_match("画面调到5米").is_none(), "数值句按设计不出");
        assert!(grammar_match("冷光").is_none(), "裸预设词交给词表精确匹配");
        assert_eq!(grammar_match("换成冷光").unwrap().label, 23);
        assert_eq!(grammar_match("声音有点太大了").unwrap().label, 38);
        assert_eq!(grammar_match("往暖色调一级").unwrap().label, 12);
        assert_eq!(
            grammar_match("提高一点亮度").unwrap().label,
            4,
            "「一点亮」不是「点亮」"
        );
        assert_eq!(grammar_match("声音开到最大").unwrap().label, 42);
        assert!(
            grammar_match("设备静音").map(|h| h.label) == Some(44),
            "静音优先于设备对象"
        );
        let c = grammar_match("把灯弄亮一点吧").unwrap().command().unwrap();
        assert_eq!(
            (c.semantic_label, c.match_type, c.normalized_text.as_str()),
            (4, "grammar", "灯弄亮一点")
        );
    }

    #[test]
    fn mode_parsing_and_executable_gate() {
        assert_eq!(parse_mode(None), Mode::Observe, "未设=observe");
        assert_eq!(parse_mode(Some("")), Mode::Observe);
        assert_eq!(parse_mode(Some("off")), Mode::Off);
        assert_eq!(parse_mode(Some("0")), Mode::Off);
        assert_eq!(parse_mode(Some("Execute ")), Mode::Execute);
        assert_eq!(parse_mode(Some("banana")), Mode::Observe, "未知值不执行");
        assert_eq!(Mode::Execute.as_str(), "execute");
    }

    include!("device_grammar_testdata.rs");
}
