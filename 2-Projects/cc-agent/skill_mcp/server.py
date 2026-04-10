"""
Skill Evolution Engine - MCP Server
cc 的自进化引擎：记录执行轨迹、管理技能库、生成 Skill 草稿。

使用方式：
  stdio 模式（Claude Desktop / claude --mcp）：
    python server.py

  HTTP 模式：
    fastmcp run server.py --transport streamable-http --port 8766
"""

import sys
import os
from contextlib import asynccontextmanager

# 确保能导入同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastmcp import FastMCP
from db import get_pool, close_pool
import trajectory as traj_ops
import draft_generator as draft_ops
import catalog_sync as catalog_ops
from security_guard import scan_content


mcp = FastMCP(
    name="skill-evolution-engine",
    instructions=(
        "cc 的自进化引擎。记录执行轨迹、管理技能库、生成 Skill 草稿。\n\n"
        "工作流程：\n"
        "1. 任务开始时调用 trajectory_open 创建轨迹\n"
        "2. 执行过程中调用 trajectory_step 记录步骤\n"
        "3. 遇到决策点调用 trajectory_decision\n"
        "4. 遇到摩擦/错误调用 trajectory_friction\n"
        "5. 任务结束调用 trajectory_close（复杂任务可开启 auto_draft=true）\n"
        "6. 搜索已有技能调用 skill_search\n\n"
        "注意：Skill draft 只写入 /wiki/skill-drafts/，绝不直写 .claude/skills/"
    ),
)


# ──────────────────────────────────────────────────────────────────────────────
# 工具 1：搜索技能库
# ──────────────────────────────────────────────────────────────────────────────

@mcp.tool()
async def skill_search(
    query: str,
    include_drafts: bool = True,
    limit: int = 10,
) -> dict:
    """
    搜索技能库（verified + draft），PGroonga 全文搜索。

    - query: 搜索关键词
    - include_drafts: 是否包含草稿（默认 True）
    - limit: 最多返回数量，最大 50

    返回：{results: [{slug, name, description, status, trust_level, score}], total}
    """
    limit = min(limit, 50)
    pool = await get_pool()

    # 构建 trust_level 过滤条件
    if include_drafts:
        trust_filter = ""
        params = [query, limit]
    else:
        trust_filter = "AND source_type = 'verified_fs'"
        params = [query, limit]

    rows = await pool.fetch(
        f"""
        SELECT slug, skill_name, title, summary, status,
               source_type, scan_status, wiki_path, fs_path,
               pgroonga_score(tableoid, ctid) AS score
        FROM skill_registry
        WHERE (title &@~ $1 OR content &@~ $1)
              AND status != 'archived'
              {trust_filter}
        ORDER BY score DESC, updated_at DESC
        LIMIT $2
        """,
        *params,
    )

    results = [dict(r) for r in rows]
    return {"results": results, "total": len(results), "query": query}


# ──────────────────────────────────────────────────────────────────────────────
# 工具 2：创建轨迹
# ──────────────────────────────────────────────────────────────────────────────

@mcp.tool()
async def trajectory_open(
    session_id: str,
    task_title: str,
    task_description: str,
    trigger_source: str = "cc",
) -> dict:
    """
    创建新轨迹，返回 trajectory_id。

    - session_id: 当前会话 ID（从 Claude Code 环境获取）
    - task_title: 任务标题（简短，20 字以内）
    - task_description: 任务详细描述
    - trigger_source: 触发来源（cc / feishu / wechat / cron）
    """
    trajectory_id = await traj_ops.open_trajectory(
        session_id=session_id,
        task_title=task_title,
        task_description=task_description,
        trigger_source=trigger_source,
    )
    return {
        "trajectory_id": trajectory_id,
        "message": f"轨迹已创建: {trajectory_id}",
    }


# ──────────────────────────────────────────────────────────────────────────────
# 工具 3：记录执行步骤
# ──────────────────────────────────────────────────────────────────────────────

@mcp.tool()
async def trajectory_step(
    trajectory_id: str,
    step_no: int,
    phase: str,
    step_type: str,
    title: str = "",
    content: str = "",
    tool_name: str = "",
    tool_result: str = "",
    model_name: str = "",
    agent_name: str = "",
) -> dict:
    """
    记录轨迹执行步骤。

    - trajectory_id: 轨迹 ID
    - step_no: 步骤序号（从 1 开始）
    - phase: 阶段（plan / execute / verify / debug）
    - step_type: 类型（tool_call / reasoning / observation / action）
    - title: 步骤标题（简短描述）
    - content: 步骤内容/思考（可较长）
    - tool_name: 调用的工具名（如有）
    - tool_result: 工具返回摘要（如有，限 500 字）
    - model_name: 执行该步的模型
    - agent_name: 执行该步的 agent
    """
    step_id = await traj_ops.append_step(
        trajectory_id=trajectory_id,
        step_no=step_no,
        phase=phase,
        step_type=step_type,
        title=title,
        content=content,
        tool_name=tool_name,
        tool_result=tool_result,
        model_name=model_name,
        agent_name=agent_name,
    )
    return {
        "step_id": step_id,
        "message": f"步骤 {step_no} 已记录",
    }


# ──────────────────────────────────────────────────────────────────────────────
# 工具 4：记录决策
# ──────────────────────────────────────────────────────────────────────────────

@mcp.tool()
async def trajectory_decision(
    trajectory_id: str,
    question: str,
    chosen_option: str,
    rationale: str,
    decision_type: str = "design",
    confidence: float = 0.0,
    model_name: str = "",
) -> dict:
    """
    记录执行过程中的关键决策。

    - trajectory_id: 轨迹 ID
    - question: 面临的决策问题（如"选哪种存储方案？"）
    - chosen_option: 最终选择
    - rationale: 选择理由（简短）
    - decision_type: design / implementation / debug / scope
    - confidence: 置信度 0.0~1.0
    - model_name: 做出决策的模型
    """
    decision_id = await traj_ops.record_decision(
        trajectory_id=trajectory_id,
        question=question,
        chosen_option=chosen_option,
        rationale=rationale,
        decision_type=decision_type,
        confidence=confidence,
        model_name=model_name,
    )
    return {
        "decision_id": decision_id,
        "message": f"决策已记录: {question[:40]}",
    }


# ──────────────────────────────────────────────────────────────────────────────
# 工具 5：记录摩擦点
# ──────────────────────────────────────────────────────────────────────────────

@mcp.tool()
async def trajectory_friction(
    trajectory_id: str,
    friction_type: str,
    description: str,
    severity: str = "medium",
    resolution: str = "",
) -> dict:
    """
    记录执行过程中遇到的摩擦、错误或阻塞。

    - trajectory_id: 轨迹 ID
    - friction_type: error / misunderstanding / retry / user_correction / tool_failure
    - description: 摩擦描述（发生了什么）
    - severity: low / medium / high
    - resolution: 如何解决的（可以后补）
    """
    friction_id = await traj_ops.record_friction(
        trajectory_id=trajectory_id,
        friction_type=friction_type,
        description=description,
        severity=severity,
        resolution=resolution,
    )
    return {
        "friction_id": friction_id,
        "message": f"摩擦点已记录 [{severity}]: {description[:40]}",
    }


# ──────────────────────────────────────────────────────────────────────────────
# 工具 6：关闭轨迹
# ──────────────────────────────────────────────────────────────────────────────

@mcp.tool()
async def trajectory_close(
    trajectory_id: str,
    outcome: str,
    summary: str,
    models_used: list = None,
    tags: list = None,
    auto_draft: bool = False,
) -> dict:
    """
    关闭轨迹，记录最终结果。

    - trajectory_id: 轨迹 ID
    - outcome: 执行结果（success / failure / partial）
    - summary: 任务摘要（50 字以内）
    - models_used: 使用的模型列表（如 ["claude-sonnet-4-6", "deepseek-chat"]）
    - tags: 标签（如 ["部署", "nginx", "NAS"]）
    - auto_draft: 是否自动生成 Skill 草稿（eligible 时才会生成）

    返回轨迹统计 + 可选的 draft 生成结果。
    """
    close_result = await traj_ops.close_trajectory(
        trajectory_id=trajectory_id,
        outcome=outcome,
        summary=summary,
        models_used=models_used,
        tags=tags,
    )

    result = {
        "trajectory_id": trajectory_id,
        "outcome": outcome,
        **close_result,
        "message": (
            f"轨迹已关闭。complexity_score={close_result['complexity_score']}, "
            f"eligible_for_draft={close_result['eligible_for_draft']}"
        ),
    }

    # 如果开启 auto_draft 且符合条件，自动生成草稿
    if auto_draft and close_result.get("eligible_for_draft"):
        draft_result = await draft_ops.generate_skill_draft(trajectory_id)
        result["draft"] = draft_result
        if draft_result.get("ok"):
            result["message"] += f" | Skill draft 已生成: {draft_result['path']}"
        else:
            result["message"] += f" | Draft 生成失败: {draft_result.get('message')}"

    return result


# ──────────────────────────────────────────────────────────────────────────────
# 工具 7：手动触发 Skill draft 生成
# ──────────────────────────────────────────────────────────────────────────────

@mcp.tool()
async def skill_draft_generate(trajectory_id: str) -> dict:
    """
    从指定轨迹生成 Skill 草稿。

    先进行安全扫描，通过后写入 /wiki/skill-drafts/{slug}。
    block 级别的内容只写入 skill_registry（标记 blocked），不写 documents。

    - trajectory_id: 已关闭的轨迹 ID（status=completed）
    """
    result = await draft_ops.generate_skill_draft(trajectory_id)
    return result


# ──────────────────────────────────────────────────────────────────────────────
# 工具 8：安全扫描
# ──────────────────────────────────────────────────────────────────────────────

@mcp.tool()
async def skill_scan(content: str) -> dict:
    """
    对文本内容进行安全扫描。

    检测：
    - 危险命令（rm -rf /、curl|bash、反弹 shell 等）
    - 硬编码密钥（API Key、密码、Token）
    - Prompt Injection 攻击

    返回：
    {
      "status": "pass" | "warn" | "block",
      "risk_level": "low" | "medium" | "high" | "critical",
      "dangerous_commands": [...],
      "secrets": [...],
      "prompt_injection": [...],
      "findings": [...]
    }
    """
    result = scan_content(content)
    return {
        "status": result.status,
        "risk_level": result.risk_level,
        "dangerous_commands": result.dangerous_commands,
        "secrets": result.secrets,
        "prompt_injection": result.prompt_injection,
        "findings": result.findings,
    }


# ──────────────────────────────────────────────────────────────────────────────
# 生命周期钩子
# ──────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app):
    yield
    await close_pool()

mcp._lifespan = lifespan


# ──────────────────────────────────────────────────────────────────────────────
# 入口
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # 默认 stdio 模式
    mcp.run()
