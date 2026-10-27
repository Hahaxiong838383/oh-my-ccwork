# Air 受管界面与运行态维护包（2026-10-27）

本目录是本次Air维护版的源码入口，含无凭据脚本与离线回归；不含生产config/controller配置、节点凭据或个人日志。仓库中的候选、生产部署和线上验收是不同状态；是否已部署以对应回执与manifest为准，不凭文件日期推断。

## 源码与部署文件

| 文件 | Air目标 | 用途 |
|---|---|---|
| `xray-manager.py` | `~/xray/xray-manager.py` | Air历史功能、受管界面、配置写保护和精确launchd操作 |
| `managed_status.py` | `~/xray/managed_status.py` | 界面的只读、脱敏状态采集模块；必须与manager同目录 |
| `rule-updater.py` | `~/xray/rule-updater.py` | 受管资产pending与保inode日志轮转；不是界面升级的重启入口 |

**Air界面发布必须一起核对前两文件。** 上级 `../xray-manager.py` 是独立跨平台主版本，没有整文件回填Air历史差异；不能拿它覆盖本包或生产文件。保留Air既有 `easytier_manager.py` 扩展及其他服务，不在本包复制凭据配置。

controller项目入口为 [`company-lisa-failover`](../../vps-proxy/company-lisa-failover/README.md)，生产运行目录为 `~/xray/company-lisa-failover/`。历史Air工作树不是所有机器的固定源码路径，使用前核当前checkout和运行SHA。

## 界面如何判断状态

- `/api/managed-status`只读查询精确controller LaunchAgent和RoutingService `bi`，结合state时间戳。状态新鲜度上限45秒；缺失、损坏、过期、进程不明或控制面异常不显示探测正常，不拿旧selected冒充实时出口。
- 网络总体区分`healthy/degraded/blocked/stale/error/unavailable`；三路探针的业务成功与部分可达分开。pin显示指定路由和剩余TTL；过期pin不冒称仍在强制执行。
- 静态selector/fallback的`cf-block`单独标注。只有有效实际override才报告确认的出口；空override不会拿磁盘默认值填成“当前出站”。路由列表展示balancer目标、inbound等限制，避免把配置目标当运行证据。
- pending依据持久marker展示`pending_until_verified`；标记不存在只表示“无待确认记录”，不等于资源已生效。标记损坏显示未知/错误，不根据旧updater状态或PID变化自动变绿。
- 受管或状态尚未确认时，节点增删改、链接/订阅导入、端口、均衡组和路由写入口锁定。后端写保护与HTTP409是第二道防线；错误不能继续关弹窗、显示成功或触发重启。查看、日志和TCP测试保留；TCP测试仅测端点建立连接，不能证明经代理访问目标业务成功。

实际Air的`bi`输出带缩进和`- `前缀，解析与回归必须使用真实样本，同时覆盖CRLF、空override、外来tag及重复/混合格式，不能只用手造简化文本：

```text
  - Selecting Override:
    1   cf-dmit
  - Selects:
    1   cf-block
```

## 资产更新与日志边界

受管updater只更新磁盘geo资产、不自动HUP或重启Xray，`rule-updater.pending.json`保留到维护验证收口。标记应先于资产替换持久化；下载无变化、PID改变或配置校验通过不足以证明目标资源已加载，不自动清空pending。

受管access/xray日志复制到原子备份后在原fd截断，保inode并验证原描述符继续写入；复制与截断之间可能丢少量日志。其它日志沿用既有策略，不为轮转重启主服务。

## 安全发布与回退

1. 先读实际LaunchAgent路径、目标两文件SHA和当前服务/配置状态，确认本次拥有的变更范围；生成全部候选并完成离线检查，备份原文件及权限。
2. 写入前重读摘要，冲突则停止并重新合并；先原子写同目录helper，再写manager，最后仅重启 `com.xray.manager` 加载界面。逐文件记录回执，版本检查加原子替换不是跨文件事务。
3. 读回两文件SHA、API和真实8888页面，核原Xray、Grok专用代理与controller身份/健康。界面发布不调用主代理重启/停止，不清pending，不修改生产路由或guard。
4. 失败时只恢复仍属于本次版本的文件并重载manager；保留后续他人修改。需要主Xray维护重启以应用资源时另行验证guard、实际override和目标请求，原有连接不能自动迁移。

通用 `install.sh` 检测到controller配置或LaunchAgent即exit78；本包也不是跨平台安装模板。控制器byte/semantic guard、手动pin和外来override保护继续保留，不用改哈希绕过真实配置漂移。

## 离线验证

在本目录运行：

```bash
/usr/bin/python3 -B -m unittest discover -v
node test_manager_ui.js xray-manager.py
node test_managed_ui.js xray-manager.py
# 可选：已有 Playwright 与浏览器时，环境变量指向其现有路径；不安装依赖
node test_browser_ui.cjs
```

2026-10-27 12:20 Air 页面发布与验收已完成，详情见[复盘与防复发](复盘与防复发.md)。当前源码/部署摘要和历史运行基线分别保存在manifest中。

上级安装器守护测试为 `test_install_guard.py`，仅使用临时HOME与命令拦截；不执行真实安装。用实际解释器复跑，测试总数及生产验证以当次回执为准。文件摘要见 `manifest.json`，UI截图/状态快照不能代替部署后的新读回，也不代表长SSE或一个工作日稳定性已验收。
