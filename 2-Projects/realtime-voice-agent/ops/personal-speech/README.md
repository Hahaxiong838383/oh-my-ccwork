# 飞牛本地中文语音试点

独立容器，只接在飞牛 Docker 私网 `personal-voice-private`。个人语音 worker 在 `AGENT_NAME=personal-xiaoke` 且设置了 `PERSONAL_LOCAL_SPEECH_URL` 时，才把识别和合成转到这里。P003 不读这个变量，默认火山/讯飞行为不变。

这是 `personal-local-pilot`，音色是 Piper `zh_CN-huayan-medium`（单说话人，22.05 kHz，服务里重采样到 24 kHz）。不是原小可音色。来源和许可见 [SOURCES.md](SOURCES.md)。

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 试点标识、模型名、原生采样率 |
| POST | `/v1/tts` | JSON `{"text":"..."}`，返回 24 kHz s16le PCM |
| GET | `/v1/asr` | WebSocket。二进制帧为 16 kHz s16le；文本 `{"event":"end"}` 后返回 final |

容器仅在 `personal-voice-private` 内提供 8091 端口。验收从该私网使用 `selftest.py http://personal-local-speech:8091 <reference.wav>`。不挂出网网络。内存上限 1.5 GiB，2 个 CPU。不落盘录音。

## 主 agent 需要做的事

重新构建并发布个人语音 worker 二进制，使本次 `stt_volc.rs` 和 `tts.rs` 的接点生效。不要操作时把下面的变量写进 P003，也不要写进文字中继共用的 `livekit.env` / `brain.env`。文字中继同样使用 `AGENT_NAME=personal-xiaoke`，这个 URL 只能出现在语音 worker 自己的环境里。

```
PERSONAL_LOCAL_SPEECH_URL=http://personal-local-speech:8091
```

不需要改 `TTS_PROVIDER`。未设置该 URL，或进程不是 `personal-xiaoke` 时，这段代码不生效。

## 回滚

在飞牛停止并删除 `personal-local-speech` 容器，去掉 worker 上的 `PERSONAL_LOCAL_SPEECH_URL`，再发布不含该接点的 worker。模型目录可留在 `/vol1/1000/docker/personal-local-speech/models`。不要删除其他项目的容器。

飞牛最终镜像为 `personal-local-speech:20261125.4`。同一连接静默 32 秒后，公开人声样本正确转写为「价格太高的原因」；合成「今天天气怎么样」用时 105 ms，得到 1.482 秒非静音音频，回送识别逐字一致。浏览器业务路径与并发验收详见[部署回执](../../docs/个人版部署验收.md)。
