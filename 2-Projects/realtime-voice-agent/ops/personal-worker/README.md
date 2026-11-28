# 飞牛 2 个人语音 Worker

飞牛运行独立的 Rust 容器。它用自己的 LiveKit 配置向北京注册为 `personal-xiaoke`，通过 Docker 私网访问个人大脑。每个房间都验证北京派单的主人和设备。配置允许两路同时接单。飞牛管理台从只读的 `cache/state/worker.json` 获取最近一次注册心跳、进行中的任务数和配置容量。样本过期时页面会提示。

## 构建与发布

1. 在 `rust-worker/` 运行 `cargo build --release --locked`。用 `sha256sum target/release/voice-rust-worker` 核对实际构建。
2. 在本目录设置 `VOICE_EDGE_CA` 指向北京试点的公开 CA 证书，运行 `./build.sh`。可用 `VOICE_WORKER_BINARY` 指定已经核验的二进制。镜像只打包 VAD、EOT、程序和公开证书。首次构建会下载 CPython 3.12 / Linux amd64 的依赖。EOT 使用 `livekit-local-inference` 的原生模型，构建后会实际初始化模型。
3. 将镜像送到飞牛。在 `/vol1/1000/docker/personal-voice-runtime` 将本目录的 `compose.yaml` 安装为 `compose.worker.yaml`，创建归属运行 UID 1000 的 `cache/state/`。运行用的 `private/livekit.env` 和 `private/brain.env` 留在飞牛。`worker.release.env` 只写 `WORKER_BUILD=<二进制 SHA256 前 12 位>`。
4. 检查个人池没有活动房间，再运行 `docker compose --env-file worker.release.env -f compose.worker.yaml up -d --no-build`。回读运行容器的镜像 ID 和 `/usr/local/bin/voice-rust-worker` SHA256。确认注册、判停侧车启动、浏览器发起一次完整通话。回退时使用上一版的发布文件与镜像，并重新验收。

`WORKER_MAX_JOBS=2` 为初始接单上限。试点默认关闭声纹。本实例的云端语音设置需要单独授权。语音供应商、实测路径、实机指纹均以[本次部署回执](../../docs/个人版部署验收.md)为准。

手机房间复用 P003 的流式切句。正文开头累积到 8 个字符后遇中文逗号即可先合成，后续仍按整句处理。讯飞使用逐句预建连接；超过 650 毫秒仍未完成握手时，在同一 10 秒预算内最多再试一条连接。达到 120 字的长回复播放期间，单独说「嗯」「嗯嗯」「嗯哼」可以继续听；完整的新问题仍可打断。误打断后恢复播放时用 250 毫秒淡入。当前参数见同目录的 Compose 文件。

个人房间读取只读挂载的 `PERSONAL_PROVIDERS_FILE=/run/personal-providers/providers.json`。Worker 只按房间快照切换 ASR/TTS。`active.asr` 或 `active.tts` 为 null 时分别走飞牛本地识别和本地五音色。语言模型请求始终使用 `http://personal-brain:8080/v1`，Worker 不读取、不改写、不发送大模型厂商密钥。无关的 LLM 条目不会让语音失效。P003 不读这个文件。

同目录的 `interaction.json` 保存后台已发布的整套词表。每个新私人房间读取一次。两类识别词合并去重后用于在线火山识别，打断词和退出词补充内置指令，附和词经过既有过滤。读完后写出 `cache/state/words-receipt.json`，记录版本、时间和是否在线识别。已在通话中的房间沿用创建时的设置。

私人 Worker 将每轮的阶段耗时写入 `cache/state/turn-timing.jsonl`，写入队列有上限，文件按大小轮转。仅记录房间标识、轮次、阶段、时间戳与毫秒数。后台按房间和轮次合并最近七天内至多四十条已提交的回复，缺少采样的阶段留空。判停和识别定稿从用户停说起算，其余时长从开始答复起算，首音指 Worker 发出音频。
