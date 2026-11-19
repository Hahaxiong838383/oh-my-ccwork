# 安装、备份和 macOS 权限（RC）

候选 App version 2.0.0 / build 78 / release channel rc.1，Bundle ID `com.mycc.nio-warp-demo`。安装使用交付的 **DMG**；备份 ZIP 解压得到的 `.app` 是软件归档，不是 DMG，也不携带该机器的最新现场参数或权限。客户芯片、macOS 版本与安装位置必须先对照交付 manifest；运行最低 macOS 14，候选包实际架构以清单为准。不要把 arm64 包当作已兼容 Intel 的通用包。

## 升级前由客户执行

1. 记录当前 V1 App 的版本/构建、安装位置和启动入口。结束播放后退出 V1，确认没有另一份 NIO Warp 正在运行。
2. 在客户自己选择的私有备份目录保存当刻几何设置、全部预设和来源/播放列表。优先用 App 可用的导出功能；另可在终端备份当前偏好域（文件含现场参数，留在客户本地）：

   ```sh
   mkdir -p "$HOME/Documents/NIO-Warp-backup-current"
   defaults export com.mycc.nio-warp-demo "$HOME/Documents/NIO-Warp-backup-current/preferences.plist"
   ```

3. 如果此前已进入 V2，还需保存 V2 来源/播放列表设置，详见 [回退边界](ROLLBACK.md)。不要用旧日期标定备份代替本次备份。
4. 核对交付 DMG 的 SHA-256 与清单一致，保留原 V1 软件包。将旧 `.app` 存入归档目录，避免同时保留多个可误启动的同 Bundle ID App。
5. 双击 DMG 打开安装卷。**已有安装须退出后替换原固定路径**，包括原先在 `~/Applications/NIOWarpApp.app` 的情况；不要另装到 `/Applications` 后混用两个副本。新电脑首次安装才将 App 拖到卷内 `Applications` 快捷方式，安装到 `/Applications/NIOWarpApp.app`。
6. 弹出 DMG，确认启动入口指向唯一已安装 App，再从该固定路径启动。不要从 DMG、Downloads、ZIP 临时解压目录或其它旧副本直接运行。先核对版本与该机器实际配置/预设，再配置 Connect。

## 签名和权限

本次构建环境没有有效代码签名身份，候选包为 **ad-hoc 签名、未经公证的受控测试包**。它不具备 Developer ID 正式分发证明。若 macOS 或公司 IT 阻止运行，按组织的受控测试审批/签名流程处理或等待 Developer ID 签名、公证版；不关闭系统整体安全保护，不提供批量删除隔离属性的方案。签名详情以 manifest 为准。

**权限由每台机器分别授权**；在另一台电脑已获授权或收到旧 App 备份，不会让新电脑自动获得权限。允许唯一固定安装位置的 NIO Warp 的“屏幕与系统音频录制”权限后退出并重开；原生鼠标/键盘控制可能还需要“辅助功能”。浏览器控制若出现 macOS 自动化请求，按本次操作允许控制 Chrome。安装路径、证书或构建身份变化可能要求重新授权，不能承诺升级免授权。先确认启动的是本次安装副本，再给需要的 App / 本次操作授权；普通 Bridge JSON-lines 输入不需要屏幕录制或辅助功能，USB/串口权限按实际硬件适配另验。

工作台若提示“请在系统设置→隐私与安全性→屏幕与系统音频录制中允许NIOWarpApp，然后退出并重新启动”，按提示允许本机 App，**完全退出后重新打开**，再核对捕获首帧与校正输出。外屏在线、软件版本相同和签名有效均不能代替该权限；尚未获得首帧时保持未验收。

本次 Air 实测：旧 v28 使用开发证书签名，备份 V1（77）使用 ad-hoc 签名；旧屏幕录制开关即使显示已开启（记录值为 1），当前 App 的捕获权限预检仍拒绝。此类签名切换后仍被拒绝的情况，先退出 NIO Warp，仅重置本 App 的屏幕录制授权记录：

```sh
tccutil reset ScreenCapture com.mycc.nio-warp-demo
```

这条命令只重置该 Bundle ID，不授予权限、不修改校正参数；不要执行全局权限重置。重置后客户必须在系统设置中**手动重新允许 NIOWarpApp，完全退出并重新打开**，再核对首帧与实际校正输出。不能自动 grant，也不能只凭旧开关显示已开启就跳过验证。本次 Air 经精确重置、用户重新允许并重开后，V1 实际显示已恢复并获用户确认；这不代表 V2 Connect 现场链路已验收。此重置是特定权限故障的处理步骤，不是每次安装的必做动作。

DMG 安装只替换软件，不恢复参数、预设或跨机权限。旧电脑的最新现场标定不在通用包中，新电脑需独立核对其显示器、几何设置和权限；无校正画面时按 [诊断说明](ROLLBACK.md) 分段检查并记录证据，不能仅凭包格式判定原因。

## 安装 SDK

SDK 目录可放在客户可写位置，和 App 分开。先确认 Node.js 22+，推荐 Node 24 LTS；已有满足版本的 Node 可复用。SDK 依赖仅局部安装：

```sh
cd /客户解压目录/connect-sdk
npm ci --ignore-scripts --omit=dev
cp config.example.json config.local.json
node src/cli.js --config config.local.json
```

将示例路径替换为客户实际目录；不需要 `sudo` 或全局 npm 包。安装要访问 npm registry；企业离线环境由 IT 提供对应架构 Node 和已核对的离线依赖包，不假定本包包含运行时。SDK 保留旧协议兼容依赖，已知审计问题见 `connect-sdk/DEPENDENCY-REVIEW.md`。

客户自行安装/打开 ProtoPie Connect 和 Chrome，在 Connect 自行登录并确认 Enterprise 权限；NIO Warp 与 SDK 不保存该密码，不自动上传原型。首次试用按照 [验收表](ACCEPTANCE.md)，出现错误先停止候选流程，再按 [回退说明](ROLLBACK.md) 恢复软件。

署名：codex（OpenAI）| 2026-10-10
