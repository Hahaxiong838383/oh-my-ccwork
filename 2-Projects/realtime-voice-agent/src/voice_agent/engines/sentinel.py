"""结束哨兵流式剥离(说完即挂断,2026-07-30 同事需求 §五方案 B)。

租户大脑在告别语末尾输出约定哨兵(如 ``[[END_SESSION]]``),agent 从 LLM 输出流
中剥离——**必须在 TTS/transcript 之前**(llm_node 层),保证哨兵绝不被念出、
也不进字幕;检出后由上层等本轮播放完毕再结束会话。

流式难点:哨兵可能被任意切分到多个 chunk(``[[END`` + ``_SESSION]]``),
所以尾部持有"疑似哨兵前缀"暂不放行,直到确认是/不是。纯函数类,可单测。
"""

from __future__ import annotations


class SentinelStripper:
    """流式文本过滤器:剥离哨兵(支持跨 chunk 分割),检出置 ``found``。"""

    def __init__(self, sentinel: str) -> None:
        if not sentinel:
            raise ValueError("sentinel 不能为空")
        self._sentinel = sentinel
        self._buf = ""
        self.found = False

    def feed(self, chunk: str) -> str:
        """喂入一个 chunk,返回当前可安全放行的文本(可能为空串)。"""
        self._buf += chunk
        while self._sentinel in self._buf:
            self.found = True
            self._buf = self._buf.replace(self._sentinel, "", 1)
        # 尾部若是哨兵的真前缀,扣住等下一 chunk 定夺
        hold = 0
        max_hold = min(len(self._sentinel) - 1, len(self._buf))
        for i in range(max_hold, 0, -1):
            if self._sentinel.startswith(self._buf[-i:]):
                hold = i
                break
        out = self._buf[: len(self._buf) - hold]
        self._buf = self._buf[len(self._buf) - hold :]
        return out

    def flush(self) -> str:
        """流结束:释放扣住的尾巴(此时已确认不是完整哨兵,原样放行)。"""
        out, self._buf = self._buf, ""
        return out


__all__ = ["SentinelStripper"]
