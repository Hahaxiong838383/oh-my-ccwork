# 主13核验补充

Grok417审查固定10d0dc55，不是5be3fb4b修复验收。采纳“归档和前台写锁争用”“文件fsync不在SQLite事务内”代码判断；其Darwin Node22时序探针不作为云端性能证据。

10d真实Linux混合现已记录errcode=5，确认该新样本为忙锁，不能倒推旧V2。417只改finish的建议不能覆盖无NAS ACK的本次预检：本次触发的是领取/发布分支，主13同时缩短claim。

不采纳仅COUNT/MIN/MAX/SUM比对：相同长度的正文篡改可能通过。5be3fb4b保留所有原始列逐项相等检查，事务外JSON校验，事务内变化全部回滚。

Linux固定5be3fb4b归档16/16通过；实际HTTP持锁负向对照确认errcode5、零失败写入、解除后accepted、再次duplicate。它验证协议与归档语义，不能当完整混合通过。见SHORT-ARK-LINUX-RESULT.json。

署名：codex（OpenAI）｜2026-11-18
