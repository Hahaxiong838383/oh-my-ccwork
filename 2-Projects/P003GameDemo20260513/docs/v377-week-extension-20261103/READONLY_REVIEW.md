# 会话48：同ID延期一周只读评审

结论：在当前请求仍ACTIVE且cfg66仍指向该ID的前提下，可由13执行一次性严格CAS，仅延长expires_at_ms。无需换ID、bump配置revision、重启或放宽常规创建API。此结论是代码/线上只读核验，未代执行生产延期、未证明设备上传。

## 根因与实时语义
- ConfigStore.createAnalyticsDiagnosticRequest对ttl_seconds强制60..86400；不是DB CHECK，也不是接收端二次最长寿命校验。
- analytics/index.ts:103首读授权，:124在读解压/校验body后再次readAnalyticsDeviceContext，:134把最新该批context交writer。device-context.ts:16每次新建readOnly连接，:58读取诊断请求；无跨批grant缓存。writer/writer-thread只是将该批snapshot移交事务。已在途批使用旧snapshot，不能宣称改库即时改写在途任务；当前旧expiry距现在10小时，故延期不会使已在途合法批失败。
- tiers.ts:29–38校created<=now、sn、revoked、expires、allowedsource、收到时lookback3d和累计quota1000，没有expires-created<=86400约束。
- admin HTML:1431直接比较r.expires_at_ms与Date.now，显示真实时间。列表需刷新后看到新期限，旧已打开UI不会被主动推送更新。创建表单/API继续最多24h属于正常边界。
- device snapshot只暴露ID/开关/队列策略，不含expires。只改server grant行不会改变客户端快照，不需要revision；人为bump反而触发无意义重应用。ConfigStore按SELECT读行，不缓存request；下一次admin GET可见新expiry。

## 线上独立证据（12:38:32 CST）
- cfg66，当前ID diag-121d6b4b-a9ed-43b2-975c-786542d8b9ae，ACTIVE，旧expires1793719799775，created1793679950775，1000/3d/14source，未撤销。
- 主Brain和receiver按实际/proc进程环境+cwd解析均 /opt/p003/server/data/config.db；stat dev64771/inode261784一致。主Brain实际node子进程3937890确有该config.db打开FD；PM2父PID未必是DB持有者，已检查子链。receiver短连接不常驻FD符合readOnly每次open/close源码。
- PM2 voice3937878/restarts48，analytics3937833/restarts9。9关键服务端文件以及实际部署admin HTML均逐字节匹配856552b9。证据runtime-read-48.json、fds-48.json、source-check-48.json。
- 设备配置所有行的规范化SHA保留于runtime-read-48.json，供前后对撞；没有输出密钥/正文/全SN。

## 13最小操作建议（48未执行）
1. 生产私有备份目录保存目标row、config/meta、上传策略、usage当前值、相关表结构/DB路径inode、进程/源hash、执行脚本hash与授权来源；完整SQLite备份使用backup API，不裸cp WAL主文件、不恢复整库。
2. 开BEGIN IMMEDIATE短事务；重新读目标SN+ID，检查未撤销、now<旧expiry、cfg仍相同ID/upload/capture=true及created/quota/lookback/sources等expected值。new_expiry=事务内实际now+604800000。更新WHERE包含SN+ID+旧expiry+revoked IS NULL及其他expected；UPDATE仅expires列；changes严格1，否则rollback停止，不重试覆盖新状态。
3. 外部审计回执记录old/new expiry、实际执行时间、before/after该行diff、config_meta/device_config保持、usage不重置、所有不变量。无需为审计改业务表或添加服务feature；整窗quota1000不会每日恢复，lookback3/诊断payload保留3天也不会变成7天，7天末检查全部原始payload不是合法验收要求。
4. COMMIT后独立新连接读取；13可GET管理页确认新期限及设备快照cfg66/同ID，再核receiver路径、ready、仅038/daily23、source/PID/Ark授权和倾听清单未改。48保持只读，不主动POST事件验证，不触发语音。
5. 操作前确认没有独立旧23:30关闭timer覆盖本次同ID延期；原创建脚本没有创建此timer，不把历史窗口timer等同本次。新自动轮换/每日request/重启均无需。
6. 回滚只能CAS同一ID和expected新expiry→旧expiry。旧截止已过后恢复旧值等于立刻到期，需13明确决定结束授权，不能自动回旧过期值，更不能清seen/usage或回灌配置库。

## 关联资料要同步的点
- 本轮原reconcile_readonly.py固定旧expiry+1h截止，**不能原样用于完整一周对账**，否则11/4凌晨后的数据被过滤。13延期回执到后，运维文档须写明新期限；按指定日期/真实RID做有界查询或更新该审计脚本窗口常量（不是生产feature），防止读查产生假零。
- 用户一周授权只延长此诊断请求生命周期，1000仍整个一周累计；满额后新样本会拒收，不可承诺整周零拒收。
- 不换ID避免客户端durable旧请求样本被撤销；但延期不复活此前旧diag-15f...请求，也不让超过3d的样本变合法。

以上为执行前评审。13随后执行延期；48已于12:39:58独立回读核实，详见本目录EXTENSION_RECEIPT.md。48无生产写入。

署名：codex（OpenAI）| 2026-11-03 12:40 CST
