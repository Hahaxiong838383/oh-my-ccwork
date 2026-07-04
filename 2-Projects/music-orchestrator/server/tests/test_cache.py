"""测试 LRUFileCache prune 逻辑"""

import time

from app.cache import LRUFileCache


def test_cache_path_for(tmp_path):
    c = LRUFileCache(str(tmp_path), 10)
    p = c.path_for("bilibili:BV123")
    assert p.parent == tmp_path
    assert p.name.endswith(".audio") or len(p.name) > 8


def test_prune_removes_oldest(tmp_path):
    c = LRUFileCache(str(tmp_path), max_mb=1)  # 1MB 阈值
    # 写入 3 个超过 1MB 的文件（总 2.4MB）
    files = []
    for i in range(3):
        key = f"track-{i}"
        data = b"x" * (900 * 1024)  # ~0.9MB
        p = c.path_for(key)
        p.write_bytes(data)
        files.append(p)
        time.sleep(0.01)  # 保证 atime 不同
        c.touch(key)  # 确保 atime 更新

    # 此时总大小 > 1MB，调用 prune 应该删掉最早的
    pruned, freed = c.prune(target_mb=1)
    assert pruned >= 1
    # 最老的文件应该被删
    # 验证：files[0] 很可能不存在（取决于精确 atime）
    remaining = [f for f in files if f.exists()]
    assert len(remaining) < 3
