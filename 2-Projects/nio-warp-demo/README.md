# NIO Warp Demo

用于验证“扩展虚拟画布 + 全反射面预畸变”的最小可行 Demo。

## 当前状态

- 已实现纯软件闭环，不依赖真实挡风玻璃。
- 自动生成模拟反射 Footprint、目标方正网格、预畸变屏幕图和校正结果。
- 同时输出安全矩形模式和全反射面模式对比。
- 全反射面模式使用扩展画布，完整利用模拟反射区域。

## 一键运行

```bash
cd /Users/rayman.chen/mycc/2-Projects/nio-warp-demo
uv sync
uv run nio-warp-demo --output artifacts/latest
```

## 外接 32 寸显示器交互 Demo

直接双击：

```text
/Users/rayman.chen/mycc/2-Projects/nio-warp-demo/start-display-demo.command
```

或者在终端启动：

```bash
cd /Users/rayman.chen/mycc/2-Projects/nio-warp-demo
uv run nio-warp-display-demo
```

使用步骤：

1. 浏览器自动打开笔记本控制台。
2. 点击“打开外接屏窗口”。
3. 把新窗口拖到 32 寸显示器。
4. 在外接屏窗口按 `F` 进入全屏。
5. 在笔记本控制台实时调整画布高度和模拟玻璃参数。
6. 外接屏按 `1`–`4` 查看扩展画布、未校正反射、物理预畸变和校正结果。

## 原生整屏接管 Demo

当前本机开发验收版为 **v0.4.2 (6)**，固定安装路径：

```text
/Users/rayman.chen/Applications/NIOWarpApp.app
```

控制台窗口标题和界面顶部都会显示当前 Bundle 版本。日常启动应使用固定安装版；`native/dist/NIOWarpApp.app` 仅是构建产物，不作为用户侧版本真值。

重新构建并安装最新版：

```bash
cd /Users/rayman.chen/mycc/2-Projects/nio-warp-demo/native
scripts/install-app.sh
```

原生版本使用 ScreenCaptureKit 捕获目标外接屏的整个桌面，排除程序自身的覆盖窗口后，再使用 Metal 实时 Warp 回同一块外屏。

```text
/Users/rayman.chen/mycc/2-Projects/nio-warp-demo/start-native-warp.command
```

首次启动时：

1. macOS 会请求“屏幕与系统音频录制”权限。
2. 在系统设置中允许 `NIOWarpApp`。
3. 退出应用后，再次双击启动脚本。
4. 三星外屏上原本存在的桌面、菜单栏和所有应用窗口会被整体 Warp。
5. MacBook 内置屏保留控制面板，用于实时调节 Warp 参数。

程序通过 ScreenCaptureKit 排除自身应用，避免“捕获外屏同时又在外屏显示”产生无限回采。覆盖窗口支持鼠标穿透，但点击坐标尚未做逆向映射，因此当前适合画面展示验证；需要精确交互时，应继续增加输入坐标反向映射。

### 原生标定功能

- **矩形 AA 区**：以外屏物理像素设置 `X / Y / 宽 / 高`，AA 区外由 Metal 每帧清为纯黑。
- **逻辑画布**：独立设置 UI 最大画布宽高；默认保持比例铺满并裁切多余边缘，可调水平/垂直裁切位置。
- **自动全屏内容跟随**：输入源可选“整个外接屏幕”或“自动跟随全屏窗口”；自动模式识别覆盖外屏 82% 以上且连续稳定的最大窗口，约 1 秒内动态切为单窗口捕获，退出全屏或关闭窗口后自动恢复整屏。
- **跨应用原生全屏覆盖**：应用以辅助模式运行，输出层使用 `canJoinAllApplications` 加入 QuickTime、IINA 等第三方应用的全屏 Space；播放器全屏后仍由 AA/Warp 输出层覆盖，不会直接露出原始全屏画面，内屏控制台继续可见。
- **镜像**：支持水平翻转、垂直翻转及两者组合。
- **基础 Warp**：实时调节弧度、压缩、不对称、倾斜和水平弯曲。
- **多项式增量**：支持 2–5 阶二维多项式，逐项编辑 X/Y 系数，并实时检查网格折叠和 AA 越界。
- **配置持久化**：所有设置自动保存；支持完整配置 JSON 或仅多项式 JSON 导入、完整配置导出和恢复默认。
- **抗锯齿**：独立总开关；关闭时使用点采样，开启后可选 4 点性能档或 9 点质量档，并提供左右分屏 A/B 诊断图。
- **畸变趋势**：支持同向模拟和反向预畸变；反向模式统一反转基础 Warp 与多项式位移，并重新铺满 AA 区。
- **外屏自适应**：Retina 外屏按物理像素捕获和渲染；配置按显示器硬件标识独立保存，避免跨屏参数污染。
- **自动性能保护**：质量档低于 55 FPS 或 GPU P95 超过 14 ms 时，运行时自动降到性能档，不覆盖保存配置。
- **标定测试图**：一键显示主次网格、红绿中心线和白色边界；“一键无畸变标定”可临时关闭全部 Warp，且不改写保存参数。
- **预设与历史**：预设按名称保存，应用前检查外屏分辨率；最多保留 30 个历史版本并支持一键回退。
- **安全恢复**：可暂停覆盖层；全局 `⌃⌥⌘Esc` 紧急隐藏；外屏断开、休眠或分辨率变化时先隐藏再重建。

示例配置：`native/config/default-warp-configuration.json`。多项式按总次数排列，例如三阶系数顺序为：

```text
1, x, y, x², x·y, y², x³, x²·y, x·y², y³
```

系数采用归一化坐标，输入画布中心为 `(0, 0)`，取值范围约为 `[-1, 1]`；输出系数是相对于 AA 区宽高的增量比例。

默认配置为 5120×2880 外屏、居中 `88%×48%` AA 区、7680×936 逻辑画布和保持比例铺满裁切模式。画布尺寸表示 UI 的逻辑最大尺寸；当前 Demo 捕获现有 macOS 桌面后重新采样，不会改变 macOS 自身的窗口排版分辨率。

### 阶段 1 使用建议

1. 初次标定先开启“标定网格、中心线和边界”。
2. 默认使用“性能模式”，确认 5K 60 FPS 稳定后再试“质量模式”。
3. 每完成一组有效参数就保存命名预设。
4. 任何异常按 `⌃⌥⌘Esc`，外屏会立即恢复原始桌面。
5. 阶段 1 回滚点见 `.rollback/20260812-190000-phase1-baseline/RESTORE.txt`；v0.4.0 开发前 Git 回滚点见 `.rollback/20260813-194500-auto-fullscreen-baseline/RESTORE.txt`。

### 当前 P0 状态

1. **外屏验收通过**：保持原始比例、铺满目标区域、裁切多余边缘，并支持裁切位置微调。
2. **软件验收通过，待玻璃拍摄**：一键无畸变标定不覆盖配置，A/B 退出后恢复进入前的预览状态。
3. **外屏验收通过**：抗锯齿总开关、真实点采样关闭状态，以及左右完全相同图案的 A/B 对比。
4. **外屏验收通过**：Retina 物理像素适配、显示器配置隔离和反向预畸变趋势。
5. **后续 P0**：物理点击坐标到原桌面坐标的逆 Warp 输入映射。
6. **v0.4.0**：支持自动跟随第三方全屏窗口并按画布比例铺满裁切；普通 16:9 内容映射到极端超宽画布时仍会裁掉上下内容，这是保持比例且不留黑边的必然结果。

详细方案见 [`docs/p0-next-implementation-plan.md`](docs/p0-next-implementation-plan.md)，本轮离线结果见 [`docs/p0-offline-acceptance.md`](docs/p0-offline-acceptance.md)。

运行后重点查看：

- `artifacts/latest/contact_sheet.png`：完整结果总览。
- `artifacts/latest/physical_predistorted.png`：物理屏幕应显示的预畸变画面。
- `artifacts/latest/observed_corrected.png`：经过模拟反射后看到的校正结果。
- `artifacts/latest/acceptance_report.json`：自动验收数据。

## 验收

```bash
uv run pytest -q
uv run nio-warp-demo --output artifacts/latest --strict
```

原生阶段 1 验收清单见 [`docs/phase-1-acceptance.md`](docs/phase-1-acceptance.md)。

`--strict` 会在以下条件不满足时返回失败：

- 全反射目标内容覆盖率不低于 99%。
- 使用轻微抗锯齿平滑后，校正网格平均绝对误差不高于 4 灰度级。
- 使用轻微抗锯齿平滑后，校正网格 P95 误差不高于 12 灰度级。
- 映射没有大面积越界或空洞。

## MVP 边界

本版本已验证 ScreenCaptureKit 捕获整块外屏、Metal 60 FPS 实时 Warp、同屏回显和完整内容利用。当前仍未验证真实挡风玻璃光学、7680×936 目标硬件性能以及 Warp 后输入坐标反向映射。下一阶段应使用固定机位拍摄真实网格，以实测控制点替换当前模拟模型。

完整经验复盘与下一阶段检查清单见 [`docs/lessons-learned.md`](docs/lessons-learned.md)。
