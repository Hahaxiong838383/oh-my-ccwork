# P003 场景美术化 Skill 迭代日志

## V1.0 · 2026-05-14 23:00（D3.5 完工沉淀）

**触发场景**：川哥连续 3 次让 cc 把抽象 CSS 占位场景替换为写实美术图。第 3 次时（AskMode）成功复用前 2 次经验、零返工实施。

**沉淀内容**：
- 4 条铁律（状态机零侵入 / PNG 自包含 UI / 3 轻动效黄金组合 / TTS sayDirect 开口）
- 7 步实施流程（资产准备 → 测坐标 → 套模板 → 状态机集成 → TTS 集成 → AudioContext 解锁 → 验证）
- 1 份参数化模板代码（`template-scene.tsx`，6 处 TODO 标记）
- 3 个实施案例（setup / welcome / askmode）

**关键参数表**：
- 星点：drift 3-4cqw / 周期 3-3.8s / opacity 0.25→1.0 / scale 0.65→1.25 / 数量 5-6
- 表情屏绿光：14-18cqw × 11-13cqh / 1.8s / opacity 0.25→0.85 / scale 0.9→1.12 / mix-blend screen + @supports 降级
- 字幕暖白光晕：rgba(255,240,210,0.32) / 2.6s 周期

**踩过的 6 个坑**（已写入 SKILL.md 反模式清单）：
1. PNG 双 .png 后缀（Finder 隐藏扩展名）
2. 动效太保守 4s 内看不见（4cqw drift / 3s 周期 是下限）
3. codex 多文件改动遗漏 server 入口白名单（contract gate）
4. AudioContext 用户手势栈陷阱（unlockAudio 提前到按钮 onClick）
5. voice-client emit 依赖外部监听（改 service 内部统一播放）
6. 字幕冷蓝光晕与暖色场景打架（必须暖白）

## 待迭代场景

- [ ] NightReport（夜航报告，6s 时长，可能需要图表/数据动效）
- [ ] OpenBox 4 级（common/rare/epic/legendary，每级颜色不同，烟花 + 震屏 + reward HUD）
- [ ] EcoUnlock（生态缸 Lv2 升级，4s 分段：背景→鱼缸→鱼游→灯亮）
- [ ] Farewell（关盖告别，小可挥手 + slogan）
- [ ] focusRunning（主交互场景，复杂，可能不适合纯 PNG）

**注意**：OpenBox/EcoUnlock 这种"已经有复杂 CSS 动画"的场景，PNG 替换要慎重 —— 可能损失原有动效。建议 PNG 仅作背景层，原 CSS 动画保留为前景层。

## 更新协议

每实施新场景后，cc 自动：
1. 在本日志加一段新场景实施记录
2. 在 `examples/<scene>.md` 创建该场景案例
3. 如果有新的反模式或新坑，更新 SKILL.md 对应 section
4. bump V 号（V1.x 小迭代 / V2.0 方法论重大变更）
