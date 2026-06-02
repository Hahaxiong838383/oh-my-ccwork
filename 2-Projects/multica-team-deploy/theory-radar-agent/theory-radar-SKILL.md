---
name: theory-radar
description: AI 前沿理论雷达日报端到端自动化。一个 issue 内完成:抓取 arXiv 近3天论文 → 选8篇深度分析 → 发川哥飞书。不派子 issue。脑科学×LLM / 认知科学×AI / LLM机制 / Agent 治理。
---

# AI 理论雷达日报自动化（端到端单 agent）

你负责生成当天 AI 前沿理论雷达日报并发送到川哥飞书。**一个 issue 内端到端完成全部三步，不要派子 issue、不要等其他 agent。** 全程中文。

## 步骤 1：抓取 arXiv 论文

arXiv 是境外站，**必须带 proxy**（NO_PROXY 保证本地服务直连）：

```bash
export HTTPS_PROXY=http://127.0.0.1:10808 HTTP_PROXY=http://127.0.0.1:10808 NO_PROXY=localhost,127.0.0.1
python3 ~/theory-radar/arxiv-theory-radar.py
```

输出 `/tmp/theory-radar-data.json`（近3天论文，含 sections / 各篇 title/abstract/arxiv_id/categories）。先 `cat /tmp/theory-radar-data.json | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['date'],d['total'])"` 确认抓到。

## 步骤 2：选 8 篇 + 深度分析

读 JSON，从所有 sections 合并去重，选最相关 8 篇。**选篇优先级**：
1. 直接研究 LLM 内部机制 × 认知/神经科学对应
2. 新认知计算模型可迁移 AI
3. 脑神经实验对 attention/memory/reasoning 有启发
4. Agent 评测/治理/行为

每篇 **5 段式中文**（专有名词保留英文）：
```
【N】中文精简标题（≤20字）
📍 arxiv.org/abs/XXXXX | 分类
🔬 核心发现：[2-3句论文核心结论]
🔗 与LLM连接：[1-2句如何映射到大模型机制/AI设计]
💡 研究启示：[1-2句对认知AI/类脑计算价值]
```

## 步骤 3：发川哥飞书（3 条防截断）

**收件人 = 川哥**，multica user id 固定：`ece30832-3b2c-49b6-985c-c9254cd3f108`

**铁律（违反 = 事故）**：open_id **只能**从 sidecar /status 取，**禁止手敲任何 ou_/UUID**（LLM 复制长 hex 易出 c→f 一字之差，飞书 API 不验存在性会送错人）。

```bash
MUID=ece30832-3b2c-49b6-985c-c9254cd3f108
OPEN=$(curl -sS "http://127.0.0.1:18090/api/feishu/device/status?multica_user_id=$MUID" | python3 -c "import sys,json;print(json.load(sys.stdin)['lark_user_open_id'])")
# 把 3 条消息分别写文件（避免 shell 引号问题），再逐条发
# 消息1: 标题卡 + 第1-3篇; 消息2: 第4-6篇; 消息3: 第7-8篇 + 今日总结
cat > /tmp/tr1.txt << 'MSGEOF'
━━━━━━━━━━━━━━━━
🧬 AI前沿理论雷达
📅 MM月DD日 | 共 8 篇精选
🔬 脑科学 · 认知科学 · LLM理论
━━━━━━━━━━━━━━━━

【1】... (5段式)
【2】...
【3】...
MSGEOF
# 同理 /tmp/tr2.txt(4-6篇) /tmp/tr3.txt(7-8篇+总结)
for f in 1 2 3; do
  bash ~/lark_multi_user/05_agent_spawn.sh "$MUID" im +messages-send --user-id "$OPEN" --text "$(cat /tmp/tr$f.txt)"
  sleep 2
done
```

每条返回 `{"ok":true,"data":{"message_id":"om_..."}}` 即成功。3 条都拿到 message_id 才算完成。

## 铁律汇总

1. **一个 issue 内端到端**：抓取→分析→发送，不派子 issue、不等其他 agent、不 block 要 O2（本 skill 已含全部 O2）
2. **抓取必带 HTTPS_PROXY**（arxiv 境外）
3. **open_id 走 sidecar /status，禁手敲**
4. **全中文**，5 段式格式
5. 完成后 issue comment 记录 3 个 message_id + 状态置 in_review
6. 若某步失败：抓取失败→重试1次带 proxy；飞书 bound:false→报 token 失效让川哥重新授权；不要伪造 message_id

## ★ 收尾铁律（防超时 + 防重复，FUT-83 教训）

7. **每条消息只发一次**：`05_agent_spawn.sh` 返回 `ok:true` + message_id 即成功，**立即发下一条，绝不重发已成功的**。只有返回 ok:false 才重试该条（max 1 次）。
8. **发完即停**：3 条消息 + 1 条 comment(记 message_id) 完成后，**立即把 issue 置 in_review 并结束任务**。**禁止**任何额外动作：不归档 wiki、不写多维表、不反复读取检查、不再生成内容。任务到此为止。
9. **效率优先**：分析 8 篇 + 发 3 条应在 10 分钟内完成，不要逐篇反复打磨。
