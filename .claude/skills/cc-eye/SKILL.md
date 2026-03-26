---
name: cc-eye
description: cc 的摄像头视觉感知。看一眼环境、查场景描述、管理 daemon。触发词："/look"、"看一眼"、"摄像头"、"环境里有什么"、"cc-eye"
user_invocable: true
---

# cc-eye — 视觉感知技能

cc 通过 USB 摄像头 + 本地多模态模型（moondream）感知物理世界。

## 项目路径

`~/mycc/2-Projects/cc-eye/`（Python 3.12 venv）

## 快速操作

### 1. 看一眼（最常用）

读取 daemon 缓存的最新场景描述，不拍照不启动摄像头：

```bash
cat /tmp/cc-eye-scene.json 2>/dev/null
```

如果文件不存在说明 daemon 未运行，需要先启动 daemon。

### 2. 实时拍照 + 模型描述

当需要**最新画面**时（daemon 未运行或场景可能已变）：

```bash
cd ~/mycc/2-Projects/cc-eye && source .venv/bin/activate && python -c "
from vision_models import VisionModel
import cv2
cap = cv2.VideoCapture(0)
for _ in range(5): cap.read()
ret, frame = cap.read()
if ret:
    frame = cv2.flip(frame, 1)
    cv2.imwrite('/tmp/cc-eye-latest.jpg', frame)
cap.release()
vm = VisionModel(mode='fast')
if vm.is_available:
    result = vm.describe_camera('Describe concisely: people, objects, what is happening.')
    print(result)
else:
    print('moondream 不可用，检查 ollama serve')
"
```

### 3. 查看最近事件

```bash
tail -10 /tmp/cc-eye-events.jsonl 2>/dev/null
```

事件类型：`motion`（运动）、`person_appeared`（有人来）、`person_left`（人走了）、`scene_described`（场景描述）。

### 4. 启动 daemon

```bash
cd ~/mycc/2-Projects/cc-eye && source .venv/bin/activate && python camera_daemon.py &
```

daemon 功能：每 5 秒拍一帧、运动检测、人脸检测、每 60 秒 moondream 场景描述。

### 5. 停止 daemon

```bash
pkill -f "python camera_daemon.py"
```

### 6. 启动实时标注画面（需要前台终端）

提醒用户在终端前台运行：
```bash
cd ~/mycc/2-Projects/cc-eye && source .venv/bin/activate && python live_view.py
```

快捷键：ESC 退出、M 切 MediaPipe、Y 切 YOLO、S 截图。

## 数据文件

| 文件 | 内容 |
|------|------|
| `/tmp/cc-eye-latest.jpg` | 最新摄像头帧 |
| `/tmp/cc-eye-scene.json` | 最新场景描述（moondream 生成） |
| `/tmp/cc-eye-events.jsonl` | 事件日志 |

## 注意事项

- 摄像头同一时间只能被一个进程占用（daemon 和 live_view 不能同时跑）
- live_view 必须在前台终端运行（macOS WindowServer 限制）
- moondream 需要 ollama serve 在后台运行
