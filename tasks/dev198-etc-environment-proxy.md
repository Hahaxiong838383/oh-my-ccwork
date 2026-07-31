# 待办 · dev198 `/etc/environment` 里的死代理（需 root，cc 做不了）

> 状态：**挂起**（2026-07-31，cc 无免密 sudo；川哥当时够不到 dev198 终端）
> 发现路径：Mini 换 IP → dev198 上 9 个 Bot 全部拿不到 tenant_access_token，故障 12 分钟

## 问题

`/etc/environment`（root 拥有，626 字节，mtime 2026-07-17）里写着：

```
# mini xray proxy (dev198 via mini LAN) — managed 2026-07-17
http_proxy=http://10.9.1.57:10808
https_proxy=http://10.9.1.57:10808
HTTP_PROXY=http://10.9.1.57:10808
HTTPS_PROXY=http://10.9.1.57:10808
ALL_PROXY=socks5h://10.9.1.57:10808
all_proxy=socks5h://10.9.1.57:10808
NO_PROXY=…（这两行不用动）
no_proxy=…
```

`10.9.1.57` 是 **Mini 的旧 DHCP 地址**。2026-07-31 11:20 Mini 改成手动 IP `10.9.1.54`
之后，这个代理目标人间蒸发 —— 而 xAI **只能走代理**（直连超时），飞书 token 刷新
也走代理，于是 dev198 上 9 个 Bot 全线不可用。

`/etc/pam.d/sshd` 的 `pam_env.so` 在 session 建立时读这个文件，早于任何 shell rc，
所以它对整机每个登录会话生效。

## 已经做掉的（不需要 root）

| 路径 | 措施 | 验证 |
|---|---|---|
| 两个 Bot 服务 | `~/.config/systemd/user/feishu-grok-{bridge,runner-worker}.service.d/10-proxy.conf` 里 `Environment=` 指向 `127.0.0.1:10808` | **证伪过**：故意把管理器环境设成死地址 `10.9.1.99` 再重启，进程内仍是 `127.0.0.1` |
| `ssh host '命令'` | `~/.bashrc` **顶部**（必须在 Debian 那句 `case $- in *i*) ;; *) return;;` 之前）加条件覆盖 | 实测 `HTTP_PROXY=127.0.0.1:10808`，api.x.ai 421 通 |

**平台已安全**：Bot 服务不再依赖 Mini，自动化操作也走已修好的路。

## 仍然坏的

- **登录/交互 shell** 仍拿到 `10.9.1.57`。⚠️ **cc 没能给出确凿解释** —— `.bashrc`
  的覆盖在这条路上没生效，`env -u HTTP_PROXY` 清掉后再起登录 shell 仍是旧值，
  说明还有一处未定位的注入点。影响面仅限「人在 dev198 上手敲命令」。
- `/etc/environment` 本体未动。

## 修法（需要 root，川哥自己跑）

```bash
sudo cp /etc/environment /etc/environment.bak-20260731 \
  && sudo sed -i 's#10\.9\.1\.57:10808#127.0.0.1:10808#g' /etc/environment \
  && grep -i proxy /etc/environment
```

改完 6 行 proxy 变 `127.0.0.1:10808`，`NO_PROXY` 两行不动。**不用重启服务**
（Bot 服务有 drop-in 兜底，本来就不受它影响）。

回滚：`sudo cp /etc/environment.bak-20260731 /etc/environment`

顺带把那行过期注释也改了：`# local xray proxy (dev198 self-hosted) — 2026-07-31 起改指本地，去掉跨机依赖`

## 为什么值得修

不修的话，dev198 上**除了那两个 Bot 服务之外**的一切（手敲命令、将来新加的服务、
别人写的 cron）都会走一个死地址，而且症状是**静默超时**不是明确报错 ——
这次就是靠翻 axios 错误栈才定位到的。

## 根子上的教训

`/etc/environment` 那行注释 `mini xray proxy (dev198 via mini LAN)` 是 2026-07-17
写的 —— **一条写在系统级配置里的跨机 IP 依赖，且用的是 DHCP 地址**。
两台机器的网络自此绑死，对方一动 IP 这边就塌，而且塌在一个没人会想到去看的地方。

相关：[[feedback_migration_env_reconciliation]]、[[feedback_connectivity_diagnosis_layered]]
