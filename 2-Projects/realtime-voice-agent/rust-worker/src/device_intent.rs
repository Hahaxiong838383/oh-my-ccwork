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
const POLITE_PREFIX: &[&str] = &["可以帮我", "麻烦", "帮我", "小可", "请", "把", "好", "那", "嗯", "哎"];
const POLITE_SUFFIX: &[&str] = &["可以吗", "好吗", "一下", "吧"];

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

/// 2b 合同 v2 第一批低风险可逆集合(codex 终值):亮暗一级/暖冷一级/三光模式/音量 ±5。
/// 画面远近 33/34 归实体电机域,开关灯/最值/静音/高度全在第二批(观察一周后议)。
pub const L2_FIRST_BATCH: [u32; 9] = [4, 6, 12, 13, 22, 23, 24, 37, 38];

pub fn l2_first_batch(label: u32) -> bool {
    L2_FIRST_BATCH.contains(&label)
}

/// LLM 慢路执行门序(纯函数,单测载体)。Err=suppress 原因(日志 reason 枚举);顺序即优先级:
/// execute_off → android_capability_missing → unknown_label → not_in_batch → fast_path_hit → no_trace。
pub fn l2_gate(
    execute_on: bool,
    capable: bool,
    label: u32,
    fast_path_pending: bool,
    has_trace: bool,
) -> Result<(), &'static str> {
    if !execute_on {
        return Err("execute_off");
    }
    if !capable {
        return Err("android_capability_missing");
    }
    if !known_label(label) {
        return Err("unknown_label");
    }
    if !l2_first_batch(label) {
        return Err("not_in_batch");
    }
    if fast_path_pending {
        return Err("fast_path_hit");
    }
    if !has_trace {
        return Err("no_trace");
    }
    Ok(())
}

/// 2b 候选关联判定(纯函数):同 trace && 候选属于本 turn(到达时标记 next_turn_id+1 == 本轮 id) && 非残留。
/// 不设 commit 等待上限(codex 终值①);fresh=false 仅代表「候选后长时间没有任何 commit」的残留。
pub fn candidate_matches(same_trace: bool, for_turn: u64, cur_turn: u64, fresh: bool) -> bool {
    same_trace && for_turn == cur_turn && fresh
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

    #[test]
    fn l2_first_batch_is_exactly_nine_low_risk_labels() {
        for l in [4, 6, 12, 13, 22, 23, 24, 37, 38] {
            assert!(l2_first_batch(l), "{l} 应在第一批");
        }
        for l in [2, 3, 5, 7, 25, 26, 33, 34, 42, 43, 44, 45, 90] {
            assert!(!l2_first_batch(l), "{l} 不得在第一批");
        }
    }

    #[test]
    fn l2_gate_order_and_reasons() {
        assert_eq!(l2_gate(false, true, 6, false, true), Err("execute_off"));
        assert_eq!(l2_gate(true, false, 6, false, true), Err("android_capability_missing"));
        assert_eq!(l2_gate(true, true, 999, false, true), Err("unknown_label"));
        assert_eq!(l2_gate(true, true, 3, false, true), Err("not_in_batch"), "关灯在第二批");
        assert_eq!(l2_gate(true, true, 33, false, true), Err("not_in_batch"), "画面远近实体电机域");
        assert_eq!(l2_gate(true, true, 6, true, true), Err("fast_path_hit"));
        assert_eq!(l2_gate(true, true, 6, false, false), Err("no_trace"));
        assert_eq!(l2_gate(true, true, 6, false, true), Ok(()), "全门通过");
        assert_eq!(l2_gate(true, true, 24, false, true), Ok(()), "中性光在第一批");
    }

    #[test]
    fn candidate_matches_requires_trace_turn_and_freshness() {
        assert!(candidate_matches(true, 4, 4, true), "同 trace+本 turn+新鲜=关联");
        assert!(!candidate_matches(false, 4, 4, true), "异 trace 不关联(M10 旧 trace ID)");
        assert!(!candidate_matches(true, 4, 5, true), "候选属于上一 turn 不关联(残留防 already_applied 错话术)");
        assert!(!candidate_matches(true, 4, 4, false), "候选后长时间无 commit 的残留不关联");
        assert!(candidate_matches(true, 7, 7, true), "长句:只要 commit 落在同一 turn 就关联,无固定等待上限");
    }
}
