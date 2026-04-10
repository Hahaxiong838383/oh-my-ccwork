"""
One API 客户端封装
- 异步 httpx 调用 /v1/chat/completions
- 自动 fallback：主模型失败 → 切换备用
- 记录 usage 到 PostgreSQL
- 超时 60s，重试 1 次
"""
import time
import logging
from typing import Optional

import httpx

from .router import get_router, RouteResult
from .usage import record_usage

logger = logging.getLogger(__name__)


class ChatResult:
    def __init__(self, content: str, model: str, usage: dict, latency_ms: int):
        self.content = content
        self.model = model         # 实际使用的模型
        self.usage = usage         # {"prompt_tokens": ..., "completion_tokens": ...}
        self.latency_ms = latency_ms


async def _call_once(
    client: httpx.AsyncClient,
    base_url: str,
    api_key: str,
    model: str,
    messages: list,
    max_tokens: int,
    temperature: float,
) -> dict:
    """单次调用，不含重试/fallback"""
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    # max_tokens 只在明确指定时传递（部分中转不支持）
    if max_tokens and max_tokens < 8192:
        body["max_tokens"] = max_tokens
    resp = await client.post(
        f"{base_url}/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=60.0,
    )
    resp.raise_for_status()
    return resp.json()


async def chat_completion(
    messages: list,
    task_type: Optional[str] = None,
    agent: Optional[str] = None,
    model: Optional[str] = None,
    system: Optional[str] = None,
    max_tokens: int = 4096,
    temperature: float = 0.7,
) -> ChatResult:
    """
    统一入口：路由 → 调用 One API → fallback → 记录 usage

    Args:
        messages:    对话消息列表（OpenAI 格式）
        task_type:   任务类型，用于路由（如 "research"、"summarize"）
        agent:       Agent 名称，用于路由（如 "researcher"）
        model:       显式指定模型，覆盖路由规则
        system:      系统提示，自动插入到消息头部
        max_tokens:  最大输出 token 数
        temperature: 温度
    """
    router = get_router()
    route: RouteResult = router.resolve_model(task_type=task_type, agent=agent, model=model)

    # 插入 system 消息
    if system:
        messages = [{"role": "system", "content": system}] + list(messages)

    used_model = route.model
    start = time.monotonic()

    async with httpx.AsyncClient() as client:
        try:
            data = await _call_once(
                client, router.base_url, router.api_key,
                route.model, messages, max_tokens, temperature,
            )
        except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.RequestError) as e:
            # 主模型失败，尝试 fallback
            if route.fallback:
                logger.warning("主模型 %s 失败（%s），切换到 fallback %s", route.model, e, route.fallback)
                used_model = route.fallback
                data = await _call_once(
                    client, router.base_url, router.api_key,
                    route.fallback, messages, max_tokens, temperature,
                )
            else:
                raise

    latency_ms = int((time.monotonic() - start) * 1000)

    choice = data["choices"][0]
    content = choice.get("message", {}).get("content", "") or ""
    usage = data.get("usage", {})

    # 异步记录用量（失败不影响主流程）
    try:
        await record_usage(
            model=used_model,
            task_type=task_type,
            agent=agent,
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
            latency_ms=latency_ms,
            cost=_estimate_cost(used_model, usage),
        )
    except Exception as exc:
        logger.warning("记录 usage 失败（不影响结果）: %s", exc)

    return ChatResult(
        content=content,
        model=used_model,
        usage=usage,
        latency_ms=latency_ms,
    )


def _estimate_cost(model: str, usage: dict) -> float:
    """
    粗略估算费用（USD），仅用于统计参考
    实际以 One API 账单为准
    """
    input_t = usage.get("prompt_tokens", 0)
    output_t = usage.get("completion_tokens", 0)

    # 每 1M token 价格（USD），粗略值
    pricing = {
        "deepseek-chat": (0.14, 0.28),
        "deepseek-reasoner": (0.55, 2.19),
        "qwen-plus": (0.40, 1.20),
        "gemini-2.5-flash": (0.075, 0.30),
        "gemini-2.5-pro": (1.25, 10.00),
        "claude-sonnet-4-6": (3.00, 15.00),
    }
    in_price, out_price = pricing.get(model, (1.0, 3.0))
    return (input_t * in_price + output_t * out_price) / 1_000_000
