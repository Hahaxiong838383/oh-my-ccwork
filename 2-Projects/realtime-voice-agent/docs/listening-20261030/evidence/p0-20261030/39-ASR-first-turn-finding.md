# e0 最终统一矩阵新增未闭环项

运行源码仍freeze e0a83f81，没有悄改运行代码。统一矩阵rtc-run-1793353699185182498完整7项，6rc0，lease_timeout在注入前失败。证据39-rtc-e0-matrix，所有新房1793353701及以后，非旧结果。

精确根因链：AJ_pw9JDqhH6cNd / sn-BJP00326103099999938-1793353879 / trace6a4cdb8d。
09:51:19.940 ASR预连；09:51:20.209供应商握手完成。
09:51:24.964 RTC signal超时，09:51:27.967重试，09:51:30.108 Room成功 connect_ms10183。
09:51:30.147 pipeline接管prebuilt_age_ms10207，09:51:30.277首次提交PCM。
09:51:30.337供应商45000081，waiting next packet timeout session ended；ordered asr_unavailable；首句没有进入proposal，既有first_turn_failed切RTC，续讲产生普通回复，探针判失败。自动收房成功。
不是租约失效分支失败（尚未SIGSTOP），不是capacity问题（Availability/Assignment完整），也不是Android未回ready。

同一e0/同实例/maxjobs1/未改WAV/未加超时，当前精准重跑lease_timeout以取得真正故障分支证据。该重跑不会覆盖统一矩阵失败，也不会报告首轮7/7绿。源码如要最小修复，可在pipeline接管时对已空等约10s的preconnected ASR替换一条新stream（保旧任务显式终止+drop，不能仅延长RTC/probe等待）。更全面首帧时刻/ASR通用恢复不属于本轮窄修范围。主会话可根据精确证据裁定下一最小补丁，当前不再未经复验扩大e0冻结面。
