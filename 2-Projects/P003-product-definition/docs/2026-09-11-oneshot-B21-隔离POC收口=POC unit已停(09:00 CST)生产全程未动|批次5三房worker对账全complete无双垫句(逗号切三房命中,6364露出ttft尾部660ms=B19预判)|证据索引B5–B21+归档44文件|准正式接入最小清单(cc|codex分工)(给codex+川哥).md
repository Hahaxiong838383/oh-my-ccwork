# One-shot 首句隔离 POC 收口回执（给 codex + 川哥）

日期：2026-09-11 09:02 CST。对应 codex `ONESHOT_V261_REPRESENTATIVE_TWO_ROUNDS_20260911.md`（两轮代表性真人验收，建议收口）+ 川哥「先收口吧，准正式接入了」。

## 0. 收口动作（本轮做了什么）

| 动作 | 结果 |
|---|---|
| 最后三房 worker 侧对账 | …6363 / 6364 / 6365 全 complete，worker 零垫句、正文门按 receipt_done 放行、underrun 0（§1） |
| 停隔离 POC unit（HANDOFF 待完成 4） | 闸门 received 9 == closed 9 后 `systemctl stop voice-worker-poc`，2026-09-11 00:59 UTC（08:59 CST）；transient unit 已消失（LoadState=not-found），64.90 只剩 `voice-worker-rust`（生产）与 `voice-worker-colleague` |
| 生产 | `voice-worker-rust` MainPID 2017631（2026-09-06 23:49:55Z 起）**全程未动**；每轮核查生产 journal POCTEST0001 命中均为 0 |
| 留档 | 64.90 `/root/rust-worker-poc/`：最终二进制 `5d52a1bb…`（23f050b9f）+ 9 个回滚二进制 + env 与 5 份 env 备份 + **POC unit 全量 journal 18452 行**（`poc_journal_full_20260908_20260911.log.txt`，无 token，不入仓）；`/root/opcm-poc-rooms/` 只剩去 token 公开副本 + 注册表 53 条 |
| 未消费房 | 批次 5 …1789086366（到 2026-09-13 08:26 CST）；POC unit 已停，**要再用得先按旧 HANDOFF 第 25 行那条 systemd-run 重建 unit** |
| 代码 | worker 分支 `feat/ordered-pcm-input @ 23f050b9f`（origin 已推，未合 main）；铸房/模拟器脚本在 mycc main |

## 1. 批次 5 三房 worker 对账（codex 表里只有 6364/6365；6363 是 08:43 的「3+5」）

| 项 | …6363「帮我算一下 3+5 等于多少」16 字 | …6364 句中停顿「帮我算一下 7+8 等于多少」16 字 | …6365「3+5+2 一共是多少」14 字 |
|---|---|---|---|
| begin accepted since_pipeline | 78 | 139 | 0 |
| held final → commit（投机 lead） | 30.119 → 30.137（18） | 12.369 → 12.400（31） | 22.738 → 22.762（23） |
| LLM ttft | 404 | **755** | 366 |
| 首句逗号切 | **命中**「3加5等于8哦，」8 字 | **命中**「7加8等于15哦，」9 字 | **命中**「3加5是8，」6 字 |
| 正文就绪 vs receipt_done 到达 | 就绪早 405 ms → 门 **held 405** | 就绪晚 660 ms → held 0 | 就绪晚 220 ms → held 0 |
| body first frame since_turn | 1199 | 1150 | 799 |
| 端侧承接播完→首远端 PCM（codex） | — | **850** | **475** |
| 结果 / worker 垫句 / underrun | complete / 无 / 0 | complete / 无 / 0 | complete / 无 / 0 |

- 三房逗号切全部命中（数学类回复天然「结果哦，解释」结构），首句 6～9 字就交 TTS。
- …6364 的 850 ms = **B19 §4 预判的「ttft 尾部超过承接」第一次真人撞上**：ttft 755 + 首句 120 + TTS 262 = 1137 ms > 承接 1180 − 上行，正文比 receipt_done 晚 660 ms 就绪，门 held 0 立即放行——行为正确，就是生成链露出来了。这是产品参数（承接时长 vs ttft 分布）问题，不是缺陷。
- …6363 是理想形态：正文早 405 ms 就绪在门里等，承接播完即出声。

## 2. 验过什么 / 没验什么（上产前别当成已验）

**验过（有 worker 日志锚 + 端侧锚）**：早 begin / ACK 前有界上传 / 随采即发尾段 + end（…0278 起）；本地承接 v1 三层门（签名 metadata ∧ env ∧ begin 声明）+ ack 回显 + receipt_done 放行 + 3000 ms fail-open；端侧没播 played_ms=0 → worker 垫句（…9362）；缺片/取消/超时 fail-closed（模拟器矩阵）；held-final 投机 + TTS 预热 + 跳垫句三条件；首句逗号切；完整性门（句中停顿 10 字完整）；真人房 9 房 complete（7014/7015/9361/9362/0274/0276/0277/0278/6363/6364/6365 中有效对账 11）。

**没验（转产必须补）**：P95（ttft 样本 9 个：537/736/456/558/496/870/404/755/366）；**首句后切回 RTC 多轮会话**（POC 里 ordered 房整个 job「RTC 音频只计数丢弃」，只做一句）；STOP/EXIT/空闲超时在这条路径；设备执行与状态回执；生产 Session API 签发；VAD-less 放宽分支（`pipeline.rs:2215`）在生产签发下的行为；session_id 头与 metadata 对撞；真人 ttft>承接 的体验只撞上一次（…6364）。

## 3. 准正式接入最小清单（合并 codex「后续最小范围」4 条 + cc B19 §4 账）

| # | 事 | 归属 | 备注 |
|---|---|---|---|
| 1 | 生产 Session API 对**灰度名单内真实 MCU SN** 签 `input_mode=ordered_pcm` + `local_receipt="v1"`（metadata），其余设备不签 = 旧路径 | cc（server） | 回滚 = 名单清空；不把 POC 房文件搬成凭据方案（codex 1） |
| 2 | worker：ordered 代次终态后**切回 RTC 正常多轮**（现 POC 整 job 丢弃 RTC）；VAD-less 放宽分支守卫；session_id 对撞；POC 七个 env 开关定生产默认值并进生产 env | cc（worker） | 这是 worker 侧最大一块；换装走 received==closed SOP；分支合 main 前过 244+ 测试 |
| 3 | Android：预录 + 本地判停 + 承接脱离 Studio armed，走产品开关；首句后切回正常多轮（音量/AEC/「停」打断/「退出」关闭保留）；不照搬 POC 观察窗 | codex | codex 2、3 |
| 4 | 控设备接现有执行器 + 真实状态回执，LLM 不得口头冒充执行成功 | codex（端）+ cc（server 回执面） | codex 4；本线只做到识别 |
| 5 | 灰度：1 台真机（名单第一台）→ 验收锚 = POC 同款 worker 日志行（begin accepted / filler skipped / gate released / body first frame）+ 用户反馈；跑够 ≥20 轮再看 ttft 分布定承接时长 | 双方 | 先不动承接长度与 704 安静门 |

建议顺序：1 → 2（可并行开发）→ 3 → 5 → 4。

## 4. 证据索引

- 回执链：B5–B21 在 `2-Projects/P003-product-definition/docs/2026-09-0{8,9}-oneshot-B*`、`2026-09-1{0,1}-oneshot-B*`；Downloads 副本 `CC_ONESHOT_*.md`。
- 归档目录 `2-Projects/realtime-voice-agent/docs/oneshot-b6-20260909/`：44 个文件（模拟结果 jsonl、真机房 journal 窗、去 token 公开房文件、注册表快照）；本轮 +1 `poc_journal_b21_rooms_6363_6364_6365_20260911.log.txt`。
- 工具：`2-Projects/realtime-voice-agent/tools/opcm_poc_mint_rooms.py`、`opcm_device_sim.py`（64.90 `/root/asr-burst-probe/` 同版）。
- 未 commit（等川哥 ①）：B19/B20/B21 回执 + 归档 7 文件。

署名：cc（Claude）| 2026-09-11 09:02 CST
