# D6 P1 表情感知方案规划（评审稿）

> **回滚锚点**：git tag `p003-v0.9-stable` (commit `d04adb91a`)
> 任何时候: `git reset --hard p003-v0.9-stable && git push --force-with-lease`（**川哥确认才能 force push**）

## 1. 目标

每次小可开口前 0.5-1.5s 内抓拍用户当前表情 → 上传云端 Gemini Flash Vision → 拿到表情描述 → 注入字幕/TTS 文本，让小可对当前用户状态做出"人设感"反馈。

**真正可感受的效果**：
- 孩子笑 → 小可说"看你笑得这么开心，欢迎回到方舟！"
- 孩子皱眉 → 小可说"今天看着有点累呢，要不要先休息一下？"
- 抓不到 → 退回原始字幕，零退化

**不在 D6 P1 范围**：
- 实时持续抓帧 (>1 帧/3s)
- 多人脸 / 性别 / 年龄识别
- 本地 face-api.js 集成
- LLM 实时融合（D6 P2 再做）

## 2. 架构图

```
┌─ 浏览器 (web HTTPS) ──────────────────────────┐
│ <video hidden> ← getUserMedia                  │
│       ↓ 抓帧                                    │
│ canvas (320×240) → JPEG q=0.7 (~15KB) → base64 │
│       ↓                                        │
│ visionClient.snapAndDetect()                   │
│   ↓ wait <= 1.5s                               │
│ currentExpressionRef = { expr, at }            │
└────────────────────────────────────────────────┘
       ↓ ttsSpeak 前 ensureExpression()
       ↓ POST /api/vision/expression
┌─ apps/server (Hono) ──────────────────────────┐
│ /api/vision/expression                         │
│   ↓ Gemini-3 Flash Vision (via 代理 4000)      │
│   ↓ prompt: "用 1 个标签描述这张人脸主要情绪    │
│       从 happy/neutral/tired/curious/no_face   │
│       选一个，只返回标签"                       │
│   ↓ 1.2s p95                                   │
│ → JSON { expr: "happy", conf: 0.86 }           │
└────────────────────────────────────────────────┘
       ↓ 缓存 currentExpressionRef
       ↓ ttsSpeak 内查表
EXPR_INTRO[expr] + 原始字幕 → setSubtitle + sayDirect
```

## 3. 文件清单

### 新增

| 文件 | 作用 |
|------|------|
| `apps/web/src/services/vision-client.ts` | getUserMedia + canvas 抓帧 + 压缩 + 上传 + 缓存 |
| `apps/web/src/components/CameraPermissionGate.tsx` | 摄像头授权 UI（挂 SetupGuide 完成配网按钮）|
| `apps/web/src/config/expression-intros.ts` | expr → intro 文案映射表 |
| `apps/server/src/routes/vision.ts` | POST /api/vision/expression 端点 |
| `apps/server/src/services/gemini-vision.ts` | Gemini Vision 调用封装 |
| `docs/D6-vision-expression-plan.md` | 本文档 |

### 修改

| 文件 | 改动 |
|------|------|
| `apps/web/src/scenes/SetupGuide.tsx` | 配网按钮 onClick 加 requestCameraPermission()（与 unlockAudio 同手势栈）|
| `apps/web/src/machines/index.ts` | applyEffects setSubtitle case 内 await ensureExpression() + 拼字幕；ttsSpeak 同样 |
| `apps/server/src/server.ts` | 注册 /api/vision/expression 路由 |
| `apps/server/.env.local` | 加 GEMINI_API_KEY（已有，复用）|

## 4. 接口契约

### `/api/vision/expression`

```
POST /api/vision/expression
Content-Type: application/json
Body: { jpegBase64: string }  // 不含 "data:image/jpeg;base64," 前缀

Response 200: { expr: 'happy' | 'neutral' | 'tired' | 'curious' | 'no_face', latencyMs: number }
Response 4xx: { error: string }
Timeout: 客户端 1500ms 超时即取消，server 端 3000ms 后强制返 no_face
```

**Gemini Vision prompt**（精确控制输出）：
```
你是一个儿童面部表情识别系统。看这张照片中的人脸，从以下标签中选一个最贴近的：
- happy (开心、微笑、大笑)
- tired (疲倦、打哈欠、揉眼睛)
- curious (好奇、惊讶、睁大眼睛)
- neutral (无明显情绪)
- no_face (画面里没有人脸)

只返回标签字符串，不要任何其他内容、引号或解释。
```

### 客户端缓存

```ts
interface ExpressionSnapshot {
  expr: 'happy' | 'neutral' | 'tired' | 'curious' | 'no_face';
  at: number;  // Date.now()
}

const EXPRESSION_TTL_MS = 3000;
// 3s 内复用缓存，避免抓拍过频
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

## 5. Phase 拆分

### P0：回滚锚点
- ✅ `git tag p003-v0.9-stable` + push（已完成）

### P1：摄像头权限 + 视频源（1.5h）
- 加 `<video>` 隐藏元素到 DeviceFrame
- vision-client 内 getUserMedia({ video: { width: 320, height: 240 } })
- CameraPermissionGate 组件（挂 SetupGuide 按钮）
- 失败兜底：用户拒绝 → camera unavailable → 全程走 neutral 走原字幕

### P2：抓帧 + 压缩 + 上传 (1.5h)
- canvas drawImage(video) → toDataURL('image/jpeg', 0.7)
- snapAndDetect() async function
- currentExpressionRef + EXPRESSION_TTL_MS 节流
- fetch /api/vision/expression 1500ms timeout

### P3：server 端 Gemini Vision (1.5h)
- POST /api/vision/expression 路由
- gemini-vision.ts: 调代理 4000 + prompt
- 输出 sanitize (parse 标签，非法值 → 'no_face')

### P4：ttsSpeak 集成 (1h)
- applyEffects setSubtitle case 前 await ensureExpression()
- 模板拼接：`${EXPR_INTRO[expr]}${effect.text}`
- 兼容 silent + 空字幕情况

### P5：端到端测试 (1h)
- 真机授权流程
- 抓拍延迟实测
- 模板拼接视觉验收
- 失败链 fallback 测试

**总工时 6.5h（约半个工作日）**

## 6. 兜底链（关键）

```
摄像头不可用 (拒绝/无设备) → camera unavailable flag → 所有 ensureExpression 直接返 neutral → 走原字幕
       ↓
抓拍失败 (canvas 异常) → fallback neutral
       ↓
上传超时 (1.5s) → fallback 用 currentExpressionRef 缓存值
       ↓
缓存也无值 → fallback neutral → 走原字幕
       ↓
server 端 Gemini Vision 失败 → 返 no_face → 客户端拿到 no_face → 走原字幕
```

**核心原则**：任意环节失败都不阻塞 TTS，最多回退到 V0.9 原字幕行为。

## 7. 风险点

| 风险 | 缓解 |
|------|------|
| iOS Safari getUserMedia 必须用户手势 | 挂 SetupGuide 按钮 onClick（已是手势栈，跟 unlockAudio 同步）|
| 隐私敏感（儿童面孔上云）| server 端只取标签字符串，原图即用即抛不存盘；README 加隐私说明 |
| Gemini Vision $0.002/帧 | 3s TTL 节流后 demo 整跑 $0.02，可忽略 |
| 摄像头位置不稳定（孩子动）| 抓不到人脸返 no_face → 走原字幕，无副作用 |
| 抓拍 + vision 比 TTS 慢 | 并行执行：ttsSpeak 不等 expression，模板拼接在 setSubtitle 时合并最近缓存 |
| Demo 演示场地光线差 | Gemini Vision 对低光容错较好，最差 → no_face |
| iOS Safari 隐私 webcam 黑屏 | 二段策略：首先尝试，失败 fallback neutral，不阻塞 |

## 8. 验收标准

- [ ] 摄像头授权后 video stream 可见（debug 阶段隐藏元素改为可见）
- [ ] 每次 ttsSpeak 前 currentExpressionRef 在 3s 内有效（log 验证）
- [ ] expr='happy' 时字幕拼上"看你笑这么开心，"前缀
- [ ] 摄像头拒绝场景全程走 V0.9 原字幕，无报错
- [ ] vision 超时 1.5s 后用缓存或 neutral，TTS 不阻塞
- [ ] 整 demo 跑完 10 次表情触发，总 vision 调用 ≤ 15 次（节流生效）

## 9. 不做（明确边界）

- ❌ 持续抓帧流（每帧上传）—— 贵 + 隐私 + 无感知收益
- ❌ 本地 face-api.js 集成 —— 模型几 MB 破坏 demo 第一原则
- ❌ 多人脸识别 —— demo 单儿童用户场景不需要
- ❌ 表情→开发自定义 LLM prompt —— D6 P2 再做
- ❌ 长期表情趋势分析 —— 不在 demo 范围

## 10. D6 P1 上线后续 TODO

- D6 P2：LLM 对话场景表情融入（按住说话 → system prompt 注入）
- D6 P3：表情统计面板（debug 用，看 demo 期间 happy/tired 比例）
- D7：表情→剧情分支（开心宝箱概率↑，疲倦推荐静思）

## 11. 决策记录

| 项 | 选择 | 理由 |
|---|------|------|
| Vision API | Gemini-3 Flash via 代理 4000 | 已在用 + LLM 主线同提供商 + p95 1.2s |
| 客户端摄像头 | getUserMedia + canvas | 浏览器原生，零依赖 |
| 图片格式 | JPEG q=0.7, 320×240 | ~15KB / 上传<100ms |
| 节流 | 3s TTL 缓存 | 平衡新鲜度 vs 成本 |
| 字幕融合 | 模板替换（A 路）| 零额外延迟，demo 节奏不动 |
| 失败默认 | neutral → 原字幕 | 完全退化到 V0.9 |
| 授权时机 | SetupGuide 完成配网按钮 | 用户手势栈 + 一次性授权 |
| 隐私 | server 不存图 | 即用即抛 |

---

**评审目标**：cc 派 codex（架构+实施细节）+ gemini（产品+风险+UX）并行评审本规划，回报后 cc 整合再决定开工。
