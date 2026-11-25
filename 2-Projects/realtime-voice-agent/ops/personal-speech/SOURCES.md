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

默认音色仍是华燕。另外四路来自各自的 onnx，不是华燕改音高或语速；服务里合成速度固定为 1.0，输出都重采样到 24000 Hz。本轮用同一套 Zipformer，把「今天天气怎么样」逐字听回。五路都听回原句。

`vits-icefall-zh-aishell3` 仍不加载。上一轮它是 8000 Hz，同一问句被听成「并艰天气」。本轮没有再把它放进可用列表。

| id | 名称 | 包 | onnx SHA256 | 原生采样率 | 许可 |
|---|---|---|---|---|---|
| `piper-zh-huayan-medium` | 华燕 | `vits-piper-zh_CN-huayan-medium` | `04234ec24907e9efa7e153669e07d4e0cf6d260adc005323aa929386dae53f86` | 22050 | 包内 MODEL_CARD：Dataset License Unknown。来源 `https://github.com/PlayVoice/HuaYan_TTS` |
| `melo-zh-en` | Melo | `vits-melo-tts-zh_en` | `bf30582eb1b012250a35b1a4a80e7dfbcf8485e7bb9de0d95efbbeef0e4ad86d` | 44100 | 包内 LICENSE 是 MIT 文本，上游 `https://github.com/myshell-ai/MeloTTS`。单女声 |
| `fanchen-wnj` | WNJ | `vits-zh-hf-fanchen-wnj` | `ccd592a5f6fa3f7e8840405c3422ffed9eba58db253d4abd82c75280db98c644` | 16000 | sherpa 文档写明由 `https://huggingface.co/spaces/lkz99/tts_model` 的 `G_wnj_latest.pth` 转出，包内没有 LICENSE。公开说明是一名男声。不把这当成商用授权 |
| `piper-zh-chaowen` | 超文 | `vits-piper-zh_CN-chaowen-medium` | `1cb646ea826a6ee73e329ea06319fb8d459da8a35be6c1ba30210387deb3bc55` | 22050 | MODEL_CARD：数据集 `https://github.com/OHF-Voice/voice-datasets`，License CC0。卡片写由小雅 medium 微调 |
| `piper-zh-xiao-ya` | 小雅 | `vits-piper-zh_CN-xiao_ya-medium` | `c8882021fe2da5440870c4d18a45ffd8036ee3219660b0eef8a1f57cc3f0c166` | 22050 | MODEL_CARD：数据集 `https://huggingface.co/openspeech/BZNSYP`，非商用，见 `https://www.data-baker.com/data/index/TNtts/`。卡片写 Piper 1.4 依赖 g2pW；这里走 sherpa 词表，本轮测试句已听回 |

下载地址都是 `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/<包名>.tar.bz2`。sherpa-onnx 1.13.3 代码是 Apache-2.0。已测但不采用的 aishell3 压缩包 SHA256 仍是 `ab468db3a3308cdd861495e0db2f25d79418a0c00639f74944c7cdf5dd8c6ec1`。

华燕按 Piper 示例加载：`zh_CN-huayan-medium.onnx`、`tokens.txt`、`espeak-ng-data`，说话人 0。其余四路有 `lexicon.txt` 和规则 fst，说话人 0。当前 active 写在容器卷 `/state/active.json`。没有这份文件时用华燕。
