# P003 倾听管理配置发布回执 · 2026-10-30

## 结论

北京时间2026-10-30 09:50:48，Worker管理后台 → Worker Brain → 倾听模式配置已部署。管理配置可保存、回读、审计和恢复；**真实倾听授权、音频输出与Android确认尚未接入，总闸关闭，空设备名单，禁止开启（HTTP409）**。这是后台管理能力发布，不是整套倾听功能的真机验收。

入口：https://kidshub-ai.hahaxiong.cc/admin/ 。管理员重新登录后进入Worker管理 → Worker Brain，顶部可见配置卡。已验证公网全站真实登录、导航、v3配置读取、六项数值字段、关闭总闸和重新载入，浏览器pageerror为0。截图见`admin-listening-production.png`，仅截配置卡。

## 发布范围与验证

- 源码锚：`beafc98013b016fa80444021cf6e1cd4bc40e0d6`（业务提交`22505d8b`）。三方核对生产/`5426e78e`/新提交，当前线上两份共享文件与基线相同，无冲突。
- 新增`listening-policy.ts`、`listening-settings.ts`、`listening-settings-store.ts`、`routes/listening-admin.ts`，修改`routes/admin-data.ts`和管理HTML，共6文件。只发布主Brain/管理页。
- 服务器隔离目录`/opt/p003/listening-admin-verify-20261030`用生产src副本加精确发布文件验证：管理API38、store12、原签票45、filler policy、pure policy4及全量TypeScript检查通过；复用现有依赖，无新增安装。
- 切换前两次LiveKit活跃房间为0。只停止/启动`p003-voice`，恢复health约2.29秒，PID3152068→3213742；stop/start方式PM2 restart_time保持40。未以restart_time不变宣称未重启。
- 真实管理接口：匿名401，editor/guest GET/PUT均403；同值保存v1→v2、旧revision409、开启409、恢复默认v1→v3，最终关闭/空名单，两条审计。未改任何设备策略。
- 首次真实GET完成两表初始化，实际库`/opt/p003/server/data/config.db`。保存/恢复经过真实数据库并回读。
- 公网HTML SHA256：`555b1dd33159966ee7183d204ed145104d14cf22e522a95a5ea2d66e0439b60f`，与发布文件一致。
- 主/候选Brain未涉及源码、env、preview二进制及搜索/filler flags保持；候选Brain PID3151603、Analytics PID3192914、个人站PID1626403保持。普通/候选Worker未部署。
- 本次未进行真实设备聊天实听；未把配置页上线当成音频链路通过。

## 即时备份与回滚

备份：`/opt/p003/backups/listening-admin-20261030T015046Z`。含触及文件原件、旧/新SHA清单、切换前一致性config.db备份、回滚脚本；全部保存在服务器受限目录，凭据不入代码仓。

```sh
# 只核验本次部署文件没有再次被更新，不实际回滚
python3 /opt/p003/backups/listening-admin-20261030T015046Z/rollback.py
# 确认空闲后执行文件回滚；脚本若检测到后续文件改动会拒绝
python3 /opt/p003/backups/listening-admin-20261030T015046Z/rollback.py --apply
curl -fsS http://127.0.0.1:3001/health
```

已执行脚本dry-run；未为演练再次停线上服务。回滚只恢复本次6文件，删除本次新增模块；**保留新增两表和审计，不回灌整库**。config.db备份仅作灾难恢复证据，不用于常规回滚。真实授权链路将来上线仍需新→旧→新隔离演练。

## 开发接续

后续任务分工见`DEVELOPMENT_NEXT.md`。继续使用现有Codeg会话38（Brain）和39（Worker），两条专用分支；派发后的实际状态以对应会话为准。本轮发布锚先冻结，后续代码只进开发树，不自动部署或开闸。

署名：codex（OpenAI）| 2026-10-30
