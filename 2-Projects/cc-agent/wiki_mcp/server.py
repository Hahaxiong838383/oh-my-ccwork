"""
Wiki 知识引擎 MCP Server
FastMCP 入口，注册 5 个工具，支持 stdio 和 Streamable HTTP 模式运行。

使用方式：
  stdio 模式（Claude Desktop / claude --mcp）：
    python server.py

  HTTP 模式：
    fastmcp run server.py --transport streamable-http --port 8765
"""

import sys
import os
from contextlib import asynccontextmanager

# 确保能导入同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastmcp import FastMCP
from db import close_pool
import tools as t

# 创建 MCP server 实例
mcp = FastMCP(
    name="wiki-knowledge-engine",
    instructions=(
        "个人知识库引擎。提供全文搜索、文档读写和本地文件导入功能。"
        "搜索默认只返回 verified 文档；写入路径必须以 /wiki/ 开头。"
        "首次使用请调用 wiki_guide 了解用法和统计概览。"
    ),
)


# ─────────────────────────────────────────────
# 注册工具
# ─────────────────────────────────────────────

@mcp.tool()
async def wiki_guide() -> dict:
    """
    返回知识库概览和使用指南。
    包含文档统计（总数/verified/draft）、来源分布、最近更新，以及工具使用说明和写作规范。
    """
    return await t.wiki_guide()


@mcp.tool()
async def wiki_search(
    query: str,
    include_drafts: bool = False,
    limit: int = 10,
) -> dict:
    """
    全文搜索知识库文档（支持中文）。

    - query: 搜索关键词
    - include_drafts: 是否包含草稿，默认 False（只搜 verified）
    - limit: 最多返回结果数，默认 10，最大 50

    返回：[{path, title, snippet, score, trust_level, header_breadcrumb}]
    """
    return await t.wiki_search(query=query, include_drafts=include_drafts, limit=limit)


@mcp.tool()
async def wiki_read(path: str) -> dict:
    """
    读取 wiki 文档。

    - path: 精确路径（如 /wiki/concepts/agent）或 glob 模式（如 /wiki/concepts/*）

    精确路径返回：{path, title, content, tags, trust_level, updated_at}
    glob 模式返回：{documents: [...], count, total_chars}，总字符数限制 120K
    """
    return await t.wiki_read(path=path)


@mcp.tool()
async def wiki_write(
    path: str,
    content: str,
    title: str = "",
    tags: list[str] = None,
    mode: str = "create",
    old_str: str = "",
    new_str: str = "",
) -> dict:
    """
    写入或更新 wiki 文档。路径必须以 /wiki/ 开头。

    - path:    文档路径，如 /wiki/concepts/agent-memory
    - content: 文档内容（Markdown）
    - title:   标题，为空时从 content 首行 # 自动提取
    - tags:    标签列表，如 ["agent", "memory"]
    - mode:    create（新建）/ replace（全量替换）/ append（追加）/ str_replace（局部替换）
    - old_str: str_replace 模式：要替换的原始文本
    - new_str: str_replace 模式：替换后的新文本

    写入后自动分块并更新全文索引。
    """
    return await t.wiki_write(
        path=path,
        content=content,
        title=title or None,
        tags=tags,
        mode=mode,
        old_str=old_str or None,
        new_str=new_str or None,
    )


@mcp.tool()
async def wiki_ingest(file_path: str) -> dict:
    """
    导入本地 Markdown 文件到知识库。

    - file_path: 文件绝对路径，必须在 /home/hahaxiong83/mycc/ 目录下

    自动：
    - 生成 wiki 路径（/wiki/import/<相对路径>）
    - 提取标题
    - 分块写入
    - trust_level 设为 verified，source_type 设为 import
    """
    return await t.wiki_ingest(file_path=file_path)


# ─────────────────────────────────────────────
# 生命周期钩子（FastMCP 3.x 用 lifespan）
# ─────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app):
    yield
    await close_pool()

mcp._lifespan = lifespan


# ─────────────────────────────────────────────
# 入口
# ─────────────────────────────────────────────

if __name__ == "__main__":
    # 默认 stdio 模式，Claude Desktop / claude CLI 直接调用
    mcp.run()
