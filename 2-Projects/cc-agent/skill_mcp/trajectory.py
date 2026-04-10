"""
轨迹存储操作
负责创建、追加、关闭执行轨迹，以及记录决策点和摩擦点

依赖表（由另一个 Agent 负责建表）：
- trajectories        轨迹头
- trajectory_steps    执行步骤
- trajectory_decisions 决策记录
- trajectory_frictions 摩擦点
"""

import json
from typing import Optional
from db import get_pool


async def open_trajectory(
    session_id: str,
    task_title: str,
    task_description: str,
    trigger_source: str = "cc",
) -> str:
    """
    创建轨迹头，返回 trajectory_id (UUID str)

    - session_id: Claude Code 会话 ID
    - task_title: 任务标题（简短）
    - task_description: 任务详细描述
    - trigger_source: 触发来源，默认 cc
    """
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        INSERT INTO trajectories (session_id, task_title, task_description, trigger_source, status)
        VALUES ($1, $2, $3, $4, 'open')
        RETURNING id::text
        """,
        session_id,
        task_title,
        task_description,
        trigger_source,
    )
    return row["id"]


async def append_step(
    trajectory_id: str,
    step_no: int,
    phase: str,
    step_type: str,
    title: str = "",
    content: str = "",
    tool_name: str = "",
    tool_args: Optional[dict] = None,
    tool_result: str = "",
    model_name: str = "",
    agent_name: str = "",
    status: str = "completed",
) -> int:
    """
    追加执行步骤，返回 step_id

    - trajectory_id: 轨迹 ID
    - step_no: 步骤序号（从 1 开始）
    - phase: 阶段（如 plan / execute / verify）
    - step_type: 类型（tool_call / reasoning / observation / action）
    - title: 步骤标题
    - content: 步骤内容/思考
    - tool_name: 调用的工具名
    - tool_args: 工具参数（dict）
    - tool_result: 工具返回结果（字符串摘要）
    - model_name: 执行该步的模型
    - agent_name: 执行该步的 agent（cc/codex/gemini 等）
    - status: completed / failed / skipped
    """
    pool = await get_pool()
    tool_args_json = json.dumps(tool_args or {}, ensure_ascii=False)
    row = await pool.fetchrow(
        """
        INSERT INTO trajectory_steps
            (trajectory_id, step_no, phase, step_type, title, content,
             tool_name, tool_args, tool_result, model_name, agent_name, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
        RETURNING id
        """,
        trajectory_id,
        step_no,
        phase,
        step_type,
        title,
        content,
        tool_name,
        tool_args_json,
        tool_result,
        model_name,
        agent_name,
        status,
    )
    return row["id"]


async def record_decision(
    trajectory_id: str,
    question: str,
    chosen_option: str,
    rationale: str,
    decision_type: str = "design",
    confidence: float = 0.0,
    step_id: Optional[int] = None,
    model_name: str = "",
) -> int:
    """
    记录决策点，返回 decision_id

    - trajectory_id: 轨迹 ID
    - question: 面临的决策问题
    - chosen_option: 选择了哪个选项
    - rationale: 选择理由
    - decision_type: 决策类型（design / implementation / debug / scope）
    - confidence: 置信度 0.0~1.0
    - step_id: 关联的步骤 ID（可选）
    - model_name: 做出决策的模型
    """
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        INSERT INTO trajectory_decisions
            (trajectory_id, step_id, question, chosen_option, rationale,
             decision_type, confidence, model_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
        """,
        trajectory_id,
        step_id,
        question,
        chosen_option,
        rationale,
        decision_type,
        confidence,
        model_name,
    )
    return row["id"]


async def record_friction(
    trajectory_id: str,
    friction_type: str,
    description: str,
    impact: str = "",
    resolution: str = "",
    severity: str = "medium",
    resolved: bool = False,
    step_id: Optional[int] = None,
) -> int:
    """
    记录摩擦点，返回 friction_id

    - trajectory_id: 轨迹 ID
    - friction_type: 类型（error / misunderstanding / retry / user_correction / tool_failure）
    - description: 摩擦描述
    - impact: 对任务的影响
    - resolution: 如何解决的
    - severity: low / medium / high
    - resolved: 是否已解决
    - step_id: 关联的步骤 ID（可选）
    """
    pool = await get_pool()
    # impact 不在表中，如有则拼入 description
    full_desc = description
    if impact:
        full_desc = f"{description}（影响: {impact}）"
    row = await pool.fetchrow(
        """
        INSERT INTO trajectory_frictions
            (trajectory_id, step_id, friction_type, description,
             resolution, severity, resolved)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
        """,
        trajectory_id,
        step_id,
        friction_type,
        full_desc,
        resolution,
        severity,
        resolved,
    )
    return row["id"]


async def close_trajectory(
    trajectory_id: str,
    outcome: str,
    summary: str,
    models_used: Optional[list] = None,
    tags: Optional[list] = None,
) -> dict:
    """
    关闭轨迹，更新 status/outcome/summary/ended_at。

    计算 complexity_score = step 数 + friction 数 * 2
    eligible_for_draft = complexity_score >= 5 or has_friction

    返回：{id, complexity_score, tool_count, has_friction, eligible_for_draft}
    """
    pool = await get_pool()

    # 统计步骤数
    step_count = await pool.fetchval(
        "SELECT COUNT(*) FROM trajectory_steps WHERE trajectory_id = $1",
        trajectory_id,
    )

    # 统计工具调用数（step_type = tool_call）
    tool_count = await pool.fetchval(
        """
        SELECT COUNT(*) FROM trajectory_steps
        WHERE trajectory_id = $1 AND tool_name != ''
        """,
        trajectory_id,
    )

    # 统计摩擦点数
    friction_count = await pool.fetchval(
        "SELECT COUNT(*) FROM trajectory_frictions WHERE trajectory_id = $1",
        trajectory_id,
    )

    step_count = step_count or 0
    tool_count = tool_count or 0
    friction_count = friction_count or 0

    # 计算复杂度分
    complexity_score = int(step_count) + int(friction_count) * 2
    has_friction = friction_count > 0
    eligible_for_draft = complexity_score >= 5 or has_friction

    # 更新轨迹状态（只更新表中实际存在的列）
    models_json = json.dumps(models_used or [], ensure_ascii=False)
    await pool.execute(
        """
        UPDATE trajectories
        SET status = 'completed',
            outcome = $2,
            summary = $3,
            models_used = $4::jsonb,
            tags = $5,
            complexity_score = $6,
            tool_count = $7,
            ended_at = now()
        WHERE id = $1
        """,
        trajectory_id,
        outcome,
        summary,
        models_json,
        tags or [],
        complexity_score,
        int(tool_count),
    )

    return {
        "id": trajectory_id,
        "complexity_score": complexity_score,
        "tool_count": int(tool_count),
        "has_friction": has_friction,
        "eligible_for_draft": eligible_for_draft,
    }


async def get_trajectory(trajectory_id: str) -> dict:
    """
    获取完整轨迹（头 + steps + decisions + frictions），用于生成 Skill draft

    返回 dict 包含：
    - trajectory: 轨迹头信息
    - steps: 执行步骤列表
    - decisions: 决策记录列表
    - frictions: 摩擦点列表
    """
    pool = await get_pool()

    # 读取轨迹头
    trajectory = await pool.fetchrow(
        "SELECT * FROM trajectories WHERE id = $1",
        trajectory_id,
    )
    if not trajectory:
        return {"error": f"轨迹 {trajectory_id} 不存在"}

    # 读取步骤
    steps = await pool.fetch(
        """
        SELECT * FROM trajectory_steps
        WHERE trajectory_id = $1
        ORDER BY step_no ASC
        """,
        trajectory_id,
    )

    # 读取决策
    decisions = await pool.fetch(
        """
        SELECT * FROM trajectory_decisions
        WHERE trajectory_id = $1
        ORDER BY created_at ASC
        """,
        trajectory_id,
    )

    # 读取摩擦点
    frictions = await pool.fetch(
        """
        SELECT * FROM trajectory_frictions
        WHERE trajectory_id = $1
        ORDER BY created_at ASC
        """,
        trajectory_id,
    )

    def row_to_dict(row):
        """asyncpg Record 转 dict，处理不可序列化类型"""
        d = dict(row)
        for k, v in d.items():
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
        return d

    traj_dict = row_to_dict(trajectory)
    # 补充计算字段（不在数据库中）
    cs = traj_dict.get("complexity_score", 0) or 0
    has_friction = len(frictions) > 0
    traj_dict["has_friction"] = has_friction
    traj_dict["eligible_for_draft"] = cs >= 5 or has_friction

    return {
        "trajectory": traj_dict,
        "steps": [row_to_dict(r) for r in steps],
        "decisions": [row_to_dict(r) for r in decisions],
        "frictions": [row_to_dict(r) for r in frictions],
    }
