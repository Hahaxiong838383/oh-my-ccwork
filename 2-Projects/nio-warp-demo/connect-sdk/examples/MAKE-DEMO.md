# 最小 Receive 演示原型制作（RC，未实测）

本包交付制作步骤和输入样例；没有可用 Studio/Connect 授权环境，未生成真实 `.pie`。文档或 JSON 文件不能改后缀冒充原型。

1. 在已合法授权的 ProtoPie Studio 新建空白原型，画布可用 1280×720；创建明显可见的 `Indicator` 矩形（宽 400、高 120），位置固定，初始不透明度 20%。另建数值文本 `Counter`，初始显示 0。
2. 创建 number 变量 `Level`（0）、`Toggle`（0）、`Count`（0），以及 text 变量 `Action`（空字符串）。
3. 创建 Receive trigger，Message 填 `demo.level`，Channel 选 **ProtoPie Studio**（官方说明该通道也适用于 Connect），启用 Assign to Variable，选择 `Level`。在此触发器下设置 Indicator 的 Opacity response，使用公式 `20 + Level * 0.8`，单位为百分比，时长 0。输入 25 后期望 40%，输入 75 后期望 80%。此步骤是最小必需闭环。[官方 Receive / Channel / Assign to Variable 说明](https://www.protopie.io/learn/docs/interactions-triggers#receive)
4. 可选：Receive `demo.toggle` 赋值给 `Toggle`；条件 Toggle 等于 1 时改变 Indicator 填充色，等于 0 时恢复原色。
5. 可选：Receive `demo.action` 赋值给 `Action`；条件 Action 等于 `next` 时通过 Assign response 将 Count 更新为 `Count + 1`，等于 `reset` 时设 0；用 Text response / 变量公式让 Counter 显示 Count。按安装版本的响应界面操作并在 Studio 预览确认；未完成可只验收第 3 步。
6. 在 Studio 保存实际 `.pie`，通过 Connect 的 `+ New` 或拖入文件加载；打开它的浏览器按钮，复制完整 `/pie?pieid=...` 链接。[官方加载与浏览器播放步骤](https://www.protopie.io/learn/docs/connect-managing-testing-prototypes)
7. 先在 Connect 消息面板人工发送 `demo.level` 值 25，核对面板和浏览器变化；再启动 SDK，等待 connected 后把 `demo-input.jsonl` 的各行逐行粘贴，间隔至少 100ms。记录 Connect 版本、协议、原型文件 SHA-256、面板收到的值和浏览器效果。
8. 最后才把同一完整播放器链接填入 NIO Warp 的 Connect 来源，开始播放并核对捕获/输出。新增原型会产生新 pieid，替换原型通常沿用 pieid，变更后重新确认链接。[官方 pieid 行为](https://www.protopie.io/learn/docs/connect-managing-testing-prototypes)

此演示只改变原型图层；不要求数字键映射，不写 Warp 几何或镜像参数。连接 Bridge 但没有画面变化时，先检查 Receive 消息拼写、通道和变量类型，不用修改校正参数试错。完成后记录验收结果；本制作文档不构成已验收声明。

署名：codex（OpenAI）| 2026-10-10
