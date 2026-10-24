# R15 候选 Worker DNS 重试诊断

仅适用于独立候选 `p003-search-worker.service`。本配置不修改系统 DNS、生产 Worker、地址选择、证书校验、TTS 并发或整体连接期限。

2026-10-24 候选日志实际记录 TTS DNS 5010ms；系统调用另一次复现连接本机 DNS stub 后 `poll(POLLIN, 5000)` 超时 5005ms。它确认 DNS 等待，但不能定位丢包在 stub 还是上游，也不能解释另一轮正文的 LLM 等待。

候选进程使用 `RES_OPTIONS=timeout:1 attempts:2`：保留两次尝试，把单次解析重试等待改为1秒。恢复正常响应时更早重试；持续故障时会更早失败，因此仍须统计真实成功率与长尾，不把配置安装当成性能验收通过。

| 隔离故障 | 默认 | 候选参数 | 结果 |
|---|---:|---:|---|
| 首轮 A/AAAA 响应均丢弃 | 5073.0ms | 1100.0ms | 两者成功，均4个DNS请求 |
| 所有响应丢弃 | 10388.8ms | 2462.2ms | 两者失败，均4个DNS请求 |

测量脚本用 Linux 独立网络及挂载命名空间，必须这样运行：

```sh
sudo unshare --mount --net --fork python3 ops/dns-fault-harness.py
```

脚本在修改任何挂载或网卡前核对命名空间隔离；不满足就报错。测试仅在隔离的回环地址应答合成域名，不向真实上游发故障请求。

配置文件 `p003-search-worker-r15-resolver.conf` 安装到候选服务专属 `90-r15-resolver.conf` drop-in。安装、移除及恢复都必须先确认三个灰度闸关闭、候选jobs=0，并按部署记录核SHA。回滚时移除本轮新增drop-in、daemon-reload，再重启候选；不能恢复整个数据库或重启生产服务。

真实运行验证需从候选PID环境只读取 `RES_OPTIONS`，并核运行二进制哈希；不要输出完整环境。R13/R15配对使用同一候选DNS参数，比较范围是两个Worker版本在相同解析配置下的差异，不能称作与未经修改的现役服务对照。

参考：[Linux resolver 手册](https://man7.org/linux/man-pages/man5/resolv.conf.5.html)、[systemd-resolved 配置](https://www.freedesktop.org/software/systemd/man/latest/resolved.conf.html)。`single-request-reopen` 针对另一类双查询同端口问题，本轮没有证明该原因，故未启用。

署名：codex（OpenAI）| 2026-10-24
