"""
用量统计 - 记录每次调用到 PostgreSQL 的 model_usage 表
PG 连接: postgresql://cc:ccagent2026@127.0.0.1:5433/cc_agent
"""
import os
import logging
from typing import Optional

import asyncpg

logger = logging.getLogger(__name__)

_PG_DSN = os.environ.get("PG_URL", "postgresql://cc:ccagent2026@127.0.0.1:5433/cc_agent")

# 建表 DDL（与 init.sql 列名一致：model_name, agent_name, cost_usd）
_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS model_usage (
    id            BIGSERIAL PRIMARY KEY,
    model_name    TEXT NOT NULL,
    task_type     TEXT,
    agent_name    TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    latency_ms    INTEGER,
    cost_usd      NUMERIC(10,6),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_usage_model ON model_usage (model_name, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_agent ON model_usage (agent_name, created_at);
"""


async def _get_conn() -> asyncpg.Connection:
    return await asyncpg.connect(_PG_DSN)


async def ensure_table() -> None:
    """确保 model_usage 表存在（应用启动时调用一次）"""
    conn = await _get_conn()
    try:
        await conn.execute(_CREATE_TABLE_SQL)
    finally:
        await conn.close()


async def record_usage(
    model: str,
    task_type: Optional[str],
    agent: Optional[str],
    input_tokens: int,
    output_tokens: int,
    latency_ms: int,
    cost: float,
) -> None:
    """写入一条调用记录（参数化查询，防 SQL 注入）"""
    conn = await _get_conn()
    try:
        await conn.execute(
            """
            INSERT INTO model_usage
                (model_name, task_type, agent_name, input_tokens, output_tokens, latency_ms, cost_usd)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            model, task_type, agent, input_tokens, output_tokens, latency_ms, cost,
        )
    finally:
        await conn.close()


async def get_usage_summary(days: int = 7) -> dict:
    """
    查询最近 N 天用量汇总，返回按模型/任务类型/Agent 分组的统计
    """
    conn = await _get_conn()
    try:
        # 按模型汇总
        by_model = await conn.fetch(
            """
            SELECT
                model_name,
                COUNT(*)               AS calls,
                SUM(input_tokens)      AS total_input,
                SUM(output_tokens)     AS total_output,
                ROUND(AVG(latency_ms)) AS avg_latency_ms,
                ROUND(SUM(cost_usd)::numeric, 4) AS total_cost
            FROM model_usage
            WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
            GROUP BY model_name
            ORDER BY total_cost DESC
            """,
            str(days),
        )

        # 按任务类型汇总
        by_task = await conn.fetch(
            """
            SELECT
                COALESCE(task_type, 'unknown') AS task_type,
                COUNT(*)               AS calls,
                SUM(input_tokens + output_tokens) AS total_tokens,
                ROUND(SUM(cost_usd)::numeric, 4) AS total_cost
            FROM model_usage
            WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
            GROUP BY task_type
            ORDER BY calls DESC
            """,
            str(days),
        )

        # 按 Agent 汇总
        by_agent = await conn.fetch(
            """
            SELECT
                COALESCE(agent_name, 'direct') AS agent_name,
                COUNT(*)               AS calls,
                SUM(input_tokens + output_tokens) AS total_tokens,
                ROUND(SUM(cost_usd)::numeric, 4) AS total_cost
            FROM model_usage
            WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
            GROUP BY agent_name
            ORDER BY calls DESC
            """,
            str(days),
        )

    finally:
        await conn.close()

    return {
        "days": days,
        "by_model": [dict(r) for r in by_model],
        "by_task_type": [dict(r) for r in by_task],
        "by_agent": [dict(r) for r in by_agent],
    }
