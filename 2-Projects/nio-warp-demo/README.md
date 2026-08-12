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

原生版本使用 ScreenCaptureKit 捕获三星外接屏的整个桌面，排除程序自身的覆盖窗口后，再使用 Metal 实时 Warp 回同一块三星外屏。

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

`--strict` 会在以下条件不满足时返回失败：

- 全反射目标内容覆盖率不低于 99%。
- 使用轻微抗锯齿平滑后，校正网格平均绝对误差不高于 4 灰度级。
- 使用轻微抗锯齿平滑后，校正网格 P95 误差不高于 12 灰度级。
- 映射没有大面积越界或空洞。

## MVP 边界

本版本已验证 ScreenCaptureKit 捕获整块外屏、Metal 60 FPS 实时 Warp、同屏回显和完整内容利用。当前仍未验证真实挡风玻璃光学、7680×936 目标硬件性能以及 Warp 后输入坐标反向映射。下一阶段应使用固定机位拍摄真实网格，以实测控制点替换当前模拟模型。

完整经验复盘与下一阶段检查清单见 [`docs/lessons-learned.md`](docs/lessons-learned.md)。
