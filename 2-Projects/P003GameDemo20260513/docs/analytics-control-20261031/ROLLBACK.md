# 发布与回滚记录

发布采用逐文件SHA校验与增量覆盖；普通Brain基线0708d768，P2使用现场源码三方合并后的独立patch（apps/server/deploy/analytics-control-20261031/p2-integration.patch）。实际备份路径、文件前后SHA及进程记录在发布回执补记。

1. 发布前备份本次涉及的源文件、管理页、三份环境文件，以及config.db/devices.db的SQLite一致性副本；记录已有Analytics最近备份。conversation新增列、identity epoch和Analytics索引为向后兼容增量，不恢复整库、不丢发布后新数据。
2. 只重启p003-voice、p003-analytics、p003-search-brain。Rust Worker、SFU、个人服务及倾听Brain不变。原搜索名单/窗口、倾听开关及Analytics旧单机范围不变。
3. 首选后台“数据埋点→上传管理→关闭全部上传”；API为GET control读取revision后PUT enabled:false。Analytics不可达时仍能保存关闭。物理保护闸保持独立，可按旧analytics-control.py关闭作为兜底。
4. 方舟关闭：GET /v1/device/ark/admin/settings获取revision，然后PUT {expected_revision:<当前>,enabled:false,subjects:[]}；清grants/当前快照，不删Analytics或对话审计。旧不带revision的调用已不适用。
5. 必要时核当前文件仍为本发布SHA，恢复备份内同名源文件及环境文件；新增且仍等于发布SHA的文件可移除；重启对应三个进程。管理页原子恢复。保留新增列、触发器、索引，不能删除epoch后继续用旧grant。若后台已修改上传名单，先明确记录/关闭总闸；旧代码只认识旧env名单，不能盲目回退后重开已撤销设备。
6. 回滚后核main/analytics/P2健康、原单机23点配置、未授权接口拒绝、个人服务/倾听PID未变。不得在代码回滚中恢复旧数据库来覆盖新会话或埋点。

P2通过专用secret与回环只读接口取主Brain授权事实，150ms总截止，普通聊天不请求；服务端校验socket回环，公网nginx /internal不转发本路由。Ark新环境键不放入P2 *_DB_PATH，不破坏工作树隔离。
