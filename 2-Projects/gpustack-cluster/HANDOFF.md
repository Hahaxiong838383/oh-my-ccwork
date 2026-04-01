# Mac 算力集群 — 交接文档

> 给下一个 session 看的。读完就能续上。

## 当前状态（2026-04-01 16:20）

### ✅ Exo 单节点推理验证通过（9B-4bit），27B-4bit 待下载

**架构**：Mini (M4 32GB) + Studio (M2 Max 32GB) = 64GB 统一算力池
**主方案**：Exo（MLX 格式，libp2p 组网，Pipeline 模式）
**备方案**：llama.cpp RPC（GGUF 格式，7B 已验证可用）

### 已完成
- ✅ 雷电直连：Mini 192.168.100.1 ↔ Studio 192.168.100.2（<1ms）
- ✅ SSH 免密：`ssh macstudio`（用户 fu-121，密码 1234）
- ✅ Mac Studio 升级到 macOS Tahoe 26.4（M2 Max, 30核GPU, Metal 4, 32GB）
- ✅ Mac Mini：macOS 26.2（M4, 10核GPU, Metal 4, 32GB）
- ✅ llama-server + rpc-server（b8589）安装在两台
- ✅ **llama.cpp RPC 分布式推理验证通过**（Qwen2.5-7B 双节点 27 tok/s）
- ✅ **Exo 双节点 libp2p 连接通过**（Mini CLI + Studio CLI）
- ✅ Xray 直连规则：hf-mirror.com、modelscope.cn 走直连
- ✅ 一键启动脚本：`2-Projects/gpustack-cluster/start-exo-cluster.sh`
- ✅ Studio 永不休眠：pmset sleep 0 + displaysleep 0
- ✅ **SIGSEGV 根因定位并修复**：Exo 的 JACCL RDMA 在 macOS Tahoe 不可用
- ✅ **Patch model cards: `supports_tensor=false`**，强制 Pipeline 模式
- ✅ **Qwen3.5-9B-4bit 单节点推理成功**（通过 API 创建 instance）
- ✅ EXO Thunderbolt 服务配置静态 IP（Mini en3, Studio en5）

### 进行中
- ⏳ 需要下载 Qwen3.5-27B-4bit（16GB，单节点可跑）

### 下一步
1. 下载 Qwen3.5-27B-4bit 到 Mini（16GB，~90分钟）
2. 单节点运行 27B-4bit 测性能
3. 如需跨双节点大模型：用 llama.cpp RPC（Exo Ring 模式需要 RDMA，macOS Tahoe 不支持）
4. 写 launchd plist 做开机自启

### SIGSEGV 根因（重大发现）

**所有** Qwen3.5 模型的 model card 都设了 `supports_tensor=true`，导致 Exo 走 JACCL RDMA 张量并行。macOS Tahoe 没有 Thunderbolt Bridge 硬件端口和 `rdmactld`，RDMA 连接失败 → Runner 进程 SIGSEGV。

**修复**：patch 两台的 model card TOML 文件：
```
/Applications/EXO.app/Contents/Resources/exo/_internal/resources/inference_model_cards/mlx-community--Qwen3.5-*.toml
supports_tensor = true → false
```
备份在 `.toml.bak`。

**Ring 模式的限制**：即使 patch 后走 Pipeline，多节点分片仍需 Ring 后端的 RDMA 连通性检查 → 单节点 OK，跨节点 blocked。

### 推理 API 调用方式（Exo 特殊）

Exo `/v1/chat/completions` **不会自动创建 instance**。需要两步：
```bash
# 1. 获取 placement
curl http://localhost:52416/instance/placement?model_id=mlx-community/Qwen3.5-9B-4bit

# 2. 用 placement 创建 instance
curl -X POST http://localhost:52416/instance \
  -H "Content-Type: application/json" \
  -d '{"instance": <placement_json>}'

# 3. 然后才能推理
curl http://localhost:52416/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mlx-community/Qwen3.5-9B-4bit","messages":[...]}'
```

### llama.cpp RPC 性能参考
- Qwen2.5-7B 跨双节点：27 tok/s

## 一键启动脚本

### Exo 集群（推荐）
脚本：`2-Projects/gpustack-cluster/start-exo-cluster.sh`
- 自动修复雷电 IP（networksetup）
- 自动获取 Studio Peer ID
- 自动 bootstrap 连接
- 等待组网确认

### llama.cpp RPC 集群（备用，跨节点大模型用这个）
```bash
# 1. Studio 上启动 RPC（关键：--device MTL0 禁用 BLAS）
ssh macstudio 'nohup ~/llama-cpp/llama-b8589/rpc-server --host 0.0.0.0 --port 50052 --device MTL0 > /tmp/rpc-server.log 2>&1 & disown'

# 2. 等 15 秒让 Metal 初始化
sleep 15

# 3. Mini 上启动 llama-server（清除代理！）
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  ~/llama-cpp/llama-b8589/llama-server \
  --model <模型路径.gguf> \
  --host 0.0.0.0 --port 8080 \
  --rpc 192.168.100.2:50052 \
  --n-gpu-layers 99 --ctx-size 4096

# 4. 测试
curl http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "test", "messages": [{"role": "user", "content": "Hello!"}]}'
```

## Dashboard

| 节点 | 地址 |
|------|------|
| Mini Worker | http://localhost:52416 |
| Studio Master | http://192.168.100.2:52415 |

## 关键配置

| 项目 | Mini | Studio |
|------|------|--------|
| IP（雷电） | 192.168.100.1 (en3, EXO Thunderbolt 2) | 192.168.100.2 (en5, EXO Thunderbolt 4) |
| macOS | 26.2 | 26.4 |
| SSH | — | `ssh macstudio` (fu-121/1234) |
| WiFi | en1 (10.9.1.54) | en1 iBRO (10.9.1.155) |
| Exo API | 52416 | 52415 |
| Exo libp2p | — | 52525 |
| llama-server | `~/llama-cpp/llama-b8589/llama-server` | 同左 |
| rpc-server | `~/llama-cpp/llama-b8589/rpc-server` | 同左 |
| RPC 端口 | — | 50052 |
| 代理 | xray 10808 + mihomo 7890 | 无代理 |
| HF 镜像 | hf-mirror.com（直连，~3MB/s） | 同左 |
| 休眠策略 | 默认 | pmset sleep 0 + displaysleep 0 |

## 踩坑记录（必读！）

1. **Exo Peer ID 每次重启都变** → 无法固化，用启动脚本自动获取
2. **端口占用导致 Exo 静默失败** → OSError: Address already in use，libp2p 不连但不报错。解决：启动前必须 kill 所有残留 + lsof 清端口
3. **雷电 IP 不持久** → ifconfig 设的 IP 会被 macOS 重置。解决：用 Exo Thunderbolt 服务的 networksetup -setmanual
4. **代理环境变量污染 libp2p** → 必须用 env -i 或彻底 unset 所有 proxy 变量
5. **Exo DMG 的模型下载管理不支持手动缓存** → 只能通过 Dashboard GUI 触发下载
6. **浏览器走 Xray 代理访问 localhost 503** → 需要加 localhost/127.0.0.1 到系统代理豁免
7. **Studio 休眠导致雷电断连** → pmset sleep 0 + displaysleep 0
8. **Mini 雷电接口拔插后会变（en2→en3→en9）** → 每次重连要确认实际活跃接口
9. **HF 镜像 hf-mirror.com 直连 3MB/s** → 已加入 Xray 直连规则
10. **Studio rpc-server 必须 --device MTL0** → BLAS 后端 RMS_NORM 不支持
11. **代理是所有内网问题的第一嫌疑人** → 启动 llama-server 时必须 `env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY`
12. **Studio 的 macOS 权限必须授予 rpc-server** → 网络访问、传入连接都要允许
13. **RPC server Metal shader 编译需要 ~15 秒** → 首次启动后等够时间再连
14. **Studio Xcode 坏了** → `/usr/bin/python3` 和 `strings` 等系统工具有 USDKit 错误，用 `/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11` 替代
15. **Mini 的 all_proxy=socks5:// 会导致 httpx 崩溃** → Exo 和 HF 下载都受影响
16. **⭐ Exo SIGSEGV 是 RDMA 问题不是模型问题** → `supports_tensor=true` 触发 JACCL RDMA，macOS Tahoe 无 Thunderbolt Bridge/rdmactld → 必须 patch model card 为 false
17. **⭐ Exo Ring 跨节点也需要 RDMA** → `supports_tensor=false` 只解决单节点，跨节点仍需 RDMA 连通性 → 跨节点大模型用 llama.cpp RPC
18. **⭐ Exo API 不自动创建 instance** → 需要先 GET placement → POST instance → 然后才能 /v1/chat/completions

## 模型下载路径

Exo 模型缓存在 `~/.exo/models/` 目录（不是 HuggingFace 缓存）。

## 决策记录

见 `2-Projects/gpustack-cluster/04-决策记录.md`

---
*最后更新: 2026-04-01 16:20*
