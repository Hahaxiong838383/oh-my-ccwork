# RTC case2 断言复核（只读）

范围：只核 3 组 RTC 第 2 编号的测试断言与归因。候选 `50bac0b28c4f44e169ad574c08682fe509a72a46`，trace `p0-39-29a21af0-be40-4084-812f-e15c661de20d`，房间 `sn-BJP00326103099999938-1794084579`。未改代码、未改结果、未编译、未等待纠正后的隔离测试。这不是真人验收，也不是正式生产验收。

## 裁决

旧失败保持失败。`case-2-result.json` 仍是 `passed: false`，错误仍是旧断言 `held prefix caption not restored exactly once`。本次没有把它改写成通过。

两条「小可」字幕来自两次真实 ASR final，各对应一个不同字幕段。服务器没有把一条 final 追加成两条。

修正后的断言合理：按 `held_wall` 读取 `worker.log` 里之后的全部 `stt final`，与非空 final 字幕做内容、数量、顺序严格相等，并要求段 ID 唯一、无音频。它不是放宽成 `>= 1`。

## 证据

文件哈希与 `FEEDBACK_CASE2_ASSERTION_ANALYSIS.json` 一致：

- `worker.log` `6117abb4ce34e6b6cd4399fc47adeaeee4e8a428103da5a0bc724dcaf28f958e`
- `case-2-result.json` `50fe600540ff908d62daae729feb43b058e7ffd19ee0411dd6e309177e757c27`

时钟锚点：客户端 `session.input_ready` 的 `ts_ms=1794084580293` 与 worker `2026-11-07T20:49:40.293144Z` 相差 0.144ms。下面的 `t_est` 用这个锚点从 worker 时间换到探针 `t_ms`。

同一房间的 `stt final`：

| worker 时间 | t_est | 文本 | 归属 |
| --- | --- | --- | --- |
| 20:49:40.989203Z | 1426 | 小可 | ordered_pcm，随后 `finals:2, finals_held:2, text_chars:9`（「小可」+「先听我讲个故事」） |
| 20:49:41.520416Z | 1957 | 先听我讲个故事 | 同上，被 hold，没有变成用户字幕 |
| 20:49:54.719671Z | 15156 | 小可 | wake 上行（t_ms 13223）之后 |
| 20:49:55.608369Z | 16045 | 小可 | 同上 |

两条 wake final 相隔 889ms。中间有一次 `listening acoustic speech_start`（20:49:54.888090Z）。这是两次收尾，不是同一条日志被写了两遍。

客户端 final 字幕：

- t_ms 15158，`SG_3088589e9102`，文本为空。时刻对齐第一条 wake final。
- t_ms 16045，`SG_459049ff336f`，`小可`。
- t_ms 16046，`SG_68fe9b7e1c70`，`小可`。

两条「小可」段 ID 不同，落在同一次回调里，时刻对齐第二条 final。第一条 final 当时没有立刻变成「小可」文本，而是一条空段；889ms 后两条文本一起出现。空段不增加「小可」条数。

wake 之后整段序列（非空 final）两边相同，共 7 条：

`小可` / `小可` / `萧兄今天走进森林` / `发现一颗金色的苹果` / `他把苹果分给了朋友` / `最后一件礼物` / `是一只紫色风筝`

其后每条故事字幕的 `t_ms` 与对应 `stt final` 相差约 0–6ms，且各用一个段 ID。全日志非空 final 字幕 12 条，段 ID 12 个，没有重复。`audio` 长度为 0。更早那条 ordered「小可」没有再多出第三条用户字幕；「先听我讲个故事」也没有作为字幕出现。

因此可见形态是 2 条 wake final → 2 条不同段的「小可」。一条 final 被重复追加时应是 ASR 条数少于字幕条数，或同一段 ID 出现两次。这里两者都不是。

## 旧断言为什么失败

旧探针 `feedback-reviewed-rtc-case2/rtc-probe.py` 在 `started_ms` 之后只收文本去掉标点后等于「小可」的 final，并要求 `len(held)==1`。实际两条都是「小可」，断言按自身规则失败，结果保持 `passed: false`。这个预期把 wake.wav 当成只会有一条 final。

## 新断言

`prepare-feedback-reviewed-rtc.py` 的 `FILES['rtc-probe.py']` 经 `ast.literal_eval` 后 base64 解码（sha256 `18470b74c68b84d6edd0a0e3ccabad984437fdb702b78ff28b7162149490657b`）。`held_prefix_check` 段在 `speak('wake')` 前记下 `held_wall=time.time()`，结束后：

- 去掉 ANSI，取 `worker.log` 中时间戳 `>= held_wall` 的全部 `stt final` 文本，记为 `rows`。
- 取 `t_ms>=started_ms` 的非空 final 字幕文本，记为 `actual`。
- `rows` 非空，且至少一条去标点后是「小可」。
- `actual==rows`。
- 这些字幕的段 ID 数量等于条数。
- `not self.audio`。

用这份旧轨迹重放该谓词，wake 时窗的 7 条文本序列相等、段 ID 唯一、音频为空。这只说明新谓词与旧日志一致，不是新测试通过，也不改写旧的 `passed: false`。纠正后的隔离测试结果本次未读、未等。

边界：新断言比较的是文本序列，不比较每条 final 的到达时刻，所以「两条小可同一回调到达」仍会通过。空字幕被 `text.strip()` 排除，`SG_3088589e9102` 不进入比较。这两点不把断言放宽成「至少一条小可」；多追加、少发、错序或重复段 ID 仍会失败。
