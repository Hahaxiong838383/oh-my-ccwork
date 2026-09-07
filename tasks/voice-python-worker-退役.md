# voice-agent Python worker 退役（释放资源给 rust 正式线）
> 创建：2026-09-07 | 状态：**进行中**（A 已执行；B/C/D 等拍板）

## 目标
把 64.90 上 Python 线（主线 voice-worker + 同事租户 voice-worker-colleague/voice-console/caddy）的内存约 1.15 GB、公网端口 8081/8082/80/443 与 LiveKit agent 注册释放给 rust 正式线；保留 rust 依赖的 voice-venv 与 7 个共享 env 键。盘点：[INVENTORY-PYTHON-WORKER-RETIRE-20260907](../2-Projects/realtime-voice-agent/docs/INVENTORY-PYTHON-WORKER-RETIRE-20260907.md)。

## 待办
- [ ] 川哥拍板 §5 五项（同事三件套处置 / 域名证书 / venv / 保留期 / 通知文案）
- [x] A 主线 voice-worker：disable --now + LiveKit 注册验收（2026-09-07 14:02，+526 MB 可用，rust 未动）
- [ ] B1 通知同事 + 截止日；B2 到期停三件套；/opt/voice-agent 留档
- [ ] C 磁盘：rust 备份留 5、eot-snapshots 留 7 天 + cron；deploy-worker-bin.sh 加轮转
- [ ] D 收尾：7 键并入 rust-worker.env + unit 去两行 + restart 验 job；47.239 摘 voice-test.html；仓库/skill 标退役；记忆更新

## 进度记录
- 2026-09-07：只读盘点完成（两机 unit/内存/端口/流量/耦合），同事线 9-05 起降到每天 1–2 次、今天 10:23 仍有一次真实会话；主线 8-19 起零流量。
- 2026-09-07 14:02：川哥批 A → 已停并禁用 voice-worker；rust PID/重启数不变；LiveKit 注销干净；其余可清理项列表见盘点 §7。
- 2026-09-07 14:08：川哥批「腾出的内存给 rust」→ rust unit MemoryHigh 900M→1400M / MemoryMax 1300M→1800M 热生效（set-property + unit 文件同步），OOMScoreAdjust=-900（drop-in + 现役进程即时），未重启；详见盘点 §8。
