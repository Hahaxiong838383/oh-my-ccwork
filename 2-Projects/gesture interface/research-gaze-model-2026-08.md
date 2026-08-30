# 眼动模型升级调研（2026-08-30 · 路线B触发）

> 触发：v3.7 批次1 验收通过后，正常使用仍有识别抖动（川哥反馈）。
> 方法：gh search repos + Web 检索，在 [`research-gaze-accuracy-2026-07.md`](./research-gaze-accuracy-2026-07.md) 基础上增量更新。
> 基线：MediaPipe FaceMesh 手工几何特征（head/iris 加权）+ 二阶多项式校准 + OneEuro + 隐式校准（v3.7）。
> 核心判断：抖动的根子在**手工几何特征的 per-frame 噪声**（虹膜单点比例对像素抖动极敏感），
> 平滑/状态机只能治标；外观法模型（整脸 CNN）per-frame 输出天然更稳，是精度与抖动的同一剂药。

## 一、相对 2026-07 报告的关键变化

| 2026-07 结论 | 2026-08 现状 | 影响 |
|---|---|---|
| PureGaze 首选（license 需查仓库确认） | **官方 repo 无 LICENSE 文件（77★）= 默认版权保留** | ❌ 出局（除非联系作者） |
| WEBEYETRACK 仅论文（arXiv 2508.19544） | **已开源 RedForestAI/WebEyeTrack，MIT，55★，2026-08-27 活跃；Python PyPI 包 + JS NPM 包** | ✅ 升为首选候选 |
| MobileGaze 备选（MIT+ONNX） | 确认全系仅 Gaze360 训练（MAE 11-13° 域内） | ❌ 维持出局（head-gaze conflict 退化） |
| — | GazeFollower 新出（ACM'25，带校准 1.11cm） | ⚠️ CC BY-NC-SA 禁商用 + 「Reduce Jitter」在待办清单 → 出局 |
| — | OpenFace 3.0（CMU 多任务工具箱） | ⚠️ gaze 是副产物、精度未公布、学术 license 惯例 → 观察 |
| — | CapStARE（ETH-XGaze 3.36° + <10ms） | 论文级，未见开源 repo → 观察 |

## 二、候选终表

| 方案 | license | 形态 | 关键数字 | 判定 |
|---|---|---|---|---|
| **WebEyeTrack**（RedForestAI） | MIT ✅ | Python 包（TF/Keras）+ JS 包；模型+few-shot 校准+屏幕坐标全链 | 2.32cm@GazeCapture；**9 样本 few-shot**（与我们 9 点校准同构）；2.4ms@iPhone14 | **首选试点** |
| **ptgaze**（hysts, 372★） | MIT ✅ | pip 装；ETH-XGaze resnet18 模型，输出 pitch/yaw | ETH-XGaze 系抗 head-gaze conflict（Gaze4HRI 实锤） | **备选：模型级替换，保留我们全部交互层** |
| L2CS-Net（523★ MIT） | MIT | torch | Gaze360 训练：conflict 每 1° 加 ~1° 误差 | ❌ 场景不合 |
| MobileGaze/yakhyo（208★） | MIT | ONNX 全套 | 仅 Gaze360 训练 | ❌ 同上 |
| GazeFollower（34★） | CC BY-NC-SA | 全链系统 | 1.11cm（带校准） | ❌ 禁商用+减抖未做 |
| PureGaze（77★） | **无 license** | torch | 零样本最稳（旧调研） | ❌ 法律不可用 |
| 3DGazeNet（128★） | 无 license | torch | ECCV'24 | ❌ 同上 |
| OpenFace 3.0（190★） | 待确认 | 多任务工具箱 | gaze 精度未公布 | 观察 |

## 三、推荐路线（两步走）

### 第一步：A/B 探针（~0.5 人日，先做）
写一个独立小脚本，同一摄像头流上并排跑「现有手工管线 vs 候选模型」，输出两条 gaze 曲线：
- 量化指标：静视 30s 的输出 std（抖动）、注视切换的阶跃响应延迟；
- 肉眼指标：两个光标并排画在验证屏上。
先测 **ptgaze**（pip 一装就有，接口最省），WebEyeTrack Python 包其次（TF 依赖重，装得动再测）。
**用数据决定换不换、换哪个——不先重构。**

### 第二步：按探针结果接入（2-3 人日）
- 若 ptgaze 胜出：`gaze_estimator.py` 内部把 head/iris 手工融合替换为模型推理，输出 pitch/yaw → 归一化 → **完整保留现有校准（显式 9 点 + 隐式捏取）+ OneEuro + 候选状态机 + 到位门**——四轮打磨的交互层全部不动，只换信号源。
- 若 WebEyeTrack 胜出：它自带 few-shot 校准与屏幕坐标输出，与我们校准链重叠——取其模型层输出（禁用其校准）接我们的链，或做适配层对比两种接法。
- 兜底：两者都不比现有管线好 → 回到批次2（σ/margin 调参 + EAR 眼睑补偿 + 双眼虹膜亚像素），零新依赖。

### 风险与注意
- **ETH-XGaze 权重的许可**：数据集条款为研究用途，衍生权重商用性存疑——当前 demo 阶段无碍，产品化前需复核（与 MyJavis 结合规划相关）。
- WebEyeTrack 的 TF/Keras 依赖与 PyInstaller 打包体积（当前 565MB 会更大）。
- 模型推理帧率在无独显 Mac 上需实测（resnet18@CPU 预计可 30fps，待验证）。
- 换模型后 config 里 HEAD_*/IRIS_* 系列参数作废，校准期望值域需重标定一次。

## 主要来源

- github.com/RedForestAI/WebEyeTrack（MIT）｜ arXiv 2508.19544（2.32cm / k<9 / 2.4ms@iPhone14）
- github.com/hysts/pytorch_mpiigaze_demo（MIT, ptgaze, ETH-XGaze resnet18）
- github.com/yakhyo/gaze-estimation（MIT，确认仅 Gaze360 训练）｜ github.com/Ahmednull/L2CS-Net
- github.com/GanchengZhu/GazeFollower（CC BY-NC-SA）｜ github.com/yihuacheng/PureGaze（无 license）
- github.com/CMU-MultiComp-Lab/OpenFace-3.0 ｜ arXiv 2509.19936（CapStARE）｜ arXiv 2605.04770（Gaze4HRI 零样本基准）
