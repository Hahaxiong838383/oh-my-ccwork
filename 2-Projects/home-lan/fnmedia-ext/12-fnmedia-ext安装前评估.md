# fnmedia-ext 安装前评估

后续状态：用户授权加固后已安装独立0.2.17.1，见[13号部署报告](13-fnmedia-ext加固部署与升级保护.md)。本页保留安装前评估，不代表当前未安装。

日期：2026-10-28。目标：飞牛1；原始评估结论：**版本兼容，但原版 0.2.17 未通过安装前验证，暂未安装。** 飞牛2未操作。

## 项目与适用范围

- 项目：[yujian0815/fnmedia-ext](https://github.com/yujian0815/fnmedia-ext)，第三方影视扩展；不是官方影视应用本身。
- 最新公开发布：[v0.2.17](https://github.com/yujian0815/fnmedia-ext/releases/tag/v0.2.17)，2026-10-27发布，源码 commit `bb714a796107745de366e25f3c2f3cc96f54474e`。
- 提供在线搜索聚合、虚拟媒体库、多线路播放及在线播放续播；通过接管官方 Unix socket 进入整个影视请求链，不是独立网页小工具。
- 飞牛1现场：`FNOS1`、`192.168.1.43`、x86_64、fnOS `1.2.0800`；官方影视 `trim.media 0.9.8-1` 正在运行。满足项目最低 fnOS 1.2.0，影视版本与 README 的人工验证版本一致。
- 官方 CLI `fnos1` profile可用，应用商店搜索无此插件；若后续安装，应采用应用中心手动 FPK，保留应用归属。
- 本轮只做NAS只读检查及开发机隔离验证；没有上传安装包、执行安装回调、接管socket或修改影视配置。

## 发布物核验

实际下载 `fnmedia-ext-0.2.17-lite.fpk`，866759字节，SHA-256：

`770c68378998df5ffb9b334d81585cd727921ea6f8e79fb0e0f3353097cda9cf`

与GitHub资产digest及同Release的`.sha256`附件一致。解包后53个与公开仓库共有的文件逐字一致，含本次验证的代理代码。校验和证明下载一致性，不等同发布者签名或安全保证。默认同名包与Lite资产的GitHub digest相同。

独立审查还发现Full包含公开仓库未提供的模块和JAR/WASM、额外运行时；不能用Lite源码的审查覆盖Full。此次未运行Full、未安装Android运行时、未配置或播放外部资源。

## 决定暂缓安装的证据

| 问题 | 已验证证据 | 对飞牛1的影响 |
|---|---|---|
| Lite管理页初始化报错 | 发布包`app.py:3411`调用不存在的`providers.source_priority`；隔离GET `/v/api/ext/status`返回500、异常为`AttributeError`。`admin_ui.py:1265`初始化先await该接口 | 原版管理台不能正常完成初始化；安装成功或服务active也不能证明可用 |
| 管理写接口缺身份校验 | 不传Cookie/Authorization的POST `/v/api/ext/config`返回HTTP 200、业务code 0，测试标题实际写入隔离配置；管理HTML也匿名返回200 | 能访问该路径的客户端可修改插件配置；`admin_token`虽生成但未消费为鉴权条件 |
| 可借插件读取本机HTTP服务 | 发布包分片代理接受URL参数，无目标IP限制；匿名请求真实访问开发机`127.0.0.1`上的自建测试服务，并完整返回非空标记正文 | 将NAS可达内网服务暴露给插件调用者；测试仅访问自建fixture，未探测私人服务 |
| 在线历史按影片全局存储 | `history.py:68-103`以item_guid为键，`app.py:2385-2418`把同一`history.all()`合入每个请求，没有用户维度 | 多用户会共享在线播放记录；这是在线记录，不能据此声称官方本地影片历史也被泄露 |
| 强杀后恢复不完整 | `supervise.py:194-225`依赖finally恢复；unit为`Restart=no`且无`ExecStopPost`；再次启动遇非官方target及现存upstream直接退出 | SIGKILL/OOM等情况下可能留下死socket，使整个影视入口不可用；这是源码判断，本轮未在生产强杀验证 |

飞牛1的nginx `/v`直接代理到`trim_media.sock`，同时配置了系统安全码检查。无Cookie现场请求仍到达官方后端：扩展status路径返回官方501业务消息，`/v/`返回原影视HTML，没有跳转安全码页。**这不是插件管理页已暴露的证明（插件尚未安装），但不能把桌面图标权限或现有登录页当成扩展接口已有管理员鉴权。** 公网、FN Connect和访客网全部入口本轮未做可达性普查，不声称公网已暴露。

## 隔离测试结果与边界

使用下载包解出的原始Python代码，Python 3.12.3；FastAPI 0.162.0、Starlette 1.10.0、httpx 0.28.1。未执行应用lifespan，未启动资源抓取或更新后台任务；没有修改代理函数来制造结果。

```json
{
  "status_endpoint": {"http": 500, "source_priority_function_present": false},
  "anonymous_config_write": {"http": 200, "business_code": 0, "persisted": true},
  "anonymous_admin_page": {"http": 200, "bytes": 79961},
  "anonymous_loopback_read": {"http": 200, "exact_fixture_body": true, "fixture_hits": 1},
  "negative_invalid_target": {"http": 502, "not_fixture_body": true, "fixture_hits_unchanged": true}
}
```

真实loopback HTTP fixture只返回测试标记；无效URL负例没有再次命中fixture。未进行影视播放、NAS插件端到端、冷启动或卸载恢复验收，因此不存在“已安装可用”的结论。

## 维护风险与后续安装条件

插件以root运行，安装时在线安装未锁版本的Python依赖。默认每6小时检查更新，**不会自动安装**；但点更新会以root热替换文件，绕过应用中心正常升级登记。当前不建议开启或接入无人值守升级。

原官方socket现场已为0666，所以不能把0666本身描述成插件新降低的权限；新增风险是同一可访问socket承载了无鉴权管理接口。正常退出有恢复逻辑，不等于强杀/内存耗尽后一定能恢复。README的“不提供资源站”表述也不能代替代码检查：公开providers实际列出11个默认源、8个默认启用。

建议等待上游修复后重新验收Lite；若明确选择自维护加固版，需要覆盖以下完整范围，不能只补缺失函数：

1. 修复公开构建缺失函数并验证管理台及实际搜索调用链。
2. 管理接口验证管理员身份；播放/海报代理校验授权及目标地址，包括DNS解析、重定向和私有地址，避免绕过。
3. 在线历史、收藏与续播按已验证用户隔离。
4. 停用内置root热替换更新，锁依赖；保留应用中心统一升级。
5. 补独立socket恢复与启动排序，在隔离环境验证启动失败、正常停止、SIGKILL/OOM、官方影视重启与NAS冷启动，确认不误删后来新建的官方socket。
6. 安装前留档和回滚；通过官方CLI先dry-run，安装后分别验匿名拒绝、管理员入口、官方透传、真实播放及停用恢复。

仅加内网限制仍未解决当前管理台500和恢复缺口，因此本轮没有直接安装原版，也没有擅自改成需要长期维护的私有fork。

## 证据位置

临时调查目录：`/tmp/fnmedia-ext-review-20261028/`，含release元数据、原包、源码、隔离探针和聚合测试JSON；临时目录不是长期备份。本报告保留版本、摘要、哈希及证据边界。没有保存NAS密码、登录token、媒体清单或观看记录到仓库。

源码定位均相对上述commit：`proxy/app.py`、`proxy/providers.py`、`proxy/admin_ui.py`、`proxy/history.py`、`proxy/supervise.py`、`proxy/updater.py`、`deploy/fnmedia-ext.service.in`、`packaging/fpk/cmd/install_callback`。
