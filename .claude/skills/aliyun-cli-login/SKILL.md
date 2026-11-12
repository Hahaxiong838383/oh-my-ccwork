---
name: aliyun-cli-login
description: 在 home-studio 登录和维护阿里云 CLI 的三个 OAuth profile（cc-remote、cn-139、intl-jp）。用于「aliyun 登录」「configure 无效」「无浏览器授权」「回调 URL」。不用于改云资源、轮换 AccessKey，或在已有图形桌面的机器上做普通安装。
---

# home-studio 阿里云 CLI 登录

适用主机 `hahaxiong-home-studio`，用户 `hahaxiong83`。二进制 `~/.local/bin/aliyun`。2026-11-12 验收版本是 3.5.3，上一版留在 `~/.local/bin/aliyun.3.4.11`。配置只在 `~/.aliyun/config.json`，权限保持 `600`。不要打印这个文件，也不要把 AccessKey 放进命令行参数。

真身是本目录。`~/.agents/skills/aliyun-cli-login` 指向这里。

## 三个 profile

2026-11-12 `aliyun sts GetCallerIdentity` 已验证。`configure list` 里带 `*` 的是当前默认，当时是 `intl-jp`。不带 `--profile` 就走当前默认。

| profile | 站点 | AccountId | 身份 | 默认地域 | 对应账号 |
|---|---|---|---|---|---|
| `cc-remote` | CN | `1688373750559418` | 根用户 | `cn-hongkong` | 中国站·午夜设计师 |
| `cn-139` | CN | `1694482744260991` | 根用户 | `ap-northeast-2` | 中国站·139 手机号 |
| `intl-jp` | INTL | `5032581483931690` | 根用户 | `ap-northeast-1` | 国际站 Gmail |

`intl-jp` 是国际站账号根用户的 OAuth，不是 2026-06-15 那个只有轻量服务器权限的 RAM 子用户 `cc-swas-ops`。不要把凭据库里的 root AccessKey 写进 `config.json`。Air 上的 CLI 配置本轮没有看，不要假定两边相同。

轻量服务器的查法仍是插件 `aliyun-cli-swas-open` 加 `--biz-region-id`。产品线和区域别名见 A 库 `reference_cloud_servers.md`，这里不复制。

## 验收

`configure list` 显示 Valid 只说明本地 profile 能被读出。验收是下面命令打印的 `AccountId` 与上表一致：

```bash
aliyun sts GetCallerIdentity --profile <profile>
```

`IdentityType=Account` 且 `Arn` 以 `:root` 结尾，表示登的是账号根用户。三个 profile 的 AccountId 必须彼此不同。

## 无头授权

这台机器只有 GDM 欢迎界面，没有已登录的用户桌面。3.4.11 会在本机 `127.0.0.1` 等浏览器回调，换一台设备打开链接完成不了。`aliyun configure --help` 必须有 `--no-browser`（3.5.2 起）。

没有这个旗标时再升级：从 GitHub `aliyun/aliyun-cli` 的发布页取 linux amd64 包，用该发布页上的 sha256 校验，装到 `~/.local/bin/aliyun`，旧文件改名为 `aliyun.<旧版本>`。不要用官方 `install.sh`，它会装进 `/usr/local/bin`，还可能要 root。

## 登录

用户准备好再开始。一次只登一个 profile。授权链接空等不要超过 30 分钟，超时后的链接作废，重新开一轮。

```bash
python3 ~/mycc/.claude/skills/aliyun-cli-login/scripts/oauth_no_browser.py \
  --profile cc-remote --site CN --region cn-hongkong --language zh
```

`cn-139` 用 `--site CN --region ap-northeast-2`。`intl-jp` 用 `--site INTL --region ap-northeast-1`。

脚本打出 `AUTH_URL=` 和 `CALLBACK_FILE=`。把 URL 交给用户。中国站两个 profile 的域名是 `signin.aliyun.com`，国际站是 `signin.alibabacloud.com`。用户必须登上表对应的那个账号。

授权后浏览器会去打开 `http://127.0.0.1:12345/cli/callback?...`。页面打不开是正常的。用户交回地址栏里的完整 URL。先核对其中的 `state` 和这一轮 `AUTH_URL` 的 `state` 相同，再把这一整行写入 `CALLBACK_FILE`，权限 `600`。不要把回调 URL 写进记忆、技能或提交。

脚本会等 CLI 打出 `Default Region Id` 再写入地域，等打出 `Default Language` 再写入语言。不要提前把地域和语言跟回调拼在同一次输入里。3.5.3 每个 `ReadInput` 都新建一个 `bufio.Scanner`，扫描器读走下一条后就被丢掉，语言会落成 CLI 的默认 `en`。

`aliyun configure` 本身不接受 `--region` 和 `--language`，那两个旗标只在 `aliyun configure set`。`--oauth-site-type` 可以带上，但 3.5.3 仍会问站点；直接回车默认是 CN。

登完若多出一个空的 `default` profile，删掉它：`aliyun configure delete --profile default`。然后再跑一次三个 profile 的 `GetCallerIdentity`。
