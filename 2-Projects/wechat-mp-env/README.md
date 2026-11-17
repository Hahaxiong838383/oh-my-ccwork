# wechat-mp-env — home-studio 微信小程序开发/发布环境

> 本目录是**唯一真源**。skill 只是指针，不复制细节。

## 一句话

Linux 上没有官方微信开发者工具；这里装的是**社区移植版 2.02.2609250**（用户级解包，不碰系统目录），
外加 **miniprogram-ci** 做无头上传，两条通道覆盖「要界面调样式」和「无人值守发版」。

## 快速开始

```bash
cd ~/mycc/2-Projects/wechat-mp-env

./bin/wxdt-doctor          # ① 自检：工具/依赖/显示/CI/密钥/磁盘
./bin/wxdt                 # ② 开 IDE（需要图形会话），登录扫码
./bin/wxdt-cli islogin     # ③ 确认登录态
```

新建项目：

```bash
cp -r templates/miniprogram-starter ~/mycc/2-Projects/mp-<名字>
cd ~/mycc/2-Projects/mp-<名字>
# 改 project.config.json 里的 appid
```

出二维码（不必开 IDE）：

```bash
node ~/mycc/2-Projects/wechat-mp-env/scripts/preview.mjs --project "$PWD"
```

上传开发版：

```bash
node ~/mycc/2-Projects/wechat-mp-env/scripts/upload.mjs --project "$PWD" -v 0.0.1 -d "首个版本"
```

## 目录

```
wechat-mp-env/
├── app/                 # 开发者工具本体（dpkg-deb -x 解包，用户级）
│   └── opt/apps/io.github.msojocs.wechat-devtools-linux/files/bin/
├── app.bak/             # 升级时的上一版本（回滚用）
├── bin/
│   ├── wxdt             # 开 IDE 窗口
│   ├── wxdt-cli         # CLI（修掉了上游子命令被吞的 bug）
│   └── wxdt-doctor      # 自检
├── downloads/           # deb 安装包留档
├── node_modules/        # miniprogram-ci（全项目共用）
├── scripts/
│   ├── install-devtools.sh   # 安装/升级/回滚
│   ├── preview.mjs           # 出预览二维码
│   └── upload.mjs            # 上传开发版
├── templates/miniprogram-starter/   # 最小可跑骨架
└── docs/
    ├── WORKFLOW.md      # 开发→预览→上传→备案→提审→发布
    ├── PITFALLS.md      # 会真的卡住你的坑
    └── CHECKLIST.md     # 上线前检查
```

产物默认写 `/data/home-studio/artifacts/<项目名>/`（二维码、包信息），源码留 NVMe。

## 两条通道怎么选

| 场景 | 通道 | 命令 |
|---|---|---|
| 调样式、看模拟器、真机调试 | IDE | `wxdt` / `wxdt-cli open --project <dir>` |
| 无人值守、脚本化、无图形会话 | CI | `scripts/preview.mjs` / `scripts/upload.mjs` |
| 只想要二维码 | 两者都行 | 无头用 CI；有界面用 `wxdt-cli preview` |

**关键前提**：`wxdt-cli` 的 preview/upload/login 都要求 **IDE 正在运行 + 服务端口已开启**
（IDE → 设置 → 安全设置 → 服务端口）。这不是 Linux 移植版的特性，官方工具同样如此。
完全无头环境直接用 `miniprogram-ci`，它不依赖 IDE。

## 验收记录

### 第二轮 · 2026-11-17（环境自检 + 修复）

| 检查 | 结果 | 证据 |
|---|---|---|
| 上游版本 | **已是最新** | GitHub latest release `v2.02.2609250-1`（2026-11-13 发布）与本机一致 |
| IDE 无头启动 | **通过（新验证）** | 容器 + Xvfb 下加载全部 `*.wxvpkg`，走到 `[LoginState] need-login`，主进程存活 ~60s |
| CI 脚本 | **修好 2 个硬阻断** | `preview.mjs` / `upload.mjs` 原为 `.mjs` 却用 `require()` → `ReferenceError: require is not defined`；改 `createRequire(import.meta.url)` 后 `--help` 与真实链路均通（能走到"缺密钥"这一步） |
| 单实例锁 | 已清理 | 残留 `SingletonSocket → /tmp/codeg-acp/...`（目录已不存在） |
| secrets 目录 | 已建 | `~/.mycc-secrets` 700，暂无密钥 |
| 根盘 | **预警** | `/` 91% 已用，仅剩 20G |
| 登录态 | **未验证** | 仍需可交互桌面扫码 |
| 端到端上传 | **未验证** | 缺 appid + 上传密钥 |

### 第一轮 · 2026-11-17（首次安装）

| 检查 | 结果 | 证据 |
|---|---|---|
| 包版本 | 2.02.2609250-1 | `dpkg-deb -f` |
| 共享库 | 0 缺失 | `ldd electron/electron \| grep -c 'not found'` = 0 |
| 主程序加载 | 能读到 app.asar 并初始化 | 启动输出 `appPath .../resources/app.asar`，随后仅因 `Missing X server or $DISPLAY` 退出 |
| CLI 子命令 | 已修复 | 上游 `bin/node` 把子命令当 `--electron` 的值吞掉；`bin/wxdt-cli` 绕过包装后 `islogin` 被正确识别，报「服务端口已关闭」（IDE 未运行的正常提示） |
| miniprogram-ci | 2.1.31 已装 | `pnpm add -D miniprogram-ci` |

## 图形会话怎么来

这台机器当前只有 gdm 的登录界面（Xwayland `:1024`/`:1025`，属于 gdm 用户），没有 hahaxiong83 的桌面会话。
IDE 是 Electron 程序，必须要 X/Wayland。四条路：

1. **本机登录桌面**（最简单）：显示器前登录 GNOME，开终端跑 `./bin/wxdt`。
2. **ssh -X**：`ssh -X hahaxiong83@<host>` 后跑（走 X11 转发，慢但能用）。
3. **无头容器跑**（**2026-11-17 已实测可行**）：主机没 sudo 装不了 xvfb，改用现成镜像在容器里跑，
   容器自带 Xvfb + Electron 全部依赖库。命令见 `docs/PITFALLS.md` 2.5。
   缺点是只有 Xvfb、没有可交互桌面，**验证得了启动、扫不了码**。
4. **浏览器桌面**：本机已有 `wechat-selkies` 容器（`https://10.10.10.23:3001`，需认证）。
   要扫码登录，需另起一个同类容器把 IDE 目录挂进去 + selkies 出口（未做，见待办）。

## 升级 / 回滚

```bash
# 升级：把新 deb 丢进 downloads/ 后
./scripts/install-devtools.sh

# 回滚到上一版本
./scripts/install-devtools.sh --rollback
```

升级不动 `~/.config/wechat-devtools`（登录态保留）；但移植版换 Electron 版本时可能清缓存重登。

## 已知限制

- 移植版非官方，作者自述「只在修某功能时测过」，见 `docs/PITFALLS.md` 第 2 节。
- 跟的是 2.02 线（当前 2.02.2609250），可能落后官方最新稳定版若干小版本。
- 提审/发布无 API，必须后台人工点。
- 备案是发布前提，1–20 工作日，需本人人脸核身 + 工信部短信 24h 内核验。

## 待办（川哥拍板后做）

- [ ] 提供 appid / 主体类型 → 配 `~/.mycc-secrets/private.<appid>.key`
- [ ] 决定 IP 白名单策略（关闭 / 固定出口 / 只走 IDE 登录态）
- [ ] 图形会话里做一次登录 + 首次上传验收
- [ ] 是否另起 selkies 容器把 IDE 变成浏览器可访问（远程用，不动现有微信容器）
