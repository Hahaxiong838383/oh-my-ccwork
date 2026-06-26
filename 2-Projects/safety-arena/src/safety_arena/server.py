"""FastAPI 服务层:把 capture → replay → metrics 暴露成 HTTP + SSE。

启动:  uv run python -m safety_arena.server   (默认 127.0.0.1:8800)
交互:  浏览器打开 /docs(FastAPI 自带 Swagger UI)即可点测所有端点。

端点:
  GET  /api/health                 健康 + trace 数
  GET  /api/scenarios              内置场景 id 列表
  POST /api/capture                跑一个内置场景 → 落库(M3 接真实 SUT)
  GET  /api/traces                 已存 trace 列表
  GET  /api/traces/{id}            一条 trace 的完整事件
  POST /api/replay                 多策略重放 → 结果 + 指标表(同步)
  GET  /api/replay/stream          单策略 SSE timeline(token emit / 仲裁决策按 t_ms 流式)
  POST /api/scan                   旋钮扫描(buffer / latency)→ 权衡曲线点
"""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

from .capture import capture, capture_async
from .metrics import StrategyMetrics, aggregate, format_table
from .models import InputCase
from .providers.gemini_sut import GeminiSut
from .providers.keyword_mock import DEFAULT_RULES, KeywordRiskSut, Rule
from .scenarios import CASES, sut as scenario_sut
from .serde import decision_to_dict, emit_to_dict, result_to_dict, trace_to_dict
from .store import TraceStore
from .strategies import Arbiter, Knobs, ParallelBuffer, SerialBlock
from .strategies.base import shifted_signals, trace_is_harmful

DB_PATH = os.environ.get("SAFETY_ARENA_DB", "data/traces.db")
store = TraceStore(DB_PATH)
WEB_DIR = Path(__file__).parent / "web"


def seed_scenarios() -> None:
    s = scenario_sut()
    for case in CASES.values():
        store.save(capture(s, case))


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_scenarios()  # 启动即灌内置场景,开箱有数据可玩
    yield


app = FastAPI(title="safety-arena", version="0.1.0", lifespan=lifespan)


# ---------------- 解析 helper ----------------

def build_strategy(spec: str):
    """'serial-block' / 'parallel-buffer:4' / 'arbiter' / 'arbiter:2'。"""
    name, _, arg = spec.strip().partition(":")
    if name == "serial-block":
        return SerialBlock()
    if name == "parallel-buffer":
        return ParallelBuffer(int(arg) if arg else None)  # 无 arg → 用 knobs.buffer_depth_tokens(给滑块)
    if name == "arbiter":
        return Arbiter(int(arg) if arg else None)
    raise HTTPException(400, f"未知策略: {spec}")


def build_knobs(d: dict | None) -> Knobs:
    d = d or {}
    return Knobs(
        classifier_latency_ms=float(d.get("classifier_latency_ms", 0)),
        buffer_depth_tokens=int(d.get("buffer_depth_tokens", 0)),
        high_at=float(d.get("high_at", 0.75)),
        medium_at=float(d.get("medium_at", 0.45)),
        low_at=float(d.get("low_at", 0.20)),
    )


def metrics_to_dict(m: StrategyMetrics) -> dict:
    def lv(x):
        return {"p50": x.p50, "p95": x.p95, "p99": x.p99, "mean": x.mean}

    return {
        "strategy": m.strategy, "n": m.n,
        "ttft": lv(m.ttft), "first_safe": lv(m.first_safe), "total": lv(m.total),
        "leakage_rate": m.leakage_rate, "mean_leaked_tokens": m.mean_leaked_tokens,
        "max_leaked_tokens": m.max_leaked_tokens, "intervention_rate": m.intervention_rate,
    }


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ---------------- 请求体 ----------------

class CaptureReq(BaseModel):
    scenario: str | None = None  # 内置场景 id(M1);自定义 SUT 在 M3


class ReplayReq(BaseModel):
    trace_id: str
    strategies: list[str] = ["serial-block", "parallel-buffer:0", "parallel-buffer:4", "arbiter"]
    knobs: dict | None = None


class ScanReq(BaseModel):
    trace_id: str
    knob: str                 # "buffer" | "latency"
    values: list[float]
    buffer_depth: int = 4     # latency 扫描时固定的 buffer 深度


# ---------------- 端点 ----------------

@app.get("/", response_class=HTMLResponse)
def root():
    return (WEB_DIR / "app.html").read_text(encoding="utf-8")


@app.get("/api/health")
def health():
    return {"ok": True, "traces": len(store.list())}


@app.get("/api/scenarios")
def scenarios():
    return {"scenarios": list(CASES.keys())}


@app.get("/api/rules")
def get_rules():
    """白盒规则评分器的默认词库(pattern + weight),前端加载后可编辑,再随 capture-text 传回。"""
    return {"rules": [{"pattern": r.pattern, "weight": r.weight, "note": r.note} for r in DEFAULT_RULES]}


@app.post("/api/capture")
def do_capture(req: CaptureReq):
    if not req.scenario:
        raise HTTPException(400, "M1 仅支持内置场景(scenario=...);自定义 SUT 在 M3")
    if req.scenario not in CASES:
        raise HTTPException(404, f"未知场景: {req.scenario}")
    tr = capture(scenario_sut(), CASES[req.scenario])
    store.save(tr)
    return {"trace_id": tr.trace_id, "n_tokens": len(tr.tokens()), "harmful": tr.is_harmful()}


_custom_seq = 0


class CaptureTextReq(BaseModel):
    text: str
    id: str | None = None
    rules: list[dict] | None = None  # 自定义词库 [{pattern, weight, note}];不给用默认


@app.post("/api/capture-text")
def capture_text(req: CaptureTextReq):
    """自定义文本 → 规则 mock SUT(按危险词标风险)生成 trace 并落库。真实 classifier+LLM 在 M3。"""
    global _custom_seq
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "文本不能为空")
    _custom_seq += 1
    cid = (req.id or f"custom-{_custom_seq}").strip() or f"custom-{_custom_seq}"
    rules = None
    if req.rules:
        rules = [Rule(str(r["pattern"]), float(r["weight"]), str(r.get("note", "")))
                 for r in req.rules if r.get("pattern")]
    tr = capture(KeywordRiskSut(rules=rules), InputCase(cid, text))
    store.save(tr)
    return {"trace_id": tr.trace_id, "input_text": tr.input.text, "n_tokens": len(tr.tokens()), "harmful": tr.is_harmful()}


class CaptureLiveReq(BaseModel):
    text: str
    gen_model: str | None = None
    clf_model: str | None = None


@app.post("/api/capture-live")
async def capture_live(req: CaptureLiveReq):
    """自定义文本 → 真实 SUT(小可 Gemini 生成 + LLM-as-classifier 并行)录 trace。需配 GEMINI_PROXY_URL/API_KEY。"""
    global _custom_seq
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "文本不能为空")
    try:
        sut = GeminiSut(gen_model=req.gen_model, clf_model=req.clf_model)
    except RuntimeError as e:
        raise HTTPException(503, f"真实 SUT 未配置:{e}")
    _custom_seq += 1
    try:
        tr = await capture_async(sut, InputCase(f"live-{_custom_seq}", text))
    except Exception as e:  # 真实调用失败(网络/上游)不该 500,给可读错误
        raise HTTPException(502, f"真实生成失败:{e}")
    store.save(tr)
    return {
        "trace_id": tr.trace_id, "input_text": tr.input.text, "n_tokens": len(tr.tokens()),
        "harmful": tr.is_harmful(), "generated": tr.full_text(), "sut": sut.name,
    }


@app.get("/api/traces")
def list_traces():
    return {"traces": store.list()}


@app.get("/api/traces/{trace_id:path}")
def get_trace(trace_id: str):
    tr = store.get(trace_id)
    if not tr:
        raise HTTPException(404, "trace 不存在")
    return trace_to_dict(tr)


@app.post("/api/replay")
def do_replay(req: ReplayReq):
    tr = store.get(req.trace_id)
    if not tr:
        raise HTTPException(404, "trace 不存在")
    knobs = build_knobs(req.knobs)
    results = [build_strategy(s).replay(tr, knobs) for s in req.strategies]
    agg = aggregate(results)
    return {
        "results": [result_to_dict(r) for r in results],
        "metrics_table": format_table(agg),
        "metrics": {k: metrics_to_dict(v) for k, v in agg.items()},
    }


@app.get("/api/replay/stream")
async def replay_stream(
    trace_id: str,
    strategy: str = "parallel-buffer:0",
    classifier_latency_ms: float = 0.0,
    buffer_depth_tokens: int = 0,
    high_at: float = 0.75,
    medium_at: float = 0.45,
    low_at: float = 0.20,
    speed: float = 8.0,
):
    tr = store.get(trace_id)
    if not tr:
        raise HTTPException(404, "trace 不存在")
    knobs = Knobs(
        classifier_latency_ms=classifier_latency_ms, buffer_depth_tokens=buffer_depth_tokens,
        high_at=high_at, medium_at=medium_at, low_at=low_at,
    )
    result = build_strategy(strategy).replay(tr, knobs)

    timeline = [(e.t_ms, "emit", emit_to_dict(e)) for e in result.emits]
    timeline += [(d.t_ms, "decision", decision_to_dict(d)) for d in result.decisions]
    timeline.sort(key=lambda x: x[0])

    async def gen():
        sigs = shifted_signals(tr, knobs)  # 含 classifier 延迟注入后的信号时刻
        toks = tr.tokens()
        gen_first = round(toks[0].t_ms, 1) if toks else 0.0
        gen_last = round(toks[-1].t_ms, 1) if toks else 0.0
        clf_ms = round(sigs[0].t_ms, 1) if sigs else None
        # 瓶颈:classifier 判定晚于生成完成 → classifier 是延迟瓶颈(三机制差异大);否则生成是瓶颈(差异≈生成跨度)
        bottleneck = "classifier" if (clf_ms is not None and clf_ms > gen_last) else "生成"
        yield sse("meta", {
            "trace_id": trace_id, "strategy": result.strategy_name,
            "input": tr.input.text, "harmful": trace_is_harmful(tr, knobs),
            "thresholds": {"high_at": knobs.high_at, "medium_at": knobs.medium_at, "low_at": knobs.low_at},
            "gen": {"first_ms": gen_first, "last_ms": gen_last, "span_ms": round(gen_last - gen_first, 1), "n_tokens": len(toks)},
            "classifier_ms": clf_ms,
            "bottleneck": bottleneck,
            "signals": [
                {
                    "t_ms": round(s.t_ms, 1), "risk": s.risk, "label": s.effective_label().value,
                    "reason": s.signal_reason, "source": s.signal_source,
                }
                for s in sigs
            ],
        })
        prev = 0.0
        for t_ms, kind, payload in timeline:
            dt = (t_ms - prev) / max(speed, 0.01) / 1000.0
            if dt > 0:
                await asyncio.sleep(min(dt, 2.0))  # 按 t_ms 加速重放,封顶 2s 防卡
            prev = t_ms
            yield sse(kind, payload)
        yield sse("done", {
            "emitted_text": result.emitted_text, "leaked_tokens": result.leaked_tokens,
            "ttft_ms": result.ttft_ms, "first_safe_token_ms": result.first_safe_token_ms,
            "total_ms": result.total_ms, "intervened": result.intervened,
        })

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/scan")
def do_scan(req: ScanReq):
    tr = store.get(req.trace_id)
    if not tr:
        raise HTTPException(404, "trace 不存在")
    points = []
    for v in req.values:
        if req.knob == "buffer":
            r = ParallelBuffer(int(v)).replay(tr, Knobs())
        elif req.knob == "latency":
            r = ParallelBuffer(req.buffer_depth).replay(tr, Knobs(classifier_latency_ms=v))
        else:
            raise HTTPException(400, "knob 只支持 buffer | latency")
        points.append({"x": v, "leaked_tokens": r.leaked_tokens, "ttft_ms": r.ttft_ms, "total_ms": r.total_ms})
    return {"knob": req.knob, "buffer_depth": req.buffer_depth, "points": points}


def run() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8800")))


if __name__ == "__main__":
    run()
