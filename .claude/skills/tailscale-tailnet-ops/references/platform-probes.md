# 跨平台取数命令（Tailscale 连通性排查）

同一套判据要在不同平台取数，踩的坑不一样。下面按平台给可直接粘的命令，全部只读。

## macOS（客户端是 App 版）

```bash
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
$TS version | head -1
$TS netcheck 2>&1 | head -22          # UDP / IPv4 / MappingVariesByDestIP / PortMapping / 各区域延迟
$TS status --json | head -c 300        # Self.Relay；peer 的 Relay 与 CurAddr
```

- **CLI 常不在 PATH**：App 装在 `/Applications/Tailscale.app` 时 `tailscale` 命令找不到，用上面的 `command -v … || echo <App 路径>` 兜底，别断言“没装”。`sudo` 场景下同理。
- **没有 `timeout` 命令**：用 `timeout 20 ssh …` 会得到 `zsh: command not found: timeout`。远端调用改用 `ssh -o ConnectTimeout=N`；要限制整段命令时间就自己计数或用 `perl -e 'alarm'`，不要套 GNU coreutils 的 `timeout`。
- **系统代理与 VPN**：
  ```bash
  scutil --proxy | grep -E 'HTTPEnable|HTTPSEnable|SOCKSEnable|ProxyAutoConfigEnable'
  scutil --nc list | grep -i tailscale      # Tailscale 自己也是一个 VPN 服务条目
  scutil --dns | grep nameserver | head -3  # tailnet DNS 会是 100.100.100.100
  route -n get default | grep -E 'gateway|interface'
  ```
- **测真实链路必须绕过系统代理**：
  ```bash
  curl --noproxy '*' -s -o /dev/null -m 10 -w 'connect:%{time_connect}s tls:%{time_appconnect}s code:%{http_code}\n' https://<host>:<port>/
  ```
  不加 `--noproxy '*'` 时 `time_connect` 是与本地代理建连的耗时（0.000x 秒），会把“完全不可达”误读成“极快”。
- 网络接口枚举用 `networksetup -listallhardwareports`；Wi-Fi 还是有线看 `route -n get default` 的 interface 与硬件端口对应关系。

## Linux

```bash
tailscale netcheck 2>&1 | head -20
ss -tlnp | grep :22        # 对端 sshd 是否在听、是否被别的进程占
nc -zv <host> 22           # 区分“链路不通”与“缺授权”
journalctl -u tailscaled --since '30 min ago' | grep -iE 'disco|new contact' | tail
```

`journalctl -u tailscaled` 里的 `ping(...): sending disco ping` 与 `magicsock: new contact … via=direct` 能证明打洞是否在推进，比只看 `tailscale ping` 的时间切片更有说服力。

## 多出口判定（两端都在内网时最容易被忽略的一步）

1. 两台机器各自 `netcheck`，记下 `IPv4: yes, <公网IP>:<port>` 那一行。
2. **同一内网网段、不同公网 IP ⇒ 多线出口/策略路由**（不是“它们同网所以 NAT 一样”）。这种环境下打洞要跨多条 egress 猜地址，冷态窗口天然更长。
3. 再各自取内网地址与默认网关（`route -n get default` / `ip route get 1.1.1.1`）确认是否真在同一网段；同网段同网关却 egress 不同，就是出口分流的直接证据。

## 判据落点

- 对称 NAT（`MappingVariesByDestIP: true`）+ `PortMapping` 为空 ⇒ 该侧不能指望入站映射，只能靠对端固定端口打洞或中继。
- 对端 NAT 类型只在**对端本机**取，别从本机推。
- 想评估“自建 DERP 快不快”，在**受影响的那个客户端**上对自建 derper 与官方各区域分别做 `curl --noproxy '*'` 的 `time_connect`/`time_appconnect` 对照，别用本机数据代替。
