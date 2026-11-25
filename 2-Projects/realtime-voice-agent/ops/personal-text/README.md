# 小可个人语音文字通道

方案 C 的「仅用文字」使用原有设备签票和同一个北京 LiveKit 房间。文字轮复用个人大脑的 SSE 接口。网页默认关闭「允许小可记住这条消息」，本轮使用 `store:false`。文字对话上下文留在当前房间的进程内存。开启或关闭记忆时清空该客户端本房的短期文字上下文。

## 房间协议

- 网页发送可靠、定向的 `personal.v1.input` 数据包，包含 `recipient`、32 位十六进制请求 ID 和 `type`。`hello` 探测文字通道。只有回显 `ready` 的参与者才接受本页文字提交。`text` 带 `text` 和 `store`，`cancel` 沿用提交 ID。
- Rust 只为 `personal-xiaoke`、`pv-<32hex>` 和有效派单元数据装配文字通道。入站包按 LiveKit 的参与者身份、当前 SID、可靠类型及目标身份校验。文字按房间和请求 ID 去重，同一时间处理一轮，取消或设备离房会结束正在读取的 HTTP 流。
- 答复沿可靠、定向的 `personal.v1.output` 回送，`text_result` 携带正文和终止块中的 `tool`、`sources`。语音普通问答从同一 SSE 终止块取得元数据，收到 `[DONE]` 且本轮未被打断后，发送 `voice_result`。页内以语音轮次 ID 对应现有字幕，来源链接仅接受 HTTPS。
- 浏览器优先选派单的 Rust agent。飞牛文字参与者固定身份为 `personal-text-relay`。它使用北京现有的房间列表能力，检查房间 SID 后以只能发送房间数据的票入房，只接受同房的签票设备身份。设备端继续使用原票，管理接口和大脑入口留在原权限边界内。

## 过渡发布

容器 `personal-text-rtc-1` 通过独立 Compose 运行，入口为同一 Rust 二进制的 `--personal-text-relay` 模式。飞牛路径为 `/vol1/1000/docker/personal-voice-runtime/personal-text`，连接现有大脑内网，主动连接北京，使用现有私有 CA。没有宿主端口映射，无需改北京网关、签票或原 worker Compose。

从该目录使用 `TEXT_RUNTIME_IMAGE=public.ecr.aws/docker/library/ubuntu:24.04 docker compose up -d --no-build`。镜像实机 ID 为 `sha256:2b147973fd863c93ced60f325461fe0e262b91317b008e6a2d961f13e81af0e4`。同样传入 `TEXT_RUNTIME_IMAGE` 可通过 `docker compose stop rtc` 收回文字中继，或用 `voice-rust-worker.before-identity-check` 恢复过渡组件的前一版。

### 根任务换装回执

- 原始 Rust 构建提交 `2592754456024f356b09375190949dd25e6aab12` 是本分支祖先。开发前基线和当前提交中的 `rust-worker` 树均为 `a11963f947ba1987aff863bb4ac4c990a2fe4f7d`。原始二进制 SHA256 回读为 `0578ca2e4c5a0caa357a3dd62bddcc6a26464abf34b1a507092fe771f3c19e56`。
- 候选二进制为 `/data/home-studio/artifacts/personal-voice/worker-build/voice-rust-worker-personal-data-1f9f6cfd504609bdb66719ca262c1b5480ea139b05c58a8ee9436a39c81a1ae1`。飞牛文字容器使用相同实物，SHA256 为 `1f9f6cfd504609bdb66719ca262c1b5480ea139b05c58a8ee9436a39c81a1ae1`。Compose 实机 SHA256 为 `cafd357091ed848e8d22cf29326fbe301c012ccbdd29bc6f5a987df3f41552db`。构建来自基线 Rust 树叠加本工作树的个人通道源码，待根任务收录。
- Debian Bookworm 的大脑镜像缺少构建所需的 glibc 和 libstdc++ 版本，文字组件实机已改用 Ubuntu 24.04 运行镜像。
- 原 worker 的无麦克风启动有 60 秒上限。如果原二进制正好被派到文字房，可能会在到期时删除整个房间。候选版本会在可信设备仍在线时保留房间，无 ASR/TTS 配置时也维持文字服务。根任务应在个人池空房时替换唯一的 `personal-xiaoke`，回读运行中二进制，再按服务接入情况退役中继。语音输入到来源展示的真实验收仍依赖个人 ASR/TTS 凭据。

## 2026-11-25 实机验收

- 北京 `/talk/` 静态发布为 `/opt/personal-edge/clients/2e59ea8147b14be2`。实机 `index.html` SHA256 为 `bef9f24ed5d01a78bd95f243e608ec274adaa42b1a23af6c7cf23241c512eb69`，`voice.js` 为 `3e0f619200deaa4b0171c0455675a9f5bc67df736383e1d70a93b2f887af48d0`。现有私人 HTTPS 入口回读到相同脚本。
- 北京直连在 Chromium 独立信任库导入试点 CA 后验收。私人 HTTPS 入口走它现有的 HTTPS 与北京信令转发。两个入口各用一台临时设备，在零次麦克风请求的情况下通过 Enter 向真实大脑查 Python 3.14.0 发布公告，从可靠通道获得 `search` 和来源，点击后打开 Python 官网公告。重复提交 ID 仅产生一条答复。停止查询收到取消回执，同房随后收到时钟答复。
- 匿名及无效设备签票返回 401，指定房间的篡改请求体返回 400，合法设备票访问管理接口分别返回 401 和 403。两台临时设备已撤销。上述两个房间各有一条 `delivered` 和一条 `cancelled` 的查询任务回执，持久会话表均为零行。
- Rust release 构建和三个新增范围测试通过。全量运行通过 639 项，忽略 2 项，另外三个原有 onboarding HTTP/SQLite fixture 因当前工作树缺少 Node 的 `tsx` 依赖而启动失败。排除这三个 fixture 再跑，639 项通过。
