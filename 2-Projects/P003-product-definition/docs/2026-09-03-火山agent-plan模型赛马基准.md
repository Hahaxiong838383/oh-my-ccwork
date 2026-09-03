# 火山 Ark「agent plan」各模型可用性 / 首字延迟 / 赛马适配基准（2026-09-03）

- 作者：cc（Claude）· 依据：`~/Documents/陈川个人站/火山 agent plan-20260902.rtfd`（Base `https://ark.cn-beijing.volces.com/api/plan/v3`，OpenAI 兼容；key 只存该文件，本文与记忆不复制）
- 测法：流式 chat.completions，`max_tokens=80`，能关思考的关（`thinking.type=disabled`）；短提示（60 字 system + 「太亮了」）在 Air 与 64.90（HK，worker 生产机）各跑；再用 1.4k 字 system（含 `[[DEV:N]]` 协议段）在 64.90 复测前四名。每模型 2–3 次，样本小，看量级与稳定性不看小数。

## 一、可用性（11 个模型）

| 模型 | 能否正常调用 | 思考能否关 | 备注 |
|---|---|---|---|
| doubao-seed-2.1-turbo | ✅ | ✅ | 短提示最快，长提示最慢（prefill 重） |
| doubao-seed-evolving | ✅ | ✅ | 周级滚动升级的统一 ID＝行为会漂，不宜做生产兜底 |
| doubao-seed-2.0-lite | ✅ | ✅ | 现役兜底（coding plan 同名模型） |
| doubao-seed-2.0-mini | ✅ | ✅ | 长提示下最快且最稳；回复偶有跑题 |
| deepseek-v4-pro | ✅ | ✅ | 首字 1.2–2s |
| deepseek-v4-flash | ✅ | ✅ | 中位 1.1s，有 7.5s 长尾 |
| minimax-m3 | ✅ | ✅ | 中位 0.86s，有 6.3s 长尾 |
| glm-5.3-flash / glm-5.3 | ⚠️ | ❌ | `thinking.type=disabled` 报「not supported」；思考默认吃掉 token 预算→80 token 内零正文；`reasoning_effort=none` 只减不灭，首字 1.7s |
| kimi-k2.7-code | ⚠️ | ❌ | 带 thinking 参数 400；不带则必思考 250+ 字，首字 2.2s |
| kimi-k3 | ❌ | — | 文档自述「火爆中」：首字 3.6s–38s |

响应头无任何 ratelimit/quota 字段，**套餐额度（RPM/TPM/月量）未知**，文档也没写——赛马每轮双发，额度是硬约束，先在控制台确认。

## 二、首字延迟（TTFT，ms，中位数；括号为各次实测）

| 模型 | Air 短提示 | HK 短提示 ×3 | HK 1.4k 字提示 ×3 |
|---|---|---|---|
| doubao-seed-2.1-turbo | 530/777 | **541**（526·541·595） | 2318（2176·2318·2405） |
| doubao-seed-evolving | 2534/366 | 621（538·621·878） | 1274（737·1274·1747） |
| doubao-seed-2.0-lite（现役兜底） | 656/882 | 852（774·852·876） | 1334（907·1334·1986） |
| doubao-seed-2.0-mini | 586/638 | 833（802·833·1195） | **524**（431·524·769） |
| deepseek-v4-pro | 1172/2050 | 1255（1192·1255·1623） | — |
| deepseek-v4-flash | 2726/650 | 1075（780·1075·**7469**） | — |
| minimax-m3 | 857/733 | 856（811·856·**6318**） | — |

长提示下四个 doubao 全部正确输出 `[[DEV:6]]` 标记（协议兼容）。**结论：提示词长度改变排名**——2.1-turbo 短提示第一、长提示垫底；mini 长提示第一。评估兜底模型必须用生产长度的 prompt。

## 三、现役赛马的真实账（64.90 journal 48h，362 轮）

- main（大脑 kidshub-ai）胜 335 轮（92.5%），fallback 胜 27 轮（7.5%）；race TTFT p50 799 / p90 1236 / p95 1349 / max 2064 ms。
- fallback 胜出时 race TTFT 868–1507 ms：它只在 main 超过 800ms grace 后才有机会，而 lite 自己首字 ~850–1300ms，所以「救回来」的轮次仍要 1–1.5s 才出声。
- **fallback 的 system prompt 不是小可**（更正：`AGENT_INSTRUCTIONS` 未设置，走 `llm.rs` 内置的通用「中文实时语音助手」默认指令，无小可人设、无设备协议）：兜底胜出的 27 轮孩子听到的是通用助手口吻、没有记忆的回复。这是比速度更先该修的事。

## 四、能不能用作赛马机制——结论

1. **可以，但只有 doubao 四个能进候选**；glm/kimi 关不掉思考、kimi-k3 排队，deepseek/minimax 有 6–7s 长尾（兜底路最忌长尾）。
2. **推荐兜底 = doubao-seed-2.0-mini**（生产长度提示下 ~520ms、三次波动 340ms），预期把 fallback 胜出轮的出声时刻从 0.9–1.5s 压到 ~0.8–0.9s（受 grace 800 下限约束），只影响约 7.5% 的慢轮；lite 保留为回滚锚。evolving 因滚动升级不进生产。
3. **先做两件前置再换**：①给 fallback 一段精简人设（≤400 字，含 `[[DEV:N]]` 协议与两句话限制），并按长提示复测；②在火山控制台拿到 agent plan 的 RPM/TPM/月额度，估算「每轮双发」的消耗；额度不够就不换 key，继续用 coding plan。
4. 换法（都是 env）：`LLM_FALLBACK_BASE_URL=…/api/plan/v3`、`LLM_FALLBACK_MODEL=doubao-seed-2.0-mini`、`LLM_FALLBACK_API_KEY`（新 key）、`AGENT_INSTRUCTIONS`（精简人设）→ 纪律重启；验收=48h 后重跑本文 §三 的统计，看 fallback 胜出轮的 race TTFT 分布左移、且回复带人设。
5. 可选：把 grace 从 800 降到 ~600 只在换了更快兜底之后再试，先看 main 的 p50（799）——grace 低于 main 中位会让一半轮次被兜底抢走，人设与记忆就丢了。

## 五、复现

基准脚本在 cc 会话 scratchpad（`ark_bench.py` / `ark_bench_long.py`，urllib 流式，key 从 `ARK_KEY` 环境读，不落盘）；64.90 上已有 `scripts/bench_race_pair.py` 可做主路/兜底成对基准。

## 六、按生产环境同一 prompt 复测（2026-09-03 11:15 CST，川哥要求）

**prompt 来源**：在 aliyun-hk 用与 `custom-llm.ts` 热路径**同一组函数**为 003 现场组装（世界观 + 安全基座 + 记忆区块 + 课程/启蒙/召回/陪伴护栏 + 设备附加规则 + 设备意图协议；`skipInjectReceipt` 不刷回执）：A 新会话「太亮了」system **4,759 字**；B 会话中段（003 最近 6 轮真实历史）+「给我讲一个恐龙的小知识」system **5,567 字**。64.90（HK）发起，每模型每变体 4 次，`max_tokens=120`，关思考。

| 模型 | A 首字 4 次（ms） | A 中位 | B 首字 4 次 | B 中位 | 备注 |
|---|---|---|---|---|---|
| **doubao-seed-2.0-mini** | 677·695·878·891 | **787** | 588·591·828·947 | **710** | 两变体都最快最稳；`[[DEV:6]]` 正确；聊天回复带称呼 |
| **deepseek-v4-flash** | 652·778·790·1007 | 784 | 790·866·930·937 | 898 | 与 mini 同档且极稳（本轮无长尾） |
| doubao-seed-evolving | 596·628·1000·2100 | 814 | 651·792·884·1574 | 838 | 中位好但有 2.1s 尾；滚动升级不进生产 |
| minimax-m3 | 731·779·1226·1449 | 1003 | 788·854·854·1088 | 854 | 稳，略慢 |
| doubao-seed-2.0-lite（现役兜底同款） | 759·1732·1838·3767 | 1785 | 913·1258·3726·4895 | 2492 | **真 prompt 下 0.8–4.9s 大抖**，不宜再做兜底 |
| doubao-seed-2.1-turbo | 1353·1559·2673·3960 | 2116 | 520·557·3838·4250 | 2198 | 双峰，prefill 重 |

六个模型 24 次调用全部 200、零思考泄漏、A 变体全部输出 `[[DEV:6]]`，B 变体全部按人设称呼「川哥」——人设与协议兼容性都过。

**与现役对照**：大脑主路（DeepSeek 官方 API 主 + 火山 doubao 兜底的大脑内赛马）在 worker 侧看到的 race TTFT p50 = 799ms（48h/362 轮）。mini / deepseek-v4-flash 用**同一份 4.8k 字 prompt** 做到 ~710–900ms，与主路中位持平，长尾更短。

## 七、结论修订（覆盖 §四）

1. **worker 兜底换 doubao-seed-2.0-mini**：真 prompt 下比现役 lite 快 1–1.8s 且波动小 3 倍；lite 在 5k 字 prompt 下 0.8–4.9s 抖动，兜底意义已失。前置仍是两件：给 fallback 一段精简人设（现为空）、控制台确认 agent plan 额度（双发）。
2. **大脑内赛马（DeepSeek 官方 + 火山 doubao）** 可把火山侧从现役 doubao 型号换成 mini，或把 deepseek-v4-flash 改走 Ark agent plan（HK→北京 ~800ms 稳定，规避官方 API 晚高峰 1.3–40s 抖动）——这是「同一模型换供应商」的低风险试法，先影子对比再切。
3. evolving 不进生产（滚动升级=行为漂移）；2.1-turbo 与 lite 出局；glm/kimi 出局。
4. 样本仍小（每格 4 次、单时段）；换之前用 64.90 `scripts/bench_race_pair.py` 跑 24h 影子对比看 p95。

## 八、执行记录（2026-09-03 11:26 CST，川哥拍板：建议 1 执行；建议 2 大脑不改）

- 64.90 `rust-worker.env`：`LLM_FALLBACK_BASE_URL=…/api/plan/v3`、`LLM_FALLBACK_MODEL=doubao-seed-2.0-mini`、`LLM_FALLBACK_API_KEY`=agent plan key、`LLM_FALLBACK_THINKING=disabled`；新增 `AGENT_INSTRUCTIONS`（363 字精简小可人设：语音语域 + 安全 + 第一批 9 个 `[[DEV:N]]` 映射；主路的大脑会过滤 system 消息，故只影响兜底）。`P003_DEVICE_INTENT_EXECUTE=1`/canary/二进制 `7ab90905` 未动。
- 纪律重启 11:24:40 CST（PID 1678795，注册 1，ERROR 0）。烟测（worker 同一份 env，HK 发起）：「太亮了」528/571ms 首字、`[[DEV:6]]` 正确；「恐龙」543ms。
- 回滚锚：`rust-worker.env.bak-20260903-pre-j2-open`（改回 coding plan lite：BASE_URL `…/api/coding/v3` + 原 key + `doubao-seed-2.0-lite`，去掉 `AGENT_INSTRUCTIONS`）+ 纪律重启。
- **事故**：首次写入时 key 经 stdin 与 `bash -s` 脚本相撞，key 被当命令执行并回显进会话记录、错 key 上线约 1 分钟（11:23:39–11:24:40，期间零会话）；已修正。**agent plan key 已暴露在本机会话日志，建议控制台轮换后告知，cc 换 env。**
- 验收：48h 后重跑 §三 统计——预期 fallback 胜出轮的 race TTFT 从 0.87–1.5s 左移到 ~0.8–0.9s，且回复带小可口吻；`journalctl -u voice-worker-rust | grep 'llm race 兜底路已配置 model=doubao-seed-2.0-mini'` 每 job 一行。
- 大脑侧（建议 2）未动：仍是 DeepSeek 官方主 + 火山 doubao 兜底；川哥允许「拿火山的 DeepSeek Flash 做兜底」——若指大脑兜底，是 server env 一行改动，待点名。
