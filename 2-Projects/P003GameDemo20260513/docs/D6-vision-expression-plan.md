# D6 P1 表情感知方案规划 V0.2（评审整合稿）

> **回滚锚点**：git tag `p003-v0.9-stable` (commit `d04adb91a`)
> 任何时候: `git reset --hard p003-v0.9-stable && git push --force-with-lease`（**川哥确认才能 force push**）

## §0. 评审整合 Header

| 评审 | Verdict | 关键改动 | 落实位置 |
|---|---|---|---|
| Codex（架构） | NEEDS_FIX → 采纳 A' | 工程细节 6 条 + 单飞锁 + toBlob + 离屏透明 + zod 白名单 | §3-§5 + §10 |
| Gemini（产品） | NEEDS_TWEAK → 采纳 | confidence ≥0.8 阈值 + 授权铺垫 + 合规边界 | §0 / §6-§9 |

**V0.1 → V0.2 关键变化**：
1. **架构定型 A'**：scene 切换瞬间预抓拍 + 5s 后台兜底；ttsSpeak **永远零等待**，保住 D5 P20-21 字幕严同步。
2. **拒绝 codex 推荐的"滞后一拍" A 方案**：P003 90% 单句场景，A 会让 demo 表情系统几乎全场失效。
3. **新增 confidence 档**：Gemini 返置信度，<0.8 强制走 neutral，防"笑被判 tired"现场翻车。
4. **合规闭环**：demo 可云，商业化前必转端侧（face-api.js / MediaPipe FaceMesh）。
5. **UX 护航**：SetupGuide 加"小可想看看你是谁"铺垫；首次抓拍成功小可说"我看到你啦"；拒绝场景 0.3 概率说"我看不到你呢"。

## §1. 目标

每次小可开口前 0.5-1.5s 内（由 **scene 切换预抓拍**触发）拿到用户表情 → 注入字幕/TTS 文本，让小可对当前用户状态做出"人设感"反馈。

**真正可感受的效果**：
- 孩子笑 → 小可说"看你笑得这么开心，欢迎回到方舟！"
- 孩子皱眉 → 小可说"今天看着有点累呢，要不要先休息一下？"
- 抓不到 / confidence 低 / 摄像头拒绝 → 退回 V0.9 原字幕，零退化

**不在 D6 P1 范围**：
- 实时持续抓帧（除 5s 后台兜底外）
- 多人脸 / 性别 / 年龄识别
- 本地 face-api.js 集成（D6 P3 商业化路线）
- LLM 实时融合（D6 P2 再做）

## §2. 架构图（A' 时序）

```text
[Scene 切换链 · 主触发]
jumpToScene(scene) / scene transition hook
  └─ fire-and-forget: expressionSnapshot.snapIfStale()
       ├─ 若 inFlightPromise 存在: 复用同一请求（单飞锁）
       ├─ 抓帧 + 上传 (≤1.5s client timeout)
       └─ ~1.2s 后写入 currentRef = { expr, confidence, at }

[发声链 · 零等待]
ttsSpeak(text)
  ├─ 同步读取 currentRef.expr（不 await）
  ├─ prefix = EXPR_INTRO[currentRef.expr]（neutral 时为空）
  └─ sayDirect(prefix + text)

[后台兜底链]
App mount
  └─ setInterval(5000): snapIfStale()
       └─ 仅当 Date.now() - currentRef.at > 3000 才触发抓拍

[冷启动专属]
SetupGuide 完成配网按钮 onClick（同 unlockAudio 手势栈）
  └─ expressionSnapshot.snap() 预触发，保 Welcome 首句带表情
```

**核心约束**：`ttsSpeak` 路径永不 `await ensureExpression()`。预抓拍跟发声**解耦**，用 demo 既有过场动画时间（4.5s 飞船 / 2.5s 静思 / 0.8s fade）覆盖 vision 1.2s 延迟。

**时序窗口实测**：

| Scene | 过场窗口 | vision 1.2s 是否够 |
|---|---|---|
| Welcome | SetupGuide → Welcome ~500ms + 首字打字机 200ms | ✅ 提前到按钮 onClick 预抓 |
| 夜航报告 | jumpToScene fade 300ms | ⚠️ 略紧，靠 3s TTL 缓存复用 |
| 出航 launching | 4.5s 飞船过渡 | ✅ 绰绰有余 |
| 静思 launching | 2.5s 单图过渡 | ✅ 够 |
| reward | focusRunning 16s 期间已刷新 | ✅ 缓存命中 |
| Farewell | 返舱 fade 800ms | ✅ 够 |

## §3. 文件清单

### 新增

| 文件 | 作用 |
|------|------|
| `apps/web/src/services/expression-snapshot.ts` | **模块单例** + `inFlightPromise` 单飞锁 + TTL 缓存 + `snap` / `snapIfStale`（对齐 voice-client 模式，StrictMode 兼容） |
| `apps/web/src/components/CameraPermissionGate.tsx` | 摄像头授权 UI（挂 SetupGuide 完成配网按钮）|
| `apps/web/src/config/expression-intros.ts` | expr → intro 文案映射表 |
| `apps/server/src/routes/vision.ts` | POST /api/vision/expression 端点 |
| `apps/server/src/services/gemini-vision.ts` | Gemini Vision 调用 + zod 输出清洗 |

> **命名变更**：V0.1 的 `vision-client.ts` → V0.2 改 `expression-snapshot.ts`（语义更准 + 强调单例）。

### 修改

| 文件 | 改动 |
|------|------|
| `apps/web/src/scenes/SetupGuide.tsx` | 完成配网按钮 onClick：①`requestCameraPermission()` ② `expressionSnapshot.snap()` 预触发（与 unlockAudio 同手势栈）|
| `apps/web/src/machines/index.ts` | `jumpToScene` / `scene transition` 入口挂 `expressionSnapshot.snapIfStale()`（fire-and-forget）；`ttsSpeak` 同步读 `currentRef.expr` 拼前缀，**不 await** |
| `apps/web/src/App.tsx`（或主入口） | mount 后启动 `setInterval(snapIfStale, 5000)` 后台兜底 |
| `apps/server/src/server.ts` | 注册 /api/vision/expression 路由 |
| `apps/server/.env.local` | 加 GEMINI_API_KEY（已有，复用）|

## §4. 接口契约（V0.2）

### `POST /api/vision/expression`

```
请求
  Content-Type: application/json
  Body: { jpegBase64: string }   // 无 "data:image/jpeg;base64," 前缀
  约束: base64 长度 ≤ 50KB，超限 server 直接 413

响应 200
  { expr: ExpressionLabel, confidence: number, latencyMs: number }
  confidence ∈ [0, 1]

响应 4xx
  { error: string }

超时
  客户端 1500ms cancel
  server 端 3000ms 强制返 { expr: 'no_face', confidence: 0 }
```

### Server 端 zod 白名单（关键）

```ts
const LabelSchema = z.enum(['happy', 'tired', 'curious', 'neutral', 'no_face']);
const VisionOutSchema = z.object({
  label: LabelSchema,
  confidence: z.number().min(0).max(1),
});
const parsed = VisionOutSchema.safeParse(modelJson);
const out = parsed.success ? parsed.data : { label: 'no_face', confidence: 0 };
```

### 客户端 confidence 阈值（关键）

```ts
const { expr, confidence } = resp;
const safeExpr = confidence < 0.8 || expr === 'no_face' ? 'neutral' : expr;
currentRef.expr = safeExpr;
currentRef.at = Date.now();
```

### Gemini Vision prompt（让 Gemini 同返置信度）

```
你是一个儿童面部表情识别系统。看这张照片中的人脸，从以下标签中选一个最贴近的：
- happy (开心、微笑、大笑)
- tired (疲倦、打哈欠、揉眼睛)
- curious (好奇、惊讶、睁大眼睛)
- neutral (无明显情绪)
- no_face (画面里没有人脸)

返回 JSON：{"label": "<标签>", "confidence": <0.0-1.0>}
只返回 JSON，不要任何其他内容、解释或代码块标记。
```

### 客户端缓存

```ts
interface ExpressionSnapshot {
  expr: 'happy' | 'neutral' | 'tired' | 'curious' | 'no_face';
  confidence: number;
  at: number;  // Date.now()
}
const EXPRESSION_TTL_MS = 3000;  // 3s 内复用缓存
const BACKGROUND_REFRESH_MS = 5000;  // 5s 后台兜底
```

### intro 文案表

```ts
const EXPR_INTRO: Record<Expression, string> = {
  happy: '看你笑得这么开心，',
  tired: '今天看着有点累呢，',
  curious: '睁大眼睛在看什么？',
  neutral: '',
  no_face: '',
};
```

## §5. Phase 拆分（修订版）

### P1：摄像头权限 + getUserMedia + 离屏透明 video（1.5h）
- 加 `<video>` 元素到 DeviceFrame，样式 `position:absolute; opacity:0; pointer-events:none; width:1px; height:1px`（**不**用 `display:none`，避免某些浏览器停解码）
- `getUserMedia({ video: { width: 320, height: 240 } })`
- CameraPermissionGate 挂 SetupGuide 按钮（手势栈）
- 拒绝：`cameraUnavailable` flag + `sessionStorage` 持久化 → 全程走 neutral
- 铺垫文案（见 §9）

### P2：snap() 模块单例 + toBlob + inFlightPromise + 5s 后台兜底（2h）
- `expression-snapshot.ts` **模块级单例**（非组件 ref，避免 React StrictMode 双 mount 冲突）
- `canvas.toBlob(blob, 'image/jpeg', 0.7)` 取代 `toDataURL`（异步、稳定）
- `inFlightPromise` 单飞锁：并发请求复用同一 Promise，避免 3s TTL 期间并发雪崩
- `EXPRESSION_TTL_MS = 3000` 缓存复用
- `setInterval(snapIfStale, 5000)` 后台兜底

### P3：server Gemini Vision + zod 白名单（1.5h）
- 调代理 4000 multimodal endpoint + prompt
- zod parse → 非法值 → `no_face`
- base64 长度上限 50KB → 413
- 3000ms 超时降级

### P4：jumpToScene hook + SetupGuide 预触发 + ttsSpeak 零等待集成（1h）
- `machines/index.ts` 在 `jumpToScene` 入口 + scene transition 入口挂 `expressionSnapshot.snapIfStale()`（fire-and-forget）
- SetupGuide onClick 同时调 `snap()`（手势栈 + 冷启动）
- `ttsSpeak` 路径**只同步读** `currentRef.expr`，**永不 await**
- 模板拼接：`${EXPR_INTRO[expr]}${effect.text}`

### P5：端到端测试 + 资源释放 + confidence 实测（1h）
- 切场景 / 组件卸载 / 盖关：`stream.getTracks().forEach(t => t.stop())` + `clearInterval`
- 真机授权流程实测
- 端到端跑 demo 测 confidence 分布
- 暗光 / 逆光压测（展会场景模拟）
- 模板拼接视觉验收

**总工时 7h（半天 + 1h）**

## §6. 兜底链（V0.2 扩展）

```
摄像头不可用（拒绝/无设备）→ cameraUnavailable flag → neutral → 原字幕
       ↓
抓拍失败（canvas 异常）→ 缓存复用 → 缓存也无 → neutral
       ↓
上传超时 1.5s → 缓存复用 → 缓存也无 → neutral
       ↓
server 端 Gemini Vision 失败 / 3s 超时 → no_face → neutral
       ↓
**新增** confidence < 0.8 → neutral（防表错情翻车）
       ↓
任意环节失败都不阻塞 TTS，最多回退 V0.9 原字幕
```

**核心原则**：任意环节失败都不阻塞 TTS。`ttsSpeak` 永不等 vision，最坏 currentRef 为 neutral → 走 V0.9 原字幕。

## §7. 风险表（V0.2 更新）

| 风险 | 缓解 |
|------|------|
| iOS Safari getUserMedia 必须用户手势 | 挂 SetupGuide 按钮 onClick（与 unlockAudio 同手势栈）|
| 隐私敏感（儿童面孔上云）| server 端只取标签字符串，原图即用即抛不存盘；README 加隐私说明 |
| Gemini Vision $0.002/帧 | 3s TTL 节流 + 5s 后台兜底，整 demo $0.02，可忽略 |
| 摄像头位置不稳定（孩子动）| 抓不到人脸 → no_face → 走原字幕，无副作用 |
| 抓拍 + vision 比 TTS 慢 | A' 解耦：ttsSpeak 永不 await，预抓拍走 scene 过场时间 |
| iOS Safari 隐私 webcam 黑屏 | 二段策略：先尝试，失败 fallback neutral，不阻塞 |
| **错误标签现场翻车（笑被判 tired）** | **confidence < 0.8 强制 neutral；prompt 让 Gemini 同返置信度** |
| **展会暗光/逆光抓不准** | **现场暗光压测；no_face 时回原字幕；提前查场地光线** |
| **儿童面孔上云合规** | **demo 可云；商业化前必转端侧推理；server 不存图 + 即用即抛** |
| **React StrictMode 双 mount** | **expression-snapshot.ts 模块级单例 + inFlightPromise，对齐 voice-client** |
| **MediaStream 资源泄漏** | **切场景/卸载/盖关执行 `track.stop()` + `clearInterval`** |

## §8. 隐私合规章节

### 8.1 现状（demo 可云）
- server 端原图即用即抛，不落盘、不写日志
- Gemini 代理 4000 调用记录由代理方控制（已是川哥自建代理）
- 标签字符串无法重建人脸

### 8.2 商业化前必转端侧（路线图）
- 中国《个保法》第 31 条：处理 14 岁以下儿童个人信息需父母同意 + 制定专门规则
- 美国 COPPA：13 岁以下儿童面部信息属敏感生物信息，需 verifiable parental consent
- 欧盟 GDPR Art.9：生物特征数据原则禁止处理，例外极严
- **结论**：demo 阶段 ok；产品化前必须端侧推理（face-api.js 或 MediaPipe FaceMesh + 量化模型）

### 8.3 demo 阶段透明度
- README 新增「摄像头使用说明」段
- 界面加"摄像头使用中"绿点指示器（极小、不喧宾夺主），让现场家长/观察者可见
- SetupGuide 铺垫文案明示用途（见 §9）

## §9. 授权铺垫文案 + UX 引导

### 9.1 SetupGuide 完成配网按钮前铺垫（采用 A 版）
> 「小可想看看你是谁，可以打开摄像头吗？」

理由：合规友好（明示用途）+ 孩子能理解（拟人化但不卖萌过头）。
B 版（"让小可记住你的样子"）会触发"存储面部数据"的合规警觉，弃用。

### 9.2 第一次抓拍成功后小可说
- "我看到你啦"（仅首次，避免重复违和）
- 触发条件：CameraPermissionGate 通过 + 首次 snap() 返非 no_face

### 9.3 摄像头拒绝场景的优雅降级
- 不要完全静默 → 偶尔小可说一句"我看不到你呢，不过没关系"（每场景 0.3 概率触发）
- 避免家长以为系统坏了
- 不要循环说（每场景最多一次）

### 9.4 长时间无字幕触发时的表情新鲜度
- 5s 后台兜底刷新已覆盖（§2 后台兜底链）
- 体感无需向用户暴露

## §10. 关键工程细节修正（6 条最小代码示例）

### 10.1 模块单例 + inFlightPromise（snap 函数）

```ts
let shared: ExpressionSnapshotInstance | null = null;
let inFlightPromise: Promise<void> | null = null;

export function getExpressionSnapshot() {
  if (!shared) shared = createExpressionSnapshot();
  return shared;
}

export function snap(): Promise<void> {
  if (inFlightPromise) return inFlightPromise;
  inFlightPromise = doSnap().finally(() => { inFlightPromise = null; });
  return inFlightPromise;
}

export function snapIfStale(): Promise<void> {
  if (Date.now() - currentRef.at < EXPRESSION_TTL_MS) return Promise.resolve();
  return snap();
}
```

### 10.2 toBlob 异步替代 toDataURL（避免主线程阻塞）

```ts
const blob = await new Promise<Blob | null>((resolve) =>
  canvas.toBlob(resolve, 'image/jpeg', 0.7),
);
if (!blob) throw new Error('snapshot_failed');
const b64 = await blobToBase64(blob);
```

### 10.3 离屏透明 video 样式（不用 display:none）

```ts
const hiddenVideoStyle: React.CSSProperties = {
  position: 'absolute',
  opacity: 0,
  pointerEvents: 'none',
  width: '1px',
  height: '1px',
};
```

### 10.4 track.stop() 资源释放钩子

```ts
function disposeCamera(stream?: MediaStream) {
  stream?.getTracks().forEach((t) => t.stop());
}

useEffect(() => () => {
  disposeCamera(cameraStreamRef.current);
  if (timerRef.current) clearInterval(timerRef.current);
}, []);
```

### 10.5 zod 白名单 schema（server 端）

```ts
const LabelSchema = z.enum(['happy', 'tired', 'curious', 'neutral', 'no_face']);
const VisionOutSchema = z.object({
  label: LabelSchema,
  confidence: z.number().min(0).max(1),
});
const parsed = VisionOutSchema.safeParse(modelJson);
const out = parsed.success ? parsed.data : { label: 'no_face', confidence: 0 };
```

### 10.6 confidence < 0.8 → neutral（客户端）

```ts
const { expr, confidence } = resp;
const safeExpr = confidence < 0.8 || expr === 'no_face' ? 'neutral' : expr;
currentRef.expr = safeExpr;
currentRef.at = Date.now();
```

## §11. 验收标准

- [ ] 摄像头授权后 video stream 可见（debug 阶段隐藏元素改为可见）
- [ ] 每次 ttsSpeak 触发时 `currentRef.expr` 在 3s 内有效（log 验证）
- [ ] **`ttsSpeak` 路径无任何 `await ensureExpression()`**（grep 验证）
- [ ] expr='happy' 且 confidence ≥ 0.8 时字幕拼上"看你笑这么开心，"前缀
- [ ] confidence < 0.8 时字幕走 V0.9 原文（无前缀）
- [ ] 摄像头拒绝场景全程走 V0.9 原字幕，无报错；0.3 概率触发"我看不到你呢"
- [ ] vision 超时 1.5s 后用缓存或 neutral，TTS 不阻塞
- [ ] 整 demo 跑完 10 次表情触发，总 vision 调用 ≤ 15 次（节流生效）
- [ ] 切场景 / 卸载 / 盖关后摄像头指示灯熄灭（track.stop 生效）
- [ ] React StrictMode 双 mount 不导致并发雪崩（单飞锁验证）
- [ ] 暗光 / 逆光 / 侧逆光场景实测 confidence 分布

## §12. 不做（明确边界）

- ❌ 持续抓帧流（每帧上传）—— 贵 + 隐私 + 无感知收益
- ❌ 本地 face-api.js 集成（D6 P3 商业化路线，demo 阶段不做）
- ❌ 多人脸识别 —— demo 单儿童用户场景不需要
- ❌ 表情→自定义 LLM prompt —— D6 P2 再做
- ❌ 长期表情趋势分析 —— 不在 demo 范围
- ❌ **codex 的"滞后一拍"A 方案** —— P003 90% 单句场景会失效

## §13. D6 P1 上线后续 TODO

- D6 P2：LLM 对话场景表情融入（按住说话 → system prompt 注入）
- D6 P3：表情统计面板（debug 用，看 demo 期间 happy/tired 比例）+ 端侧推理 PoC
- D7：表情→剧情分支（开心宝箱概率↑，疲倦推荐静思）

## §14. 决策记录

| 项 | 选择 | 理由 |
|---|------|------|
| Vision API | Gemini-3 Flash via 代理 4000 | 已在用 + LLM 主线同提供商 + p95 1.2s |
| 客户端摄像头 | getUserMedia + canvas | 浏览器原生，零依赖 |
| 图片格式 | JPEG q=0.7, 320×240 (toBlob) | ~15KB / 上传<100ms / 异步不阻塞主线程 |
| 节流 | 3s TTL 缓存 + 5s 后台兜底 | 平衡新鲜度 vs 成本 vs 隐私 |
| **架构** | **A'（scene 切换预抓 + 后台兜底）** | **P003 90% 单句场景，A "滞后一拍" 会全场失效；A' 用 demo 既有过场时间换 vision 延迟** |
| 字幕融合 | 模板替换（A 路）| 零额外延迟，demo 节奏不动 |
| 失败默认 | neutral → V0.9 原字幕 | 完全退化 |
| 授权时机 | SetupGuide 完成配网按钮 + 铺垫文案 | 用户手势栈 + 一次性授权 + 合规友好 |
| 隐私 | server 不存图 + 即用即抛 | demo 可云，商业化必转端侧 |
| **置信度阈值** | **confidence < 0.8 → neutral** | **防"笑被判 tired"现场翻车** |
| **单例模式** | **模块级单例 + inFlightPromise** | **StrictMode 双 mount 兼容 + 并发雪崩防护** |
| **video 隐藏** | **离屏透明（非 display:none）** | **避免某些浏览器停解码** |

---

**当前状态**：V0.2 评审整合稿完工。codex（架构）+ gemini（产品）双引擎评审已采纳。等川哥拍板后开 P1 实施。

**评审产物溯源**：
- codex 原评审：`/tmp/codex_d6_review.log`（NEEDS_FIX）
- gemini 原评审：`/tmp/gemini_d6_review.log`（NEEDS_TWEAK）
- codex V0.2 工程草稿：`/tmp/d6_codex_v02_draft.md`
- gemini V0.2 产品草稿：`/tmp/d6_gemini_v02.log`
