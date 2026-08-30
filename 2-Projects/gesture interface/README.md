# gesture interface（手势交互）

> 状态：active（2026-07-10 重启：打包 macOS App + 真机跑通 v3.0 全链路）
> 最后活跃日期：2026-07-10
> 一句话目标：用普通 USB 摄像头，通过「注视预选 + 捏住拖拽」实现自然的手势交互 Demo。

## 下一步
- [ ] MyJavis 结合（2026-07-14 川哥拍板 V0 开工）：本项目面部算法（FaceMesh/EAR/头姿/防抖范式）改造为 MyJavis vision-probe 联调探针（契约 v0.2），评估与方案存档见 `~/mycc/2-Projects/MyJavis/docs/VISION-评估与V0方案.md`
- [x] 川哥真机验收 v3.1 注视精度：通过（2026-07-10）
- [x] 路线 C（捏取即校准）已落地 v3.2：隐式在线校准，越用越准（2026-07-10）
- [ ] 路线 B（PureGaze/ETH-XGaze 外观法模型）触发条件：换环境明显退化 或 卡片网格加密需求，见 `research-gaze-accuracy-2026-07.md`
- [x] 实机跑通验证 v3.0 注视 + 面部特征 + 校准链路：已打包 `/Applications/GestureDemo.app`，川哥真机测试通过（2026-07-10）
- [x] 整理版本号不一致：内层 README 已补 v3.0 条目（面部特征 + 9 点校准 + 2D 注视），标题/结构/快捷键同步更新（2026-07-10）

## 归档条件
- Demo 已完成验证目的、无后续迭代计划 → 移入 `5-Archive/`
- 或被某个正式项目（如产品化的手势交互方案）取代 → 归档并在新项目中引用

## 当前事实
- 项目仅含一个子目录 `gesture_drag_demo/`，是一个可运行的 Python Demo（无独立 GitHub repo，mycc 单仓子目录）。
- 技术栈：OpenCV + MediaPipe（Hands + FaceMesh/Iris），依赖见 `requirements.txt`（opencv-python>=4.8、mediapipe 0.10.9~0.10.15、numpy>=1.24）。
- 能力（基于源码）：手部 21 关键点检测 + Pinch/Release 状态机；粗粒度注视方向估计（头部 + 虹膜加权融合）；注视候选卡片预选与锁定；面部特征追踪（EAR/眨眼/朝向/表情线索）；校准流程；4 桌面 × 12 卡片的拖拽交互 + 气泡系统。
- 版本：v3.6（单一真源 `config.py` VERSION，UI 右下角水印同步显示）。
- 运行入口为 `python app.py`，需 USB 摄像头；快捷键 ESC 退出 / R 重置 / G 注视调试 / F 面部特征 / C 重新校准。
- 文件修改时间：核心源码（app/config/ui/hand_tracker/gesture_state/gaze_estimator/face_tracker）均为 2026-03-27；较早文件（calibration/attention_selector/requirements/内层 README）为 2026-03-23。

## 关键入口
| 入口 | 路径/链接 | 说明 |
|------|-----------|------|
| 主程序 | `gesture_drag_demo/app.py` | 主循环：手势拖拽 + 注视预选 + 面部特征融合（v3.0） |
| 参数配置 | `gesture_drag_demo/config.py` | 所有可调阈值集中管理（摄像头/Pinch/注视/候选） |
| 详细说明 | `gesture_drag_demo/README.md` | Demo 原始文档（安装/运行/交互/技术原理/版本历史，记至 v2.0） |
| 依赖清单 | `gesture_drag_demo/requirements.txt` | Python 依赖 |
| 手部检测 | `gesture_drag_demo/hand_tracker.py` | 摄像头 + MediaPipe Hands 关键点 |
| 注视估计 | `gesture_drag_demo/gaze_estimator.py` | FaceMesh + Iris 粗粒度注视方向 |
| 面部特征 | `gesture_drag_demo/face_tracker.py` | EAR/眨眼/朝向/表情线索 |
| 候选选择 | `gesture_drag_demo/attention_selector.py` | 注视候选卡片评分与锁定 |
| 校准 | `gesture_drag_demo/calibration.py` | 启动时注视校准流程 |
| UI 绘制 | `gesture_drag_demo/ui.py` | 桌面/卡片/气泡绘制、拖拽、调试可视化 |

## 外部信息
| 类型 | 值 |
|------|----|
| 外部 repo | 无（mycc 单仓子目录，无独立 GitHub repo） |
| 服务地址 | 无（纯本地运行，无网络服务） |
| 端口 | 无 |
| 负责人 | 川哥（待确认） |

## 进度记录
- 2026-06-17：基于本地内容生成项目状态卡（cc）。
- 2026-07-10：补齐内层 README v3.0 文档；PyInstaller 打包 macOS App（`gesture_drag_demo/dist/GestureDemo.app`，564MB，构建配置 `GestureDemo.spec`，摄像头授权 + 实机启动已验通）（cc）。
- 2026-07-10：App 部署 `/Applications/GestureDemo.app`，川哥真机测试 v3.0 全链路（9 点校准 + 注视预选 + 手势拖拽 + 面部特征）通过，项目状态 paused → active（cc）。
- 2026-07-10：注视精度深度调研（deep-research 多源+对抗验证，报告 `research-gaze-accuracy-2026-07.md`）+ v3.1 路线A 落地：二阶多项式校准（xy 交叉项+仿射兜底）+ OneEuro 平滑，4 测全过，App 已重打包部署，川哥真机验收通过（cc）。
- 2026-07-10：应用图标上线（GPT Image 2 生成金瞳之眼+捏卡片主题，假透明修复 + icns 转换，源图与 icns 在 `gesture_drag_demo/assets/`），重打包部署验证通过（cc）。
- 2026-07-10：v3.2 路线C 捏取即校准落地：隐式在线校准（pinch 抓卡=注视弱标签+滑窗增量重拟合+离群拒绝+锚点保底），uncal 字段防复合漂移，4 测全过（漂移修正实测 -59%），App 部署（cc）。
- 2026-07-10：v3.2 川哥真机验收通过（隐式校准体感有效）。调研三路线：A✅ C✅，B 留触发条件（cc）。
- 2026-07-10：v3.3 校准质量闭环（川哥提案）：FixationGate 门控（滑窗 std 盯稳才计样本）+ 点位进度环转圈变绿 + 超时放宽降级防卡死，12 测全过，App 部署（cc）。
- 2026-07-10：v3.3 川哥真机验收通过（质量环转圈体验 OK）。
- 2026-07-13：v3.4 气泡凝视驻留环（川哥提案）：dwell 锁定 3→30 帧 + 环形进度弧 + 衰减不清零，3 新测全过；同日将质量门控范式迁移至 cc-AirPlayer v4.14 标定（HandFixationGate，263 测过）（cc）。
- 2026-07-13：v3.4.1 修历史级 bug（川哥报告气泡环不走引出）：set_dragging 每帧无条件清空锁定计数——卡片 8 帧锁定/气泡锁定自 v3.0 起从未真正达成，候选高亮每帧重算掩盖了它；改转换沿触发，18 测全过（+2 帧序回归测）。同日 AirPlayer 加旧标定沿用提示条（按 C 体验 v4.14 新标定）（cc）。
- 2026-07-13：v3.5 垂直注视门控：卡片仅视线下方参与评分、气泡仅上方累积进度（config CARD_GAZE_Y_MIN/BUBBLE_GAZE_Y_MAX），修「盯气泡底部卡片躺枪跳选中」（1D 水平评分的历史设计），20 测全过（cc）。
- 2026-07-13：v3.5 川哥真机验收通过（垂直门控生效，底部卡片不再躺枪）。
- 2026-08-30：v3.6 校准到位门（川哥报告：不看校准点也自动完成标定）：根因=FixationGate 只测稳不测位置（稳定看错地方 std 一样低，且不看点的人完成得更快）；修复=到位门（参照位移+方向 cos 判据，位置驱动提前扫视也判对）+ 未到位 UI 喊话 + 12s 未到位剔除该点不兜底 + LOO 残差剔污染点（训练残差会传染邻居指错人）+ MAE 质量门（<5 点失败/<7 点禁 poly2/超 0.15 红字建议重做）；5 套测试全绿（新增 10 测含事故负向复现），待川哥真机验收（正向：正常跟点无感通过；负向：故意不看点 → 喊话+剔除+失败明示）（cc）。
