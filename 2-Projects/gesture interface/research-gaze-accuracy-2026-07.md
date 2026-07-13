# 眼球注视估计精度提升调研（2026-07-10）

> 方法：deep-research 多源检索（5 路并行）+ 逐源主张提取 + 源质量标注，43 个结果合成。
> 基线：MediaPipe FaceMesh 虹膜关键点 + head/iris 加权融合 + 9 点仿射校准（gaze_estimator.py v3.0）。
> 场景：12 卡片区域级注视预选，主痛点 = 垂直方向与边缘区域。

## 一、先校准预期：论文数字 vs 真实世界

- 域内基准（MPIIFaceGaze 等）的 4° 量级是理想值；**零样本跨域真实误差是 7-20°**（Gaze4HRI 2026 基准 arXiv:2605.04770；NICO 实测 arXiv:2509.24001：GazeTR 14.7°/L2CS 19.7°）
- **个人校准是精度的关键环节，不是可选项**：OpenVINO/ETH-XGaze 模型 + 仅 4 点变换回归即可 6.95°→3.3°（2024，Sensors）——校准把误差砍半是普遍规律
- 需求账：13" 屏 4×3 卡片 ≈ 每卡 8°×7°（50cm 视距），容忍半卡误差 → **需要 ~3-4° 精度**。零样本外观法不够，校准后刚好够
- **垂直差是物理性的、所有方案共有**：向下看时眼睑跟随遮挡，最好的模型误差也从 6.85° 恶化到 14.95°（Gaze4HRI）。本项目代码的对应根因：`iris_dir_y` 用"虹膜在上下眼睑间位置比"，把视线和眼睑位置混在一个信号里
- 机理确认：**眼动非线性集中在屏幕顶部行和左右边缘**（ETRA GP 校准研究）——正是我们"边缘+垂直差"的痛点位置，说明升级校准函数直接对症

## 二、Top3 推荐路线

### 路线 A：工程增强现有几何法（1-2 人日，先做）
1. **校准升级**：per-axis 仿射 → **含 xy 交叉项的二阶多项式**（PMC 误差分布研究：二阶含交叉项是甜点，高阶不必然更好；GP 回归在 720p 噪声下优势被吃掉不值得上）。9 点刚好够拟合，边缘要更稳可加到 12-16 点
2. **EMA → OneEuro**：cc-AirPlayer 的 `sense/one_euro.py` 现成实现直接搬（UnitEye MuC'24 实测三滤波对比后推荐 OneEuro）
3. 垂直信号用 EAR 做眼睑联动补偿实验（低置信，靠校准多项式兜底）
- 预期：边缘/垂直明显改善，零新依赖零许可风险。**不动模型就能吃到的增益**

### 路线 B：外观法模型替换手工融合（3-5 人日）
- **选 ETH-XGaze 系预训练权重，别选 Gaze360 系**——这是调研最有价值的选型结论：
  - 我们的场景是"头不动、只动眼看卡片" = **head-gaze conflict**，Gaze360 系模型每 1° conflict 增加 ~1° 误差（MCGaze 斜率 +0.99°/°），ETH-XGaze 系几乎不受影响
  - 零样本：PureGaze(ETH-XGaze) 7-12° vs L2CS(Gaze360) 19°、MobileGaze 11-13°
- 首选 **PureGaze**（零样本最稳 + 推理 500+ FPS 量级；license 需查仓库确认）；备选 yakhyo/MobileGaze（MIT + ONNX 全套 + 4.8MB 轻量档，但 Gaze360 训练跨域较弱）
- 架构：模型输出 yaw/pitch → 接路线 A 升级后的多项式校准 → 屏幕坐标。TPAMI 综述实证：头姿当特征拼接无效、全脸端到端优于手工融合——**现有 head 0.35/iris 0.65 加权属于被证明上限低的路线**
- 部署：ONNX Runtime（CoreML EP）在 M5 上预算富余
- 预期：校准后 ~3° 量级可期（同构路径实证 3.2-3.3°），垂直与头姿鲁棒性质变

### 路线 C：捏取即校准——隐式在线校准（+2-3 人日，叠加 B）
- Sugano 范式（IEEE THMS 2015，实测 2.9°）：交互点击 = 注视标签。**本 demo 有天然标签：用户 pinch 抓卡片的瞬间视线必在卡片上** → 每次抓取产出一个校准样本，在线增量更新校准回归，按头姿聚类局部模型
- 2025 年 WEBEYETRACK（arXiv:2508.19544）证明 few-shot 端上个性化同方向可行
- 预期：越用越准，且把"换座位/换姿势后校准漂移"问题一并解决

## 三、明确不值得做

| 方案 | 否决理由 |
|---|---|
| GeoGaze (2026) | 只输出左/中/右三分类，比现状还粗 |
| GP/高斯过程校准 | 仿真显示优势在低分辨率特征噪声下归零（720p 正中枪），二阶多项式即可 |
| MediaPipe iris + Kalman 论文 | 源质量标记 unreliable（延迟数据自相矛盾 10 倍，指标无定义） |
| 视频时序模型 (MCGaze) | 19.6 FPS，超实时预算 |
| Apple 官方路径 | 死路实锤：Vision framework 只有瞳孔关键点无注视方向；ARKit lookAtPoint 仅 iOS+TrueDepth；iOS 18 Eye Tracking 是 accessibility 功能无开发者 API、无 macOS 版 |
| GazeTR / UnitEye 直接复用 | 许可雷：CC BY-NC-SA（禁商用）/ GPL 传染 |

## 四、建议执行序

A → 真机验收 → 不够再 B → C 锦上添花。A 的两项（多项式校准 + OneEuro）半天可出可测版本；若 A 后区域选择已稳，B/C 留作产品化再上。

## 主要来源

- Gaze4HRI 零样本基准（2026）arXiv:2605.04770 ｜ NICO 实测（2025）arXiv:2509.24001 + github.com/kocurvik/nico_gaze
- TPAMI 综述 + GazeHub 基准 arXiv:2104.12668 ｜ 4 点校准实证（2024）Sensors s25134086 相关
- GP vs 多项式校准 ETRA'16 ｜ 多项式阶数误差分布 PMC7733312 ｜ 校准综述 PMC10987702
- Sugano 隐式校准 IEEE THMS 2015 ｜ WEBEYETRACK arXiv:2508.19544 ｜ UnitEye MuC'24（滤波对比）
- 模型仓：github.com/yakhyo/gaze-estimation (MIT) ｜ Ahmednull/L2CS-Net (MIT) ｜ yihuacheng/GazeTR (CC BY-NC-SA) ｜ MediaPipe iris 官方文档（64×64 输入 + 官方声明不做注视推断）
