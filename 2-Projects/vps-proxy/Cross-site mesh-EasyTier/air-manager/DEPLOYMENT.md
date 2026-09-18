# Air EasyTier Manager 部署与回滚

部署日期：2026-09-18（Asia/Shanghai）。V1 观察模式，仅手动重启。

## 安装清单

- 原管理器：`/Users/rayman.chen/xray/xray-manager.py`，仅增加扩展 hook，没有重写原逻辑。
- 原文件备份：`/Users/rayman.chen/xray/xray-manager.py.pre-easytier-20260918-141833`
- 接入后管理器 SHA256：`20844edee5f1972db7c0bf3810437b55462330cb88c8c22f67c7d046ecff5d11`
- 用户态模块：`/Users/rayman.chen/xray/easytier_manager.py`、`easytier_monitor.py`、`easytier-tab.html`
- LaunchAgent：`/Users/rayman.chen/Library/LaunchAgents/cn.easytier.air-monitor.plist`，以当前普通用户运行、登录自动启动。
- 私有状态目录：`/Users/rayman.chen/Library/Application Support/EasyTierManager/`（0700），状态文件与控制 socket 均 0600。
- 特权助手：`/Library/PrivilegedHelperTools/cn.easytier.manager-restart`（root:wheel 0755，clang 从本目录 C 源码编译）。
- 单条 sudoers：`/private/etc/sudoers.d/easytier-air-manager`（root:wheel 0440），只允许当前用户执行上述固定助手且不接受参数。
- 特权冷却锁：`/var/run/cn.easytier.manager-restart.lock`（root 0600）。

## 验收证据

1. macOS 系统管理员授权完成；sudoers 两次 `visudo -cf` 验证通过。
2. **35/35** Python 3.9 标准库测试通过，覆盖 Host/Origin/令牌、GET 不触发重启、JSON 确认与任意参数拒绝、过期不得绿灯、真实 SSH 标识、固定目标、并发重启互斥、冷却、PID 未变/探测失败不得宣布恢复、切网不自动重启。
3. 浏览器已实际打开新增 Tab，验证实时数据、检测按钮、取消确认；桌面截图目视布局通过。正常数据来自运行态，不含演示值。
4. 通过与按钮相同的 HTTP API 做了**一次真实重启**：14:20:10 受理，约 1ms 返回 HTTP 202；EasyTier PID `60535 → 62389`，14:20:18 确认恢复。并发点击返回 409，冷却期再次请求返回 409；带额外参数的 sudo 助手调用被拒绝。
5. 重启后独立真实 SSH 登录：Studio 0.34s、home-studio 0.26s、dev198 0.27s，均成功（与周期性 banner 探测区分）。
6. Xray 引擎 PID 始终为 `38014`，未重启引擎或更改其配置；原 `/api/status`、`/api/sysproxy` 正常。只重载了 `com.xray.manager` 网页进程。
7. 原管理器删除本次 hook 后与备份逐字节一致；模块源文件与运行文件校验一致。监控日志为空，无异常堆栈。

## 未声称完成

- 自动重启没有启用，也没有自动重启代码；侧栏是标记清楚的第二阶段预留策略。
- 未通过主动切断用户 Wi-Fi、合盖或重启系统做破坏性验收；实际切网/唤醒持久性待后续自然使用验证。
- 仅三个固定目标做 SSH 服务标识探测，其他节点只显示 EasyTier 路径；SSH 标识探测不等于已认证登录。
- 香港公网 SSH 主机密钥警告、旧 UDP 11010 connector 不在本次改动范围。

## 回滚（由 agent 执行，不要求用户手工操作）

1. 先读取当前管理器，检查无并发编辑。优先只删除 `integrate.py` 的 `HOOK` 字符串；若 SHA256 仍为上面的已部署值，也可恢复列出的原文件备份。不要覆盖部署后别人的改动。
2. `launchctl kickstart -k gui/$(id -u)/com.xray.manager`。**不要重启 `com.xray.proxy`**。
3. `launchctl bootout gui/$(id -u)/cn.easytier.air-monitor`，仅移除本次 LaunchAgent。保留状态目录和事件用于复盘，除非用户另行要求清理。
4. 经管理员授权移除本次特权助手和单条 sudoers；不要编辑其他 sudoers 或其他服务。
5. 确认 8888 原有界面正常、Xray 引擎未变、EasyTier 原服务仍在运行。

2026-09-18 用户明确授权本次由 codex 更新共享记忆并 commit + push。代码通过独立工作区收口至代码仓 main，不切换或混入当前 P003 工作分支；共享记忆单独提交到记忆仓。提交结果记录在共享事件与最终回执中。
