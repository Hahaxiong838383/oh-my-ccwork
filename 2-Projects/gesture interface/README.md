# gesture interface（手势交互）

> 状态：active（2026-07-10 重启：打包 macOS App + 真机跑通 v3.0 全链路）
> 最后活跃日期：2026-07-10
> 一句话目标：用普通 USB 摄像头，通过「注视预选 + 捏住拖拽」实现自然的手势交互 Demo。

## 下一步
- [ ] MyJavis 结合（2026-07-14 川哥拍板 V0 开工）：本项目面部算法（FaceMesh/EAR/头姿/防抖范式）改造为 MyJavis vision-probe 联调探针（契约 v0.2），评估与方案存档见 `~/mycc/2-Projects/MyJavis/docs/VISION-评估与V0方案.md`
- [x] 川哥真机验收 v3.1 注视精度：通过（2026-07-10）
- [x] 路线 C（捏取即校准）已落地 v3.2：隐式在线校准，越用越准（2026-07-10）
- [x] 路线 B（ETH-XGaze 外观法模型）已落地 v3.8：AB 探针实测垂直 SNR 0.52→11.43 后拍板接入 ptgaze，见 `research-gaze-model-2026-08.md`（2026-08-30）
- [x] 实机跑通验证 v3.0 注视 + 面部特征 + 校准链路：已打包 `/Applications/GestureDemo.app`，川哥真机测试通过（2026-07-10）
- [x] 整理版本号不一致：内层 README 已补 v3.0 条目（面部特征 + 9 点校准 + 2D 注视），标题/结构/快捷键同步更新（2026-07-10）

## 归档条件
- Demo 已完成验证目的、无后续迭代计划 → 移入 `5-Archive/`
- 或被某个正式项目（如产品化的手势交互方案）取代 → 归档并在新项目中引用

## 当前事实
- 项目仅含一个子目录 `gesture_drag_demo/`，是一个可运行的 Python Demo（无独立 GitHub repo，mycc 单仓子目录）。
- 技术栈：OpenCV + MediaPipe（Hands + FaceMesh/Iris），依赖见 `requirements.txt`（opencv-python>=4.8、mediapipe 0.10.9~0.10.15、numpy>=1.24）。
- 能力（基于源码）：手部 21 关键点检测 + Pinch/Release 状态机；粗粒度注视方向估计（头部 + 虹膜加权融合）；注视候选卡片预选与锁定；面部特征追踪（EAR/眨眼/朝向/表情线索）；校准流程；4 桌面 × 12 卡片的拖拽交互 + 气泡系统。
- 版本：v3.9（单一真源 `config.py` VERSION，主界面+校准屏右下角水印同步显示）。注视信号源：ptgaze ETH-XGaze 外观法模型（`GAZE_BACKEND` 一行可回退 legacy 手工管线）。校准档：`~/Library/Application Support/GestureDemo/calibration.json`（删档=物理重置）。
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
- 2026-08-30：v3.6 校准到位门（川哥报告：不看校准点也自动完成标定）：根因=FixationGate 只测稳不测位置（稳定看错地方 std 一样低，且不看点的人完成得更快）；修复=到位门（参照位移+方向 cos 判据，位置驱动提前扫视也判对）+ 未到位 UI 喊话 + 12s 未到位剔除该点不兜底 + LOO 残差剔污染点（训练残差会传染邻居指错人）+ MAE 质量门（<5 点失败/<7 点禁 poly2/超 0.15 红字建议重做）；5 套测试全绿（新增 10 测含事故负向复现）（cc）。
- 2026-08-30：v3.6 川哥真机验收：负向拦截通过（不看点不再假完成）；暴露两回归/新问题：①中上点卡死（arrived 耦合 std，高噪声点位死锁——模拟三 seed 实锤）②主界面候选/进度跳动（卡片进度硬清零+眨眼零防护+隐式重拟合 reset 滤波闪断，均源码实锤）。
- 2026-08-30：v3.7 批次1（川哥拍板，回滚锚点=commit 5f807ad07 v3.6）：①到位门解耦（到位只看位置，std 只管质量，放宽全程有效）②方向自愈（幅度显著仅方向不符→弃方向，拦截力不损失）③校准诊断日志落盘 ~/Library/Logs/GestureDemo-calib.log ④卡片进度衰减不清零 ⑤眨眼冻结候选状态机（15 帧保险丝）⑥隐式重拟合不 reset OneEuro；5 套测试全绿（+5 测），App 重打包部署，待真机验收（重标定看中上点+盯卡片 30s 看进度稳定）；批次2（σ/margin 调参、EAR 眼睑补偿）等批次1验收后按剩余症状动（cc）。
- 2026-08-30：v3.7 川哥真机验收通过（标定通过、中上点恢复；残留正常使用抖动）→ 触发路线B调研：GitHub+Web 增量调研沉淀 `research-gaze-model-2026-08.md`（关键变化：WebEyeTrack 已开源 MIT / PureGaze 无 license 出局 / Gaze360 系确认排除），推荐两步走（AB 探针 → 按数据接入）（cc）。
- 2026-08-30：AB 探针落地（`probe_ab_gaze.py`，ptgaze 装入 venv 时踩 mediapipe 被 uv 自动升 1.0.1 删 legacy API 的坑——pin 回 0.10.15，requirements 上限修正为 ≤0.10.15 硬边界）。川哥真人跑探针：**垂直 SNR 手工 0.52（信号坏死）vs ptgaze 11.43（21.9 倍）**，水平 13.42 vs 5.35（B 够用且被单段异常拖累）；静态图对照：手工管线零输入自抖 std 0.2、模型恒定——抖动根源实锤。拍板接入（cc）。
- 2026-08-30：v3.8 路线B落地（回滚锚点=commit dd06afeaa + 运行时闸门 GAZE_BACKEND="legacy" 一行回退）：gaze_estimator 内嵌 ptgaze ETH-XGaze 信号源（归一化 -yaw/15、-pitch/15 按探针实测定标防削顶），FaceMesh 照跑供眨眼/EAR/UI，模型丢脸自动回退 legacy 顶帧，交互层（校准链/OneEuro/状态机/到位门）零改动；模型收 `models/`（git 不入库缺失自愈）；6 套测试全绿（+test_ptgaze_backend 5 测）；待打包部署+川哥真机验收（cc）。
- 2026-08-30：v3.8 川哥真机验收：标定过程有提高✅；两问题：帧率 13-15（处理超 33ms 摄像头节拍锁定）+ 中下气泡识别不准（几何算账实锤：v3.5 门控常数 0.25 在真垂直信号下封锁屏高 62.5%~75% 的低位气泡——靠坏死信号标定的阈值，信号修好后反成封锁器）（cc）。
- 2026-08-30：v3.8.1（锚点=commit fbaf62c63）三修：①垂直门控改布局几何推导（桌面顶线 ±0.10，set_layout）②ptgaze CPU→MPS（全链 55→17.5ms 实测）③face_debug 默认关+气泡 dwell 时间制（帧率波动不改手感，眨眼时段不计入）；6 套测试全绿（+2 测）。川哥验收：**气泡全部正常✅**；帧率仍 15 ⚠️（MPS 已生效但节拍锁定未解——瓶颈不在推理侧，候选：Hands 推理/imshow 渲染/摄像头曝光帧率，下轮用分段计时定位）（cc）。
- 2026-08-30：v3.9 标定点外扩+增量标定（川哥拍板，锚点=commit 90c1f0657 v3.8.1）：①9 点外扩 10-90%/12-88%（外推区变插值区，GAZE_PT_DEG_SCALE 15→25 防边缘削顶）②校准档持久化 calib_store.py（元数据毒药防御：backend/scale/点表布局任一变更自动弃档）③启动 3 点快验微调（残差≤0.28 合并重拟合，超限自动转全量——环境剧变检测器）④隐式样本跨会话（7 天保鲜回灌）⑤失配哨兵（连续 5 拒→橙字提示按 C）⑥按 C=一键重置+重标+覆盖落盘，删 JSON=逃生门 ⑦主界面常驻按键说明；7 套测试全绿（+test_calib_store 7 测）；待打包部署+真机验收（cc）。
