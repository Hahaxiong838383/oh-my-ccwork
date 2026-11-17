# 微信小程序 · 踩坑清单（home-studio 实测 + 官方文档核对）

本文件只记「会真的卡住你」的坑，不写科普。所有条目都对应可执行判断/处置。

---

## 1. 上传类

### 1.1 CI 上传报 IP 不在白名单（最常见）
- **现象**：`miniprogram-ci` upload/preview 返回 `-1` / `invalid ip` / `not in whitelist`。
- **根因**：后台「开发管理 → 开发设置 → 小程序代码上传」开了 IP 白名单，而家宽是动态 IP（本机实测出口 120.244.92.4，北京移动，会变）。
- **处置（三选一，按严格度递增）**：
  1. 后台**关闭** IP 白名单（密钥只在本机、600 权限、不入 git，个人项目可接受）；
  2. 固定出口：让上传走固定公网 IP 的代理（`miniprogram-ci` 的 `proxy` 参数 / `HTTP_PROXY`），把该 IP 加白；
  3. 干脆不用密钥：改用 IDE 登录态上传（`wxdt-cli upload`），登录态由扫码获得。
- **判据**：`curl -s https://ifconfig.me` 与后台白名单比对；变了就是它。

### 1.2 密钥丢失不可找回
- 代码上传密钥在后台生成后**只显示一次**，平台不存明文。丢了只能「重置」，旧密钥立即失效。
- 存放：`~/.mycc-secrets/`（600），或统一进 `~/.mycc-secrets.env` 只存路径。**永不入 git / 不入记忆正文**。

### 1.3 上传版本号被占用
- 同一 robot（1~30）重复同版本号会覆盖，但跨 robot 不覆盖。团队协作时用固定 robot 区分人。
- 版本号建议 `主.次.修` + 日期后缀，便于后台辨认。

---

## 2. 开发者工具（Linux 移植版）

### 2.1 启动后白屏 / 编辑器空白
- 先删缓存：`rm -rf ~/.config/wechat-devtools/app/WeappCache`
- 再删全部配置：`rm -rf ~/.config/wechat-devtools`（会丢登录态，需重扫）
- 目录名是 **`wechat-devtools`（连字符）**，不是 Windows 习惯的 `wechat_devtools`（下划线）；写错路径会以为"删了没效果"。
- 走浏览器版 IDE（`bin/wxdt-ide`）时，对应路径在挂载卷：
  `/data/home-studio/wxdt-ide/config/.config/wechat-devtools/`
- 仍是空白 → libstdc++ 与预编译原生模块不匹配，需要重编原生模块或改用 docker 构建版（见项目 FAQ 第 3/4/8 条）。

### 2.2 编辑器字体异常
- 移植版默认字体在 Linux 下难看：设置里手输字体名（推荐 `Fira Code` / `Noto Sans Mono CJK SC`）。

### 2.3 编辑器里选中文字就进剪贴板
- 这是 Linux primary selection 特性。关掉：
  `~/.config/wechat_devtools/Default/Editor/User/settings.json` 里 `"editor.selectionClipboard": false`

### 2.4 设了代理导致登录/上传失败
- 报 `Protocol "https:" not supported` → 有残留 `http_proxy`。上传前 `unset http_proxy https_proxy all_proxy` 及大写版本。

### 2.5 无图形会话时跑不起来
- IDE 是 Electron 应用，必须有 X。SSH 里跑需要 `xvfb-run` 或 `DISPLAY=:N` 指向已有会话。
- `miniprogram-ci` 不需要 X —— 服务器/无头场景优先用它。
- **主机没有 sudo 时装不了 xvfb**（本机 sudo 要密码）。已实测可行的替代：**用现成镜像在容器里跑**，
  容器内自带 Xvfb + Electron 全部依赖库，不碰主机：
  ```bash
  docker run --rm -v ~/mycc/2-Projects/wechat-mp-env:/env:ro \
    --entrypoint sh ghcr.io/nickrunning/wechat-selkies:latest -c '
      export HOME=/root
      timeout 90 xvfb-run -a -s "-screen 0 1280x900x24" \
        /env/app/opt/apps/io.github.msojocs.wechat-devtools-linux/files/bin/bin/wechat-devtools'
  ```
  2026-11-17 验证：能正常加载 `*.wxvpkg` 资源、走到 `[LoginState] need-login`，
  即主进程 + 渲染进程都活着。**缺的只是可交互桌面**（扫码要人手点），
  要真正扫码需在容器里叠一层 selkies/x11vnc 桌面。容器内 `dbus` 缺失只报 warning，不影响启动。

### 2.5b 残留单实例锁导致"已在运行"
- 现象：明明没进程，启动却立刻退出或复用了别的会话。
- 根因：`~/.config/wechat-devtools/Singleton{Lock,Socket,Cookie}` 是符号链接，指向上次运行时的
  `hostname-pid` / `/tmp/...` socket；异常退出后残留（本机实测残留指向 `/tmp/codeg-acp/...`）。
- 处置：`rm -f ~/.config/wechat-devtools/Singleton{Cookie,Lock,Socket}`。`bin/wxdt-doctor` 的 [1b] 段会自动检出。

### 2.5e IDE 白屏（整窗纯白，但不是黑屏也不是报错）
三个独立原因，按命中率排：

1. **容器没映射 `/dev/dri`（最常见）**
   - 现象：IDE 窗口存在、进程正常、日志无错误，但截图/浏览器里整窗纯白。
   - 根因：Xvfb 拿不到 GPU 设备 → 只能软件渲染 → Electron 画不出内容。
   - 判据：`docker exec wxdt-ide ls /dev/dri` 报 No such file；`pgrep -a -x Xvfb` 里没有
     `-vfbdevice /dev/dri/renderD128`。
   - 处置：`docker run` 加 `--device /dev/dri`，并设 `DRINODE=/dev/dri/renderD128`、
     `DISABLE_DRI3=false`（`bin/wxdt-ide` 已内置，宿主有 `/dev/dri` 才加）。
   - **只开 Xvfb 这个不够**：宿主/容器都要有 render 节点；对照可用的 `wechat-selkies`
     容器，它也是映射了 `/dev/dri`。

2. **selkies 初始分辨率太小，装不下 IDE 记住的窗口**
   - 现象：同上（纯白），但 `/dev/dri` 正常。
   - 根因：selkies 默认把虚拟屏压到 1024x768，而 IDE 会记住上次的窗口尺寸（如 1960x1200），
     窗口比屏大 → 内容画在屏幕外。
   - 判据：`xdotool getwindowgeometry <id>` 的宽高 > `xrandr` 的 current。
   - 处置：`SELKIES_MANUAL_WIDTH=2048 SELKIES_MANUAL_HEIGHT=1536`（`bin/wxdt-ide` 默认已设，
     可用 `WXDT_IDE_SCREEN_W/H` 覆盖），重建容器。**必须在容器创建时给，事后 `xrandr` 改
     分辨率 IDE 不会重绘，照样白。**

3. **跨容器的 GPU 缓存损坏**
   - 处置：删 `app/GPUCache`、`app/Code Cache`、`app/DawnCache`、`app/DawnGraphiteCache`、
     `app/GrShaderCache`、`app/ShaderCache` 再起 IDE。不要动 `app/WeappLocalData`（登录态）。

### 2.5f 界面语言不是中文
- 容器里有 `zh_CN.utf8` 不代表界面会中文：**GUI 程序的语言由 `LANGUAGE` 决定，它优先级高于
  `LANG`/`LC_ALL`**。镜像默认 `LANGUAGE=en_US.UTF-8`，只加 `LC_ALL=zh_CN.UTF-8` 没用。
- 但**把 LANGUAGE 塞进容器 env 重建容器后，IDE 出现过持续白屏**（原因未完全定位，疑似与
  中文 locale 下的字体/渲染路径有关）。当前做法：容器 env 保持镜像默认，**启动 IDE 时按进程注入**：
  ```bash
  docker exec -d -u abc -e DISPLAY=:1 -e HOME=/config \
    -e LANG=zh_CN.UTF-8 -e LANGUAGE=zh_CN.UTF-8 -e LC_ALL=zh_CN.UTF-8 \
    wxdt-ide /opt/wxdt/bin/bin/wechat-devtools --lang zh
  ```
  `bin/wxdt-ide` 已内置。验收看 `ps aux | grep chrome_crashpad`/network service 的 `--lang=zh-CN`，
  或直接看界面：菜单应是「微信开发者工具 / 小程序模式 / 预览 / 真机调试 / 上传」。

### 2.5d 浏览器版 IDE「连不上」= Xvfb 虚拟屏太小（真踩过）
- **现象**：浏览器打开 `wxdt-ide` 的地址，输完账号密码后一直转圈 / 黑屏 / 反复重连，容器日志刷
  `Rate limited: reconnecting too quickly`。
- **根因**：selkies 会把 X 分辨率改成**浏览器窗口的真实像素尺寸**（Mac Retina 上是 3548x1992 这种），
  再通过 RandR 向 Xvfb 申请新 mode。若超过 Xvfb 启动时的 `-screen 0 WxHx24` 上限，X 直接拒：
  `Failed (add new mode). RC: 1, Stderr: X Error of failed request: BadMatch`，连接随即崩、
  前端重连又撞上 500ms 的 `RECONNECT_DEBOUNCE_MS` 限流 → 表现就是"根本连不上"。
- **判据**：`docker logs wxdt-ide | grep -E 'resize request|BadMatch'`，看到请求尺寸 > `xrandr` 的 maximum 即是。
- **处置**：`MAX_RES` 别按 1080p 给。`bin/wxdt-ide` 默认 `WXDT_IDE_MAXRES=7680x4320`，
  改完必须**重建容器**（Xvfb 的 screen 尺寸是启动参数）。验证：
  `docker exec -e DISPLAY=:1 -u abc wxdt-ide xrandr | head -1` 的 maximum 要大于客户端请求。

### 2.5c 直接跑 electron 报 SUID sandbox FATAL
- 现象：`.../electron --version` 报 `The SUID sandbox helper binary was found, but is not configured correctly`。
- 根因：用户级 `dpkg-deb -x` 解包后 `chrome-sandbox` 不是 `root:root 4755`，而改成 4755 需要 sudo。
- 处置：**不要直接调 electron**，一律走官方启动器 `bin/wechat-devtools`（末尾已带 `--no-sandbox`）。这不是故障。

### 2.6 真机调试连不上
- 手机与 home-studio 必须**同一网段**（同 WiFi / 同 LAN），且本机防火墙放行工具监听的端口。
- 公司/公共 WiFi 常开 AP 隔离，会直接不通。

### 2.7 版本落后官方
- 移植版跟的是社区构建节奏（当前 2.02.2609250），可能落后官方最新稳定版若干个小版本。功能差异以官方更新日志为准，遇到「官方有这个菜单但这里没有」先升级移植版。

---

## 3. 账号 / 资质 / 发布

### 3.1 没有备案 = 不能发布
- 2023-09-04 起强制。流程 5 步，卡点在：
  - **工信部短信核验 24 小时内必须完成**（12381 发到主体负责人/小程序负责人手机），超时直接驳回重来；
  - 通管局 1–20 工作日。
- 备案材料：主体证件、主体负责人证件、小程序负责人证件、**人脸核身**（本人、白/浅色背景、不戴帽/口罩/耳机）、承诺书。
- 备案号上线后自动展示在小程序资料页，无需自己挂。

### 3.2 提审 / 发布没有 API
- 上传（开发版）可自动化；**提交审核 → 发布（全量/分阶段）只能在 mp.weixin.qq.com 后台点**。
- 要全自动，只能走第三方平台代开发（需授权），成本远高于人工点两下。

### 3.3 类目选错 = 白干
- 类目必须与实际功能一致，选错会被驳回。个人主体类目少、**不能开微信支付**；企业主体可开支付但要营业执照 + 微信认证（审核服务费 + 年审）。

### 3.4 隐私指引没配，接口直接报错
- 2023-09 起必须配《小程序用户隐私保护指引》。没配时 `wx.getUserProfile`、位置、相册、剪贴板等隐私接口调用失败或返回空。
- 位置：后台「设置 → 服务内容声明 → 用户隐私保护指引」。

### 3.5 服务器域名限制
- `wx.request` 只能打**已备案域名 + HTTPS + 443**，且要在后台配「request 合法域名」。
- 境外服务器（RackNerd 等）无法备案 → 要么换国内云，要么用**云开发**（云函数/数据库不走域名校验）。

### 3.6 云开发免费环境会到期
- 未发布前免费；**发布后第 15 天到期**（活动至 2026-12-31）。到期不转付费（19.9 元/月）环境会被停。
- 上线前就要把「转付费」排进计划，别等线上挂了才发现。

---

## 4. 本机环境

### 4.1 根盘吃紧
- `/` 218G 已用 188G（**91%**），装 IDE 后余量约 20G（2026-11-17 实测；再装一个 894M 的 IDE 版本会掉到 ~19G）。
- 项目 `node_modules`、构建产物建议指到 `/data/home-studio/artifacts/<项目>/`，源码留 NVMe。
- `downloads/` 的 deb 留档只留最新一个，旧的及时删。

### 4.2 用户级安装（无 sudo）
- 本机 `sudo` 需要密码，agent 不能静默提权。
- 因此 IDE 用 `dpkg-deb -x` 解包到用户目录 + 软链，**不碰系统目录**；升级 = 换包重解，回滚 = 换回旧目录。

### 4.3 Node 版本
- 本机 Node 24.22.3，`miniprogram-ci` 要求 ≥16.1.0，满足。
- 移植版 README 建议 Node 22 用于「自行构建」，**运行已构建的包不需要**。
