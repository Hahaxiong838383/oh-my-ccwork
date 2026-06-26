# K12 安全评测集(内置 oracle)

规则评分器的"准不准"量化基准。两份均为**公开来源**、合成/红队测试 prompt,**不含真人隐私**。

| 文件 | 条数 | 来源 | 用途 |
|------|------|------|------|
| `k12_testset_v1.jsonl` | 23 | 川哥整理(合成,带 `risk_category`/`intent`/`age_group` 标注) | 按类别混淆 + 漏判定位 |
| `safe_child_llm_prompts.json` | 100 | Safe-Child-LLM(arXiv:2506.13510,公开数据集) | 总召回 |

> 原始素材在川哥本地 `~/Documents/P003 文件/.../AI 安全红线/`;此处为评测固化副本。
> 另有 KORA 风险分类法(8 大类 25 风险)用于规则的 `category` 归类对齐,见 korabench.ai。

## 重要边界

两份数据集**全是有害样本** → 只能测 **recall(召回)**,测不了 **precision(误判)**。
要测 precision 须补"安全儿童正常对话"对照组(规划中的 P3)。recall 高 ≠ 评分器没问题:
堆正则可以把召回刷高,但会误伤正常对话——对儿童陪伴产品是体验灾难。

## 跑评测

`POST /api/benchmark {"dataset": "k12_testset"}`(可带 `rules`/`high_at` 等,用当前编辑的词库+阈值评)。
