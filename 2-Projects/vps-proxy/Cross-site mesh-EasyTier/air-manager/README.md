# Air EasyTier 管理接入（2026-09-18）

仅 Air：为现有 localhost:8888 Xray Manager 增加 EasyTier Tab。第一阶段观察模式：**没有自动重启逻辑**。

- `easytier_monitor.py`：用户 LaunchAgent，30 秒采样，3 个固定目标 SSH 服务标识探测；仅获取 peer/route JSON，不读取 node info/config 或原始日志。关闭网页或管理器不影响采样。
- `easytier_manager.py`：管理器扩展、Unix socket 客户端、仅本机 Host/Origin 校验及随机会话令牌防 CSRF。
- `easytier-tab.html`：正式界面，全部来自后台真实状态，无演示数据。
- `restart-helper.c`：安装为 root:wheel 的固定动作程序，不接受参数；仅能重启 `system/cn.easytier.mesh`，成功后冷却 10 分钟。
- `integrate.py`：只插入扩展钩子，保留原管理器其他代码，备份并支持回滚。
- `test_integration.py`：标准库测试，不重启真实服务。

## 运行边界

监控是当前用户登录后运行的 LaunchAgent，不是系统启动前服务。状态和 socket 位于 `~/Library/Application Support/EasyTierManager/`（0700；socket/状态 0600）。不记录密码、网络密钥、SSH 私钥、原始 SSH banner 或 node config。固定目标为 Studio 10.10.10.12、家里开发机 10.10.10.23、dev198 10.10.10.13；探测不登录、不执行远端命令。SSH-2.0 标识响应只证明 SSH 服务有响应，不代表已认证登录。

重启需要先安装固定路径 helper 与单条 sudoers 授权。Web 服务仍为普通用户，不保存管理员密码，不允许自选命令/地址。实际安装和回滚清单见同目录 `DEPLOYMENT.md`（部署后填写，不含秘密）。

## 验收口径

进程运行、peer 可见、TCP 建连、SSH 服务标识分别判读。状态超过 90 秒过期显示未知，不保留绿灯。重启返回 accepted 只代表排队；新 PID 出现且三项服务探测通过才宣布恢复。未通过则展示恢复验证失败。单节点离线不会自动重启本机。

## 后续工作

见 [NEXT-STEPS.md](NEXT-STEPS.md)。自动恢复尚未实现或启用；先观察自然切网与唤醒。

## 2026-09-22 家庭双栈入口

新增 Lucky TCP 21110 → NAS2 EasyTier 11010、DDNS mesh4/mesh6、NAS 无特权 UPnP 租约核对脚本，以及现有 EasyTier Tab 内的拓扑/地址区。详情见 `LUCKY-BOOTSTRAP-DEPLOYMENT.md`（验收后记录）。不把 TCP 端口或 DNS 成功当作安全握手入网。
