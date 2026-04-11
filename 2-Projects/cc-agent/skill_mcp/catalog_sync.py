"""
.claude/skills/ 目录同步到 skill_registry 表

扫描本地已验证的 skill 文件，保持数据库与文件系统一致：
- 新发现的 skill → INSERT
- 已有的 skill 内容变了 → UPDATE
- 数据库有但文件已删 → 标记 archived
"""

import os
import re
import hashlib
from pathlib import Path

from db import get_pool

# 本地 Skill 目录（不修改，只读）
SKILLS_DIR = "/home/hahaxiong83/mycc/.claude/skills"

# 识别 Skill 文件的文件名（大小写均可）
SKILL_FILENAMES = {"SKILL.md", "skill.md"}


def _read_skill_file(file_path: Path) -> dict:
    """
    读取 Skill 文件，提取 frontmatter + 内容。

    返回：
    {
      "name": str,      # skill 名（从目录名或 frontmatter 提取）
      "slug": str,
      "description": str,
      "content": str,   # 完整文件内容
      "tags": list,
      "file_path": str,
    }
    """
    content = file_path.read_text(encoding="utf-8")

    # 提取 frontmatter（--- ... ---）
    name = ""
    description = ""
    tags = []

    fm_match = re.match(r"^---\s*\n(.*?)\n---\s*\n", content, re.DOTALL)
    if fm_match:
        fm_text = fm_match.group(1)
        for line in fm_text.splitlines():
            line = line.strip()
            if line.startswith("name:"):
                name = line[5:].strip().strip("'\"")
            elif line.startswith("description:"):
                description = line[12:].strip().strip("'\"")
            elif line.startswith("tags:"):
                # 简单解析 tags: [a, b] 或 tags: a, b
                raw_tags = line[5:].strip().strip("[]")
                tags = [t.strip().strip("'\"") for t in raw_tags.split(",") if t.strip()]

    # 如果 frontmatter 没有 name，用目录名作为 name
    if not name:
        name = file_path.parent.name

    # 如果没有 description，尝试从首行 # 标题提取
    if not description:
        for line in content.splitlines():
            if line.startswith("# "):
                description = line[2:].strip()
                break

    slug = re.sub(r"[^\w\-\u4e00-\u9fff]", "", name.lower().replace(" ", "-"))

    return {
        "name": name,
        "slug": slug or file_path.parent.name,
        "description": description,
        "content": content,
        "tags": tags,
        "file_path": str(file_path),
    }


def _content_hash(content: str) -> str:
    """计算内容 MD5，用于变更检测"""
    return hashlib.md5(content.encode("utf-8")).hexdigest()


async def sync_verified_skills() -> dict:
    """
    扫描 .claude/skills/ 目录下所有 SKILL.md / skill.md 文件，
    同步到 skill_registry 表（source_type='verified_fs', status='active'）。

    - 新发现的 skill → INSERT
    - 已有的 skill 内容变了 → UPDATE
    - 数据库有但文件已删 → 标记 archived

    返回: {added: N, updated: N, archived: N, errors: [...]}
    """
    pool = await get_pool()

    # ── 扫描本地文件 ─────────────────────────────────────────────────
    local_skills: dict[str, dict] = {}  # slug → skill_info

    skills_root = Path(SKILLS_DIR)
    if not skills_root.exists():
        return {"added": 0, "updated": 0, "archived": 0, "errors": [f"目录不存在: {SKILLS_DIR}"]}

    for skill_file in skills_root.rglob("*"):
        if skill_file.name in SKILL_FILENAMES:
            try:
                info = _read_skill_file(skill_file)
                slug = info["slug"]
                # 如果 slug 冲突，后发现的覆盖（理论上不应有重名）
                local_skills[slug] = info
            except Exception as e:
                pass  # 读取失败的文件跳过

    # ── 读取数据库中所有 verified_fs skill ───────────────────────────
    db_rows = await pool.fetch(
        """
        SELECT slug, content, status
        FROM skill_registry
        WHERE source_type = 'verified_fs'
        """
    )
    db_slugs: dict[str, dict] = {row["slug"]: dict(row) for row in db_rows}

    added = 0
    updated = 0
    archived = 0
    errors = []

    # ── 处理本地文件：INSERT 或 UPDATE ───────────────────────────────
    for slug, info in local_skills.items():
        new_hash = _content_hash(info["content"])
        try:
            if slug not in db_slugs:
                # 新技能 → INSERT
                await pool.execute(
                    """
                    INSERT INTO skill_registry
                        (skill_name, slug, title, summary, status, source_type,
                         content, tags, fs_path, scan_status)
                    VALUES ($1, $2, $3, $4, 'active', 'verified_fs',
                            $5, $6, $7, 'pass')
                    ON CONFLICT (slug) DO NOTHING
                    """,
                    info["name"],
                    slug,
                    info["description"] or info["name"],
                    info["description"],
                    info["content"],
                    info["tags"],
                    info["file_path"],
                )
                added += 1
            else:
                existing = db_slugs[slug]
                existing_hash = _content_hash(existing.get("content") or "")
                if existing_hash != new_hash or existing.get("status") == "archived":
                    # 内容变了或曾被 archived → UPDATE
                    await pool.execute(
                        """
                        UPDATE skill_registry
                        SET skill_name = $2,
                            title = $3,
                            summary = $4,
                            status = 'active',
                            content = $5,
                            tags = $6,
                            fs_path = $7,
                            scan_status = 'pass',
                            updated_at = now()
                        WHERE slug = $1 AND source_type = 'verified_fs'
                        """,
                        slug,
                        info["name"],
                        info["description"] or info["name"],
                        info["description"],
                        info["content"],
                        info["tags"],
                        info["file_path"],
                    )
                    updated += 1
        except Exception as e:
            errors.append(f"处理 {slug} 失败: {e}")

    # ── 处理数据库中有但本地已删除的 skill ───────────────────────────
    for slug, row in db_slugs.items():
        if slug not in local_skills and row.get("status") != "archived":
            try:
                await pool.execute(
                    """
                    UPDATE skill_registry
                    SET status = 'archived', updated_at = now()
                    WHERE slug = $1 AND source_type = 'verified_fs'
                    """,
                    slug,
                )
                archived += 1
            except Exception as e:
                errors.append(f"归档 {slug} 失败: {e}")

    return {
        "added": added,
        "updated": updated,
        "archived": archived,
        "total_local": len(local_skills),
        "errors": errors,
    }
