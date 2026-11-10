# 本轮回滚记录

已发布代码：Worker b071e579，binary SHA 1193dfd309042686d6cd55fd6c781bead516750a7aff0d77bb4761fbe5707622；管理后台 a8226a0d + 发布互斥48fbace2。

## 发布前
主池运行SHA 0f8a9721cf972822f8e030d60e707d711cab74ff3187d3683146e21d02d3ce78 / PID4110554；倾听1fd53248/PID4110633与搜索56f6878f/PID2446060不动。后端admin-data before056e9d3c，页面before240bea05，发布器before6e675aa3。源码rollback/p003-bounded-worker-pre-20261110与rollback/p003-bounded-admin-pre-20261110均已push。

## 回滚层级
1. 仅关闭灾备：管理后台赛马配置→关闭有界灾备→保存。在无通话窗口受控重启，只走Brain，密钥档案保留。
2. 恢复旧Worker：使用/root/p003-worker-disaster-fallback-20261110/before-main里的voice-rust-worker/env/apply_hotwords.py精确恢复，停服务后原子替换再启动；再次核新PID可执行文件SHA、registered worker、保护池PID不变。旧env会恢复每轮火山双发，费用也回到旧模式。
3. 恢复后台：/opt/p003/_backup/worker-disaster-20261110里的admin-data.ts/admin.html，恢复前只允许当前候选或原基线SHA，遇漂移拒绝。恢复路由后重启p003-voice并验/health；不改任何数据库和设备权限/开关。

部署脚本含失败自动回滚，证据分别写before-main/receipt.json与后台备份receipt.json；不覆盖首次失败，重试另开目录。凭据备份只在服务器私有目录，文档和代码仓均不含密钥。

状态补记：本轮已上线并完成生产两轮验证，回滚工具只读检查PASS，未实际回退；最终状态以同目录上线回执和RELEASE_EVIDENCE.json为准。
