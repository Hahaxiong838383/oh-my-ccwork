# Netflix Remote Bridge

为 Android 11 手机版 Netflix (`com.netflix.mediaclient`) 提供方向键/OK 导航。独立包 `cn.hahaxiong.netflixremote`，不改 Netflix APK 或数据；不联网、不读取账号密码。

只在 Netflix 为活动窗口、没有输入法且没有正在编辑的输入框时拦截方向键与确认键。HOME/音量及其他 APP 原样通过；返回键仅在正在预览进度时取消草稿，其余情况原样通过。蓝框标识真实可操作节点；OK 优先无障碍点击，失败才点节点可见区域中心。边缘尝试对应滚动动作。

播放器识别 Netflix 已观测到的 resource-id：左右调用后退/前进按钮；上下唤出控件并选择控件；隐藏控件时第一次 OK 唤出，随后 OK 点击蓝框选中的按钮。字幕菜单按普通双列节点导航，已选中且不可点击的 checkable 项仍可选。

0.1.1：可见 checkable 选择菜单优先于背后的播放器容器，禁用快进/后退特殊分支并移除背景播放控件候选。`NetflixRemoteBridge` 日志新增 `focus index/count/bounds/id/scene`，仅焦点状态变化时输出，不记录文本标签、账号或内容描述。

0.1.2：未知页面无可操作节点时把方向/确认交回 Netflix；只有滚动区域时仅在滚动成功后消费方向键。点击的手势兜底重新读取节点可见坐标，并确认活动窗口仍一致。

0.1.3：修正真机 `playPauseButtonTestTag` 非点击包裹层被误选的问题，播放器控件必须 clickable 或带 ACTION_CLICK；默认先选实际 pause/play 子按钮。仅在中心播放/快进后退控件选中或播放器控件隐藏时，左右直接快进/后退；选中底部菜单后左右走普通空间导航。新增真实 wrapper/pause 属性与菜单路由回归测试。

0.1.4：唤出播放控件先对已识别的播放器容器执行 ACTION_CLICK，只有失败才尝试手势；所有手势兜底等待消费中的方向/确认键松开后执行，并再次解析目标和活动窗口。日志明确记录 semantic 点击结果、gesture accepted/completed/cancelled，服务 dump 含 pendingKeyUp 状态。手势是否生效仍须真机验收，不能仅由 accepted=true 判定。

0.1.5：快进后的过渡树可能只剩返回键；此时不生成默认选择，保留此前选择身份，方向/OK 进入 `player_waiting` 等待完整控件，禁止误点返回。返回只允许在正常控件中明确移动选中后点击。延迟手势带输入代次：新按键取消旧点击；离开场景/中断清空按住状态，丢失 KEY_UP 的项 5 秒无重复后淘汰并取消旧意图。播放器控件已显示时不再次兜底点中心。

0.1.7：修复 My Netflix → Continue Watching 的可见播放卡片被不可见父容器整树跳过。可见性现在逐节点判断，仍按真实滚动视口裁切；仅 wrapper 不可见不再否定可见子节点。Netflix 9.84 的 `2131427788` 播放卡片具有独立于 `2131427786` 详情和 `2131427791` 更多按钮的点击动作，三个操作均保留；此例外同时检查父 ID 和两个子 ID，升级 Netflix 后应重新验证。选择菜单限定为 RadioButton 或同父垂直排列的多个 checkable 选项，单个 My List 开关不再误屏蔽 Play。

0.1.8（已部署，versionCode 13）：将真机 `seekbar` 的 `RangeInfo` 毫秒范围和 `ACTION_SET_PROGRESS` 纳入可选节点，明确排除亮度滑杆。播放控件显示时按下选择进度条，左右短按预览 ±10 秒；长按 0.7 秒后每次 ±30 秒、2 秒后每次 ±60 秒。辅助框显示实际目标时间；只有 OK 松开后才向 Netflix 提交原生进度动作。编辑中返回取消草稿，上下取消草稿并恢复控件导航。若播放控件已隐藏，首次 OK 只唤出并显示草稿，第二次 OK 才提交；隐藏时上下取消草稿后先唤出。保持原有中心播放/暂停与左右 10 秒按钮行为。 code13 的长按时长由服务记录首次消费 DOWN 到 KEY_UP，兼容本固件重复事件重置 downTime/repeatCount；松键、清场或 5 秒无重复过期后重置。诊断含 heldMs、stepMs 和 heldDurationMaxMs。

New & Hot 列表仅在已核实的英文页面结构成立时启用专用滚动。内容候选按真实标题栏与底栏遮挡边界裁切，方向键先浏览内容，越界时松键后按实时内容视口滑动；滚后焦点留在内容。两次已完成手势各经两次稳定回读仍无变化，才允许下一次方向进入标题栏或底栏；这表示本轮观察到边界，不承诺服务端没有更多数据。长按不会直接跳到底栏。诊断输出 signature、viewport、pending、unchanged 计数和指定影片标题节点 hash，便于主代理核对真实连续浏览。

真机 Android 11 配置为 `-touch`，无 `FEATURE_TOUCHSCREEN`；系统无障碍滑动立即取消，而相同坐标的系统 `input swipe` 已确认可滚动。code12 仅在已识别 Feed 的无障碍手势明确取消后，使用本辅助 UID 已获 Magisk 授权的本机兼容通道；先在实际应用进程中只读验证 uid0，再以绝对系统路径和整数坐标执行滑动，无需常驻 ADB。后台调用限时；新输入/场景变化撤销私有意图文件，迟到执行还须通过应用进程存活和短期时间门。取消/失败不计为到达边界；播放器、点击和其他页面不使用此通道。撤销该包 Magisk 授权即可禁用这项兜底。

所有延迟点击/跳转须重验按键代次、Netflix 前台窗口、场景代次及目标节点；换影片、离开播放器、字幕菜单或无效范围时取消旧草稿。诊断 dump 增加 class、RangeInfo、seekEditing/seekTargetMs；不获取系统媒体会话权限，媒体实际位置由主代理用 ADB 外部核验。

新增的生产 `CandidateTree` 与测试共享同一遍历路径；51 项检查包含真实 63 节点的 Continue Watching 树、两张播放卡片间的左右导航、详情/更多保留、屏外排除，以及真实 19 项字幕选项。数据位于 `test/fixtures/`，只含节点结构、ID、坐标和状态，不含文本、描述或账户。原有播放器过渡、按键代次与几何测试继续执行。0.1.8/code13 共 154 项断言通过，新增真实 54 节点播放器与三份 New & Hot/Top10 结构样本；构建通过仍不等于真机验收。

可通过服务自身只读 dump 查看节点，不启动 UIAutomator、不抑制无障碍服务：

```sh
adb -s SERIAL shell dumpsys activity service cn.hahaxiong.netflixremote/.BridgeService
```

输出服务选中快照与当前 Netflix 根节点树（最多 600 节点），包含 id、class、RangeInfo、bounds、可见/可点击/可选/选中/可编辑状态、数字 action IDs；New & Hot 影片标题节点仅另输出 identityHash 用于核对连续浏览，不输出标题文本；不输出任何 text/contentDescription/action label。添加 `--refresh-nodes` 可对每个节点调用只读 `refresh()`，便于比较服务缓存与最新节点；默认不强制刷新缓存。

## 构建

`./build.sh` 使用现有 Codeg Android SDK 34 / JDK 21，无 Gradle、第三方依赖或下载。产物 `out/netflix-remote-bridge.apk`。纯 Java 导航测试随构建执行。

`BRIDGE_SIGN_DIR` 指向签名目录，缺省为本地 `private-signing/`，权限 700/600，不入仓库、不随源码归档。已部署更新缺少签名时默认失败，必须恢复原密钥；只允许首次部署显式设置 `BRIDGE_CREATE_SIGNING=1` 生成新签名。密码随机生成，只经文件参数传递，不输出或写进命令行；后续 APK 更新须保留同一签名。构建脚本不会安装或操作设备。

持久构建示例：`BRIDGE_SIGN_DIR="$HOME/.local/share/netflix-remote-bridge/private-signing" ./build.sh`。源码归档排除 `private-signing/` 和 `out/`；主代理负责把现有签名备份入凭据库。

## 权限及启停

需要 Android 无障碍服务的读取窗口、过滤按键、执行手势能力；焦点框使用 `TYPE_ACCESSIBILITY_OVERLAY`，不需要 SYSTEM_ALERT_WINDOW。设置界面有适配开关和系统无障碍入口。启用组件：`cn.hahaxiong.netflixremote/.BridgeService`。

安装/授权由主代理执行并保留原服务列表，不可清空其他无障碍服务。用 ADB 增加组件时必须读取当前 `enabled_accessibility_services`，只追加本组件。

一键隔离（将 SERIAL 替换为已核实设备）：

```sh
adb -s SERIAL shell pm disable-user --user 0 cn.hahaxiong.netflixremote
```

彻底回退只移除本无障碍组件后：

```sh
adb -s SERIAL uninstall cn.hahaxiong.netflixremote
```

不卸载/清数据 `com.netflix.mediaclient`。本项目不提供静默自启或修改其他服务设置。

## 真机验收（必须由主代理完成，构建通过不等于可用）

1. Netflix 首页方向键逐个移动蓝框，OK 打开实际选中影片；海报行末继续按能滚动，屏外项不会获得焦点。
2. 字幕菜单上下移动语言、左右换列；已选语言可见；移到 Apply 点击后重新打开确认选项保存。
3. 播放器控件隐藏时 OK 只唤出控件，蓝框在播放/暂停时再 OK 暂停/播放；左右分别执行已有 10 秒按钮。下移选择进度条，左右只预览目标时间，核对实际播放位置未跳转；OK 松开后应接近目标位置。返回取消草稿且长按不退出，上下继续菜单导航；字幕仍可进入。
4. 返回键按 Netflix 原行为返回，HOME 正常离开；非 Netflix 首页/设置中的方向键正常；音量正常。
5. New & Hot/Top10 连续向下和反向浏览，用真实标题 identityHash 与可见页面核对内容变化；新按键、原生返回与页面切换须使旧滚动回调失效，不能抢焦点或误计边界。
6. Netflix 搜索输入框/输入法打开时方向键与输入均由系统处理。
7. APP 内关闭适配后立即消失焦点框、恢复原方向键；重新开启恢复。ADB 禁用本包后 Netflix 登录和播放保持。

已知边界：只处理 APP 实际暴露的无障碍节点；无语义的 Canvas/DRM 画面不生成虚构按钮。首次显示隐藏播放器只点已识别的播放器容器，不在未知页面乱点。真实设备事件/重复按键/Compose 层级仍需验收。


当前已验收部署为0.1.8/code13；列表连续浏览、进度条编辑/确认/取消及长按加速已通过真机验证。0.1.7的继续观看两张卡片、详情/更多与播放器/字幕真机回归通过。APK签名保存在本机 `~/.local/share/netflix-remote-bridge/private-signing` 与Vault条目「Netflix 遥控适配 APK 签名」，不入仓库。具体真机结果见同级 DEPLOYED.md。
