# P003 T0/T1 前置审查

模型 Grok 4.7。分支 codex/p003-prnas-storage-50-20261116 @ d8bd447cccf4。未做 T0。dashboard.ts:14 也看 ceiling。

1. ConfigStore：事务内对 revision 在 config-store.ts 225–239。跨进程每次新连接（device-context.ts:49）。勿用无 revision 的 setFlag（306–314）。setValue 会抬设备 cfg（346–358）。改法：配额入 runtime_flag，照抄该事务；补 busy_timeout。勿进设备键。

2. 四道门：contracts.ts:29 max(32)；store.ts 20、36；service.ts:14 slice(0,32)，空 env 默认一台；routes.ts 15/31/38/42 与 service.ts:18 都看 ceiling。种子只一次写 ARK_CONTEXT_SN_ALLOW，之后不读 env。authorize（33–42）无 revision 且强制 enabled=1；configure（24–27）删表外 grant。改法：两边在 BEGIN IMMEDIATE 内重读对方；低于已启用数则 409，不改名单。管理体 4096（routes.ts:37）改 64KiB；快照保持 16384。

3. capacity.ts 22–23 夹到 20，是硬顶。已验证是 14×84000（ANALYTICS_MEMORY.md 第8行）。第14、29行是保留/样本窗，不是台数。缓存 60 秒且不看 revision（28）；路由只拒超 120 秒（control-route.ts:37）。改法：已验证写 14，Ark 留空，勿写 20/50。新增取 min(磁盘,维护,已验证)；已有名单不自动关（34–38）。缓存键加 revision。保留 twenty_devices_*。

4. 三份名单：index.ts:51、service.ts:28 SEARCH_CANARY_SN、search-admin.ts:9 max(32)。preview 仍被 ceiling 挡住（runtime.ts:25）。改法：代理改为 enabled 且有当前 grant。勿放宽搜索或倾听。

5. UI：GET/PUT /api/admin/analytics/control（admin-data.ts:2189；页面 5010–5016）。无 storage 路由。新路由做兄弟，不改上传体。“20台”（约1454行）改为规划、已验证14、安全上限。

未验：未跑服务，未读生产库。未测锁。生产名单另验。
