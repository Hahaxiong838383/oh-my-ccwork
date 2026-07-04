# 公网访问链路(回家/外网访问 voice)

> 2026-06-30。`voice.hahaxiong.top` 原是纯内网服务(DNS→dev198 内网 IP),回家/外网不可达。
> 本文档记录把内网 LiveKit(自建 cascade)暴露公网的**完整链路 + WebRTC 媒体通道配置**,可复现。

## 链路总览

```
用户(手机5G / 外网)
  ├─ 信令 wss(443)  ─→ DNS灰云直连 ─→ 阿里云HK 8.218.26.17 nginx ─→ frp(17443) ─→ dev198 nginx:443 ─→ livekit:7880
  └─ 媒体 ICE        ─→ 阿里云HK 8.218.26.17 :7881/:7882 ─→ frps ─→ frp隧道 ─→ dev198 livekit:7881(TCP)/:7882(UDP)
```

**关键:WebRTC 的信令和媒体是两条独立通道,两条都要通。** 只通信令(443)→ 手机握手成功但报 `could not establish pc connection`(媒体 ICE 建不起来)。

## 配置清单(五处)

### 1. DNS —— 灰云直连,不走 Cloudflare 橙云
- `voice.hahaxiong.top` A 记录 → `8.218.26.17`(阿里云公网 IP,**不是**内网 IP)
- **灰云(DNS only)**。橙云(代理)国内 +2.3s 延迟(实测经 CF 2.47s vs 直连 0.29s),实时音频必走灰云。

### 2. 阿里云 HK nginx —— 信令反代
- `/etc/nginx/sites-available/voice-public`:443(**无 http2**)→ `proxy_pass https://127.0.0.1:17443` + WS upgrade map
- **必须去 http2**:nginx 1.24 不支持 h2 over WebSocket(RFC 8441),浏览器协商 h2 → wss 握手 404
- certbot 真证书(灰云直连必须;自签 → 浏览器警告 + wss 拒)

### 3. frp —— dev198 frpc → 阿里云 frps
`/etc/frp/frpc.toml` 三个 proxy(serverAddr=8.218.26.17:7000):

| name | type | localPort | remotePort | 用途 |
|---|---|---|---|---|
| dev198-voice | tcp | 443 | 17443 | 信令 |
| dev198-livekit-tcp | tcp | 7881 | 7881 | 媒体 TCP |
| dev198-livekit-udp | udp | 7882 | 7882 | 媒体 UDP |

> ⚠️ 媒体端口 `remotePort` 必须 = `localPort` = LiveKit 的 tcp_port/udp_port,因为 LiveKit 广播 `node_ip:tcp_port`,客户端按这个端口连,frp 端口对不上就连不到。

### 4. LiveKit —— dev198 `/etc/livekit/config.yaml`
```yaml
port: 7880
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: false
  node_ip: 8.218.26.17   # ← 广播阿里云公网IP;不设则广播内网IP,外网客户端连不到媒体
keys:
  voicekey: <见 dev198 实机,不入 git>
```

### 5. 阿里云安全组 `sg-j6chwi69v5k6i3pxsfzg` —— 入方向放行媒体端口
- TCP `7881/7881` ← `0.0.0.0/0`
- UDP `7882/7882` ← `0.0.0.0/0`  **(WebRTC 主媒体走 UDP,这条必放行)**

```bash
# 用本机 aliyun-cli cc-remote profile(HK 区)加规则:
aliyun ecs AuthorizeSecurityGroup --profile cc-remote --RegionId cn-hongkong \
  --SecurityGroupId sg-j6chwi69v5k6i3pxsfzg \
  --IpProtocol tcp --PortRange 7881/7881 --SourceCidrIp 0.0.0.0/0 --Description "LiveKit RTC TCP"
aliyun ecs AuthorizeSecurityGroup --profile cc-remote --RegionId cn-hongkong \
  --SecurityGroupId sg-j6chwi69v5k6i3pxsfzg \
  --IpProtocol udp --PortRange 7882/7882 --SourceCidrIp 0.0.0.0/0 --Description "LiveKit RTC UDP"
```

## 验证

```bash
# ① 信令 + 端口可达
curl -sI --noproxy '*' https://voice.hahaxiong.top/voice-test.html   # 期望 200
nc -zv  8.218.26.17 7881   # TCP succeeded
nc -zuv 8.218.26.17 7882   # UDP succeeded

# ② WebRTC 媒体 E2E(从公网模拟手机5G,0% 丢包 = 媒体通道真通)
NO_PROXY="*" LIVEKIT_URL="wss://voice.hahaxiong.top" \
  LIVEKIT_API_KEY="voicekey" LIVEKIT_API_SECRET="<见 dev198 config.yaml>" \
  lk load-test --room e2e-test --audio-publishers 1 --subscribers 1 --duration 12s
# 期望:Finished connecting to room + Track 0% 丢包
```

测试页:**https://voice.hahaxiong.top/voice-test.html**

## 坑

- **重启 frpc 会断经 frp 的 ssh 隧道**:`ssh dev198` 实际走 `8.218.26.17:22198`→frp。改完配置**只重启 livekit-server,不碰 frpc**(frpc systemd 会自愈隧道)。
- `/etc/livekit/` 目录 root owner → config.yaml 即便 chuan owner,`sed -i` 建临时文件也需目录写权,改用 `sudo sed -i`。
- **harness 安全门控**:cc 自动改安全组开公网端口 / 自己加 settings allow 规则都会被拦(Security Weaken / Self-Modification),需用户亲自跑命令或控制台放行。

## ⚠️ 待优化:node_ip 副作用

`node_ip` 让 LiveKit 只对外广播公网 IP,**dev198 本地的 worker(agent)连 SFU 媒体时可能也绕阿里云一圈**(本来同机 <1ms),给 agent 媒体加几十 ms 延迟。修法:双 candidate 策略(本地 worker 走内网 host + 外网手机走公网 node_ip),待验证 worker 实际媒体路径后实施。与延迟优化任务相关。

---

## HK ECS 直接公网部署(2026-06-30,另一套方案,无需 frp)

dev198 在公司内网必须 frp 中转;若 LiveKit 直接跑在**有公网 IP 的云主机**(如阿里云 HK ECS `47.239.204.68`),架构更简单——**不需要 frp**:

```
用户 → DNS → HK ECS nginx:443(wss) → livekit:7880(信令) + 直连媒体 7881/7882
```

- **DNS**:`voice-hk.hahaxiong.cc` A 记录 → 公网IP。`aliyun alidns AddDomainRecord --profile <p> --DomainName hahaxiong.cc --RR voice-hk --Type A --Value <IP>`。hahaxiong.cc 权威 NS 在阿里云(`dns7/dns8.hichina.com`),阿里云 DNS 改即全网生效(4 个公共 resolver 实测都解析对)。
- **nginx + certbot**:`certbot --nginx -d voice-hk.hahaxiong.cc`(80 HTTP-01 challenge,自动配 443 SSL + 80→443 redirect)。
- **LiveKit config**:`node_ip: <公网IP>`(直接广播公网 IP,不经 frp)。
- **安全组**:放行 80/443/7881tcp/7882udp。
- 验证:`lk load-test` 公网连 wss + 0% 丢包。
- 部署态:systemd(livekit-server + voice-worker),aliyun profile 独立。

## 移动网络(5G)韧性:TURN/TLS + 重连生命周期(2026-07-02)

川哥手机 5G 实测"通话中但无声无指标",server 日志实锤三层根因,全部修复:

1. **5G UDP 媒体断线**(`short ice connection`,建立后十几秒断,greeting/指标数据丢):
   开 LiveKit 内置 TURN(`/etc/livekit/config.yaml`),TLS 流量运营商不歧视:
   ```yaml
   turn:
     enabled: true
     domain: voice-hk.hahaxiong.cc
     cert_file: /etc/letsencrypt/live/voice-hk.hahaxiong.cc/fullchain.pem
     key_file: /etc/letsencrypt/live/voice-hk.hahaxiong.cc/privkey.pem
     tls_port: 5349
     udp_port: 3478
   room:
     empty_timeout: 20   # 空房 20s 销毁(默认 300s,见下)
   ```
   **安全组需放行 5349/tcp + 3478/udp**(harness 拦 cc 自动改,川哥手动)。
2. **重连进"无 agent 死房"**:agent dispatch 只在 room **创建时**发生;默认
   `close_on_disconnect=True`(用户断开 agent 立即关)+ 空房存活 300s → 断开后短时间
   重连=旧房无 agent,彻底无反应。修:`close_on_disconnect=False`(agent 留守 45s,
   重连/5G resume 对话续上)+ `delete_room_on_close=True`(真退出时删房,下次必新房
   必重新 dispatch)+ idle watchdog(`IDLE_SHUTDOWN_SECONDS` 默认 45)。
3. **job 收尾卡死**:`entrypoint did not exit in time`(session.run 永挂)→ job 拖 40s
   强杀。修:`ctx.add_shutdown_callback(engine.aclose)`。另 `load_threshold` 生产默认
   0.7,2 核机 CPU 尖峰即拒接新 job("no worker available"),放宽 0.95(env
   `WORKER_LOAD_THRESHOLD`)。

## 测试页(voice-test.html)部署 checklist(踩坑,血泪)

⚠️ **症状误导坑**:页面能开但"点开始对话**无反应 + 不弹麦克风授权 + 一直未连接**"——**先怀疑前端 SDK 静态资源 404,不是连接层**(三症状是一个前端脚本崩溃的连锁,详见记忆 `frontend_sdk_static_404_misdiagnosed_as_connection`)。

- 测试页引用本地 `<script src="/livekit-client.umd.min.js">`(LiveKit 浏览器 SDK,538KB)——**部署必须连 JS 一起传**,只 scp html 漏 JS → SDK 404 → 点击 handler 抛 `ReferenceError` → 三症状全是这一个连锁。
- nginx **静态资源要专门 location**:`location = /livekit-client.umd.min.js { root /var/www/voice; }`,否则被反代的 `location /` 吞到 livekit(精确 location 优先于前缀 `/`)。确认返回 `application/javascript` MIME。
- token 用 voicekey 签(同 config.yaml `keys`),`room`/`roomConfig.agents[].agentName` 对上 worker(`realtime-voice-agent`)。dev198 与 HK 同 voicekey → token 可跨机复用。
- 诊断:**F12 Console 看红色报错**(`XXX is not defined`/`404`)+ curl 页面每个静态资源查 404,再查连接层。
- 部署后客户端要**清缓存/硬刷新**(`Ctrl+Shift+R`/无痕),否则之前 404 的 JS 被浏览器缓存。
