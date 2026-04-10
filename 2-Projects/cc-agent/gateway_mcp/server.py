"""
Gateway MCP Server - 让 Claude Code 在对话中调用其他模型
工具列表：
  - llm_call   : 调用指定模型执行任务（节省 Claude Code 额度）
  - llm_models : 列出所有可用模型和路由配置
  - llm_usage  : 查看最近 N 天用量统计
"""
import sys
import os
import json
import asyncio
import logging

# 将 cc-agent 根目录加入 Python 路径，使 gateway 包可导入
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from fastmcp import FastMCP
from gateway.client import chat_completion
from gateway.router import get_router
from gateway.usage import get_usage_summary, ensure_table

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

mcp = FastMCP(
    name="gateway",
    instructions=(
        "多模型网关 MCP，调用 DeepSeek/Qwen/Gemini 等云端模型执行任务，节省 Claude Code 额度。"
        "优先用 llm_call 处理搜索、总结、翻译、代码审查等任务。"
    ),
)


@mcp.tool()
async def llm_call(
    prompt: str,
    task_type: str = "casual",
    model: str = "",
    system: str = "",
    max_tokens: int = 4096,
) -> str:
    """
    调用云端模型执行任务（不消耗 Claude Code 额度）。

    Args:
        prompt:     用户输入 / 任务描述
        task_type:  任务类型，决定路由到哪个模型。
                    可选值: casual | summarize | translate | research |
                            code_review | wiki_compile | wiki_query
        model:      显式指定模型名（留空则按 task_type 路由）
                    例: deepseek-chat | qwen-plus | gemini-2.5-pro
        system:     系统提示（留空使用默认）
        max_tokens: 最大输出 token 数（默认 4096）

    Returns:
        JSON 字符串，包含 content（模型回复）和 model（实际使用模型）
    """
    messages = [{"role": "user", "content": prompt}]
    result = await chat_completion(
        messages=messages,
        task_type=task_type or None,
        model=model or None,
        system=system or None,
        max_tokens=max_tokens,
    )
    return json.dumps(
        {
            "content": result.content,
            "model": result.model,
            "usage": result.usage,
            "latency_ms": result.latency_ms,
        },
        ensure_ascii=False,
        indent=2,
    )


@mcp.tool()
def llm_models() -> str:
    """
    列出所有可用模型和当前路由配置。

    Returns:
        JSON 字符串，包含路由规则和 Agent 模型分配
    """
    router = get_router()
    config = router.list_routes()
    return json.dumps(config, ensure_ascii=False, indent=2)


@mcp.tool()
async def llm_usage(days: int = 7) -> str:
    """
    查看最近 N 天的模型用量统计，按模型/任务类型/Agent 分组。

    Args:
        days: 统计天数（默认 7 天）

    Returns:
        JSON 字符串，包含各维度用量汇总和费用估算
    """
    summary = await get_usage_summary(days=days)
    return json.dumps(summary, ensure_ascii=False, indent=2)


async def _startup() -> None:
    """确保 PG 表存在"""
    try:
        await ensure_table()
        logger.info("model_usage 表已就绪")
    except Exception as e:
        logger.warning("PG 初始化失败（不影响 MCP 启动）: %s", e)


if __name__ == "__main__":
    # 启动前建表
    asyncio.run(_startup())
    mcp.run()
