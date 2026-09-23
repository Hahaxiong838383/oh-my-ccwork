# 小可语音 worker 迁移方案：64.90.13.117 → 64.90.13.177（voice-worker-hk2）

> 写于 2026-09-22 11:28 CST ｜ 作者 cc ｜ 状态：方案，未执行 ｜ 适用：小可读写台生产语音链路（rust worker 两池，含 One-shot V1.1）

## 0. 一句话结论

**读写台不用动，也不用重新 OTA、不用改小程序、不用你手动操作设备。** 迁移只发生在 LiveKit 后面那一层：新机把同名 worker 报到 LiveKit，老机下线，设备毫无感知。你需要做的只有两件事：拍板一个切换时段，以及事后决定老机去留。

## 1. 为什么设备不用动（架构一图流）

```
读写台(Launcher)
  ├─① 找 p003 服务端(kidshub-ai.hahaxiong.cc, aliyun-hk)要房间票
  │     票里写死 agent 名：普通会话 = rust-worker，One-shot 首句会话 = rust-worker-firstturn
  ├─② 拿票连 LiveKit(voice-hk.hahaxiong.cc = 47.239)进房
  └─③ LiveKit 看票上的 agent 名，把活派给"任何一个"以该名字报到的 worker

worker(64.90.x)是主动出站去 LiveKit 报到的，设备和服务端都不知道 worker 在哪台机器上。
```

已核实（2026-09-22 只读检查）：
- 服务端代码里 agent 名是常量 `rust-worker` + 环境变量 `ONESHOT_FIRST_TURN_AGENT_NAME`，没有任何 worker IP。
- LiveKit 机（47.239）的 nginx、LiveKit 配置、防火墙里都没有 64.90 的 IP 绑定，worker 只凭 API key 报到。
- worker 出站调用的服务端接口（`kidshub-ai.hahaxiong.cc/v1`，小可大脑）nginx 无 IP 白名单。
- 服务端确实有两条通道写了老机地址，但都是**后台运维用**、都已是可配置项：后台「服务器状态」的资源统计（`WORKER_STATS_SSH_TARGET`）和热词/别名发布（`HOTWORD_APPLY_TARGET`），另有 `admin-data.ts:1802` 一处旧写死。切机时改配置 + 修那一行即可，cc 做。

## 2. 迁什么、不迁什么

### 2.1 要迁（小可两池）

| 项 | 老机真值 | 说明 |
|---|---|---|
| 生产池二进制 | `/root/rust-worker/voice-rust-worker` sha256 `b0ec810bea77be98…`（09-17 02:00Z） | = 分支 d3681ee04（附和词 observe + 重连计数修复），原样字节拷贝，不重编 |
| One-shot 池二进制 | `/root/rust-worker-firstturn/voice-rust-worker` sha256 `bd76e93d506daba2…`（09-17 01:38Z） | = 299b074ba（One-shot V1.1 封版）+ d4c2d7dc7 重连修复；`.prev`=c2b84b2e 回滚锚一并带 |
| env 三层 | `/root/realtime-voice-agent/.env`、`poc-eou.env`、`/root/rust-worker/rust-worker.env`、`/root/rust-worker-firstturn/rust-worker-firstturn.env` | 含 LiveKit/火山/讯飞/大模型密钥，只在两台机之间直传，不经仓库不经聊天 |
| 判停边车 | `/root/voice-venv`（670M，python 3.12.3 venv，路径固定 `/root/voice-venv`，两机 python 同版可原路径搬）+ `/root/rust-worker/eot_sidecar.py` | worker 自己拉起边车，每池一个，各 ~0.5G 内存 |
| 模型 | `silero_vad.onnx`（rust-worker 目录内）、声纹模型 `assets/models/…campplus…onnx` 与注册表 `assets/speakers/registry.json`（在 `/root/realtime-voice-agent/assets`，注册表自 07-03 起只读，worker 不写） | 随目录同步 |
| 承接音/人格音 | `/opt/voice-agent/`（fillers-colleague=小可回滚锚、fillers-persona、tts-cache，共 ~50M） | 整目录搬 |
| 设备命令别名表 | `/root/rust-worker/device_aliases.tsv` | 后台发布通道会写它 |
| 后台通道脚本 | `apply_hotwords.py`、`stats.sh`、`host-stats.py`、`deploy-worker-bin.sh`、`restart-worker-envonly.sh` | 后台「服务器状态」和热词发布靠它们 |
| systemd unit | `voice-worker-rust.service`（MemoryHigh 1400M/Max 1800M）、`voice-worker-firstturn.service`（1200M/1500M，含 UnsetEnvironment 去掉快照目录与审计采集） | 内存限额先原样，8G 机上后续再放宽；**老机 firstturn 池是 disabled 状态靠手动拉起的，新机两池都 enable** |
| 快照目录 | 新建空的 `/root/eot-snapshots`、`/root/eot-snapshots-firstturn` | 只建目录，不搬老数据 |

`/root/rust-worker` 去掉 30 个 `.bak-*` 后只有 216M，`/root/rust-worker-firstturn` 208M，加 venv 与资产总计约 1.2G，几分钟同步完。

### 2.2 不迁

- `/root/eot-snapshots` 2.1G 和 `/root/oneshot-audit-*`：都是音频证据，B50 授权只限指定设备会话且要按期删，不复制到新机；One-shot 池 unit 里审计采集继续保持关闭（UnsetEnvironment 不动）。
- 30 个二进制 `.bak-*`、几十个 env `.bak-*`：回滚锚就是老机本身，不用搬。
- `voice-worker.service`（python 主线）：已退役、inactive，不搬。
- `voice-worker-colleague`（Javis 同事 demo，python）、`voice-console` + caddy `voice-api.hahaxiong.cc`、`voice-worker-demo`（你的体验 demo 池）：**不属于小可正式环境，本轮不动，留在老机**。老机 10/16 到期若要退，再做第二阶段（见 §6）。

## 3. 怎么迁（五步，都是 cc 做）——⚠️ 已被 §10「最终建议」取代，保留作对照

**A. 备料（新机，不报到）** 同步上表全部文件到新机同路径，逐文件 sha256 对撞；装两个 unit 但先不启动。新机 8C/8G 基线已整备完（09-22 11:15），glibc/CPU 与老机同构，二进制免编译。

**B. 并行报到（验证期）** 先起 One-shot 池（`rust-worker-firstturn`）再起生产池，两机同名 worker 同时在 LiveKit 注册。LiveKit 按负载分配，新机会自然分到一部分真机会话。判据：新机 journal 出现 `registered` + 真机房间 `job accepted`、首声/EOT 指标正常、边车 socket 有监听、无 ERROR 簇；后台「服务器状态」切到新机能读到资源。验证期建议 1–2 小时，避免长期两机并行让热词发布只落一台。

**C. 切换（安静时段）** 老机两池 `stop`。rust worker 收到停止信号不排水（源码无 drain，TimeoutStop 90s 只是等待），在途会话会被直接掐断，所以必须挑零在途房的时刻：近 30 天签发按小时统计 06 点最低（0.75%），建议 **06:00–07:00 CST**，停之前 cc 用 LiveKit 日志确认老机 workerID 无活跃 job。停后老机 unit 设为 disabled，防重启回来抢活。

**D. 后台对接** 服务端 `.env.local` 加 `WORKER_STATS_SSH_TARGET`、`HOTWORD_APPLY_TARGET` 指向新机，`admin-data.ts:1802` 那处旧写死改成读同一变量，`pm2 restart p003-voice --update-env`；新机照老机配好后台用的受限只读/发布入口；后台点一次「服务器状态」和一次热词发布做回归。

**E. 观察与回滚** 切换后 24–48 小时看：房间数/underrun 比例/WARN 形状与迁前基线（09-15 记录：82 房/191 turn/underrun 47%）同形；One-shot 首句会话 `begin accepted` 正常。回滚 = 老机两池 `start`（文件都还在，秒级），新机 `stop`。

## 4. 你要做的（人话版）

1. **拍板切换时段**（建议某天 06:00–07:00 CST；验证期可以放在前一天白天）。
2. **迁完后决定老机去留**：老机 ~10/16 到期。留着 = 天然回滚锚 + demo/同事 demo/console 继续在上面跑；退掉 = 需要第二阶段（§6）。
3. **决定新机密码策略**：迁完后改密并关密码登录（cc 可做，等你点头）。

不需要你：动设备、发 APK/OTA、改小程序、改后台配置、改 DNS（第一阶段无 DNS 变更）。

## 5. 风险与已核实的边界

| 风险 | 事实 | 处理 |
|---|---|---|
| 切换掐断在途会话 | worker 无排水 | 只在零在途房时停老机；LiveKit 日志核对 |
| 两机并行状态分叉 | 声纹注册表只读；设备记忆/情景记忆/人格成长全在服务端 DB；worker 本地可变的只有快照/审计证据与热词 env | 并行期短、热词发布在切换后再做 |
| 边车没起来 = 判停变钝 + 声纹失效（08-14 实证，进程级单例不重连） | 新机首启按纪律 `stop→确认无残留边车→start`，判据 `ss -xlp` 有 eot.sock 监听 | 首启即验 |
| One-shot 池漏启 | 老机该池是 disabled 靠手工拉起 | 新机 enable，重启机器自恢复 |
| 内存 | 老机 3.8G 已到 available 1.8G；新机 7.8G，两池+两边车约 1.5–2G | 限额先原样，稳定后再放宽 |
| 审计采集误带 | One-shot 池 env 里 `ONESHOT_AUDIT_CAPTURE_ENABLED=1` 但 unit 用 UnsetEnvironment 关掉 | 新机 unit 原样保留 Unset，且不搬审计目录 |
| 后台通道指错机 | 三处引用见 §1 | 切换日一次改完并回归 |
| openssh 升级断听 | 新机已升到最新，短期不会再触发；将来升级放 transient unit | 见记忆 feedback_apt_openssh_upgrade_sshd_gap |

顺带发现（与迁移无关但值得看）：LiveKit 日志最近 2 小时有 14 条 `no worker is available` 指向 `rust-worker`，同期只有一个 worker 在册（老机生产池）。可能是 worker 重连窗口或负载上报，没有深查，迁移到新机后如果消失就说明是老机资源问题；如果还在，再单独排。

## 6. 第二阶段（可选，仅当老机要退）

demo 池 + Javis 同事 demo 池 + voice-console/caddy 一起搬到新机。多出来的动作只有一条：`voice-api.hahaxiong.cc` 的 A 记录指到新机（DNS 在阿里云 cc-remote 账号，cc 能改），以及新机防火墙放开 80/443。同事 demo 池是 python worker，要多搬 `/root/realtime-voice-agent` 整仓（89M，editable 装，venv 已随第一阶段到位）。

## 7. 时间估算

备料 30 分钟，验证期 1–2 小时，切换 10 分钟，后台对接 20 分钟，观察 24–48 小时。全程 cc 操作，你只出现在第 4 节那三个决定里。

---

## 8. 迁移清单（逐项，三线交叉核对于 2026-09-22 11:41 CST）

核对方法：①运行中两池进程 `/proc/<pid>/environ` 与 fd/maps 真值 ②源码在两池对应提交读取的全部 98 个 env 名 ③老机系统级配置全扫（sysctl/limits/journald/drop-in/hosts/timers/cron）。三线并集如下，✅=已核实存在于老机且路径无 IP/主机名绑定。

### A. 二进制（字节拷贝，不重编；动态依赖仅 libc/libm/libgcc_s/libstdc++，新机同版）
| # | 路径 | 指纹 / 来源 | 验收锚 |
|---|---|---|---|
| 1 | `/root/rust-worker/voice-rust-worker` | sha256 `b0ec810bea77be98…`，分支 d3681ee04（附和词 observe + 重连修复） | 新机 sha256 相同 |
| 2 | `/root/rust-worker-firstturn/voice-rust-worker` | sha256 `bd76e93d506daba2…`（299b074ba One-shot V1.1 封版 + d4c2d7dc7） | 同上 |
| 3 | `/root/rust-worker-firstturn/voice-rust-worker.prev` | `c2b84b2ec88b3bcf…` 回滚锚 | 同上 |

### B. 配置（4 env + 2 unit + 3 drop-in + 1 hosts 行）
| # | 路径 | 说明 | 新机差异 |
|---|---|---|---|
| 4 | `/root/realtime-voice-agent/.env` | 41 键：LiveKit / 火山 / 大模型 / 讯飞 / 声纹开关 | 原样 |
| 5 | `/root/realtime-voice-agent/poc-eou.env` | 11 键：判停参数 | 原样 |
| 6 | `/root/rust-worker/rust-worker.env` | 66 键：`AGENT_NAME=rust-worker`、`WORKER_MAX_JOBS=10`、热词/别名/灰度名单、边车路径 | `WORKER_MAX_JOBS` 按 §9 改 |
| 7 | `/root/rust-worker-firstturn/rust-worker-firstturn.env` | 17 键：`AGENT_NAME=rust-worker-firstturn`、`ONESHOT_*`、`ORDERED_*` | 加独立 `EOT_SOCK`，`WORKER_MAX_JOBS` 按 §9 改 |
| 8 | `voice-worker-rust.service` + drop-in `10-oom.conf`（OOMScoreAdjust=-900）+ system.control 覆盖 MemoryHigh/Max 1400M/1800M | EnvironmentFile 顺序 .env→poc-eou→rust-worker.env | 限额按 §9，写进本体不再用 set-property |
| 9 | `voice-worker-firstturn.service` + `50-b84-capacity.conf`（1200M/1500M）+ `99-disable-audit-capture.conf`（Unset ONESHOT_AUDIT_*）；本体 `UnsetEnvironment=EOT_SNAPSHOT_DIR` | **老机是 disabled 靠手工拉起** | 新机 enable；Unset 两条原样保留 |
| 10 | `/etc/hosts` 一行 `47.239.204.68 javis.chenchuan.cc voice-hk.hahaxiong.cc` | 公网 DNS 现也解析到同 IP，钉死只为不依赖 DNS | 照搬 |

四个 env 文件 grep 老机 IP/主机名 = 0 命中；系统级无自定义 sysctl/limits/journald（全默认），locale C.UTF-8、UTC，新机已同。

### C. 判停/声纹边车与模型
| # | 路径 | 说明 |
|---|---|---|
| 11 | `/root/voice-venv/`（670M） | 边车 python 环境；两机 python 3.12.3 同版、`pyvenv.cfg home=/usr/bin`，原路径 rsync 即可用。边车实际加载：livekit `local_inference` 原生库（EOU 模型随包内置）+ `sherpa_onnx` + numpy；`/root/.cache` 里没有模型 |
| 12 | `/root/rust-worker/eot_sidecar.py` | 边车脚本，worker 启动时自己拉起 |
| 13 | `/root/rust-worker/silero_vad.onnx` | VAD 模型 2.3M |
| 14 | `/root/realtime-voice-agent/assets/models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` | 声纹模型 |
| 15 | `/root/realtime-voice-agent/assets/speakers/registry.json` | 声纹注册表，07-03 起未变、worker 不写 |
| → | 直接 rsync 整个 `/root/realtime-voice-agent/`（89M，venv 的 editable `.pth` 也指向它） | |

### D. 资产与数据表
| # | 路径 | 说明 |
|---|---|---|
| 16 | `/opt/voice-agent/`（~50M） | `fillers-colleague`=生效 FILLER_DIR（含 manifest.json，后台通道读）、`fillers-persona/<两台 SN>`、`tts-cache`、三份 .bak |
| 17 | `/root/rust-worker/device_aliases.tsv` | 设备命令别名表，后台发布通道会改写 |
| 18 | `/root/rust-worker/e2e-audio/`（380K） | `cmd_*.wav` 设备命令探针音频 |
| 19 | `/root/rust-worker/fillers-v6-staging/`（7.4M） | 承接音 staging，顺手搬 |

### E. 后台（p003 服务端）通道
| # | 项 | 说明 |
|---|---|---|
| 20 | 新机脚本：`apply_hotwords.py`、`stats.sh`→`host-stats.py`、`deploy-worker-bin.sh`、`restart-worker-envonly.sh` | 热词发布=快照→原子写 rust-worker.env→stop→等边车清零→start→健康自检；**只重启生产池**，firstturn 不在其范围（现状如此，照搬） |
| 21 | 新机受限入口 | 老机 authorized_keys 里两条后台专用条目（资源统计只读 / 热词发布，各锁一条命令）原样照配 |
| 22 | 服务端 `.env.local` 加 `WORKER_STATS_SSH_TARGET`、`HOTWORD_APPLY_TARGET`；`admin-data.ts:1802` 旧写死改读前者；`pm2 restart p003-voice --update-env`；服务端 known_hosts 加新机指纹（BatchMode 否则直接失败） | cc 做 |
| 23 | 回归：后台「服务器状态」读到新机 + 热词发布一次回执 ok | |

### F. 运行时目录（新建空目录，不搬数据）
| # | 路径 | 说明 |
|---|---|---|
| 24 | `/root/eot-snapshots` | 生产池 EOT_SNAPSHOT_DIR；老机 2.1G / 2362 房 / 近 7 天 338 文件，无清理闸 |
| 25 | `/root/eot-snapshots-firstturn` | env 里有但 unit Unset，实际不写；建目录无害 |
| 26 | `/tmp/*-eot.sock` | worker 启动自建 |

### G. 出站连通性（新机 09-22 实测 6/6 通；worker 只出站，ufw 出站全放）
`wss://voice-hk.hahaxiong.cc`（LiveKit，钉 IP 后 3ms）、`https://kidshub-ai.hahaxiong.cc/v1`（小可大脑，/health 200）、`wss://openspeech.bytedance.com`（火山 ASR/TTS）、`wss://cbm01.cn-huabei-1.xf-yun.com`（讯飞 TTS）、`https://ark.cn-beijing.volces.com`（大模型兜底）、`https://javis.chenchuan.cc`（env 里有，rust 不读）。

### H. 明确不搬
- 30 个 `voice-rust-worker.bak-*`、几十个 env `.bak-*`、`canary-new/`、`v6-new/`（旧二进制 69M×2）。
- `/root/eot-snapshots` 老数据、`/root/oneshot-audit-20260912`、`/root/oneshot-audit-control-20260912` 与其一次性 timer（09-13 已执行完）。
- `voice-worker.service`（python 主线，已退役 inactive）、`voice-worker-colleague`（Javis 同事 demo）、`voice-console` + caddy `voice-api.hahaxiong.cc`、`voice-worker-demo`（体验 demo）→ 第二阶段。
- `MUSIC_ORCHESTRATOR_URL=127.0.0.1:8100`：老机上无人监听且 rust 不读该键（python 线遗留），随 .env 搬过去无害。

### I. 验收锚（每步机器可判）
文件逐项 sha256 对撞 → 启动 journal `registered worker`、无 panic、`ss -xlp` 两个 eot.sock 各有监听、边车进程数=2 → 真流量 journal `received job request, accepting`/`worker_room_connected`/`process exiting` 且 LiveKit `assigned job to worker` 的 workerID 属新机 → 后台两条通道回归 → 切换后老机两池 inactive+disabled、LiveKit 只剩新机 workerID。

## 9. 资源利用与并发上限（两池口径；单池终值见 §10.4）

### 9.1 现状真值（老机 4C/3.8G，09-22 实测）
- 两池 `WORKER_MAX_JOBS` 各 10；**7 天真实峰值并发 2**（生产池 333 单/7 天、firstturn 36 单、demo 2 单；每日 11–91 单）。
- 生产池 cgroup：121 小时平均 0.05 核、内存峰值 583M（限 1400M）、`memory.events` high/max 全 0、无 CPU 节流；整机 CPU PSI full=0。
- 单路成本（08-14 实测，单轮短 probe）：**0.3 核、12–18MB**，瓶颈是 CPU 不是内存。
- **两池共用一个边车 socket**（`/tmp/rust-worker-eot.sock`），边车单进程串行推理，RSS ~500M。
- LiveKit 那 14 条 `no worker is available` 已定性：`jobType=JT_PARTICIPANT`，rust worker 只接 JT_ROOM，每次进房 LiveKit 都会顺手试一次参与者级派单——**不是容量问题**。

### 9.2 新机（8C/7.8G）建议配置
| 项 | 老机 | 新机 | 依据 |
|---|---|---|---|
| 生产池 `WORKER_MAX_JOBS` | 10 | **20** | 8 核留 1 核给系统与边车 → 7÷0.3≈23 路 |
| firstturn 池 `WORKER_MAX_JOBS` | 10 | **12** | 两池服务同一批设备，硬约束是「同时说话总数≈23」 |
| 生产池 MemoryHigh/Max | 1400M/1800M | **3000M/3500M** | 固定 ~0.65G + 20 路×18M ≈ 1G，留 3 倍 |
| firstturn MemoryHigh/Max | 1200M/1500M | **2000M/2500M** | 同上 |
| 边车 | 共用 1 个 | **各 1 个**（firstturn 独立 `EOT_SOCK`） | +0.5G 内存换掉串行瓶颈与互相牵连 |
| OOMScoreAdjust | 仅生产 -900 | 两池 -900 | 系统缺内存先杀别的 |
| 快照保留 | 无限增长 | 建议 30 天定时清理 | 2.1G/2 个月，80G 盘不急但要有闸 |

合计常驻约 1.8G、满载约 3G，8G 机余量充足；两池限额之和 6G 仍给系统留 1.8G。

### 9.3 并发上限（人话）
- **可接入设备数**：不受 worker 机限制。设备只是服务端账本一行，在线时每 30 分钟拉一次配置、报一次遥测，几百台都不是事。
- **同时说话的设备数**：老机名义 10 路；新机按 CPU 口径 **约 23 路，建议按 20 路用**（生产 20 + firstturn 12 是名义值，真正的闸是同时说话总数）。超过 20 台同时说话就加第二台 worker 机：LiveKit 注册制，新机报到即分流，设备和服务端零改动。
- **先查三个外部天花板**，否则 worker 放到 20 也白搭：火山流式 ASR 并发配额、讯飞 TTS 并发配额、大模型 RPM。这三个数我这里没有，标「未知」，要在各家控制台看。
- **周边两台机**：LiveKit 机 47.239（2C/1.6G）7 天 746 房、峰值 2 并发、PSI 0，音频房便宜，几十路可以；但它是 3 个月试用机 **~09-29 到期**，续费比扩容紧急。p003 服务端 aliyun-hk（2C/3.4G）发票 + 大脑代理，20 路无压力。
- **校准动作**：0.3 核/路来自单轮短 probe，长会话多轮会更高。MAX_JOBS 定终值前，在新机用 rtc_probe 多开跑一次 5–10 路压测，看 CPU PSI 与 EOT 延迟再拍板。

---

## 10. 最终建议：单池 + 零空窗切换（2026-09-22 12:45 CST，川哥要求「设备端无感」）

### 10.1 三条铁律（无感的全部含义）
1. **任一时刻，服务端正在签发的每个 agent 名都至少有一个 worker 在 LiveKit 注册**——没有空窗。
2. **只在 0 在途房时停 worker**——rust worker 无排水，停就是掐。
3. **首句票据只能落到带 One-shot 标志的 worker**——生产池二进制已含代码但 env 没标志，落上去是降级首句。

### 10.2 为什么是单池
- 生产池 d3681ee04 ⊇ One-shot 池全部提交；One-shot 池的 12 个标志消费点全在 ordered 上下文之后（`TTS_FIRST_CLAUSE_ORDERED_ONLY` 默认 true、ready 确认只应答新端才会发的请求）。同池不误伤老 APK。
- 一个池一个数（20 路），热词发布一次覆盖全部会话，少一个边车、少一套 unit。

### 10.3 五个阶段（每一步都可单独回退，老机全程不动直到最后）

| 阶段 | 动作 | 设备可感？ | 回退 |
|---|---|---|---|
| 0 备料 | 新机按 §8 清单同步、指纹对撞；单 unit `voice-worker-rust`：生产池 env + One-shot 12 标志，`WORKER_MAX_JOBS=20`，MemoryHigh/Max 3000M/3500M，OOM -900，enable | 否 | 删文件 |
| 0.5 隔离验证 | 新机先用**临时 agent 名**（如 `rust-worker-hk2`）启动，用仓内 rtc_probe 按名派单跑真流量（ASR/TTS/大脑/判停/声纹）；看 `registered`、边车 socket、`worker_room_connected`、首声指标、0 ERROR | 否（真机永远碰不到临时名） | stop |
| 1 并行接活 | 改回 `AGENT_NAME=rust-worker` 重启（新机此时无流量，重启零成本）。老生产池 + 新单池同名并存，LiveKit 分流普通票据；首句票据仍全落老 One-shot 池。观察 ≥24h：新机 journal 有真机房、underrun/WARN 形状与老机同形；后台「服务器状态」目标切新机 | 否（普通票据两边行为相同） | stop 新池 |
| 2 首句切换（06:00–07:00） | ①老生产池「读在途=0 即 stop」一条命令内完成 → ②服务端 `ONESHOT_FIRST_TURN_AGENT_NAME=rust-worker`，`pm2 restart --update-env` → ③老 One-shot 池**不停**，空转当热备 → ④等下一次自然首句会话（或灰度机 …03800006 触发一次），确认新池 `ordered_pcm 实验模式启用(受信 metadata)` + `begin accepted` | 只有 ①的毫秒级竞态；首句流量 ~5 房/天 | env 改回 + 老生产池 start，秒级 |
| 3 收尾（切换后 24–48h） | 老 One-shot 池 stop+disable；热词发布目标切新机；`admin-data.ts:1802` 旧写死改读配置；服务端 `AGENT_NAME` 注释更新；观测脚本（b104）journal 源改单 unit、按票据类型分流统计 | 否 | 老池 start |

顺序不可换：**老生产池先停 → 服务端改派单目标 → 老 One-shot 池最后停**。反过来会让首句票据落到没标志的老生产池。

### 10.4 单池终值
`WORKER_MAX_JOBS=20`（8 核 ÷ 0.3 核/路留 1 核 ≈23，按 20 用）、MemoryHigh/Max 3000M/3500M、一个边车、`EOT_SNAPSHOT_DIR=/root/eot-snapshots`（30 天清理）、审计采集不带。外部配额（火山 ASR / 讯飞 TTS / 大模型 RPM）仍是未知，量产前查。

### 10.5 设备侧结论
不发 APK、不 OTA、不改小程序、不改 DNS、不重新配网；老版本设备（242/233）走普通路径照常；新版本设备带声明的走首句路径。设备唯一可能感知的只有阶段 2 第①步的毫秒级竞态，放在日流量 0.75% 的时段。

### 10.6 你要做的
拍板阶段 1 的开始时间（任意时段皆可，只加不减）和阶段 2 的那个早晨；迁完后决定老机去留与新机密码策略。其余全部 cc 执行。

---

## 11. 执行记录（cc 逐步追加）
- 09-22 12:5x 阶段 0/0.5/1：rsync 四目录 + 12 标志合池 env（MAX_JOBS 20，3000M/3500M）；临时名 rust-worker-hk2 探针全绿（eou 424/首声 +729/llm ttft 748，小可人设回答）；12:57 改回 rust-worker 注册 AW_Ftd5oYjdi2Vs 与老生产池并存。13:32 首个真机房落新机 = 设备端 2 秒空房（与老机基线同型：当天 13 房 10 房零音频）。
- 09-22 13:00–13:42 后台：服务器状态/接入容量支持多 worker（WORKER_STATS_SSH_TARGETS）+ 判停边车表（host-stats.py sidecars_block 四机同版）。
- 09-22 13:45 观察：川哥体验的 3 场全是首句票据 → 全落老 One-shot 池（阶段 1 设计如此），新机未接到真对话；老生产池 45 分钟零房。
- 09-22 13:46 **阶段 2 ①**：老生产池 in-flight=0 → `systemctl disable --now voice-worker-rust`（其共用边车随之退出，老 One-shot 池按需自愈）。
- 09-22 13:47 **阶段 2 ②**：aliyun-hk .env.local `ONESHOT_FIRST_TURN_AGENT_NAME=rust-worker`（备份 _backup/20260922-phase2-env.local.bak），pm2 restart --update-env，health ok，/api/admin/oneshot agent_name=rust-worker，policy capability 不变。
- 09-22 13:47+ **阶段 2 ③**：老 One-shot 池不停作热备；设备端预取票据 TTL 1h 仍指旧目标（13:47:52 …00800010 仍落老池），排空前不动它；排空后空转时重启一次让它拥有独立边车。④ 等新机首个首句房（watcher）。
- 09-22 14:56 **阶段 3 项提前（行 22 的 HOTWORD_APPLY_TARGET）**：川哥发现热词页每类标题都挂「env 已改未重启」——根因是通道默认指老机 64.90.13.117，老生产池 13:46 已停（MainPID=0 → 进程值为空 ≠ 文件值），并非新机改了 env 没重启（新机 10 键文件=进程逐一对撞 SAME）；且此时从页面「发布」会 `systemctl start` 拉起老池造成 rust-worker 双注册。处置：先用 forced-command key 对新机干跑 status（ok/unit_active/五类 in_sync 全 true），再 aliyun-hk `.env.local` 追加 `HOTWORD_APPLY_TARGET=root@64.90.13.177`（备份 `_backup/20260922-145522-hotword-target/`，`.new` md5 复验后 mv），pm2 restart --update-env，health 200；后台 /api/admin/hotwords channel_ok、unit_active、五类 live_in_sync 全 true，worker-race 文件=进程零差异。赛马/音色面板同通道一并指新机。回滚：删该行（或 cp 备份回 .env.local）+ pm2 restart --update-env。
- 09-22 15:00 **阶段 2 ③ 收口**：老 One-shot 热备 3h 接 5 房关 5 房（最后一房 13:49 …00800010），14:50 后零新房；14:40 它已自行 spawn 独立边车（`EOT sidecar connected (spawned)`，socket 在听）→ 计划中的「排空后重启一次」不再需要，不动它。观察器脚本判据写坏（in-flight 输出两列致比较失败）已停，未误操作。
- 09-22 15:35 新机换装语音控设备 D1 二进制（sha 8fbc42bd…；备份 .bak-20260922-073535 = d3681ee04 产物 b0ec810b…；纪律换装 deploy-worker-bin.sh，in-flight 0）——与迁移无关，记机器史。老 One-shot 热备仍旧二进制。

## 12. 阶段 3 执行清单（2026-09-22 16:50 拟，等切换后 24–48 h 即 09-23 13:47 之后；每步可单独回退）
前提判据：老热备 24 h 零新房（今 13:49 后已零）、新机 24 h 无 ERROR 增长、后台卡两台 worker 都绿。
**A. cc 直接做**
1. 老 One-shot 热备 `voice-worker-firstturn` 于老机 stop + disable（unit 文件与二进制留作回滚锚 7 天；回滚 = start + 服务端 `ONESHOT_FIRST_TURN_AGENT_NAME` 改回旧名 + pm2 restart）。
2. 代码去写死老机：`hotword-channel.ts` 默认 TARGET → hk2、`hosts-status.ts` `LEGACY_WORKER_TARGET` → hk2 + 注释、`admin-data.ts` 旧注释、`rollback-b8.sh`/`vi-collide.sh`/`build-local.sh` 提示语、hosts-status 测试；服务端 pm2 重启一次。
3. 服务端 `.env.local`：`WORKER_STATS_SSH_TARGETS` 标签去「迁移中」；老机行是否保留取决于 B-8（老机上还有 demo/租户线要观测则保留到退役日）；`AGENT_NAME`/One-shot 注释更新。
4. 观测脚本：`b104-oneshot-adoption-report-20260913.sh` journal 源改新机单 unit、按票据类型分流统计。
5. 新机 unit `Description` 去「迁移中」；老机清理（老热备停后）：EOT 快照 2.1 G 按既有保留策略、31 份二进制备份留 5、socket 残留。
6. 记忆与文档：cloud_servers 老机角色改为「caddy + voice-console + 租户线（7 天 0 房）+ demo 线（7 天 2 房）」、迁移文档 §11 收尾、RELEASES。
**B. 川哥拍板**
7. 老机去留（~10/16 到期）：老机上仍跑 caddy、voice-console、`voice-worker-colleague`（租户 python 线，7 天 0 房）、`voice-worker-demo`（7 天 2 房）——要么随机器退役、要么迁新机（8 G 可容）或别处；定了 cc 出方案。
8. 新机安全：改 root 密码 + 关密码登录（sshd 改动分类器拦 cc，需你跑一条命令）；RTF 里的旧密码作废。老机上 aliyun-hk 的两把 forced-command key 随退役消失，新机已配。
- 2026-09-23 09:58 CST 阶段 3 第 2 项「代码去写死老机」随语音控设备 D2 A 组上线（服务端 8f0951722：hotword-channel 默认 TARGET / hosts-status 默认目标与标签 → hk2，vi-collide / build-local 提示语 / rollback-b8 注 / b104 单池版）；env 已设故线上行为不变。其余项等 13:48（老热备 24h 零房到点）。
