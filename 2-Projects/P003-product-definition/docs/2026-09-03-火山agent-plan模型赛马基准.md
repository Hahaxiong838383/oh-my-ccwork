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
- **fallback 的 system prompt 是空的**（`AGENT_INSTRUCTIONS=` 空）：兜底胜出的 27 轮孩子听到的是没有小可人设、没有记忆的通用回复。这是比速度更先该修的事。

## 四、能不能用作赛马机制——结论

1. **可以，但只有 doubao 四个能进候选**；glm/kimi 关不掉思考、kimi-k3 排队，deepseek/minimax 有 6–7s 长尾（兜底路最忌长尾）。
2. **推荐兜底 = doubao-seed-2.0-mini**（生产长度提示下 ~520ms、三次波动 340ms），预期把 fallback 胜出轮的出声时刻从 0.9–1.5s 压到 ~0.8–0.9s（受 grace 800 下限约束），只影响约 7.5% 的慢轮；lite 保留为回滚锚。evolving 因滚动升级不进生产。
3. **先做两件前置再换**：①给 fallback 一段精简人设（≤400 字，含 `[[DEV:N]]` 协议与两句话限制），并按长提示复测；②在火山控制台拿到 agent plan 的 RPM/TPM/月额度，估算「每轮双发」的消耗；额度不够就不换 key，继续用 coding plan。
4. 换法（都是 env）：`LLM_FALLBACK_BASE_URL=…/api/plan/v3`、`LLM_FALLBACK_MODEL=doubao-seed-2.0-mini`、`LLM_FALLBACK_API_KEY`（新 key）、`AGENT_INSTRUCTIONS`（精简人设）→ 纪律重启；验收=48h 后重跑本文 §三 的统计，看 fallback 胜出轮的 race TTFT 分布左移、且回复带人设。
5. 可选：把 grace 从 800 降到 ~600 只在换了更快兜底之后再试，先看 main 的 p50（799）——grace 低于 main 中位会让一半轮次被兜底抢走，人设与记忆就丢了。

## 五、复现

基准脚本在 cc 会话 scratchpad（`ark_bench.py` / `ark_bench_long.py`，urllib 流式，key 从 `ARK_KEY` 环境读，不落盘）；64.90 上已有 `scripts/bench_race_pair.py` 可做主路/兜底成对基准。
