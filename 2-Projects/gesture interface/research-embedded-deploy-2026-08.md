# 嵌入式部署调研：RK3588 / RK1828 / Hailo 跑 v3.9 眼动+手势方案（2026-08-30）

> 触发：川哥问 RK3588 配 1828 或 hailo-5 能否运行当前方案、需要什么调整、与 MacBook Air 对比。
> 方法：Web 检索（型号存在性/实测 benchmark）+ PyPI 直验（mediapipe aarch64 wheel）+ 本项目实测数据对账。
> 当前方案计算构成真值（Air M5 实测）：FaceMesh ~2.4ms + ptgaze face_landmarker+resnet18@MPS 全链 17.5ms + Hands ~10ms；主循环 15fps（有未解的非推理瓶颈）。

## 〇、型号澄清（先纠偏）

- **RK1828 是真品**（我知识截止后的新品，已验证）：瑞芯微 2025 发布、2026 量产的边侧 AI 协处理器——**20 TOPS INT8、片上 5GB 3D 堆叠 DRAM、典型功耗 5W**，走 PCIe 挂在主控 SoC（RK3588 正是官方典型搭配），主打**边侧跑 2B-7B LLM/多模态大模型**（百 token/s 级），支持多芯堆叠。
- **「Hailo-5」不存在**：Hailo 2026 现役产品线为 Hailo-8L（13 TOPS）/ Hailo-8（26 TOPS）/ Hailo-10H（40 TOPS INT4 / 20 INT8）/ Hailo-15（视觉 SoC）。下文按 Hailo-8 系论。

## 一、结论

**RK3588 单板（不加任何算力卡）就能跑当前方案**，但有两档：直接移植 ≈ 与 Air 现状打平（10-15fps）；换 NPU 原生管线可到 30fps+。**RK1828 对本方案是过配**——它的价值不在跑这三个小 CNN，而在给整机加 LLM/VLM 大脑（与 MyJavis 融合的战略件）。**Hailo-8 路线不推荐做主力**——有人实测把 MediaPipe 模型编上 Hailo-8，multi-context 在 PCIe 上换页，单手追踪只有 12fps。

## 二、逐组件可行性（RK3588）

| 组件 | Air M5 现状 | RK3588 落地 | 依据 |
|---|---|---|---|
| gaze resnet18（核心新增件） | MPS ~5-8ms | **NPU 4.09ms / 244FPS 实测**——反超 | TinyComputers RK3588 NPU 基准；resnet18 是 RKNN 最标准支持架构，torch→ONNX→RKNN INT8 |
| MediaPipe FaceMesh（眨眼/EAR/UI） | CPU 2.4ms | **aarch64 wheel 存在已验证**（0.10.15 有 cp39-cp312 manylinux aarch64）；CPU 慢 4-5 倍 ≈ 8-12ms | PyPI 直验；RK3588 GB6 单核 ~600-750 vs M 系 ~4000（注意：网传"RK3588 单核 2283"是把多核分误当单核，RK3588S 实测**多核** 2601） |
| MediaPipe Hands | ~10ms | ≈ 35-50ms ← **CPU 直跑的瓶颈** | 同上倍率推算（推断，待真机） |
| ptgaze face_landmarker | 含在 17.5ms 内 | CPU ≈ 15-25ms（推断） | tasks API tflite，XNNPack aarch64 |

## 三、三条路线

### 路线 A：RK3588 直接移植（2-3 天，先做 POC）
mediapipe aarch64 wheel + torch aarch64（或纯 RKNN runtime）+ gaze 模型转 RKNN INT8。**代码架构已留好插槽**：`GAZE_BACKEND` 抽象加 `"rknn"` 分支即可，交互层零改动。预期 10-15fps——与 Air 现状打平，可先验证精度（INT8 量化损失由个性化校准链兜底，需真机重跑 AB 探针确认 SNR 不塌）。
### 路线 B：NPU 原生管线（1-2 周，达标后投）
三模型全上 NPU（3 核 NPU 可并行分配）：RetinaFace/人脸关键点 rknn 版替代 FaceMesh、rknn 生态手部模型替代 Hands、gaze resnet18。预期 30fps+、CPU 大幅空闲。代价：mediapipe 的 21 点手部+pinch 状态机需换等效模型并重标参数（交互层阈值全部要按新信号重审——threshold_dead_signal 教训，换信号源必须重审消费绝对值的阈值）。
### 路线 C：Hailo-8（不推荐主力）
实测反证：MediaPipe palm+hand landmark 编上 Hailo-8 后无手 19fps/单手 12fps/双手 8fps（multi-context PCIe 换页）；且 Hailo 只管模型，前后处理仍压主机 CPU。适合"单一大模型+弱主机"，不适合我们的多小模型管线。

### RK1828 的正确定位
本方案三个小 CNN 合计 <10 GFLOPs/帧，RK3588 自带 6 TOPS NPU 富余，1828 的 20 TOPS + 5GB 用不上。**它的价值在下一步**：项目 README 本就有 MyJavis 融合规划——RK3588（感知：眼动+手势+人脸）+ RK1828（语义：2-7B LLM/VLM 本地推理）= 完整离线多模态交互盒子，5W 加得起。建议等融合规划明确再上。

## 四、与 MacBook Air（M5）对比

| 维度 | Air M5（现状） | RK3588 路线A | RK3588 路线B | +RK1828 |
|---|---|---|---|---|
| gaze 推理 | 5-8ms (MPS) | **4.09ms (NPU)** | 同左 | 同左 |
| 全链帧率 | 15fps（有未解瓶颈） | 10-15fps | **30fps+（预期）** | 同 B |
| CPU 余量 | 大 | 紧张 | 富余 | 富余 |
| LLM 能力 | 可跑（占资源） | 无 | 无 | **2-7B 百token/s** |
| 整机功耗 | ~15-30W | **~7-12W** | 同左 | +5W |
| 成本/形态 | 已有/笔记本 | ~¥600-1000/独立盒子 | 同左 | +模组价（新品未知） |

一句话：**性能上 RK3588 路线 B 有望反超 Air 现状**（Air 的 15fps 本就卡在非推理瓶颈上），功耗形态碾压；Air 的优势只剩开发便利。

## 五、若上 RK3588 的调整清单

1. gaze 模型：torch→ONNX→RKNN INT8（量化校准集用探针采的真实注视数据）；`GAZE_BACKEND="rknn"` 新分支
2. 路线 A 用 mediapipe aarch64 wheel（≤0.10.15，**装依赖严禁自动升级**——铁律同 Mac）；路线 B 换 rknn 模型并重审全部交互阈值
3. MPS/torch 调用 → RKNN runtime；摄像头 V4L2/MIPI-CSI；UI OpenCV on Wayland/X11
4. 真机验收铁门：重跑 AB 探针（INT8 后 SNR 对撞 MPS 版）+ 校准全链 + 帧率分段计时

## 主要来源

- [RK1828 参数（20TOPS/5GB/5W）](https://www.iotdt.com/news/xingyezixun/2648.html) ｜ [瑞芯微官方云栖大会发布](https://www.rock-chips.com/a/cn/news/rockchip/2025/1021/2110.html) ｜ [RK182X datasheet](https://www.scensmart.com/general-description-of-soc/rockchip-rk182x-series-ai-co-processor-datasheet/)
- [RK3588 NPU 基准（resnet18 4.09ms/244FPS）](https://tinycomputers.io/posts/rockchip-rk3588-npu-benchmarks.html) ｜ [RK3588S GB6 多核 2601](https://hwpure.com/submission/1187-rockchip-rk3588s-geekbench-6-multi-core)
- [Hailo-8 跑 MediaPipe 实测（12fps 单手）](https://medium.com/@grouby177/accelerating-the-mediapipe-models-with-hailo-8-69dc24719c9f) ｜ [Hailo 产品线](https://hailo.ai/products/ai-accelerators/hailo-8-ai-accelerator/) ｜ [Hailo model zoo 手部/人脸](https://github.com/hailo-ai/hailo_model_zoo/blob/master/docs/public_models/HAILO8/HAILO8_facial_landmark_detection.rst)
- mediapipe 0.10.15 aarch64 wheel：PyPI JSON API 直验（cp39-cp312 manylinux_2_17_aarch64 存在）
