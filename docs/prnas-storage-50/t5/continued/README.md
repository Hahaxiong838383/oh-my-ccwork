# T5 接续：保留失败与新增查询测量

- 固定e093云Linux小批完整入库/统计/备份，但第一批ACK521.38ms导致8批P95超过500ms，整体FAIL，不删样本、不放宽门槛。
- 五组现有storage回归通过，source仍与T4相同。
- 新独立Ark测量使用真实ArkRuntime→loopback HTTP→readArkHistory/SQLite；检查assets与内部HTTP读体完成。实际最短deadline120ms，p99目标100ms；保留每轮和冷启动。
- 两次Mac短测均出现首轮内部HTTP未完成，延迟140.76/199.03ms，资产值均正确。后续要在云端与批上传重叠复验，不能据本地冷启动/同时构建的结果判生产根因，也不能宣称A09通过。
- 已清理首轮失败任务唯一合成DB/WAL/SHM。删除前确认failed/PID0、30万行全部合成设备且无打开fd，保存文件SHA及原结果；生产/其它树/有效cover夹具未删。
- 600k现役规格隔离轮正在运行；候选e093，CPUQuota50%、MemoryMax768MiB，9000s外层限时/7200s上传期限。保护监控仅停止该测试：free<5GiB、RAM<20%、现役ready连续3次失败。不是成熟库或24小时结果。
