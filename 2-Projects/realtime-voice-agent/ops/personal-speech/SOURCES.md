# 飞牛本地中文语音试点 · 模型来源

这是本地试点，不是原小可音色，也不是已授权的云 ASR/TTS。以后可以换成有授权的云服务；不设置 `PERSONAL_LOCAL_SPEECH_URL` 时，现有火山/讯飞路径保持原样。

## ASR

| 项 | 值 |
|---|---|
| 包名 | `sherpa-onnx-streaming-zipformer-multi-zh-hans-int8-2023-12-13` |
| 本机路径 | `/data/home-studio/models/myjavis/build-048-inputs/asr-model/sherpa-onnx-streaming-zipformer-multi-zh-hans-int8-2023-12-13` |
| 公开来源 | sherpa-onnx ASR 模型发布中的同名 int8 流式 Zipformer |
| 运行文件 | `encoder-epoch-20-avg-1-chunk-16-left-128.int8.onnx`、`decoder-epoch-20-avg-1-chunk-16-left-128.onnx`、`joiner-epoch-20-avg-1-chunk-16-left-128.int8.onnx`、`tokens.txt` |
| 许可 | 目录内没有 LICENSE 文件。sherpa-onnx 工程代码是 Apache-2.0。声学权重的数据授权没有随包声明，本试点不把它当成商用授权。 |

公开样音 `test_wavs/TEST_MEETING_T0000000351.wav` 只用于本机验收，是模型包自带的 16 kHz 单声道样音。

## TTS

运行音色是 Piper `zh_CN-huayan-medium`。本机没有现成中文神经音色。官方 `vits-icefall-zh-aishell3` 已下载并实测，原生采样率是 8000 Hz；问句「今天天气怎么样」合成后被同一套 ASR 听成「并艰天气」，所以不作为这次试点的出声音色。

| 项 | 运行中的 Piper huayan | 已测但不采用的 aishell3 |
|---|---|---|
| 包名 | `vits-piper-zh_CN-huayan-medium` | `vits-icefall-zh-aishell3` |
| 下载 | `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-huayan-medium.tar.bz2` | `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2` |
| 压缩包 SHA256 | `dbdfec42b91d9cee31cce9ff4b3e9c305eb6fbf60546d071f7e46273554cce6b` | `ab468db3a3308cdd861495e0db2f25d79418a0c00639f74944c7cdf5dd8c6ec1` |
| 采样率 | 22050 Hz，服务输出重采样到 24000 Hz | 8000 Hz |
| 许可 | 包内 `MODEL_CARD` 写 Dataset License: Unknown。来源仓库 `https://github.com/PlayVoice/HuaYan_TTS`。sherpa-onnx 代码是 Apache-2.0 | 压缩包没有 LICENSE。权重来自 AISHELL-3（OpenSLR 93），公开条款偏学术研究，商用需另行授权 |

huayan 按 sherpa-onnx 1.13.3 的 Piper 示例加载：`zh_CN-huayan-medium.onnx`、`tokens.txt`、`espeak-ng-data`，说话人 0。服务标识是 `personal-local-pilot` / `piper-zh-huayan-medium`。
