# X96 X10Pro 实际部署与验收

**当前部署：0.1.8/code13（2026-10-18 12:58验收）。当前SHA与完整验收见文末“预览滚动与进度条修复”；以下0.1.7段保留为历史。**

2026-10-18，手机版 Netflix 9.84.0 / 74548，Android 11，3840×2160。辅助APK独立安装，不改Netflix包或登录数据。

- 包名 `cn.hahaxiong.netflixremote`，版本0.1.7 / code8。
- APK SHA256 `ae75d9da56f3d408c495888912f490856a5c8a8310be1960015acb68d40c2a22`。
- 无网络权限；无障碍组件 `cn.hahaxiong.netflixremote/.BridgeService`，只在Netflix活动窗口拦截方向/确认，无输入法、无聚焦编辑框时工作。
- APK在本目录out中（gitignore），源码在src/res，构建读 `BRIDGE_SIGN_DIR=~/.local/share/netflix-remote-bridge/private-signing`。签名备份Vault条目「Netflix 遥控适配 APK 签名」（9ea15a2e-2230-415b-911f-b9cb886d008f），不可生成另一把替代已部署签名。

## 用户操作

方向键移动蓝框；OK点击。边缘自动滚动。返回/HOME/音量按系统原行为处理。

播放器隐藏时OK先唤出控件；蓝框在播放/暂停时OK切换播放状态。主播放区域左右调用Netflix的10秒快退/快进按钮；上下选择控件，移到底部菜单后左右在菜单按钮间移动，OK进入字幕等菜单。控件自动隐藏后先重新唤出再选择。

字幕菜单可左右切音轨/字幕列，上下选择语言，右移到Cancel/Apply后OK。默认中文字幕由Netflix profile保存，辅助层没有后台反复打开字幕菜单。

## 真机证据

- ADB `input keyevent`在此固件绕过Accessibility过滤，不作为桥接成功证据。测试用识别出的G20S PRO Keyboard对应 `/dev/input/event6` 的sendevent走内核输入；HOME用Consumer Control `event7`的KEY_HOMEPAGE。设备编号重启后可能变，重测先getevent重新确认。
- 主页上下导航和纵向滚动、海报行末向右横向滚动、OK打开实际选中卡片（Rites of Passage）通过。
- 0.1.5行为版验证隐藏→OK显示→OK暂停；快进紧跟OK仍在PlayerActivity；下方向键进入底部、左右移动、OK打开字幕、Apply关闭通过。0.1.6仅修改帮助文案/版本号，部署后又验证方向键进入字幕、Apply和恢复播放。
- BACK离开播放器，真实HOME到当贝桌面；非Netflix根不可用/无候选且没有拦截日志，系统按键放行。输入法mInputShown=true时桥接根不可用，方向键放行。
- APP开关实际关闭/开启，服务enabled=false/true回读通过。
- UIAutomator会暂时抑制无障碍并重新绑定，导致焦点重置；导航验收优先 `dumpsys activity service cn.hahaxiong.netflixremote/.BridgeService`，不要边按键边用uiautomator取树。服务dump仅输出ID/坐标/状态，不含文本/账号。
- 已修复非点击playPause包裹层、seek过渡只剩Back误选返回、菜单左右误seek、过期坐标兜底、松键竞态等。33项本机回归＋签名校验通过。

## 停用/回退

用户可打开「Netflix 遥控适配」关闭开关。ADB紧急隔离：`pm disable-user --user 0 cn.hahaxiong.netflixremote`。彻底卸载前仅从enabled_accessibility_services中移除本服务，保留其他服务，不清Netflix数据。

范围：基于当前Netflix真实暴露的控件，不保证未来APP版本、全部未知页面或受保护画面。未绕过DRM或伪造电视认证。

## 2026-10-18 11:51：继续观看补修

用户反馈 My Netflix 的 Continue Watching 无法选中，旧版本确实漏掉此分支。真实服务树63节点中，两张播放卡片被 invisible 的原生父wrapper包裹；旧递归提前剪掉子树，且会把有Info/More孩子的播放父卡片作为普通wrapper删除。

0.1.7按每个节点自身可见性遍历，仍保留屏幕/滚动视口裁切；只为本版已验证的7788+7786/7791结构保留独立播放父动作。实际候选11→17，两张播放卡片和四个辅助按钮均恢复。单个My List checkable不再判为字幕菜单；字幕双列仍识别。

真实G20S内核输入：从顶部资料栏Down进入第一张播放卡片，Right/Left切两张卡片，OK分别续播Battleship（position约839秒、state3）与Beauty in Black S1:E1 Make It Rain（约129秒、state3）。Down进入Info，OK打开详情；Right进入More，OK打开更多菜单后Back退出，未执行移除。蓝框截图与节点卡片边界一致。隐藏播放器OK显示，再OK暂停state2；Down/Right/OK打开字幕，左右/上下正常，默认English Original＋Chinese Simplified仍选中。

51项本地检查通过（原33＋真实树/选择菜单18）；安装后设备base.apk SHA与交付APK一致。已回到My Netflix并选中继续观看卡片。没有重测此前全部网络故障注入、冷启动或所有未知页面。证据见runtime/netflix-20261018/cw-quality/。


## 2026-10-18 12:58 CST：预览滚动与进度条修复（当前部署）

- 当前0.1.8/code13，APK SHA256 `d5df1c03a3dd7488b6ff039d8c2be57076ab686efdb295f31ce852779c459b56`；设备base.apk独立读取逐SHA一致。154项自动检查与独立静态审查通过。
- New & Hot真实树没有scroll action；底栏从y1908遮挡内容。专用上下导航按实际内容归属裁切，在内容末端松键后真实滑动，不会提前跳到底栏。
- 本机Configuration为television -touch，系统无障碍手势立即取消。只给本辅助UID10080配置Magisk允许（policy2，原policy1），仅已识别Feed失败后用本机受限input swipe；无需电脑常驻、没有改系统feature。新键/窗口取消尚未启动的意图，已开始的约420ms滑动不保证立即撤回。
- code12从Top10 TV入口连续浏览20个实际可见影片，到末尾两次无移动后才进入Search；UP回内容并反向上一片。ComingSoon连续3片及快速Down/Back通过。code13仅改变长按计时，安装后再次从Below浏览3片，Feed通过。
- 真实seekbar是非clickable的可调范围节点，已纳入导航并排除brightnessSlider。播放控件显示后从播放/暂停Down选择进度条，左右预览目标，OK松键提交；Back取消，Up/Down取消后换控件。控件隐藏时第一次OK仅显示、第二次才提交。
- code13暂停MediaSession位置304253ms在两个Right草稿期间不变；OK后实际跳转。长按档位heldMs883/2185对应30/60秒，松键后新短按heldMs0恢复10秒。长按Back取消仍留在播放器；隐藏草稿首次OK前后656036ms不变，第二次才跳转。Netflix原生跳转落点与目标存在数秒到十余秒偏差，本轮确认真实前后跳转，不承诺逐秒精确。
- Continue Watching两卡左右及OK续播、Up/Down取消草稿、字幕入口回归通过。Netflix登录、网络/High/字幕偏好未改。
- 证据：runtime/netflix-20261018/scroll-seek/；报告：mycc/2-Projects/vps-proxy/2026-10-18-Netflix预览滚动与进度条修复.md。回滚APK为证据目录rollback-0.1.7-code8.apk（原签名）。卸载辅助包前撤销其Magisk授权，避免UID复用继承策略；仅停用可关闭适配开关或disable-user，Netflix数据保留。
