---
name: netflix-android-remote
description: 维护和验收 X96 上 Netflix 手机版的独立遥控辅助包 netflix-remote-bridge，处理蓝框导航、预览列表滚动、进度条草稿与遥控长按；不用于 Netflix 登录、代理线路或 DRM/4K 改造。
---

# Netflix Android 遥控适配运维

维护 `cn.hahaxiong.netflixremote` 无障碍辅助包。Netflix 本体为 `com.netflix.mediaclient`；两者的数据、版本、签名和权限分开核验。

## 入口

- 源码真源：`~/home-lan/4-Assets/Code/netflix-remote-bridge/`，先读该目录 `README.md`、`DEPLOYED.md` 的最新部署段；文件开头可能保留旧版本历史。
- 设备／ADB 入口先查共享记忆和设备台账，不沿用历史 IP、serial、`eventN` 或 UID。
- 涉及列表、手势或 seek 的排障，读 [references/diagnosis-and-acceptance.md](references/diagnosis-and-acceptance.md)；具体版本、证据和签名指针见 [references/project-map.md](references/project-map.md)。

## 会改变结论的六条经验

1. **先证明测试输入经过被测入口。** 本机固件的 `adb input keyevent` 绕过无障碍键过滤，不能证明遥控适配成功。用当前识别出的真实遥控事件通道，配服务键日志闭合；重复按键也要走原生 `EV_KEY=2`。
2. **生产树与检查工具的树不同。** UIAutomator 会暂时抑制／重绑服务，树结构也可能与服务读到的不同。导航期间优先服务自带 dump；不可见 wrapper 不代表孩子不可见，`visible=true` 也不能证明节点没有被底栏盖住。
3. **请求被接受不等于手势执行。** 比较 accepted、completed/cancelled、实际内容变化。非触摸 Android 11 的 `Configuration.touchscreen` 可能挡住无障碍手势，而 shell 注入仍可用；不得用 shell 成功反推无障碍通道正常。
4. **按原生能力识别进度条。** 真实 `seekbar` 可以不可点击但具有 `RangeInfo` 与 `ACTION_SET_PROGRESS`。核实单位，排除亮度条；左右只改本地草稿，OK 松键后提交，取消与隐藏控件按实际分支验收。
5. **长按时长不依赖厂商事件的 downTime。** 此固件重复事件样本的 downTime 不能稳定表示整次按住时长。独立记录首次消费 DOWN 至 UP，重复事件保留起点；新输入代次、松键、清场和失联淘汰分别验证，防旧动作迟到。
6. **同签名与当前运行态分别验。** 沿用已部署签名，安装后独立读取设备 APK SHA；再用真实遥控、服务树和 MediaSession 验主路径。自动检查、主机 shell 成功或旧版本验收都不能代替新部署的运行结果。

## 修改与交付

按用户当前问题限制修改范围；在独立工作副本改动，复用已有真实节点 fixture 和构建测试。保持播放器、选择菜单、Feed、编辑框／输入法的场景优先级；不在未知页面猜坐标。

所有延迟点击、滑动和 seek 提交均需复核当前窗口、场景、输入代次和目标；新键／BACK／离开场景废弃旧意图及旧回调。候选筛选与执行前回读使用同一内容所有权和遮挡裁切，不能因候选坐标已裁切就省掉第二次检查。

非触摸设备的本机 `su input swipe` 是当前设备已批准的 **Feed 专用**回退，不是通用执行接口或新设备授权。核实际 App UID 的可用性，保留整数视口坐标、期限、私有令牌与应用存活检查；不要扩成任意命令或通过修改系统触摸 feature 解决。已开始注入的手势不承诺瞬时撤回。

交付记录：改动范围、实际安装版本与 SHA、按用户原问题验证的行为、未测分支、同签名回滚包。记录实际可见影片数与真实播放位置；不要把布局指纹数当影片数，不承诺 Netflix 原生 seek 逐秒落点。多人同时操作时先隔离可归因样本，不能把混合输入时段当通过证据。

停用优先关闭辅助包开关或禁用该包，不清 Netflix 数据。若任务要求卸载，先按当前包与 UID 撤销其既有 Magisk 策略，再移除本无障碍组件，保留其他组件；避免 UID 复用继承授权。
