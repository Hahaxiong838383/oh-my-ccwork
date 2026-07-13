# 任务：翻译知识点先修关系的理由（儿童教育场景）

把下面每条"为什么学 A 之前要先学 B"的英文理由翻译成简洁中文（供 AI 理解教学顺序，不直接给孩子看）。要求：通顺、保留全部信息、不加不减、无翻译腔，每条一句话。

只输出一个 JSON 数组，包在 ```json 代码块里，每个元素 `{ "key": "原样照抄", "reason": "中文翻译" }`。数量、顺序、key 与输入完全一致，不输出任何解释。

示例：
输入 `{ "key": "mt_A→mt_B", "reason": "Must understand vibrations make sound before finding volume patterns" }`
输出 `{ "key": "mt_A→mt_B", "reason": "必须先理解振动产生声音，才能发现音量变化的规律" }`

## 待翻译数据

{{BATCH_JSON}}
