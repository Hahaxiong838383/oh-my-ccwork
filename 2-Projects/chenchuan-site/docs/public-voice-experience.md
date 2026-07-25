# AI 战略镜像公开语音体验

## 产品入口

- 首页首屏「陈川的战略镜像」卡片可直接打开语音弹窗，不跳页。
- `/ai-os/chat` 默认实时语音，可切换为原有 3 轮文字问答。
- `/admin/voice-experience` 可生成追加 2 分钟体验码、撤销码、按访客体验编号重置当天基础额度。

访客会被明确告知这是 AI 而非陈川本人。公开会话不启用长期记忆、声纹、提醒、音乐和设备控制，本站不保存录音与对话转写。

## 架构

```text
浏览器
  ├─ 控制面 -> 个人站 /api/chat/voice/* -> MyJavis_ccsite /public-voice/*
  └─ 媒体面 -> 火山 RTC（浏览器与 RTC 直连）
```

个人站只把服务端可信人设发给独立的 `MyJavis_ccsite` 服务。它复用 MyJavis 技术栈，但使用独立分支、部署目录、PM2 进程和环境变量，不合并或替换 MyJavis 主服务。共享密钥和签名密钥均为 server-only，RTC SDK 仅在访客点击后动态加载，不增加首页首包。

## 配额与体验码

- 基础额度：每浏览器每天 1 次，每 IP 每天 2 次。
- 单次时长：120 秒；MyJavis 和浏览器双计时回收。
- 追加体验码：默认一次、7 天有效；数据库只存 SHA-256 哈希，明文只在后台生成后显示一次。
- 后台重置：访客提供页面显示的 `V-XXXXXXXXXX` 体验编号即可，不需要提供 IP 或对话内容。

SQLite 只保存匿名访客标识、配额、体验码元数据和房间生命周期，不保存录音或转写。

## 生产环境变量

个人站生产 `.env.local`：

```bash
PUBLIC_VOICE_ENABLED=0
PUBLIC_VOICE_MAX_SECONDS=120
MYJAVIS_PUBLIC_VOICE_BASE_URL=https://javis.chenchuan.cc/ccsite
MYJAVIS_PUBLIC_VOICE_SHARED_SECRET=
VOICE_SESSION_SIGNING_SECRET=
```

MyJavis 使用同一份共享密钥。两个 secret 必须放权限 `600` 的生产环境文件，不进入 Git、日志、文档或浏览器。

## 发布顺序

1. 备份 `MyJavis_ccsite` 独立目录、个人站当前目录和两边环境文件权限/哈希，不输出内容；不操作 MyJavis 主服务目录。
2. 先部署 `MyJavis_ccsite`，保持 `PUBLIC_VOICE_ENABLED=0`，验证 `/ccsite/health` 和错密钥 `401`。
3. 写入两边共享密钥，启用 `MyJavis_ccsite`，验证控制面 start/stop，并确认 MyJavis 主服务健康未变化。
4. 部署个人站，先保持站点 `PUBLIC_VOICE_ENABLED=0`，验证首页、文字问答、后台与静态资源。
5. 最后启用个人站开关，做一次真实 2 分钟语音、打断、手动结束和体验码验收。

## 回滚

最快回滚只需把个人站 `PUBLIC_VOICE_ENABLED=0` 并重启，语音按钮即停止创建会话，首页和文字问答继续工作。

完整回滚顺序：个人站关开关 -> `MyJavis_ccsite` 关开关 -> 恢复两个独立部署备份 -> 分别重启并验证健康。MyJavis 主服务始终不在回滚操作范围内。已开始的会话最多 120 秒后由独立服务硬超时回收。

## 验收清单

- 首页弹窗和 `/ai-os/chat` 桌面、手机布局正常。
- 未用额度可开始；同访客并发被拒；基础额度耗尽后要求体验码。
- 后台可生成、撤销体验码和重置访客；明文码不会在列表再次出现。
- 页面关闭、手动结束和倒计时归零都会调用 stop。
- MyJavis 私有 App 通话、邀请码、记忆、声纹、提醒和音乐能力无回归。
- 公开会话前后 memory/event log 条数不增加，服务日志无访客原话与回答正文。
