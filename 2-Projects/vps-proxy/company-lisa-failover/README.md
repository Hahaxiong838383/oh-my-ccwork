# 公司 Lisa 出口三层容灾

范围：Studio 首批；2026-10-23 13:30 经授权加入公司网络中的 Air。观察一个工作日后再准入 Mini / dev198。

实现文件：`controller.py`（Python 标准库）、`build_config.py`（纯配置变换）、`test_failover.py`（离线测试）。
本目录仅存无凭据代码、测试与交付说明。真实 Xray 配置和 SOCKS 凭据只在设备受限运行目录，禁止提交。

## 策略

- 每机独立、15 秒一轮（±1 秒抖动）；每条路径独立探测 HTTPS204 + Codex 未认证 models401。
- 401 只证明 TLS/目标可达，不等于账号可用、推理或长 SSE 验收。403/429 单独记录为目标拒绝，不能断言网络断开。
- 当前路径服务连续两轮失败时优先改用当轮两项均成功的候选；恢复连续健康120秒、当前路径持有300秒才升优先级。所有候选都缺完整服务证据时，任一目标成功仍记可达并保留可达路径（DEGRADED）。
- 顺序 DMIT→Lisa、ZGO→Lisa、mesh→home-studio→独立固定 DMIT→Lisa。自动模式三路的两项探测连续三轮全部失败才从已选路径进入 block；冷启动没有既有路径时仍默认 block。单一共享目标失败不再使所有仍可达线路变成 blackhole。
- Xray `api bo` 改新连接的出口，无须日常重启。旧连接不迁移；首次接线需要维护窗口，重启 Xray 会断开旧连接。
- 控制器用独占锁；API 选择读回验证后才记录切换成功；Xray 重启默认 block，控制器重新探测后恢复。
- 控制器崩溃由服务管理器拉起。控制器停止并不会撤销 Xray 已存在的 override，因而手工维护需先 pin block 或执行回滚，不能只停控制器当作网络熔断。
- 状态文件不跨进程继承健康计数，避免设备睡眠/长停机后用旧健康做决策；超45秒采样间隔重置健康证据。
- 可限时手动 pin；到期自动回自动模式；pin 路径本轮不可用则 block，不强行通过失效路径。

## 操作

`python3 controller.py --config <controller.json> --status` 查看最近状态。
`python3 controller.py --config <controller.json> --pin zgo --duration 900` 临时固定15分钟。
`python3 controller.py --config <controller.json> --pin auto` 恢复自动。
`python3 -B -m unittest discover -v` 离线测试。

## 安全/准入

Studio 对应家中独立 Xray 仅监听 EasyTier IP，SOCKS 用户密码认证+来源IP白名单。Air 使用另一独立 loopback-only relay，严格主机校验的 SSH 隧道 + 独立 SOCKS 凭据，避免 mesh 源地址改写导致白名单失效。两者固定 DMIT、不指向家中通用自动代理。原10809仅允许10.10.10.24的转发保持不变。私网/本机目标禁止转发，避免代理环路和横向访问。
每次部署先检查端口、配置哈希、任务空闲；备份+校验+原子替换；无关分流不修改。Mini现有Lisa规则可精准替换；dev198目前没有Lisa规则，不能将main-balancer整体换成Lisa，需在推广门禁时明确新增业务域名范围。

## Air 扩展

`air_ops.py` 提供用户级 launchd prepare/apply/rollback；`add_air_relay.py` 安装家中独立 Air relay。只替换 Air 原指向 `admin-LISA-DMIT-11443` 的四条规则；现有 ZGO/X/Grok、GitHub balancer 及其他分流不变。家中备用经 Air loopback10832 SSH 转发到 home loopback10811，既有公司10810不改。实际部署、验证边界及回滚详见 DEPLOYMENT.md。

## 复盘

`RETROSPECTIVE-20261023.md` 记录证据链、失败教训、发布范围和未完成门禁；稳定操作原则已同步到共享 xray skill。

## 2026-10-27 防复发维护

- `controller.py` 同步 Air 已验证的部分可达/三轮全断策略和生命周期诊断。静态配置仍默认 `cf-block`，严格 pin、foreign override 拒绝、数组顺序及完整配置内容保护保持。
- `air_ops.py prepare` 从实际候选字节计算 byte SHA 和 `controller.canonical_config_sha256`，不在纯配置模板里凭空生成基线。语义签名只忽略 JSON 对象键顺序与空白；真实字段、值、数组顺序变化仍拒绝，重复 key / NaN 拒绝。后续 prepare 必须使用本目录配套 controller。
- 原 `test_failover.py` 仅更新三返回探测协议和三轮全断预期；原安装/回滚/守护断言保留。`test_controller_regression.py` 为49项回归，可通过 unittest discover 或传入待测 controller 路径运行。`test_air_prepare.py` 验证实际候选的两个签名与 manifest 一致。
- `air_ops.py` apply/rollback 面向首次安装和原始 manifest，不是当前运行态的增量升级工具。已有安装不能整套重装或拿旧 manifest 回滚；增量更新须按当前 SHA 校验、受限备份、原子替换和单服务验证。
- Air `~/xray/rule-updater.py` 的受管模式只更新磁盘资源，持久记录 `rule-updater.pending.json` / `rule-updater.status` 的 `pending_until_verified`，不自动 HUP。当前 UI 没有新增 pending 展示；PID 改变不足以清除此标记。日志 copytruncate 可能丢失复制与截断之间的少量日志。
- manager/updater 运行态脚本与离线测试归档在另一真源 `~/mycc/2-Projects/xray-manager/maintenance-20261027/`；manager 主源码与运行态存在历史差异，不得以旧 install.sh 覆盖已有受管安装。
