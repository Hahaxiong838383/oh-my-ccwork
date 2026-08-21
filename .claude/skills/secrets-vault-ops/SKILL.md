---
name: secrets-vault-ops
description: home-studio 凭据库（Vaultwarden 自托管）的取用、运维与排障。**需要任何密钥/token/账号密码时先来这里取，不要问川哥要、不要翻旧对话、更不要让他贴进对话**。触发词："密钥"、"token"、"凭据"、"密码管理"、"vaultwarden"、"取 token"、"GitHub token"、"阿里云 key"、"Cloudflare token"、"密码库"、"vault 锁了"、"解锁密码库"、"读不到密钥"。涵盖：取用姿势（防 argv 泄漏）、锁/解锁、条目命名规范、排障决策树（取不到/读出 null/session 失效/bw 找不到）、部署真值与重建步骤、安全边界。
layer: 基建层
authorization: A区（读取库内条目自由；改容器配置/关开注册/轮换 session 需先说明；主密码永远只有川哥掌握，绝不代输）
output_levels: L1
---

# home-studio 凭据库运维

**2026-08-21 建成。川哥的密钥统一存放处。**

## 铁律

1. **要用某个 token，先来这里取。** 不问川哥要、不翻旧对话、不让他贴进对话——贴进对话就进 transcript 和 recall-log，等于泄漏。
2. **主密码只有川哥知道，我永远不代输、不索要、不猜。**
3. **取到的值绝不打印到终端**（会进我的上下文）、**绝不进 argv**（`/proc/<pid>/cmdline` 世界可读）。只在同一条命令里用变量。

## 真值

| 项 | 值 |
|---|---|
| 网页入口（川哥用） | `https://10.10.10.23:8443`（家内也可 `192.168.1.133:8443`） |
| 实现 | Vaultwarden，docker 容器 `vaultwarden`，`--restart unless-stopped` |
| 镜像 | **`ghcr.io/dani-garcia/vaultwarden`**（docker hub 拉不动，见排障） |
| 数据 | `~/.local/share/vaultwarden/data/db.sqlite3` |
| 证书 | `~/.local/share/vaultwarden/ssl/cert.pem`（自签，SAN 含两 IP，2036 到期） |
| 取用命令 | `vw`（`~/.local/bin/vw`，已封装证书信任 + session 读取） |
| 解锁命令 | `~/.local/bin/vw-login`（**川哥自己跑**） |
| session | `~/.local/share/vaultwarden/.session`（600）——**它就是解密钥匙** |
| 注册 | 已关闭（`SIGNUPS_ALLOWED=false`），仅 1 个账号 |

## 日常取用

同步 → 列名 → 取值：

```bash
vw sync
vw list items | jq -r '.[].name'
vw get password "GitHub token"
```

**用在 API 调用上——走 stdin，不走 argv：**

```bash
TOKEN=$(vw get password "GitHub token")
curl -sS --config - <<CURLCFG
url = "https://api.github.com/user/repos?per_page=100"
header = "Authorization: Bearer $TOKEN"
header = "Accept: application/vnd.github+json"
CURLCFG
```

反例（禁止）：把 token 写进 `-H` 参数。shell 展开后进 argv，本机任何用户一条 `ps` 就抄走。

**给子命令用环境变量**（`/proc/<pid>/environ` 只有同用户和 root 可读，比 argv 强一档）：

```bash
GH_TOKEN=$(vw get password "GitHub token") gh repo list
```

## 排障决策树

### 取不到值 / 报 `Not found`

1. `vw sync` 了吗——川哥刚在网页加的，本地缓存还没有。
2. `vw list items | jq -r '.[].name'` 确认**条目名**（空格、大小写必须完全一致）。
3. 名字对但仍 `Not found` → **条目里那个字段是空的**。判据：`vw get item <id>` 的 `.login.password` 为 `null`，而 **name 能正常解出**（name 在 Bitwarden 里同样是加密的）⇒ 解密链路没问题，是川哥建了条目没填密码栏。让他去网页编辑 → 密码栏 → 保存。

### `status` 是 `locked` / 报未解锁

session 过期或被锁。**只有川哥能解**：

```bash
ssh -t home-studio-mesh '~/.local/bin/vw-login'
```

我这边没有 TTY，密码提示弹不出来，别尝试代跑。

### 报 `bw 未安装`

bw 在 `~/local/node/bin/`，该目录是在 `.bashrc` 的「非交互 return」**之后**才进 PATH 的，而 `ssh host 'cmd'` 读到 return 就停。脚本里必须自己固化：`export PATH="$HOME/local/node/bin:$PATH"`。川哥 `.bashrc` 头部有他自己写的同主题注释，排查前先看那里。

### 容器没了 / 要重建

```bash
sg docker -c 'docker ps -a --filter name=vaultwarden'
```

数据在挂载卷里，`docker rm -f` 重建不丢。

### 镜像拉不动

`registry-1.docker.io` DNS 被污染成假 IPv4 + 不通的 IPv6，daemon 直连 000。

⚠️ **别用 curl 测完就下结论**——shell 有 xray 代理而 systemd 管的 daemon **不继承**，curl 得 401 是走了代理。用 `curl --noproxy '*'` 才是 daemon 的真实处境。`ghcr.io` DNS 干净且只有 IPv4，直接能拉。

### docker 权限拒绝

`usermod -aG docker` 只对新登录生效，跑着的 session 不认。不用重启，`sg docker -c '...'` 当场可用（用户已在 `/etc/group` 里就不需要密码）。

## 条目命名规范

川哥在网页上建条目，名字要**简单、稳定、可预测**，我按名字找：`GitHub token`、`aliyun-key-id`、`aliyun-key-secret`、`cloudflare-token`。

名字变了我就找不到——找不到时先 `vw list items` 看实际名字，别猜。

## 安全边界（别说得比这更乐观）

- Bitwarden 端到端加密，**服务端也解不开**。我能自动读，前提是 `.session` 常驻磁盘，**在川哥锁上之前，任何能读该文件的进程都能解开整个库**。这是他知情选择的代价。
- `bw delete item` 是**软删**（进回收站，数据库行还在），彻底删要 `--permanent`。
- **主密码忘了无法找回，这台机器无 TPM 兜底。** `db.sqlite3` 需单独备份。
- 凡是会输出凭据的命令（login / token create / unlock），预先把 stdout 重定向掉——`bw login` 会把完整 session key 打在屏幕上，川哥复制终端输出汇报时连带泄漏（2026-08-21 实际发生过一次，已用 `--raw > /dev/null` 堵掉）。

## 相关

记忆 [[project_home_studio_vaultwarden]]（真值锚）、[[feedback_tool_prints_secret_to_terminal]]、[[feedback_secret_on_argv_is_world_readable]]、[[feedback_verified_in_my_convenient_shape]]。
