# 小可个人语音客户端

手机和 Web 共用方案 C。设备持自己的凭据向同源的 `POST /api/voice/ticket` 申请短时房间票。聊天页只在当前页面内存保存设备凭据与字幕。关闭页面会释放麦克风。后台登录口令和设备凭据分别管理。

在本目录执行 `npm ci --workspaces=false && npm run build`，将 `dist/` 发布到签票服务的同源 HTTPS 入口。构建从锁文件安装 LiveKit 浏览器 SDK，页面运行时从同源加载 SDK。服务端必须为浏览器返回受信任的 WSS 地址，客户端和 worker 在同一房间后才能验证双向音频。

带浏览器的回归验收使用 `verify.cjs`。指定 `VOICE_TEST_URL`、合成问句 WAV 的绝对路径 `VOICE_TEST_WAV` 及对应识别关键词 `VOICE_TEST_EXPECT`，将测试设备凭据通过标准输入交给 Node。私有 CA 试点须先校验服务端证书并指定其公钥固定值 `VOICE_TEST_PIN`，公网受信证书可省略。可用 `PLAYWRIGHT_MODULE` 和 `CHROMIUM_PATH` 指定本机浏览器工具。脚本要求实际收到双边字幕并观察到播放时钟推进，只有进房不能通过。
