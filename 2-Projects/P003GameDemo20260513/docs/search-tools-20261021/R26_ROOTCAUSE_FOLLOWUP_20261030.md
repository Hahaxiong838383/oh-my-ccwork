# R26 入房与短句故障继续排查记录

时间：2026-10-30，北京时间。状态：**两项尚未完成根因闭环，未发布相关修复，不能收口。**

本记录补充 `R26_CONTINUED_INVESTIGATION_20261030.md`，保留上午全部失败。
本轮没有把离线验证、Grok 评审或取证工具测试写成真机修复通过。

## 1. 本轮推进与协作

- Codex 负责调查、代码和验证。按用户指定，经 Codeg `delegate_to_agent(agent_type=grok)` 委派只读调查，任务 `fe40822d-c8df-4232-99a4-6de9f7fb3efb`、会话 40，已完成。
- 可核实 Grok 身份为 xAI；接口未返回具体模型，Grok 也未能核实具体型号。没有声称某个特定型号参与评审。
- Grok 未修改代码、部署或设备。其结论由 Codex 复核；下文标明新增证据和限制，不能整段照抄为已查明事实。
- 当前缺口是设备侧连接阶段及同轮音频路径。Codex 本机和 Air 的现有 ADB 列表均为空；已询问实际测试 Mac 和上午原始证据目录，尚待答复。

## 2. 入房：缩小到信令连接完成之前

上午 18 个唯一签票对应 12 个实际 RTC 房间、6 个无房级日志的签票。不能拿 23 次场景尝试作相同分母，也不能直接将两类错误日志相加成唯一连接失败数。

补查 Nginx 原始行的时间、来源哈希、SDK 和设备参数，发现这 6 个签票各自在约 10 秒后有同来源 Android SDK 2.27.0、OkHttp 4.12.0、RK3562 / Android 15 / Wi-Fi 的 `/rtc/validate` HTTP 200：

| 签票北京时间 | 校验北京时间（日志秒级） | 相差毫秒 |
|---|---|---:|
| 09:37:12.758 | 09:37:23 | 10,242 |
| 09:39:23.898 | 09:39:34 | 10,102 |
| 09:50:55.236 | 09:51:05 | 9,764 |
| 09:53:01.777 | 09:53:12 | 10,223 |
| 09:53:56.990 | 09:54:07 | 10,010 |
| 10:06:46.455 | 10:06:56 | 9,545 |

**证据限制：**校验 URL 没有 room/token，不能将来源与时间相关性写成认证 token 的直接绑定；共享出口也可能存在其他设备。WebSocket access log 通常在连接结束时落盘，101 行的时间不能当成握手开始时间。

已核对 SDK exact tag 和本机缓存 AAR：`SignalClient.SIGNAL_CONNECT_TIMEOUT=10000`。官方实现连接失败后会用相同 Authorization 发 HTTP 校验，因此上述形态与信令建立 deadline 相符；**校验 200 不等于 WebSocket 建立成功，也不等于媒体或 input_ready 成功。**

出处：

- [LiveKit Android 2.27.0 SignalClient](https://raw.githubusercontent.com/livekit/client-sdk-android/v2.27.0/livekit-android-sdk/src/main/java/io/livekit/android/room/SignalClient.kt)
- [该版本 WebModule](https://raw.githubusercontent.com/livekit/client-sdk-android/v2.27.0/livekit-android-sdk/src/main/java/io/livekit/android/dagger/WebModule.kt)

同来源、相邻时段的完整 HTTP 检查没有补出失败 `/rtc` 状态，现存 Nginx error log 也未补出该时段错误。现有日志不足以在 DNS、TCP、TLS、WebSocket 请求/响应、首个 JoinResponse 之间定案。没有据此改超时、加自动重试、改端口或重启服务。

09:50 的主 Brain 短暂停机仍保留在时间线内：该次签票在健康恢复后成功，但不能由此证明整条入房链正常；更早和更晚失败也不能全部归因这次发布。

## 3. 短句：上行声音存在衰减和缺段，不能靠关键词修复

Codex 与 Grok 分别对已有三份 8 秒 Worker 环形快照核对能量、VAD、ASR final 和 commit。没有重录、替换失败样本，也没有再次外派原音频。

- 取消附近的大段 PCM 接近底噪，只有短暂能量突发，没有独立 VAD 起止；没有完整取消 ASR。
- 改查与退出的开头附近存在底噪、衰减及零碎能量，之后出现较明显尾段；独立无提示 ASR 没有恢复完整控制句。
- **不能把“能量低”直接写成某个字确定不存在。**缺 Mac 源音频的同轮精确播放时轴及设备发布前 PCM，快照时间按样本时长回推也存在接收/缓冲误差。
- 尤其改查段存在多次明显能量突发，不能笼统写成“整个前缀都是数字静音”。Grok 的近似时段描述只用于提示调查方向，不作为声学层最终归因。
- 三句均在首句 `ordered_pcm` 已结束后的 RTC 相位。Worker 常规路径先将 PCM 送 ASR，再处理 VAD；`user_final` 与 commit 字数一致。当前没有 Worker 根据搜索控制词裁短文本的证据。
- 空 `interrupt telemetry` 可由自然播完时清空文本后切换状态产生，不能当成 ASR 收到一次空取消指令。
- 现有 recovery 仅覆盖有 VAD、无主转写等条件；它未调度不能证明它造成缺字。拿相同残缺 PCM 再识别，也不能补回未进入其中的声音。

优先待验证的是采集、HAL/系统预处理、WebRTC APM 和 RTC 发布链。当前本地参考源码设置 `VOICE_COMMUNICATION`，软件 AEC/NS/AGC 开启、硬件 AEC/NS 标志关闭；**该源码尚未与现场活动 v367 APK 逐项对照，不能直接宣称这是现场配置或根因。**

Android 官方说明 AudioSource 会映射到设备特定的采集与预处理路径；关闭 SDK 某个硬件标志不能单独证明 HAL 不再处理。依据仅支持设计对照实验，不支持现在直接切换全量采集源。

- [Android 采集预处理配置](https://source.android.google.cn/docs/core/audio/implement-pre-processing?hl=en)
- [Android 音频采集与 UNPROCESSED 限制](https://developer.android.com/media/platform/mediarecorder)
- [Android 并发录音与静音规则](https://developer.android.google.cn/media/platform/sharing-audio-input?hl=en)

## 4. 已亲自编写的只读取证工具

文件：`tools/collect_search_device_evidence.py`，Python 标准库，无新增依赖。

先核对指定 ADB transport 的 MCU SN，再读取活动 `base.apk` 哈希和版本。采集 logcat、音频服务/AudioFlinger/AudioPolicy、Launcher 服务、连接和 DNS 状态；最后复核身份与活动 APK，期间发生 OTA/换机则判为不稳定，保留失败材料。

它不清日志、不改音量/开关、不安装、不唤醒、不连接新 ADB transport；输出新建目录 700、文件 600。原始日志可能含正文或凭据，只留私有目录，**不得将采集目录加入 Git 或直接转发**。终端仅输出采集状态与版本元数据。

在实际连接设备的 Mac 上执行；先用本机 ADB `devices -l` 读取当前 transport，不能把 MCU SN 填进 `--serial`：

```bash
python3 tools/collect_search_device_evidence.py \
  --adb "$HOME/Library/Android/sdk/platform-tools/adb" \
  --serial '<本次实际ADB transport>' \
  --expected-sn BJP00326060100100004 \
  --run-id '<与播放日志相同的run_id>' \
  --out '<已存在的私有父目录>/<新的本轮目录>' \
  --source-audio '<本轮固定话术WAV>'
```

同一 run 的开始与结束分别用新目录采一次；测试期间不清 logcat。采集命令串行执行，避免并行争用 ADB。

工具单测 4/4：错 MCU SN 提前停止、私有权限/活动 APK/只读行为、采集期间 OTA 判失败、已有失败目录不覆盖。**这是工具测试，不是两项产品故障通过。**

工具还不能产生 APK 中不存在的 DNS/TCP/TLS EventListener 或 APM 前后回调。若现有日志仍缺这些阶段，将在核实现场 APK 对应源代码后加最小诊断点；不会把另一棵树的未完成代码打包部署。

## 5. 接下来必须做的同轮验证

1. 取得测试 Mac 入口和上午私有原始目录；现场 `MCU SN + pm path + version + APK SHA` 与播放 run 对齐，原失败全部保留。
2. 入房单独复现，只唤醒、不继续播放查询。逐层记录签票、SDK 连接起止/异常链、DNS/TCP/TLS/信令/JoinResponse、RTC/Worker/input_ready；缺阶段明确缺失，不能从系统 VALIDATED 推出成功。
3. 同一固定短句比较安静输入与等待词/正文重叠输入；同轮关联源音频、设备 APM 前后、Worker 环形音频及 ASR。先比较声音包络，再看识别。若采集回调缺失，只能记待验。
4. 只在可复现机制得到证实后做最小修复。不得用降 VAD 门限、扩残句关键词、延长盲等或反复重试将失败变成通过。
5. 修复必须保住喇叭回声不会触发幽灵轮，并复跑原隔离、Linux 构建、真实接口、普通聊天正文声音性能门、空闲切换与回滚门禁。最终仍需 Mac 外放穿过实际麦克风链路复验。

## 6. 本轮运行与发布边界

12:58:47–48 只读复核：候选 Brain/Worker、主 Brain/Worker 均在线，候选 Worker 无活动 job；候选 Worker binary 仍为 `2832637822bf203f0e8e9597fd77e657384e6c3b7413da939750e35e0eacd071`，preview 仍为 `5dbc544ac7d5ce99a31e29d822047718feee5cabcc60aeb7b25af0c154f389ab`。

这两个产物包含此前天气最小修复，**不包含入房/短句故障修复**。本轮未部署、未重启、未切开关；未触碰倾听工作树或总闸，主后台四 tabs 文件哈希未变。

两台原 P2 设备及 2026-11-02 11:19 CST 截止保持，持久 timer active；没有扩名单或续窗。未来发布需在当前天气版本上重新建立 R1，不得回退到漏掉 style/ark 或天气补丁的旧产物。

署名：codex（OpenAI）| 2026-10-30
