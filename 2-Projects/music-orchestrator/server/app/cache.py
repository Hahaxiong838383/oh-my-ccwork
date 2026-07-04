"""LRU 文件缓存实现

使用文件 atime/mtime 做 LRU 依据。
MVP 阶段：先落盘再响应（非边下边传）。
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
from pathlib import Path
from typing import Tuple, Optional

logger = logging.getLogger(__name__)


class LRUFileCache:
    def __init__(self, cache_dir: str, max_mb: int):
        self.cache_dir = Path(cache_dir)
        self.max_bytes = max_mb * 1024 * 1024
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _key_to_filename(self, key: str) -> str:
        h = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
        return h

    def path_for(self, key: str) -> Path:
        # 默认给 .audio 扩展名，实际扩展名可由调用方在 key 中包含
        fname = self._key_to_filename(key)
        # 简单策略：如果 key 包含扩展信息则尝试提取，否则统一 .bin
        if "." in key and key.split(".")[-1].isalnum() and len(key.split(".")[-1]) <= 5:
            ext = key.split(".")[-1]
            return self.cache_dir / f"{fname}.{ext}"
        return self.cache_dir / f"{fname}.audio"

    def has(self, key: str) -> bool:
        p = self.path_for(key)
        return p.exists() and p.is_file()

    def touch(self, key: str) -> None:
        """更新访问时间（atime）"""
        p = self.path_for(key)
        if p.exists():
            # touch 更新 atime/mtime
            os.utime(p, None)

    def _get_size_and_atime(self, p: Path) -> Tuple[int, float]:
        try:
            stat = p.stat()
            # 优先用 atime 做 LRU，如果 atime 不可靠则用 mtime
            atime = stat.st_atime if stat.st_atime > 0 else stat.st_mtime
            return stat.st_size, atime
        except Exception:
            return 0, 0.0

    def prune(self, target_mb: Optional[int] = None) -> Tuple[int, int]:
        """删除最久未访问的文件直到总大小 <= target_mb（默认用自身 max）"""
        target = (target_mb or (self.max_bytes // (1024 * 1024))) * 1024 * 1024
        with self._lock:
            files = []
            total = 0
            for f in self.cache_dir.iterdir():
                if f.is_file():
                    size, atime = self._get_size_and_atime(f)
                    files.append((atime, size, f))
                    total += size

            if total <= target:
                return 0, 0

            # 按 atime 升序（最久未访问在前）
            files.sort(key=lambda x: x[0])

            pruned = 0
            freed = 0
            for atime, size, f in files:
                if total <= target:
                    break
                try:
                    f.unlink()
                    total -= size
                    pruned += 1
                    freed += size
                except Exception as e:
                    logger.warning(f"prune failed for {f}: {e}")

            freed_mb = freed // (1024 * 1024)
            logger.info(f"cache prune: removed {pruned} items, freed {freed_mb}MB")
            return pruned, freed_mb

    def write_file(self, key: str, content: bytes) -> Path:
        """原子写入 + 写入后 prune"""
        p = self.path_for(key)
        with self._lock:
            tmp = p.with_suffix(p.suffix + ".tmp")
            tmp.write_bytes(content)
            tmp.replace(p)
            # 写入后更新 atime
            os.utime(p, None)
        # 写入后检查是否需要 prune
        self.prune()
        return p
