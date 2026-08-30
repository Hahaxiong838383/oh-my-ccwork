"""
config.py - 集中参数配置

所有可调参数在这里统一管理，方便调试和迭代。
"""

# ============================================================
# 摄像头
# ============================================================
CAMERA_INDEX = 0            # 摄像头索引
CAMERA_WIDTH = 1280          # 摄像头宽度
CAMERA_HEIGHT = 720          # 摄像头高度

# ============================================================
# 手部检测 & Pinch 状态机
# ============================================================
MAX_NUM_HANDS = 1            # 最大检测手数
PINCH_ON_THRESHOLD = 0.33   # pinch_ratio 低于此值视为"捏住"
PINCH_OFF_THRESHOLD = 0.45  # pinch_ratio 高于此值视为"松开"
CONFIRM_FRAMES = 3           # 连续多少帧确认后才切换状态
LOST_FRAMES_RELEASE = 5     # 丢手多少帧后自动释放
SMOOTHING_ALPHA = 0.6        # EMA 平滑系数（越大越跟手，越小越平滑）

# ============================================================
# 版本（单一真源：app.py 横幅与 UI 水印都读这里）
# ============================================================
VERSION = "v3.9.1"

# ============================================================
# 注视信号源后端（2026-08 路线B·v3.8）
# ============================================================
# "ptgaze"=ETH-XGaze resnet18 外观法模型（AB 探针实测垂直 SNR 11.43,
#   手工管线 0.52——垂直信号质变，见 probe_ab_result.txt）
# "legacy"=原手工几何融合（head/iris 加权）——回滚闸门：改这一行即回退
GAZE_BACKEND = "ptgaze"
# ptgaze pitch/yaw(度) → raw gaze [-1,1] 的除数。按川哥探针实测定标:
# 屏幕25%-75%对应 yaw位移~11°/pitch~6.7°。v3.9 标定点外扩到 10%-90% 后
# 边缘 yaw 到 18°+,15 会削顶污染标定 → 提到 25(教训:IRIS_SCALE_Y 削顶)
GAZE_PT_DEG_SCALE = 25.0
# v3.8.1 推理设备："mps"=Apple GPU(实测CPU 19.5ms致帧率腰斩13-15fps),
# 不可用时自动回退 cpu 并打警告
GAZE_PT_DEVICE = "mps"
FACE_CONF_THRESHOLD = 0.5    # FaceMesh 检测置信度
FACE_TRACK_THRESHOLD = 0.5   # FaceMesh 追踪置信度
HEAD_WEIGHT = 0.35            # 头部朝向权重（0~1，剩余给虹膜）
HEAD_SCALE = 2.5              # 头部偏移放大系数
IRIS_SCALE = 1.8              # 虹膜偏移放大系数
MIN_FACE_WIDTH = 30           # 最小有效面部宽度（像素）

# ── 注视 OneEuro 平滑（2026-07 路线A：替代固定 EMA）──
# min_cutoff 越小静视越稳；beta 越大扫视响应越快
GAZE_MIN_CUTOFF = 0.8         # 水平静视平滑强度
GAZE_BETA = 0.6               # 水平速度自适应敏感度
GAZE_MIN_CUTOFF_Y = 0.6       # 垂直更稳（信号噪声更大）
GAZE_BETA_Y = 0.5             # 垂直速度自适应敏感度
GAZE_D_CUTOFF = 1.0           # 速度估计 cutoff（默认）

# ── 校准持久化 + 启动快验（2026-08 v3.9：增量标定）──
CALIB_STORE_ENABLED = True        # 校准档持久化总开关
QUICK_VERIFY_POINTS = 3           # 启动快验点数（中心+左上+右下，覆盖两轴）
QUICK_VERIFY_TARGET = 12          # 快验每点合格样本数（短平快）
QUICK_VERIFY_TIMEOUT = 5.0        # 快验单点超时（秒）→ 视为快验失败转全量
QUICK_OK_MAE = 0.12               # 快验残差 ≤ 此值：旧档直接可用（仍做微调）
QUICK_FIX_MAE = 0.28              # 快验残差 ≤ 此值：合并快验点重拟合微调
                                  # 超过：环境剧变（换摄像头/房间）→ 引导全量重标
QUICK_VERIFY_WEIGHT = 2.0         # 快验点在合并重拟合中的权重（旧锚点=1.0）
IMPLICIT_PERSIST_DAYS = 7.0       # 隐式样本持久化保鲜期（超期不回灌）
IMPLICIT_REJECT_ALERT = 5         # 连续离群拒绝达此数 → UI 提示按 C 重标（失配哨兵）

# ── 隐式在线校准（2026-07 路线C：捏取即校准）──
IMPLICIT_CALIB_ENABLED = True   # 总开关
IMPLICIT_MAX_SAMPLES = 40       # 隐式样本滑窗容量（FIFO 淘汰最老）
IMPLICIT_WEIGHT = 0.5           # 隐式样本权重（锚点=1.0，隐式只微调不推翻）
IMPLICIT_OUTLIER_DIST = 0.45    # 离群拒绝阈值（校准空间距离，防盲抓污染）
IMPLICIT_REFIT_EVERY = 3        # 每累积 N 个样本重拟合一次

# ── 垂直注视 ──
HEAD_WEIGHT_Y = 0.30            # 垂直头部权重（上下摆幅小，权重低于水平）
HEAD_SCALE_Y = 3.0              # 垂直头部偏移放大（上下摆幅小，需要更大放大）
IRIS_SCALE_Y = 2.0              # 垂直虹膜偏移放大

# ── v3.7 注视稳定性 ──
CANDIDATE_PROGRESS_DECAY = 2    # 卡片锁定进度衰减量/帧（衰减不清零，v3.4 气泡范式移植）
BLINK_FREEZE_ENABLED = True     # 眨眼帧冻结候选状态机（眨眼虹膜乱值会打断锁定）
BLINK_FREEZE_MAX_FRAMES = 15    # 连续冻结上限（保险丝：EAR 异常卡眨眼态时强制恢复）

# ============================================================
# 注视候选卡片选择
# ============================================================
CANDIDATE_LOCK_FRAMES = 8     # 连续多少帧锁定候选
# ── v3.8.1 垂直门控改布局几何推导 ──
# v3.5 拍的常数(0.15/0.25)是 legacy 垂直信号坏死年代的产物:换 ptgaze 真
# 信号后,屏高62.5%~75%生成的低位气泡被门控稳定封锁(注视它 gaze_y>0.25)。
# 现以「桌面顶线的期望 gaze_y ± 余量」运行时推导(AttentionSelector.set_layout),
# 布局变阈值自动跟。以下常数仅作无布局信息时的兜底(测试/旧调用)。
CARD_GAZE_Y_MIN = 0.15        # 兜底：gaze_y 低于此值(视线在上方)卡片不参与评分
BUBBLE_GAZE_Y_MAX = 0.25      # 兜底：gaze_y 高于此值(视线在下方)气泡进度衰减
GAZE_Y_GATE_MARGIN = 0.10     # 分界线(桌面顶)两侧的余量带,吸收校准误差与噪声
CANDIDATE_RELEASE_FRAMES = 12 # 连续多少帧释放候选
CANDIDATE_MIN_CONFIDENCE = 0.25  # 最低候选评分阈值
ATTENTION_SWITCH_MARGIN = 0.15   # 候选切换迟滞余量（防抖动）
ATTENTION_SCORE_SIGMA = 0.12     # 高斯评分标准差

# ============================================================
# 注视候选气泡选择（气泡短命，锁定更快）
# ============================================================
# v3.8.1 dwell 改时间制：帧率波动不再改变交互手感（15fps 时 30 帧曾变 2 秒）。
# BUBBLE_LOCK_FRAMES/DECAY 保留原值——标称 30fps 下时间制与帧数制数学等价，
# 由 attention_selector 按 dt 换算（LOCK_SECONDS = FRAMES/30）。
BUBBLE_LOCK_FRAMES = 30           # 凝视驻留标称帧数（30fps 基准 → 1.0s）
BUBBLE_PROGRESS_DECAY = 2         # 非候选帧的进度衰减量（衰减而非清零，防抖动挫败）
BUBBLE_RELEASE_FRAMES = 6         # 连续多少帧释放气泡候选
BUBBLE_SCORE_SIGMA = 0.30         # 气泡高斯评分标准差（宽容识别，降低精度要求）
BUBBLE_SWITCH_MARGIN = 0.05       # 气泡候选切换迟滞余量（更容易切换）

# ============================================================
# 面部特征追踪
# ============================================================
EAR_BLINK_THRESHOLD = 0.21      # EAR 低于此值判定为眨眼
EAR_SMOOTHING_ALPHA = 0.4       # EAR 平滑系数
BLINK_CONFIRM_FRAMES = 2        # 连续几帧低 EAR 确认眨眼
BLINK_REFRACTORY_FRAMES = 6     # 眨眼后不应期帧数（防重复计数）
MAR_OPEN_THRESHOLD = 0.35       # 嘴巴纵横比大于此值判定为张嘴
FACE_MESH_DRAW_TESSELATION = False  # 是否绘制面部三角网格
FACE_MESH_DRAW_CONTOURS = True      # 是否绘制面部轮廓线

# ============================================================
# 窗口
# ============================================================
WINDOW_NAME = "Gesture Drag Demo"
# v3.9.1 主界面背景：False=纯黑（感知照常吃原始帧，仅显示层清黑；
# 手部骨架/卡片/气泡/HUD 照画），按 B 运行时切换。校准/快验屏不受
# 影响（保留暗视频底——用户需要隐约看到自己以确认在画面内）
SHOW_CAMERA_BG = False
