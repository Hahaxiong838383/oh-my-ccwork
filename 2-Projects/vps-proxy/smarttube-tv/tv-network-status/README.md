# 电视开机网络提示

独立轻量 APK + Magisk 异步 watcher。在当贝桌面右下角显示真实开机联网进度，
当前 boot 的 `boot-ready-boot-id` 匹配后显示“网络已连接”，完整展示 2 秒后退出。
离开桌面立即隐藏，不接收按键或触摸；不启动 Activity，不改代理事务、DNS 或播放器。

源码在本目录；构建和测试输出放 `/tmp/tv-network-status-build`。
APK 私钥仅以 `TV_NETWORK_STATUS_*` 专用项保存到 `~/.mycc-secrets.env`（600），不入仓。
首次构建可用 `CREATE_SIGNING=1 ./build.sh`，之后缺签名即拒绝，禁止意外替换已装签名。

运行入口：`/data/adb/service.d/98-tv-network-status.sh`，worker 在
`/data/adb/tv-network-status/watch.sh`。所有这些文件 root:root 700。
APK 包名 `cn.hahaxiong.tvnetstatus`，没有桌面图标，不依赖辅助功能服务。
只需 `SYSTEM_ALERT_WINDOW` app-op；状态服务要求 `android.permission.DUMP`，普通 APK 不能伪造状态。

状态语义：

- 仅解析当前 boot 的阶段日志；日志用于文案，**成功只认 ready 文件**。
- 源端检查前台为 user 0 的当贝 HOME。状态心跳失联 3 秒自动隐藏，避免覆盖播放器。
- 成功计时用 Android monotonic clock，重复心跳不延长 2 秒。
- 成功发生在其他应用前台时直接退出；返回桌面不补弹旧启动成功消息。
- 这是开机提示，不是持续联网监控；之后的故障恢复由原有 guardian 负责。

## 构建、部署和验收

```sh
bash build.sh
python3 deploy.py --serial <当次核对的ADB地址> \
  --apk /tmp/tv-network-status-build/tv-network-status.apk \
  --evidence /tmp/tv-network-status-build/deployment.json
```

`deploy.py` 安装前后核对前台、代理 PID/startticks、既有 manifest 文件和时钟入口；
新入口在 `PATH=/nonexistent` 下实跑。本 boot 已就绪时静默消费，不能为了展示组件伪造断网。
在前台切换事件可用的这台 Android 11 ROM 上，watcher 订阅真实 `wm_set_resumed_activity`，
每 15 秒做一次有界快照校验。离开桌面停止本服务，成功后停止 watcher 与日志订阅。

`test/device_watcher.py <ADB地址> <输出JSON>` 把同一 watcher 放到随机隔离目录，
输入和 `am` 调用全部替身化，在盒子真实 shell 回放等待、离开、返回、成功和同 boot 重入。
它不会伪造生产 ready 文件，也不会向真实 APK 发桌面状态。

服务的 `RENDER_PREVIEW` 与 `PRIVATE_DISPLAY_TEST` action 同样受 DUMP 保护。
前者只把真实 View 渲染到应用私有 PNG；后者仅在已断言非默认、私有的虚拟屏挂载
真正的 `TYPE_APPLICATION_OVERLAY`，验证 WindowManager 参数与成功显示时长。
测试不能退回物理屏，完成后释放显示、窗口、服务，不写生产 completed boot。

2026-10-30 已后台部署：APK SHA、脚本 SHA 与运行回读一致；Android 私有屏窗口右下角
`[980,628][1256,696]`（1280×720、边距 24dp），等待/成功中文渲染正常，成功计时 2000ms，
窗口移除日志约 2014ms。普通应用 UID 10065 的调用被 DUMP 拒绝。
直播前台与代理进程保持，帧持续增长，drop/error 为 0。验收见 `ACCEPTANCE-20261030.json`。
以上首次安装未重启。随后用户授权的软件重启已通过，见
`ACCEPTANCE-20261030-REBOOT.json`：本 boot 25.879s 自动显示等待，46.91s 网络 ready，
47.215s 显示成功，49.296s 移除（2081ms），服务退出后不再弹出。
盒子中途自动进入 DIYP 时浮窗隐藏；验收通过 HOME 返回桌面查看成功提示。
成功态与消失后实机截图已保存到本机 `~/图片/屏幕截图/`；本轮不是物理断电验收。

恢复 DIYP 应从当贝桌面图标正常打开，**不要直接启动内部 PlayerActivity**：
它依赖登录入口加载 ForceTV native 库，直接启动实测会出现 `UnsatisfiedLinkError`。
本轮一次错误直启后，已用桌面正常入口恢复 1080p 持续播放、drop/error 为 0。

回滚：先移除独立 service.d 入口；若 watcher 还在，按完整 argv 核对并停止其 PID，
再 `am stopservice --user 0 -n cn.hahaxiong.tvnetstatus/.StatusService`、
`pm uninstall --user 0 cn.hahaxiong.tvnetstatus`。仅清理本组件目录，不触碰原代理或当贝时钟修复。
