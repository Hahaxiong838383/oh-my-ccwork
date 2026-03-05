---
name: gold-analysis
description: 黄金走势分析 - 每4小时获取实时金价，分析涨跌趋势，发飞书通知。触发词："/gold"、"黄金分析"、"金价走势"
---

# 黄金走势分析

## 执行流程

### Step 1: 获取价格数据

```bash
python3 .claude/skills/gold-analysis/scripts/gold-analysis.py
```

输出 JSON 包含：
- `current_usd`: 当前金价（美元/盎司）
- `current_cny`: 当前金价（人民币/盎司）
- `changes`: 各时间段涨跌幅（4h/1d/3d/7d）
- `signal`: 操作信号（观望/关注买点/谨慎追多）
- `reason`: 分析理由列表

### Step 2: 组织分析报告

根据 JSON 数据，结合以下维度分析：
1. **价格位置**：当前价格在近期区间的位置
2. **动量**：4h/1d 涨跌方向是否一致
3. **节奏**：与 7d 趋势的背离或延续
4. **建议**：简洁的操作方向（持有/等回调/减仓等）

### Step 3: 发飞书通知

使用 send.js 发送，格式如下（卡片分区版）：

标题：`黄金走势 MM-DD HH:MM`

内容模板（用 \n 换行）：
```
━━━━━━━━━━━━━━━━
💰 ¥X,XXX.XX /克   $X,XXX /盎司

📈 涨跌幅
  4小时   X.XX%
  今日    X.XX%
  本周    X.XX%

🎯 操作信号：[emoji] [信号文字]
  [分析要点1]
  [分析要点2]
━━━━━━━━━━━━━━━━
⚠️ 非投资建议
```

调用命令：
```bash
node /Users/rayman.chen/mycc/.claude/skills/tell-me/send.js \
  "黄金走势 MM-DD HH:MM" \
  "━━━━━━━━━━━━━━━━\n💰 ¥X,XXX.XX /克   \$X,XXX /盎司\n\n📈 涨跌幅\n  4小时   X.XX%\n  今日    X.XX%\n  本周    X.XX%\n\n🎯 操作信号：[emoji] [信号]\n  [要点1]\n  [要点2]\n━━━━━━━━━━━━━━━━\n⚠️ 非投资建议" \
  blue
```

## 数据说明

| 数据源 | 更新频率 | 覆盖时段 | 角色 |
|--------|---------|---------|------|
| goldprice.org | 分钟级实时 | 24/7 | 主源 |
| fawazahmed0 currency API | 每日一次 | 全天 | 兜底 |

- **历史数据**：存储于 `/tmp/gold-price-history.json`（最近30条）
- **goldprice.org 接口**：`https://data-asg.goldprice.org/dbXRates/CNY`，返回 `items[0].xauPrice`（CNY/oz）
- **需带 Referer/Origin 头**：`Origin: https://goldprice.org`，否则被拒绝

## 注意事项

- 所有分析仅为参考，不构成投资建议
- 历史数据不足时（首日）涨跌幅显示"积累中"
