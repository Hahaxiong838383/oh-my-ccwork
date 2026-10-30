# P003 倾听模式执行记录

2026-10-30用户已批准开始执行；当前完成的是基础模块和后台管理配置，**后台配置已于09:50:48 CST部署；尚未接入生产收音/播放链路，未开闸、未做真人验收**。

## 已完成与本批证据

| 内容 | 状态与证据 |
|---|---|
| 工作区 | Brain/Worker独立工作树及分支，Codeg folder28/29已登记；原会话未迁移 |
| 冻结点 | Brain e4bf0632、Worker ef92ee1a；两条rollback标签；运行二进制SHA见ROLLBACK.md |
| 协议 | 两树同字节`4-Assets/contracts/p003-listening-mode-v1.json`；Android联调文档已交付；ACK结构为待接线合同 |
| Worker底座 | 新增纯状态/一次许可/有界缓冲，未被main/pipeline引用；29项测试通过；6个复审缺陷先复现失败后修复 |
| Brain底座 | 纯设置验证、显式名单、双端能力资格、绑定JWT签发/验证；10组测试与定向TypeScript检查通过；未注册HTTP路由 |
| 独立评审 | 只读Worker评审确认原4类问题关闭并独立重跑29项通过；Brain独立复审8组通过后，主代理补继承字段/稀疏数组与畸形票据测试至10组通过 |

TDD：core初版21项预期失败→21通过；复审再补6项失败（租约续期、摘要重传/裁切/跨实例、缺口、正在讲话）→加回调/旧epoch等测试共29通过。Brain策略4组、grant6组；grant非法签发的拒绝测试在空实现阶段自然通过，不能将它们称为已先验证正确拒绝原因；成功签发及验签路径先失败后实现。

测试日志私有保存`~/.local/state/p003-listening-20261030/`，仓库不存secret、用户正文或服务器原始日志。`node_modules`复用已安装项目依赖的忽略symlink，未装新依赖/改锁文件。当前本机rustc1.70只用于纯模块2021测试，不能构建现有edition2024整个Worker。

## 下一批明确任务

1. 主Brain权威会话登记、严格worker JWT＋服务Bearer＋grant＋当前registry归属验证；实现15秒短租约和设备签票接线。仅有grant不能当内部HTTP鉴权。
2. Worker接control/实际participant/签名metadata；持续记录VAD活动；所有输出出口逐帧许可、capture取消排空、enter双确认；普通LLM/spec/filler/设备动作抑制。
3. 独立summary/feedback接口与异步任务，绕过普通chat历史/吐槽armed/人格/工具副作用；语音邀请规则和用户主动反馈按钮接线。
4. 搜索结果永久显式播放标记；普通与搜索候选两基线分别验证，禁止整树覆盖。
5. 后台UI、Android当前包合同验收、完整Linux/RTC/真人测试、回滚演练后才发布和单机开窗。

具体文件、接口、门槛见`docs/superpowers/plans/2026-10-30-p003-listening-implementation.md`。所有未取证项保留未完成状态；不以底座测试替代全链路验收。

署名：codex（OpenAI）| 2026-10-30

## 复审修正与协议校验

Brain严格unknown解析补了自有字段/稀疏名单检查；先复现继承对象误通过，再修正。补签名正确但超时长/nbf不一致票据拒绝，以及敏感额外字段不进入JWT的测试。Worker的旧片段去重只保证最近256条，超范围保守标gap，已写入交接合同。

两树协议已解析并核对示例request_id/epoch，字节一致SHA256：`8c2264161fe7bf3270c99517d6c952ee7cdd912c38f6be389a5d1acbbf43923b`。Rust代码通过现有远端rustfmt stdin/stdout格式化，未落远端业务文件；纯测试在格式化后重跑通过。

最终独立上下文评审已重跑Worker29/Brain10，两树合同cmp一致，未发现阻塞性底座代码缺陷；评审指出的旧测试数量已同步。原device-session签票回归45/45通过（临时数据库与合成凭据），只证明旧签发路径回归，不代表新倾听签票已经接入。

## 源码交付锚

2026-10-30 08:26 CST，首批代码与冻结tag已atomic push至既有origin，并通过独立`git ls-remote`核同：

- Brain代码：`43bdebdc1ffda98b2c8bea419da9dad23f3c5de6`，分支`codex/p003-listening-brain-20261030`。
- Worker代码：`53727c3fb367f5a4f692a81511d5ac8303eb728a`，分支`codex/p003-listening-worker-20261030`。
- 冻结tag：Brain→`e4bf06324553850ce28b9d1bcdaa70bef974eb46`，Worker→`ef92ee1aa30e6ef869f6270de22173ce51617f30`。

本节后续归档提交不改变代码锚。推送仅完成源码交付，没有自动部署倾听模式。共享记忆在独立本地目录，不把本仓push等同其已推送。


## Worker Brain 管理配置追加（2026-10-30）

用户要求调试参数在后台调整。已实现配置卡、严格接口、同config.db专用两表、原子CAS/审计、历史恢复、只关闭总闸操作与独立运行状态。见`ADMIN_CONFIGURATION.md`。修复重登录保持Brain导航时不自动加载的缺口，已先补浏览器失败用例再修复。原Task3配置部分和Task6界面部分已完成；真实授权租约、音频接线、运行确认、当前Android及真人验收仍待。

本批修改只在Brain专用开发分支，Worker树与线上服务保持。关闭/恢复不会触及原config表或整库恢复；运行未就绪时开启请求409。配置接口测试38、存储12、真实浏览器组件链路、Brain原10组、签票45及filler回归验证，详见本批文档；不能称整套倾听功能已实现。

本批最终复审：重登录缺口已关闭，独立Admin38/Store12通过；主代理Chromium含实际登录函数回归通过、全量TypeScript检查通过。配置与历史读取同一事务快照，64KiB请求上限位于鉴权之后。

## 09:50管理配置发布

见`ADMIN_RELEASE_20261030.md`；此前“未部署”描述为当时快照，当前仅管理UI/API已部署，真实倾听仍未开通。接续任务见`DEVELOPMENT_NEXT.md`。
