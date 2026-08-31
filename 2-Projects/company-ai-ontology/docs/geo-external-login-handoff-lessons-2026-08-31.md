# GEO 外部账号登录接力经验教训（2026-08-31）

## 结论

- 搜狐号账号 ID `6` 已在 company-vm 变为 `active`，媒体桥重启后仍保持登录并进入可分发账号列表。
- 持久状态文件为 `/home/futurus/Google/Chrome/XiaohongshuProfiles/geo-d31b984eff13/.geo-login-state/sohu.json`，权限 `0600`，本次保存 `14` 个 Cookie 和 `1` 个 sessionStorage origin。
- 两个真实根因分别是 Chrome `151.0.7922.175` 与 Studio Playwright `1.62.0` 的 CDP 兼容问题，以及 Python.org macOS Python 未加载系统 CA bundle。
- 兼容修复已进入组织仓：PR #20 / Commit `67cc2a145797c4ad2f1cf1602aece7f2483397ea`，PR #21 / Commit `78c719d60b7e89b64ee0415981e6667a88276286`。
- company-vm 生产同版 venv 全量测试 `412/412` 通过；`geo-engine.service`、`media-bridge.service` 均为 `active`，`/health` 返回 `200`。

## 模块 1：操作入口与设备归属

### 现象

- 用户在 Air 上操作，不代表命令一定在 Air 本地 shell 执行；若先 SSH 进 Studio 再执行浏览器命令，Chrome 实际运行在 Studio。
- 从富文本复制命令时，裸 URL 可能变成 `[URL](URL)`，终端得到的不是原始参数。

### 固化规则

1. 登录命令必须粘贴到 Air 本地终端，先用 `hostname` 或 shell 提示符确认执行主机。
2. 终端命令中的 URL 只允许裸字符串或 shell 引号，不允许 Markdown 链接语法。
3. Dashboard 文案只能说明“复制命令到外部设备执行”，不能声称网页能自动启动外部设备的 SSH 和浏览器。

## 模块 2：Air Chrome Profile 启动

### 现象

- `open -na "Google Chrome" --args ...` 可能被已有的同 Profile Chrome 进程吞掉调试参数，页面打开了，但 `127.0.0.1:<port>/json/version` 没有监听。
- 只看到搜狐页面出现，不能证明 CDP 已启用。

### 固化规则

1. 每个平台使用独立目录，例如 `$HOME/.geo-login/sohu`，禁止复用日常 Chrome Profile。
2. 必要时只终止命令行包含该独立 Profile 路径的 Chrome 进程，禁止全量关闭用户 Chrome。
3. 故障兜底使用 Chrome 可执行文件直接启动，并加入 `--no-first-run`、`--no-default-browser-check`。
4. 启动后必须轮询本机 `http://127.0.0.1:<port>/json/version` 成功，再建立接力；页面可见不能替代 CDP 预检。

## 模块 3：SSH 反向 CDP 隧道

### 现象

- Studio 端存在 `127.0.0.1:<port>` LISTEN，只能证明 SSH ControlMaster 建立；如果 Air 本机同端口没有 Chrome，访问仍会 `connection reset by peer`。
- helper 失败后可能残留纯端口转发的 `sshd-session`。

### 固化规则

1. 分别验证 Air 本机 CDP、Studio 回环端口和页面 target，三者不能互相替代。
2. 隧道只允许 `127.0.0.1`，禁止公开监听 CDP。
3. 使用独立 ControlMaster socket，helper 结束后关闭隧道；失败路径也要清理残留监听。
4. 排障时记录端口、进程、连接方向和页面 URL，不记录 Cookie、Token 或 Storage 正文。

## 模块 4：Chrome / Playwright CDP 兼容

### 现象

- Air Chrome `151.0.7922.175` 可正常提供 CDP，但 Playwright `connect_over_cdp()` 在 `Browser.setDownloadBehavior` 阶段报：`Browser context management is not supported`。
- 隧道和浏览器都正常，helper 仍会提前退出。

### 固化规则

1. 只有命中上述明确兼容错误时，才从 Playwright 切换到纯标准库 WebSocket/CDP 客户端。
2. 原生 CDP 读取 Cookie、localStorage、sessionStorage，并继续执行目标平台域白名单。
3. 其他 Playwright/CDP 错误必须 fail-closed，不能用宽泛 `except` 自动降级后继续上传。
4. 登录判定至少连续两次稳定为真后再 handoff，避免单页跳转瞬态误判。

## 模块 5：HTTPS Handoff 上传与 CA

### 现象

- Studio 的 Python.org Python `3.11` 默认 CA 路径不存在，且 relay venv 没有 `certifi`；浏览器/CDP 检测成功后，上传 `https://geo.kidshub.cn/connect/<token>/handoff` 才报 `CERTIFICATE_VERIFY_FAILED`。

### 固化规则

1. Relay 优先尊重 `SSL_CERT_FILE`，否则检测 macOS `/etc/ssl/cert.pem` 和 Linux 常见系统 CA bundle。
2. 禁止用 unverified SSL context、`-k` 或关闭证书验证绕过问题。
3. Relay 发布验收必须由其实际 Python venv 访问公网 `/health`，不能只用系统 `curl`。
4. CDP 读取成功和 HTTPS handoff 成功是两个独立阶段，日志必须能区分。

## 模块 6：搜狐登录就绪判定

### 现象

- 搜狐新版后台使用 `/mpfe/v4/contentManagement/...`；只认旧 `/mpfe/v4/main` 会把已登录账号误报为待扫码。
- 只根据 URL 判断又可能把实名认证、入驻审核或空页面壳误判为成功。

### 固化规则

1. 同时检查受信后台路由和真实后台导航/内容证据。
2. `passport.sohu.com` 只证明通行证登录，不等于搜狐创作者后台可发布。
3. 实名认证、入驻审核、风控或空壳页面必须保持 `login_required`。

## 模块 7：company-vm 导入与持久化

### 现象

- 只把会话写进运行中浏览器，会在媒体桥或 Chrome 重启后丢失 sessionStorage，账号重新变为待登录。

### 固化规则

1. Handoff 导入成功后，将目标平台状态写入 Chrome Profile 内 `.geo-login-state/<platform>.json`。
2. 目录权限 `0700`、文件权限 `0600`；保存前继续校验平台域、HTTPS origin、数量、长度和总载荷。
3. 浏览器重新启动时先恢复 Cookie/localStorage/sessionStorage，再执行平台登录检测。
4. 禁止直接修改数据库伪造 `active`；账号状态只能来自桥端真实登录检测。

## 模块 8：生产验收与发布边界

### 必须同时成立

1. Air 本机 `/json/version` 可达，目标搜狐页面 target 存在。
2. Studio relay 明确输出“登录态已同步到 company-vm”。
3. company-vm 状态文件存在且权限为 `0600`。
4. `POST /distribution/accounts/test` 对账号 ID `6` 返回 `ok=true / status=active`。
5. `/distribution/accounts` 中账号为 `active`，因此进入前端分发账号过滤结果。
6. 重启 `media-bridge.service` 后再次检测仍为 `active`。
7. `geo-engine.service`、`media-bridge.service` 均为 user systemd `active`，内部 `/health` 为 `200`。

### 发布边界

- Chrome 151 原生 CDP兼容和 CA bundle 修复只影响 Studio relay，不需要为了对齐 Commit 无关重启 GEO Engine。
- Studio helper 使用不可变 Release 和原子 wrapper 切换，并保留上一 wrapper/Release 回滚点。
- 当前 Dashboard 自动生成命令仍使用 `open -na`；后续应将“直接 Chrome 二进制启动 + 本机 `/json/version` 预检 + 失败日志”下沉到生成器。在该改造上线前，遇到“未连接到 Air Chrome”按模块 2 的兜底流程处理。
