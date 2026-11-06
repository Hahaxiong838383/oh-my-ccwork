# SFU 只读复核：2026-11-06 下午真实房间与上午 B 三代

采集返回 2026-11-06 18:29:04 CST。只读，未改 known_hosts、密钥、SFU/nginx 配置，未在服务器落文件，未发语音、未做探针、未扩灰度、未改业务代码。Worker 正文、PCM 能量和 APK versionCode 不在本层。

## 1. 结论

14:00 至 18:29 的真实设备房（`sn-` + 14 位 SN + 10 位秒级房尾）共 47 个，每个只有 1 个 roomSID。没有出现上午 B 那种同一房名连续三代。47/47 都有 `JT_ROOM` 派单。`JT_PARTICIPANT` / `JT_PUBLISHER` 的 “no worker is available” 在这 47 个 SID 上各出现一次，包括后面单 SID、双端音轨、客户端离开的会话，不能记成房级派单失败。

设备关闭原因里没有 `SERVICE_REQUEST_DELETE_ROOM`。保留的 negotiation 事件里，真实房和已排除房的 `negotiation failed` 都是 0。上午 11:23 / 11:52 那种 Subscriber 音频再协商超时，在这窗的已保留事件里没有再现。

这只说明 SFU 信令图和上午 B 的断房形态不同。B 的第三代本身也是双端 active、双方音频轨、客户端离开、约 22 秒；当时无声发生在这条图之上。下午图完整不能证明扬声器里有非零 PCM，也不能证明 Android 就绪状态或 Worker 输出门已经好。

03800006 这窗 19 个真实房全部派到 `p003-search-listening-20261030`，workerID 仍是上午 B 的 `AW_H5bWQUJqErSo`。主池 15:34:55 的生命周期/容量广告没有出现在这 19 个房的 SFU 派单目标上。其余 28 个真实房派到 `rust-worker`。`rust-worker` 的注册 ID 在 15:30:49 之前是 `AW_bMcDSuaqigpU`（6 房），15:35:48 之后是 `AW_JNDVANh7ZpeR`（22 房）。SFU 日志没有 991ee2a3，也没有 Worker 二进制 SHA。

APK/versionCode 367 在 SFU 日志中缺。有客户端块时，设备一律是 LiveKit Android SDK `2.27.0`、protocol 13、android 15、`rockchip rk3562_rc160`、wifi；Agent 是 Rust SDK `0.8.3`。与上午 B 的 SDK 块相同，不能据此区分 367 与更旧安装包。

## 2. 机器与 SSH

同一条只读路径落地：Air 上的既有身份做最终认证，`BatchMode=yes`、`StrictHostKeyChecking=yes`，直连 `root@47.239.204.68`。这次没有用 home-studio-mesh。`sfu-extra.py`（SHA256 `627fa835850c81097e28deaef9765ed3eafd201d6c5ce7347ed1822d195d9841`）在该路径上 rc=0。

| 项 | 值 |
|---|---|
| hostname | `iZj6cbb5uj10lp67k1xak0Z` |
| DNS `voice-hk.hahaxiong.cc` | `47.239.204.68` |
| livekit-server | 1.13.2 |
| MainPID / NRestarts | 783 / 0 |
| 进程启动 | 2026-09-12 17:41:36 CST |
| 真实房 nodeID | `ND_YVXiWnhrq4MH` |
| 下午 journal | 3577 行，保留 2956，PID 只有 783 |
| 窗 | 14:00:00 CST 至采集返回 18:29:04 CST；最后一条真实房事件 18:01:49 |

`sfu-collect.py` 的 `since` 固定为 03:20 UTC 且没有 until。按原脚本重放会把已归档的上午 journal 一直读到现在，所以没有整份重放。主机名、DNS、版本和 PID 用的是该脚本开头同一组身份字段，并与上午证据里的 hostname / PID 783 一致。进程从 9 月 12 日起没有重启，下午和上午 B 不是两次不同的 SFU 二进制。

`sfu-extra.py` 里 5 秒计数器是 18:26 左右的瞬时采样，不用于解释 11:35 或 17:43 的单个房间。

## 3. 排除与一个聚合修正

排除没有进入真实房计数：

| 类 | 组数 | 依据 |
|---|---|---|
| 13 位毫秒房尾 | 19 | 房名后缀长度。灰探针已知会用真实 03800006 加毫秒房尾 |
| 假 SN `…99999902` | 22 | 房名 |
| 非 `sn-BJP003{14}-{10}` 房名 | 8 | 14:12–14:17，agent 为 `rust-worker`，有双方音频和客户端离开；不计入设备样本 |

`diagnostic_test` 和 `server-ab-` 没有出现在本次解析到的 SFU 字段里，历史 B 的 trace `b874ed69-1614-4547-bdf1-b522558ccddd` 也没有出现在 SFU 重读里。B 的身份靠房尾 `1793936147` 与既有对账 SID 对齐，不靠 SFU 里的 trace 原文。因此「metadata 含 diagnostic_test」这条排除在本层没有独立命中；13 位房尾和假 SN 已经按房名排除。10 位真实房没有被这条 metadata 规则再划走。

每个真实房名还会带一批没有 roomID 的 API 行（DeleteRoom 等）。按 roomID 为空单独成组会多出 47 个假代。下面的代次只计有 roomID 的 SID。空 roomID 桶只用来回收 DeleteRoom 时间，不记成新一代。

Nginx 自 14:00 起 `DeleteRoom` 147 条，来源全部是 Worker 主机 `64.90.13.177`。其中包含探针房。真实房的空 roomID 桶 47/47 能看到 DeleteRoom API。客户端离开之后的 DeleteRoom 是这窗的常态，不能单独当成上午那种把仍在线设备踢掉的证据。

## 4. 下午真实房

47 个 SID，6 个设备尾号：00800010×6，04800006×7，00100004×9，02000031×4，03800006×19，02000053×2。Reconnect 标志在已保留的 starting 行上没有 true。全部 node 为 `ND_YVXiWnhrq4MH`。

派单：

| 时段（CST，按该 SID 首条事件） | agent | workerID | SID 数 |
|---|---|---|---|
| 15:34:55 前 | rust-worker | `AW_bMcDSuaqigpU` | 6 |
| 15:34:55 后 | rust-worker | `AW_JNDVANh7ZpeR` | 22 |
| 全窗，且全是 03800006 | p003-search-listening-20261030 | `AW_H5bWQUJqErSo` | 19 |

媒体图（`JT_ROOM` 已派、设备与 agent 都 active、双方都发布了 audio、没有 negotiation failed、设备关闭原因为 `CLIENT_REQUEST_LEAVE`、单 SID）：

| 设备会话时长 | 数量 | 其中 listening / rust-worker |
|---|---|---|
| ≥15 秒 | 17 | 15 / 2 |
| <15 秒但仍满足上面的图 | 19 | 2 / 17 |
| 设备没有 active 记录，sessionDuration 记 0，双方音频轨已发布，关闭仍是客户端离开 | 11 | 2 / 9 |

15 秒不是产品门槛。它只用来和 B 第一代大约 1.7 秒的离开分开。8–12 秒、双端音轨、客户端离开的 rust-worker 房仍是单 SID 图，不是 B 的服务端删房。11 个「没有设备 active」的房没有 negotiation failed，也没有服务端删房原因；SFU 只看到轨已经发布、active 行缺失、持续时间记 0。

`close_called` 类 datachannel 错误在 ≥15 秒的图里也很常见（17 个长会话里多数有 8 条 close_called，其中一部分排在第一条 participant closing 之前）。17:37:05 的 038 长会话还有 3 条 `dtls_timeout`，设备关闭原因仍是客户端离开，没有下一代。所以关房附近的 DTLS/close 不能当成这窗的初始根因，也不能用来把长会话判失败。

## 5. 最新真实会话

最新 038，倾听池，单 SID：

| 项 | 值 |
|---|---|
| 时间 | 17:43:34.713 CST 起，设备侧 26.2 秒 |
| 房 | `sn-****03800006-1793958214` / `RM_vCWc3Qh4pURE` |
| JT_ROOM | `AJ_dBRGRwemkGBj`，agent `p003-search-listening-20261030`，worker `AW_H5bWQUJqErSo` |
| 音轨 | 设备 `TR_AM4t3NDVi6D754`，agent `TR_AMrT2KCHm2wj95`，mime `audio/red` |
| ICE | 设备与 agent 都有选中的 UDP |
| 关闭 | 双方 `CLIENT_REQUEST_LEAVE` |
| datachannel | 8 条 close_called（2 条早于第一条 closing 行，6 条在其后）；无 dtls_timeout |
| SDK | Android 2.27.0；APK version 缺 |

17:31:30–17:43:34 还有 15 个更早的 038 新房名（房尾各自不同），同一倾听 worker，都是单 SID、双方音频、双方 UDP、客户端离开。时长 8.8–81.0 秒。这是连续新建房，不是同一房名重连三代。其中最长的一条是 17:38:43 `sn-****03800006-1793957922` / `RM_PP3CEYeoR6Sw` / `AJ_WFkDFGx95FY9`，81.0 秒。

主池 `rust-worker` 上，时长 ≥15 秒的两条：

| 时间 | 房 | SID / job | worker | 设备时长 | 音轨 |
|---|---|---|---|---|---|
| 16:56:08.525 | `sn-****02000053-1793955368` | `RM_Mgf7aLferSA9` / `AJ_3R3uo489MkbY` | `AW_JNDVANh7ZpeR` | 52.3 秒 | 设备 `TR_AMpdFocqJHbTp8`，agent `TR_AMwACU6m3HUQbD` |
| 17:38:48.130 | `sn-****00100004-1793957927` | `RM_xZnQb9LfpYk3` / `AJ_MpEzURA5nwfE` | `AW_JNDVANh7ZpeR` | 63.9 秒 | 设备 `TR_AMSS8UNoqNKJea`，agent `TR_AMTSf986u7CNnD` |

18:01:28–18:01:49 尾号 00800010 有三个不同房尾的 rust-worker 房（一个持续时间记 0，两个约 10.7 秒和 11.4 秒）。房名不同，不是 B 式同房多代。这是本窗最后的真实设备活动。

## 6. 上午 B 重读

房尾 `1793936147`，11:35–11:45 CST 重读 151 行 journal，房名过滤后保留 72。三个有 roomID 的代次与既有 `sfu-brain-reconciliation` 的 SID/job/轨一致。trace 仍不在 SFU 行内。空 roomID 桶里有三次 DeleteRoom HTTP 200：11:35:53.051、11:36:08.001、11:36:43.402，以及 11:36:17.542 `could not handle new participant`（participant 尾号 03800006）。这四条按时间贴回三代，不单列成第四代。

| 代 | SID / job | 设备关闭 | 设备时长 | 音轨（agent / 设备） | 关闭附近 datachannel |
|---|---|---|---|---|---|
| G1 | `RM_mEFRuUuQs5QR` / `AJ_DbBjN5VB47oZ` | `CLIENT_REQUEST_LEAVE` | 1.726 秒 | `TR_AMUPL6mGJY3js5` / `TR_AMYxcK8JMAbL2F` | 6 条 close_called，都在 closing 之时或之后。DeleteRoom 200 在 11:35:53.051 |
| G2 | `RM_3qk9GiHYh76F` / `AJ_N5Zt7m3QYfag` | `SERVICE_REQUEST_DELETE_ROOM` | 8.660 秒 | `TR_AMUdysXtFYTMpt` / `TR_AMNAazEApYLF5f` | 8 条 dtls_timeout，都在 closing 之时或之后。DeleteRoom 200 在 11:36:08.001。agent 先 `CLIENT_REQUEST_LEAVE` |
| 桥 | 无新 SID | 11:36:17.542 could not handle new participant |  |  | 发生在 G2 删除之后、G3 设备 11:36:18.492 starting 之前 |
| G3 | `RM_zYXPHLbKQw9W` / `AJ_cMdP7R2ERBQ2` | `CLIENT_REQUEST_LEAVE` | 22.390 秒 | `TR_AMhMSNUZq5Fcte` / `TR_AMAVWFUXoP6uKe` | 8 条 close_called（5 条早于第一条 closing 行）。DeleteRoom 200 在 11:36:43.402 |

三代 `JT_ROOM` 都派到 `AW_H5bWQUJqErSo`。每代另有 `JT_PUBLISHER` 与 `JT_PARTICIPANT` 未派工，当时三代仍有 agent active。G2 的 dtls_timeout 落在服务端删房当时，不作为更早的初始握手失败。G3 的 SFU 图和下午那些 ≥15 秒单 SID 会话同类；Android 原文里的 begin_timeout / 零播放是另一层，SFU 重读没有把它消掉。

和下午 038 的差别，在 SFU 上就是：上午同一房名 3 个 SID，G2 由服务端 DeleteRoom 断开仍在房内的设备；下午 19 个 038 房各 1 个 SID，设备关闭原因都是客户端离开，workerID 仍是同一个倾听注册。

## 7. 两个已知变更在 SFU 上的位置

12:23:32 Brain LLM provider 修复早于整个 14:00 窗。本层没有第二段「修复前」的下午对照，不能把 17:43 的图从这次 Brain 变更里拆出来。038 的派单目标是倾听 agent；这个 agent 的 LLM URL 不在 SFU 日志里。

15:34:55 主池更新与 `rust-worker` 注册 ID 从 `AW_bMcDSuaqigpU` 换成 `AW_JNDVANh7ZpeR` 的时间相邻（上一房 15:30:49，下一房 15:35:48）。倾听注册 ID 没有换。038 下午的单 SID 图走的是没换注册的倾听 worker，不能记到 991ee2a3 头上。rust-worker 换注册之后仍有大量 <15 秒甚至 duration 0 的单 SID 会话，也有两条 ≥15 秒会话；SFU 没有看到换注册前后出现或消失 negotiation failed。

## 8. 边界

SFU 能支持的判断：房级派单发生了；下午真实房没有同名多代；没有把设备以服务端删房原因踢下线；双方音频轨在多数会话里发布了；选中的是 UDP；Android/Rust SDK 版本块与上午相同；SFU 进程未重启。

SFU 不能支持的判断：用户听到了声音；versionCode ≥367；Android 就绪去重已消失；Worker 写出了非零 TTS；12:23 的 provider 修复已经或尚未作用于倾听池；991ee2a3 改变了 038 的媒体结果。搜索/倾听业务是否仍在这些 038 房里跑，只能看到 agent 名 `p003-search-listening-20261030`，不能从 SFU 改写成「普通聊天已离开倾听池」，也不能把上午无声归到这个 agent 名本身——同一个 agent 注册下午给出了单 SID 客户端离开图。

## 9. 证据文件

目录：`/Users/fu-121/.local/state/p003-voice-incident-20261106/version-comparison-20261106/sfu/`

- `rooms.json`：下午分组与 B 重读。真实代次以有 roomID 的对象为准。
- `machine.json`：主机、路径、计数。
- `path-sfu-extra.stdout` 与 `path-sfu-extra.transport.json`：既有 `sfu-extra.py` 的只读执行。
- `remote_collect.py`：经 stdin 跑在 SFU 上的只读汇总，未在服务器保存。
- `SHA256SUMS.txt`：上述产物摘要。

署名：本会话 SFU 只读。生产与业务仓库未改。
