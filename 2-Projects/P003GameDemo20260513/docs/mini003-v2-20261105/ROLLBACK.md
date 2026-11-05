# mini003 v2 发布与回滚

运行候选：a92bd8f342144d6253cbb9a928925639ffa597cc。发布前源码标签 `rollback/p003-mini003-server-pre-20261105` → 78612abfb0a4a49151dd64d3aa783aa45f1000c3，已推送并独立核远端相同。

发布7文件：device-enrollment-proof/store、routes/device-enrollments、ble-binding-store、routes/ble-bindings、device-credential、routes/device-session。每个before必须匹配当前线上，after必须匹配固定Git候选。仅原子替换这些文件；不覆盖整树、后台、微信体验版、APK或搜索/倾听候选池。

部署前备份devices/pairing/accounts/profile四库（SQLite在线backup），保存7个before文件、manifest和环境SHA。无新增数据库迁移、环境变量或设备开关变更。先重载Analytics共享鉴权读取器并验ready，再重载主服务验health；个人站保持原PID。

优先回退新增接入：运行本次服务器备份目录的 `rollback-new-enrollment.py`。该脚本在3个enrollment文件after哈希仍匹配时恢复它们并重启主服务，使新v2接入暂停；保留已登记数据、ble-key-v1领证、凭据认证和本次激活归因修复。已发但未确认的v2挑战需停止现场流程，恢复版本后重新申请。备份目录以RELEASE_EVIDENCE.json为准。

不要盲目把7个文件全部回退：完整退回旧BLE激活逻辑会重新带回“旧凭据点亮新receipt”缺陷。若必须完整退代码，应先暂停联调并评估已签发凭据/回执，不自动恢复数据库。库备份只用于取证或另行数据恢复，禁止整库回灌、清owner、删密钥或清应用数据。

本次变更不具备厂商证书/防克隆认证功能：它沿客户端已实现的设备自持公钥与本机确认完成登记，不增加出厂PKI，也不宣称证明硬件真伪。

署名：codex（OpenAI）| 2026-11-05
