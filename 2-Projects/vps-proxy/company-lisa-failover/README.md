# 公司 Lisa 出口三层容灾

范围：Studio 首批；2026-10-23 13:30 经授权加入公司网络中的 Air。观察一个工作日后再准入 Mini / dev198。

实现文件：`controller.py`（Python 标准库）、`build_config.py`（纯配置变换）、`test_failover.py`（离线测试）。
本目录仅存无凭据代码、测试与交付说明。真实 Xray 配置和 SOCKS 凭据只在设备受限运行目录，禁止提交。

## 策略

- 每机独立、15 秒一轮（±1 秒抖动）；每条路径独立探测 HTTPS204 + Codex 未认证 models401。
- 401 只证明 TLS/目标可达，不等于账号可用、推理或长 SSE 验收。403/429 单独记录为目标拒绝，不能断言网络断开。
- 连续两轮失败才退出当前路径；候选须当轮两项探测均成功。恢复连续健康120秒、当前路径持有300秒才升优先级；当前路径失效时不受持有时间限制。
- 顺序 DMIT→Lisa、ZGO→Lisa、mesh→home-studio→独立固定 DMIT→Lisa。本轮全部失效记录 ALL_DOWN，当前路径连续失败达到门槛才选 blackhole，绝不静默直连或循环切换。
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
