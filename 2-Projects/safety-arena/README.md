# safety-arena

> 串行 vs 并行**安全架构**的横向、白盒对比测试平台。
> 一句话:验证「实时安全控制(并行 + arbiter)是否真的优于阻断式安全(串行)」——而且能公平、可证伪地验证。

## 这是什么

给安全对话 Agent 做架构 A/B 的**实验仪器**,不是 demo。对比对象:

- **Baseline(串行阻断)**:Classifier 先判 → 通过才让 LLM 生成 → 输出。零泄漏,但延迟高。
- **Proposed(并行 + speculative + arbiter)**:LLM 边生成边流式输出,Classifier 并行跑,Arbiter 实时决定放行 / 暂存 / 截断 / 改写 / 取消。延迟低,但有「拦截前已泄漏」的风险。

## 核心设计:capture-once → replay-many

不让两条 pipeline 各打一次 LLM(LLM 非确定 → 两次生成不可比,replay 变成"重摇")。而是:

1. **Capture**:一次输入,真实 SUT(LLM + Classifier)只跑一次,把 **token 流 + 风险信号流**按时间戳录成一条 `Trace`(单一真相源,落库)。
2. **Replay**:同一条 `Trace` 喂给 N 个**策略**(Serial-block / Parallel buffer=k / Arbiter A/B/C)离线重放。
3. **Metrics**:在受控条件下算 latency 向量 / **leakage** / 干预率。

好处:对比完全受控(消除 LLM 随机性)、便宜(一次生成 N 次评估)、天然全白盒(每个 token×时刻的信号与决策都在 trace 里可逐帧回看)。

## 两个可扫旋钮(并行架构的命门)

- `classifier 延迟注入`:并行优势只在 classifier **相对生成够慢**时才成立 → 扫它看优势区间。
- `buffer 深度 k`:hold 住 k 个 token 等信号。`k=0` 零延迟但必泄漏;`k=∞` 退化成串行。这条 **latency↔leakage 权衡曲线**就是结论本身。

## 最该量的指标:leakage(不是只看末态安全)

并行的全部风险点 = token 已流给用户,arbiter 才喊停 → 用户**已经看到了不安全前缀**。只看最终输出安全率会把这个致命泄漏漏掉。核心指标是**拦截前暴露的 unsafe token 数 / 暴露时长**。

## latency 是向量不是标量

`TTFT`(首 token)/ `首个安全 token 时间` / `总完成时间` / `首次干预时间` 分开报。并行赢在 TTFT,但加 buffer 防泄漏后 TTFT 回退——必须看向量。

## 状态

- [x] M0 核心引擎:数据模型 / capture / replay / 3 策略 / metrics + 确定性 mock + 单测(纯逻辑,不碰真实 LLM)
- [x] M1 服务层:FastAPI + SSE 流式 timeline + SQLite trace 落库 + /docs 交互(REST: capture/traces/replay/scan;SSE: replay/stream)
- [x] M2 Web 可视化:单页(零构建,FastAPI 直接 serve `/`)= SSE timeline 动画 + 四策略对比表 + diff + buffer 权衡曲线
- [ ] M3 接真实 SUT(可插拔 provider;若用于语音/小可,接其生产 classifier + LLM)
- [ ] M4 安全 judge(可插拔 + 校准)算 unsafe-output-rate

## 布局

```
src/safety_arena/
  models.py          # Trace / Event / Decision / ReplayResult 数据模型
  providers/         # SUT 抽象 + 确定性 mock(M3 接真实 LLM)
  capture.py         # 跑 SUT → Trace
  strategies/        # serial_block / parallel_buffer / arbiter(可插拔)
  replay.py          # Trace × Strategy → ReplayResult
  metrics.py         # 聚合 latency 向量 / leakage / 干预率
tests/               # 确定性 fixtures + 单测
```

## 跑

```bash
uv sync
uv run pytest -q                      # 15 个测试(引擎 + 服务)
uv run python -m safety_arena.demo    # 离线对比(不起服务,直接看对比表 + 两条权衡曲线)

uv run python -m safety_arena.server  # 起服务(默认 127.0.0.1:8800,PORT 可改)
# 浏览器开 http://127.0.0.1:8800/      → Web 可视化(timeline 动画 + 对比表 + diff + 曲线)
# 浏览器开 http://127.0.0.1:8800/docs  → API(Swagger)
```

SSE timeline 示例(token 逐帧 emit + 仲裁决策按 t_ms 流式):

```bash
curl -N "http://127.0.0.1:8800/api/replay/stream?trace_id=harm-early::mock&strategy=parallel-buffer:0&speed=20"
```
