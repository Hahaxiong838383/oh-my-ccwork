"""
数据库连接池管理
复用 wiki_mcp 的模式，使用 asyncpg 连接 PostgreSQL + PGroonga
"""

import os
import asyncpg
from typing import Optional

# 数据库连接字符串（优先从环境变量读取）
DATABASE_URL = os.environ.get("PG_URL", "postgresql://cc:ccagent2026@127.0.0.1:5433/cc_agent")

# 全局连接池
_pool: Optional[asyncpg.Pool] = None


async def get_pool() -> asyncpg.Pool:
    """获取数据库连接池，懒初始化"""
    global _pool
    if _pool is None:
        try:
            _pool = await asyncpg.create_pool(
                DATABASE_URL,
                min_size=2,
                max_size=10,
                command_timeout=30,
            )
        except Exception as e:
            raise RuntimeError(f"数据库连接失败: {e}\n请确认 PostgreSQL 在 127.0.0.1:5433 上运行") from e
    return _pool


async def close_pool():
    """关闭连接池（服务停止时调用）"""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
