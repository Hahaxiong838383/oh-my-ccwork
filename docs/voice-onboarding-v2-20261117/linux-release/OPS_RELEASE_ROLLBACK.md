# 语音教学 V2 Linux 发布及回滚记录

2026-11-17，主13执行；Grok383审核默认关闭兼容发布。执行证据以 `evidence/PRODUCTION-RESULT.json` 为准，早先评审中的“尚未部署”是发布前状态。

## 固定边界

- 构建源码786a135bcc2f42037b117ec2d3582fcb3af2409b；运行源码42df1d0320aec5338c9d1be2c11de6e514966944。新增身份测试和交付文档不改变运行字节。
- 仅主池binary和Brain的8文件；清单 `evidence/BRAIN-MANIFEST.json`。全量Linux639通过、2忽略；Brain同套30项在LinuxNode24及线上源码隔离副本Node22/24通过。
- 两库备份确实都存在，quick_check通过：devices.db / profile.db。私有路径见生产回执，不外发文件。
- 正式普通服务身份与默认测试夹具不同。只配置教学专属白名单键，复用现有Search/Ark认可的身份，不替换既有正常聊天token。
- 教学总闸和V2门均false，开放教学会话0。新增服务身份不等于启用教学。

## 并行发布核对

15:34 CST主Worker、Brain发布；15:39左右会话360又更新了5个小程序文件并发生受控PM2重启。主13下一步操作被PID检查拒绝，没有覆盖它。

`src/miniapp-dashboard.ts`、`src/ark/dashboard.ts`、`src/ark/records-store.ts`、`src/ark/records-contract.ts`、`src/ark/records-legacy.ts` 与360工作树独立逐字节核同。后续服务身份配置发布前后全部源码一致。最终检查使用这5个已核新哈希，未将原基线的“其他文件不变”偷换为跨所有并发发布都不变。

## 常规回滚

1. 确认本轮后是否出现其他代码/配置发布；读取当前文件哈希和进程，不能直接假定仍是本轮版本。
2. 先将教学总闸及V2门设为false；等180秒存量租约排空、确认无活动教学房间。当前未开过闸，无需凭空清资料。
3. 只删除本次加入的`VOICE_ONBOARDING_WORKER_ACCOUNTS`键；核值仍为本轮记录的hash，保留其他配置。`ops/rollback-service-identity.py`已做语法检查，未在生产执行，调用后须核health。
4. Brain在 `/opt/p003/onboarding-release-20261117/deploy-brain.py rollback` 按清单恢复8文件；新增4文件删除，其他原4文件恢复备份。保留360文件及所有SQLite数据/增量列。该脚本先做版本/闸门漂移拒绝。
5. 空房后主Worker在 `/root/p003-onboarding-release-20261117/deploy-worker.py rollback` 恢复旧binary。正常自动回滚子命令要求单元active、进程/磁盘均为本轮新hash。
6. 核主Worker注册、运行/磁盘旧hash一致；Brain health、Analytics ready为200；其他服务/PID/配置保持；做一轮普通对话验证。切勿把脚本退出0当作真机通过。

## 异常现场

如发布器被SIGKILL、服务已failed或8文件只替换了一半，常规rollback可能拒绝。先只读核当前状态，再恢复**本轮拥有的文件**；主Worker备份binary经SHA验证后原子写回并恢复可执行权限，启动服务验证。Brain对每个目标分别核before/after；遇到第三种hash先识别是否其他发布，不能覆盖。

脚本以root运行，umask077使新增源码0600、Worker0700；现役运行用户为root且健康验证通过。env解析不是通用dotenv解析器；本轮另核PM2缓存无开启标志、配置实际仅新增身份项；后续不能以当前解析器取代任意复杂env格式的审计。

生产回滚没有人为触发演练，不宣称“所有异常都自动恢复”。这份记录提供已验证的旧字节、固定清单及明确操作边界。

署名：codex（OpenAI）｜2026-11-17

## 最终独立复核

Grok383通过默认关闭兼容发布审查；Grok384仅复核服务身份配置增量，结论通过、无阻断。Grok384没有读真实生产探针，主13随后独立核得400 invalid_request及memory_write=none；该证据在worker-postflight-final.json，不扩张为实际教学写入或APK通过。
