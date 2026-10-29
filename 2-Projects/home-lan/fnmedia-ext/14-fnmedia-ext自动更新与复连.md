# fnmedia-ext 自动更新与复连（2026-10-29）

用户要求插件可随时更新，官方影视升级后自动匹配、复连，并每日更新海量内容；不改官方影视。已将独立 Lite 加固版由0.2.17.1升级至0.2.19.1。13号报告中的“永久禁更新、官方变版必须人工启用”已由本方案替代。

## 最终机制

1. 管理页更新按钮 → NAS非敏感队列 → home-studio 用户 timer每分钟处理、每小时查上游。升级保留鉴权/CSRF/SSRF/用户隔离和恢复加固。受审基线v0.2.19；核心代码有变则needs_review，不自动执行未知上游代码。
2. 官方完整进程身份核验；已核版直接连接，新版公开协议通过进入试运行，60秒复查，失败15秒重试并还原官方入口。明确手动停止保持停止。未知登录/搜索/播放协议仍可能需要适配。
3. 热榜21600秒、海量库86400秒。海量库刷新路由和影片首页；不是仅刷新分类，也不全量抓取所有分页。失败保留缓存并退避，部分失败如实显示；首页影片与路由持久化。

## 真实升级入口

官方CLI0.1.1 install-fpk dry-run返回canUpgrade=true，但install/task报10236，原版仍正常。app update --package-type local/file都卡在cloud download/task。没有卸载重装。

维护器补了临时loopback TLS CONNECT适配：固定目标飞牛1，只改fnmedia-ext的download/task来源为固定目录FPK，CLI仍自己处理OAuth、正式update guard、update/task和轮询。真实update task `1793233976960255234-fnmedia-ext` 成功。未导出/解密/复制CLI凭据，未用NAS密码登录API。

源码：`4-Assets/Code/fnmedia-ext-hardening/`，维护器在maintenance子目录，运行态在runtime/fnmedia-ext-managed。上游93a781b1813eaaa83723765f38e6e4dddd60a651，加固源码39577bdec8e20b7e75b1b24c61dc6caacb6b9101。FPK SHA256 `9f03f21e9a108aaf9aba7f47f4a27dfdc2f2fd02ec69ce286182339d715df4a4`。

## 数据与证据

升级前NAS私有完整state备份：`/var/lib/fnmedia-ext-backups/pre-managed-20261029T000633Z/state.tar.gz`，SHA256 `87662159aa83403ce0bdff82548701e62d919831b54b4b7d8f7b110ca01df61f`；新回调还会为后续升级保存持久恢复点。用户启用状态及配置/历史摘要一致。

部署后官方PID7511、原socket inode3051保持，官方程序/manifest/nginx三SHA与上一轮一致；匿名管理接口401，HTTP子进程cap全0。自动刷新真实成功，海量四类首页18/20/20/20条，热榜160/160/160/138条。维护timer已真实执行GitHub检查并显示上游0.2.19/本地0.2.19.1。

108项插件回归（真实UDS/恢复/兼容/内容/权限），27项更新准备器、31项维护器用例通过。公开协议已在NAS只读验证，包括用改变的测试基线验证probation分支，未更改官方文件。

## 边界

home-studio需在线才能检查/执行插件版本更新；NAS内容刷新及复连独立运行。上游核心代码变化仍需维护；公开探针无法证明未来登录与播放协议兼容。fnOS可能拒绝降级，自动回退只做尝试，拒绝时保留恢复点和失败状态，不能称已经回滚。未实际升级官方影视、重启NAS或重测TV/真实外站播放。

## 最终验收补充

- 应用中心stop后跨过维护timer触发仍保持inactive，上游socket消失且官方入口恢复；随后start正常。
- SIGKILL插件监督进程：0.11秒观察到官方入口恢复，16.96秒新插件重新接管；官方PID7511保持，NRestarts=1是本轮故障演练。
- 管理更新真实排队函数分别提交check/update，均被每分钟timer自动消费；update在当前已最新版时正确返回up_to_date，没有重复安装。当前maintenance_online=true、pending=false。
- 安装后83个打包载荷文件逐SHA一致；差异补丁从干净v0.2.19重建72个Git源码文件逐字节一致。
- 重启/强杀之后再查：配置/历史保持、自动内容刷新成功记录与四类首页缓存仍在；官方三SHA仍一致。
