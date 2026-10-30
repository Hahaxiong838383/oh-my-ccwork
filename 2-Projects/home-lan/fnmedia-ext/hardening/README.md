# fnmedia-ext 飞牛1加固维护

当前版本 **0.2.19.2**（2026-10-30），上游 Lite `yujian0815/fnmedia-ext@93a781b1813eaaa83723765f38e6e4dddd60a651`。保留上游署名，只归档差异补丁，不复制公开协议常量或用户凭据。不是上游官方发布。

## 部署与入口

飞牛1 `192.168.1.43`，应用中心手动 FPK，`/vol3/@appcenter/fnmedia-ext/repo`，systemd `fnmedia-ext.service`。管理页 `https://192.168.1.43:5667/v/online-admin`，沿用影视管理员会话与 CSRF；无新增管理密码。不改官方程序、数据库、nginx；仅独立插件可逆接管 Unix socket。

## 更新行为

- 管理页“检查更新 / 检查并更新”只向 `/var/lib/fnmedia-ext-maintenance` 排队。HTTP 工作进程不下载、不执行更新代码。
- home-studio 用户 timer `fnmedia-ext-maintenance.timer` 每分钟消费队列、续心跳，每小时查 GitHub 稳定版。执行器为本目录 `maintenance/runner.py`，运行态在 `~/home-lan/runtime/fnmedia-ext-managed/`；登录复用本机 `trim-cli --profile fnos1` OAuth，SSH 复用本用户 key，**不向 NAS 复制 OAuth 凭据**。
- `update_prepare.py` 仅接受根 VERSION/CHANGELOG.md/文档.md 的变动，保留全部加固源码，版本加 `.1`。Python、shell、依赖、清单等变动显示 `needs_review`，必须适配后再发包。定时任务只检查；管理员随时点更新。
- 安装前校验官方三文件可读、打包、NAS 文件 SHA 回读、App Center dry-run 的 `canUpgrade=true`。升级后验版本、服务、socket、匿名管理拒绝与三 SHA。失败尝试旧 FPK，但 fnOS 可拒绝降级，故**不承诺自动回滚一定成功**；失败状态保留且停止重复安装，恢复点保留供维护。
- **trim-cli 0.1.1 缺口**：install-fpk 对已装应用即使 canUpgrade=true，install/task 仍报10236；app update 又先走 cloud 下载。本目录 `local_upgrade.py` 用短时 loopback TLS CONNECT 代理，只把 fnmedia-ext 的下载来源改为固定 NAS FPK，随后由原 CLI 跑正式 update 检查和任务。目标只允许飞牛1；不记录 HTTP 头、body、token，不读/解密 session 文件。它复用该 profile 已启用的自签 TLS 策略；临时证书/私钥随进程删除。CLI 修复后应移除此适配层。
- 包留在飞牛1 `/vol3/1000/软件安装/fnmedia-ext-managed-packages/`；根目录归 Administrators。NAS 私有备份 `/var/lib/fnmedia-ext-backups/` 仅 root 可读，不入 Git。

## 自动复连

已核版本/摘要保持原锁。监听者必须匹配完整 exe 路径、运行摘要和磁盘摘要。官方版本变化后，先恢复官方入口，再检查公开版本接口、公开签名配置接口和未登录鉴权行为；通过后标为 **probation 试运行**。每60秒复查上游，异常还原官方入口。systemd 失败后15秒重试，不耗尽启动额度；手动停止仍保持停止。

公开检查不等于登录、搜索、播放的全协议验证。未知接口变化仍需适配；没有升级真实官方影视来证明未来版本兼容。服务中仅监督/恢复进程保留 CAP_SYS_PTRACE（读 /proc 身份需要），HTTP/桌面子进程 capability 全0、no_new_privs=1。

## 内容更新

用户热榜/海量库启用状态原样保留。热榜6小时，海量库24小时：重建分类并强制抓取可用分类的影片首页，深页按需读取，避免整库爬取。管理页显示真实成功/失败/下次计划，可手动刷新。

手动与后台共用一次运行；部分分类失败不算全部成功；失败保留旧榜/首页、5分钟起指数退避。首页影片本身及分类路由落盘，重启后仍能回退旧内容。调度在 NAS 内运行，不依赖 home-studio 在线；home-studio 离线只影响版本检查/升级。

## 构建与验证

`python3 build.py --work-dir /tmp/fnmedia-rebuild --proxy http://127.0.0.1:10808`：固定上游提交、补丁、fnpack SHA、Python3.11 x86_64 离线依赖，生成 FPK，不安装。构建目录必须不存在。

插件113项回归通过（新增搜索总时限、请求取消与错片绑定回归）；更新准备器27项、维护执行器31项通过。首次真实官方 update/task 升级成功；官方 PID7511和三SHA保持，配置/历史验摘要一致，自动首页刷新78条（18/20/20/20）且状态成功。真实管理员页面由用户反馈已使用；本轮未重新验证登录后第三方播放、TV、冷启动或官方真实升级。0.2.19.2播放排障、真机证据与剩余验收见项目15号报告；自动更新机制见14号报告及 managed-*.json。

正常停启/卸载用 `trim-cli --profile fnos1 app stop/start/uninstall fnmedia-ext --yes`。异常恢复用插件同源 `recover.py` 或 `deploy/uninstall.sh --stop-only`，必须回读 socket 归属；不手动删除官方 socket。不要设置生产 FNMEDIA_STATE_DIR 把用户数据指向 /run。

## 0.2.19.2 播放修复

每个搜索源增加12秒总时限，避免快源已找到片源却被慢源拖到整批25秒超时；搜索与榜单共享Future隔离请求取消；无相关匹配时不再绑定第一条无关影片。真机同词搜索12.04秒返回3个精确可播源。电视/手机升级后真实画面声音仍待复测，不承诺第三方每条内容可用。发布包位于 `/data/home-studio/artifacts/fnmedia-tv-20261030/releases/`，维护器可信树及last-good指针已同步。

升级适配器现按NAS真实download/status的 `packageType=path` 调用update；local/file在本轮update/info均返回10100。仅对固定NAS的POST `/oauthapi/refresh`放行原样转发，令牌仍由CLI管理；已实测代理内官方refresh成功。
