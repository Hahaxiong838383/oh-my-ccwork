---
name: fnos-nas
description: 飞牛 NAS (Teiron fnOS) 系统知识库，基于实战排障经验沉淀。触发词："飞牛"、"NAS"、"fnOS"、"储存空间"、"文件管理"、"trim_"、"WebDAV"、"loginprotect"
---

# fnOS NAS 排障指南

> 飞牛 NAS (Teiron fnOS) 系统知识库，基于实战排障经验沉淀。
> 触发词："飞牛"、"NAS"、"fnOS"、"储存空间"、"文件管理"、"trim_"、"WebDAV"、"loginprotect"

---

## 维护原则

1. 需要在飞牛上部署服务时，**优先使用飞牛应用中心的 APP**。先 `trim-cli app store search`，能装就 `trim-cli app install`。应用中心没有，或功能明确不够，才允许手动 fpk 或 Docker，并写明原因。
2. 后续维护用官方 CLI：npm `@trimjs/trim-cli`，本机命令 `trim-cli`。登录只用 OAuth，不把密码或授权 code 放进命令参数。
3. 家里局域网和两台飞牛的台账在独立仓 `~/home-lan`，不要写回 MyAgent。

## 专项维护

飞牛影视在线扩展的安装、播放/卡顿、插件更新与官方升级复连，使用 [fnmedia-ext-maintenance](../fnmedia-ext-maintenance/SKILL.md)。先查带日期的设备台账与运行态；下文历史端口/内核记录不能直接当作当前设备状态。

## 系统架构

| 组件 | 说明 |
|------|------|
| 发行版 | Debian bookworm |
| NAS内核 | 6.12.18-trim（原生，支持 trimafs） |
| 当前内核 | 6.12.43+deb12-amd64（通用，trimafs 挂载失败） |
| 存储 | RAID1 (md0/md127) → LVM+dm-cache → btrfs /vol1 /vol2 |
| 数据库 | PostgreSQL，数据库名 `trim` |
| Web 端口 | 飞牛 1 与飞牛 2（2026-10-12，系统 1.2.0800）：5666 HTTP、5667 HTTPS。`trim-cli` 对远程 IP 用 https:5667。管理接口在 `/ogh/ac/h/` |

---

## 核心服务

| 服务 | 说明 | 日志 |
|------|------|------|
| `trim_main` | NAS 核心服务（C++） | `systemctl status trim_main` |
| `filestor_service` | 文件存储 RPC API（C++） | `/usr/trim/logs/filestor_service.log` |
| `trim_sac` | Session Auth Center | `/var/log/trim_sac/` |
| `trim_http_cgi` | HTTP/WebSocket 网关（Go，TRPC协议） | nginx 日志 |
| nginx | 反向代理 | `/usr/trim/nginx/logs/access.log` |
| `webdav.service` | 原生文件 WebDAV（`:5005` HTTP / `:5006` HTTPS） | `/usr/trim/logs/share_service.log`（分享重建）；进程 `/usr/trim/bin/webdav` |

---

## 关键路径

```
/vol1/                      # btrfs 卷1（drwx------ root，需 ACL 才能访问）
/vol1/1000/                 # 用户 hahaxiong83 的存储根目录
/vol2/                      # btrfs 卷2
/vol2/@team/                # 团队文件目录（0755 root）
/vol2/@team/FUTURUS 工作文件夹/  # 团队文件夹（需 ACL r-x）
/fs/1000/                   # trimafs 虚拟路径（内核不支持时为空目录）
/usr/trim/bin/              # NAS 二进制文件
/usr/trim/nginx/            # nginx 配置和日志
/usr/trim/logs/             # 各服务日志
```

---

## PostgreSQL `trim` 数据库

常用查询：

```sql
-- 检查用户
SELECT uid, name FROM users;

-- 检查用户存储挂载（disable=0 才显示）
SELECT * FROM user_storage WHERE uid=1000;

-- 检查长 token（文件管理器用）
SELECT uid, LEFT(token, 20) FROM longtoken WHERE uid=1000;

-- 检查权限集
SELECT gid, comment, permset FROM groups;
```

---

## 已知问题与修复

### 1. 文件管理「权限不足」- 储存空间

**现象**：管理员账号打开文件管理器 → 储存空间 → 报「权限不足」

**根因**：`/vol1/` 和 `/vol2/` 是 `drwx------` root，`filestor_service` 的 `trim_access(uid, path)` 做 OS 层权限检查时 EACCES。

**修复**：
```bash
sudo setfacl -m g:Administrators:x /vol1/ /vol2/
# 验证
sudo -u hahaxiong83 ls /vol1/1000/
```

**为什么只加 x 不加 r**：filestor_service 构建完整路径（`/vol1/1000/filename`）后直接访问，只需 traverse 权限，不需要 list `/vol1/` 根目录。

---

### 2. 文件管理「权限不足」- 团队文件

**现象**：团队文件夹可以看到（有 `--x`），但进入后看不到内容

**根因**：`/vol2/@team/` 下各团队目录的 ACL 为 `other::--x`，uid=1000 只有 execute（traverse）没有 read（list）。

**修复**：
```bash
sudo setfacl -m u:hahaxiong83:r-x "/vol2/@team/FUTURUS 工作文件夹" "/vol2/@team/个人文件夹"
# 验证
sudo -u hahaxiong83 ls "/vol2/@team/FUTURUS 工作文件夹/"
```

---

### 3. 储存空间不显示（文件管理器左侧空白）

**现象**：文件管理器打开，左侧「储存空间」区域空白

**根因**：PostgreSQL `user_storage` 表中 uid=1000 的条目缺失或 `disable=1`

**修复**：
```sql
-- 查看现有卷
SELECT id, path FROM mount WHERE type='btrfs';

-- 检查 user_storage
SELECT * FROM user_storage WHERE uid=1000;

-- 若缺失，参考其他用户插入（disable=0）
INSERT INTO user_storage (uid, storage_id, ...) VALUES (1000, ...);
```
然后重启 trim_main：`sudo systemctl restart trim_main`

---

### 4. trimafs 挂载失败

**现象**：`systemctl status triminit` 显示 `mount: /fs: unknown filesystem type 'trimafs'`

**原因**：当前运行的是通用 Debian 内核（6.12.43+deb12），不含 trimafs 内核模块。trimafs 是 Teiron 私有虚拟文件系统，只有原生 NAS 内核（6.12.18-trim）支持。

**影响**：`/fs/1000/` 下的 ftp/nfs/smb/webdav 虚拟路径不可用，但实际存储访问不受影响（filestor_service 直接访问 /vol1/ /vol2/）。

**临时解决**：以上 ACL 修复可绕过 trimafs，直接授予 OS 层访问权限。

---


### 6. WebDAV 401 对管理员账密仍拒

**现象**：`PROPFIND http://192.168.1.115:5005/` 对 `hahaxiong83`（Administrators、登录密码=WebDAV 密码）回 `401 Not Authorized`，本机和 NAS localhost 一样。看起来像没授权。

**根因**：`/usr/trim/bin/webdav` 的 `loginprotect`（`IsUserBanned` / `IsIPBanned` / `RecordFailure` / `sameCalendarDay`）。连续失败把用户或 IP 封进 **go-cache 内存**。封上之后对的账密也是 401。`ExecReload=kill -HUP` 清不掉。

**修复**：
```bash
sudo systemctl restart webdav.service
# 应 207。根下列的是共享名（如 开发机备份），不是 /vol2/1000/...
```

**注意**：Codeg `remoteDir` 不能带 `/`。home-studio 备份真值见 A 库 `project_home_studio_fnos2_backup`。

---
## 常用诊断命令

```bash
# 检查应用层权限（会走 filestor RPC 检查）
sudo check_perm 1000 /vol1/

# 检查 ACL
sudo getfacl /vol1/
sudo getfacl "/vol2/@team/FUTURUS 工作文件夹"

# 实时看 filestor 日志
sudo tail -f /usr/trim/logs/filestor_service.log

# 检查 nginx 访问（看 WebSocket 连接情况）
sudo tail -f /usr/trim/nginx/logs/access.log

# 检查 SAC 用户信息（需要 token）
TOKEN="xxx"
curl -s -H "Cookie: token=$TOKEN" "http://localhost:5668/sac/rpcproxy/v1/userinfo"
```

---

## ACL 持久性

btrfs 上的 POSIX ACL 存储为 `system.posix_acl_access` xattr，**重启后保留**，不需要额外脚本。

验证：
```bash
sudo getfattr -n system.posix_acl_access /vol1/  # 有输出 = 已持久化
```

---

### 5. 文件管理器上传大文件失败

**现象**：通过外网域名（如 `fn2.hahaxiong.cc:8666`）上传 >100MB 文件失败，nginx 日志无任何上传记录

**根因**：请求经过 Cloudflare 隧道，**免费版限制单次上传 100MB**，请求在 Cloudflare 层被拒绝，根本未到达 NAS。

**修复/绕过**：
- **推荐**：改用局域网直接访问 `http://192.168.1.115:5668/` 上传，绕开 Cloudflare 限制
- **备用**：在 NAS 上直接 `wget`/`curl` 下载文件，不走浏览器上传

**上传日志路径**：
```bash
sudo tail -f /usr/trim/logs/uploadsrv.log    # 上传服务日志
sudo tail -f /usr/trim/nginx/logs/access.log  # nginx 访问日志（POST /upload 在此）
```

**注意**：上传走 WebSocket（`/websocket?type=file`）而非普通 HTTP POST，大文件调试看 uploadsrv.log 而不是 access.log。

### 7. trim-cli 与 EasyTier（2026-10-12）

系统升到 1.2.0800 后，`trim-cli --profile fnos2 app list` 和 `fnos1` 都能列出应用。1.2.0701 没有 `/ogh/ac/h/`，同一条命令拿到的是网页 404。

应用中心的 `EasyTier` 1.0.9、`EasyTier-Web`、`易组网(用户版)` 不能替换飞牛 2 上已经在跑的 Docker `easytier/easytier:v2.6.4`。那个容器占 `10.10.10.22`，并导出家里网段。细节在 A 库 `project_fnos_trim_cli`。

### 8. trim-cli 登录、失效与保活（2026-11-16 实测）

**失效表现**：`refresh failed: client mismatch` 或连续 401 —— access/refresh token 已不能轮换，只能重新走 OAuth。
`login --refresh` 成功时输出 `endpoint: oauth.refresh`；失败不要重试旧 token，也不要改凭据文件。

**重新授权（非交互会话）**：`login` 的 `Authorization code` 提示需要 TTY，直接在管道/后台跑会报
`IO error: not a terminal`。做法是用 python `pty` 起子进程：把授权链接读出来给用户，用户授权后把
一次性 code 写进文件（不要放进命令行参数），由包装脚本写入 pty 并回车。

**保活**：`~/.local/bin/trim-cli-keepalive.sh` + systemd 用户单元 `trim-cli-keepalive.{service,timer}`，
每天 08:15 / 20:15（Asia/Shanghai，`Persistent=true`，±180s 随机）对 `fnos1`/`fnos2` 各跑一次
`login --refresh`；linger=yes，未登录也会执行。日志 `~/.local/state/trim-cli/keepalive.log`（保留 400 行），
失败记 `FAIL` 并非零退出，由 journal 留痕。NAS 长期关机/断网超过 refresh token 有效期仍会掉一次授权，
属预期，看到 FAIL 再人工授权。
