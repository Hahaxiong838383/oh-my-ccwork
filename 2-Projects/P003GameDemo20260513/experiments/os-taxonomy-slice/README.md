# os-taxonomy 切片管线（L_companion 数据生产线）

> 2026-07-13 一天内从评估到双链路上线的完整管线归档。产物消费方：`apps/server/assets/companion-kg/`。
> 上游、许可、运行时架构见 [assets/companion-kg/SOURCE.md](../../apps/server/assets/companion-kg/SOURCE.md)。

## 复现/扩展场景速查

| 场景 | 跑什么 |
|---|---|
| 上游更新/扩切片（改年龄或学科规则） | `scripts/extract-slice.mjs`（规则在文件头）→ 翻译 → 质检 → 向量 |
| 翻译新增主题 | `scripts/build-batches.mjs` → `scripts/run-translate.sh topics`（grok-4.5，断点续跑）→ `run-translate.sh reasons` |
| 质检 | `scripts/run-qc.mjs`（codex 网关降级链）→ `scripts/apply-fixes.mjs` → `scripts/merge-validate.mjs`（含触发词冲突分析） |
| **换 embedding 模型（必做）** | `scripts/precompute-embeddings.mjs` 重算全量主题向量（query/passage 必须同模型铁律） |
| 召回/误报回归 | `scripts/eval-match.mjs`（L1 子串基线）+ `scripts/eval-hybrid.mjs`（语义+重排混检扫阈值）；holdout 集 `testset/holdout.json` |
| 人工抽检包 | `scripts/sample-review.mjs`（固定种子可复现） |

env 依赖：`SILICONFLOW_API_KEY`（本机在 `~/.mycc-secrets.env`）；翻译/质检走 omp（xai-oauth/grok-4.5、codex-api2 链）。

## 关键结论存档（详见 memory `kid-speech-semantic-over-substring`）

- 子串触发词召回天花板 28%（三轮迭代实证），bge 语义 top3=78%/top5=94% → 架构=语义 top3 + **先**触发词重排(+0.05)**后**阈值门(0.47) + 多候选交主 LLM 消歧
- 测试集：正样本 grok 只见英文原文防近亲繁殖；负样本 hard/gray 分级（产品合理触发≠误报）；E2E 话语必须取自已验证存在的数据
- LLM 批处理回传用 idx 序号不用 id（`mt__` 双下划线被 normalize，确定性错误）
- 上游 v1 有 11 条 evidence 是文献引用占位（Learning to Learn/元认知类），codex 已按行为句式重写

## 目录

- `scripts/` 全管线脚本（提取/切批/翻译/质检/修复/合并校验/向量/评估/抽检/E2E）
- `prompts/` 翻译、质检、触发词扩充、话语生成四套 prompt 模板
- `testset/` 首轮 100 正样本 + holdout 50 + 负样本 49（hard/gray 标注）
- `slice-en.json` 英文切片源；`qc-report.json` 质检 97 处问题清单；`eval-*.json` 评估明细；`sample-review-30.md` 川哥终审抽检包
- 未归档：`batches-raw/`（LLM 原始输出，仅调试值）、`topics-embeddings.json`（产物在 assets 侧）
