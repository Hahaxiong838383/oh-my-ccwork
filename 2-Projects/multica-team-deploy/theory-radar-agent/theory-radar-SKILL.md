---
name: theory-radar
description: AI 前沿理论雷达日报端到端自动化。一个 issue 内完成:抓取 arXiv 近3天论文 → 精选论文深度分析 → 发川哥飞书 → 同步个人站。不派子 issue。脑科学×LLM / 认知科学×AI / LLM机制 / Agent 治理。
---

# AI 理论雷达日报自动化（端到端单 agent）

你负责生成当天 AI 前沿理论雷达日报，发送到川哥飞书，并把同一批内容同步到个人站。**一个 issue 内端到端完成全部步骤，不要派子 issue、不要等其他 agent。** 全程中文。

## Prompt Shard Kernel（时效 + 工具证据吸收版）

本 skill 继承 multica `current-info` + `tool-source-of-truth` + `file-output`:

- **实时源优先**: 今日论文必须以当前 arXiv 抓取 JSON 为准,不能靠训练记忆编论文。
- **失败透明**: 抓取失败、JSON 为空、飞书发送失败都要如实 comment,不要补写虚构论文或虚构 message_id。
- **证据收尾**: 完成必须记录 3 个真实 `message_id` + 1 个个人站 webhook 成功响应;缺任一项就不能报全成功。
- **范围固定**: 本 skill 的 O2 已完整,不要派子 issue,不要临时加 wiki/表格/归档动作;个人站同步是本 skill 的固定步骤,不是额外扩展。
- **版权克制**: 只摘要论文标题/摘要含义,不复制长段原文。

## 步骤 1：抓取 arXiv 论文

arXiv 是境外站，**必须带 proxy**（NO_PROXY 保证本地服务直连）：

```bash
export HTTPS_PROXY=http://127.0.0.1:10808 HTTP_PROXY=http://127.0.0.1:10808 NO_PROXY=localhost,127.0.0.1
python3 ~/theory-radar/arxiv-theory-radar.py
```

输出 `/tmp/theory-radar-data.json`（近3天论文，含 sections / 各篇 title/abstract/arxiv_id/categories）。先 `cat /tmp/theory-radar-data.json | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['date'],d['total'])"` 确认抓到。

## 步骤 2：精选论文 + 深度分析

读 JSON，从所有 sections 合并去重，优先选最相关的 8 篇；若当天论文不足 8 篇，按实际数量输出，但不少于 4 篇。**选篇优先级**：
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

同时把同一批分析保存为结构化 JSON，供个人站 webhook 使用。**不得为个人站重新选择论文或重新生成一套不同分析**。

文件：`/tmp/theory-radar-site-report.json`

Schema:
```json
{
  "date": "YYYY-MM-DD",
  "summary": "一句话今日趋势综述，中文，80字以内",
  "generatedAt": "YYYY-MM-DDTHH:mm:ss+08:00",
  "papers": [
    {
      "index": 1,
      "title": "中文精简标题",
      "arxivId": "2606.xxxxx",
      "url": "https://arxiv.org/abs/2606.xxxxx",
      "published": "从 /tmp/theory-radar-data.json 回填原始 published",
      "category": "主分类",
      "score": 80,
      "finding": "与飞书一致的核心发现",
      "llmLink": "与飞书一致的 LLM 连接",
      "insight": "与飞书一致的研究启示"
    }
  ]
}
```

生成后先校验：
```bash
python3 - <<'PY'
import json
p='/tmp/theory-radar-site-report.json'
d=json.load(open(p))
assert d.get('date') and d.get('generatedAt')
assert isinstance(d.get('papers'), list) and 4 <= len(d['papers']) <= 8
for i, paper in enumerate(d['papers'], 1):
    assert paper.get('index') == i
    assert paper.get('arxivId') and paper.get('url', '').startswith('https://arxiv.org/abs/')
    assert paper.get('finding') and paper.get('llmLink') and paper.get('insight')
print('site report ok', d['date'], len(d['papers']))
PY
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

每条返回 `{"ok":true,"data":{"message_id":"om_..."}}` 即成功。3 条都拿到 message_id 才算飞书发送完成。**飞书消息不要加署名/发送方标识行**，消息 3 放剩余论文 + 今日总结；若当天只有 6 篇，消息 3 只放今日总结即可。

## 步骤 4：同步个人站（同源内容）

个人站 webhook 已部署：

- URL: `https://my.chenchuan.cc/api/radar-webhook`
- 鉴权: `Authorization: Bearer $RADAR_WEBHOOK_TOKEN`
- body: `/tmp/theory-radar-site-report.json`

secret 只在 mini 本地 `~/.theory-radar-push.env`，**禁止 echo token，禁止写入 issue comment，禁止写入 git**。

webhook 必须直连并带浏览器 UA，避免 xray/境外出口导致 403：

```bash
set -a
. "$HOME/.theory-radar-push.env"
set +a
python3 - <<'PY'
import json, os, sys, urllib.request

url = os.environ.get('RADAR_WEBHOOK_URL', 'https://my.chenchuan.cc/api/radar-webhook')
token = os.environ.get('RADAR_WEBHOOK_TOKEN')
if not token:
    raise SystemExit('missing RADAR_WEBHOOK_TOKEN')

body = open('/tmp/theory-radar-site-report.json', 'rb').read()
req = urllib.request.Request(
    url,
    data=body,
    headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    method='POST',
)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open(req, timeout=60) as r:
    text = r.read().decode()
    print(text)
    data = json.loads(text)
    if not data.get('ok'):
        raise SystemExit('webhook not ok: ' + text)
PY
```

拿到 `{"ok":true,...}` 才算个人站同步完成。若个人站同步失败：不要重发已成功的飞书消息；comment 里记录“飞书成功、个人站失败”的真实状态和错误摘要，状态不要报全成功。

## 铁律汇总

1. **一个 issue 内端到端**：抓取→分析→发送飞书→同步个人站，不派子 issue、不等其他 agent、不 block 要 O2（本 skill 已含全部 O2）
2. **抓取必带 HTTPS_PROXY**（arxiv 境外）
3. **open_id 走 sidecar /status，禁手敲**
4. **全中文**，5 段式格式；优先最多 8 篇，实际不足 8 篇时至少 4 篇即可完成
5. 完成后 issue comment 记录 3 个 message_id + 个人站 webhook ok 响应摘要 + 状态置 in_review
6. 若某步失败：抓取失败→重试1次带 proxy；飞书 bound:false→报 token 失效让川哥重新授权；不要伪造 message_id

## ★ 收尾铁律（防超时 + 防重复，FUT-83 教训）

7. **每条消息只发一次**：`05_agent_spawn.sh` 返回 `ok:true` + message_id 即成功，**立即发下一条，绝不重发已成功的**。只有返回 ok:false 才重试该条（max 1 次）。
8. **同步完即停**：3 条消息 + 个人站 webhook ok + 1 条 comment(记 message_id 和 webhook ok 摘要) 完成后，**立即把 issue 置 in_review 并结束任务**。**禁止**任何额外动作：不归档 wiki、不写多维表、不反复读取检查、不再生成内容。任务到此为止。
9. **效率优先**：精选论文分析 + 发 3 条 + 推个人站应在 10 分钟内完成，不要逐篇反复打磨。
10. **不加署名**：飞书 3 条消息都不要加“署名/发送方/Agent 小组”之类的末尾标识行。
