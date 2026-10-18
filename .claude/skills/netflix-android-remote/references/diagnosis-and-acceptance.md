# 排障判据与独立验收

只加载本次问题对应小节。以下 ID、坐标与行为来自 2026-10-18 的 Netflix 9.84／X96 Android 11；更新 App、ROM 或遥控器后重新取样，不扩大为所有 Android 的保证。

## 输入与观察入口

1. 从当前设备能力读数确认遥控 Keyboard 与 Consumer Control 设备；历史上二者是不同 `eventN`，重启后编号可能变化。
2. 真遥控或正确事件节点的 `sendevent` 用于证明无障碍 `onKeyEvent` 路径。短按须包括 DOWN/UP；长按须包括真实 `EV_KEY` value 2，不能用反复独立短按代替。同步看服务消费日志和节点选择变化。
3. 在导航测试中读取服务自带快照：

```sh
adb -s "$TV_SERIAL" shell dumpsys activity service cn.hahaxiong.netflixremote/.BridgeService
```

`TV_SERIAL` 来自当前已核设备入口。需要比较缓存与新节点时再用服务支持的 `--refresh-nodes`。UIAutomator 适合补查文字／类别，不与生产键过滤验收混用；使用后重新确认服务已绑定、选择状态已稳定。

服务 dump 只保留结构、状态、范围值和诊断指纹。MediaSession 可独立证明实际 `state/position`；提取所需字段即可，不把账户、标题等完整原始内容写入共享记忆。

## 树、候选与 Feed

本机实际出现过三类反例：

| 观察 | 错误推断 | 应验证的对象 |
|---|---|---|
| UIAutomator 有 GridView／scrollable | 服务必有 ACTION_SCROLL | 服务生产树中的实际节点和 action IDs |
| 父 wrapper invisible | 整棵子树不可用 | 每个孩子自己的可见性与真实裁切区域 |
| 节点 visible=true、位于屏幕内 | 可选可点击 | 内容所有权、底栏覆盖和执行前实时 bounds |

当前 New & Hot 要联合匹配根 `2131427748`、标题 `2131427665` 的精确页面文字、横排分类、内容结构与底栏。当前标题／简介／预览 ID 见 `FeedPolicy.java`；不能仅拿通用根或单个数字 ID 开启手势。中途标题屏外时允许依据已核实的兄弟结构识别，但仍需至少一个可见内容节点与视口相交。

3840×2160 样本中分类栏底是 y=300，底栏全宽祖先顶是 y=1908；tab 子节点顶 y=1968 不是内容边界。坐标从实时 bounds 推导。Top10 的 Play/MyList 虽 visible=true，却全在 dock 后；先按路径／ID 确认内容归属，再裁切，不能按 y 大就把它们归为 dock。

验收：真实方向键沿内容逐个走，末端触发滑动，滚后仍选内容；反向返回上一片；回看短分类；快速连续方向键和方向后立即 BACK 不让旧任务抢焦点。到末尾需要两次已完成滑动后的稳定无位移回读，不能由一次取消或一次静止截图推断到底。

影片计数只用真正进入内容视口的可见标题身份；布局 signature 同时含坐标，只能证明变化，不能单独证明换片。标题屏外或 hash 无有效身份时不计数。

## 非触摸 Android 11 的手势门槛

若 accepted 后立即 cancelled，先区分通道：确认目标显示器／视口、是否有输入打断，然后读当前 touchscreen feature 与 `mGlobalConfiguration`。本机已出现无 `FEATURE_TOUCHSCREEN`、全局 `television -touch`；`DisplayInfo.touch=INTERNAL` 不代表通过配置门槛。

AOSP Android 11 对应链路：

- [DisplayContent 配置生成](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-11.0.0_r1/services/core/java/com/android/server/wm/DisplayContent.java#1945)：结合 feature 与输入设备生成 `Configuration.touchscreen`。
- [WindowManagerService.isTouchableDisplay](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-11.0.0_r1/services/core/java/com/android/server/wm/WindowManagerService.java#7714)：检查 `TOUCHSCREEN_FINGER`。
- [AccessibilityServiceConnection](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-11.0.0_r1/services/accessibility/java/com/android/server/accessibility/AccessibilityServiceConnection.java#374)：需要注入器与可触摸显示器，否则报告失败。

这是解释本机现象的官方机制，不是已反编译厂商 ROM 的声明。当前兼容实现只在已识别 Feed 的 cancel 回调后用本机受限 `su input swipe`。应由真实 App 进程完成 `id -u` 探针并执行，不能仅拿 ADB shell 的 root 成功证明 App 已获授权。

回退检查：新输入／窗口／场景清理取消尚未启动令牌；晚授权前检查期限、私有令牌与应用 PID；超时、旧任务 finally 和旧回调不覆盖新任务。成功判据仍是 Feed 内容变化；进程退出 0 只是中间证据。正在执行的约420ms注入不保证立即撤回。

## seek、repeat 与隐藏控件

先看服务的 `selected id/scene`：30／60秒加速只适用于选中 `seekbar`，或已有草稿但控件已隐藏的分支；中心播放区域左右调用 Netflix 原生10秒按钮，持续10秒可能是正常行为，不能直接归因长按计时。

确认进入进度条分支后，从生产树读取 `seekbar` 的 `RangeInfo(min,max,current)` 和 `ACTION_SET_PROGRESS`，再用 MediaSession 实际位置核对单位。本版为毫秒；不可点击不等于不可调。明确排除 `brightnessSlider`。

在暂停状态建立稳定基线，避免正常播放增长混淆结果：

| 输入 | 必须同时验证 |
|---|---|
| 左／右短按 | 草稿按10秒变化，MediaSession实际位置仍等于基线 |
| OK松键 | 草稿清除，实际位置发生对应方向跳转；分别记录请求目标与最终落点 |
| BACK，包括长按 | 草稿取消，实际位置不变；本次取消不误退播放器 |
| UP／DOWN | 取消草稿，再移动到预期控件 |
| 控件隐藏后首次OK | 仅唤出，草稿保留、实际位置不变 |
| 随后第二次OK | 才提交草稿；不能只看 overlay消失 |
| 原生repeat长按、松键再短按 | 达到30／60秒档位，松键后回10秒；可见／隐藏草稿两路均检查 |

本版 `SeekPolicy.stepMs` 阈值为700ms／2000ms。真机重复事件的事件时间不能稳定表示整次按住时长，因此使用 `KeyState.heldSince` 从首次消费 DOWN 计时，repeat 保留起点；UP、clear 和超过5秒失联淘汰必须清理。代次用于撤销旧动作，按住时长用于步进，二者不能互相代替。

Netflix 原生 seek 落点可比目标偏差数秒到十余秒。报告两值及实际方向，不用“请求成功”或“草稿目标变化”冒充播放器已精确跳到该秒。

## 同签名更新与独立运行态

沿用现有 `build.sh` 与签名指针；缺失已部署签名时恢复原密钥，不开启 `BRIDGE_CREATE_SIGNING=1` 另造密钥。构建产物和签名均不加入技能目录。

更新后独立读取设备安装路径对应 APK 的 SHA，与交付 APK 比较；另核证书指纹一致。保留同签名旧 APK 和停用路径，安装不清 Netflix 数据，不覆盖其他无障碍服务配置。

至少跑本次改动直接影响的主路径，再回归播放器／字幕／继续观看等相邻场景。重新安装后的样本单独记录；旧版本的20片验收不能直接算成新版本验过20片。检查进程本地独立运行，不依赖主机维持 shell、ADB转发或测试脚本；观察辅助 App 自己的 root探针／回退日志和实际 UI结果。
