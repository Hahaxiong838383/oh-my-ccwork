# HANDOFF: 9B TTFT + 视觉注入排查

## 问题

1. **9B TTFT 20-38s**（目标 <10s）
2. **9B 不感知摄像头画面**（Gemini 同场景下正常）

## 已完成

- memory-intake JSON 截断容错（`parseFactsFromResponse` 括号补全）已部署
- intake 路由改为 Mini ollama qwen2.5:7b（`data/model-config-overrides.json`）
- Mini ollama 已改为 `0.0.0.0:11434` 监听（plist 已改）

## 已知问题（下个 session 修）

### 1. Mini 网络不通
- `EHOSTUNREACH 10.9.1.54:11434`
- 原因：Mini IP 可能变了（DHCP），或两台机器不在同一子网
- 修复：确认 Mini 当前 IP，考虑固定 IP 或用 hostname

### 2. prediction-engine require 错误
- `ReferenceError: require is not defined` at prediction-engine.ts:284 和 :641
- 原因：ESM 项目中用了 `require()`
- 影响：每次 Admin API 请求都报错，可能影响性能
- 修复：改为 `import()` 或 `readFileSync`

### 3. 视觉注入不生效（核心问题）
- `latest.json` 实时更新（daemon 正常）
- `semantic-latest.json` 也有数据
- 但 9B prompt 中没有摄像头内容
- **排查方向**：
  - `visual-state.ts` 的 `getVisualState()` 返回什么？`stale` 是否为 true？
  - `formatEnvironmentHint()` 输出是否为空？
  - 在 `brain-api.ts:313` 加日志打印 `environmentHint` 长度
  - Gemini 走同一条 `route.brain=true` 路径但能正常显示视觉 → 问题可能在 9B 对 system prompt 的理解能力

### 4. 20s TTFT 的本质
- 即使 intake 不争抢，9B prefill 2500+ token prompt 在 M2 Max 上本身就需要 ~15s
- 视觉注入（~200 token）+ 记忆注入（19 条）+ SOUL prompt + 用户状态 = prompt 膨胀
- **方向**：压缩 system prompt，或者接受 9B 的 TTFT 限制，把 9B 定位为 fallback

## 关键文件
- `src/brain-api.ts:266` — 视觉获取 `route.brain ? getVisualState() : null`
- `src/brain-api.ts:313` — 环境提示注入 `formatEnvironmentHint(visual)`
- `src/services/visual-state.ts:50` — STALE_THRESHOLD_MS = 60_000
- `src/services/memory-intake.ts` — JSON 截断容错
- `src/services/prediction-engine.ts:284,641` — require 错误
- `data/model-config-overrides.json` — intake 路由配置

### 5. intake 连 Mini EHOSTUNREACH（核心阻塞）
- Node.js 独立运行 `fetch("http://192.168.100.1:11434/api/tags")` 能通
- 但 PM2 进程内的 brain 连不上，报 `EHOSTUNREACH ... Local (192.168.100.2:64611)`
- NO_PROXY 已设，系统代理已关，防火墙已关
- **高度怀疑 PM2 进程继承了旧的网络 context**——解法：`pm2 delete brain && pm2 start` 重建进程而非 restart
- fallback 用了 9B 模型跑 intake（37s），严重抢 GPU
- **紧急修复**：先禁 fallback（删除 config 中 fallbackIntake），让 intake 失败就失败，不抢 9B

### 6. 9B fallback intake 输出 thinking 而非 JSON
- 9B 的 Qwen3.5 默认开 thinking，输出 chain-of-thought 而非 JSON
- 解法：intake 调 9B 时需要加 `enable_thinking: false` 或在 prompt 里强制 `no_think`

## 可粘贴提示词

```
继续排查 9B TTFT + 视觉注入问题。HANDOFF 在 2-Projects/brain-product/HANDOFF-9b-issues.md。
紧急优先级：
1) pm2 delete brain && pm2 start 重建进程（而非 restart），测试 intake 是否能连 Mini 192.168.100.1:11434
2) 如果还不通，先在 overrides 里删 fallbackIntake 或设为 null，阻止 9B 跑 intake 抢 GPU
3) 在 brain-api 加日志看 formatEnvironmentHint 输出（视觉注入排查）
4) 修 prediction-engine 的 require 错误
```
