# 自动接入发布与回滚记录

运行候选：`60485d45e566eba7b6e26277e925b8e68852a16b`。基线：`7ccd1f7cd3e9c23b148c4712686dc1a17cdc297a`。独立分支：`codex/p003-auto-enrollment-20261104`；基线标签 `rollback/p003-auto-enrollment-pre-20261104`，均已推送并核远端 SHA。

## 实际发布

- 2026-11-04 15:35 CST，aliyun-hk `/opt/p003/server`；仅六个运行文件：新增 proof/store/routes/tool，index 挂路由，旧 BLE 路由仅导出两个现有函数。未部署 package.json、未安装依赖、未全树覆盖。
- 发布前六文件逐一核 before SHA、新文件必须不存在；源文件备份与 SQLite backup API 一致性备份完成，数据库 quick_check=ok。
- 备份目录：`/opt/p003/_backup/auto-enrollment-20261104T073507Z`。`manifest.json` 记录 before/after SHA，`release.json` 记录实际发布结果，`rollback.py` 为漂移拒绝的逐文件回退脚本。
- 主服务 `p003-voice` wrapper PID 4049589→4172529，PM2 restarts 49→50（本次主动重启一次）；个人服务 1626403/0、埋点服务 3937833/9 未变。进程后续观测 823 秒保持同 PID/重启数。
- 新增两表 `device_identity_statement`、`device_enrollment_challenge` 及索引；既有设备/凭据/回执表沿现役合同使用。迁移不填充设备台账。
- 发布前后及稳定性复验17台设备的 SN/status/owner/policy/version 摘要一致：`85ff7bd7bd5bdeaaee57d368be5dae3fd01b9b4c90b34f0f1effeaac63e332f9`。C 未登记；没有替设备签名、制造 owner、清解绑或发真实短信。

## 开关与凭据

`/opt/p003/server/data/device-enrollment-config.json` 权限0600，动态读取，配置结构详见源码。已启用 2026-11-04 15:35:07.605 至 11-18 15:35:07.605 CST。签名 secret 与工位 Bearer 为分别生成的32字节随机秘密，不写 Git、日志、Markdown或 Downloads。

工位凭据已安全安装 Studio/Air `~/.config/p003/identity-provisioner.json`，Air工具已用公网有效授权+非法公共输入验证，预期400，没有签发身份。新工位安装凭据应沿安全运维通道，不从截图/聊天传递。

密钥轮换必须同时更新 `issuer_key_id` 和 `signing_secret`，再由可信初始化工具重取同一身份声明；只换 secret 不换 issuer 会使旧声明幂等复用但验签失败。既有已绑定设备正常鉴权不依赖声明继续有效。不要把本次14天接入窗口当作设备业务凭据有效期。

## 常规停止与精确回退

1. 优先原子修改新配置 `enabled=false`（保持0600及其他字段），停止新签发/challenge/首次confirm。已提交回执、claim及设备鉴权不受这一个新开关限制；原有claim时限和撤销校验继续生效。
2. 如需回退运行代码，先核现场 manifest；执行已落盘的 `python3 /opt/p003/_backup/auto-enrollment-20261104T073507Z/rollback.py`。脚本先关闭新登记，逐文件核当前仅能为before或after SHA，有漂移则拒绝；恢复两个旧文件，删除本轮四个新增文件，再仅重启主服务。
3. **不得恢复整库覆盖当前数据**。保留新增表、真实签发/绑定记录与现有用户归属；旧代码能继续处理已生成的标准 BLE 回执、claim、鉴权。备份数据库是取证/灾难恢复锚，不是常规代码回滚步骤。
4. 回退后核 `/health` 的真实 JSON、PM2 PID/计数、旧绑定/claim/账号隔离、设备归属摘要；新登记不可用符合回退目标。

已把真实生成的 rollback.py 在服务器私有文件镜像执行：旧文件完整恢复、新文件删除、配置关闭、模拟数据库保持原样；模拟并发漂移拒绝。实际生产没有执行代码回退，也没有恢复数据库。

## 测试记录中的非代码失败

- 初始新流程第一次绿测发现 JWS audience 字面量不一致，修复后真 HTTP/边界/独立复验通过；原失败日志保留。
- 首次远端部署探测误读 `.env`，实际启动用 `.env.local`；在任何生产写入前终止。纠正只读 PORT 路径后发布成功。
- 首次公网旧短信空body断言写成 bad_request，现役合同返回400 bad_phone；纠正测试期望后通过，没有改短信源码/发送短信。
- Node22执行Analytics测试触发既有SQLite安全保护，按实际埋点Node24重跑通过。未绕过保护。
- 全仓tsc仍有12项旧错误，与独立基线日志逐字节相同；不将其报告为全绿。

私有完整证据：`/Users/fu-121/.local/state/p003-miniapp-bind-c-20261104`。公开可审摘要见同目录 `PRODUCTION_RELEASE.json`，不含秘密。

署名：codex（OpenAI）| 2026-11-04
