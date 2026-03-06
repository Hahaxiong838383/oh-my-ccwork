---
name: gold-analysis
description: 黄金走势分析 - 每4小时获取实时金价，结合 MA5/MA20/RSI(14) 技术指标分析趋势，发飞书通知。触发词："/gold"、"黄金分析"、"金价走势"、"适不适合买入"
---

# 黄金走势分析

## 执行流程

### Step 1: 获取价格数据 + 技术指标

```bash
python3 .claude/skills/gold-analysis/scripts/gold-analysis.py
```

输出 JSON 包含：
- `cny_per_gram`: 当前金价（人民币/克）
- `usd_per_oz`: 当前金价（美元/盎司）
- `changes`: 短期涨跌幅（4h/1d/3d/7d，基于本地历史）
- `indicators.ma5`: 5日均线（USD，Stooq 日线）
- `indicators.ma20`: 20日均线（USD，Stooq 日线）
- `indicators.rsi`: RSI(14)
- `indicators.above_ma20`: 是否站上 MA20（布尔值）
- `signal`: 操作信号（观望/关注买点/谨慎追多/趋势偏空）
- `reason`: 分析理由列表

### Step 2: 组织分析报告

根据 JSON 数据，结合以下维度分析：
1. **价格位置**：当前价格 vs MA5/MA20，判断多空趋势
2. **RSI**：>70 超买（谨慎追多）/ <30 超卖（关注买点）/ 中性区间
3. **动量**：4h/1d 涨跌方向是否一致
4. **建议**：综合均线位置 + RSI，给出入场/观望/减仓方向

### Step 3: 发飞书通知

使用 send.js 发送，格式如下：

标题：`黄金走势 MM-DD HH:MM`

内容模板（用 \n 换行）：
```
━━━━━━━━━━━━━━━━
💰 ¥X,XXX.XX /克   $X,XXX /盎司

📈 涨跌幅
  4小时   X.XX%
  今日    X.XX%

📊 技术指标
  MA5    $X,XXX  MA20  $X,XXX
  RSI    XX.X

🎯 信号：[emoji] [信号文字]
  [分析要点1]
  [分析要点2]
━━━━━━━━━━━━━━━━
⚠️ 非投资建议
```

调用命令：
```bash
node /Users/rayman.chen/mycc/.claude/skills/tell-me/send.js \
  "黄金走势 MM-DD HH:MM" \
  "内容" \
  blue
```

## 数据说明

| 数据源 | 更新频率 | 用途 |
|--------|---------|------|
| goldprice.org | 分钟级实时 | 当前价格（主源） |
| fawazahmed0 currency API | 每日一次 | 价格兜底 |
| Stooq XAUUSD | 日线，无需 API key | MA5/MA20/RSI 历史计算 |

- **Stooq 接口**：`https://stooq.com/q/d/l/?s=xauusd&i=d`，返回 CSV，拉取最近 90 天
- **本地短期历史**：`/tmp/gold-price-history.json`（最近30条，用于4h/1d涨跌）
- **goldprice.org 接口**：需带 `Origin: https://goldprice.org` 头

## 信号判断逻辑

| 条件 | 信号 |
|------|------|
| RSI ≥ 70 | 🟡 谨慎追多（超买） |
| RSI ≤ 30 | 🟢 关注买点（超卖） |
| 价格 < MA20 | 🔴 趋势偏空，观望 |
| 价格 > MA20 + RSI 中性 | 🟢 关注买点（趋势支撑） |
| 其他 | ⚪ 观望 |

## 注意事项

- 所有分析仅为参考，不构成投资建议
- Stooq 为 USD 日线，MA/RSI 指标以 USD 价格计算
- 首次运行即可获得完整技术指标（Stooq 提供90天历史）
