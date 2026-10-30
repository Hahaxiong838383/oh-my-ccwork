# 电视第二阶段启动优化共享记忆快照

- 2026-10-30 10:43 CST 目标40～50秒已达成。最终同版本boot2dcd94f4/5221cafe，完整DNS/缓存ready46.60/45.07秒，独立审计47.82/46.31秒，无失败重试；旧基线77.30秒。
- 原因是逐/proc执行shell子命令；native完整扫描保留身份/锁语义，从约12.4秒缩至约0.06秒。先只改transaction/main实测51.15秒，再优化worker扫描，未并行、未削弱校时/DNS/安全门。
- 现stage /data/adb/video-proxy/boot-fast-20261030-workers，rack-dualstack-v2=16文件，workerctl纳入整组回滚；immutable helper SHA钉住，错误回旧shell。新service.d入口及当前外部asset清单同源，旧stage保留。
- 最终双栈正文/1MiB/DoT/5354和两HY2正文/1MiB均通过，唯一进程/16文件/依赖SHA权限通过；DIYP1080p持续增帧/error0。SmartTube保存DNS1与禁自动修复true保持；其实际影片、新版物理断电及长期故障恢复未验。
- 真源commit 77400ea7829e13e201cad4e3c04ba49bafde3d09；56文件快照逐字节匹配。项目报告2026-10-30-电视启动40至50秒优化结果.md；本轮仅本地commit，不push。
- 教训：阶段日志时间是检查点，不一定是阶段起点；以每段uptime与真实重启定位，不通过删保护或提前ready凑指标。初版目标未达时沿证据扩大最小实现范围，再在最终同版本验证两次。
