#!/usr/bin/env python3
"""
黄金走势分析脚本
- 数据源1: 新浪财经 SHFE 沪金期货 (盘中实时，09:00-15:30 / 21:00-02:30 北京时间)
- 数据源2: fawazahmed0 currency API (盘间兜底，日线数据)
- 主单位: 人民币/克
- 输出: JSON 格式，供 SKILL.md 读取后发飞书
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

HISTORY_FILE = "/tmp/gold-price-history.json"
API_FALLBACK = "https://latest.currency-api.pages.dev/v1/currencies/xau.json"
TROY_OZ_TO_GRAM = 31.1035  # 1 troy ounce = 31.1035 克
BJ_TZ = timezone(timedelta(hours=8))


def is_shfe_trading():
    """判断当前是否在上期所黄金交易时段（北京时间）"""
    now = datetime.now(BJ_TZ)
    t = now.hour * 100 + now.minute
    # 日盘 09:00-15:30，夜盘 21:00-次日 02:30
    return (900 <= t <= 1530) or (t >= 2100) or (t <= 230)


def get_au_contracts():
    """生成最近 3 个沪金期货合约代码（双月：2/4/6/8/10/12）"""
    now = datetime.now(BJ_TZ)
    year, month = now.year, now.month
    contracts = []
    # 往后找最近的双月合约
    m = month
    y = year
    while len(contracts) < 3:
        m += 1
        if m > 12:
            m = 1
            y += 1
        if m % 2 == 0:
            contracts.append(f"AU{str(y)[2:]}{m:02d}")
    return contracts


def fetch_price_sina():
    """盘中优先：从新浪财经拉取 SHFE 沪金实时价（CNY/克）"""
    if not is_shfe_trading():
        return None
    for contract in get_au_contracts():
        try:
            url = f"https://hq.sinajs.cn/list=nf_{contract}.XSGE"
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://finance.sina.com.cn",
            })
            with urllib.request.urlopen(req, timeout=5) as resp:
                raw = resp.read().decode("gbk", errors="replace")
            match = re.search(r'"([^"]+)"', raw)
            if not match:
                continue
            fields = match.group(1).split(",")
            # 字段5（index 4）为最新成交价，SHFE 金价单位：元/克
            if len(fields) < 5 or not fields[4]:
                continue
            price = float(fields[4])
            if not (300 < price < 5000):   # 合理区间校验
                continue
            return {
                "cny_per_gram": round(price, 2),
                "usd_per_oz": round(price * TROY_OZ_TO_GRAM / 7.3, 2),
                "date": datetime.now(BJ_TZ).strftime("%Y-%m-%d"),
                "source": f"SHFE {contract}(实时)",
            }
        except Exception as e:
            print(f"[WARN] Sina {contract} failed: {e}", file=sys.stderr)
    return None


def fetch_price_fallback():
    """盘间兜底：fawazahmed0 日线数据"""
    try:
        req = urllib.request.Request(API_FALLBACK, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        cny_per_oz = data["xau"].get("cny")
        usd_per_oz = data["xau"].get("usd")
        return {
            "cny_per_gram": round(cny_per_oz / TROY_OZ_TO_GRAM, 2),
            "usd_per_oz": round(usd_per_oz, 2),
            "date": data.get("date", ""),
            "source": "fawazahmed0(日线)",
        }
    except Exception as e:
        print(f"[WARN] fallback fetch failed: {e}", file=sys.stderr)
        return None


def fetch_price():
    return fetch_price_sina() or fetch_price_fallback()

def load_history():
    try:
        with open(HISTORY_FILE) as f:
            return json.load(f)
    except Exception:
        return []

def save_history(history):
    with open(HISTORY_FILE, "w") as f:
        json.dump(history[-30:], f)

def analyze(current, history):
    price = current["cny_per_gram"]
    result = {
        "cny_per_gram": price,
        "usd_per_oz": current["usd_per_oz"],
        "date": current["date"],
        "source": current.get("source", ""),
        "changes": {},
        "signal": "观望",
        "signal_emoji": "⚪",
        "reason": [],
    }

    for label, hours in [("4h", 4), ("1d", 24), ("3d", 72), ("7d", 168)]:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        past = [h for h in history if datetime.fromisoformat(h["ts"]) < cutoff]
        if past:
            old = past[-1]["cny_per_gram"]
            chg = (price - old) / old * 100
            result["changes"][label] = round(chg, 2)

    chg_1d = result["changes"].get("1d", 0)
    chg_7d = result["changes"].get("7d", 0)

    if chg_1d > 1.0:
        result["signal"] = "谨慎追多"
        result["signal_emoji"] = "🟡"
        result["reason"].append(f"日内涨幅 {chg_1d:+.2f}%，追高需控仓")
    elif chg_1d < -1.0:
        result["signal"] = "关注买点"
        result["signal_emoji"] = "🟢"
        result["reason"].append(f"日内跌幅 {chg_1d:+.2f}%，可关注支撑位")
    else:
        result["signal"] = "观望"
        result["signal_emoji"] = "⚪"
        result["reason"].append(f"日内波动 {chg_1d:+.2f}%，方向不明")

    if chg_7d > 3.0:
        result["reason"].append(f"7日累涨 {chg_7d:+.2f}%，短期偏强但注意回调风险")
    elif chg_7d < -3.0:
        result["reason"].append(f"7日累跌 {chg_7d:+.2f}%，中期偏弱")

    result["reason"].append("⚠️ 仅供参考，非投资建议，请结合宏观研判独立决策")
    return result

def main():
    current = fetch_price()
    if not current:
        print(json.dumps({"error": "无法获取黄金价格数据"}))
        sys.exit(1)

    history = load_history()
    ts = datetime.now(timezone.utc).isoformat()
    history.append({"ts": ts, "cny_per_gram": current["cny_per_gram"]})
    save_history(history)

    result = analyze(current, history[:-1])
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
