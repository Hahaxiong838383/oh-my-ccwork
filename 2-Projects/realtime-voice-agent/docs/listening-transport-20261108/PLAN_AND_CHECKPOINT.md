# 倾听池连接稳定性补齐

状态：代码与隔离回归完成，正式发布待独立 RTC、Grok 复核和线上空闲核验。不是整个语音故障收口。

## 固定对象

- 现役倾听源码 `5b3fdaac2b0e6d552a899ea7a941616cfbed2d5d`，二进制 `7d39184c200053db5adbc59580517110762b0c3ac31928cc246d5f9162817de0`。
- 当前 session39 HEAD 缺少现役短退出口令补丁，因此从现役提交建立专用分支 `codex/p003-listening-transport-20261108`；原 38/39 树未改。
- 运行候选 `de09010304f2a44556bd706c7b810828062b4433`；正式无测试 feature 构建 `d627dfa91f33fd01771c87bc6ac2bbb6a3ccb937b823bf7e0bd56ec92e1ab0e0`，78023792 字节。GLIBC/GLIBCXX 兼容门通过。
- 后续提交仅补一个 cfg(test) 用例和记录，未改变上述运行候选。额外用例验证 1 秒首 PCM 截止取消正在挂起的真实预热任务。

## 修改及保留

只改 voice_connect、tts、tts_xfyun、stt_volc 和 pipeline 的 ASR 接口调用。CNAME 的目标地址位于 ADDITIONAL 时不再误判无地址；按实际解析器清理短 TTL 缓存；恢复取消分支的诊断上下文。TTS 在前台共享 10 秒接通预算，650ms 后最多一条备用，保留候选首 PCM 预算和 200ms DNS 备用规则，避免重复对冲。ASR 接通有总上限，未使用流不发伪结束帧，连接失败不进入六轮重复接通。

其余运行模块逐文件核同基线（见 EVIDENCE.json），包括搜索 R27、倾听状态机、三条退出语句、授权和房间清理。`P003_TTS_LATENCY_V1=1` 与恢复同时开启时，不再另开预热对冲。发布只新增两个恢复开关=1，其余配置、设备范围、窗口期限保持原值。

## 自检证据

| 核验 | 结果 |
|---|---|
| 原现役完整回归 | 613 通过、2 既有忽略 |
| 在旧代码加入 CNAME 缺陷用例 | 570 通过、3 真实失败、2 忽略 |
| 候选完整回归 | 648 通过、0 失败、2 忽略 |
| 额外首 PCM / 恢复取消交叉测试 | 合计 649 通过、0 失败、2 忽略 |
| 正式构建和 ABI 门 | 通过，固定 de090103 |
| 真实 RTC / 安卓 / 线上切换 | 尚未执行，待后续回执更新 |

完整日志位于私有状态目录 `p003-business-watchdog-20261107/listening-transport-evidence`，SHA 在 EVIDENCE.json。保留首次遗漏测试合同文件、复制测试依赖不匹配、构建缺少显式 build SHA 的失败记录；这些均修正后复跑，不当作业务通过。

## 发布和回滚

1. 仅倾听池；当前主 Brain canary 名单为 03800006。主池和独立搜索池进程/二进制/配置作为保护对象。
2. 发布前重核磁盘与进程二进制、健康 jobs=0、无该池活动房间/租约，以及配置/窗口未漂移。备份 binary、canary.env、release.json、unit 和 Brain listening-release.json，分别 SHA 校验。
3. 先替换 Worker 正式 binary+两个恢复开关+release.json，检查注册及健康；随后按原字节哈希比较更新 Brain 发布清单 build SHA，等待真实配置 ACK。只改 build/evidence_ref，不改授权能力/设备范围。
4. 回滚必须成对恢复 Worker binary/env/release 元数据与 Brain manifest；先核服务空闲，不整树覆盖，不回灌数据库。待完成部署脚本与确切备份路径后记录最终回执。
5. Git 代码回滚锚 `rollback/p003-listening-transport-pre-20261108` 已 push，peeled=5b3fdaac；远端私有原 binary/env/unit 备份在 `/root/p003-business-watchdog-20261107/rollback-other-pools/p003-listening-worker/`，本轮已重核。

## 仍不能声称解决的事项

CNAME 缺陷已复现，但没有历史 DNS 4704ms 的抓包，不能推断它就是那次等待的唯一原因。ASR recognition hold 与业务看门狗尚未移植到倾听池，对应测试留在私有待办文件而非算成通过。独立搜索池本轮未发版。服务器合成语音测试不能代替安卓、真人语音、设备网络与长期稳定性验收。

署名：codex（OpenAI）| 2026-11-08
