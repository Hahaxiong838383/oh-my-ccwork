# v0.13.9（61）：光标资源故障不再中断演示

## 根因与证据

v0.13.8诊断版捕捉到5次资源错误退出，另1次为用户正常Esc。异常退出时全部画面绑定、网格、来源1920×600、捕获元数据与窗口状态均匹配，故障均为 `cursorState=nativeResource`、资源不可用；按下与未按下状态均出现，并非长按计时保护或显示参数变化。

当时直接获取原CSS声明的1×光标图片，curl报35（Connection reset by peer），浏览器fetch也报Failed to fetch。程序的image-set解析固定优先1×，浏览器实际已经加载的是2×原图；每次Esc新建输入transport又清掉其缓存，因而重新依赖资源下载。资源失败被原有串行worker当作整个输入连接的致命错误，回调工作台并把指针带回内屏。图片读取期间还会把松键等输入排在后面。

同一现场启用Page域后，`Page.getResourceContent`可直接读取已加载的2×原图：Default为106×106（SHA256 `450061feb79c620ac746efd1792ff0e73ea017d9cbcb26de02a54068816b46ec`），Active为100×100（SHA256 `ca98ed6bb0b392f6d98f4947a930011902e2331aa23c6568e10a08be3c5ce9af`）。按CSS密度2解码仍为53/50点，热点26/25。没有重画圆圈或修改原图。

## 修复

- 优先读取当前页面已加载、且计算后CSS明确列出的原图候选，按该候选的density和hotspot解码；缓存缺失才走既有资源加载。
- 引入独立光标资源错误类型；解析、图片或资源失败只保留当前样式、记录提示并重试，不关闭坐标/键盘/按键连接。导航、断连、CDP超时和来源失配仍按原策略停止。
- 串行队列保留按输入顺序读取CSS的步骤；耗时取图移到队列外，松键和视口检查不再等待图片加载。
- 比较输入修订号，鼠标释放/移动后不安装迟到的pressed/hover样式。过时的图片失败不阻止新的状态刷新。
- 同一target、进程与文档timeOrigin可恢复已验证的可见松开态原光标；跨Esc不重放pressed或hidden，换页不复用旧文档。

## 验证与部署

固定入口 `/Users/futurus/Applications/NIOWarpApp.app` 已安装 **0.13.9（61）**；源码/包指纹、进程路径、严格签名及指定签名条件一致。校正数学、方向及现场参数未改。

- 输入/原光标51项461断言通过，覆盖2×缓存、精确URL与密度、资源故障非致命、图片阻塞时松键/视口继续、缓存miss与CDPtimeout区别、换页/重连后迟到结果隔离。
- 原因保留/作用域/退出/指针恢复/光标文档身份33项178断言通过。两组使用原生产代码和原测试体的assertion shim，非正式XCTest，不合计。
- 实机系统事件自动检查：按住8秒始终active、buttons=1、queueLength=0；松开恢复buttons=0和原Default，Esc回内屏后重入正常。normal/pressed均记录`cursorResourceOrigin=page-cache`、density=2，资源摘要与现场缓存一致。自动注入不代替本机鼠标手感验收。
- 安装完成、重启前偏好逐字节一致；之后公司/家中/其他屏幕配置、鼠标、ProtoPie和预设语义均一致。
- 用户本机鼠标复验：现场确认“都正常，没有自行退回”，长按、松开、Esc重入及原圆圈移动/点击通过。

边界：没有任何已加载或已验证原图的冷启动，仍取决于原图能否首次获得；不伪造替代圆圈。本轮未改变网络、安装代理、测试长期离线或重启Chrome清空缓存。外部连接被重置的网络侧来源未确定，本版修复的是资源故障错误终止输入及不必要重复下载。

## 回滚

代码标签 `nio-warp-before-cursor-resource-20260918` 指向v0.13.8提交 `5ec206cc`。安装前旧应用、变更源码、最新参数和部署标记配对备份：`/Users/futurus/mycc/2-Projects/nio-warp-demo/.rollback/app-installs/20260918-115659Z-before-v0139`。回写任何参数前先保留新的现场手调值。

人验后完整应用、native源码和参数快照：`/Users/futurus/mycc/2-Projects/nio-warp-demo/.rollback/accepted-baselines/20260918-115919Z-v0139`；摘要已记录。

署名：codex（OpenAI）| 2026-09-18
