---
name: gold-analysis
description: 黄金走势分析 - 每4小时获取实时金价，结合技术指标+宏观数据多因子评分，发飞书通知。触发词："/gold"、"黄金分析"、"金价走势"、"适不适合买入"
---

# 黄金走势分析

## 执行流程

### Step 1: 获取数据（脚本自动完成）

```bash
python3 .claude/skills/gold-analysis/scripts/gold-analysis.py
```

输出 JSON 字段说明：

**价格**
- `cny_per_gram`: 当前金价（人民币/克）
- `usd_per_oz`: 当前金价（美元/盎司）
- `source`: 数据来源（goldprice.org 实时 / fawazahmed0 兜底）
- `changes`: 短期涨跌幅（4h/1d/3d/7d，基于本地历史）

**技术指标**（`indicators`）
- `ma5` / `ma20`: 5日/20日均线（USD）
- `rsi`: RSI(14)
- `above_ma5` / `above_ma20`: 是否站上均线
- `boll_upper` / `boll_mid` / `boll_lower`: 布林带上轨/中轨/下轨（USD）
- `macd_line` / `macd_signal` / `macd_histogram`: MACD(12,26,9)

**宏观数据**（`macro`）
- `dxy` / `dxy_chg`: 美元指数及1日涨跌幅（负相关）
- `bond10y` / `bond10y_chg`: 10年美债收益率及1日变化（负相关）
- `vix` / `vix_chg`: VIX 恐慌指数（正相关，避险需求）
- `silver` / `gold_silver_ratio`: 白银价格 & 金银比（高比值=黄金相对高估）
- `oil_wti` / `oil_chg`: WTI 原油及1日涨跌（通胀预期联动）

**综合评分**
- `score`: 多因子加权得分（-100 极度看空 ~ +100 极度看多）
- `signal` / `signal_emoji`: 信号文字和 emoji
- `reason`: 各因子得分明细列表

### Step 2: 组织分析报告

分析维度（按重要性排序）：

1. **综合评分**：score 及各因子加权情况
2. **宏观环境**：DXY/美债收益率走向（与黄金负相关）、VIX 恐慌程度（避险需求）
3. **技术面**：MA5/MA20 位置（趋势判断）、RSI（超买超卖）、BOLL 通道、MACD 动能
4. **价格动量**：4h/1d 方向是否一致，是否接近重要均线支撑
5. **相对估值**：金银比（>90 黄金相对高估，<65 低估）

### Step 3: 发飞书通知

使用 send.js 发送，格式如下：

标题：`黄金走势 MM-DD HH:MM`

内容模板（用 \n 换行）：
```
━━━━━━━━━━━━━━━━
💰 ¥X,XXX.XX /克   $X,XXX /盎司

📈 涨跌幅
  4小时  X.XX%    今日  X.XX%

📊 技术指标
  MA5  $X,XXX   MA20  $X,XXX
  RSI  XX.X     MACD柱 X.XX
  布林  $X,XXX ～ $X,XXX

🌐 宏观数据
  美元DXY   XXX.X  (X.XX%)
  10Y美债   X.XX%  (X.XXbp)
  VIX恐慌   XX.X
  金银比    XX.X   WTI原油  $XX.X

🎯 综合评分：[score] 分
  [emoji] [信号文字]
  [因子明细1]
  [因子明细2]
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
| goldprice.org | 分钟级实时 | 当前金价（主源） |
| fawazahmed0 currency API | 每日一次 | 金价兜底 |
| Stooq XAUUSD | 日线，无需 API key | MA5/MA20/RSI/BOLL/MACD 历史计算 |
| Stooq XAGUSD | 日线 | 白银价格（计算金银比） |
| yfinance DX-Y.NYB | 近5日 | 美元指数 DXY |
| yfinance ^TNX | 近5日 | 10年美债收益率 |
| yfinance ^VIX | 近5日 | VIX 恐慌指数 |
| yfinance CL=F | 近5日 | WTI 原油期货 |

- **本地短期历史**：`/tmp/gold-price-history.json`（最近30条，用于4h/1d涨跌）
- **依赖安装**：`pip3 install yfinance`

## 多因子评分权重

**技术面（总权重 ~50%）**

| 指标 | 最大影响 | 方向 |
|------|---------|------|
| RSI(14) | ±20 | 超卖加分，超买减分 |
| MA20 位置 | ±15 | 站上加分，跌破减分 |
| MA5 位置 | ±8 | 同上 |
| MACD 柱状图 | ±10 | 正值加分，负值减分 |
| 布林带位置 | ±7 | 触下轨加分，触上轨减分 |

**宏观面（总权重 ~50%）**

| 指标 | 最大影响 | 方向 |
|------|---------|------|
| DXY 美元指数 | ±15 | 美元跌=黄金涨（负相关） |
| 10Y 美债收益率 | ±12 | 利率涨=黄金跌（负相关） |
| VIX 恐慌指数 | ±10 | VIX 高=避险需求强（正相关） |
| 金银比 | ±8 | 比值高=黄金相对高估（减分） |
| WTI 原油 | ±5 | 油价涨=通胀预期=黄金涨 |

## 信号区间

| 评分 | 信号 |
|------|------|
| ≥ 40 | 🚀 强烈看多 |
| 20～39 | 🟢 偏多，关注买点 |
| 5～19 | 🟡 轻微偏多，观望为主 |
| -4～4 | ⚪ 中性，观望 |
| -19～-5 | 🟡 轻微偏空，观望为主 |
| -39～-20 | 🔴 偏空，控制仓位 |
| ≤ -40 | ⚠️ 强烈看空 |

## 注意事项

- 所有分析仅为参考，不构成投资建议
- 技术指标以 USD 价格计算（Stooq XAUUSD 日线，90天历史）
- yfinance 获取宏观数据，网络不通时对应因子自动跳过不影响主流程
