# Company Ontology Mini Tunnel

Mac Mini 维护一条到 `aliyun-hk` 的持久反向 SSH，仅把 QNAP 的 LAN 健康网关映射到阿里云回环地址：

```text
aliyun-hk 127.0.0.1:19180 -> Mini -> QNAP 192.168.61.18:19080
```

该通道不开放公网监听，不承载数据库、业务正文或凭据。公网用户必须先通过 H 控制面的管理员认证，才能读取控制面聚合后的脱敏状态。

安装：

```bash
zsh deploy/mini/install-company-ontology-tunnel.sh
```
