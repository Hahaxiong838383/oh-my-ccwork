---
name: huawei-ailife-tv-control
description: 分析三星手机上的华为智慧生活电视开机、设备控制和插件链路，结合远程Mac USB ADB与REA证据继续真机验证；不用于Netflix遥控适配或电视代理维护。
---

# 华为智慧生活电视控制

先读[本机分析与交接](../../../2-Projects/vps-proxy/smartlife-tv/ANALYSIS-20261030.md)，保留其中已验与未验边界。设备身份从共享user_hardware记忆重新核验。

## 续接

- 手机连公司Mac Studio的USB，不能把它当成家里Ubuntu。经SSH执行Mac的ADB，先devices再指定唯一目标执行getprop；多设备时不猜序列号。
- 当前目标为华为com.huawei.smarthome，“智慧生活”17.0.3.320；不要与涂鸦“智能生活”混淆。APK更新后重新比SHA并使旧证据验收过期。
- 用户本轮只要求归档，待后续配合。继续时先确认手机解锁及电视设备页；Starting、device状态不证明前台页面已打开。
- 从真实设备型号、页面组件与插件定位开机方法；通用DeviceOttActivity的switch=1只是候选，不可拿来猜具体设备命令。
- 获得明确开机测试指令后再发控制；真实电视/面板状态是成功判据。保留“不要影响当前播放”约束，区分电视与Android电视盒。

## REA与证据

遵循已安装的reverse-engineer-anything技能。Android工具可用时直接分析；provider缺配置时读诊断，优先已有CLI/JDK/JADX的进程级环境，不重复安装或重注册MCP。

本机已验工具、方法名、Evidence ID和恢复命令见交接；原始APK/完整证据/JAR在smartlife-tv/.local/，已被Git忽略。仅重用SHA匹配样本，不把/tmp和/dev/shm当持久存储。

- 完整JSON先写文件，只读摘要、选定方法和精确manifest节点；大类清单与dumpsys先过滤，不用截断文本做完整性结论。
- 静态推断、受控执行和用户报告分别记录。主APK存在动态插件机制，不等于已取得该电视插件。
- DeviceControlManager会校验设备并分派AiLifeProxy/HiLink；DeviceOttActivity先更新开关UI再发请求，UI成功不能替代设备实测。
- 所查三个内部组件exported=false，不是可直接adb启动的公共控制入口；不能扩大为“整个应用不可自动化”。
- 公司手机不默认具备家庭LAN/蓝牙可达性；先核真实传输路径与待机能力。不要把Wi-Fi、蓝牙和云端候选写成已验证事实。

## 样本与传输

ADB只取目标APK，账号数据库/令牌不进入Git或共享记忆。下载插件/读取私有目录受现有权限约束，不自动root或改包。

跨站大包按cross-site-file-transfer规则：可续传、单写入者、源目标字节数与全SHA核对；短连接成功不证明大载荷稳定。根盘容量紧张时先选有足够空间的分析位置，最终报告与必要证据持久保存。
