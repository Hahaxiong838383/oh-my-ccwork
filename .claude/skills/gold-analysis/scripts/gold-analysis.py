#!/usr/bin/env python3
"""
黄金走势分析脚本
- 实时价格: goldprice.org (分钟级) → fawazahmed0 (日线兜底)
- 历史日线: Stooq XAUUSD (免费，无需 API key，90天)
- 技术指标: MA5 / MA20 / RSI(14)
- 输出: JSON 格式，供 SKILL.md 读取后发飞书
"""
import csv
import io
import json
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

HISTORY_FILE = "/tmp/gold-price-history.json"
API_GOLDPRICE = "https://data-asg.goldprice.org/dbXRates/CNY"
API_FALLBACK  = "https://latest.currency-api.pages.dev/v1/currencies/xau.json"
API_STOOQ     = "https://stooq.com/q/d/l/?s=xauusd&i=d"
TROY_OZ_TO_GRAM = 31.1035
BJ_TZ = timezone(timedelta(hours=8))
GOLDPRICE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Origin": "https://goldprice.org",
    "Referer": "https://goldprice.org/",
}


# ── 实时价格获取 ──────────────────────────────────────────────

def fetch_price_goldprice():
    """主源：goldprice.org 实时 CNY/oz（分钟级）"""
    try:
        req = urllib.request.Request(API_GOLDPRICE, headers=GOLDPRICE_HEADERS)
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read())
        item = data["items"][0]
        cny_per_oz = item["xauPrice"]
        usd_per_oz = round(cny_per_oz / item.get("curr", {}).get("USD", 7.25) if isinstance(item.get("curr"), dict) else cny_per_oz / 7.25, 2)
        return {
            "cny_per_gram": round(cny_per_oz / TROY_OZ_TO_GRAM, 2),
            "usd_per_oz": usd_per_oz,
            "cny_per_oz": cny_per_oz,
            "date": datetime.now(BJ_TZ).strftime("%Y-%m-%d"),
            "source": "goldprice.org(实时)",
        }
    except Exception as e:
        print(f"[WARN] goldprice fetch failed: {e}", file=sys.stderr)
        return None


def fetch_price_fallback():
    """兜底：fawazahmed0 日线数据"""
    try:
        req = urllib.request.Request(API_FALLBACK, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        cny_per_oz = data["xau"].get("cny")
        usd_per_oz = data["xau"].get("usd")
        return {
            "cny_per_gram": round(cny_per_oz / TROY_OZ_TO_GRAM, 2),
            "usd_per_oz": round(usd_per_oz, 2),
            "cny_per_oz": round(cny_per_oz, 2),
            "date": data.get("date", ""),
            "source": "fawazahmed0(日线)",
        }
    except Exception as e:
        print(f"[WARN] fallback fetch failed: {e}", file=sys.stderr)
        return None


def fetch_price():
    return fetch_price_goldprice() or fetch_price_fallback()


# ── Stooq 历史日线 ────────────────────────────────────────────

def fetch_stooq_daily(days=90):
    """从 Stooq 获取 XAUUSD 日线收盘价（USD/oz），返回最近 days 条"""
    try:
        req = urllib.request.Request(API_STOOQ, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            text = resp.read().decode("utf-8")
        reader = csv.DictReader(io.StringIO(text))
        closes = [float(row["Close"]) for row in reader if row.get("Close")]
        return closes[-days:] if len(closes) >= days else closes
    except Exception as e:
        print(f"[WARN] stooq fetch failed: {e}", file=sys.stderr)
        return []


# ── 技术指标计算 ──────────────────────────────────────────────

def calc_ma(prices, n):
    """计算最近 n 日均线"""
    if len(prices) < n:
        return None
    return round(sum(prices[-n:]) / n, 2)


def calc_rsi(prices, n=14):
    """计算 RSI(n)，prices 为收盘价列表"""
    if len(prices) < n + 1:
        return None
    deltas = [prices[i] - prices[i - 1] for i in range(1, len(prices))]
    recent = deltas[-(n):]
    gains = [d for d in recent if d > 0]
    losses = [-d for d in recent if d < 0]
    avg_gain = sum(gains) / n if gains else 0
    avg_loss = sum(losses) / n if losses else 0
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - 100 / (1 + rs), 1)


# ── 本地短期历史（4h 用）────────────────────────────────────

def load_history():
    try:
        with open(HISTORY_FILE) as f:
            return json.load(f)
    except Exception:
        return []


def save_history(history):
    with open(HISTORY_FILE, "w") as f:
        json.dump(history[-30:], f)


# ── 综合分析 ──────────────────────────────────────────────────

def analyze(current, intraday_history, stooq_closes):
    price_usd = current["usd_per_oz"]
    price_cny_gram = current["cny_per_gram"]

    result = {
        "cny_per_gram": price_cny_gram,
        "usd_per_oz": price_usd,
        "date": current["date"],
        "source": current.get("source", ""),
        "changes": {},
        "indicators": {},
        "signal": "观望",
        "signal_emoji": "⚪",
        "reason": [],
    }

    # 短期涨跌幅（基于本地4h历史）
    for label, hours in [("4h", 4), ("1d", 24), ("3d", 72), ("7d", 168)]:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        past = [h for h in intraday_history if datetime.fromisoformat(h["ts"]) < cutoff]
        if past:
            old = past[-1]["cny_per_gram"]
            chg = (price_cny_gram - old) / old * 100
            result["changes"][label] = round(chg, 2)

    # 技术指标（基于 Stooq USD 日线）
    if stooq_closes:
        # 用最新 Stooq 收盘价补充当前价格做指标计算
        prices_with_today = stooq_closes + [price_usd]
        ma5  = calc_ma(prices_with_today, 5)
        ma20 = calc_ma(prices_with_today, 20)
        rsi  = calc_rsi(prices_with_today, 14)
        result["indicators"] = {
            "ma5":  ma5,
            "ma20": ma20,
            "rsi":  rsi,
            "above_ma5":  price_usd > ma5  if ma5  else None,
            "above_ma20": price_usd > ma20 if ma20 else None,
        }

    # 信号判断（优先用技术指标，兜底用日内涨跌）
    ind = result["indicators"]
    chg_1d = result["changes"].get("1d", 0)
    chg_4h = result["changes"].get("4h", 0)
    rsi_val = ind.get("rsi")
    above_ma20 = ind.get("above_ma20")
    ma20_val = ind.get("ma20")

    signals = []

    # RSI 信号
    if rsi_val is not None:
        if rsi_val >= 70:
            signals.append(("sell", f"RSI {rsi_val} 超买区，追多需谨慎"))
        elif rsi_val <= 30:
            signals.append(("buy", f"RSI {rsi_val} 超卖区，可关注买点"))
        else:
            signals.append(("neutral", f"RSI {rsi_val} 中性区间"))

    # MA20 位置信号
    if above_ma20 is not None and ma20_val:
        if above_ma20:
            signals.append(("bull", f"价格 ${price_usd:.0f} 站上 MA20 ${ma20_val:.0f}，趋势偏多"))
        else:
            signals.append(("bear", f"价格 ${price_usd:.0f} 跌破 MA20 ${ma20_val:.0f}，趋势偏空"))

    # 日内涨跌兜底
    if not signals:
        if chg_1d > 1.0:
            signals.append(("sell", f"日内涨 {chg_1d:+.2f}%，追高控仓"))
        elif chg_1d < -1.0:
            signals.append(("buy", f"日内跌 {chg_1d:+.2f}%，关注支撑位"))

    # 综合信号
    sell_signals = [s for s in signals if s[0] == "sell"]
    buy_signals  = [s for s in signals if s[0] == "buy"]

    if len(sell_signals) >= 2 or (rsi_val and rsi_val >= 70):
        result["signal"] = "谨慎追多"
        result["signal_emoji"] = "🟡"
    elif len(buy_signals) >= 1 and above_ma20:
        result["signal"] = "关注买点（趋势支撑）"
        result["signal_emoji"] = "🟢"
    elif len(buy_signals) >= 1:
        result["signal"] = "关注买点"
        result["signal_emoji"] = "🟢"
    elif above_ma20 is False:
        result["signal"] = "趋势偏空，观望"
        result["signal_emoji"] = "🔴"
    else:
        result["signal"] = "观望"
        result["signal_emoji"] = "⚪"

    result["reason"] = [s[1] for s in signals]
    result["reason"].append("⚠️ 仅供参考，非投资建议")
    return result


# ── 主流程 ────────────────────────────────────────────────────

def main():
    current = fetch_price()
    if not current:
        print(json.dumps({"error": "无法获取黄金价格数据"}))
        sys.exit(1)

    # 短期历史（用于 4h/1d 涨跌）
    intraday_history = load_history()
    ts = datetime.now(timezone.utc).isoformat()
    intraday_history.append({"ts": ts, "cny_per_gram": current["cny_per_gram"]})
    save_history(intraday_history)

    # Stooq 长期日线（用于技术指标）
    stooq_closes = fetch_stooq_daily(days=90)

    result = analyze(current, intraday_history[:-1], stooq_closes)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
