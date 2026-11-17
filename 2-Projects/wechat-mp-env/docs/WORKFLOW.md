# 微信小程序 · 工作流（home-studio）

> 从「一行代码」到「线上可访问」，每一步在本机的具体命令。真源 = 本文件；skill 只做指针。

环境根目录：`~/mycc/2-Projects/wechat-mp-env`
工具根目录：`~/mycc/2-Projects/wechat-mp-env/app`（用户级安装，不碰系统目录）

---

## 0. 一次性准备

```bash
# 登录（终端出二维码，微信扫）
wxdt-cli login -f terminal

# 确认登录态
wxdt-cli islogin
```

登录态存在 `~/.config/wechat-devtools/app/`（**连字符**，不是 `wechat_devtools`），一般可维持数周；失效就重扫。

### 0.1 没有图形会话时：浏览器版 IDE（`wxdt-ide`）

本机没有 hahaxiong83 的桌面会话、也没接显示器，主机 `sudo` 又要密码。所以 IDE 用**容器 + selkies** 跑，
浏览器访问即可 —— 不需要显示器、不需要 sudo、不需要装 xvfb。

```bash
./bin/wxdt-ide up       # 起容器 + 起 IDE（幂等），打印访问地址
./bin/wxdt-ide url      # 只看地址/账号（密码在 ~/.mycc-secrets/wxdt-ide.pass，600）
./bin/wxdt-ide status   # 容器 / Xvfb / IDE / 资源
./bin/wxdt-ide shot     # 不开浏览器，直接截当前屏幕到 /tmp
./bin/wxdt-ide down     # 停（登录态保留在 /data/home-studio/wxdt-ide/config）
```

打开 `https://10.10.10.23:3002/`（自签证书，信任一次）→ 看到的就是真实 IDE 窗口，
里面有登录二维码，**微信扫码即登录**。登录态落在挂载卷
`/data/home-studio/wxdt-ide/config/.config/wechat-devtools/`，容器重建不丢。

容器规格：Xvfb 2048x1536（`WXDT_IDE_SCREEN_W/H` 可调）+ openbox（可拖窗/最大化）
+ selkies（h264/jpeg 编码）+ **映射宿主 `/dev/dri` 走 GPU**（不映射会 IDE 整窗白屏，
见 PITFALLS 2.5e），实测内存约 500MB–1.1GB。IDE 目录以**只读**方式挂入，容器不改你的安装。

界面语言：中文。由**启动进程时注入** `LANGUAGE/LANG/LC_ALL=zh_CN.UTF-8` + `--lang zh` 实现
（不塞容器 env，实测塞进去会白屏，见 PITFALLS 2.5f）。

网络：容器内**不带** `http_proxy` 等变量，走 docker bridge 直连；实测 `servicewechat.com`、
`mp.weixin.qq.com` 等小程序相关域名全部解析到国内 IP、connect 20–45ms。
宿主虽有全局 `http_proxy=127.0.0.1:10808`，但 xray 按 `geoip:cn` 把国内流量直连，
带代理 env 测出口 IP 同样是 120.244.92.4（北京移动）。**小程序链路没有走代理节点。**

### 0.2 登录态保活（已固化）

登录态在 `/data/home-studio/wxdt-ide/config/.config/wechat-devtools/`（挂载卷），
微信自己的 token 由 IDE 常驻运行时持续刷新。所以保活的核心是**让 IDE 一直跑着**。
三层守护，全部无需人工：

| 层 | 机制 | 覆盖场景 |
|---|---|---|
| 容器 | `--restart unless-stopped` | docker daemon 重启、宿主重启后容器自动起 |
| IDE | systemd user timer `wxdt-ide-ensure.timer`（每分钟） | 容器重启后 Xvfb 重建、IDE 崩溃、被误杀 |
| 数据 | systemd user timer `wxdt-ide-backup.timer`（每天，留 7 份） | 误删/损坏，产物在 `/data/home-studio/wxdt-ide/backup/` |

```bash
# 看守护是否在跑
systemctl --user list-timers wxdt-ide-*
journalctl --user -u wxdt-ide-ensure.service -n 20 --no-pager

# 手动体检 / 干预
./bin/wxdt-ide login      # 登录态自检（状态/昵称/多久没刷新/掉线事件）
./bin/wxdt-ide ensure     # 立刻自愈一次
./bin/wxdt-ide backup 7   # 立刻备份
```

宿主重启这条路依赖 `Linger=yes`（本机已开）+ timer 的 `OnBootSec=90s`；容器由 docker 的
restart policy 拉起，IDE 由 timer 在容器就绪后补起。**整机重启路径未做实机验证**
（要真重启一次才算数），单测已覆盖「IDE 被杀」「容器 restart」两种。

登录态真过期时（`wxdt-ide login` 会看到 `need-login` 事件 > 0，且界面停在二维码）：
浏览器打开 `https://10.10.10.23:3002/` 重扫一次即可，配置无需清理。

---

## 1. 新建项目

```bash
# 从骨架复制
cp -r ~/mycc/2-Projects/wechat-mp-env/templates/miniprogram-starter ~/mycc/2-Projects/mp-<项目名>
cd ~/mycc/2-Projects/mp-<项目名>

# 填 project.config.json 里的 appid
# 装 CI 依赖
pnpm add -D miniprogram-ci
```

目录约定：源码在 NVMe（`~/mycc/2-Projects/`），构建产物/截图/二维码输出到 `/data/home-studio/artifacts/<项目>/`。

---

## 2. 开发循环（三种粒度）

### 2.1 最快：终端出二维码，手机看（不需要开 IDE）

```bash
node scripts/preview.mjs            # miniprogram-ci，纯 Node
# 或
wxdt-cli preview --project "$PWD" --qr-output /data/home-studio/artifacts/<项目>/preview.png
```

产物：`/data/home-studio/artifacts/<项目>/preview.png`，手机扫即可。

### 2.2 要模拟器 / WXML 面板 / 调样式：开 IDE

```bash
wxdt                                   # 打开工具窗口
wxdt-cli open --project "$PWD"          # 直接打开当前项目并编译
```

### 2.3 要自动化断言：miniprogram-automator

```bash
wxdt-cli auto --project "$PWD" --auto-port 9420
# 另开进程跑 automator 脚本，可截图/取元素/点击
```

---

## 3. 上传（开发版）

两选一：

```bash
# A. CI 通道（需密钥 + IP 白名单，适合无人值守）
node scripts/upload.mjs -v 1.0.0 -d "首个版本"

# B. 登录态通道（不需密钥，适合密钥未配好时）
wxdt-cli upload --project "$PWD" -v 1.0.0 -d "首个版本"
```

上传成功后：后台「版本管理 → 开发版本」可见。

---

## 4. 备案（首次上线必须，且必须提前启动）

1. 后台首页点【去备案】
2. 填主体信息 / 主体负责人 / 小程序信息 / 小程序负责人
3. **人脸核身**（本人操作，白或浅色背景，不戴帽/口罩/耳机）
4. 提交 → 平台初审 1–2 工作日
5. **留意 12381 短信，24 小时内**去 https://beian.miit.gov.cn/ 完成核验（超时驳回）
6. 通管局 1–20 工作日
7. 拿到备案号 → 才能发布

材料清单：主体证件、主体负责人证件、小程序负责人证件、前置审批（如涉及）、授权书/居住证等补充材料（按省份）。

---

## 5. 提审 → 发布

1. 后台「版本管理 → 开发版本」→ 选中刚上传的版本 → 【提交审核】
2. 填功能页面、测试账号、类目、隐私说明
3. 审核 1–7 天（首次可能更久）
4. 通过后 →【发布】→ 全量 或 分阶段（灰度）
5. 发布后：小程序码可在后台下载；备案号自动展示

> 提审和发布没有公开 API，只能人工点。第三方平台代开发是另一套（需授权）。

---

## 6. 上线前检查

见 `docs/CHECKLIST.md`。最少要确认：

- [ ] 备案号已下发
- [ ] 《用户隐私保护指引》已配置（否则隐私接口报错）
- [ ] 服务器域名已配（云开发可跳过）
- [ ] 类目与实际功能一致
- [ ] 体验版走完主流程无阻断
