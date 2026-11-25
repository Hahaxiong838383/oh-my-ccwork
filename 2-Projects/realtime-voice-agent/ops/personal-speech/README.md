# 飞牛本地中文语音试点

独立容器，只接在飞牛 Docker 私网 `personal-voice-private`。个人语音 worker 在 `AGENT_NAME=personal-xiaoke` 且设置了 `PERSONAL_LOCAL_SPEECH_URL` 时，才把识别和合成转到这里。P003 不读这个变量，默认火山/讯飞行为不变。

这是 `personal-local-pilot`。默认音色仍是 Piper `zh_CN-huayan-medium`（华燕）。另外四路是各自的模型文件，速度固定 1.0：Melo、WNJ、超文、小雅。不是原小可音色。来源和许可见 [SOURCES.md](SOURCES.md)。

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 试点标识、当前音色、模型名、原生采样率。没有可用音色时 503 |
| GET | `/v1/voices` | `{"voices":[{"id","name","description"}],"active"}`。只列出已加载音色 |
| PUT | `/v1/voices/active` | `{"id","previous"}`。`previous` 必须是当前 active，否则 409 且不改。成功后写入 `/state/active.json`，重启仍生效。未加载的 id 返回 404 |
| POST | `/v1/voices/preview` | `{"id"}`，固定说「今天天气怎么样」，返回 `audio/wav` |
| POST | `/v1/tts` | JSON `{"text":"..."}`，不看 id，用 active。返回 24 kHz s16le PCM，响应头 `X-TTS-Voice` |
| GET | `/v1/asr` | WebSocket。二进制帧为 16 kHz s16le；文本 `{"event":"end"}` 后返回 final |

合成日志只记音色、字符数、采样率、字节数和耗时，不记文本。

容器仅在 `personal-voice-private` 内提供 8091 端口。验收从该私网使用 `selftest.py http://personal-local-speech:8091 <reference.wav>`。不挂出网网络。内存上限 1.5 GiB，2 个 CPU。不落盘录音。

## 通话接入与验证

个人 Worker 使用 `PERSONAL_LOCAL_SPEECH_URL=http://personal-local-speech:8091`。每次合成从响应读取 `X-TTS-Voice`，开场白也使用即时合成。该变量只放在个人语音 Worker 的环境。管理员通过私人后台试听和切换。测试服务 API 可在隔离实例执行 `voicecheck.py <内部地址>`，它会临时切换音色并使用版本检查恢复测试前的选择。

## 回滚

只回滚本服务时，把飞牛 `personal-local-speech/.env` 的 `SPEECH_BUILD` 改回 `20261125.4`，保留该镜像，再在该目录执行 `docker compose up -d --no-deps --force-recreate`。不要删除其他项目的容器，也不要改 worker。旧镜像忽略 `/state` 和 `/models/voices`，合成回到华燕。模型目录可留在 `/vol1/1000/docker/personal-local-speech/models`。

完全撤掉本地语音时，再停止并删除 `personal-local-speech` 容器，去掉 worker 上的 `PERSONAL_LOCAL_SPEECH_URL`，并发布不含该接点的 worker。

当前多音色镜像为 `personal-local-speech:20261125.5`。`20261125.4` 保留作回滚点。浏览器业务路径与并发验收详见[部署回执](../../docs/个人版部署验收.md)。
