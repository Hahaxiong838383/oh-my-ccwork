# gesture interface（手势交互）

> 状态：active（2026-07-10 重启：打包 macOS App + 真机跑通 v3.0 全链路）
> 最后活跃日期：2026-07-10
> 一句话目标：用普通 USB 摄像头，通过「注视预选 + 捏住拖拽」实现自然的手势交互 Demo。

## 下一步
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
- 2026-07-10：补齐内层 README v3.0 文档；PyInstaller 打包 macOS App（`gesture_drag_demo/dist/GestureDemo.app`，564MB，构建配置 `GestureDemo.spec`，摄像头授权 + 实机启动已验通）（cc）。
- 2026-07-10：App 部署 `/Applications/GestureDemo.app`，川哥真机测试 v3.0 全链路（9 点校准 + 注视预选 + 手势拖拽 + 面部特征）通过，项目状态 paused → active（cc）。
- 2026-07-10：注视精度深度调研（deep-research 多源+对抗验证，报告 `research-gaze-accuracy-2026-07.md`）+ v3.1 路线A 落地：二阶多项式校准（xy 交叉项+仿射兜底）+ OneEuro 平滑，4 测全过，App 已重打包部署，川哥真机验收通过（cc）。
- 2026-07-10：应用图标上线（GPT Image 2 生成金瞳之眼+捏卡片主题，假透明修复 + icns 转换，源图与 icns 在 `gesture_drag_demo/assets/`），重打包部署验证通过（cc）。
- 2026-07-10：v3.2 路线C 捏取即校准落地：隐式在线校准（pinch 抓卡=注视弱标签+滑窗增量重拟合+离群拒绝+锚点保底），uncal 字段防复合漂移，4 测全过（漂移修正实测 -59%），App 部署（cc）。
- 2026-07-10：v3.2 川哥真机验收通过（隐式校准体感有效）。调研三路线：A✅ C✅，B 留触发条件（cc）。
- 2026-07-10：v3.3 校准质量闭环（川哥提案）：FixationGate 门控（滑窗 std 盯稳才计样本）+ 点位进度环转圈变绿 + 超时放宽降级防卡死，12 测全过，App 部署（cc）。
- 2026-07-10：v3.3 川哥真机验收通过（质量环转圈体验 OK）。
