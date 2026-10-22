# 指定 SN 灰度运行说明

本目录为候选运行模板，最新R6记录见 [验收与回滚](../../../../docs/search-tools-20261021/R6_ACCEPTANCE_20261022.md)。记录仅为当时快照，接续必须重核线上开关/截止/版本/运行SHA。

- 独立入口 `src/search-canary-main.ts`，仅 loopback 3007；导入 store 前校验全部数据库、音频路径，拒绝越界/未知 DB 键/数据符号链接与硬链接；systemd 再限制写权限。
- 不导入普通 index.ts，不挂载设备签发/OTA/遥测/Analytics/人格日批。关闭记忆提取及音频生成。仅复制目标设备必要人格配置/回声文本快照，不回灌生产。
- HTTPS 独立前缀，精确 `/v1/` 路由；不公开健康与管理 API，不记带 token 的 URL。候选账户+独立 JWT secret+API key+完整 SN 三层限定。
- 生产最小补丁仅 device-session.ts / search-canary-policy.ts / search-canary-runtime.ts。首句合同原样计算，候选同时写 JWT/响应；到期或健康租约失效回原 agent。
- Worker 每5秒上报受鉴权心跳；Brain 给15秒租约，生产签发异步缓存。候选满载不续新派单租约；注册/心跳状态不代表音频通过。
- 开窗必须同时准备候选 config 的 expires_at_ms、Worker window.json 和生产同名窗口标记；最后才启生产派单。窗口最长2小时；默认关、空名单拒绝、P2默认关。
- 截止时生产派单自动回原路径，候选搜索拒新/取消待播，Worker watchdog 在下一秒关闭候选房间；设备结束旧会话重连即签原 agent。不是会话内无缝迁移。
- 提前关窗顺序：生产 `p003.search.canary.enabled=0` → 候选 `p003.search.enabled=0` → Worker window.enabled=false → 确认 active jobs=0 → 停候选。
- 恢复共享签发补丁只还原 R1 对应文件/配置；Nginx只撤本次location，先 `nginx -t` 再reload。禁止整库回灌。保持原子替换、关闭失败默认拒绝。

更新纪律：等待上传进程成功退出，核候选产物字节数和SHA与构建清单相等，才可stop/替换/start；禁止传输未完成先改名或安装。截止前不足6秒的新票据回原路径，避免违背现有最短TTL。

## R4：明确授权的两设备名单（2026-10-22）

候选支持严格1至2台完整SN，空、重复、短SN或超过2台均拒绝；生产派单、候选Brain及Worker三侧名单必须一致。候选Brain的`SEARCH_CANARY_SN`为逗号分隔完整SN（不带空格），`SEARCH_CANARY_MAX_JOBS=2`须与Worker的`WORKER_MAX_JOBS=2`一致；缺省仍1。满载不续派候选，非目标仍走原链路。

Worker窗口新格式使用`allowlist`数组，不再填`sn`；旧单`sn`格式兼容，但同时非空提供`sn`和`allowlist`会失败关闭。窗口和环境名单不一致也拒绝已有会话，因此删设备或回退必须协调三侧，不只改单处。到期脚本保留名单，只关闭匹配截止的窗口；不滚动延长。

本次新增00100004、保留03800006，固定2026-10-22 23:59 CST截止、P2关。实时结果与恢复点见项目文档`docs/search-tools-20261021/R4_TWO_DEVICE_CANARY_20261022.md`，旧单机快照不覆盖新授权。
