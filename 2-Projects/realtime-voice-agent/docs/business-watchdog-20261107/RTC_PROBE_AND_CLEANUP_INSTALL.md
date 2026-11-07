# 真实 RTC 探针与清理辅助服务

状态：真实合成 RTC 生命周期及独立进程退出清理验证通过；辅助清理 timer 已安装。主/搜索/倾听业务二进制未切换。

探针是 cfg(test) ignored 测试，默认测试不发网络；明确 synthetic-only、固定合成 SN BJP00326110799999901、单进程 observe/enforce 才允许执行。直接调用正式 run_job，走 LiveKit 麦轨/PCM/ASR 输入/ready/ordered 转 RTC；不注册另一个 Worker，不接受用户设备派单，不修改设备配置。测试房独立命名，前后精确 SID 查验；不能将合成验证称真人实听。

辅助服务首次真实启动失败，原因是 unit 只加载 rust-worker.env，而实际生产主服务依次加载 realtime-voice-agent/.env、poc-eou.env、rust-worker.env。缺失 LIVEKIT_URL 引发 KeyError。完整失败日志私有保存；补齐相同顺序后 2026-11-07 23:45:22 CST 启动成功，healthy=true、remaining=0、timer=active。主 PID3179125/NRestarts0 保持。不得将 systemd-analyze verify 成功当环境齐备。

回滚：本阶段若需停止辅助服务，先检查 /var/lib/p003-business-cleanup/queue 是否有记录。现役旧主程序不会创建该队列记录；未来候选已启用强制保护时，不得先停清理再放任 job 失去兜底。先关闭新 enforce 配置或确认全部对应 job 结束，再 systemctl disable --now p003-business-room-cleanup.timer；保留队列/status、脚本和安装清单以便恢复，禁删除未确认房间记录。

安装清单 /root/p003-business-watchdog-20261107/cleanup-install-manifest.json；首次失败 unit 原字节 cleanup-unit-initial.service；最终 unit SHA256 6a1b442c44b3d00ce91fba8b124c95216193e48470e8507e6f5ffbd861b818ca。补齐环境只引用原有文件，未外传任何凭据，也未改这些文件。

后续继续核真实静音 enforce/observe、ordered begin_timeout 后 RTC 宽限、清理结果、helper 重试/进程终止，再发布主池单机。本探针只覆盖生命周期，不取代正常语料、灰度池及真实设备验收。

署名：codex（OpenAI）

## 本轮最终实测（2026-11-07 CST）

| 项目 | 实测结果 | 范围 |
|---|---|---|
| Observe 静音 | ready 3989ms；ready 后 9001ms job 仍存活；正常关闭，无 panic | v2 独立探针，不是生产 Worker |
| Enforce 静音 | ready 4128ms；Close(IdleNoProgress) 日志约9338ms；原 SID 回读 Gone | 静音仍在输入，循环存活不再续命 |
| 首句没发 begin→RTC | 客户端收到 input_ready 3080ms、input_phase 5583ms；约11491ms才作空闲关闭；房间 Gone | 保留转场宽限，未接受过期包 |
| 独立清理进程所有权 | 测试 owner 存活时保留；退出后14337ms内 deleted=1、remaining=0 | 临时 sleep 进程+合成 SFU 房，未杀现役 Worker；不是完整 Worker SIGKILL 验证 |

失败原件全部保留：最初观察探针在强制 abort job 的测试收尾引起 SDK Cancelled panic（退出码虽0不能称干净通过），改成客户端正常关房并等待 job 后 v2 不再出现；第一轮 ordered 在短前台回查超时后仍有房，旧夹具立即判失败并主动清房，所以该轮不能证明独立重试。最终夹具保持客户端，允许既定独立 timer 在有界35秒内完成，v3重跑通过。该轮前台 Gone，无须等35秒；后台真正删房另由 owner-death 测试独立证实。

第一次 ordered 测试与测试二进制传输重叠，连接延迟不能代表空载产品性能；最终轮在传输结束后运行。未用任何一轮消除历史网络故障结论。

Grok 会话168固定1f947fe4复核无阻断，原文已归档，未冒称 Grok 重跑本轮真实 RTC。正式release 76127728字节/SHA becc21e9d81cb11bb39ce73df8467867bf038e0cc1771ead1646a9bd9279d2b3，glibc≤2.39/libstdc++≤3.4.33，通过构建但未安装为现役。

23:48前只读SFU仍为02000053原SID RM_D6tdPrWhteMk、两个原参与者ACTIVE；没有清该用户房。最后三池运行SHA/PID/NRestarts保持：主35f59ec/3179125/0、倾听7d39184/2750511/0、搜索56f6878/2446060/0。

下一步：正式语料正常问答/输出等待回归、Brain实际签发配置与UI、主池单机灰度发布；分别核搜索和倾听现役基线再移植。原始输入失败及12张未匹配签票未定位，不能宣称所有语音不稳定已根治。
