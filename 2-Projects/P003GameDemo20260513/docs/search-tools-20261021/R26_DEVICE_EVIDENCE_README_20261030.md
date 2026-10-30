# P003 连接与短句只读取证

用于S04原失败的继续定位。此工具不安装APK、不清日志、不改音量、不唤醒、不修改开关、不主动连接新ADB设备。**取证成功不是产品通过。**

在实际连接S04的测试Mac运行。先读ADB现有列表，选择正确transport；MCU SN必须独立核验，不能将SN当ADB serial。

```bash
"$HOME/Library/Android/sdk/platform-tools/adb" devices -l
python3 collect_search_device_evidence.py \
  --adb "$HOME/Library/Android/sdk/platform-tools/adb" \
  --serial '<上一步实际transport>' \
  --expected-sn BJP00326060100100004 \
  --run-id '<本次播放与独立录音同一个run_id>' \
  --out '<已存在私有父目录>/<新的before或after目录>' \
  --source-audio '<本次固定源音频文件>'
```

正式播放前、场景结束后分别新建before/after目录执行；保持原失败，禁止重复覆盖。仅唤醒连接失败时不再播放后续查询；最多一次另run的诊断复测。保持Mac与设备原音量、音色、语速和摆位，独立记录播放及录音时轴。详细原10场景沿用MacBook TTS联调指南。

工具先核MCU SN、活动APK SHA及版本；采集设备时钟/uptime、logcat、音频服务/AudioFlinger/AudioPolicy、Launcher服务、连接与DNS状态，再复核SN及APK。错设备提前停止，期间OTA/换机判失败但保留材料。目录700/文件600。

连接故障先看同一attempt的SDK `websocket failure`、`connect cancelled`，保留异常类型和cause、HTTP response状态。未出现日志可能是日志级别或采集缺失，不能当成没有异常；不在现场自行开启全量调试或修改SDK。`/rtc/validate 200`和系统网络VALIDATED均不能证明入房成功。v367的OkHttp会关闭WebSocket EventListener，普通HTTP耗时不能冒充握手耗时。

短句须同run对齐：源音频/播放→设备采集或发布前证据→Worker上行快照→ASR→收到控制→任务终态→实际声音。工具没有新增APM前后PCM钩子，也没有自动开启现有PCM probe；缺哪层如实标缺失。独立麦克风完整不代表设备完整上行。不要用预期答案提示独立ASR。

**原始采集可能含凭据、儿童正文和设备隐私，只留受限私有目录，禁止加入git、公开文档或随意转发。** 回传先由端侧/服务端同事脱敏，只提供run/attempt/trace/room、版本、时间、阶段、异常类别与耗时；必要原日志走既有私有证据渠道。

当前取证工具已有4项单元测试，但尚未连接本次真实设备运行。需要实际测试Mac入口及上午原始材料目录，才能继续物理链路复验；服务器权限已可用。

署名：codex（OpenAI）| 2026-10-30（北京时间）
