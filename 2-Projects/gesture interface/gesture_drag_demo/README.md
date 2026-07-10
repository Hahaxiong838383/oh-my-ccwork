# Gesture Drag Demo v3.0

基于 OpenCV + MediaPipe 的手势拖拽交互 Demo。使用普通 USB 摄像头，通过 **注视预选 + 捏住拖拽** 实现自然的卡片交互。

## v3.0 新特性：面部特征 + 眼动校准

- **2D 注视估计**：注视方向从水平单轴扩展到水平 + 垂直双轴（`gaze_x` / `gaze_y`）
- **9 点眼动校准**：启动时引导注视 3×3 网格校准点，最小二乘回归仿射参数（`calibrated = a × raw + b`，x/y 独立），提升注视精度；按 C 可随时重新校准
- **面部特征追踪**（`face_tracker.py`，复用 FaceMesh 结果零额外推理）：
  - 眼部：EAR（眼睛纵横比）、眨眼检测（帧确认 + 不应期）、眼睛开合度
  - 头部朝向：yaw / pitch / roll
  - 表情线索：MAR（嘴巴开合比）、眉毛高度
- **面部特征可视化**：按 F 切换面部特征调试图层

## v2.0 特性：注视预选（Gaze-Attention Pre-selection）

- **粗粒度注视方向估计**：MediaPipe FaceMesh + 虹膜关键点，实时判断用户注视方向
- **候选卡片高亮**：看向某个区域 → 对应卡片淡金色提示 → 持续注视 → 金色脉冲锁定
- **注视 + 捏住融合**：锁定的候选卡片优先被捏住抓取，无需精确对准
- **拖拽不被打断**：拖拽期间注视冻结，释放后自动恢复候选选择
- **全参数可配置**：所有阈值集中在 `config.py`，方便调试

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
| **注视**（看向屏幕某侧） | 对应区域卡片高亮为候选 |
| 持续注视同一区域 | 候选锁定（金色脉冲边框） |
| 拇指 + 食指捏住 | 抓住锁定的候选卡片（优先）或最近的卡片 |
| 捏住状态下移动手 | 卡片跟随移动 |
| 拇指 + 食指松开 | 释放卡片，恢复注视候选 |
| 手移出画面 | 自动释放卡片 |
| 按 ESC | 退出程序 |
| 按 R | 重置卡片到初始位置 |
| 按 G | 切换注视调试可视化 |
| 按 F | 切换面部特征可视化 |
| 按 C | 重新运行眼动校准 |

## 画面信息说明

### 左上角：手势状态
- **FPS**：帧率
- **Hand**：手部检测状态（DETECTED / LOST）
- **Pinch Ratio**：拇指尖与食指尖距离比例
- **State**：当前状态（idle / hovering / pinching / released）
- **Grabbing**：是否正在拖拽

### 右上角：注视 & 注意力状态（按 G 切换）
- **Face**：面部检测状态
- **Direction**：注视方向（LEFT / CENTER-L / CENTER / CENTER-R / RIGHT）
- **Gaze X**：水平注视值 [-1, 1]
- **Confidence**：注视可信度
- **Head / Iris**：头部与虹膜方向分量
- **Mode**：注意力模式（free / candidate / dragging）
- **Candidate**：候选卡片 + 锁定状态
- **Lock Progress**：锁定进度条

## 参数调节

所有可调参数集中在 `config.py`：

### 手势参数
| 参数 | 默认值 | 说明 |
|------|--------|------|
| `PINCH_ON_THRESHOLD` | 0.33 | 低于此值判定为"捏住" |
| `PINCH_OFF_THRESHOLD` | 0.45 | 高于此值判定为"松开" |
| `CONFIRM_FRAMES` | 3 | 连续几帧确认后切换状态 |
| `SMOOTHING_ALPHA` | 0.6 | 坐标平滑系数（越大越跟手） |

### 注视参数
| 参数 | 默认值 | 说明 |
|------|--------|------|
| `GAZE_SMOOTHING_ALPHA` | 0.35 | 注视方向平滑（越小越稳） |
| `HEAD_WEIGHT` | 0.35 | 头部朝向权重（剩余给虹膜） |
| `HEAD_SCALE` | 2.5 | 头部偏移放大系数 |
| `IRIS_SCALE` | 1.8 | 虹膜偏移放大系数 |

### 候选选择参数
| 参数 | 默认值 | 说明 |
|------|--------|------|
| `CANDIDATE_LOCK_FRAMES` | 8 | 连续多少帧锁定候选 |
| `CANDIDATE_RELEASE_FRAMES` | 12 | 连续多少帧释放候选 |
| `ATTENTION_SWITCH_MARGIN` | 0.15 | 候选切换迟滞余量（防抖动） |
| `ATTENTION_SCORE_SIGMA` | 0.12 | 高斯评分标准差 |

### 调参建议

- **候选切换太频繁**：增大 `ATTENTION_SWITCH_MARGIN` 或 `CANDIDATE_LOCK_FRAMES`
- **候选锁定太慢**：减小 `CANDIDATE_LOCK_FRAMES`（如 5）
- **注视方向抖动**：减小 `GAZE_SMOOTHING_ALPHA`（如 0.2）
- **注视反应太慢**：增大 `GAZE_SMOOTHING_ALPHA`（如 0.5）
- **捏住太灵敏**：调大 `PINCH_ON_THRESHOLD`（如 0.38）
- **卡片跳动**：调小 `SMOOTHING_ALPHA`（如 0.4）

## 项目结构

```
gesture_drag_demo/
  app.py                # 主循环：融合注视预选 + 手势拖拽
  config.py             # 集中参数配置
  hand_tracker.py       # 摄像头与手部关键点检测
  gesture_state.py      # Pinch/Release 状态机
  gaze_estimator.py     # 粗粒度注视方向估计（FaceMesh + Iris，2D）
  attention_selector.py # 注视候选卡片选择器（评分 + 锁定）
  face_tracker.py       # 面部特征：EAR/眨眼/头部朝向/表情线索
  calibration.py        # 9 点眼动校准（3×3 网格，仿射回归）
  ui.py                 # 桌面/卡片绘制、拖拽、调试可视化
  requirements.txt      # Python 依赖
  README.md             # 本文件
```

## 技术原理

### 手势检测（v1.0）
1. MediaPipe Hands 检测 21 个手部关键点
2. `pinch_ratio = 拇指尖到食指尖距离 / 手腕到中指根部距离`
3. 迟滞机制：捏住阈值 < 松开阈值，避免边界抖动
4. 帧确认 + EMA 平滑

### 注视预选（v2.0）
1. **面部检测**：MediaPipe FaceMesh（含虹膜关键点 468-477）
2. **头部朝向**：鼻尖相对双眼中心的水平偏移比例
3. **虹膜朝向**：虹膜中心在眼白中的水平位置比例
4. **加权融合**：`gaze_x = 0.35 × head + 0.65 × iris`，EMA 平滑
5. **候选评分**：高斯函数评估卡片与注视方向的接近度
6. **帧计数锁定**：连续 8 帧最高分 → 锁定候选（金色脉冲高亮）
7. **迟滞切换**：新候选需超出当前候选 0.15 分才切换，防止抖动
8. **融合抓取**：pinch 时优先抓取锁定候选 → 回退到位置命中测试

## 版本历史

- **v3.0**：面部特征追踪（EAR/眨眼/头部朝向/表情线索）+ 9 点眼动校准 + 2D 注视估计
- **v2.0**：注视预选（FaceMesh + Iris → 候选锁定 → 融合抓取）
- **v1.2**：气泡系统 + 捏住动效 + 拖拽立体感
- **v1.0**：基础手势拖拽（MediaPipe Hands + Pinch 状态机）
