# Vision Daemon — Phase 2B-2

> mycc-brain 视觉 sidecar，运行在 Studio（M2 Max），通过文件协议与 brain 通信。

## 架构

```
USB 摄像头 + 麦克风 → vision_daemon.py (1fps)
                                ├─ data/activity/latest.json
                                ├─ data/activity/status.json
                                └─ data/activity/YYYY-MM-DD.jsonl
                                              ↓
                              brain (visual-state.ts 每 3s 轮询)
                                              ↓
               user-state.ts（attention/noiseLevel 轻量融合）
                                              ↓
                              visual-gate.ts: away → silent
```

## 依赖

- Python 3.12（brew）
- opencv-python-headless + numpy + sounddevice
- MobileNet-SSD 模型（~23MB，setup 脚本自动下载）

## 安装

```bash
# 进入项目
cd ~/mycc/2-Projects/brain-product/mycc-brain

# 一键初始化
bash tools/vision/setup_studio.sh
```

脚本会自动：
1. 修复 python3.12 symlink（Studio 已知问题）
2. 创建 `.venv-vision` 虚拟环境
3. 安装 requirements.txt
4. 下载 MobileNet-SSD 模型到 `tools/vision/models/`
5. 执行自检（import cv2 + 模型加载 + sounddevice）

## 运行时配置

- `mycc-brain` 启动时会按顺序自动加载：
  1. 当前进程已有环境变量
  2. `.env.local`
  3. `.env`
- 当前验证阶段默认 brain 模型由 `BRAIN_DEFAULT_MODEL` 控制，默认推荐：

```bash
BRAIN_DEFAULT_MODEL=cc-gemini-3.1-flash
```

- Studio 常驻运行建议把在线模型密钥放到 `.env.local`，不要依赖“当前终端临时 export”。
- `.env.local` 已加入 `.gitignore`，示例字段见 `.env.example`。
- 更完整说明见 [runtime-env.md](/Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/docs/runtime-env.md)。

## 启动

```bash
# 前台运行（调试）
bash tools/vision/run_vision.sh --debug

# PM2 托管（生产）
bash tools/vision/run_vision.sh --pm2
```

## CLI 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--camera-index` | 0 | 摄像头设备号 |
| `--data-dir` | `data/activity/` | 输出目录 |
| `--fps` | 1.0 | 主循环帧率 |
| `--detect-interval` | 5 | MobileNet-SSD 检测间隔（秒） |
| `--heartbeat-seconds` | 30 | JSONL 心跳间隔 |
| `--once` | - | 单次执行后退出 |
| `--debug` | - | 调试输出 |

## 输出文件

### latest.json（实时状态）

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
  "confidence": 0.85,
  "audioLevel": 0.02,
  "audioMethod": "sounddevice-rms",
  "audioAvailable": true
}
```

### status.json（daemon 健康状态）

```json
{
  "running": true,
  "startedAt": "...",
  "lastFrameAt": "...",
  "lastWriteAt": "...",
  "lastError": null,
  "audioLastSampleAt": "...",
  "audioLastError": null,
  "droppedFrames": 0,
  "totalFrames": 12345,
  "version": "vision-daemon-v1"
}
```

### YYYY-MM-DD.jsonl（日志历史）

每行一个 JSON 事件，触发条件：
- `"trigger": "change"` — activity 状态变化时立即写
- `"trigger": "heartbeat"` — 每 30 秒写一次

## present 状态机

```
[unknown] ── 检到人 ──→ present=true
          ── 连续 3 次没检到 ──→ present=false

present=true ── 连续 3 次没检到 ──→ present=false
present=false ── 检到人 1 次 ──→ present=true
stale(>60s) ──→ brain 忽略视觉（fail-open）
```

## activity 规则

| present | motionLevel | activity |
|---------|------------|----------|
| true | > 0.05 | active |
| true | <= 0.05 | idle |
| false | - | away |
| null | - | unknown |

## 故障排查

| 问题 | 排查 |
|------|------|
| 摄像头打不开 | `system_profiler SPCameraDataType`，检查 macOS 隐私设置 |
| `audioAvailable=false` | 检查系统麦克风权限、输入设备选择、`sounddevice` 是否可 import |
| 模型加载失败 | 重新运行 `setup_studio.sh` |
| latest.json 不更新 | 检查 daemon 是否运行：`pm2 status vision-daemon` |
| brain 看不到视觉 | 检查 `data/activity/` 目录和文件权限 |

## macOS 摄像头 / 麦克风权限

首次运行时 macOS 可能弹出摄像头或麦克风权限请求。如果通过 SSH 运行，需要：
1. 在 Studio 本机终端运行一次 daemon
2. 在系统偏好设置 → 隐私 → 摄像头 / 麦克风 中授权终端

## Phase 2B-2 验证结果

- `latest.json` 已验证能写出 `audioLevel/audioMethod/audioAvailable`
- `/admin/api/visual-status` 已验证能返回音频字段
- `user-state.ts` 已验证能从视觉/音频上下文推断 `attention` 和 `noiseLevel`
- `cc-gemini-3.1-flash` 已验证能正确消费环境感知上下文，当前推荐作为默认 brain 模型
- `raw-gemini-3.1-flash` 对照验证明确表示“不知道环境状态”，证明环境感知只注入 brain 路由
