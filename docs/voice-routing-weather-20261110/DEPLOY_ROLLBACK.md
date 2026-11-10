# P003 语音天气候选｜发布与回滚记录

当前状态：NOT_DEPLOYED。仅准备、备份与隔离测试，线上运行文件未替换；此文不是上线回执。

## 来源与回滚点

| 对象 | 候选分支 | 原基线／rollback tag |
|---|---|---|
| 主池 | codex/p003-voice-input-routing-fix-20261110 | f0380202eb93303bc69563d37c08bab6f3f9d0fa；rollback/p003-voice-routing-pre-20261110 |
| Brain | codex/p003-weather-preview-fix-20261110 | 62d840c2e347d65bec1de4ddf523b6a2a7c117d6；rollback/p003-weather-preview-pre-20261110 |
| 倾听池 | codex/p003-voice-routing-listening-20261110 | ac18707965623b85540408fc1d989eacb04ce798；rollback/p003-voice-routing-listening-pre-20261110 |

Worker运行备份：`/root/p003-voice-routing-weather-20261110/baseline-20261110T050228Z`。Brain源码/UI备份：`/opt/p003/_backup/voice-routing-weather-20261110/baseline-20261110T050230Z`。预览旧程序补充备份：`/opt/p003/_backup/voice-routing-weather-20261110/preview-supplement/search-route-preview`。

私有候选及证据根：`/Users/fu-121/.local/state/p003-voice-routing-weather-execution-20261110`。候选包不包含env、密钥、真实用户音频或数据库。实际旧运行binary与Git基线分别记录；不能只用checkout标签代替生产运行文件恢复。

## 精确文件范围

`DEPLOY_MANIFEST.json`列7个目标：主池binary；倾听池binary及release.json；Brain两份TS、后台index.html、Rust预览程序。每项均含before/after SHA、旧文件备份、mode。配置schema仍为1；目录数据未改。旧独立搜索池不在部署清单内。

`check_manifest.py`为只读检查器：

```sh
python3 check_manifest.py DEPLOY_MANIFEST.json --host worker --mode before
python3 check_manifest.py DEPLOY_MANIFEST.json --host worker --mode backup
python3 check_manifest.py DEPLOY_MANIFEST.json --host brain --mode before
python3 check_manifest.py DEPLOY_MANIFEST.json --host brain --mode backup
```

在对应主机受控目录运行。任意SHA不符必须停止，用最新线上差分重新审查；不能覆盖其他会话刚发布的文件。镜像before/after/backup正向通过，模拟漂移exit1拒绝；本轮只读核线上及备份全部吻合。

## 后续发布顺序

1. 指定体验SN与时间，核实际派单和现役池；记录配置revision、原设备范围、agent/build。新工作树可见不代表生产已启用。
2. 重跑before/backup检查。确认该池无活跃任务；有房间就延后，不硬重启。复核候选bundle及解压文件SHA。
3. 先发布与候选配套的Brain只读预览/页面，按现有服务发布流程核健康。Worker按池分批原子替换；倾听池必须同时更新release.json，保留原agent/env/unit。
4. 重启仅本批必要进程，核/proc运行binary SHA、健康租约、签票build和真实assignment，再通知设备开始。不能仅凭磁盘文件SHA称上线。
5. 单机通过后才扩大到既有灰度；不顺手为其他设备打开搜索、倾听、定位或诊断。业务窗口至少7天，结束恢复记录的原范围。

## 回滚顺序

1. 停止扩大，恢复本批前设备派单／配置范围。记录当前trace与版本，保留现场。
2. 回滚前用`--mode after`核当前文件确为本批候选，且backup仍符合before；若已漂移，停止覆盖并按实际差分处理。
3. 仅将manifest对应backup复制至同目录临时文件，恢复原mode，验证before SHA后原子替换。主池和倾听池分别恢复，倾听release.json与binary必须成对；Brain/UI/preview独立恢复。
4. 仍在处理真实任务时先等空闲。按现有流程重启本批进程，核/proc SHA及健康、普通问答、取消、倾听退出、关房重入。
5. 不还原env、不整树覆盖、不回灌DB、不删owner、不撤销今天既有DNS/TTS/灾备修复。本轮没有改这些配置；如另有配置发布须用其独立记录。

本轮仅源码与文档需要撤销时可revert相应专用分支提交，不触碰生产。源码回滚标签和生产备份不是同一种证据，需分别保留。

署名：codex（OpenAI）| 2026-11-10 13:53:20 CST
