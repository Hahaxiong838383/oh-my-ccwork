"""
文本分块逻辑
- 按段落分割（双换行）
- 每块目标 ~512 token（1 char ≈ 0.25 token，即 ~2048 chars）
- 128 token 重叠（~512 chars）
- 跟踪 Markdown 标题层级，生成 header_breadcrumb
"""

import re
from dataclasses import dataclass
from typing import List, Optional

# token 估算常数（1 char ≈ 0.25 token）
CHARS_PER_TOKEN = 4
TARGET_CHUNK_TOKENS = 512
OVERLAP_TOKENS = 128

TARGET_CHUNK_CHARS = TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN   # 2048 chars
OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN             # 512 chars

# Markdown 标题正则
HEADING_RE = re.compile(r'^(#{1,6})\s+(.+)$', re.MULTILINE)


@dataclass
class Chunk:
    chunk_index: int
    content: str
    header_breadcrumb: str   # 如 "## 概念 > ### 子章节"


def _extract_heading(line: str) -> Optional[tuple[int, str]]:
    """从行中提取标题层级和文本，非标题返回 None"""
    m = HEADING_RE.match(line.strip())
    if m:
        level = len(m.group(1))
        text = m.group(2).strip()
        return level, text
    return None


def _build_breadcrumb(heading_stack: List[tuple[int, str]]) -> str:
    """将标题栈拼成面包屑字符串"""
    if not heading_stack:
        return ""
    return " > ".join(f"{'#' * lvl} {txt}" for lvl, txt in heading_stack)


def chunk_text(content: str) -> List[Chunk]:
    """
    将文档内容分割成带面包屑的 Chunk 列表。

    策略：
    1. 按段落（双换行）切分
    2. 遇到标题段落更新 heading_stack
    3. 累积段落直到达到目标大小，然后输出一个 chunk
    4. 使用重叠保证上下文连续性
    """
    # 按双换行分段
    paragraphs = re.split(r'\n\n+', content.strip())

    chunks: List[Chunk] = []
    heading_stack: List[tuple[int, str]] = []   # [(level, text), ...]

    # 当前累积缓冲
    buffer: List[str] = []
    buffer_chars = 0
    chunk_index = 0

    # 重叠缓冲（上一个 chunk 末尾的段落）
    overlap_buffer: List[str] = []

    def flush_chunk(paras: List[str], breadcrumb: str) -> None:
        nonlocal chunk_index
        text = "\n\n".join(paras).strip()
        if not text:
            return
        chunks.append(Chunk(
            chunk_index=chunk_index,
            content=text,
            header_breadcrumb=breadcrumb,
        ))
        chunk_index += 1

    def build_overlap(paras: List[str]) -> List[str]:
        """从段落列表末尾取出不超过 OVERLAP_CHARS 的段落作为重叠"""
        result = []
        total = 0
        for p in reversed(paras):
            if total + len(p) > OVERLAP_CHARS:
                break
            result.insert(0, p)
            total += len(p)
        return result

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        # 检测标题（段落首行即标题）
        first_line = para.split('\n')[0]
        heading = _extract_heading(first_line)
        if heading:
            level, text = heading
            # 弹出同级或更深的标题，保持栈的层级正确
            heading_stack = [(lvl, txt) for lvl, txt in heading_stack if lvl < level]
            heading_stack.append((level, text))

        para_chars = len(para)

        # 如果加入当前段落后超出目标大小，先 flush
        if buffer and buffer_chars + para_chars > TARGET_CHUNK_CHARS:
            breadcrumb = _build_breadcrumb(heading_stack)
            flush_chunk(buffer, breadcrumb)
            # 重叠：取 buffer 末尾部分
            overlap_buffer = build_overlap(buffer)
            buffer = list(overlap_buffer)
            buffer_chars = sum(len(p) for p in buffer)

        buffer.append(para)
        buffer_chars += para_chars

    # 处理剩余段落
    if buffer:
        breadcrumb = _build_breadcrumb(heading_stack)
        flush_chunk(buffer, breadcrumb)

    return chunks
