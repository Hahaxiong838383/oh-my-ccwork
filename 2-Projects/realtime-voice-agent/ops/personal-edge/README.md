# 小可个人语音北京接入层

北京 ECS `i-2zeg6on7idgp8zggi1jv`（`cn-beijing`，`60.205.5.246`）运行独立 LiveKit 1.13.11、设备签票服务和 HTTPS 网关。运行文件在 `/opt/personal-edge`。设备 SQLite 由 `personal-edge-ticket.service` 管理，路径为 `/var/lib/personal-edge-ticket/devices.sqlite3`。签票和飞牛 worker 使用不同的 LiveKit API key。ECS 的旧 Nginx 继续管理 80/443。

| 入口 | 用途 |
| --- | --- |
| `https://60.205.5.246:18784` | 浏览器使用端、同源签票、健康检查 |
| `wss://60.205.5.246:18784` | LiveKit 信令和 worker 注册 |
| `60.205.5.246:18782` TCP/UDP | WebRTC 媒体，优先 UDP，ICE/TCP 回退 |
| `60.205.5.246:18785` UDP | LiveKit 签发临时凭据的 TURN/UDP 回退 |
| `127.0.0.1:18780`、`127.0.0.1:18781` | LiveKit 和签票本机上游 |

试点 HTTPS 使用本任务独立 CA。首部手机的设备凭据和公开 CA 文件 `ca.crt` 在 Vaultwarden 的「小可个人语音 · phone-01 设备凭据」。客户端先核对 CA 的 SHA256 指纹，再按系统或浏览器的证书信任流程导入。指纹为 `46:B1:CE:BE:98:F0:E4:0F:5A:A9:79:7B:9C:09:F9:CD:21:80:2E:2B:B7:E0:CC:A6:09:77:3C:0E:51:D4:F1:65`。公网默认信任入口仍需一个可在北京 ECS 正常访问的备案域名和该实例的独立受信证书。现有 `bridge.hahaxiong.cc:443` 和候选域名 `xiaoke-voice.hahaxiong.cc:443` 从公网握手被重置。词途的 ECS 回环 HTTPS 首页正常。当前支持 ICE/TCP 和 TURN/UDP 回退。仅允许 HTTPS 443 出站的网络需要另配 TURN/TLS 443。

## 使用端接线

将使用端的静态构建放到 ECS `/opt/personal-edge/public/`，让页面与签票接口使用同一个 HTTPS origin。正式换域名时，同时更新证书、签票 service 的 `PERSONAL_EDGE_PUBLIC_URL`、飞牛 `LIVEKIT_URL` 及客户端入口；该变量取浏览器可访问的 `wss://` origin，签票服务据此校验 HTTPS Origin。

在用户点开始时发送空请求体。房间由服务端生成，设备凭据只从请求头发送。签票请求的返回格式为 `{url, token, room}`，前端用 `room` 关联本通状态。JWT 的 `exp` 为签发后 120 秒，LiveKit 验证允许额外 60 秒时钟偏差。前端收到票后立即入房。票只授予指定房间的麦克风、订阅及同房数据消息权限。

```js
import { Room, RoomEvent } from 'livekit-client';

const response = await fetch('/api/voice/ticket', {
  method: 'POST',
  cache: 'no-store',
  headers: { Authorization: `Bearer ${deviceCredential}` },
});
if (!response.ok) throw new Error(`Ticket request returned ${response.status}`);
const { url, token, room: roomId } = await response.json();

const room = new Room();
room.on(RoomEvent.TrackSubscribed, track => {
  if (track.kind === 'audio') document.body.appendChild(track.attach());
});
room.on(RoomEvent.TrackUnsubscribed, track => {
  for (const element of track.detach()) element.remove();
});
await room.connect(url, token);
await room.localParticipant.setMicrophoneEnabled(true);
```

`401` 表示设备凭据无效或已撤销，`429` 按 `Retry-After` 重试。每次新的开始动作申请新票。让 SDK 在同一会话中处理重连。入房后等待 `personal-xiaoke` agent 参与者或其音轨，超过 15 秒显示助手暂不可用，并调用 `room.disconnect()`。手动结束也调用该方法。签票成功代表设备获准入房，助手就绪以真实参与者或音轨为准。设备凭据由使用者导入，勿进入前端构建、URL 或遥测。调试时只记录房间 ID 和 HTTP 状态。

## 飞牛 worker

飞牛 2 上的文件归 worker 运行账号 `hahaxiong83`，目录权限 `0700`，文件权限 `0600`。

- `/vol1/1000/docker/personal-voice-runtime/private/livekit.env` 可通过容器 `env_file` 注入 `LIVEKIT_URL`、`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET`。
- `/vol1/1000/docker/personal-voice-runtime/private/edge-ca-bundle.crt` 含系统 CA 和试点 CA。将其只读挂入容器并用 `SSL_CERT_FILE` 指向容器内路径，保留 ASR、TTS 等供应商的公共证书信任。
- Rust worker 的 `AGENT_NAME=personal-xiaoke`。签票的 dispatch metadata 含注册表给出的 `owner_id` 与 `device_id`，房间格式为 `pv-<32 位十六进制>`。个人大脑按此可信映射找主人。

## 设备及发布运维

`bash issue-device.sh owner <设备ID>` 的输出仅用于管道交给授权的凭据存储。每个 owner/device 可保持一条有效凭据，ECS 数据库只保存摘要。主人或设备 ID 使用小写英数字和连字符，最长 32 位。通过 ECS 运行 `cd /opt/personal-edge && python3 -B ticket.py list` 查看状态，用 `python3 -B ticket.py revoke owner <设备ID>` 停发该设备的新票。撤销后可给原 ID 发新凭据。已签发 JWT 会自然到期，已在房里的设备若需要立即踢出须另外关闭该活动房间。

`bash deploy.sh` 通过已验证的阿里云 CLI profile `cc-remote` 把源码送到这一台 ECS。LiveKit 官方压缩包校验 GitHub 发布 SHA256 后安装到独立目录。北京 ECS 直拉吞吐低时，先 `bash deploy.sh --pki-only`，可用 `upload-release.py` 在服务未启动时接收同一官方压缩包，接收器只接受固定体积、固定 SHA256 的发布包，并在成功后退出。修改已运行的配置时按变更范围重启对应的 `personal-edge-*.service`。可用 `systemctl disable --now personal-edge-{gateway,ticket,livekit}.service` 停掉试点。若收回监听，再删除本任务的 UFW `18784/tcp`、`18782/tcp`、`18782/udp` 和 `18785/udp` 规则。保留设备表和私密配置可恢复原试点。

## TURN/UDP 与回退

浏览器经 WSS 入房时取得 TURN 临时凭据。TURN 对外接收 UDP `18785`，同机中继端口池为 `18850–18977/udp`，无需在 UFW 放行该端口池。LiveKit 同时发布公网和内网 ICE 候选，内网例外仅允许本实例的 SFU 地址 `172.17.37.109/32`。实例内网地址变化时需同步更新这条规则。端口池可容纳 128 个分配，样本中的两位 Chromium 参与者共收集了 16 个 relay 候选。并发通话容量需另测。

完整回退文件为 ECS 上的 `/opt/personal-edge/private/livekit.before-turn.20261125T044729Z.yaml`，SHA256 为 `0851627fb9b341205f9e45b56dd9c037dc175f247141cd331e8246e9ced6941d`。回退前通过本机 LiveKit `RoomService/ListRooms` 核实房间数为 0，再在该 ECS 执行以下步骤。

```bash
cd /opt/personal-edge
printf '%s  %s\n' 0851627fb9b341205f9e45b56dd9c037dc175f247141cd331e8246e9ced6941d \
    private/livekit.before-turn.20261125T044729Z.yaml | sha256sum -c - &&
install -m 0644 private/livekit.before-turn.20261125T044729Z.yaml livekit.yaml.rollback &&
mv -f livekit.yaml.rollback livekit.yaml &&
systemctl restart personal-edge-livekit.service &&
curl -fsS --retry 3 --retry-connrefused http://127.0.0.1:18780/ >/dev/null &&
ufw --force delete allow 18785/udp
```

回退后回读配置摘要，核实 `18782` TCP/UDP 恢复且 `18785/udp` 已停止监听。恢复上一版后，后续全量部署应使用对应的基线配置。

### 强制 relay 双向音频 · 2026-11-25

- 北京 `personal-edge-livekit.service` 于 12:49:44 CST 启动，重启前两次检查均为 0 个房间。实机 `livekit.yaml` SHA256 为 `b8a08b2781d662465c50655508a5ac0a8f9f012e5ae62e7e262f2482f95e4ec9`。公网匿名 TURN Allocate 得到 `401`，回复没有中继地址。
- 家庭宽带上的两位 Chromium `152.0.7977.8` 参与者加入独立房 `turn-relay-5403ebca9915970600f14a2f`，各自设置 `iceTransportPolicy: relay`，房间没有附带 worker 派单。每端发送 126 个音频 RTP 包、收到 125 个，入站音频能量大于 0。A 发 440 Hz，B 的频谱峰为 445 Hz。B 发 880 Hz，A 的频谱峰为 891 Hz。峰值偏差来自频谱分辨率。
- 四条媒体连接选中的候选均记录 `relayProtocol: udp`、TURN URL `turn:60.205.5.246:18785?transport=udp` 和 SFU 内网目标 `172.17.37.109:18782`。Chromium 把同机 NAT 路径选中的候选标为 `prflx`，其端口 `18891`、`18922`、`18899`、`18897` 分别与同一连接收集到的公网 `relay` 候选匹配。
- 本轮覆盖家庭宽带的强制 TURN/UDP。移动网络、前端自动降级、只允许 443 的出站网络及个人 worker 业务通话需独立验收。

## 验收 · 2026-11-25

- Chromium 通过 HTTPS 同源签票后入房。默认 UDP 房 `pv-d3b829b07da18d8101c93f0fbec82f3d`，Chromium 检出 14 个入站音包和 30 个出站音包，有非零入站音频能量。过滤 UDP 候选后，TCP 房 `pv-13a36c3764aa441b90514187a0d8f962` 检出 14 个入站音包和 24 个出站音包，有非零入站音频能量。飞牛探针通过 WSS 注册为 `personal-xiaoke`，收到这两个房间的 dispatch，分别解码至少 10 帧非零设备音频并回传测试音。
- 同一主人两台设备及另一主人同名设备取得三个不同房间和三组可信身份。匿名/未知设备返回 401，伪造请求体返回 400，非同源返回 403，过频返回 429。LiveKit 接受新 JWT，拒绝篡改房间声明的票，并在 60 秒容差耗尽后拒绝同一原票。撤销一台设备后该设备返回 401，同主人另一设备仍返回 200。
- 北京三项 systemd 服务均为 active/enabled，飞牛用试点 CA 验证远端 HTTPS。实机 LiveKit 二进制 SHA256 为 `85a58024d9b36542712514e0e926c0adb74f6182bcb19a664b9d9eb98ad01b52`，签票源码为 `4853ff065261b884e54dda29f259a6184cb5c3979c3aa4088dc6cfae9ef1e55b`，网关配置为 `fb9505379a62c7257ad8be1ee59e3f0f1054240efdd7933263dd025f4c1c98f8`。发布基线为 `090268900bed3642d6c141d7b0f62ef25667571f` 加此独占目录的工作树文件。
- 媒体验收用临时探针。个人 Rust worker 的业务通话、手机移动网络和应用层字幕、打断、工具另按产品架构验收。
