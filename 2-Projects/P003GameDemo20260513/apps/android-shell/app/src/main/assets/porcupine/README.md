# Porcupine 唤醒模型放置目录

**本目录用于存放 Picovoice Porcupine 所需的模型文件。**

## 必须放置的文件（文件名必须与代码完全一致）

1. `porcupine_params_zh.pv`
   - 中文参数模型
   - 从 Picovoice Console 下载 Android 中文模型包获得

2. `小可小可_zh_android_v3_0_0.ppn`   （**文件名必须精确匹配**）
   - 「小可小可」自定义唤醒词
   - 在 Picovoice Console 训练中文唤醒词「小可小可」后导出 Android 版本 .ppn

## 当前代码中的默认文件名（WakeWordBridge.kt）

```kotlin
private const val MODEL_FILE = "porcupine_params_zh.pv"
private const val KEYWORD_FILE = "小可小可_zh_android_v3_0_0.ppn"
```

如导出的文件名不同，请同步修改 `WakeWordBridge.kt` 中的常量。

## 获取步骤

1. 打开 https://console.picovoice.ai/
2. 创建/登录账号，获取 AccessKey（复制到 app/build.gradle.kts 的 PORCUPINE_ACCESS_KEY）
3. 下载 Porcupine 中文模型（porcupine_params_zh.pv）
4. 使用「Train Custom Wake Word」训练「小可小可」（建议录制 5-10 岁儿童真实语音样本提高识别率）
5. 导出 Android 平台 .ppn 文件，重命名为匹配 KEYWORD_FILE
6. 把两个文件复制到本目录（app/src/main/assets/porcupine/ 或直接 assets/ 根目录也可，保持与代码一致）

## 注意事项

- Porcupine 初始化时需要联网校验 AccessKey（首次或 key 变更时）
- 国内访问 Console 可能需要代理
- 如果文件缺失或 key 为空，WakeWordBridge 会捕获异常，isWakeWordAvailable() 返回 false，App 完全正常运行（优雅降级）
- 灵敏度在 WakeWordBridge.kt 中可调（SENSITIVITY），童声建议真机实测

放置完成后执行：
./gradlew assembleDebug
