//! S2-B2 在线设备命令确定性匹配(合同 CC_P003_S2B2_ONLINE_DEVICE_COMMANDS_HANDOFF_20260818)。
//!
//! 生命周期位次:EXIT → STOP_ONLY → **DEVICE_COMMAND** → LLM(pipeline 判停提交处,禁止改序)。
//! 铁律:热词只做 ASR 增强;执行判定只走本模块**确定性匹配**——无子串包含、无向量相似、
//! 无 LLM 猜测。label 46(关闭语音)/label 1(小可小可)按合同排除:不在词表、永不匹配。
//!
//! 词表:内置 assets/device_aliases.tsv(include_str! 编译锁定=合同快照);
//! env P003_DEVICE_COMMAND_ALIASES_PATH 指向同格式 TSV 时运行时覆盖(运营热改,重启生效)。
//! 音量绝对值 20 档(label 60-79)由数值句式处理,数值只认 5,10,…,100;
//! 其他值返回 VolumeOutOfRange(播固定范围提示,零硬件执行,零事件)。

use std::collections::HashMap;
use std::sync::OnceLock;

use tracing::{info, warn};

const BUILTIN_TSV: &str = include_str!("../assets/device_aliases.tsv");

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceCommand {
    pub semantic_label: u32,
    pub action: &'static str,
    pub canonical_phrase: &'static str,
    /// exact_alias | volume_percent
    pub match_type: &'static str,
    pub normalized_text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DeviceMatch {
    Command(DeviceCommand),
    /// 数值句式命中但数值不在 5..=100 步进 5 的档位集(合同 §6.6:不得四舍五入)
    VolumeOutOfRange,
}

/// 范围外音量的固定提示(合同原文)。
pub const VOLUME_RANGE_HINT: &str = "目前只能按百分之五一档调节";

struct AliasTable {
    /// 归一化 alias → (label, action, canonical)。action/canonical 泄漏到 'static:
    /// 表进程级一次构建终身有效,leak 换 &'static str 让 DeviceCommand 零克隆开销。
    map: HashMap<String, (u32, &'static str, &'static str)>,
}

static TABLE: OnceLock<AliasTable> = OnceLock::new();

fn table() -> &'static AliasTable {
    TABLE.get_or_init(|| {
        let (src, origin): (String, &str) = match std::env::var("P003_DEVICE_COMMAND_ALIASES_PATH") {
            Ok(p) if !p.trim().is_empty() => match std::fs::read_to_string(p.trim()) {
                Ok(s) => (s, "env-file"),
                Err(e) => {
                    warn!(error = %e, "P003_DEVICE_COMMAND_ALIASES_PATH 读取失败,回退内置词表");
                    (BUILTIN_TSV.to_string(), "builtin")
                }
            },
            _ => (BUILTIN_TSV.to_string(), "builtin"),
        };
        let t = parse_tsv(&src);
        info!(entries = t.map.len(), origin, "device alias 词表已加载");
        t
    })
}

fn parse_tsv(src: &str) -> AliasTable {
    let mut map = HashMap::new();
    for line in src.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 3 {
            warn!(line, "device alias TSV 行列数不足,跳过");
            continue;
        }
        let Ok(label) = cols[0].trim().parse::<u32>() else {
            warn!(line, "device alias TSV label 非数字,跳过");
            continue;
        };
        // 合同排除项在数据层再拦一道(词表被 env 覆盖时的防线)
        if label == 46 || label == 1 {
            warn!(label, "合同排除标签出现在词表,已拒绝加载该行");
            continue;
        }
        let action: &'static str = Box::leak(cols[1].trim().to_string().into_boxed_str());
        let canonical: &'static str = Box::leak(cols[2].trim().to_string().into_boxed_str());
        let mut phrases: Vec<&str> = vec![canonical];
        if cols.len() >= 4 {
            phrases.extend(cols[3].split(',').map(str::trim).filter(|s| !s.is_empty()));
        }
        for p in phrases {
            let key = normalize(p);
            if key.is_empty() {
                continue;
            }
            if let Some(prev) = map.insert(key.clone(), (label, action, canonical))
                && prev.0 != label
            {
                warn!(alias = p, prev_label = prev.0, label, "alias 跨标签重复,后者覆盖");
            }
        }
    }
    AliasTable { map }
}

// ── 确定性标准化(合同 §4.2,仅此五步,顺序固定) ──

const PUNCT: &[char] = &[
    '，', '。', '？', '！', '、', '；', '：', ',', '.', '?', '!', ';', ':', ' ', '\u{3000}',
];

/// 中文数字档位(仅合同 20 档+「百」,长词优先排列——五十五必须先于五十匹配)。
const CN_PERCENT: &[(&str, &str)] = &[
    ("百分之一百", "100"),
    ("百分之九十五", "95"),
    ("百分之八十五", "85"),
    ("百分之七十五", "75"),
    ("百分之六十五", "65"),
    ("百分之五十五", "55"),
    ("百分之四十五", "45"),
    ("百分之三十五", "35"),
    ("百分之二十五", "25"),
    ("百分之十五", "15"),
    ("百分之九十", "90"),
    ("百分之八十", "80"),
    ("百分之七十", "70"),
    ("百分之六十", "60"),
    ("百分之五十", "50"),
    ("百分之四十", "40"),
    ("百分之三十", "30"),
    ("百分之二十", "20"),
    ("百分之十", "10"),
    ("百分之五", "5"),
    ("百分之百", "100"),
];

pub fn normalize(text: &str) -> String {
    // 1. 去首尾空白+全部常见标点/空格
    let mut s: String = text.trim().chars().filter(|c| !PUNCT.contains(c)).collect();
    // 2. 全角数字/百分号 → 半角
    s = s
        .chars()
        .map(|c| match c {
            '０'..='９' => char::from_u32(c as u32 - '０' as u32 + '0' as u32).unwrap_or(c),
            '％' => '%',
            _ => c,
        })
        .collect();
    // 3. 百分之<中文数字> → 数字(长词优先)
    for (cn, digit) in CN_PERCENT {
        if s.contains(cn) {
            s = s.replace(cn, digit);
        }
    }
    // 4. 数字% → 数字
    s = s.replace('%', "");
    s
}

/// 礼貌前后缀(合同 §4.2;长前缀优先——「可以帮我」必须先于「帮我」)。
/// 「把」为 2026-08-18 晚修订新增(服务「请把光谱调暖一点」类句式;
/// 剥后仍须完整命中,故无子串误执行风险——「把手拿开」剥后照样 None)。
/// 语气词前缀为 2026-08-19 Phase 1a 新增(实测受害样本:「好关灯」「嗯退出」「那退出」
/// 「嗯调成暖光」——journal 归因)。安全性同「把」:剥后仍须完整命中,「好的呀」剥「好」
/// 后「的呀」不中=无害;单字放尾部維持长前缀优先序。
/// D1 W1b(2026-09-22,方案 v1.1):句首「哦/啊/呃/就」与句尾「啊/呀/哈/呢/哦/了」入表——D0 实录「哦最暗」
/// 「绘画模式啊」整句不中落了慢路。纪律不变:每轮至多剥一前一后、至多 4 轮、**剥后仍须完整命中**;
/// 「哦」「啊」剥尽为空串不剥(strip 后 rest 非空才算),「亮了」「好了」剥后不是别名照样 None。
const POLITE_PREFIX: &[&str] =
    &["可以帮我", "麻烦", "帮我", "小可", "请", "把", "好", "那", "嗯", "哎", "哦", "啊", "呃", "就"];
const POLITE_SUFFIX: &[&str] = &["可以吗", "好吗", "一下", "吧", "啊", "呀", "哈", "呢", "哦", "了"];

/// 音量数值句式(合同 §6.6 六句式,归一后收敛为五模板)。
fn match_volume_percent(s: &str) -> Option<u32> {
    for prefix in ["把音量调到", "音量调到", "把声音设置为", "声音开到", "音量"] {
        if let Some(rest) = s.strip_prefix(prefix)
            && !rest.is_empty()
            && rest.chars().all(|c| c.is_ascii_digit())
        {
            return rest.parse::<u32>().ok();
        }
    }
    None
}

fn lookup(s: &str) -> Option<DeviceMatch> {
    // alias 精确命中优先(显式合同条目;如「音量百分之百」归一后=「音量100」入表 label 42)
    if let Some((label, action, canonical)) = table().map.get(s) {
        return Some(DeviceMatch::Command(DeviceCommand {
            semantic_label: *label,
            action,
            canonical_phrase: canonical,
            match_type: "exact_alias",
            normalized_text: s.to_string(),
        }));
    }
    if let Some(n) = match_volume_percent(s) {
        if (5..=100).contains(&n) && n % 5 == 0 {
            // label 60=5% … 79=100%(合同 §6.6 映射)
            let label = 60 + (n - 5) / 5;
            let action: &'static str =
                Box::leak(format!("volume_{n}").into_boxed_str());
            return Some(DeviceMatch::Command(DeviceCommand {
                semantic_label: label,
                action,
                canonical_phrase: "音量绝对值",
                match_type: "volume_percent",
                normalized_text: s.to_string(),
            }));
        }
        return Some(DeviceMatch::VolumeOutOfRange);
    }
    None
}

/// 主入口:ASR final 文本 → 设备命令判定。
/// None = 非设备命令(落回闲聊/LLM)。整句匹配不中时循环剥离礼貌前后缀
/// (每轮至多剥一前一后,至多 4 轮),**剥离后仍须完整命中**——子串永不执行。
/// label 是否在词表合法集内(Phase 2a 观察打点用:LLM 幻觉 label 一眼可辨;
/// 2b 放开执行时同一函数当白名单闸)。
/// B 案退出意图专用 label(2026-08-28):不在设备命令表(known_label 恒 false),
/// 与 server 侧 device-brain-prompt.ts 协议「退出/结束对话=90」一致。
/// 90 避开设备段(2-45)与音量绝对值段(60-79)。观察期只记日志;执行期(需 codex
/// 端侧信令合同)由 worker 通知 Android 走既有退出流程,worker 永不自行关房。
pub const SESSION_EXIT_LABEL: u32 = 90;

/// 2b 合同 v2 首批(2026-09-05 起 003 灰度只放 9 个:4/6/12/13/22/23/24/37/38——亮暗一级/暖冷一级/三光模式/
/// 音量 ±5;画面远近/开关灯/最值/静音/高度当时留第二批)。
/// **D1(2026-09-22,方案 v1.1 §W2b 川哥拍板):批次扩到词表全部标签**(灯光 2–24 + 电机/虚像 25–36 + 音量 37/38/42–45),
/// 闸=目录内即放行;`not_in_batch` 原因不再产生,纠正句改挂 `unknown_label`。60–79 音量绝对值段与 1/46/90 不在词表,
/// 慢路照旧不执行。回退=换回旧二进制(批次无 env 开关;全停 L2 用 P003_DEVICE_INTENT_EXECUTE=0)。
pub fn l2_batch_allows(label: u32) -> bool {
    known_label(label)
}

/// 合同 v3.1 §1.2:电机域标签(25–36,升降/虚像远近)。`light_volume` 之外,芯片只提供候选,
/// worker 须等同轮 ASR 独立命中才提案;端侧同时不启 1000 ms fallback。
pub fn motor_label(label: u32) -> bool {
    (25..=36).contains(&label)
}

/// 芯片候选决策(纯函数,合同 v3.1 §1.2/§1.4 + codex 阶段 B §2.2 边界):
/// - 不在目录 → NotInCatalog;
/// - 端侧合同 <3(含旧包缺字段、带未知值)→ **既有兼容策略**(目录内即提案),reason 标明原因;
/// - 合同 ≥3:claimed=端侧已认领,不提案;ignored=不提案;deferred 且电机=等 ASR;其余 deferred=旧策略;
///   **所有权缺失/未知/非法 → OwnershipUnknown,fail-closed 不提案**(codex R2:旧策略也是物理执行提案,不能退回)。
///
/// 新电机等待策略**只对合同 ≥3 的端生效**——旧 APK 仍有 1 s fallback,worker 单独等 ASR 会造成「先兜底动一次再提案」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChipDecision {
    Propose,
    Claimed,
    DeferredWaitAsr,
    Ignored,
    /// 已声明合同 3 却缺失/非法所有权:fail-closed,不进任何执行路径(codex R2)
    OwnershipUnknown,
    NotInCatalog,
}

pub fn chip_decision(
    contract_version: u32,
    local_action: Option<&str>,
    label: u32,
    in_catalog: bool,
) -> (ChipDecision, &'static str) {
    if !in_catalog {
        return (ChipDecision::NotInCatalog, "label_not_in_catalog");
    }
    let known = matches!(local_action, None | Some("claimed") | Some("deferred") | Some("ignored"));
    if contract_version < 3 {
        // 合同 2 / 旧包:保持既有兼容(目录内即提案);带了新字段甚至未知值也只记诊断,不改老端行为
        let reason = if !known {
            "local_action_unknown_contract_v2"
        } else if local_action.is_some() {
            "contract_below_3"
        } else {
            "contract_v2"
        };
        return (ChipDecision::Propose, reason);
    }
    // 已声明合同 3:所有权缺失 / 非法 → fail-closed(codex R2:「旧策略」也是物理执行提案,不能退回)
    if !known {
        return (ChipDecision::OwnershipUnknown, "local_action_unknown");
    }
    match local_action {
        Some("claimed") => (ChipDecision::Claimed, "android_owned"),
        Some("ignored") => (ChipDecision::Ignored, "android_ignored"),
        Some("deferred") if motor_label(label) => (ChipDecision::DeferredWaitAsr, "motor_outside_chip_first"),
        Some("deferred") => (ChipDecision::Propose, "deferred_light_volume"),
        _ => (ChipDecision::OwnershipUnknown, "ownership_missing"),
    }
}

/// 参数归一化(合同 v3.1 §1.1 / codex §2.1):去重键的参数分量。缺省 count 与 count=1 同;
/// 无参数=空串(合同 2 恒空串)。**只在类型/范围校验之后调用**,不把字符串/小数转成合法整数。
/// 阶段 D(params 进 proposal)前无生产调用方,先以单测锁死语义。
#[allow(dead_code)]
pub fn normalize_params(count: Option<u32>, value: Option<u32>, target_deci_units: Option<u32>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(c) = count
        && c > 1
    {
        parts.push(format!("c{c}"));
    }
    if let Some(v) = value {
        parts.push(format!("v{v}"));
    }
    if let Some(t) = target_deci_units {
        parts.push(format!("t{t}"));
    }
    parts.join(",")
}

/// LLM 慢路执行门序(纯函数,单测载体)。Err=suppress 原因(日志 reason 枚举);顺序即优先级:
/// execute_off → android_capability_missing → unknown_label → fast_path_hit → no_trace。
/// (D1 起批次=词表全集,`not_in_batch` 不再产生;表外标签一律 unknown_label。)
pub fn l2_gate(
    execute_on: bool,
    capable: bool,
    label: u32,
    fast_path_pending: bool,
    has_trace: bool,
    device_text: bool,
) -> Result<(), &'static str> {
    if !execute_on {
        return Err("execute_off");
    }
    // D2 B5(2026-09-23):原话里一个设备词都没有 → 大模型写了暗号也当没写(历史 3 次误触发全属此类)
    if !device_text {
        return Err("no_device_text");
    }
    if !capable {
        return Err("android_capability_missing");
    }
    if !l2_batch_allows(label) {
        return Err("unknown_label");
    }
    if fast_path_pending {
        return Err("fast_path_hit");
    }
    if !has_trace {
        return Err("no_trace");
    }
    Ok(())
}

/// 2026-09-04(川哥拍板):慢路标记被 `not_in_batch` 压制时追加的固定纠正句——LLM 回复常自称「已经调好」
/// 而这条标签其实没执行(003 实证「画面调到5米」→ LLM 说「画面离远些啦」但什么都没发生)。
/// **只纠正、不教词表原句**:TTS 念出词表句会被 Android KWS / 本机 ASR 当成新命令(8-27 命令词禁入门同理),
/// 句子不得含任何别名(单测拿整张别名表对撞)。
pub const L2_FALLBACK_HINT: &str = "这个我暂时还不能这样调，你换个更直接的说法再试试";

/// 纠正句门(纯函数)。D1 起(方案 v1.1 §W2b):只在 `unknown_label`(LLM 给了词表外标签——46/60–79/幻觉值,回复常已自称
/// 「调好了」)+ 快路没在途(否则快路正在做同一件事)+ 有 trace(设备房) 时给。多标记轮首个已派发、其余静默(multi_label);
/// 拿不准(无标记)无事可纠;execute_off / 能力缺失 / fast_path_hit / no_trace 一律不提示。
/// 调用方已在 `l2_execute_on` 门后(EXECUTE 名单内设备;D0 起名单空=设备房全开)。
pub fn l2_fallback_hint(reason: &str, label: u32, fast_path_pending: bool, has_trace: bool) -> Option<&'static str> {
    if reason != "unknown_label" || fast_path_pending || !has_trace || known_label(label) {
        return None;
    }
    Some(L2_FALLBACK_HINT)
}

pub fn known_label(label: u32) -> bool {
    table().map.values().any(|(l, _, _)| *l == label)
}

pub fn match_command(text: &str) -> Option<DeviceMatch> {
    let mut s = normalize(text);
    if s.is_empty() {
        return None;
    }
    for _ in 0..4 {
        if let Some(m) = lookup(&s) {
            return Some(m);
        }
        let mut peeled = false;
        for p in POLITE_PREFIX {
            if let Some(rest) = s.strip_prefix(p)
                && !rest.is_empty()
            {
                s = rest.to_string();
                peeled = true;
                break;
            }
        }
        for suf in POLITE_SUFFIX {
            if let Some(rest) = s.strip_suffix(suf)
                && !rest.is_empty()
            {
                s = rest.to_string();
                peeled = true;
                break;
            }
        }
        if !peeled {
            return None;
        }
    }
    lookup(&s)
}

/// D2 B5(2026-09-23,川哥拍板):慢路「无设备词不认暗号」——判据复用承接音选桶的 `filler::is_device_text`
/// (强提示词 ∪ 对象词∧调节词),门专用只加 刺眼/晃眼(方向不歧义的灯光抱怨);明确不收 吵/听不清/安静/响/看不清
/// (09-23 决定:感受类抱怨不进设备命令,走别的处理)。
const L2_GATE_EXTRA_HINTS: &[&str] = &["刺眼", "晃眼"];
pub fn l2_device_text(text: &str) -> bool {
    crate::filler::is_device_text(text) || L2_GATE_EXTRA_HINTS.iter().any(|h| text.contains(h))
}

/// env `L2_REQUIRE_DEVICE_TEXT`(默认开;=0 关=回退到 D1 行为,无需换装)。
pub fn l2_require_device_text() -> bool {
    std::env::var("L2_REQUIRE_DEVICE_TEXT").map(|v| v.trim() != "0").unwrap_or(true)
}

/// 语法层用:与 `match_command` 同构地剥礼貌/语气词(每轮先查表,命中即停——停点与精确匹配一致),返回最终串。
pub fn peel_polite(text: &str) -> String {
    let mut s = normalize(text);
    if s.is_empty() {
        return s;
    }
    for _ in 0..4 {
        if lookup(&s).is_some() {
            return s;
        }
        let mut peeled = false;
        for p in POLITE_PREFIX {
            if let Some(rest) = s.strip_prefix(p)
                && !rest.is_empty()
            {
                s = rest.to_string();
                peeled = true;
                break;
            }
        }
        for suf in POLITE_SUFFIX {
            if let Some(rest) = s.strip_suffix(suf)
                && !rest.is_empty()
            {
                s = rest.to_string();
                peeled = true;
                break;
            }
        }
        if !peeled {
            return s;
        }
    }
    s
}

/// 测试用:词表全部(归一化别名, label)。
#[cfg(test)]
pub(crate) fn alias_entries() -> Vec<(String, u32)> {
    table().map.iter().map(|(k, (l, _, _))| (k.clone(), *l)).collect()
}

/// label 反查目录(command_word 链路,PRE_INPUT_READY_COMMAND_WORD_HANDOFF §4.2):
/// VAD 芯片命中的 semantic label → 与 ASR 命中同构的 DeviceCommand。
/// 允许目录 = 本 Matcher 词表 label 全集 + 音量档 60-79;label 1/46 永拒
/// (词表数据层本就拒载,这里显式再拦=芯片侧异常 label 的防线)。
pub fn command_by_label(label: u32) -> Option<DeviceCommand> {
    if label == 1 || label == 46 {
        return None;
    }
    if (60..=79).contains(&label) {
        let n = 5 + (label - 60) * 5;
        let action: &'static str = Box::leak(format!("volume_{n}").into_boxed_str());
        return Some(DeviceCommand {
            semantic_label: label,
            action,
            canonical_phrase: "音量绝对值",
            match_type: "command_word",
            normalized_text: format!("vad_label_{label}"),
        });
    }
    // 词表反查:同 label 多行取 canonical 首见(表内 label 唯一,见 TSV)
    let t = table();
    for (label_t, action, canonical) in t.map.values() {
        if *label_t == label {
            return Some(DeviceCommand {
                semantic_label: label,
                action,
                canonical_phrase: canonical,
                match_type: "command_word",
                normalized_text: format!("vad_label_{label}"),
            });
        }
    }
    None
}

/// label 的全部别名短语(归一化后;含 env 覆盖词表)。芯片候选回声嫌疑诊断用(2026-09-06 v230 灯控实证):
/// 刚播出的文本若包含该 label 的任一别名 → 极可能是喇叭念出命令词被芯片(无 AEC 参考的麦路径)听回。
pub fn phrases_for_label(label: u32) -> Vec<&'static str> {
    table().map.iter().filter(|(_, (l, _, _))| *l == label).map(|(k, _)| k.as_str()).collect()
}

/// 播出文本(已 normalize)是否包含 label 的任一别名短语。只作诊断字段,不改变裁决。
pub fn spoken_contains_label_phrase(spoken_norm: &str, label: u32) -> bool {
    if spoken_norm.is_empty() {
        return false;
    }
    phrases_for_label(label).iter().any(|p| !p.is_empty() && spoken_norm.contains(p))
}

/// ASR boost 追加词(env P003_DEVICE_ASR_HOTWORDS,逗号分隔;stt_volc 合并进火山热词表)。
/// 只提高识别概率,与执行判定完全无关(合同铁律 4)。
pub fn device_asr_hotwords() -> Vec<String> {
    std::env::var("P003_DEVICE_ASR_HOTWORDS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

/// 命令开关+per-SN canary(合同 §11 建议开关)。
/// P003_DEVICE_COMMANDS_ENABLED=1 且 (canary 列表为空=全开;否则 SN 命中才开)。
/// canary 条目兼容两种形态:64 位 hex=sha256(SN) 小写;否则视为 SN 明文。
pub fn commands_enabled_for(room_name: &str) -> bool {
    commands_gate(
        std::env::var("P003_DEVICE_COMMANDS_ENABLED").unwrap_or_default() == "1",
        &std::env::var("P003_DEVICE_COMMANDS_CANARY_SN_HASHES").unwrap_or_default(),
        room_name,
    )
}

/// 退出信令灰度门(v140 合同 CODEX_..._SESSION_EXIT_V140 §8.3:先仅 0010):
/// SESSION_EXIT_SIGNAL_ENABLED=1 且 SN 命中 SESSION_EXIT_SIGNAL_CANARY_SN(空=设备房全开)。
/// fail-closed:env 未配=不发信令(吞句行为不受影响,只是不通知 Android)。
pub fn exit_signal_enabled_for(room_name: &str) -> bool {
    commands_gate(
        std::env::var("SESSION_EXIT_SIGNAL_ENABLED").unwrap_or_default() == "1",
        &std::env::var("SESSION_EXIT_SIGNAL_CANARY_SN").unwrap_or_default(),
        room_name,
    )
}

/// LLM 慢路执行灰度门(2b 合同 v2):P003_DEVICE_INTENT_EXECUTE=1 且 SN 命中
/// P003_DEVICE_INTENT_EXECUTE_CANARY_SN_HASHES(空=设备房全开;首轮只填 003 hash)。
/// **独立于 P003_DEVICE_COMMANDS_CANARY_SN_HASHES**——复用会把 L1 快路也收窄到 003。
/// fail-closed:env 未配=不执行(2a 观察打点照常)。
pub fn l2_execute_enabled_for(room_name: &str) -> bool {
    commands_gate(
        std::env::var("P003_DEVICE_INTENT_EXECUTE").unwrap_or_default() == "1",
        &std::env::var("P003_DEVICE_INTENT_EXECUTE_CANARY_SN_HASHES").unwrap_or_default(),
        room_name,
    )
}

/// ASR 二遍识别(nonstream)灰度门:与设备命令 canary 同语义(sn- 房 + SN 列表),
/// 独立 env 键独立灰度。命中后 pipeline 将该 job 的 ASR 切 bigmodel_async + 二遍
/// (老 bigmodel 端点静默忽略 enable_nonstream,两者必须同调,详见 stt_volc::SttConfig)。
/// 回滚 = env 关 VOLC_ASR_NONSTREAM_ENABLED + 纪律重启,零二进制回滚。
pub fn asr_nonstream_enabled_for(room_name: &str) -> bool {
    commands_gate(
        std::env::var("VOLC_ASR_NONSTREAM_ENABLED").unwrap_or_default() == "1",
        &std::env::var("VOLC_ASR_NONSTREAM_CANARY_SN").unwrap_or_default(),
        room_name,
    )
}

/// 设备承接音桶灰度门(D1 W3a,方案 v1.1「先川哥两台听感再全量」):FILLER_DEVICE_BUCKET≠0(默认开)且 SN 命中
/// FILLER_DEVICE_CANARY_SN_HASHES(空=设备房全开);非 sn- 房永不落 device 桶。只影响承接音选桶,不碰命令判定。
pub fn device_filler_enabled_for(room_name: &str) -> bool {
    commands_gate(
        std::env::var("FILLER_DEVICE_BUCKET").map(|v| v != "0").unwrap_or(true),
        &std::env::var("FILLER_DEVICE_CANARY_SN_HASHES").unwrap_or_default(),
        room_name,
    )
}

/// 纯函数门(单测载体;env 读取在上面的薄壳里)。
fn commands_gate(enabled: bool, canary_csv: &str, room_name: &str) -> bool {
    if !enabled {
        return false;
    }
    // 非设备房(web 调试等)无条件不开命令——「不影响其他 Worker 房间」在形态层保证,
    // 先于 canary 列表判定(空列表=设备房全开,但永远不含非 sn- 房)
    let Some(sn) = room_name
        .strip_prefix("sn-")
        .and_then(|r| r.rsplit_once('-'))
        .map(|(sn, _)| sn)
    else {
        return false;
    };
    let list: Vec<String> = canary_csv
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if list.is_empty() {
        return true;
    }
    let sn_lower = sn.to_lowercase();
    let sn_hash = sha256_hex(sn.as_bytes());
    list.iter().any(|e| *e == sn_lower || *e == sn_hash)
}

/// 开场重叠窗放宽门的 SN 例外(2026-09-06 codex v237 §7.3):端侧 v237 起「提示音完整播完才开麦」,就绪后
/// 立刻说的真人首句(「讲个故事」vs「你来了故事继续」LCS 0.5)会落进估算窗被误吞。已核实装 v237 的 SN 列在
/// LOCAL_AUDIO_OVERLAP_SKIP_SN_HASHES(逗号分隔 sha256(SN) hex 或小写 SN)即跳过放宽分支;精确回声门(LCS≥0.8)、
/// 命令/急停/退出保护不变。**空表=不跳过任何设备**(与 canary 的「空=全开」相反,这是例外表)。
/// 设备回滚到旧 APK 时必须同步把它从表里拿掉。
pub fn overlap_gate_skipped_for(room_name: &str) -> bool {
    sn_listed(&std::env::var("LOCAL_AUDIO_OVERLAP_SKIP_SN_HASHES").unwrap_or_default(), room_name)
}

/// 纯函数:设备房 `sn-<SN>-<ts>` 的 SN 是否在列表(小写 SN 或 sha256(SN) hex);非设备房/空表 → false。
pub fn sn_listed(csv: &str, room_name: &str) -> bool {
    let Some(sn) = room_name
        .strip_prefix("sn-")
        .and_then(|r| r.rsplit_once('-'))
        .map(|(sn, _)| sn)
    else {
        return false;
    };
    let list: Vec<String> = csv.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
    if list.is_empty() {
        return false;
    }
    let sn_lower = sn.to_lowercase();
    let sn_hash = sha256_hex(sn.as_bytes());
    list.iter().any(|e| *e == sn_lower || *e == sn_hash)
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(text: &str) -> DeviceCommand {
        match match_command(text) {
            Some(DeviceMatch::Command(c)) => c,
            other => panic!("「{text}」应命中命令,实际 {other:?}"),
        }
    }
    fn none(text: &str) {
        assert!(match_command(text).is_none(), "「{text}」不得匹配任何设备命令");
    }

    /// 合同 §10.1.1:63 条协议原始控制短句逐条(41 canonical + 4/6 的第二原句 + 20 档音量)。
    #[test]
    fn all_63_protocol_phrases_map_correctly() {
        let fixed: &[(&str, u32, &str)] = &[
            ("打开灯光", 2, "led_on"),
            ("关闭灯光", 3, "led_off"),
            ("调亮一级", 4, "brightness_up"),
            ("灯光调亮", 4, "brightness_up"),
            ("调到最亮", 5, "brightness_max"),
            ("调暗一级", 6, "brightness_down"),
            ("灯光调暗", 6, "brightness_down"),
            ("调到最暗", 7, "brightness_min"),
            ("亮度调到一档", 8, "brightness_min"),
            ("亮度调到二档", 9, "brightness_middle"),
            ("亮度调到三档", 10, "brightness_max"),
            ("调整灯光色温", 11, "color_temperature_cycle_down"),
            ("调暖一级", 12, "color_temperature_warmer"),
            ("调冷一级", 13, "color_temperature_cooler"),
            ("灯光调暖一点", 14, "color_temperature_warmer"),
            ("灯光调冷一点", 15, "color_temperature_cooler"),
            ("最冷色温", 16, "color_temperature_cold"),
            ("最暖色温", 17, "color_temperature_warm"),
            ("常规色温", 18, "color_temperature_normal"),
            ("调到绘画模式", 19, "color_temperature_cold"),
            ("调到常规模式", 20, "color_temperature_normal"),
            ("调到夜读模式", 21, "color_temperature_warm"),
            ("调到暖光", 22, "color_temperature_warm"),
            ("调到冷光", 23, "color_temperature_cold"),
            ("调到中性光", 24, "color_temperature_normal"),
            ("设备调高一点", 25, "motor_up_step"),
            ("设备调低一点", 26, "motor_down_step"),
            ("读写台高一点", 27, "motor_up_step"),
            ("读写台低一点", 28, "motor_down_step"),
            ("设备调到最高", 29, "motor_max"),
            ("设备调到最低", 30, "motor_min"),
            ("读写台调到最高", 31, "motor_max"),
            ("读写台调到最低", 32, "motor_min"),
            ("虚像远一点", 33, "virtual_image_farther_step"),
            ("虚像近一点", 34, "virtual_image_nearer_step"),
            ("虚像调到最远", 35, "virtual_image_farthest"),
            ("虚像调到最近", 36, "virtual_image_nearest"),
            ("请大声点", 37, "volume_up_5"),
            ("请小声点", 38, "volume_down_5_min_5"),
            ("音量调到最大", 42, "volume_100"),
            ("音量调到最低", 43, "volume_5"),
            ("设备静音", 44, "mute_media_and_voice"),
            ("打开音量", 45, "unmute_media_and_voice"),
        ];
        for (text, label, action) in fixed {
            let c = cmd(text);
            assert_eq!(c.semantic_label, *label, "「{text}」label 错");
            assert_eq!(c.action, *action, "「{text}」action 错");
        }
        assert_eq!(fixed.len(), 43); // 41 canonical + 2 个第二原句
        // 20 档音量绝对值(label 60-79)
        for i in 0..20u32 {
            let n = 5 + i * 5;
            let c = cmd(&format!("音量调到百分之{}", cn_of(n)));
            assert_eq!(c.semantic_label, 60 + i, "音量 {n}% label 错");
            assert_eq!(c.action, format!("volume_{n}"), "音量 {n}% action 错");
            assert_eq!(c.match_type, "volume_percent");
        }
        // 43 + 20 = 63 条协议短句全覆盖
    }

    fn cn_of(n: u32) -> &'static str {
        match n {
            5 => "五", 10 => "十", 15 => "十五", 20 => "二十", 25 => "二十五",
            30 => "三十", 35 => "三十五", 40 => "四十", 45 => "四十五", 50 => "五十",
            55 => "五十五", 60 => "六十", 65 => "六十五", 70 => "七十", 75 => "七十五",
            80 => "八十", 85 => "八十五", 90 => "九十", 95 => "九十五", 100 => "一百",
            _ => unreachable!(),
        }
    }

    /// 合同 §10.1.2:每个动作组至少 3 条日常 alias。
    #[test]
    fn daily_aliases_hit() {
        for (text, label) in [
            ("开灯", 2), ("把灯打开", 2), ("帮我开灯", 2),
            ("关灯", 3), ("把灯关掉", 3), ("不用灯了", 3),
            ("亮一点", 4), ("再亮一点", 4), ("提高一点亮度", 4),
            ("暗一点", 6), ("灯暗一点", 6), ("降低一点亮度", 6),
            ("换个色温", 11), ("暖一点", 14), ("冷一点", 15),
            ("绘画模式", 19), ("我要画画", 19), ("夜读模式", 21), ("我要夜读", 21),
            ("设备升一点", 25), ("读写台升高一点", 27), ("设备升到最高", 29),
            ("画面远一点", 33), ("显示近一点", 34), ("虚像最远", 35),
            ("声音大一点", 37), ("音量减一点", 38),
            ("最大音量", 42), ("音量百分之百", 42), ("静音", 44), ("取消静音", 45),
        ] {
            assert_eq!(cmd(text).semantic_label, label, "「{text}」");
        }
    }

    /// 合同 §10.1.3/6:数值句式六式 + 半角百分号。
    #[test]
    fn volume_percent_phrases() {
        for text in [
            "音量百分之五十", "音量调到百分之五十", "把音量调到百分之五十",
            "音量调到50%", "把声音设置为50%", "声音开到50%", "音量调到５０％",
        ] {
            let c = cmd(text);
            assert_eq!(c.semantic_label, 69, "「{text}」应映射 50%→label 69");
            assert_eq!(c.action, "volume_50");
        }
    }

    /// 合同 §10.1.4:礼貌前后缀标准化。
    #[test]
    fn polite_affix_stripping() {
        let c = cmd("小可，帮我把灯打开一下好吗");
        assert_eq!(c.semantic_label, 2);
        assert_eq!(cmd("麻烦把音量调到百分之三十").semantic_label, 65);
        // 注:「吗」单字不在合同后缀列表(可以吗/好吗/一下/吧),「关灯吗」按合同不剥不中
        assert_eq!(cmd("可以帮我关灯好吗").semantic_label, 3);
        assert_eq!(cmd("请把声音关掉").semantic_label, 44);
    }

    /// 合同 §10.2:负例矩阵——问句/假设句/感受句/裸方向词零命中。
    #[test]
    fn negative_matrix_never_matches() {
        none("关闭语音"); // 排除项 label 46
        none("灯光为什么不亮");
        none("怎么把灯调亮");
        none("如果我说关闭灯光会怎样");
        none("设备是不是太高了");
        none("我觉得声音好像有点小");
        none("退出后告诉我怎么重新进入");
        none("退出后告诉我怎么开灯");
        // 裸方向词:高/低 仍禁(与亮度/音量/设备高度三方歧义,合同 §6.3);
        // 远/近 已由 2026-08-18 晚合同修订启用(§6.4 禁令被覆盖:远近唯一归属虚像)——
        // 见下方 revised_bare_direction_words 正例测试
        none("高一点");
        none("低一点");
        none("再高点");
        // 语气词/短声
        none("嗯");
        none("啊");
        none("我喜欢画画");
        none("晚上可以读书吗");
    }

    /// 合同修订(2026-08-18 晚 §4.5):光谱系 + 裸远近方向词。
    /// 「远一点/近一点」原为 §6.4 负例,真机口语实证后反转为正例(修订留痕)。
    #[test]
    fn revised_spectrum_and_bare_direction_words() {
        for (text, label) in [
            ("调光谱", 11), ("调整光谱", 11), ("切一下光谱", 11), ("换个光谱", 11),
            ("光谱暖一点", 14), ("调暖一点", 14),
            ("光谱冷一点", 15), ("调冷一点", 15),
            ("调远", 33), ("调远一点", 33), ("远一点", 33),
            ("调近", 34), ("调近一点", 34), ("近一点", 34),
            ("帮我调远一点", 33), ("请把光谱调暖一点", 14), // 礼貌剥离仍适用
            // Phase 1a 语气词前缀(2026-08-19):剥后完整命中才执行
            ("好开灯", 2), ("嗯打开灯光", 2), ("那关灯", 3), ("哎开灯", 2),
        ] {
            assert_eq!(cmd(text).semantic_label, label, "「{text}」");
        }
        // 语气词前缀负例:剥后非完整命令不执行(子串永不执行纪律)
        assert!(matches!(match_command("好的呀"), None), "「好的呀」剥「好」后不得命中");
        assert!(matches!(match_command("嗯嗯"), None), "「嗯嗯」剥尽后空串不得命中");
        // 修订附带负例(§4.5 匹配纪律 2/4):问句与带尾巴的句子零执行
        none("光谱为什么不一样");
        none("为什么看起来很远");
        none("调远之后告诉我为什么");
    }

    /// D1 W1b(2026-09-22):语气词前后缀剥离。正例=D0 真机实录(「哦最暗」「绘画模式啊」走了慢路)+方案 §W1b 三句;
    /// 负例=剥尽为空/剥后非别名/陈述句,子串永不执行纪律不变。
    #[test]
    fn particle_affix_stripping_d1() {
        for (text, label) in [
            ("哦最暗", 7), ("绘画模式啊", 19), ("调到最亮吧", 5),
            ("啊亮一点", 4), ("就调亮一点", 4), ("呃关灯", 3), ("关灯了", 3), ("暗一点哈", 6), ("开灯呢", 2),
            ("哦哦调到最暗呀", 7), // 两轮剥离(每轮一前一后)
            ("哦，最暗。", 7),      // 标点先归一再剥
        ] {
            assert_eq!(cmd(text).semantic_label, label, "「{text}」");
        }
        for text in ["哦", "啊", "哦哦", "了", "好了", "亮了", "灯亮了", "我关灯了", "太暗了看不清", "就这样吧", "哦是吗", "啊啊啊啊啊啊"] {
            assert!(match_command(text).is_none(), "「{text}」不得命中");
        }
    }

    /// ASR 误转别名(2026-08-18 深夜):seedasr 双向流式端点热词预算 100 tokens 且
    /// boost 随词数稀释,声母级误转救不动 → Matcher 层兜实证误转形态。
    /// 完整命中制是误吸防线:含误转词的自然长句必须零执行。
    #[test]
    fn asr_mistranscription_aliases() {
        for (text, label) in [
            ("跳光谱", 11), ("掉光谱", 11), // journal 实证「调光谱」误转(流式)
            ("掉进", 34), ("调进", 34),     // journal 实证「调近」误转(流式)
            ("调紧", 34), ("吊井", 34),      // journal 实证「调近」误转(二遍模型形态漂移,say 弱音频)
        ] {
            assert_eq!(cmd(text).semantic_label, label, "「{text}」");
        }
        none("东西掉进去了"); // 自然语境句不完整命中,零执行
        none("掉进坑里了");
        none("掉"); // 单字误转绝不入表
    }

    /// command_word 链路:label 反查目录(§4.2)。
    #[test]
    fn command_by_label_catalog() {
        let c = command_by_label(42).expect("42 在目录");
        assert_eq!(c.action, "volume_100");
        assert_eq!(c.match_type, "command_word");
        assert_eq!(command_by_label(27).unwrap().action, "motor_up_step");
        assert_eq!(command_by_label(2).unwrap().canonical_phrase, "打开灯光");
        // 音量档 60-79
        assert_eq!(command_by_label(60).unwrap().action, "volume_5");
        assert_eq!(command_by_label(79).unwrap().action, "volume_100");
        // 合同排除与未知
        assert!(command_by_label(1).is_none(), "label 1 唤醒词永拒");
        assert!(command_by_label(46).is_none(), "label 46 关闭语音永拒");
        assert!(command_by_label(999).is_none(), "目录外 label 拒");
    }

    /// 合同 §6.6:范围外数值 → 固定提示,零命令零执行。
    #[test]
    fn volume_out_of_range() {
        assert_eq!(match_command("音量调到33%"), Some(DeviceMatch::VolumeOutOfRange));
        assert_eq!(match_command("音量调到百分之五十3"), Some(DeviceMatch::VolumeOutOfRange));
        assert_eq!(match_command("把音量调到0%"), Some(DeviceMatch::VolumeOutOfRange));
        assert_eq!(match_command("音量调到200%"), Some(DeviceMatch::VolumeOutOfRange));
    }

    /// label 46 数据层防线:env 覆盖词表夹带 46 也必须被拒。
    #[test]
    fn label_46_rejected_even_in_table_data() {
        let t = parse_tsv("46\tvoice_off\t关闭语音\t关掉语音\n2\tled_on\t打开灯光\t开灯");
        assert!(!t.map.contains_key(&normalize("关闭语音")), "46 不得入表");
        assert!(t.map.contains_key(&normalize("开灯")), "正锚:合法行仍加载");
    }

    /// canary 开关:hash/明文双形态 + 非设备房拒绝(纯函数测,不碰进程 env)。
    #[test]
    fn canary_gating() {
        assert!(commands_gate(true, "", "sn-BJP00326060100200003-1787000000"), "空列表=全开");
        assert!(!commands_gate(true, "", "web-debug-room"), "非 sn- 房不开命令");
        assert!(
            commands_gate(true, "bjp00326060100200003", "sn-BJP00326060100200003-1787000000"),
            "SN 明文命中(大小写不敏感)"
        );
        assert!(
            !commands_gate(true, "bjp00326060100200003", "sn-BJP00326060100200099-1787000000"),
            "非 canary SN 拒"
        );
        let hash = sha256_hex(b"BJP00326060100200099");
        assert!(
            commands_gate(true, &hash, "sn-BJP00326060100200099-1787000000"),
            "sha256 命中"
        );
        assert!(!commands_gate(false, "", "sn-BJP00326060100200003-1787000000"), "总开关关=全关");
    }

    #[test]
    fn normalize_rules() {
        assert_eq!(normalize("  把灯打开。 "), "把灯打开");
        assert_eq!(normalize("音量调到５０％"), "音量调到50");
        assert_eq!(normalize("音量百分之五十五"), "音量55");
        assert_eq!(normalize("百分之百"), "100");
    }

    /// D1:批次=词表全集(表内每个标签都放行,表外一个不放)。锚:表内标签数 ≥ 40,防「表没加载=全拒」恒绿。
    #[test]
    fn l2_batch_allows_all_table_labels_only() {
        let mut labels: Vec<u32> = table().map.values().map(|(l, _, _)| *l).collect();
        labels.sort_unstable();
        labels.dedup();
        assert!(labels.len() >= 40, "表内标签数 {}——词表未加载", labels.len());
        for l in &labels {
            assert!(l2_batch_allows(*l), "{l} 在词表内,D1 起必须放行");
        }
        for l in [2, 3, 5, 7, 25, 26, 33, 34, 35, 36, 42, 43, 44, 45] {
            assert!(l2_batch_allows(l), "{l} 原第二批标签 D1 起放行");
        }
        for l in [0, 1, 39, 40, 41, 46, 60, 79, 90, 999] {
            assert!(!l2_batch_allows(l), "{l} 不在词表,不得放行");
        }
    }


    /// D2 B5(2026-09-23):慢路门的设备词判据——三句真误触发无设备词,13 条慢路句+用例正例全含;
    /// 感受类抱怨(太吵/听不清/看不清/安静)按决定不算设备词;刺眼/晃眼 门专用补入。
    #[test]
    fn l2_device_text_gate_d2() {
        for t in ["嗯", "比较低够劲", "这个呢这本身没啥这个那我们这个产品是是别人代工的", "太吵了", "听不清", "看不清", "安静点", "别说了", "闭嘴", "太啰嗦"] {
            assert!(!l2_device_text(t), "「{t}」不得算设备词");
        }
        for t in [
            "把灯弄亮一点吧", "太暗了看不清", "把灯开到最亮", "把灯调暗一点", "太亮了", "灯太刺眼了关掉吧", "画面调到最远", "画面拉远一点",
            "画面离我太远了拉近点", "读写台升高一点", "读写台太低了", "先静音一下", "把声音打开吧", "声音再大一点", "太刺眼了", "有点晃眼",
        ] {
            assert!(l2_device_text(t), "「{t}」应算设备词");
        }
        assert_eq!(l2_fallback_hint("no_device_text", 37, false, true), None, "无设备词压制不给纠正句");
    }

    #[test]
    fn l2_gate_order_and_reasons() {
        assert_eq!(l2_gate(false, true, 6, false, true, true), Err("execute_off"));
        // D2 B5:无设备词排在能力门之前(与 execute_off 一样是"根本不该看暗号")
        assert_eq!(l2_gate(true, false, 6, false, true, false), Err("no_device_text"));
        assert_eq!(l2_gate(true, true, 6, false, true, false), Err("no_device_text"));
        assert_eq!(l2_gate(true, false, 6, false, true, true), Err("android_capability_missing"));
        assert_eq!(l2_gate(true, true, 999, false, true, true), Err("unknown_label"));
        assert_eq!(l2_gate(true, true, 46, false, true, true), Err("unknown_label"), "46 永不在表");
        assert_eq!(l2_gate(true, true, 60, false, true, true), Err("unknown_label"), "音量绝对值段不在表");
        assert_eq!(l2_gate(true, true, 6, true, true, true), Err("fast_path_hit"));
        assert_eq!(l2_gate(true, true, 6, false, false, true), Err("no_trace"));
        assert_eq!(l2_gate(true, true, 6, false, true, true), Ok(()), "全门通过");
        assert_eq!(l2_gate(true, true, 24, false, true, true), Ok(()), "中性光");
        // D1:原第二批标签全部放行(关灯 3 / 最暗 7 / 音量最大 42 / 电机 25 / 虚像最远 35 / 静音 44)
        for l in [3, 7, 42, 25, 35, 44, 33] {
            assert_eq!(l2_gate(true, true, l, false, true, true), Ok(()), "{l} D1 起放行");
        }
    }

    /// D1(2026-09-22):纠正句只在 unknown_label + 快路没在途 + 设备房;其余压制原因一律不提示;
    /// 表内标签(D1 起全部可执行)永不纠正——纠正句挂在已执行的标签上=自相矛盾。
    #[test]
    fn l2_fallback_hint_only_for_unknown_label_on_device_room() {
        assert_eq!(l2_fallback_hint("unknown_label", 999, false, true), Some(L2_FALLBACK_HINT), "幻觉标签");
        assert_eq!(l2_fallback_hint("unknown_label", 46, false, true), Some(L2_FALLBACK_HINT), "46 表外");
        assert_eq!(l2_fallback_hint("unknown_label", 60, false, true), Some(L2_FALLBACK_HINT), "音量绝对值段表外");
        assert_eq!(l2_fallback_hint("unknown_label", 999, true, true), None, "快路在途=快路已在做,不纠正");
        assert_eq!(l2_fallback_hint("unknown_label", 999, false, false), None, "无 trace=非设备房");
        for l in [3, 7, 25, 35, 42] {
            assert_eq!(l2_fallback_hint("unknown_label", l, false, true), None, "{l} 在表内,不纠正");
        }
        for r in ["execute_off", "android_capability_missing", "not_in_batch", "fast_path_hit", "no_trace", "multi_label", ""] {
            assert_eq!(l2_fallback_hint(r, 999, false, true), None, "{r} 不提示");
        }
    }

    /// 纠正句会被 TTS 念出、再被本机 ASR / Android KWS 听到:含任何别名=自触发命令。整张别名表对撞。
    #[test]
    fn l2_fallback_hint_contains_no_device_alias() {
        assert!(match_command(L2_FALLBACK_HINT).is_none(), "整句不得命中命令");
        let norm = normalize(L2_FALLBACK_HINT);
        assert!(!norm.is_empty());
        let mut checked = 0;
        for alias in table().map.keys() {
            checked += 1;
            assert!(!norm.contains(alias.as_str()), "纠正句含别名「{alias}」");
        }
        assert!(checked >= 200, "别名表未加载({checked})——对撞等于没做");
        // 负锚:判据本身有区分力(含别名的句子必须被同一判据抓到)
        let bad = normalize("这个我暂时还不能这样调，你直接说虚像调到最远就可以啦");
        assert!(table().map.keys().any(|a| bad.contains(a.as_str())), "负锚:含别名句必须被抓到");
    }
    /// v3.1:芯片决策纯函数——合同 2 旧策略不变;合同 3 才有 claimed/ignored/电机等 ASR。
    #[test]
    fn chip_decision_matrix() {
        use ChipDecision::*;
        assert_eq!(chip_decision(2, None, 30, true).0, Propose, "合同 2 老包:目录内即提案");
        assert_eq!(chip_decision(2, Some("deferred"), 30, true), (Propose, "contract_below_3"), "旧端带新字段也走旧策略");
        assert_eq!(chip_decision(3, Some("claimed"), 4, true), (Claimed, "android_owned"));
        assert_eq!(chip_decision(3, Some("ignored"), 4, true), (Ignored, "android_ignored"));
        assert_eq!(chip_decision(3, Some("deferred"), 30, true), (DeferredWaitAsr, "motor_outside_chip_first"));
        assert_eq!(chip_decision(3, Some("deferred"), 4, true), (Propose, "deferred_light_volume"));
        assert_eq!(chip_decision(3, None, 30, true), (OwnershipUnknown, "ownership_missing"), "合同 3 缺所有权=fail-closed,不提电机动作(R2)");
        assert_eq!(chip_decision(3, Some("unknown_ownership"), 30, true), (OwnershipUnknown, "local_action_unknown"), "codex R2 反例:未知所有权不得提电机动作");
        assert_eq!(chip_decision(3, Some("weird"), 4, true).0, OwnershipUnknown, "灯光同样 fail-closed");
        assert_eq!(chip_decision(2, Some("weird"), 30, true), (Propose, "local_action_unknown_contract_v2"), "合同 2 未知值仍旧兼容策略,只记诊断");
        assert_eq!(chip_decision(3, Some("claimed"), 1, false).0, NotInCatalog);
    }

    #[test]
    fn motor_label_range_is_25_to_36() {
        assert!(!motor_label(24) && motor_label(25) && motor_label(36) && !motor_label(37));
    }

    #[test]
    fn normalize_params_default_count_equals_one() {
        assert_eq!(normalize_params(None, None, None), "");
        assert_eq!(normalize_params(Some(1), None, None), "", "缺省 count 与 count=1 归一一致");
        assert_eq!(normalize_params(Some(2), None, None), "c2");
        assert_eq!(normalize_params(None, Some(0), None), "v0", "绝对静音 0 合法且可辨");
        assert_eq!(normalize_params(Some(3), Some(50), Some(80)), "c3,v50,t80");
        assert_ne!(normalize_params(None, None, Some(50)), normalize_params(None, None, Some(80)), "不同目标不得互吞");
    }
}

#[cfg(test)]
mod chip_echo_tests {
    use super::*;

    #[test]
    fn phrases_for_label_reflect_alias_table() {
        let p = phrases_for_label(4);
        assert!(!p.is_empty(), "label 4 必须有别名");
        for ph in &p {
            assert_eq!(lookup(ph).map(|m| match m { DeviceMatch::Command(c) => c.semantic_label, _ => 0 }), Some(4), "{ph}");
        }
        assert!(phrases_for_label(1).is_empty(), "label 1 永不入表");
    }

    #[test]
    fn spoken_text_containing_alias_is_echo_suspect() {
        let p = phrases_for_label(4);
        let spoken = normalize(&format!("好嘞，帮你{}。这样看着舒服些。", p[0]));
        assert!(spoken_contains_label_phrase(&spoken, 4));
        assert!(!spoken_contains_label_phrase(&normalize("今天天气真好呀"), 4));
        assert!(!spoken_contains_label_phrase("", 4));
    }
}

#[cfg(test)]
mod overlap_skip_tests {
    use super::*;
    const H0006: &str = "ec35e1b52da5ecbfb8737a90680ee10e9c6ac8b6d1cf057a20955fa5bca4758b"; // sha256("BJP00326070804800006")

    #[test]
    fn skip_list_matches_hash_or_lowercase_sn_only() {
        let room = "sn-BJP00326070804800006-1788690141";
        assert!(sn_listed(H0006, room));
        assert!(sn_listed(&format!(" other , {H0006} "), room));
        assert!(sn_listed("bjp00326070804800006", room));
        assert!(!sn_listed("", room), "空表=不跳过任何设备");
        assert!(!sn_listed(H0006, "sn-BJP00326010100000001-1788690141"), "0001 不在表");
        assert!(!sn_listed(H0006, "web-debug-1788690141"), "非设备房恒 false");
    }
}
