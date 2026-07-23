---
name: theory-radar
description: AI 前沿理论雷达飞书日报。读取韩国正式产线已经发布的同日报告，验证后分 3 条发送给川哥；禁止再次抓取 arXiv 或重复写入个人站。
---

# AI 理论雷达飞书日报（正式报告消费端）

你只负责把韩国正式产线已经生成并发布的 Theory Radar 报告发送到川哥飞书。**韩国产线是唯一数据生产者；本任务是只读消费端。** 一个 issue 内完成，不派子 issue，全程中文。

## 单一真源

- 正式报告接口：`https://my.chenchuan.cc/api/radar/report?date=YYYY-MM-DD`
- 正式生产链：韩国 `arXiv RSS + OpenAlex + Grok 4.5 + 个人站发布`
- 本任务**禁止**运行 `~/theory-radar/arxiv-theory-radar.py`，禁止访问 arXiv Query API，禁止重新分析、改写或重新选择论文。
- 本任务**禁止**调用个人站 webhook；正式报告已经发布，再调用会造成重复生产和覆盖。

## 步骤 1：等待并读取当天正式报告

当天日期必须按上海时区计算。最多等待 5 分钟，避免 09:10 调度时韩国任务偶发仍在收尾；每 30 秒重试一次。404 只代表报告尚未就绪，不代表今日没有论文。

```bash
REPORT_DATE=$(TZ=Asia/Shanghai date +%F)
REPORT_URL="https://my.chenchuan.cc/api/radar/report?date=$REPORT_DATE"

ok=0
for attempt in $(seq 1 10); do
  if curl -fsS --connect-timeout 10 --max-time 30 \
    -H 'Cache-Control: no-cache' "$REPORT_URL" \
    -o /tmp/theory-radar-official.json; then
    if REPORT_DATE="$REPORT_DATE" python3 - <<'PY'
import json
import os

data = json.load(open('/tmp/theory-radar-official.json'))
report = data.get('report') if data.get('ok') else None
assert isinstance(report, dict)
assert report.get('date') == os.environ['REPORT_DATE']
papers = report.get('papers')
assert isinstance(papers, list) and 4 <= len(papers) <= 8
for index, paper in enumerate(papers, 1):
    assert paper.get('index') == index
    assert paper.get('title') and paper.get('url', '').startswith('https://arxiv.org/abs/')
    assert paper.get('finding') and paper.get('llmLink') and paper.get('insight')
print('official report ok', report['date'], len(papers), report.get('generatedAt'))
PY
    then
      ok=1
      break
    fi
  fi
  sleep 30
done

test "$ok" = 1
```

如果 10 次后仍未取得合法报告：在 issue comment 记录 HTTP 状态、重试次数和“正式报告尚未就绪”，将 issue 置 `blocked` 并结束。**不得改用旧 arXiv 脚本，也不得发送“今日 total=0”之类未经正式产线证实的结论。**

## 步骤 2：按正式报告生成 3 条消息

只做格式化，不让模型重新总结。飞书内容必须逐字来自接口的 `summary` 和 `papers[*]` 字段。

```bash
python3 - <<'PY'
import json
from pathlib import Path

payload = json.load(open('/tmp/theory-radar-official.json'))
report = payload['report']
papers = report['papers']
month_day = report['date'][5:].replace('-', '月') + '日'

def render(paper):
    return '\n'.join([
        f"【{paper['index']}】{paper['title']}",
        f"📍 {paper['url']} | 分类：{paper.get('category') or '未分类'}",
        f"🔬 核心发现：{paper['finding']}",
        f"🔗 与LLM的连接：{paper['llmLink']}",
        f"💡 研究启示：{paper['insight']}",
    ])

groups = (papers[:3], papers[3:6], papers[6:])
messages = []
messages.append('\n'.join([
    '━━━━━━━━━━━━━━━━',
    '🧬 AI前沿理论雷达',
    f"📅 {month_day} | 共 {len(papers)} 篇精选",
    '🔬 脑科学 · 认知科学 · LLM理论',
    '━━━━━━━━━━━━━━━━',
    '',
    '\n\n'.join(render(paper) for paper in groups[0]),
]))
messages.append('\n\n'.join(render(paper) for paper in groups[1]))
tail = '\n\n'.join(render(paper) for paper in groups[2])
messages.append('\n'.join([
    tail,
    '',
    '━━━━━━━━━━━━━━━━',
    f"📊 今日总结：{report.get('summary') or '详见以上论文拆解'}",
    '🌐 完整报告：https://my.chenchuan.cc/radar',
    '━━━━━━━━━━━━━━━━',
]).strip())

for index, message in enumerate(messages, 1):
    assert message.strip()
    Path(f'/tmp/tr{index}.txt').write_text(message, encoding='utf-8')
    print(f'message {index}: {len(message)} chars')
PY
```

## 步骤 3：验证飞书授权并发送

收件人是川哥，Multica user id 固定为 `ece30832-3b2c-49b6-985c-c9254cd3f108`。

open_id **只能**从 sidecar `/status` 实时读取，禁止手敲。`token_status=valid` 和 `token_status=needs_refresh` 都是可用状态；sidecar 会自动静默刷新。只有 `bound=false`、open_id 为空，或真实发送接口返回授权失效，才可以要求川哥重新授权。

```bash
MUID=ece30832-3b2c-49b6-985c-c9254cd3f108
curl -fsS "http://127.0.0.1:18090/api/feishu/device/status?multica_user_id=$MUID" \
  -o /tmp/theory-radar-feishu-status.json

OPEN=$(python3 - <<'PY'
import json

status = json.load(open('/tmp/theory-radar-feishu-status.json'))
assert status.get('bound') is True, 'feishu not bound'
assert status.get('token_status') in {'valid', 'needs_refresh'}, 'feishu token unusable'
open_id = status.get('lark_user_open_id')
assert isinstance(open_id, str) and open_id.startswith('ou_'), 'missing open_id'
print(open_id)
PY
)
```

逐条发送并保存原始响应。已经成功的消息绝不重发；只有 `ok:false` 的当前消息允许重试 1 次。

```bash
for index in 1 2 3; do
  bash ~/lark_multi_user/05_agent_spawn.sh "$MUID" \
    im +messages-send --user-id "$OPEN" --text "$(cat /tmp/tr$index.txt)" \
    | tee "/tmp/tr$index-response.json"
  sleep 2
done

python3 - <<'PY'
import json

ids = []
for index in range(1, 4):
    response = json.load(open(f'/tmp/tr{index}-response.json'))
    assert response.get('ok') is True, response
    message_id = (response.get('data') or {}).get('message_id')
    assert isinstance(message_id, str) and message_id.startswith('om_'), response
    ids.append(message_id)
print('\n'.join(ids))
PY
```

## 步骤 4：验收与收尾

1. `curl -fsS -o /dev/null -w '%{http_code}' https://my.chenchuan.cc/radar` 必须返回 `200`。
2. issue comment 记录：正式报告日期、论文数、接口验证成功、3 个真实 `message_id`、`token_status`、`/radar=200`。
3. 将 issue 置 `in_review`，立即结束任务。

## 铁律

1. 韩国正式报告是唯一真源；Mini 不再抓 arXiv、不再分析、不再写个人站。
2. 404 时等待重试，不能把“尚未就绪”写成“今日无论文”。
3. `needs_refresh` 不是授权失效；先依赖 sidecar 自动刷新和真实发送结果。
4. 不虚构论文、报告、message_id、webhook 状态或授权状态。
5. 每条消息只发一次；成功后禁止重发。
6. 不输出 secret，不在 comment 中记录 token、完整 sidecar 响应或用户隐私数据。
