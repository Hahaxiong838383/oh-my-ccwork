# 美宅及中转 VPS 代理网络搭建指南V1

> 美国住宅IP + CN2 GIA中转 + 备用直连节点，用于 ChatGPT / TikTok 等海外服务访问。

## 架构总览

```
主线路（日常用）：
设备 → 中转机(CN2 GIA优化线路) → 落地机(美国住宅IP) → 互联网

备用线路（应急/多IP切换）：
设备 → 备用机(直连) → 互联网
```

## 服务器角色

| 角色 | 商家推荐 | 线路 | 参考价格 | 用途 |
|------|---------|------|---------|------|
| **中转机** | DMIT LAX Pro/EB | CN2 GIA / CMIN2 | $6.9-14.9/月 | 回国线路优化，负责速度 |
| **落地机** | 丽萨主机 / 类似住宅IP商家 | AS4837 等 | ¥55/月起 | 提供纯净住宅IP出口 |
| **备用机** | RackNerd / 任意廉价VPS | 普通国际线路 | 按需 | 备用/多IP切换 |

## 部署步骤

### Step 1：落地机部署 Xray (VLESS+Reality)

```bash
# 安装 Xray
curl -sL https://github.com/XTLS/Xray-install/raw/main/install-release.sh | bash

# 生成密钥对和 UUID
xray x25519      # 生成 Reality 公私钥
xray uuid        # 生成用户 UUID
openssl rand -hex 8  # 生成 shortId
```

配置文件 `/usr/local/etc/xray/config.json`：

```json
{
  "log": { "loglevel": "warning" },
  "inbounds": [{
    "listen": "0.0.0.0",
    "port": 8443,
    "protocol": "vless",
    "settings": {
      "clients": [{ "id": "<YOUR_UUID>", "flow": "xtls-rprx-vision" }],
      "decryption": "none"
    },
    "streamSettings": {
      "network": "tcp",
      "security": "reality",
      "realitySettings": {
        "dest": "www.microsoft.com:443",
        "serverNames": ["www.microsoft.com", "microsoft.com"],
        "privateKey": "<YOUR_PRIVATE_KEY>",
        "shortIds": ["<YOUR_SHORT_ID>"]
      }
    },
    "sniffing": { "enabled": true, "destOverride": ["http", "tls", "quic"] }
  }],
  "outbounds": [
    { "protocol": "freedom", "tag": "direct" },
    { "protocol": "blackhole", "tag": "block" }
  ]
}
```

```bash
# 启动
systemctl restart xray
systemctl enable xray
# 验证
systemctl is-active xray && ss -tlnp | grep 8443
```

### Step 2：中转机部署 gost 转发

```bash
# 安装 gost v3
cd /tmp
curl -sLO https://github.com/go-gost/gost/releases/download/v3.0.0-rc10/gost_3.0.0-rc10_linux_amd64.tar.gz
tar xzf gost_3.0.0-rc10_linux_amd64.tar.gz
mv gost /usr/local/bin/gost && chmod +x /usr/local/bin/gost
```

创建 systemd 服务 `/etc/systemd/system/gost.service`：

```ini
[Unit]
Description=gost relay
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/gost -L tcp://:8443/<落地机IP>:8443
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable gost
systemctl start gost
# 验证
systemctl is-active gost && ss -tlnp | grep 8443
```

### Step 3：客户端连接

客户端填写中转机地址（不是落地机）：

| 参数 | 值 |
|------|-----|
| 协议 | VLESS |
| 地址 | `<中转机IP>` |
| 端口 | 8443 |
| UUID | `<你生成的UUID>` |
| 加密 | none |
| 流控 | xtls-rprx-vision |
| 安全 | Reality |
| SNI | www.microsoft.com |
| PublicKey | `<你生成的公钥>` |
| ShortId | `<你生成的shortId>` |
| Fingerprint | chrome |

分享链接格式：
```
vless://<UUID>@<中转机IP>:8443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=<PublicKey>&sid=<ShortId>&type=tcp#节点名称
```

支持的客户端：

| 平台 | 推荐 |
|------|------|
| iOS | Shadowrocket / Streisand |
| Android | v2rayNG / NekoBox |
| Windows | v2rayN / Clash Verge |
| macOS | Clash Verge / V2RayXS |

### Step 4（可选）：备用节点

在备用机上安装 3X-UI 面板，通过 Web 界面管理节点：

```bash
bash <(curl -Ls https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh)
```

## 运维手册

### 日常检查

```bash
# 中转机：检查 gost
ssh root@<中转机> "systemctl is-active gost && ss -tlnp | grep 8443"

# 落地机：检查 Xray
ssh root@<落地机> "systemctl is-active xray && ss -tlnp | grep 8443"
```

### 故障排查

| 现象 | 排查 | 处理 |
|------|------|------|
| 主节点连不上 | 检查 gost 是否运行 | `systemctl restart gost` |
| gost 正常但连不上 | 检查落地机 Xray | `systemctl restart xray` |
| 备用节点连不上 | 登录 3X-UI 面板查看 | 面板内重启 Xray |
| 所有节点都不通 | 本地网络问题 | 换网络/重启路由器 |

## 选型经验总结

### 回国线路对比

| 线路 | 归属 | 电信 | 移动 | 联通 | 价格 |
|------|------|------|------|------|------|
| CN2 GIA | 电信国际 | ★★★★★ | ★★★★ | ★★★★ | 贵 |
| CMIN2 | 移动国际 | ★★★★ | ★★★★★ | ★★★★ | 中 |
| AS9929 | 联通高端 | ★★★ | ★★★ | ★★★★★ | 中 |
| 普通国际 | 各种 | ★★ | ★★ | ★★ | 便宜 |

### DMIT 套餐三档区别

| 套餐 | 线路描述 | 回国优化 | 适合 |
|------|---------|---------|------|
| **Tier 1 (T1)** | 亚美优化，w/o China Optimization | ❌ 无 | 海外用户 |
| **Eyeball (EB)** | Tier 1 + CMIN2 回国优化 | ✅ 有 | 性价比首选 |
| **Premium (Pro)** | Tier 1 + DMIT骨干 + CN2 GIA | ✅✅ 最强 | 追求极致 |

**关键认知**：T1 的 "w/o China Optimization" = 没有回国线路优化，国内用户不适合做中转。

### 中转机选址原则

| 落地机位置 | 中转机推荐 | 理由 |
|-----------|-----------|------|
| 美西（加州等） | 洛杉矶 CN2 GIA | 同城转发，两段都短 |
| 美西（加州等） | 日本东京软银 | 两段都不太长 |
| 美东（纽约等） | 洛杉矶 CN2 GIA | 美国境内中转 |
| 任意位置 | 洛杉矶 CN2 GIA | 万金油选择 |

**核心逻辑**：中转机和落地机在同一城市/国家时，这段延迟几乎为零。香港/东京到美国还要跨太平洋，多绕一圈不如直接从洛杉矶转。

### 住宅IP选型

| 用途 | IP要求 | 说明 |
|------|--------|------|
| TikTok | ⭐ 住宅/家宽/双ISP | 对IP纯净度要求最高 |
| ChatGPT | 原生IP即可 | 要求相对宽松 |
| 流媒体解锁 | 原生/住宅 | 因平台而异 |

**重要**：落地机的回国线路不重要（中转机负责），核心看IP是否为住宅属性、是否被封过。

### 推荐供应商

| 用途 | 商家 | 特点 |
|------|------|------|
| 中转机 | DMIT | CN2 GIA / CMIN2，$6.9/月起 |
| 中转机（备选） | 搬瓦工 | CN2 GIA-E，$49.99/季起 |
| 落地机（住宅IP） | 丽萨主机 | 双ISP家宽，¥55/月起 |
| 落地机（备选） | WePC / MoonVM | 住宅IP VPS |
| 备用/廉价 | RackNerd | 便宜大碗，无回国优化 |

## 技术栈

| 组件 | 技术 | 版本 |
|------|------|------|
| 代理服务端 | Xray | v26.2.6+ |
| 流量转发 | gost | v3.0.0-rc10 |
| 面板管理 | 3X-UI | v2.8.9+ |
| 代理协议 | VLESS + TCP + Reality | — |
| 系统 | Ubuntu 24.04 LTS | — |
| 服务管理 | systemd | — |

## License

本文档为个人实践经验总结，仅供学习参考。
