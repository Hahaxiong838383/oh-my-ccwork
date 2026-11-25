# 小可个人语音客户端

手机和 Web 共用方案 C。设备持自己的凭据向同源的 `POST /api/voice/ticket` 申请短时房间票。聊天页只在当前页面内存保存设备凭据与字幕。关闭页面会释放麦克风。后台登录口令和设备凭据分别管理。

在本目录执行 `npm ci --workspaces=false && npm run build`，将 `dist/` 发布到签票服务的同源 HTTPS 入口。构建从锁文件安装 LiveKit 浏览器 SDK，页面运行时从同源加载 SDK。服务端必须为浏览器返回受信任的 WSS 地址，客户端和 worker 在同一房间后才能验证双向音频。
