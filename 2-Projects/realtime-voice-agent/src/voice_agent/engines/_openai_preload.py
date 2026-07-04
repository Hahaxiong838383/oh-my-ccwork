"""Side-effect 预载模块:注入 forkserver preload 列表,在 forkserver 进程内一次性
付清 openai SDK 的惰性 import 税。

openai SDK 1.x 惰性加载:首次访问 ``client.chat`` 才 import resources 树 + pydantic
建模(纯 CPU 1s+ 且持 GIL)。2026-07-03 py-spy 栈实锤:这笔税原先在 job 进程的
prewarm 协程里支付,恰被调度进 ``ctx.connect`` 的 ReadyForRoomEventRequest
deadline(rust 1s,liblivekit_ffi 内写死)窗口 → event loop 饿死 → FFI panic 秒崩;
挪进 setup_fnc 后又因补位进程 initialize 变重(叠加 nice 让路)触发 10s 超时
杀进程→重 spawn 的循环。终解=官方 ``livekit.agents.inference._warmup`` 同款
范式:app.py 把本模块注册为 Plugin package,livekit 在 forkserver 模式下自动将
其加入 ``set_forkserver_preload`` 列表 → forkserver import 一次,所有 fork 出的
子进程经 COW 继承已加载模块,idle 补位与 job 路径全部零 openai 税。

fork 安全:纯模块 import(不起线程/不建连接/不构造 client)。
macOS/spawn 开发环境无 forkserver preload,由 setup_fnc 里的兜底预载覆盖。
"""

import openai.lib.streaming.chat  # noqa: F401  (chat completions 流式解析依赖,明确兜底)
import openai.resources  # noqa: F401  (顶层 __init__ 传递 import chat/beta/completions 全树)
