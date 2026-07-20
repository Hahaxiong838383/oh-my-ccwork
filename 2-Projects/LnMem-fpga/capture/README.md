# capture/ — 会议场景采集管线 v0（D3 软件先行 · 阶段 1）

> 对应 [feature_contract.md](../feature_contract.md) v0.1 与 [标注手册](../intent_annotation_handbook.md) 红线 R1/R2。
> 一句话：开会前跑一条命令，散会 Ctrl-C——你开会说话这个动作本身就在自动产生 I3 标注锚。

## 川哥使用方法（就这一条命令）

```bash
cd ~/mycc/2-Projects/LnMem-fpga/capture && .venv/bin/python capture_daemon.py --session-note "周会"
```

- 首次运行 macOS 会弹**摄像头/麦克风**权限框 → 点允许（TCC 权限跟 Terminal 走）；
- 终端每秒刷一行状态：`帧N ~15fps 脸✓ 说话✗ 键鼠40% 事件3 ctx✓`；
- 散会后 `Ctrl-C`，数据落在 `~/.lnmem-fpga/data/sessions/<时间戳>/`。

## 隐私声明（设计约束，不是承诺）

| 采 | 不采 |
|---|---|
| 你的脸部**特征数字**（64 维 blendshapes+几何，不存图像帧） | ❌ 原始视频帧 |
| 你是否在说话（**布尔**，麦克风 RMS 算完即弃） | ❌ 任何音频内容/录音 |
| 键鼠**活动率**（系统 HIDIdleTime，零权限零内容） | ❌ 按键内容/鼠标轨迹 |
| 前台 app 的 bundle id（元数据） | ❌ 屏幕内容/对方画面/对方声音 |

手动启停本身是隐私设计：进程活着 = 你明确知道在采集。

## 文件地图

| 文件 | 职责 |
|---|---|
| `capture_daemon.py` | 主循环：摄像头→特征 + context 组装 + 事件锚 + 落盘 + 状态行 |
| `contract.py` | feature_contract v0.1 代码化（context 16 维 / 死维白名单声明） |
| `feature_frontend.py` | MediaPipe FaceLandmarker → blendshapes(52)+派生几何(12)=feat[64] |
| `context_sources.py` | 键鼠活动率 / 麦克风 VAD / 前台 app |
| `events.py` | 事件锚：speech_start/end（I3 锚）、leave_seat 候选（I5 锚）、app_switch |
| `health.py` | per-dim 活性哨兵（60s 体检，死维/饱和告警，白名单豁免） |
| `validate_annotation.py` | anchor CI（手册 §4.3；`--` 独立 CLI，exit 1=有 reject） |
| `tests/test_logic.py` | 逻辑层测试（无硬件依赖） |

## v0 范围声明（诚实边界）

- **context 16 维中 12 活 / 4 dead-by-design**（`contract.DEAD_BY_DESIGN_V0` 登记，哨兵白名单豁免，训练侧 drop）：
  `someone_speaking`（需系统音频侧检测，v0 无源）、`agenda_dwell` + one-hot 中 question/screen/agenda/join/mute 五个事件位（需会议软件集成，v0 无源）。
- 对比 LnMem 的教训：LnMem 是 18 维里 5 维死**且无人知晓**；这里是显式登记 + 哨兵盯着非白名单维——性质完全不同。
- `quality` 为 v0 占位公式；正式阈值待实测分布校准（手册 §6 R4）。
- 单人假设（track_id 恒 0）：会议场景只采你自己这一侧。

## 开发者：环境重建

```bash
cd capture
uv venv --python 3.12 .venv
uv pip install -r requirements.txt --python .venv/bin/python
bash setup_model.sh                  # 下载 face_landmarker.task (~3.7MB, Google 官方源)
.venv/bin/python -m pytest tests/ -q # 逻辑层测试
```
