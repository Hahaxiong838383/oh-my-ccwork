# Air 打开公司 Studio 远端工作区失败：诊断

2026-10-08 15:11—15:16 CST，用户报告 Air 一直提示“打开远端工作区失败”。本轮只读诊断已定位阻塞原因，尚未恢复生产；此前四档/CPA验收仍是历史成功样本，不能代表此时服务可用。

## 结论与证据

Air Codeg 0.34.0 保存的公司连接为 `http://10.10.10.12:3080`，Token 与既有批准凭据一致，自定义请求头为空。Air 的 EasyTier 路由走 utun4，SSH 正常；直接 HTTP 与既有 13080 隧道分别等满 8 秒超时。

公司 Studio 的 launchd job 仍为 running，Codeg worker PID 59099、UID 501、唯一监听 `*:3080`；实际 CPU 为 0%。在公司机器本地访问正确 Token 的 `/api/health`、错误 Token 的同接口，以及无凭据的静态 `/`，三路都在 3 秒超时。此结果将故障定位到服务端处理请求，不是仅 Air 的代理、地址或 Token。

15:13 的 1 秒实际进程采样显示一个 `tokio-runtime-worker` 全部样本停在 `list_directory_entries → std::fs::read_dir → __opendir2 → __open_nocancel`。其余 11 个运行线程在等待；日志和数据库线程没有对应阻塞。HTTP 客户端关闭后留下多个 CLOSE_WAIT，进程并未退出。

独立 macOS TCC 系统日志在 **15:07:49** 对实际 Codeg supervisor/worker 记录了 `AUTHREQ_PROMPTING`，服务名为 **kTCCServiceSystemPolicyDesktopFolder**，之后所读日志窗口无对应决定。此前 AllFiles 请求被 background-session 策略记录为拒绝。专有 TCC 只读查询显示没有已确认的 DesktopFolder 决定；全盘权限条目为拒绝。机器挂载清单无 SMB/NFS，未发现网络盘解释这次阻塞。

官方 v0.34.0 `commands/folders.rs:4498` 的 `list_directory_entries` 是 async 函数，却同步读取目录，并同步窥探每个子目录判断 `has_children`。因此即使用户只展开 `/Users/fu-121`，该代码也会访问其 Desktop 子目录，触发 macOS 权限确认。进程采样与独立 TCC 日志在真实生产进程上相互印证。该同步操作没有让出执行；本次观测中包括无锁健康和鉴权请求的服务处理一起停住。

Air 的中文提示是通用错误包装：native `open_remote_workspace` 在创建窗口前用保存的 Token 执行健康请求，超时限制 8 秒。`/api/health` handler 本身只返回固定 status/version、不读数据库，错误 Token 的中间件也不拿 ACP 锁。因此不能把这次全 HTTP 超时归为单个 Grok、CPA 或数据库查询问题。

## 恢复与长期修正

1. 在 Studio 的正式 macOS 权限流程中处理这份 Codeg executable 的 DesktopFolder 请求；根据需要允许具体文件夹，或拒绝其访问。确认/拒绝任一决定应能结束等待，但必须以真实 API 与同一路径复测为准。本轮 SSH 执行环境的 Accessibility 信任为 false，不能声称已自动点击弹窗或授权成功；未改 TCC 数据库、未放宽全盘权限。
2. 必要时通过既有 launchd job 受控恢复卡住的服务。这能恢复响应，尚不能防止再次展开用户目录触发同类授权。不要只把新 PID 或监听端口当恢复证据。
3. 服务端目录读取应放到专门的阻塞执行线程，避免同步文件系统/权限等待拖住 HTTP 处理；同时减少为 `has_children` 提前读取受保护子目录。若加请求超时，注意 timeout 不能终止已进入内核的同步调用，需要限制残留阻塞任务。
4. 现有 KeepAlive/官方 supervisor 只在进程退出时恢复，此次“进程活着、接口不响应”不会触发。若增强守护，应以连续多次本机真实健康载荷失败为判据，设置退避和重启上限，并记录原因，避免未知瞬时故障引起反复重启。

本轮诊断没有修改 Air 连接、Codeg/Grok/CPA/Xray 运行配置，没有重启生产或修改官方 binary。诊断已更新共享记忆；用户随后授权 Codex 本次直接提交公开源码与归档，提交进展见共享事件记录。归档提交不代表此故障已恢复。
