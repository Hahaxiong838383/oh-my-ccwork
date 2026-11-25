# 飞牛 2 个人语音 Worker

飞牛运行独立的 Rust 容器。它用自己的 LiveKit 配置向北京注册为 `personal-xiaoke`，通过 Docker 私网访问个人大脑。每个房间都验证北京派单的主人和设备。配置允许两路同时接单。飞牛管理台从只读的 `cache/state/worker.json` 获取最近一次注册心跳、进行中的任务数和配置容量。样本过期时页面会提示。

## 构建与发布

1. 在 `rust-worker/` 运行 `cargo build --release --locked`。用 `sha256sum target/release/voice-rust-worker` 核对实际构建。
2. 在本目录设置 `VOICE_EDGE_CA` 指向北京试点的公开 CA 证书，运行 `./build.sh`。可用 `VOICE_WORKER_BINARY` 指定已经核验的二进制。镜像只打包 VAD、EOT、程序和公开证书。首次构建会下载 CPython 3.12 / Linux amd64 的依赖。EOT 使用 `livekit-local-inference` 的原生模型，构建后会实际初始化模型。
3. 将镜像送到飞牛。在 `/vol1/1000/docker/personal-voice-runtime` 将本目录的 `compose.yaml` 安装为 `compose.worker.yaml`，创建归属运行 UID 1000 的 `cache/state/`。运行用的 `private/livekit.env` 和 `private/brain.env` 留在飞牛。`worker.release.env` 只写 `WORKER_BUILD=<二进制 SHA256 前 12 位>`。
4. 检查个人池没有活动房间，再运行 `docker compose --env-file worker.release.env -f compose.worker.yaml up -d --no-build`。回读运行容器的镜像 ID 和 `/usr/local/bin/voice-rust-worker` SHA256。确认注册、判停侧车启动、浏览器发起一次完整通话。回退时使用上一版的发布文件与镜像，并重新验收。

`WORKER_MAX_JOBS=2` 为初始接单上限。试点默认关闭声纹。本实例的云端语音设置需要单独授权。语音供应商、实测路径、实机指纹均以[本次部署回执](../../docs/个人版部署验收.md)为准。
