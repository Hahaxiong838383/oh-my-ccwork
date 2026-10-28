# fnmedia-ext 飞牛1加固维护

基于公开 Lite 源码 `yujian0815/fnmedia-ext@bb714a796107745de366e25f3c2f3cc96f54474e`，本地版本 `0.2.17.1`。只维护差异补丁，不复制上游公开协议签名常量或任何用户凭据。保留上游署名；不是上游官方发布。

## 当前部署

飞牛1 `192.168.1.43`；应用中心手动 FPK；`/vol3/@appcenter/fnmedia-ext/repo`；systemd `fnmedia-ext.service`。兼容锁：fnOS `1.2.0800`、官方影视 `0.9.8-1`，程序 SHA256 在补丁的 `compatibility.json`。独立插件临时重命名 Unix socket，不修改官方程序、数据库或 nginx 配置。

管理入口：`https://192.168.1.43:5667/v/online-admin`。使用官方影视管理员登录，桌面入口重定向到同一路径，避免 Cookie 的 Path 范围不匹配。没有新增管理密码。真实管理员页面与第三方播放尚待用户验证，不能把匿名401或集成fixture当作正例。

## 构建

在 Linux x86_64 工作机运行 `python3 build.py --work-dir /tmp/fnmedia-rebuild --proxy http://127.0.0.1:10808`。脚本固定上游提交、应用补丁、校验离线依赖及 fnpack SHA，构建 FPK；不安装、不改 NAS。需要 git、pip3、rsync、curl。依赖 wheel 固定为 NAS Python 3.11 / manylinux2014_x86_64，不能直接用于 ARM NAS。

上游许可证保留在生成的源码和包中。补丁包含测试，FPK不携带测试、运行态、凭据或`.git`。包留存于飞牛1 `/vol3/1000/软件安装/fnmedia-ext-maintenance-20261028/`；安装时不联网下载Python依赖。

## 官方影视升级

1. 官方 CLI 使用有效 `fnos1` OAuth profile。先 `trim-cli --profile fnos1 app stop fnmedia-ext --yes`，确认服务停止、upstream socket消失、原socket由官方进程监听。
2. 正常通过应用中心升级官方影视。不要编辑官方程序、数据库、nginx，也不要修改插件兼容锁来强行启动。
3. 新官方版本下，重新验证会话接口、搜索/播放协议及恢复流程，随后构建新的加固FPK。兼容锁不匹配时插件拒绝接管；运行时检测官方文件变化会主动退出并恢复入口，但不是与官方升级事务原子同步，所以仍需先停插件。
4. 插件自身也通过应用中心升级；不装上游未经加固的同名FPK覆盖本版本。该应用不在商店，没有开启自动升级或自动部署上游代码。

## 停用、恢复、卸载

常规停止/启动均用官方CLI `app stop/start fnmedia-ext --yes`。停止后回读真实socket归属；不能只看CLI成功消息。异常时保留现场，不手动删除官方socket，不重启整台NAS。

应急恢复由维护agent通过SSH执行：先停 `fnmedia-ext.service`，再运行 `/var/apps/fnmedia-ext/target/repo/deploy/uninstall.sh --stop-only`；该脚本复用带归属校验的 `recover.py`。`--verify-only`只核查，成功清理后才能通过应用中心卸载。恢复失败不会静默删除独立服务单元。脚本不重启官方影视。

监督/恢复进程仅保留 `CAP_SYS_PTRACE`，用于读取官方 `/proc/<pid>/exe`（完全清空在真机确实 PermissionError）；HTTP及桌面子进程在exec前清空所有有效/允许/可继承capability，并设置`no_new_privs`。systemd将官方程序和数据目录挂为只读。

## 验证边界

- 69项隔离测试：真实Unix socket/进程终止、用户历史/收藏隔离、DNS固定拨号/逐跳重定向/TLS验证、管理鉴权/CSRF与搜索/分片fixture、版本变化拒绝接管、桌面重定向。
- NAS Python 3.11离线依赖校验与11项网络护栏测试通过。
- 真机应用中心安装、停止/启动、SIGKILL后官方入口恢复和自动重启通过；官方进程未重启，程序/清单/nginx SHA不变，原socket inode保持。
- 未做真实管理员正例、第三方影片实际播放、TV/移动端或NAS冷启动测试。原生播放器若不带官方登录凭据会被拒绝，需要以后增加受签名约束的播放票据，不能放开匿名路径。
- 登录用户仍可用公网站点图片/分片代理；私网、loopback、链路本地目标被阻断。未实现URL签名及带宽配额，不宣称消除所有滥用风险。
- `FNMEDIA_STATE_DIR`仍被用户持久化与恢复测试共同使用；生产unit不设置它，持久数据默认在repo/state，恢复状态在/run/fnmedia-ext；不要自行设置该变量把用户数据改到/run。

现场报告见 `2-Projects/P01-家里局域网与飞牛/13-fnmedia-ext加固部署与升级保护.md`；验收JSON只含状态、PID、哈希，不含用户媒体清单或凭据。
