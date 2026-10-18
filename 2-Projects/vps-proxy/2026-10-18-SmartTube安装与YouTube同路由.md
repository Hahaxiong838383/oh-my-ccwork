# SmartTube 安装与 YouTube 同路由

> 归档状态注：本文保留各阶段原始时序、失败结果和待验边界；“当前”“待验”“未commit/push”等仅对应各记录时点。发布状态与最新进展见[本次复盘](2026-10-18-SmartTube与四级代理复盘.md)。历史回滚记录不得直接覆盖后续正式版本。

2026-10-18 15:44 CST，codex（OpenAI）。安装阶段记录：当时安装、遥控导航及代理接入完成，账号尚待用户手机授权、视频实播未通过；该“待授权/未实播”状态已被用户后续授权成功及正常播放的确认覆盖。

## 已部署

- 设备 X96 X10 Pro，Android 11，系统 ABI `armeabi-v7a,armeabi`。原 YouTube TV `com.google.android.youtube.tv` 7.28.300／UID10076 保留。
- 当前使用官方 SmartTube **32.68 Beta**，`org.smarttube.beta`，versionCode2458／UID10082。最初安装的 32.56 Stable／UID10081 已停止并 disabled-user，保留用于回退，避免桌面出现两个可用入口。
- Beta APK 官方资产、下载文件及设备已安装 base.apk 的 SHA256 均为 `a5cd4348126d53d7adf29517fc49ce17601f5cd6d7c05e9881c8b660c79d7e47`。
- 两版 APK v2 签名校验通过，证书 SHA256 均为 `109735aa24fe85e2e1623ebb3b1ecc4bf4263f4c6374e4411d646bfa2eda482a`。这证明安装产物一致及内部签名有效，未声称找到厂商独立公布的公钥指纹。
- 官方 README 存在历史构建环境感染公告；选择目前官方发布并核资产 digest，不使用第三方 APK。未查到这两个版本已知受影响证据，但扫描结果不是绝对安全证明。

## 15:44 安装阶段代理快照

按用户要求沿用原 YouTube 规则，未新建节点、未更改节点凭据。

1. `/data/adb/video-proxy/config.json` 的 `tun-in.include_uid` 加入最终 UID10082。
2. 原“除 YouTube 外的应用固定 ZGO”的倒置条件，由 `user_id=[10076], invert=true` 改为 `user_id=[10076,10082], invert=true`。只加 TUN UID 会导致 SmartTube 误走 Netflix 专线，必须同时更新这条规则。
3. Google 共用域名仍经 ZGO Reality；其余请求继承原 `auto`，当前实选 `hy2`（RackNerd）。媒体规则与 Netflix 专用 `zgo-video` selector 保持不变。
4. 配置 check 通过，沿用现有开机脚本重启 sing-box；最终生产 SHA256 为 `090fbf7e9e5d12f6b37410b52708d0ff380865af2e5a61bd5131e6a84713141b`。
5. IPv4 与 IPv6 的 UID10082 路由均独立回读为 tun0。真实连接 API 显示 beta UID10082 的 `www.youtube.com/i.ytimg.com` 经 `hy2,auto`，`www.google.com/yt3.googleusercontent.com` 经 `zgo-netflix`，与原 YouTube 规则对应。尚未拿到成功视频播放的媒体流验收。

以下仅为15:44安装阶段的原始回滚记录，已不适用于22:29四级代理迁移后的现网；不得用该配置直接覆盖当前正式配置。当前回滚应以最新实施报告及源码README为准。

原始生产配置备份：`/data/adb/video-proxy/backup-20261018-smarttube/config.json`，受保护目录及600权限。回退可停止 SmartTube、恢复此配置并运行原 `service.d/video-proxy.sh`；不需要清理或重装原 YouTube/Netflix。原 Netflix watcher 进程和遥控服务仍存活并已核绑定状态。

## 遥控与画质

- 按当前 `/proc/bus/input/devices` 识别 G20S PRO Keyboard，使用真实内核方向键／OK／返回路径验证侧栏、设置行及多级设置菜单；没有为 SmartTube 增加触屏桥接。
- 通过 UI 选择 `(4K)2160p 60fps vp9`，随后从实际持久文件 `files/app_prefs/video_player_data` 回读 `vp9,3840,2160,60.0`，证明设置保存。新版本不把此数据放在 `shared_prefs` XML；只看空 XML 会误判未保存。
- VP9 是预设偏好，有其他 codec fallback；不能宣称彻底禁用 AV1。此前盒子 AV1 驱动曾发生内核崩溃，后续实播仍须核实际 codec。
- 当前播放失败，因此尚未验证播放器快进快退、持续4K或实际VP9解码。

## 播放故障与版本选择

32.56 Stable 和 32.68 Beta，在同一代理配置、未登录状态、同一公开测试视频 `aqz-KE-bpKQ` 下，均未取得有效播放信息；MediaSession 为 state0、position0。首页可加载不等于视频能播。

- 日志 `Can't get video info` → `fromNullable result is null` → `Probably no internet connection`。源码证明最后一条是通用兜底文案，没有做连通性检测，不能据此归因网络。
- [32.68 官方发布](https://github.com/yuliskov/SmartTube/releases/tag/32.68)于2026-10-17标注 Playback error fixes。相对[32.56](https://github.com/yuliskov/SmartTube/releases/tag/32.56s)，它恢复 TV client 为首选，WEB_EMBED 后移；因此做版本对照有具体依据，但本机未登录对照仍失败。
- 未登录时 access token null 不能证明必须登录才解决；需授权后实测。
- 新版依赖 WebView 生成 PO token，盒子 WebView83 是线索；官方未给出已核最低版本。`Renderer process crash code -1` 也不能单独证明 WebView 是根因。没有升级系统WebView/GMS。
- [官方 issue #6193](https://github.com/yuliskov/SmartTube/issues/6193)有相似症状和同WebView版本，但仍属线索；不套用其用户猜测作为本机结论。

## 账号与下一步

SmartTube 没有受支持的官方 YouTube TV 登录态导入方式，备份导入仅覆盖 SmartTube 自己的设置／状态。没有读取或复制原 YouTube 账户 token。

已打开 Beta 的设置→帐号→登录设备码页面，并通过异步问题请用户在手机 Chrome 访问 `https://yt.be/activate`，选择与原 YouTube 一致的 Google 账号和频道并确认。设备码为临时授权信息，不写报告或记忆。尚未收到用户授权完成回执，仍未确认登录成功。

后续：收到授权完成后先独立确认账号／订阅可见，再重测同一视频；若仍失败，区分每个 Innertube client 的业务拒绝原因与 PO token 初始化问题。实际能播后才验证媒体链路、VP9分辨率、遥控暂停与快进快退。不要把已安装、已联网、已授权中的任一项当成实播成功。

临时 APK／工具位于 `/tmp/smarttube-install-20261018`；本机含凭据的临时配置副本、设备码截图／UI XML及诊断 ADB forward 已清理。清理前逐 SHA 确认电视端原配置备份与现网配置均完整保留。`api_check.py` 下次调用会从设备配置读取密钥到内存并重建临时转发，不依赖已删除副本。源码只读检查位于 `/tmp/smarttube-auth-review` 和 `/tmp/smarttube-media-auth-review`。本轮未 commit/push。


## 2026-10-18 15:49 CST 交接补充

只读截图确认仍是有效样式的设备码授权页；尚无用户完成授权回执，未导航离开。普通 YouTube 域名的 Beta 实际连接仍为 auto→hy2。

下一次用户完成授权后，在原应用、原网络、原测试视频复测；必须先开持续日志再触发播放。当前环形日志已被授权轮询的 JsonPathTypeAdapter 缺字段消息覆盖，事后 tail 不能代表播放阶段。优先采集 TvPoTokenProvider、TvPoTokenWebView4、WebPoTokenProvider、PoTokenWebView4、VideoInfoService 与 VideoLoaderController；仅落固定事件和时间，例如 PO_HTML_START/PO_JS_STARTED/PO_INIT_OK/PO_INIT_TIMEOUT/PO_TOKEN_READY/VIDEO_INFO_ALL_CLIENTS_FAILED。令牌、botguardResponse、visitor_data、授权头和媒体 URL 不落盘。

release 当前不会记录每个 client 的业务 status/reason；若授权后仍失败且 PO 时间线不足，最小诊断点为 VideoInfoService.firstInfoWith 的 client 返回处（只记录 client、HTTP数字码、允许的状态枚举和格式数量）。外部桌面请求使用另一套动态会话，不能替代盒子实际链路验收。


## 2026-10-18 18:40 CST 阶段更新（后续修复见本次复盘）

用户确认此前手机授权完成后已正常，旧“等待授权/未登录试播失败”不再是当前状态。本次断电后发生系统时间回到固件编译日期2024-02-28及DNS/校时循环故障；账号持久数据仍存在。已只读定位，未干扰当前直播、未执行修复。详见 [断电重启排障](2026-10-18-SmartTube断电重启DNS与时钟排障.md)。 [smarttube-user-authorized-then-coldboot-20261018]
