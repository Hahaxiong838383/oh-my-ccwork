# 指定 SN 灰度运行说明

本目录为候选运行模板，是否已部署/开窗以 `docs/search-tools-20261021/CANARY_ACCEPTANCE_20261021.md` 实际记录为准。

- 独立入口 `src/search-canary-main.ts`，仅 loopback 3007；导入 store 前校验全部数据库、音频路径，拒绝越界/未知 DB 键/数据符号链接与硬链接；systemd 再限制写权限。
- 不导入普通 index.ts，不挂载设备签发/OTA/遥测/Analytics/人格日批。关闭记忆提取及音频生成。仅复制目标设备必要人格配置/回声文本快照，不回灌生产。
- HTTPS 独立前缀，精确 `/v1/` 路由；不公开健康与管理 API，不记带 token 的 URL。候选账户+独立 JWT secret+API key+完整 SN 三层限定。
- 生产最小补丁仅 device-session.ts / search-canary-policy.ts / search-canary-runtime.ts。首句合同原样计算，候选同时写 JWT/响应；到期或健康租约失效回原 agent。
- Worker 每5秒上报受鉴权心跳；Brain 给15秒租约，生产签发异步缓存。候选满载不续新派单租约；注册/心跳状态不代表音频通过。
- 开窗必须同时准备候选 config 的 expires_at_ms、Worker window.json 和生产同名窗口标记；最后才启生产派单。窗口最长2小时；默认关、空名单拒绝、P2默认关。
- 截止时生产派单自动回原路径，候选搜索拒新/取消待播，Worker watchdog 在下一秒关闭候选房间；设备结束旧会话重连即签原 agent。不是会话内无缝迁移。
- 提前关窗顺序：生产 `p003.search.canary.enabled=0` → 候选 `p003.search.enabled=0` → Worker window.enabled=false → 确认 active jobs=0 → 停候选。
- 恢复共享签发补丁只还原 R1 对应文件/配置；Nginx只撤本次location，先 `nginx -t` 再reload。禁止整库回灌。保持原子替换、关闭失败默认拒绝。
