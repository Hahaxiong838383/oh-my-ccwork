# 家用 Ubuntu（linux-lan）运维 SOP

> 更新：2026-07-20 · 执行引擎 grok  
> 详细可检索事实：Claude A 记忆 `reference_linux_lan_ssh.md` / `user_hardware.md` §6；B `memory-items` 搜 `linux-lan`。

## 机器身份

| 项 | 值 |
|---|---|
| 角色 | 川哥家里 Ubuntu 笔记本，合盖长期在线 |
| 主机名 | `hahaxiong83-FMVU14033` |
| 用户 | `hahaxiong83` |
| 有线 | `enp0s31f6` Intel I219-LM · **固定 IP `192.168.1.119/24`** · 1000Mb/s |
| Wi-Fi 备用 | `wlp2s0` · `192.168.1.41` |
| 网关/DNS | `192.168.1.1` / `192.168.1.1,8.8.8.8` |

**≠ dev198**（公司 HP `chuan@10.9.1.198` / 公网 `:22198`）。

## 连接

```bash
ssh linux-lan          # 家中有线 .119
ssh linux-lan-wifi     # 家中 Wi-Fi .41
ssh linux-lan-pub      # 外网 frp → 8.218.26.17:22119
```

Air 配置真源：`~/.ssh/config`（密钥 `~/.ssh/id_ed25519`，免密）。**密码不入仓、不入记忆。**

## 公网 frp

- 本机：`systemd frpc`（enable）· `/etc/frp/frpc.toml`（600）· log `/var/log/frp/frpc.log`
- 映射：`22119` → `127.0.0.1:22`
- 服务端：阿里云 HK 与 mini/dev198 同 frps（`8.218.26.17:7000`）
- 云安全组：TCP 22119 已放行；HK iptables 轻量限速

排障：

```bash
ssh linux-lan 'systemctl status frpc; tail -40 /var/log/frp/frpc.log'
```

## 合盖不休眠

- `/etc/systemd/logind.conf.d/99-lid-ignore.conf`：`HandleLidSwitch*=ignore`
- GNOME：`lid-close-*-action=nothing`，`sleep-inactive-*-type=nothing`
- 建议接电长期运行

## 有线静态 IP / 千兆

- netplan：`/etc/netplan/00-installer-config.yaml`（`dhcp4: false` + addresses `.119/24`）
- 曾踩坑：安装器未开 DHCP → link-local，流量走 Wi-Fi；物理链路本身已是 1G
- 备份：`/etc/netplan.bak.*`

## 工具脚本

- 新机一键开 sshd：`4-Assets/scripts/enable-ssh-server.sh`（U 盘拷贝执行）

## 安全

- 公网端口有扫描面；依赖密钥登录 + 连接频率限制
- frp token 仅存本机/HK frp 配置文件，**禁止写入 git 与 memory 正文**
