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

### 报 `More than one result was found` / 取到空值

`vw get password "<名>"` 按**子串**匹配，不是精确匹配。库里同时有 `GitHub token` 和
`GitHub token - 大权限` 时，取前者会撞两条，bw 拒绝并列出两个 id，命令替换得到空串——
下游只看到「未认证」，看着像 token 坏了（2026-09-18 实测）。
处置：先用 id 映射名字再按 id 取，且默认选**最小权限**那条：

    for id in <列出的 id>; do echo "$id → $(vw get item "$id" | jq -r .name)"; done
    GH_TOKEN=$(vw get item <精确匹配的 id> | jq -r .login.password | tr -d '[:space:]') gh api user --jq .login

### `status` 是 `locked` / 报未解锁

session 过期或被锁。**只有川哥能解**：

```bash
ssh -t home-studio-mesh '~/.local/bin/vw-login'
```

我这边没有 TTY，密码提示弹不出来，别尝试代跑。

### 报 `bw 未安装`

bw 在 `~/local/node/bin/`，该目录是在 `.bashrc` 的「非交互 return」**之后**才进 PATH 的，而 `ssh host 'cmd'` 读到 return 就停。脚本里必须自己固化：`export PATH="$HOME/local/node/bin:$PATH"`。川哥 `.bashrc` 头部有他自己写的同主题注释，排查前先看那里。

### 前端打开慢 / 打不开

**先换地址，别急着查 Vaultwarden**——2026-08-21 从「登录慢」一路排到 EasyTier udp
隧道，绕了六七轮，根因根本不在 Vaultwarden：

| 地址 | 何时用 |
|---|---|
| `https://10.10.10.23:8443` | 走 EasyTier 隧道，位置无关，但**吞吐会波动**（实测两小时内 34.8 KB/s ↔ 1.83 MB/s） |
| `https://192.168.1.133:8443` | 在家局域网直连，绕开隧道 |

⚠️ **换地址后浏览器会重新弹自签证书警告**——每个地址要各点一次「高级 → 继续前往」，
没点就表现为「打不开」，看着像服务挂了。端口通不通用 `nc -zv <ip> 8443` 判，别靠浏览器。

判是不是网络：在客户端跑 `curl -k -sS -o /dev/null -w '%{speed_download}B/s\n' --max-time 60 https://<地址>/app/main.<hash>.js`
（curl 不吃浏览器缓存，测的是裸链路）。几十 KB/s = 链路问题；MB 级 = 链路没问题。

已知短板：Vaultwarden **静态资源不压缩**（带不带 `Accept-Encoding: gzip,br` 都是原样
传输，JS+CSS 合计 7.9MB），要压缩得在前面加反代。缓存头本身是对的
（`immutable, max-age=604800`）。

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

### sudo — 条目名 `home-studio 的 sudo 密码`（2026-09-23 实测）

**开发机有 sudo。** 我曾凭 ensurepip 报错里的「You may need to use sudo」就断言「开发机没有 sudo」，是没验证的结论。
取用只走 stdin，printf 是 shell 内建、值不进 argv：

    PW=$(vw get item bf551e03-735c-4483-93ed-f95cf4fb5274 | jq -r '.login.password // empty'); [ -n "$PW" ] || exit 1
    printf '%s\n' "$PW" | sudo -S -p '' -v; unset PW      # 之后本轮 sudo 走缓存，sudo -n true 验证


川哥在网页上建条目，名字要**简单、稳定、可预测**，我按名字找：`GitHub token`、`aliyun-key-id`、`aliyun-key-secret`、`cloudflare-token`。

名字变了我就找不到——找不到时先 `vw list items` 看实际名字，别猜。

## 已验证的取用案例（2026-08-21 实测通过）

### GitHub token — 条目名 `GitHub token`

已验证：列 82 个仓、分页拉取、push 到私有仓（fine-grained token，对 oh-my-ccwork /
mycc-global-backup 有 push+admin）。push 时凭据走 credential helper，**单引号包住
`$TOKEN` 让它在 argv 里保持字面量**，git 调 helper 时才展开：

    TOKEN=$(vw get password "GitHub token"); export TOKEN
    HELPER='!f() { echo username=<用户名>; echo "password=$TOKEN"; }; f'
    git -c credential.helper="$HELPER" push origin <branch>

🔴 **`<用户名>` 必须是真实 GitHub 用户名（`Hahaxiong838383`），不能随便填。**
fine-grained PAT 会校验它。2026-08-22 我图省事写了 `username=x`，得到的报错是

    remote: Invalid username or token. Password authentication is not supported

——它**点名了 token**，于是我一路去查 PAT 权限、查 Keychain、量 443 超时。
真相是 `push=true admin=true` 权限满格，换成真实用户名一次就过。
**A-or-B 型报错，先把两支都列出来，别只查自己正在关注的那支。**

⚠️ **判 token 好坏走 API，别靠 git 的报错**（git 的文案把 username 错、权限不足、
网络不通混在一起）：

    curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/user | jq -r .login
    curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/<owner>/<repo> \
      | jq -r '.permissions | "push=\(.push) admin=\(.admin)"'

⚠️ **fetch 成功证明不了 token 有效**——先确认仓库是私有的（未认证 API 返回 404）；
公开仓的 fetch 根本不走凭据，那是个彻头彻尾的假阳性。

### 阿里云 AccessKey — 条目名 `阿里云-海外    Gmail账号登录`

⚠️ **字段约定：AK ID 存在 username 栏，AK Secret 存在 password 栏。**
（我曾拿 password 去比对 `LTAI` 前缀，误报「不是 AK 格式」，白让川哥改了一次条目。）

    ITEM=$(vw get item <id>)
    export ALIBABA_CLOUD_ACCESS_KEY_ID=$(printf '%s' "$ITEM" | jq -r .login.username | tr -d '[:space:]')
    export ALIBABA_CLOUD_ACCESS_KEY_SECRET=$(printf '%s' "$ITEM" | jq -r .login.password | tr -d '[:space:]')

已验证：`sts GetCallerIdentity`、`ecs DescribeInstances`、`swas-open list-instances`、
`bssopenapi QueryAccountBill`。⚠️ 库里这把是**主账号 root AK**，权限无上限，
只跑只读接口，日常应换 RAM 子账号最小权限 AK。

### 🔴 取到凭据之后、调第三方 CLI 之前——先 grep 记忆

2026-08-21 同一天栽了三次：bw 找不到（答案在 `.bashrc` 文件头）、SWAS 是什么、
SWAS 怎么查（后两个答案都在 `reference_cloud_servers` 里，逐字写着装插件和
`--biz-region-id`）。**猜参数的主观感受跟回忆一模一样**，所以「不确定时去查」
永远不触发。把它绑在「我要调外部 CLI」这个客观动作上：

    rg <工具名|产品名> ~/.claude/projects/-home-hahaxiong83-mycc/memory/

详见 [[feedback_queried_the_wrong_product_line]]。

## 安全边界（别说得比这更乐观）

- Bitwarden 端到端加密，**服务端也解不开**。我能自动读，前提是 `.session` 常驻磁盘，**在川哥锁上之前，任何能读该文件的进程都能解开整个库**。这是他知情选择的代价。
- `bw delete item` 是**软删**（进回收站，数据库行还在），彻底删要 `--permanent`。
- **主密码忘了无法找回，这台机器无 TPM 兜底。** `db.sqlite3` 需单独备份。
- 凡是会输出凭据的命令（login / token create / unlock），预先把 stdout 重定向掉——`bw login` 会把完整 session key 打在屏幕上，川哥复制终端输出汇报时连带泄漏（2026-08-21 实际发生过一次，已用 `--raw > /dev/null` 堵掉）。

## 相关

记忆 [[project_home_studio_vaultwarden]]（真值锚）、[[feedback_tool_prints_secret_to_terminal]]、[[feedback_secret_on_argv_is_world_readable]]、[[feedback_verified_in_my_convenient_shape]]。
