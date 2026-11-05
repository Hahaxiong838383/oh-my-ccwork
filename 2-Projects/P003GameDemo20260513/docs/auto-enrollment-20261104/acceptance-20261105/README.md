# 自动接入完整入口验收复跑

主证据SERVER_ACCEPTANCE.json固定206个现役源/包清单、实际Node/依赖版本、新脚本SHA和原始日志SHA。main-test.stdout来自最终脚本的实际运行；早期试跑和工装失败保持在私有证据目录。regression-results.json保留core漏依赖首败及补齐后的26/26。

在Linux私有源码快照内使用已安装依赖，root网络命名空间隔离运行：

```sh
unshare --net sh -c 'ip link set lo up; exec node --experimental-sqlite --import tsx scripts/device-enrollment-main.test.ts'
```

脚本拒绝宿主网络；实际启动原src/index.ts，创建随机secret、全新DB及独立cwd，只允许loopback。没有生产.env或业务数据继承；主服务测试子进程正常/失败都停止，110秒看门狗，原一小时批处理不会在测试期执行，外部网络不通。不要为跑测试修改生产环境或复制生产数据库。

冻结现役源需在复制前后逐文件SHA比对，并确认主入口/依赖版本；本次主机使用Node22.22.2、tsx4.22.1，与主服务一致。不要拿此树全部业务源码覆盖现役：线上含后续v384等改动，只有六个自动接入业务文件与60485d45逐字节相同。新脚本本轮未要求生产进程加载。

本轮证明后台接口/持久化/权限与自动化合同，不证明真实USB、BLE本机确认或运营商短信送达；C真实RID仍待客户端自动调用产生。
