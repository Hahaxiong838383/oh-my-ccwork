# gesture interface（手势交互）

> 状态：paused（依据：纯本地实验 Demo，无 git/外部 repo；源码最后修改 2026-03-27，距今约 2.5 个月无新提交，呈停顿态）
> 最后活跃日期：2026-03-27
> 一句话目标：用普通 USB 摄像头，通过「注视预选 + 捏住拖拽」实现自然的手势交互 Demo。

## 下一步
- [ ] 待川哥确认：本项目是继续迭代、还是已达 Demo 验证目的可归档
- [ ] 若继续：实机跑通 `app.py`（需摄像头），验证 v3.0 注视 + 面部特征 + 校准链路
- [ ] 整理版本号不一致：`app.py` 头注释为 v3.0，内层 `gesture_drag_demo/README.md` 版本历史仅记到 v2.0，待补 v3.0 条目

## 归档条件
- Demo 已完成验证目的、无后续迭代计划 → 移入 `5-Archive/`
- 或被某个正式项目（如产品化的手势交互方案）取代 → 归档并在新项目中引用

## 当前事实
- 项目仅含一个子目录 `gesture_drag_demo/`，是一个可运行的 Python Demo（无独立 GitHub repo，mycc 单仓子目录）。
- 技术栈：OpenCV + MediaPipe（Hands + FaceMesh/Iris），依赖见 `requirements.txt`（opencv-python>=4.8、mediapipe 0.10.9~0.10.15、numpy>=1.24）。
- 能力（基于源码）：手部 21 关键点检测 + Pinch/Release 状态机；粗粒度注视方向估计（头部 + 虹膜加权融合）；注视候选卡片预选与锁定；面部特征追踪（EAR/眨眼/朝向/表情线索）；校准流程；4 桌面 × 12 卡片的拖拽交互 + 气泡系统。
- 版本：`app.py` 标注 v3.0（含面部特征 + 校准），内层 README 标注 v2.0（注视预选），存在版本号不一致（本轮观察）。
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
