# 诊断、停止与软件回退

状态：RC。SDK 和 Connect 是独立进程，输入故障不应写入校正参数。

## 先判断故障在哪一段

| 现象 | 检查/处理 |
|---|---|
| App 来源测试失败 | 客户在Chrome打开完整播放器链接，检查Connect服务、原型和pieid；不拿服务首页代替播放器 |
| Bridge connect_error / exhausted | 检查实际服务origin、端口、显式协议、Enterprise权限；修正后人工重启，不盲切协议或补发旧动作 |
| Bridge connected，原型不变 | 先看Connect消息面板，再核对Receive名、通道、变量类型；submitted不是送达确认 |
| 输入被丢弃 | 查stdout结果和status计数，降低输入频率；状态在下一采样周期重发，历史动作不补发 |
| Chrome可播，Warp未显示 | 确认从唯一固定安装路径启动，检查本机屏幕录制权限、显示器、实际参数、首帧和输出/来源状态；单独记录，不当作消息链成功 |
| 日志文件不可写 | log_file_disabled后只输出stderr，修正日志目录权限或置null；不改全局安全设置 |

Bridge stderr 默认只有脱敏状态。配置 `logDirectory: "./logs"` 后保留最多三个1MiB文件；运行版本、会话ID、配置哈希、连接次数和提交/丢弃计数可用于定位。stdout `{"type":"status"}` 请求返回当前状态，但不包含消息值、URL或Warp参数。日志不自动收集其它进程、不自动上传；客户整理日志时记录App/Connect/Chrome/Bridge版本及测试时段，并检查私人字段。

## 停止输入或恢复 SDK

1. Ctrl+C 停止当前 Bridge，退出或停止客户输入适配程序；不终止 Connect、其它 Chrome 页面或系统进程。
2. 需要恢复旧输入实现时，用先前保存的 SDK 副本和对应 `package-lock.json`，只在该目录重新 `npm ci --ignore-scripts --omit=dev`。新的消息必须在匹配原型中重新验收。
3. Bridge 重启后重新读取当前硬件状态并按上限发送，历史 `next/reset` 不补发。

## 恢复 V1 软件，保留最新几何

1. 客户先备份当刻配置/预设，结束播放，退出V2并确认仅一个NIO Warp进程。
2. 把候选App移到归档，核对交付 V1.0.0（77）DMG 的来源/哈希，打开 DMG 后将 V1 App恢复到原来唯一固定安装路径（包括原先在 `~/Applications` 的情况），弹出镜像再启动，核对版本与本机权限。备份 ZIP 解压是软件归档，不是安装 DMG；需要正式回退安装时使用交付方从该归档验证制作的 DMG。
3. 默认只替换软件，不导入旧整份偏好、不恢复旧日期标定、不删除现有偏好域。V2来源/播放列表使用独立键，首次只读V1迁移，不写V1来源键：

   ```text
   nioWarpProtoPie.configuration.v2
   nioWarpProtoPie.draft.v2
   nioWarpProtoPie.lastSuccessful.v2
   nioWarpProtoPie.playbackLibrary.v2
   ```

4. V1继续读取原有V1来源与共享的最新几何/预设，因此来源回退不需整份prefs恢复。V2键保留供后续候选复验，不手工删除；若客户在V2另调几何，这些最新几何也由V1继续使用。
5. 核对旧来源、鼠标方向、AA和输出；软件回退不卸载/停止Connect或客户输入程序，是否停用输入由客户按业务需要决定。

升级前 `defaults export` 的整份偏好只作为客户私有恢复依据，包含现场标定。仅在确认特定配置损坏、客户明确选择恢复且逐项理解覆盖范围时再做专项恢复；普通V2→V1回退不执行整份 `defaults import`。客户现场当前设置不进入通用交付包。

以上参数保留描述针对同一机器的软件替换。另一台电脑安装 V1/V2 不会自动获得原机器最新的几何、预设或权限；跨机设置由客户私有备份并另行核对。本表用于分段排查，不构成本次无校正画面问题的根因结论。

署名：codex（OpenAI）| 2026-10-10
