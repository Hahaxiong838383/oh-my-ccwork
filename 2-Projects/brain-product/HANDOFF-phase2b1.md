# HANDOFF: mycc-brain Phase 2B-1 视觉接入（稳定的眼睛）

> 经过 cc + Codex 三轮对抗评审收敛的方案。本 session 负责实现。

---

## 当前状态

- **分支**: 从 main 新建 `feat/brain-phase2b1-vision`
- **回滚点**: main
- **决策记录**: 见本文档下方"设计决策"
- **前置依赖**: Phase 1 数据管道已部署（v0.2.0），Studio 摄像头已接（EMEET SmartCam S600 USB）

---

## 终极目标上下文

Phase 2B-1 是 brain 视觉自进化路径的第一步：

```
2B-1: 稳定采集 + away→silent 门控 + 数据积累
  → 2B-2: 视觉融入 user-state + system prompt
  → 2B-3: 离线节奏建模 → prediction 先验
  → Phase 3: 视觉特征 → pattern-miner → experience-stream
  → Phase 4: evolution-engine 基于视觉模式自主进化
```

**本轮核心价值不只是门控——是数据积累。每天 ~3000 条 activity 事件是后续所有视觉学习的原料。**

---

## Studio 环境事实（已验证）

| 项目 | 状态 |
|------|------|
| 摄像头 | EMEET SmartCam S600, USB, 系统已识别 |
| Python | brew python@3.12 已安装，3.12.13，但 symlink 断了 |
| Python 路径 | `/opt/homebrew/Cellar/python@3.12/3.12.13/libexec/bin/python3` |
| venv 模块 | 可用（`import venv` OK） |
| venv 创建 | **需先修 symlink**（见下方前置步骤） |
| 系统 pip3 | 不可用（Xcode CLI 损坏） |
| Xcode CLI | 损坏，无法修复（需 sudo） |
| Ollama | 在线，有 moondream/minicpm-v/gemma4（**本轮不用**） |
| brain | PM2 运行中，v0.2.0，port 19080 |
| Node.js | v22.14.0 |
| brain 项目路径 | `/Users/fu-121/mycc-brain/` |
| brain data 路径 | `/Users/fu-121/mycc-data/0-System/`（记忆数据）|
| brain 本地 data | `/Users/fu-121/mycc-brain/data/`（experiences/predictions）|

---

## 前置步骤：修复 Studio Python venv

```bash
# SSH 到 Studio
ssh studio

# 修 symlink
mkdir -p /opt/homebrew/opt/python@3.12/bin/
ln -sf /opt/homebrew/Cellar/python@3.12/3.12.13/bin/python3.12 \
       /opt/homebrew/opt/python@3.12/bin/python3.12

# 验证
/opt/homebrew/Cellar/python@3.12/3.12.13/libexec/bin/python3 -m venv /tmp/test-venv
/tmp/test-venv/bin/python3 --version  # 应显示 3.12.13
/tmp/test-venv/bin/pip install opencv-python-headless numpy
/tmp/test-venv/bin/python3 -c "import cv2; print(cv2.__version__)"
rm -rf /tmp/test-venv
```

如果 symlink 修复后 venv 仍失败，备选方案：用 `--without-pip` 创建 venv + 手动安装 pip。

---

## 检测方案选型

**Phase 2B-1 选 `cv2.dnn + MobileNet-SSD`**

| 方案 | 安装复杂度 | 依赖大小 | 静坐检测 | 选择 |
|------|-----------|---------|---------|------|
| 纯帧差 | 最低 | 40MB | ❌ | 不选 |
| HOG+SVM | 低 | 40MB | ⚠️ | 不选 |
| **cv2.dnn + MobileNet-SSD** | **低** | **40MB+23MB** | **✅** | **本轮** |
| YOLOv8n ONNX | 中 | 55MB | ✅ | 升级备选 |

MobileNet-SSD 通过 `cv2.dnn.readNetFromCaffe()` 加载，OpenCV 内置推理，无额外依赖。
模型文件（.prototxt + .caffemodel）需手动下载放到 `tools/vision/models/`。

**升级路径**: 如果 MobileNet-SSD 精度不够 → 换 YOLOv8n ONNX + onnxruntime，只改检测函数。

---

## 要做的 6 个改动

### 改动 1: vision daemon（Python 侧）

**新增文件**: `tools/vision/vision_daemon.py`（~220 行）

**职责**:
- 1fps 主循环，打开 USB 摄像头
- 帧差检测 motionLevel（160×120 灰度帧差，每秒）
- MobileNet-SSD person 检测（300×300，每 5 秒分频）
- 输出三个本地文件

**present 状态机**:
```
[unknown] ── 检到人 ──→ present=true
          ── 连续 3 次没检到人（15 秒）──→ present=false

present=true ── 连续 3 次没检到 ──→ present=false
present=false ── 检到人 1 次 ──→ present=true
stale(>60s) ──→ present=null（brain 忽略视觉）
```

**activity 推断**:
- `active`: present=true && motionLevel > 0.05
- `idle`: present=true && motionLevel <= 0.05
- `away`: present=false
- `unknown`: 刚启动 / 检测失败

**文件输出**:

1. `data/activity/latest.json`（原子写入: 写 tmp → rename）
```json
{
  "schemaVersion": 1,
  "timestamp": "2026-04-08T10:12:33.000Z",
  "source": "vision-daemon-v1",
  "present": true,
  "presentConfidence": 0.85,
  "presentMethod": "mobilenet-ssd",
  "motionLevel": 0.18,
  "motionMethod": "frame-diff",
  "activity": "active",
  "confidence": 0.72
}
```

2. `data/activity/status.json`
```json
{
  "running": true,
  "startedAt": "...",
  "lastFrameAt": "...",
  "lastWriteAt": "...",
  "lastError": null,
  "droppedFrames": 0,
  "totalFrames": 12345,
  "version": "vision-daemon-v1"
}
```

3. `data/activity/YYYY-MM-DD.jsonl`
   - 心跳: 每 30 秒写一条（即使状态没变）
   - 状态变化: present 状态变化时立即写
   - 预估 ~300KB/天

**依赖**: `requirements.txt`
```
opencv-python-headless
numpy
```

**模型文件**: `tools/vision/models/`
- `MobileNetSSD_deploy.prototxt`
- `MobileNetSSD_deploy.caffemodel`（~23MB）
- 下载源: OpenCV 官方 GitHub

### 改动 2: visual-state.ts

**新增文件**: `src/services/visual-state.ts`（~80 行）

**职责**:
- 每 3 秒轮询 `data/activity/latest.json` 和 `status.json` 的 mtime
- 内存缓存当前 VisualState
- stale 阈值 60 秒

**接口**:
```typescript
interface VisualState {
  available: boolean;       // 视觉通道是否可用
  stale: boolean;           // 超过 60s 没更新
  present: boolean | null;  // 人在不在（null=unknown）
  activity: "active" | "idle" | "away" | "unknown";
  motionLevel: number | null;
  confidence: number | null;
  lastEventAt: string | null;
  staleMs: number;
  source: string | null;
}

function getVisualState(): VisualState;
function startVisualStatePolling(dataDir: string): void;
function stopVisualStatePolling(): void;
```

### 改动 3: visual-gate.ts

**新增文件**: `src/services/visual-gate.ts`（~40 行）

**本轮只有一条规则**:
```
if visual.available && visual.present === false → force silent
```

不做 active 降级、idle 降级、stableMinutes 降级。

**接口**:
```typescript
interface VisualGateResult {
  level: "silent" | "prepare" | "suggest" | "act";
  reason: string;
  applied: boolean;  // 视觉是否改变了原始 level
}

function applyVisualGate(
  currentLevel: "silent" | "prepare" | "suggest" | "act",
  visual: VisualState,
): VisualGateResult;
```

### 改动 4: brain-api.ts 接入

**修改文件**: `src/brain-api.ts`

接入位置: `decideProactiveAction()` 得到 level 后、`formatProactiveSuggestion()` 前。

```typescript
// 现有 proactive 逻辑不变
const proactive = decideProactiveAction(...);

// 新增: 视觉门控（fail-open）
let gatedLevel = proactive.level;
try {
  const visual = getVisualState();
  const gated = applyVisualGate(proactive.level, visual);
  gatedLevel = gated.level;
  if (gated.applied) {
    console.log(`[brain] visual gate: ${proactive.level} → ${gated.level} (${gated.reason})`);
  }
} catch { /* fail-open: 视觉异常不影响主链路 */ }

// 用 gatedLevel 代替 proactive.level 决定是否注入 suggestion
```

**约束**:
- 只影响 `route.brain === true` 的主链路
- 视觉读取失败 → 吞错误，走原逻辑
- 日志区分原始 level 和 gated level

### 改动 5: Admin observability

**修改文件**: `src/server.ts`
**新增文件**: `src/services/activity-observability.ts`（~50 行）

新增 `GET /admin/api/visual-status`:
```json
{
  "visual": { /* VisualState 字段 */ },
  "daemon": { /* status.json 内容 */ },
  "todayEventCount": 1234,
  "oldestLogDate": "2026-04-08"
}
```

### 改动 6: 文档和启动

**新增文件**: `docs/vision-daemon.md`

内容:
- 依赖安装（brew Python venv + pip）
- 模型下载
- 摄像头权限（macOS 隐私设置）
- 启动命令
- PM2 配置
- 故障排查

**新增文件**: `tools/vision/run_vision.sh`（PM2 启动脚本）

---

## 不做的事

- 不用 YOLO / ultralytics / torch
- 不用 Ollama / moondream / minicpm-v
- 不做场景描述 / intent 映射
- 不做 face 识别
- 不做 prediction hit 验证
- 不做 pattern-miner / resonance 接入
- 不做 active/idle 降级门控（只做 away→silent）
- 不做视觉驱动升级
- 不改 user-state.ts（Phase 2B-2）

---

## 并行执行策略

| Agent | 改动 | 文件 |
|-------|------|------|
| Agent 1 | 改动 1 (vision daemon) + 改动 6 (文档) | Python 侧全部 |
| Agent 2 | 改动 2 + 3 + 5 (visual-state + gate + observability) | TS 新增模块 |
| Agent 3 | 改动 4 (brain-api 接入) | brain-api.ts + server.ts |

Agent 2 和 3 都改 brain 侧但模块独立，不冲突。

---

## 验收标准

### Python 侧
1. vision daemon 能独立启动，摄像头可读
2. latest.json 持续更新（原子写入）
3. status.json 有 lastFrameAt / lastError
4. YYYY-MM-DD.jsonl 心跳+状态变化正常写入

### TypeScript 侧
5. `npm run build` 通过
6. `getVisualState()` 返回完整 VisualState
7. present=false 时 proactive level 被压到 silent
8. stale/异常时 brain 走原逻辑（fail-open）
9. `/admin/api/visual-status` 返回当前状态

### 禁止项确认
10. 无 YOLO / Ollama / torch 依赖
11. 无视觉→intent 映射
12. 无 prediction/resonance 接入
13. 无视觉驱动升级

---

## 设计决策

### 为什么选 MobileNet-SSD 而非纯帧差？
帧差只能检测运动，不能检测人。静坐看屏幕的人 motionLevel 极低，帧差会判 away→误触 silent。
MobileNet-SSD 是 OpenCV 内置 DNN 推理，无额外 pip 依赖，23MB 模型，M2 上 ~15ms CPU 推理。

### 为什么门控只做一条规则？
Phase 2B-1 的 present 检测尚未经过实际验证。只做最高置信度的规则（away→silent），
跑 1 周验证后再考虑加 active/idle 降级。宁可少做，不做错。

### 为什么不用 Ollama 视觉？
brain 已用 Ollama 跑 intake（MLX 4B）和 gemma4 测试。同机视觉推理会争 GPU 资源，
且 moondream 输出是自然语言描述，要映射到 present 还需要再过一次解析——依赖链太长。

---

*创建时间：2026-04-08*
