"""MiniMax M2.7 流式 LLM + function calling（async 版）"""

import json
import aiohttp
from typing import AsyncGenerator
from config import MINIMAX_API_KEY, MINIMAX_BASE_URL, MINIMAX_MODEL, FULL_PROMPT

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "control_device",
            "description": "控制智能家居设备（开灯/关灯/开关）",
            "parameters": {
                "type": "object",
                "properties": {
                    "device_name": {"type": "string", "description": "设备名，如'北卧灯'、'客厅灯'"},
                    "action": {"type": "string", "enum": ["turn_on", "turn_off"], "description": "turn_on=打开, turn_off=关闭"},
                },
                "required": ["device_name", "action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "play_music",
            "description": "播放音乐，通过小爱音箱",
            "parameters": {
                "type": "object",
                "properties": {
                    "song": {"type": "string", "description": "歌名或歌手名"},
                },
                "required": ["song"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "stop_music",
            "description": "停止播放音乐",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


async def chat_stream(messages: list, use_tools: bool = True) -> AsyncGenerator:
    """
    异步流式调用 MiniMax M2.7。
    yield 两种类型：
      ("text", "内容片段")
      ("tool_call", {"name": "xxx", "arguments": {...}})
    """
    headers = {
        "Authorization": f"Bearer {MINIMAX_API_KEY}",
        "Content-Type": "application/json",
    }

    full_messages = [{"role": "system", "content": FULL_PROMPT}] + messages
    data = {
        "model": MINIMAX_MODEL,
        "messages": full_messages,
        "stream": True,
        "max_tokens": 200,
    }
    if use_tools:
        data["tools"] = TOOLS

    tool_calls_acc = {}

    async with aiohttp.ClientSession() as session:
        async with session.post(
            MINIMAX_BASE_URL,
            headers=headers,
            json=data,
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            async for line in resp.content:
                line = line.decode("utf-8").strip()
                if not line or not line.startswith("data: ") or line == "data: [DONE]":
                    continue

                try:
                    d = json.loads(line[6:])
                    delta = d.get("choices", [{}])[0].get("delta", {})

                    content = delta.get("content", "")
                    if content:
                        yield ("text", content)

                    tc_list = delta.get("tool_calls")
                    if tc_list:
                        for tc in tc_list:
                            idx = tc.get("index", 0)
                            if idx not in tool_calls_acc:
                                tool_calls_acc[idx] = {"name": "", "arguments": ""}
                            if "function" in tc:
                                if "name" in tc["function"]:
                                    tool_calls_acc[idx]["name"] = tc["function"]["name"]
                                if "arguments" in tc["function"]:
                                    tool_calls_acc[idx]["arguments"] += tc["function"]["arguments"]

                except (json.JSONDecodeError, KeyError, IndexError):
                    continue

    # 流结束后，输出完整的 tool calls
    for idx, tc in tool_calls_acc.items():
        if tc["name"]:
            try:
                args = json.loads(tc["arguments"]) if tc["arguments"] else {}
            except json.JSONDecodeError:
                args = {}
            yield ("tool_call", {"name": tc["name"], "arguments": args})
