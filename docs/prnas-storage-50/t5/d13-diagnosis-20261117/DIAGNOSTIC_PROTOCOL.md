# T5 第1、3项诊断协议（私有运行索引）

任务：定位，不部署，不进入T6，不修改生产权限/闸门。原500ms/120ms门槛不变。

## 查询
- 基线固定65c86916，原脚本1000次重跑。
- 冷仅对自有analytics.db发POSIX_FADV_DONTNEED建议；用reader进程read_bytes核验，不全机清cache。
- CPU100%、Mem768MiB、Nice15、IOWeight20，50身份×1轮×3重复四组：冷、暖DB、冷DB+HTTP常量路由预热、冷DB+CPU200%。
- SQL计时与cpu/io/cgroup观测只放私有测试脚本；业务源码未变。每次重新起client和reader。
- 真正body完整、总时长、是否采纳history分别看，快照正确不等于历史成功。追加观测仅对私有ArkRuntime的原125ms判断记录结果，不放宽。

## 上传
- 固定e0931608业务源码；每臂clone相同600k原始合成库，保留原数据库，不含生产数据。
- 每臂独立50身份×2000事件=100k/500成功ACK。保留所有503和时间戳。移除原库后加的Ark实验/正式覆盖索引，使索引与原600k写入基线一致；保持t5_experiment_cover。
- 无维护/备份，原有checkpoint与WAL门保留；0.5核→1核→0.5核，Mem768MiB不变；不和查询同时运行。
- 新增记录writer promise时间、cpu.stat、memory.events、io.pressure/io.stat；不改变ACK与业务写法。
- 库增量逐ID/ACK/seen核对完成且记录最终库SHA后，仅删除本轮自有可重建clone DB，所有日志/账本保留，原600k不删。
- 每臂启动要求7.25GiB空闲（预估2.25GiB clone+增长与5GiB停止阈值），free<5GiB或生产ready连续3次失败则停自有测试。
- 未以小臂通过替代原600k+维护+备份混合门；多臂用于定位。

所有结果原字节归档；首次失败不覆盖。源脚本/归档SHA另记。只主13执行服务器负载，Grok只读复核。

## 追加单变量内存对照（ABA结束后）
CPU配额提高后仍未排除I/O瓶颈，因此准备1核+1536MiB第四臂；其余同1核768MiB臂，仍50×2000、同原始600k克隆、无维护/备份。只用于分离测试内存配额影响，不更改生产限制。全机MemAvailable<25%或ready连续3次失败、free<5GiB停止本臂。不得把较大配额下通过冒充原低配额混合门通过。

## 独立复审后收敛的查询补测
Grok386指出 `client_ms` 包含返回后的事实格式化，不能代替产品内部125ms采纳判断。后续仅做3次新进程×(不清缓存、先暖HTTP常量路径)两组；不再加fadvise或2CPU。直接记录grant、fetch_entered、headers、abort前后、请求/响应schema解析、SQL prepare/all、history整体归约、原125ms谓词采纳结果。私有ArkRuntime仅把原performance.now条件值保存并观测；条件数值未更改。body完整与history采纳分别报告。

## 生产配额事实
2026-11-17只读 `/proc/<pid>/cgroup` 显示Brain与Analytics同属pm2-root.service，cpu.max与memory.max均max；Analytics另有PM2 max_memory_restart=512MiB。这与测试组768MiB（包括client/reader/缓存）不是同一概念，禁止以测试限额失败证明生产机器必然容量不足。

## ABA提前停止（真实失败，保留）
第二个0.5核组成功183批后，出现writer单任务超时导致持久storage_ready=false，后续全为ANALYTICS_STORAGE_UNAVAILABLE。停止无效重试，保留完整失败数据库与账本，并核超时那批是否已提交。ABA未完成，不据此给CPU独立收益定量结论。1536MiB臂取消/NOT_RUN：优先保留失败DB，当前空间不能再开新clone；没有扩容/清失败库。后续只读查询补测在自有写入单位停止后执行。
