# KnowMe / KnowMeBench / H2HTalk / BFI-Adapt（Explore 回执要点）
## KnowMe（AIPMAndy）
- 证据=截断原话 excerpt（消息去空白前 180 字），非 span 非计数；每次打分强制附 {signal,excerpt}（scripts/analyze.py:51,173-178），结构上不可能只存分数不存原话；每维去重留 5 条，报告印 3 条（:190-198,374-379）。
- 置信度=比例边际 diff>30 high/>15 medium/else low（:219-223）；**小样本降级独立一层**：n<20 直接 low，n<50 high→medium（:200-205）；总分 ≥2 low→low、≥3 high→high（:239-245）。
- 说话人：mark_subject 只标一个人（collect.py:331-341），归一 casefold；纯正则打分无 LLM（analyze.py:70-158）；离线文件进出零网络（README.md:224）。
- 用户否决/编辑：仓库里没有（只能改 --target 重跑，:454-459）。
## KnowMeBench（QuantaAlpha）
- ⚠️ 四套 rubric 全部「Ignore Citation Tags」，引用不加不减分（evaluate/evaluate prompt.md:19,86,131,193）；grounding 只是负向兜底：编造事件/人物判 1 分（:53-56,160-163,218-220）+ Adversarial Abstention 奖励拒答假前提（readme.md:52,107-110）。
- 计分 GPT-4o judge temp=0 强制 JSON，从 5 分往下扣（run_eval.py:11,85-96; prompt.md:23-26）；数据 record{id,timestamp,location,action,dialogue,environment,background,inner_thought}，D1=6644 条，2580 query/4.7M token（readme.md:37）。
- 可复用：task_type→rubric 路由 + 扣分制 + {score,reasoning}（run_eval.py:20-58）；**查不了「指回原话」，那部分得自建**。
## H2HTalk（LolerPanda）
- SAP/安全依恋规则文本：仓库里没有（全仓仅 README.md:10 一处提及）。实际人设=恋爱男友（persona.txt:4-5,67 占有欲；chat_psy.txt:2 female user, :22,27 拥抱亲吻）；chat_routine.txt:16-18 示例=赌气/翻旧账/「陪我吃饭我就原谅你」（缠人+惩罚教科书）。
- 场景 3 族 11 档（dialogue/itinerary/recollection）；README 称 4650 实发 4589；指标只有 BLEU/ROUGE/BERTScore/embedding（evaluate/evaluator.py:31-39），无安全/温度指标；jsonl 每条只有 response 无输入无期望→不能当回归集。
## BFI-Adapt（sci-m-wang）
- 协议：11 事件×BFI-44 前后测，100 personas×9 次=900 对/格，池化 48400（kappa_dcr_analysis.py:16,28）；EXPECTED_CHANGES event→trait +/−/?（:96-108），? 格跳过剩 27 格。
- 指标：κ_pool 只测可复现不含方向（:16-18）；DCR=max(n↑,n↓)/(n↑+n↓)（:262-286）；Adapt_v2=mean(κ·S·1_dir)，S=2·DCR−1，方向不符或打平=0（:38,454-462）——「跳动≠成长」就是这个方向闸门；噪声地板 ε=0.1 存在率（rq_stats.py:86,386）；σ 坍缩检测（rq_stats.py:14-19,317）。
- 「变了但不像人」的数字：仓库里没有（README.md:5 不含结果；只有人类基准包络 d≈0.05–0.25、σ≈0.5–0.8）。
## 便宜移植 Node/TS
- dcr()（:262-286）、1_dir 闸门+Adapt_v2（:450-479）、噪声地板（rq_stats.py:386）、sample_adjusted_confidence（analyze.py:200-223）、mark_subject（collect.py:331-341）、rubric 路由+JSON judge（run_eval.py:20-114）；H2HTalk 全部指标不划算（torch）。
## 可借 / 不要学（agent 结论）
- 借：evidence 从可选字段改成构造函数必填；小样本降级独立于分数边际（按独立提及轮数）；1_dir 方向闸门给 growth_event 预设期望方向；噪声地板卡在 EMA 更新前；扣分制 rubric 做风格模板回归（短而准满分）。
- 不学：KnowMeBench 的 Ignore Citation；H2HTalk 关系模板；KnowMe 只读不可改闭环（家长须可单条否决留痕）。
