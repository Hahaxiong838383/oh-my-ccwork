# K12-KGraph 数据来源与许可

- **数据集**：K12-KGraph（Curriculum-Aligned Knowledge Graph）
- **来源**：https://huggingface.co/datasets/lhpku20010120/K12-KGraph
- **论文**：arXiv 2605.09635（2026-05）
- **License**：⚠️ **CC-BY-NC-SA-4.0（非商业 + 相同方式共享）**
- 🔴 **仅用于 demo 内测 / 研究。正式商用前必须更换可授权源**（国家中小学智慧教育平台官方教材 / 自建 KG / 采购可商用内容）。

## 内容
- 人教版数理化生（**仅 STEM**，无语文 / 英语），小学到高中。
- 10685 节点（Concept/Skill/Experiment/Exercise/Section/Chapter/Book）/ 23278 边（含 prerequisites_for 先修关系）。
- 本目录仅含 `nodes.json` + `edges.json`（KG 本体，用于运行时先修护栏注入）。
- **不含** K12-Bench / K12-Train（评测 / 训练数据）——离线验证见 `experiments/kg-value-verify/`。

## 用途（docs/20）
小可 L_curriculum 课程护栏：孩子聊到 STEM 概念时，注入其先修关系，引导小可「不越级 / 不乱讲教学顺序」，而非补充模型知识（验证证明价值在先修结构，见 docs/19）。
