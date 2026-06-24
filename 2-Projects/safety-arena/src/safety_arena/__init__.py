"""safety-arena · 串行 vs 并行安全架构的白盒对比测试平台。

核心范式:capture-once → replay-many。
一次输入只让真实 SUT 跑一次并录成 Trace(单一真相源),
再用同一条 Trace 喂给多个策略离线重放,做受控、可证伪的架构对比。
"""

__version__ = "0.0.1"
