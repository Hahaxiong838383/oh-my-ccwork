#!/usr/bin/env python3
"""
黄金走势分析脚本 v2 — 多维量化判断
- 实时价格: goldprice.org (分钟级) → fawazahmed0 (日线兜底)
- 历史日线: Stooq XAUUSD (免费，无需 API key，90天)
- 宏观联动: DXY 美元指数 / 10Y美债收益率 / 金银比 / VIX 恐慌指数 / WTI原油 (via yfinance)
- 技术指标: MA5 / MA20 / RSI(14) / BOLL(20) / MACD(12,26,9)
- 判断逻辑: 多因子加权评分系统，输出综合信号
依赖: pip3 install yfinance
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
API_STOOQ     = "https://stooq.com/q/d/l/?s={symbol}&i=d"
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


# ── Stooq XAUUSD 历史日线（黄金专用）────────────────────────

def fetch_stooq_closes(symbol, days=90):
    """从 Stooq 获取指定标的日线收盘价，返回最近 days 条"""
    try:
        url = API_STOOQ.format(symbol=symbol)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            text = resp.read().decode("utf-8")
        reader = csv.DictReader(io.StringIO(text))
        closes = [float(row["Close"]) for row in reader if row.get("Close") and row["Close"] != "null"]
        return closes[-days:] if len(closes) >= days else closes
    except Exception as e:
        print(f"[WARN] stooq {symbol} fetch failed: {e}", file=sys.stderr)
        return []


# ── 宏观数据（via yfinance）──────────────────────────────────

def fetch_yf_latest(symbol):
    """用 yfinance 获取标的最新收盘价及1日涨跌幅"""
    try:
        import yfinance as yf
        hist = yf.Ticker(symbol).history(period="5d")
        closes = hist["Close"].dropna().tolist()
        if not closes:
            return None, None
        latest = round(closes[-1], 3)
        chg = round((closes[-1] - closes[-2]) / closes[-2] * 100, 2) if len(closes) >= 2 else None
        return latest, chg
    except Exception as e:
        print(f"[WARN] yfinance {symbol} failed: {e}", file=sys.stderr)
        return None, None


# ── 技术指标计算 ──────────────────────────────────────────────

def calc_ma(prices, n):
    if len(prices) < n:
        return None
    return round(sum(prices[-n:]) / n, 2)


def calc_rsi(prices, n=14):
    if len(prices) < n + 1:
        return None
    deltas = [prices[i] - prices[i - 1] for i in range(1, len(prices))]
    recent = deltas[-n:]
    gains = [d for d in recent if d > 0]
    losses = [-d for d in recent if d < 0]
    avg_gain = sum(gains) / n if gains else 0
    avg_loss = sum(losses) / n if losses else 0
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - 100 / (1 + rs), 1)


def calc_boll(prices, n=20):
    """布林带：中轨 MA20，上轨 MA20+2σ，下轨 MA20-2σ"""
    if len(prices) < n:
        return None, None, None
    window = prices[-n:]
    mid = sum(window) / n
    variance = sum((p - mid) ** 2 for p in window) / n
    std = variance ** 0.5
    return round(mid, 2), round(mid + 2 * std, 2), round(mid - 2 * std, 2)


def calc_macd(prices, fast=12, slow=26, signal=9):
    """MACD：返回 (macd_line, signal_line, histogram)"""
    def ema(data, period):
        k = 2 / (period + 1)
        result = [data[0]]
        for p in data[1:]:
            result.append(p * k + result[-1] * (1 - k))
        return result

    if len(prices) < slow + signal:
        return None, None, None
    ema_fast = ema(prices, fast)
    ema_slow = ema(prices, slow)
    macd_line = [f - s for f, s in zip(ema_fast, ema_slow)]
    signal_line = ema(macd_line, signal)
    histogram = macd_line[-1] - signal_line[-1]
    return round(macd_line[-1], 2), round(signal_line[-1], 2), round(histogram, 2)


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


# ── 多因子评分系统 ─────────────────────────────────────────

def score_factors(price_usd, indicators, macro, chg_1d, chg_4h):
    """
    多因子加权评分：-100（强烈看空）~ +100（强烈看多）
    正分 = 做多信号，负分 = 做空信号
    """
    score = 0
    details = []

    ind = indicators
    rsi_val = ind.get("rsi")
    above_ma20 = ind.get("above_ma20")
    above_ma5 = ind.get("above_ma5")
    ma20 = ind.get("ma20")
    boll_mid = ind.get("boll_mid")
    boll_upper = ind.get("boll_upper")
    boll_lower = ind.get("boll_lower")
    macd_hist = ind.get("macd_histogram")

    # ── 技术面（权重 50%）──

    # RSI (±20分)
    if rsi_val is not None:
        if rsi_val <= 30:
            score += 20
            details.append(f"RSI {rsi_val} 超卖 (+20)")
        elif rsi_val <= 40:
            score += 10
            details.append(f"RSI {rsi_val} 偏低 (+10)")
        elif rsi_val >= 70:
            score -= 20
            details.append(f"RSI {rsi_val} 超买 (-20)")
        elif rsi_val >= 60:
            score -= 10
            details.append(f"RSI {rsi_val} 偏高 (-10)")

    # MA20 位置 (±15分)
    if above_ma20 is not None:
        if above_ma20:
            score += 15
            details.append(f"价格站上 MA20 ${ma20:.0f} (+15)")
        else:
            score -= 15
            details.append(f"价格跌破 MA20 ${ma20:.0f} (-15)")

    # MA5 位置 (±8分)
    if above_ma5 is not None:
        if above_ma5:
            score += 8
            details.append("价格站上 MA5 (+8)")
        else:
            score -= 8
            details.append("价格跌破 MA5 (-8)")

    # 布林带位置 (±7分)
    if boll_upper and boll_lower and boll_mid:
        if price_usd >= boll_upper:
            score -= 7
            details.append(f"触碰布林上轨 ${boll_upper:.0f} (-7)")
        elif price_usd <= boll_lower:
            score += 7
            details.append(f"触碰布林下轨 ${boll_lower:.0f} (+7)")

    # MACD 柱状图方向 (±10分)
    if macd_hist is not None:
        if macd_hist > 0:
            score += min(10, int(macd_hist / 5))
            details.append(f"MACD 柱 {macd_hist:+.2f} 多头 (+{min(10, int(macd_hist/5))})")
        elif macd_hist < 0:
            penalty = min(10, int(abs(macd_hist) / 5))
            score -= penalty
            details.append(f"MACD 柱 {macd_hist:+.2f} 空头 (-{penalty})")

    # ── 宏观面（权重 50%）──

    dxy = macro.get("dxy")
    dxy_chg = macro.get("dxy_chg")
    bond10y = macro.get("bond10y")
    bond10y_chg = macro.get("bond10y_chg")
    gs_ratio = macro.get("gold_silver_ratio")
    vix = macro.get("vix")
    vix_chg = macro.get("vix_chg")
    oil = macro.get("oil_wti")
    oil_chg = macro.get("oil_chg")

    # DXY 美元指数 (±15分) — 负相关
    if dxy_chg is not None:
        if dxy_chg <= -0.5:
            score += 15
            details.append(f"DXY 跌 {dxy_chg:+.2f}%，美元走弱利多黄金 (+15)")
        elif dxy_chg <= -0.2:
            score += 8
            details.append(f"DXY 跌 {dxy_chg:+.2f}%，美元小幅走弱 (+8)")
        elif dxy_chg >= 0.5:
            score -= 15
            details.append(f"DXY 涨 {dxy_chg:+.2f}%，美元走强压制黄金 (-15)")
        elif dxy_chg >= 0.2:
            score -= 8
            details.append(f"DXY 涨 {dxy_chg:+.2f}%，美元小幅走强 (-8)")

    # 10年美债收益率 (±12分) — 负相关
    if bond10y_chg is not None:
        if bond10y_chg >= 0.05:
            score -= 12
            details.append(f"10Y美债 {bond10y:.2f}% 上行，实际利率压力 (-12)")
        elif bond10y_chg >= 0.02:
            score -= 6
            details.append(f"10Y美债 {bond10y:.2f}% 轻微上行 (-6)")
        elif bond10y_chg <= -0.05:
            score += 12
            details.append(f"10Y美债 {bond10y:.2f}% 下行，利率压力减轻 (+12)")
        elif bond10y_chg <= -0.02:
            score += 6
            details.append(f"10Y美债 {bond10y:.2f}% 轻微下行 (+6)")

    # VIX 恐慌指数 (±10分) — 正相关（避险需求）
    if vix is not None:
        if vix >= 30:
            score += 10
            details.append(f"VIX {vix:.1f} 高恐慌，避险需求强 (+10)")
        elif vix >= 20:
            score += 5
            details.append(f"VIX {vix:.1f} 中等恐慌 (+5)")
        elif vix <= 12:
            score -= 5
            details.append(f"VIX {vix:.1f} 极低，市场过度乐观 (-5)")

    # 金银比 (±8分) — 高比值 = 黄金相对高估
    if gs_ratio is not None:
        if gs_ratio >= 90:
            score -= 8
            details.append(f"金银比 {gs_ratio:.1f} 极高，黄金相对高估 (-8)")
        elif gs_ratio >= 80:
            score -= 4
            details.append(f"金银比 {gs_ratio:.1f} 偏高 (-4)")
        elif gs_ratio <= 65:
            score += 8
            details.append(f"金银比 {gs_ratio:.1f} 偏低，黄金相对低估 (+8)")
        elif gs_ratio <= 72:
            score += 4
            details.append(f"金银比 {gs_ratio:.1f} 中性偏低 (+4)")

    # WTI原油 (±5分) — 通胀预期联动
    if oil_chg is not None:
        if oil_chg >= 2.0:
            score += 5
            details.append(f"油价 +{oil_chg:.1f}%，通胀预期升温 (+5)")
        elif oil_chg <= -2.0:
            score -= 5
            details.append(f"油价 {oil_chg:.1f}%，通胀预期降温 (-5)")

    return round(score), details


def predict_1h(current_cny_gram, current_usd_oz, score, indicators, macro, changes):
    """
    基于多因子信号预测未来1小时价格
    模型：动量外推 + 评分方向偏移 + RSI均值回归修正
    历史统计：黄金1小时正常波动率约 0.05~0.2%，极端行情可达 0.5%
    """
    # 动量外推：4h涨跌幅线性外推到1h（取1/4）
    momentum_4h = changes.get("4h", 0)
    base_1h = momentum_4h / 4

    # 评分方向偏移：score每10分对应约0.05%
    score_bias = score * 0.005

    # RSI均值回归修正
    rsi = indicators.get("rsi")
    rsi_adj = 0.0
    if rsi is not None:
        if rsi >= 70:
            rsi_adj = -0.05   # 超买，轻微回调倾向
        elif rsi <= 30:
            rsi_adj = +0.05   # 超卖，轻微反弹倾向

    # 合并，限幅 ±0.5%（黄金1h极少超过）
    total_pct = max(-0.5, min(0.5, base_1h + score_bias + rsi_adj))

    predicted_cny = round(current_cny_gram * (1 + total_pct / 100), 2)
    predicted_usd = round(current_usd_oz  * (1 + total_pct / 100), 2)

    # 条件假设
    assumptions = []
    dxy = macro.get("dxy")
    bond = macro.get("bond10y")
    if dxy is not None:
        assumptions.append(f"DXY维持{dxy:.1f}区间")
    if bond is not None:
        assumptions.append(f"10Y美债维持{bond:.2f}%附近")
    assumptions.append("无突发宏观事件")

    # 预测逻辑拼装
    logic = []
    if abs(base_1h) > 0.01:
        direction = "上行" if base_1h > 0 else "下行"
        logic.append(f"4h动量延续{direction}（{momentum_4h:+.2f}%→1h外推）")
    if abs(score_bias) > 0.02:
        direction = "正向" if score_bias > 0 else "负向"
        logic.append(f"综合评分{score}分提供{direction}偏移")
    if rsi_adj != 0 and rsi is not None:
        direction = "超卖反弹" if rsi_adj > 0 else "超买回调"
        logic.append(f"RSI {rsi:.1f} {direction}修正")
    if not logic:
        logic.append("各因子信号中性，预测维持当前价格")

    return {
        "predicted_cny_per_gram": predicted_cny,
        "predicted_usd_per_oz": predicted_usd,
        "predicted_change_pct": round(total_pct, 3),
        "assumptions": assumptions,
        "logic": logic,
    }


def score_to_signal(score):
    """评分转信号"""
    if score >= 40:
        return "强烈看多 🚀", "🟢"
    elif score >= 20:
        return "偏多，关注买点 📈", "🟢"
    elif score >= 5:
        return "轻微偏多，观望为主", "🟡"
    elif score >= -5:
        return "中性，观望", "⚪"
    elif score >= -20:
        return "轻微偏空，观望为主", "🟡"
    elif score >= -40:
        return "偏空，控制仓位 📉", "🔴"
    else:
        return "强烈看空 ⚠️", "🔴"


# ── 综合分析 ──────────────────────────────────────────────────

def analyze(current, intraday_history, gold_closes, macro):
    price_usd = current["usd_per_oz"]
    price_cny_gram = current["cny_per_gram"]

    result = {
        "cny_per_gram": price_cny_gram,
        "usd_per_oz": price_usd,
        "date": current["date"],
        "source": current.get("source", ""),
        "changes": {},
        "indicators": {},
        "macro": macro,
        "score": 0,
        "signal": "观望",
        "signal_emoji": "⚪",
        "reason": [],
    }

    # 短期涨跌幅
    for label, hours in [("4h", 4), ("1d", 24), ("3d", 72), ("7d", 168)]:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        past = [h for h in intraday_history if datetime.fromisoformat(h["ts"]) < cutoff]
        if past:
            old = past[-1]["cny_per_gram"]
            chg = (price_cny_gram - old) / old * 100
            result["changes"][label] = round(chg, 2)

    # 技术指标
    if gold_closes:
        prices_with_today = gold_closes + [price_usd]
        ma5  = calc_ma(prices_with_today, 5)
        ma20 = calc_ma(prices_with_today, 20)
        rsi  = calc_rsi(prices_with_today, 14)
        boll_mid, boll_upper, boll_lower = calc_boll(prices_with_today, 20)
        macd_line, macd_signal, macd_hist = calc_macd(prices_with_today)
        result["indicators"] = {
            "ma5":  ma5,
            "ma20": ma20,
            "rsi":  rsi,
            "above_ma5":  price_usd > ma5  if ma5  else None,
            "above_ma20": price_usd > ma20 if ma20 else None,
            "boll_mid": boll_mid,
            "boll_upper": boll_upper,
            "boll_lower": boll_lower,
            "macd_line": macd_line,
            "macd_signal": macd_signal,
            "macd_histogram": macd_hist,
        }

    # 多因子评分
    chg_1d = result["changes"].get("1d", 0)
    chg_4h = result["changes"].get("4h", 0)
    score, details = score_factors(price_usd, result["indicators"], macro, chg_1d, chg_4h)
    signal_text, signal_emoji = score_to_signal(score)

    result["score"] = score
    result["signal"] = signal_text
    result["signal_emoji"] = signal_emoji
    result["reason"] = details
    result["reason"].append("⚠️ 仅供参考，非投资建议")

    # 1小时价格预测
    result["prediction_1h"] = predict_1h(
        price_cny_gram, price_usd,
        score, result["indicators"], macro,
        result["changes"],
    )

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

    # XAUUSD 长期日线（技术指标）
    gold_closes = fetch_stooq_closes("xauusd", days=90)

    # 宏观数据（via yfinance）
    dxy, dxy_chg = fetch_yf_latest("DX-Y.NYB")
    bond10y, bond10y_chg = fetch_yf_latest("^TNX")
    vix, vix_chg = fetch_yf_latest("^VIX")
    oil_wti, oil_chg = fetch_yf_latest("CL=F")
    # 白银从 Stooq 拉（xagusd 有效）
    silver_closes = fetch_stooq_closes("xagusd", days=5)
    silver = silver_closes[-1] if silver_closes else None

    gs_ratio = round(current["usd_per_oz"] / silver, 2) if silver and silver > 0 else None

    macro = {
        "dxy": dxy,
        "dxy_chg": dxy_chg,
        "bond10y": bond10y,
        "bond10y_chg": bond10y_chg,
        "silver": silver,
        "gold_silver_ratio": gs_ratio,
        "vix": vix,
        "vix_chg": vix_chg,
        "oil_wti": oil_wti,
        "oil_chg": oil_chg,
    }

    result = analyze(current, intraday_history[:-1], gold_closes, macro)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
