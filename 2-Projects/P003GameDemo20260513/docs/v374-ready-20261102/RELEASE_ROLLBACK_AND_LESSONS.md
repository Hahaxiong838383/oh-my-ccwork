# v374 服务端发布、回滚与经验记录

本轮目标是完成服务端修复并开到可联调阶段。正式交付见 [P003_V374_READY_FOR_JOINT_TEST_20261102.md](P003_V374_READY_FOR_JOINT_TEST_20261102.md)，证据 [SERVER_READY_EVIDENCE.json](SERVER_READY_EVIDENCE.json)。旧v374-joint文档是历史阻断记录，不能再作为当前状态。

## 发布锚点

- 主 Brain业务提交：7c47de178013ad8cd5dd563b7302be19fccda87e，分支codex/p003-analytics-control-20261031。
- 原38倾听 Brain：cf6ef97a35b8e1c94fb7892316a56d9243684f46，分支codex/p003-listening-brain-20261030。
- 原39 Worker：b663e0e09d423ba282e21e242569774466fcfdb0，分支codex/p003-listening-worker-20261030。
- 运行二进制SHA256：`c2c8081581ae86c8155bbaf51af5eec34a05454bf8c3d8047fb74b326adcb4f5`。
- Joint冻结输入对应最终Brain bundle字节一致，SHA256 `f8c0b92ec702c2c8eee414c81b266794d8d527d84503f6a51ec4833270ff9889`；真实执行2项，不把ignored当通过。
- 唯一窗口generation：`v374-listening-ark-20261102-1793613511`；起止 2026-11-02 18:09:43 至 2026-11-04 17:58:31 CST。
- 普通Worker/P2 Worker未重启：PID1825469/2143116，SHA见证据。主Brain已重启；Analytics/个人服务未重启。旧搜索窗口没有恢复。

## 回滚点与操作顺序

远端备份（受限权限，不推Git）：

- HK `/opt/p003/backups/v374-ready-20261102`：原src、环境、manifest、凭据与仅供取证的config SQLite备份。
- Worker `/opt/p003-listening-canary-20261030/backups/v374-ready-20261102`：原二进制、环境、窗口及before/deployment记录。
- 原Worker SHA256：`29c84c8d3d508534faa9c4948b978521a41b5e7cd95cfbd2914324682b141421`。
- 本地私有执行证据：`/Users/fu-121/.local/state/p003-v374-ready-20261102`。凭据与原始业务快照不得复制进Git/交接包。

先核对当前agent、generation和deadline，避免关闭后来的新窗口。回滚顺序：

1. 主config库仅将匹配本generation的`p003.search.canary.enabled`置0，记录actor/时间；倾听管理API `/api/admin/worker-voice/listening/disable`关总闸并保留revision/audit。
2. Worker对匹配代次的window原子置enabled=false（保留4个合同字段），确认jobs归零、持久关房补偿healthy、相应房间已不存在。只关闭这次候选，不能删除其他设备房间。
3. 必要时恢复本轮变更文件与旧二进制：逐文件比较当前已部署SHA，再从上述备份选取；新文件按发布清单处理。不要整树覆盖后续提交。
4. 环境仅回退本轮变更键，保留其他并行配置；旧JWT/manifest已过期，恢复文件不等于可重新开窗。回退后保持派单/倾听关闸，普通路径恢复验收后才考虑新窗口。
5. **禁止整库回灌、恢复旧搜索enabled=1、覆盖新上传数据或修改当前设备身份epoch。** config备份只作取证；新增字段对旧代码兼容。

到期实现：原38 `apps/server/scripts/listening-window-expire.py`；实际安装为两机 `expire-v374-window.py` 与 `p003-listening-v374-expiry.timer`。绝对UTC、Persistent=true、失败重试；主库同事务核代次/agent/截止并关闭派单和倾听，总闸操作保留调参及审计。Worker用锁和原子替换关闭相同代次window；watchdog/cleanup收尾。

## 本轮经验与限制

- 中间诊断文档不能替代交付。先修复→测试→部署→真实ACK→实际签票/接口→开窗，再给端侧ready回执。
- 200只证明传输成功。须验证具体答案、`typed_facts`、源模式、上游零调用和记忆排除；GM未知不能冒充真实数量正例。
- 主Brain实际没有CUSTOM_LLM_API_KEY：对目标SN必须使用原始已验签Worker JWT和明确名单；不能加全局Key破坏普通回调。候选保持独立Key。
- 静态规则用共同解析状态处理追问、读取、记忆过滤；外部话题重置，资源选择保留收益/余额原意图。
- 原39与现役代码必须三方合并，保留倾听STT生命周期；OwnedTask解构不能被机械替换成构造调用。六项现役修复已完整纳入。
- Linux构建需复用原验证缓存。给Cargo额外设置CARGO_NET_OFFLINE改变了ort-sys环境探测，造成已缓存ONNX链接失败；撤除该额外环境覆盖后joint/release及ABI门禁通过。没有安装新依赖。
- Worker Window使用strict JSON schema。第一次部署混入agent/prepared_at元数据被拒绝，期间派单仍关、jobs=0；修成enabled/allowlist/expires_at_ms/generation四字段后注册、ACK与稳定PID通过。该阶段累计NRestarts32是历史失败，不写成“从未重启”；修复后PID2222439保持。
- Observer必须同步候选root、health、端口、expected agent及真实名单；不能仅改路径后仍硬编码旧P2 agent。最终health/lease/scope均true。
- main四个派单字段UPDATE即使值相同也推进sourceGeneration；开窗后校验只读，不能重复写同值。
- 57 Ark＋58倾听＋候选HTTP、605 Rust＋2 joint及线上取证通过；倾听候选tsc通过。主项目整体tsc仍有11条既存Gemini abort/天气类型诊断，本轮未宣称主项目全量类型检查通过，也未扩展成无关重构。
- 当前GM数据、真实安卓听说/模式和normal数据正向验收继续由端侧执行最终用例；本轮不宣称联合整体验收收口。

署名：codex（OpenAI）| 2026-11-02 18:15:51 CST
