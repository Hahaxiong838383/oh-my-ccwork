# Gesture Drag Demo

基于 OpenCV + MediaPipe 的手势拖拽交互 Demo。使用普通 USB 摄像头，通过拇指和食指的"捏住（pinch）"手势来拖拽屏幕上的卡片。

## 环境要求

- Python 3.10+
- Windows 10/11（也兼容 macOS/Linux）
- USB 摄像头（内置或外接均可）

## 安装

```bash
cd gesture_drag_demo
pip install -r requirements.txt
```

## 运行

```bash
python app.py
```

## 交互说明

| 操作 | 效果 |
|------|------|
| 拇指 + 食指捏住 | 如果 pinch 点在卡片上，抓住卡片 |
| 捏住状态下移动手 | 卡片跟随移动 |
| 拇指 + 食指松开 | 释放卡片 |
| 手移出画面 | 自动释放卡片 |
| 按 ESC | 退出程序 |
| 按 R | 重置卡片到初始位置 |

## 画面信息说明

左上角会显示实时调试信息：
- **FPS**：帧率
- **Hand**：手部检测状态（DETECTED / LOST）
- **Pinch Ratio**：拇指尖与食指尖距离 / 手部尺度（越小 = 捏得越紧）
- **State**：当前状态（idle / hovering / pinching / released）
- **Grabbing**：是否正在拖拽卡片

## 参数调节

所有可调参数集中在 `app.py` 顶部的配置区域：

```python
CAMERA_INDEX = 0            # 摄像头索引（多摄像头时修改）
CAMERA_WIDTH = 1280          # 分辨率宽度
CAMERA_HEIGHT = 720          # 分辨率高度

PINCH_ON_THRESHOLD = 0.33   # 低于此值判定为"捏住"
PINCH_OFF_THRESHOLD = 0.45  # 高于此值判定为"松开"
CONFIRM_FRAMES = 3           # 连续几帧确认后切换状态
LOST_FRAMES_RELEASE = 5     # 丢手几帧后自动释放
SMOOTHING_ALPHA = 0.6        # 坐标平滑系数（0.3=更平滑，0.9=更跟手）
```

### 调参建议

- **捏住太灵敏**：调大 `PINCH_ON_THRESHOLD`（如 0.38）
- **松开太慢**：调小 `PINCH_OFF_THRESHOLD`（如 0.40）
- **卡片跳动**：调小 `SMOOTHING_ALPHA`（如 0.4）或增大 `CONFIRM_FRAMES`
- **反应太慢**：调大 `SMOOTHING_ALPHA`（如 0.8）或减小 `CONFIRM_FRAMES`

## 项目结构

```
gesture_drag_demo/
  app.py              # 主循环与整合
  hand_tracker.py      # 摄像头与手部关键点检测
  gesture_state.py     # Pinch/Release 状态机
  ui.py                # 卡片绘制、命中测试、拖拽逻辑
  requirements.txt     # Python 依赖
  README.md            # 本文件
```

## 技术原理

1. **手部检测**：MediaPipe Hands 检测 21 个手部关键点
2. **Pinch 判定**：计算 `pinch_ratio = 拇指尖到食指尖距离 / 手腕到中指根部距离`，使用相对比例而非固定像素
3. **迟滞机制**：捏住阈值（0.33）< 松开阈值（0.45），避免边界抖动
4. **帧确认**：连续 3 帧满足条件才切换状态
5. **EMA 平滑**：对 pinch 中点坐标做指数移动平均，减少抖动
