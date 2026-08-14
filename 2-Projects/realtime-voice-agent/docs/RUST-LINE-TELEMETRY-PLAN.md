# Rust 灰度线 · SN 关联与埋点方案（待拍板）

> 目标：设备不绑死房间，但每一条埋点都能归因到具体设备 SN。
> 状态：**方案，未实现**。所有「现状」为 2026-08-14 实读代码/线上确认；「拟建」需改 worker 代码，等拍板再动。

---

## 0. 现状（先说清楚缺口在哪）

| 事实 | 影响 |
|---|---|
| worker 只读 participant `identity()`，未读 metadata/attributes | SN 走 identity 零框架改动；走 attributes 要补代码 |
| metrics 只 `publish_data` 到房间给客户端 | 页面看完即弃 |
| **Rust worker 全程 0 个文件写入点**（全量 grep 确认） | **服务端没有任何埋点留存通道** |
| 磁盘余量 43G；voice-console 无 SQLite/建表代码 | 不必迁就现有存储，可另起干净方案 |

**结论：缺的不是 SN 关联，是「服务端留存」这条通道本身。** 不补它，SN 传得再规范也采不回来。

---

## 1. SN 传递：三处冗余 + 来源标记

| 载体 | 值 | 角色 |
|---|---|---|
| **participant identity**（必选） | `dev-<SN>` | **唯一数据源**，worker 已能读，零框架改动 |
| participant attributes（S2 选做） | `{sn, model, fw, channel}` | 扩展维度（型号/固件/渠道） |
| 房间名 | `sn-<SN>-<时间戳>` | **仅供人读与 grep，不作数据源** |

房间名每次带时间戳 → 每次会话新房、必重新派单，绕开"重连撞旧房"的窄窗（见接入文档 §1）。

### 🔴 缺失时不许填看起来像真值的占位

```jsonc
// 对：缺失可判别
{ "sn": null, "sn_source": "missing" }
{ "sn": "SN12345678", "sn_source": "identity" }
// 错：以后你分不清「设备没传」和「传了个 unknown」
{ "sn": "unknown" }
```

`sn_source` 取值：`identity` / `attributes` / `invalid` / `missing`。
并把 **SN 缺失率**做成一个日常指标——**全体同值就是兜底信号**，没有这个指标，整批设备漏传 SN 你看不出来，数据看着还挺齐。

### 边界校验（SN 是外部输入）

- 白名单正则 `^[A-Za-z0-9_-]{6,64}$`；不过 → `sn=null, sn_source=invalid`，原值截断 32 字符存 `sn_raw` 供排查。
- **SN 绝不参与拼接文件路径**（防穿越）；只作字段值。

---

## 2. 埋点数据模型（JSONL，一行一事件）

公共字段：`ts` `event` `session_id`(=房间名) `sn` `sn_source` `room` `agent` `ver`

| event | 关键字段 | 回答什么问题 |
|---|---|---|
| `session_start` | model, fw, ice_type | 哪台设备、什么时候、怎么连的 |
| `turn` | turn_id, eou_ms, stt_ms, ttft_ms, ttfb_ms, e2e_first_audio_ms, asr_chars, interrupted | 每轮体验如何、慢在哪一段 |
| **`asr_empty`** | vad_ms, mean_amp, had_interim | **单字被上游丢弃**——当前最大痛点，必须单列 |
| `error` | stage(stt/llm/tts/rtc), code, msg(截断) | 故障归因 |
| `session_end` | duration_s, turns, interrupts, errors, end_reason, **dropped_events** | 会话总账 |

`asr_empty` 是这套埋点最值钱的一条：它把"用户说了但 AI 没反应"从主观抱怨变成**可按 SN、按环境统计的数字**，热词效果好不好、哪台设备声学环境差，直接看得见。

---

## 3. 落地：双通道，故意冗余

- **主**：worker 追加写 `/var/log/voice-events/<YYYY-MM-DD>.jsonl`（`O_APPEND` 单行原子，行 <4KB）
- **副**：同一事件经 tracing 进 journald（`target=event`）

**为什么要两条**：只有一条通道时，通道自己坏了不会有人告诉你——写盘权限丢了、目录被清了，表现都是"没数据"，和"设备没上线"完全同形。两条定期对账条数，差值即故障信号。

**写失败处理**：warn 日志 + 内存 `dropped_events` 计数，**绝不阻塞热路径，绝不吞掉**；计数写进 `session_end`，让"这次会话丢了多少条埋点"本身成为数据。

保留：logrotate 30 天。事件量估算——2 路并发满打满算一天几千行，磁盘压力可忽略。

---

## 4. 采集与查询

- 落盘即可 `jq` 直查，先不引任何数据库。
- 配一个 `scripts/events_query.py`：按 SN / 日期 / 事件类型聚合（会话数、平均各段延迟、asr_empty 率、错误 TOP）。
- 真要长期趋势再定时导 SQLite；**别一上来就上数据库**，2C2G 小机不值当。

---

## 5. 隐私边界（先划死）

- **默认不采音频、不采字幕原文**，`turn` 只存 `asr_chars`（字数）不存文本。
- 字幕原文含用户说话内容，属个人数据；确需采样必须单独开关 + 明确告知，且不与 SN 长期关联存储。
- SN 本身是设备标识；**一旦与对话内容绑定就变成个人数据**，这条线守住。

---

## 6. 分阶段（每阶段一个卡点）

| 阶段 | 内容 | 产出 |
|---|---|---|
| **S1 最小可用** | identity 带 SN + `session_start`/`turn`/`session_end` + JSONL 落盘 + logrotate | 能答"哪台设备、多久、几轮、延迟多少" |
| **S2 归因增强** | `asr_empty` + `error` + 读 attributes（型号/固件） | 能答"谁在丢字、错在哪一段" |
| **S3 可视** | 查询脚本 + 可选 SQLite + 缺失率/丢弃率看板 | 能答趋势 |

S1 改动集中在 worker 新增 events 模块 + job/pipeline 少数调用点，不碰现有行为逻辑。

---

## 7. 验收（按"要采回的数据"逐条对，不是数代码写完没）

1. 逐条走 §2 的 event 表：每一类都真出现过一次，字段非空且值合理。
2. **负向验证（必做）**：故意让设备**不带 SN** 接入一次，确认落到 `sn_source=missing` 而**不是**被默认值悄悄填上。没做过这一步，等于没验——判据写错时它恒绿。
3. **双通道对账**：同一时段 JSONL 条数 == journald 事件条数。
4. `asr_empty` 用已知会被丢弃的单字（"停"）真触发一次，确认能落到事件里。
5. 确认 `turn` 里**没有**字幕原文（隐私边界回归）。

---

*现状部分为 2026-08-14 实读确认；方案部分未实现，待拍板。*
