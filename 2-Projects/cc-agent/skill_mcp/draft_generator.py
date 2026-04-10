"""
Skill Draft 生成器
从执行轨迹生成结构化 Skill Markdown 草稿，写入 /wiki/skill-drafts/

流程：
1. 获取完整轨迹
2. 检查 eligible_for_draft
3. 生成 Skill Markdown（LLM 或纯模板）
4. 安全扫描
5. 写入 skill_registry + documents（scan=block 时不写 documents）
6. 写入 agent_outbox 通知
"""

import re
import json
import uuid
from typing import Optional, Callable, Awaitable


class _JSONEncoder(json.JSONEncoder):
    """处理 UUID 等不可直接序列化的类型"""
    def default(self, obj):
        if isinstance(obj, uuid.UUID):
            return str(obj)
        return super().default(obj)

from db import get_pool
from trajectory import get_trajectory
from security_guard import scan_content


# Skill draft 写入的根路径（不能写进 .claude/skills/）
DRAFT_ROOT = "/wiki/skill-drafts"


def _slugify(text: str) -> str:
    """将标题转成 URL-safe slug"""
    # 中文直接保留，转小写，空格/特殊字符转 -
    text = text.lower().strip()
    text = re.sub(r"[\s/\\:]+", "-", text)
    text = re.sub(r"[^\w\-\u4e00-\u9fff]", "", text)
    text = re.sub(r"-{2,}", "-", text)
    return text[:60]  # 限制长度


def _build_markdown_from_template(trajectory_data: dict) -> tuple[str, str]:
    """
    纯模板模式：从轨迹数据拼装 Skill Markdown，不依赖 LLM。

    返回 (slug, markdown_content)
    """
    traj = trajectory_data["trajectory"]
    steps = trajectory_data["steps"]
    decisions = trajectory_data["decisions"]
    frictions = trajectory_data["frictions"]

    task_title = traj.get("task_title", "未命名任务")
    task_description = traj.get("task_description", "")
    outcome = traj.get("outcome", "")
    trajectory_id = traj.get("id", "")

    slug = _slugify(task_title)

    # ── 触发条件：从任务描述提炼 ─────────────────────────────────────
    trigger_section = task_description.strip() or "（待补充）"

    # ── 步骤：提炼关键步骤 ────────────────────────────────────────────
    steps_lines = []
    for step in steps:
        step_no = step.get("step_no", "?")
        title = step.get("title") or step.get("content", "")[:80]
        tool_name = step.get("tool_name", "")
        phase = step.get("phase", "")
        line = f"{step_no}. [{phase}] {title}"
        if tool_name:
            line += f"（工具: {tool_name}）"
        steps_lines.append(line)
    steps_section = "\n".join(steps_lines) if steps_lines else "（无步骤记录）"

    # ── 决策记录 ─────────────────────────────────────────────────────
    decisions_lines = []
    for d in decisions:
        q = d.get("question", "")
        chosen = d.get("chosen_option", "")
        rationale = d.get("rationale", "")
        decisions_lines.append(f"- **{q}** → {chosen}（{rationale}）")
    decisions_section = "\n".join(decisions_lines) if decisions_lines else ""

    # ── 已知陷阱：从摩擦点提炼 ───────────────────────────────────────
    friction_lines = []
    for f in frictions:
        friction_type = f.get("friction_type", "")
        desc = f.get("description", "")
        resolution = f.get("resolution", "")
        severity = f.get("severity", "medium")
        line = f"- [{severity}][{friction_type}] {desc}"
        if resolution:
            line += f"\n  → 解决方式: {resolution}"
        friction_lines.append(line)
    frictions_section = "\n".join(friction_lines) if friction_lines else "（无摩擦记录）"

    # ── 验证：从 outcome 或最后一步提炼 ──────────────────────────────
    if outcome:
        validation_section = outcome
    elif steps:
        last_step = steps[-1]
        validation_section = last_step.get("tool_result") or last_step.get("content", "（无验证记录）")
    else:
        validation_section = "（无验证记录）"

    # ── 拼装完整 Markdown ─────────────────────────────────────────────
    parts = [
        "---",
        f"name: {slug}",
        f"description: {task_title}",
        "status: draft",
        f"origin_trajectory: {trajectory_id}",
        "scan_status: pending",  # 扫描后会替换
        "---",
        "",
        f"# {task_title}",
        "",
        "## 触发条件",
        "",
        trigger_section,
        "",
        "## 步骤",
        "",
        steps_section,
        "",
    ]

    if decisions_section:
        parts += [
            "## 决策记录",
            "",
            decisions_section,
            "",
        ]

    parts += [
        "## 已知陷阱",
        "",
        frictions_section,
        "",
        "## 验证",
        "",
        validation_section,
        "",
    ]

    return slug, "\n".join(parts)


async def generate_skill_draft(
    trajectory_id: str,
    llm_call_fn: Optional[Callable[[str], Awaitable[str]]] = None,
) -> dict:
    """
    从完整轨迹生成 Skill draft Markdown。

    参数：
    - trajectory_id: 轨迹 ID
    - llm_call_fn: 可选，异步函数 (prompt: str) -> str，用于 LLM 生成
                   如果不提供，使用纯模板拼装

    返回：
    {
      "ok": bool,
      "slug": str,
      "path": str,           # /wiki/skill-drafts/{slug}
      "scan_status": str,    # pass / warn / block
      "skill_id": int,       # skill_registry 主键
      "doc_id": str | None,  # documents UUID（block 时为 None）
      "message": str,
    }
    """
    pool = await get_pool()

    # 1. 获取完整轨迹
    trajectory_data = await get_trajectory(trajectory_id)
    if "error" in trajectory_data:
        return {"ok": False, "message": trajectory_data["error"]}

    traj = trajectory_data["trajectory"]

    # 2. 检查 eligible_for_draft
    if not traj.get("eligible_for_draft", False):
        return {
            "ok": False,
            "message": (
                f"轨迹 {trajectory_id} 不符合生成条件（complexity_score < 5 且无摩擦点）"
            ),
        }

    # 3. 生成 Skill Markdown
    if llm_call_fn:
        # 用 LLM 生成（调用方提供）
        task_title = traj.get("task_title", "未命名任务")
        task_description = traj.get("task_description", "")
        steps_summary = "\n".join(
            f"  {s['step_no']}. [{s['phase']}] {s.get('title') or s.get('content','')[:100]}"
            for s in trajectory_data["steps"]
        )
        frictions_summary = "\n".join(
            f"  - [{f['severity']}] {f['description']} → {f.get('resolution','')}"
            for f in trajectory_data["frictions"]
        )
        outcome = traj.get("outcome", "")

        prompt = (
            f"你是一个技能提炼助手。根据以下任务执行轨迹，生成一份可复用的 Skill Markdown 文档。\n\n"
            f"任务标题：{task_title}\n"
            f"任务描述：{task_description}\n\n"
            f"执行步骤摘要：\n{steps_summary}\n\n"
            f"摩擦点：\n{frictions_summary or '无'}\n\n"
            f"执行结果：{outcome}\n\n"
            "请生成 Skill Markdown，格式如下：\n"
            "---\n"
            "name: {slug}\n"
            "description: {一句话描述}\n"
            "status: draft\n"
            f"origin_trajectory: {trajectory_id}\n"
            "scan_status: pending\n"
            "---\n\n"
            "## 触发条件\n"
            "## 步骤\n"
            "## 已知陷阱\n"
            "## 验证\n"
        )
        markdown_raw = await llm_call_fn(prompt)

        # 从 LLM 输出提取 slug（从 frontmatter）
        slug_match = re.search(r"^name:\s*(.+)$", markdown_raw, re.MULTILINE)
        slug = slug_match.group(1).strip() if slug_match else _slugify(traj.get("task_title", "skill"))
        skill_markdown = markdown_raw
    else:
        # 纯模板模式
        slug, skill_markdown = _build_markdown_from_template(trajectory_data)

    # 4. 安全扫描
    scan_result = scan_content(skill_markdown)
    scan_status = scan_result.status  # pass / warn / block

    # 替换 frontmatter 中的 scan_status: pending
    skill_markdown = skill_markdown.replace(
        "scan_status: pending",
        f"scan_status: {scan_status}",
    )

    draft_path = f"{DRAFT_ROOT}/{slug}"

    # 5a. 写入 skill_registry（无论 block 与否都写，block 时 status=blocked）
    registry_status = "blocked" if scan_status == "block" else "draft"

    skill_id_row = await pool.fetchrow(
        """
        INSERT INTO skill_registry
            (skill_name, slug, title, status, source_type,
             wiki_path, content, origin_trajectory_id, scan_status)
        VALUES ($1, $2, $3, $4, 'draft_wiki', $5, $6, $7, $8)
        ON CONFLICT (slug) DO UPDATE
            SET status = EXCLUDED.status,
                content = EXCLUDED.content,
                scan_status = EXCLUDED.scan_status,
                wiki_path = EXCLUDED.wiki_path,
                updated_at = now()
        RETURNING id
        """,
        slug,                              # skill_name
        slug,                              # slug
        traj.get("task_title", slug),      # title
        registry_status,                   # status
        draft_path,                        # wiki_path
        skill_markdown,                    # content
        trajectory_id,                     # origin_trajectory_id
        scan_status,                       # scan_status
    )
    skill_id = skill_id_row["id"]

    # 5a-2. 写入扫描结果到 skill_scan_results
    await pool.execute(
        """
        INSERT INTO skill_scan_results
            (skill_id, scanner_version, status, risk_level,
             dangerous_commands, secrets, prompt_injection, findings)
        VALUES ($1, '1.0', $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
        """,
        skill_id,
        scan_result.status,
        scan_result.risk_level,
        json.dumps(scan_result.dangerous_commands, ensure_ascii=False),
        json.dumps(scan_result.secrets, ensure_ascii=False),
        json.dumps(scan_result.prompt_injection, ensure_ascii=False),
        json.dumps(scan_result.findings, ensure_ascii=False),
    )

    # 5b. 写入 documents 表（block 时跳过）
    doc_id = None
    if scan_status != "block":
        doc_row = await pool.fetchrow(
            """
            INSERT INTO documents
                (path, title, content, tags, source_type, trust_level)
            VALUES ($1, $2, $3, $4, 'skill_draft', 'draft')
            ON CONFLICT (path) DO UPDATE
                SET content = EXCLUDED.content,
                    updated_at = now()
            RETURNING id::text
            """,
            draft_path,
            traj.get("task_title", slug),
            skill_markdown,
            traj.get("tags") or [],
        )
        doc_id = doc_row["id"]

    # 6. 写入 agent_outbox 通知
    payload = json.dumps(
        {
            "type": "skill_draft_generated",
            "trajectory_id": trajectory_id,
            "slug": slug,
            "path": draft_path,
            "scan_status": scan_status,
            "skill_id": str(skill_id),
            "doc_id": str(doc_id) if doc_id else None,
            "findings": scan_result.findings,
        },
        ensure_ascii=False,
    )
    await pool.execute(
        """
        INSERT INTO agent_outbox (event_type, payload, status)
        VALUES ('skill_draft_generated', $1::jsonb, 'pending')
        """,
        payload,
    )

    # 7. 返回结果
    msg_parts = [f"Skill draft 已生成: {draft_path}（扫描: {scan_status}）"]
    if scan_status == "block":
        msg_parts.append(f"⚠️ 扫描阻断，未写入文档。发现: {scan_result.findings}")
    elif scan_status == "warn":
        msg_parts.append(f"⚠️ 扫描警告: {scan_result.findings}")

    return {
        "ok": True,
        "slug": slug,
        "path": draft_path,
        "scan_status": scan_status,
        "skill_id": skill_id,
        "doc_id": doc_id,
        "message": " | ".join(msg_parts),
    }
