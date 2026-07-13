# Gesture Drag Demo v3.4

## v3.4 新特性：气泡凝视驻留环（川哥提案）

- **气泡锁定改为 dwell 驻留交互**：3 帧（50ms 瞬锁）→ 30 帧（~0.5s），外围环形进度弧随凝视增长——灰底环 → 亮青弧 → 满圈进入橙色锁定态（Apple Eye Tracking Dwell Control 同款范式）
- **进度衰减而非清零**：视线短暂飘走时弧线缓慢回退（每帧 -2），回来接着涨——消除 dwell UI 最大挫败源
- 顺手修掉 app.py 里锁定进度硬编码 `/5` 的旧账（改用 `attn_sel.bubble_lock_progress` 属性）
- 参数可调：`BUBBLE_LOCK_FRAMES`（嫌慢调小）、`BUBBLE_PROGRESS_DECAY`
- 新增 `test_bubble_dwell.py`（3 测：累积锁定/衰减不清零/长离开释放）

## v3.3 新特性：校准质量闭环（川哥提案）

- **质量门控校准**（`FixationGate`，calibration.py）：告别"固定 2 秒照单全收"——只有滑窗 std 判定"盯稳了"的帧才计入合格样本，攒满 30 个才算完成该点（扫视/走神/眨眼时 std 天然飙高，装不出来）
- **转圈闭环反馈**：点位外围进度环随合格样本增长——灰=没盯稳（不涨）、亮青=采集中、转满变绿+OK 才进下一点
- **防转圈卡死**：单阶段 6 秒没攒满 → 自动放宽稳定阈值（×1.25，最多 2 次）→ 仍不满降级通过并标记，绝不困住用户
- 删除了盲目 0.4s 预热（门控天然涵盖视线到位判定）；状态差时单点最长约 18s 兜底退出
- 新增 `test_fixation_gate.py`（4 测：稳定累积/漂移不计/中断复位/超时降级）

## v3.2 新特性：捏取即校准（调研驱动·路线C）

- **隐式在线校准**（`implicit_calib.py`）：每次 pinch 抓取卡片的瞬间 = 一个注视弱标签（视线必在目标卡片上），滑窗累积增量重拟合校准多项式——**越用越准**，自动吸收换坐姿/换距离后的校准漂移（Sugano 范式，IEEE THMS 2015）
- 标签噪声三防线：离群拒绝（盲抓不污染）+ 显式 9 点锚点权重更高（隐式只微调不推翻）+ 滑窗 FIFO 淘汰
- 关键工程点：采样用**未校准原始值**（`GazeResult.uncal_gaze_*` 新字段），防"校准套校准"复合漂移
- 显式/隐式共用同一拟合器（`fit_poly_with_affine_fallback`），行为一致
- 新增 `test_implicit_calib.py`（4 测：漂移修正实测 -59% / 离群拒绝 / 滑窗上限 / 映射往返）
- 开关与参数：`config.py` IMPLICIT_*（`IMPLICIT_CALIB_ENABLED=False` 一键关闭）

## v3.1 特性：注视精度升级（调研驱动·路线A）

- **二阶多项式校准**（含 xy 交叉项，联合输入）替代 per-axis 仿射：直接拟合"边缘压缩 + 垂直增益不足 + 看角落两轴耦合"的非线性（学界实证眼动非线性集中在屏幕顶部行与左右边缘）；拟合退化时自动回退仿射，MAE 择优
- **OneEuro 平滑**替代固定 EMA：静视强平滑抗抖、扫视低滞后跟手（复用 cc-AirPlayer 生产验证实现，参数在 `config.py` GAZE_MIN_CUTOFF/BETA）
- 新增 `test_gaze_upgrade.py`（4 测：非线性场景多项式增益 ~33% / 线性场景不退化 / OneEuro 降噪+阶跃响应 / 校准 API）
- 调研报告见 [`../research-gaze-accuracy-2026-07.md`](../research-gaze-accuracy-2026-07.md)（路线 B=外观法模型、C=捏取即校准 待启）

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

- **v3.5**：垂直注视门控——卡片仅视线下方参与评分/气泡仅上方累积,修「盯气泡底部卡片躺枪」(1D评分历史设计)+2门控测
- **v3.4.1**：修历史级 bug——set_dragging 每帧无条件清空锁定计数,卡片8帧锁定/气泡锁定从未真正达成(候选高亮每帧重算掩盖了它);改转换沿触发,金色脉冲锁定与优先级3抓取首次真实生效
- **v3.4**：气泡凝视驻留环——dwell锁定(3→30帧)+进度弧+衰减不清零
- **v3.3**：校准质量闭环——FixationGate 门控(盯稳才算)+进度环反馈+超时降级防卡死
- **v3.2**：捏取即校准路线C——隐式在线校准(pinch抓卡=注视弱标签,滑窗增量重拟合,越用越准)+uncal字段防复合漂移+4测
- **v3.1**：注视精度升级路线A——二阶多项式校准（xy 交叉项+仿射兜底择优）+ OneEuro 平滑替代 EMA + 4 项单测
- **v3.0**：面部特征追踪（EAR/眨眼/头部朝向/表情线索）+ 9 点眼动校准 + 2D 注视估计
- **v2.0**：注视预选（FaceMesh + Iris → 候选锁定 → 融合抓取）
- **v1.2**：气泡系统 + 捏住动效 + 拖拽立体感
- **v1.0**：基础手势拖拽（MediaPipe Hands + Pinch 状态机）
