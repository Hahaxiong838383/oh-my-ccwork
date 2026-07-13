# 任务：儿童教育知识点中文化（面向 5-8 岁中国孩子的 AI 语音陪伴产品）

你是资深儿童教育内容本地化专家。把下面的英文「微知识点」翻译成中文，供一个面向 5-8 岁中国孩子的 AI 语音伙伴使用。

## 翻译规范（逐条遵守）

1. **name**：简短中文概念名，2-10 字，孩子家长都能一眼看懂。不要直译腔（"Buyers & Sellers" → "买家和卖家"，不是"购买者与销售者"）。
2. **description**：通顺中文，保留原文全部信息点，供 AI 理解知识点内涵。不加不减内容。
3. **evidence**：逐条翻译，保持"能够……"的可观察行为句式，条数与原文一致。
4. **assessmentPrompt**：翻成自然的中文提问（问家长"孩子能不能……"的口吻）。**必须原样保留 `{{name}}` 占位符**，它代表孩子的名字。
5. **triggers**（新增字段，最重要）：为每个知识点生成 **3-8 个中文口语触发词/短语**——5-8 岁中国孩子在日常聊天里谈到这个话题时**真的会说出口的词**，用于文本匹配。规则：
   - 每个触发词 2-6 个字，是孩子口语，不是学术词（"光合作用"孩子不会说，但"叶子为什么是绿的"里的"叶子"会说）
   - 禁止过泛的词（"东西""喜欢""什么"这类高频词会到处误命中）
   - 概念名本身如果孩子可能说出口，也放进 triggers
   - 宁少勿滥：拿不准的词不要放
6. **文化本地化**：例子里的 school fair/biscuits 等可换成中国孩子熟悉的等价物（义卖会/饼干），但知识内涵不变。
7. **禁止**：翻译腔、学术腔、增删知识内容、改动 id。

## 输出格式

只输出一个 JSON 数组，包在 ```json 代码块里，每个元素：

```
{ "id": "原样照抄", "name": "…", "description": "…", "evidence": ["…"], "assessmentPrompt": "…", "triggers": ["…"] }
```

不要输出任何解释文字。数组元素数量、顺序、id 必须与输入完全一致。

## 高质量示例（严格对标这个水准）

输入：
```json
{ "id": "mt_XX1", "subject": "Life Skills", "domain": "Economic Awareness", "ageRange": "5-7",
  "name": "Buyers & Sellers",
  "description": "When someone makes or has something, they can sell it; when someone wants something, they can buy it; introduction to the concept of exchange and transactions",
  "evidence": ["Explain what a buyer does and what a seller does", "Act out a simple buying and selling transaction with a partner"],
  "assessmentPrompt": "If {{name}} set up a stall at a school fair, could they explain who the buyers and sellers are and what each person does?" }
```

输出：
```json
[{ "id": "mt_XX1", "name": "买家和卖家",
  "description": "一个人做出来或者拥有某样东西，就可以把它卖出去；一个人想要某样东西，就可以买下来。这是对交换和交易概念的初步认识。",
  "evidence": ["能够说出买家做什么、卖家做什么", "能够和小伙伴演一演简单的买卖过程"],
  "assessmentPrompt": "如果{{name}}在义卖会上摆个小摊，他/她能说清楚谁是买家、谁是卖家、各自在做什么吗？",
  "triggers": ["买东西", "卖东西", "摆摊", "开店", "零花钱", "做生意", "义卖"] }]
```

再看一个科学类示例：

输入：
```json
{ "id": "mt_XX2", "subject": "Science", "domain": "Light & Sound", "ageRange": "5-7",
  "name": "Sources of light",
  "description": "Some objects make their own light (sun, flames, torches); we see them because the light travels to our eyes; darkness is the absence of light",
  "evidence": ["Sort pictures into things that make light and things that don't", "Explain that darkness means there is no light"],
  "assessmentPrompt": "Could {{name}} name three things that make their own light, and explain why a room goes dark when you switch the light off?" }
```

输出：
```json
[{ "id": "mt_XX2", "name": "会发光的东西",
  "description": "有些东西自己会发光（太阳、火焰、手电筒），光跑到我们的眼睛里，我们才看得见它们；黑暗就是没有光。",
  "evidence": ["能够把图片分成'自己会发光的'和'不会发光的'两类", "能够说出黑暗就是没有光"],
  "assessmentPrompt": "{{name}}能说出三样自己会发光的东西吗？能解释为什么关了灯房间就变黑吗？",
  "triggers": ["发光", "太阳", "手电筒", "天黑", "黑暗", "关灯", "为什么看得见"] }]
```

## 待翻译数据

{{BATCH_JSON}}
