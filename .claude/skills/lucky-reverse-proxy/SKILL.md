---
name: lucky-reverse-proxy
description: 飞牛 NAS 上 Lucky 反向代理（Web服务）的登录、查看、增删规则与排障。含 fnOS 隐藏管理路径、RSA 挑战登录、Lucky-Admin-Token、规则字段、IPv6 入站限制和本机验证陷阱。触发词："lucky"、"反代"、"公网入口"、"16601"、"Max121211"、"加一条域名"
layer: 基建层
authorization: A区（读取与增改自己的反代规则自由；删别人的规则、改全局设置先说明）
output_levels: L1
---

# Lucky 反代配置（飞牛 NAS）

**一句话**：Lucky 跑在飞牛2（`192.168.1.115`）的应用中心里，管理入口路径是隐藏的，
用密码库里的飞牛账号走 RSA 挑战登录，拿 `Lucky-Admin-Token` 调 API，规则按「整条回写」的方式改。

## 关键事实

| 项 | 值 |
|---|---|
| 进程 / 数据 | `/vol1/@appcenter/Lucky/bin/lucky -cd /vol1/@appdata/Lucky/data` |
| 数据目录权限 | root 700，`*.lkcf` 是加密二进制 —— **不要手改配置**，只走 API |
| 管理端口 | 16601（HTTP） |
| 管理入口路径 | 隐藏，用 `trim-cli --profile fnos2 app list` 找 Lucky 的 `urls.path`（本机实测为 `/Max121211`） |
| 凭据 | 密码库 `secrets-vault-ops` 条目「飞牛nas登录信息」（与飞牛2 账号同一套）；不打印、不进 argv |
| 鉴权头 | `Lucky-Admin-Token: <token>` |
| 典型监听 | 8666/TLS 一条规则里挂多个域名（`ProxyList` 每项一个域名） |

## 登录流程（RSA 挑战）

1. `GET /{adminPath}/api/login/challenge` → `{challengeId, nonce, publicKey, expiresIn}`
2. 用 `publicKey` 做 **RSA PKCS#1 v1.5** 加密这段 JSON（原文，不压缩）：
   `{"Account":"<账号>","Password":"<密码>","twoFA":"","challengeId":"…","nonce":"…"}`
   （超过 245 字节要分段，段间用 `|` 拼 base64）
3. `POST /{adminPath}/api/login`，body `{"challengeId":"…","cipherText":"…"}` → 返回 `token`

Python 参考实现（`LOGIN_HELPER`）：

```python
def encrypt(pem, text):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from base64 import b64encode
    key = serialization.load_pem_public_key(pem.encode())
    return b64encode(key.encrypt(text.encode(), padding.PKCS1v15())).decode()
```

## 规则 API

| 动作 | 方法与路径 |
|---|---|
| 列表 | `GET /{adminPath}/api/webservice/rules` → `ruleList[]` |
| 单条 | `GET /{adminPath}/api/webservice/rule/{RuleKey}` |
| 整条保存 | `PUT /{adminPath}/api/webservice/rule/{RuleKey}`（body 是完整规则对象） |
| 新建 | `POST /{adminPath}/api/webservice/rules` |
| 删除 | `DELETE /{adminPath}/api/webservice/rule/{RuleKey}` |

字段是 **PascalCase**：`RuleName`、`ListenPort`、`EnableTLS`、`Enable`、`ProxyList[{Key, Domains, Locations, Enable, ...}]`。
`Locations` 是上游 URL（如 `http://192.168.1.133:8899`），`Domains` 是域名数组。

## 新增一个域名的步骤

1. 先备份：把目标规则整条存成 JSON（例如 `/tmp/lucky-rule-backup.json`）。
2. 从 `ProxyList` 里挑一条启用的做模板，深拷贝，改：
   - `Key`：16 位随机字母数字
   - `Domains`：`["新域名"]`
   - `Locations`：`["http://内网IP:端口"]`
   - `Remark`：写清用途
3. 把新条目 append 回 `ProxyList`，`PUT` 整条规则；`ret=0` 即成功。
4. 用 `GET rules` 复核条目数 + 目标地址。
5. 回滚 = 从 `ProxyList` 删掉那一项再 `PUT`（或整条恢复备份）。

## 验证与陷阱

- **本机测试必须加 `--noproxy '*'`**：这台机器设了 `https_proxy=127.0.0.1:10808`，不加会走代理，
  LAN 目标会返回 `000`/`502`，看起来像规则坏了。
- 带 SNI 测本机：`curl -sk --noproxy '*' --resolve 域名:8666:192.168.1.115 https://域名:8666/…`
- **家宽通常只有 IPv6 入站**：IPv4 端口从外部连不上；本机也不支持 IPv6 hairpin，
  所以「公网可达」往往只能拿手机（IPv6）实测，别在本机下结论。
- Lucky 的 TLS 证书按域名自动管理，新增域名后本地 HTTPS 通常立即可用；外网要等 DNS/证书生效。
- 类似 Caddy 的坑（本项目另一个反代）：`handle /x/*` 不剥前缀，`handle_path /x/*` 才剥；改 Caddy 要
  `caddy validate` 后重启容器（`admin off` 时 `caddy reload` 不可用）。

## 已落地实例（2026-11-17）

「词途」App 更新通道：在既有规则 `RuleKey=AdMqS1jnVHj8YLVt`（「外网回家NAS」，8666/TLS）里追加
`wordpath.hahaxiong.cc → http://192.168.1.133:8899`。本机 SNI 校验 200；公网留给 IPv6 手机验证，
App 里有 VPS IPv4 备用通道自动回退。

## 致命坑：列表视图是残缺的，PUT 必须用单条 GET（2026-11-17 实战）

- `GET /api/webservice/rules` 返回的每个 proxy 只有十几个字段；**单条 `GET /api/webservice/rule/{key}` 才有完整 42 个字段**
  （`LocationInsecureSkipVerify`、`HttpClientTimeout`、`ProxyType`、`OtherParams` 等都在里面）。
- 拿列表对象原样 PUT，缺失字段会被写成零值：**`LocationInsecureSkipVerify=false` 会让 https 上游立刻 502**
  （自签 IP 证书没有 IP SAN，报 `x509: cannot validate certificate ... no IP SANs`）。
  本次就是这样把 `fn1.hahaxiong.cc` / `fn2.hahaxiong.cc` 打挂的。
- 正确姿势：
  1. `GET /api/webservice/rule/{key}` 取完整对象（响应是 `{"ret":0,"rule":{...}}`）
  2. 只改要改的字段（新增/删除 `ProxyList` 条目）
  3. `PUT` 同一个完整对象
- 修复 https 上游 502：对相应条目设 `LocationInsecureSkipVerify = true`，再整条 PUT；不要动全局
  `baseconfigure.InsecureSkipVerify`（那是另一层开关，改了会扩大影响面）。

## DDNS 维护（IPv4/IPv6）与「解析报错」排查（2026-11-17 实战）

### API 入口

| 动作 | 路径 |
|---|---|
| 任务列表 | `GET /api/ddnstasklist` → `{data:[…]}` |
| 单任务 | `GET /api/ddns/task/{TaskKey}` |
| 保存整条 | `PUT /api/ddns?key={TaskKey}`（body 是完整任务对象） |
| 立即同步 | `GET /api/ddns/manualSync/{TaskKey}`（`ret:4 isSyncing` = 正在跑） |
| 最近日志 | `GET /api/ddns/lastlogs`、`GET /api/ddns/logs` |
| 网卡清单 | `GET /api/netinterfaces`（`IPv6NewInterfaces` 里有 eno1 的 GUA） |
| 取址测试 | `GET /api/ipregtest?iptype=6&netinterface=eno1&ipreg=` |

### 取址方式枚举（必须是源码里的值）

- 合法：`netInterface`、`url`（脚本：`script` / `odhcpd`，视版本）
- **非法**：`interface`、`fromNetInterface`、`fromUrl` → 日志「不支持的 IP 获取方式 xxx」
- 依据：Lucky 源码 `module/ddns/conf/ddns.go` 里 `if d.GetType == "netInterface"`

### 典型故障：AAAA 停在旧前缀

现象：路由 IPv6 正常、LAN 有 GUA，但 Lucky 日志持续
「所有 IPv6 公网 IP 查询接口均失败」，域名 IPv6 访问 `000`，`dig AAAA` 指向一个 NAS 上已不存在的地址。

根因：IPv6 取址配成 URL 列表（`v6.66666.host`、`myip6.ipip.net`、`6.ipw.cn`、`v6.ip.sb` …），
这些接口在 NAS 上实测全 `000`；取不到新 IP 时 Lucky **不会**改写 AAAA，记录就停在旧前缀。

修法：

1. `V6QueryIPType="netInterface"`、`V6NetInterface="eno1"`（直接读网卡 GUA，不依赖外部接口）；
2. `V4QueryIPType="url"`、`V4QueryUrl="https://myip.ipip.net/s"`（国内可用的纯文本回显）；
3. 需要新记录时在 `Records[]` 里加 `SyncRecordData{type:"AAAA", ipv6Address:"{ipv6Addr}", SubDomainName:...}`；
4. `PUT /api/ddns?key=…` 保存 → `manualSync` → 查 `lastlogs` 确认不再报错；
5. `dig +short AAAA 域名 @223.5.5.5 @1.1.1.1 @8.8.8.8` 三处一致即生效。

### 验证 IPv6 的正确姿势

- 从有 IPv6 的机器（VPS `racknerd`）测：`curl -6 -s -o /dev/null -w '%{http_code}' https://域名:8666/update.json`
- DNS 还没刷新时用地址兜底：`curl -6 --resolve '域名:8666:[IPv6]' …`
- 直连 `https://[IPv6]:8666/` 不带 Host/SNI 会返回 404，这是路由按域名分发，不是故障
- 别在本机下结论：家宽无 IPv6 hairpin，本机测公网 IPv6 一定是 000
