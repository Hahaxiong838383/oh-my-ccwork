# 有界只读取证工具

固定Node 24.19.0。profile-selftest.mjs只建自有临时库、验证路径/只读守卫；check-failed-phase.mjs保留原错误探针作负对照。两者均为隔离工具，不是T5负载验收。

profile-first-request.mjs的云端root02源码SHA为be02c3a64a928a3b7c2f2149837f7f45d43bd3a7361b8220f2001e36d59f3abd，只允许明确的合成fixture路径。T5_PROFILE_ALLOW_SMALL仅用于临时自测，不允许对生产库使用。执行前核writer停止，设置CPU/内存/时间上限，固定fixture时间窗口，结束核ready。不得把重复暖读当成修复。

original-profile-first-request.mjs故意保留有缺陷的旧工具，不能用于验收；phase-fix-before-wal-guard.mjs保留首次云端root01版本，便于复核空WAL误判。最终工具仍保留每阶段原始错误，任一错误退出失败。此目录不包含远端登录凭据或自动发布器。
