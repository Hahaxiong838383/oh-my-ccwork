# Mac 算力集群 — 交接文档

> 给下一个 session 看的。读完就能续上。

## 当前状态（2026-03-31 17:35）

### ✅ 集群已跑通！双节点分布式推理成功

**架构**：Mini (M4 32GB) + Studio (M2 Max 32GB) = 64GB 统一算力池
**方案**：llama.cpp RPC（不是 Exo）
**性能**：Qwen2.5-7B 跨双节点 27 tok/s

### 已完成
- ✅ 雷电直连：Mini 192.168.100.1 ↔ Studio 192.168.100.2（<1ms）
- ✅ SSH 免密：`ssh macstudio`（用户 fu-121，密码 1234）
- ✅ Mac Studio 升级到 macOS Tahoe 26.4（M2 Max, 30核GPU, Metal 4, 32GB）
- ✅ Mac Mini：macOS 26（M4, 10核GPU, Metal 4, 32GB）
- ✅ llama-server + rpc-server（b8589）安装在两台
- ✅ **llama.cpp RPC 分布式推理验证通过**
- ✅ Exo 双节点 libp2p 连接也通过（备用方案）
- ✅ Xray 直连规则：hf-mirror.com、modelscope.cn 走直连
- ✅ 启动脚本和踩坑记录完善

### 下一步：下载大模型
网速较慢（~400KB/s），需要等网络好的时候下载：

**推荐模型**（GGUF 格式，用于 llama.cpp RPC）：
- `unsloth/Qwen3.5-35B-A3B-GGUF` → Q8_0 约 37GB（需要双节点）
- `Qwen/Qwen2.5-32B-Instruct-GGUF` → Q4_K_M 约 20GB

下载到 Mini 后用 rsync 到 Studio（雷电 10Gbps 秒传）。

## 一键启动命令

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

## 关键配置

| 项目 | Mini | Studio |
|------|------|--------|
| IP | 192.168.100.1 | 192.168.100.2 |
| macOS | 26.x | 26.4 |
| SSH | — | `ssh macstudio` (fu-121/1234) |
| llama-server | `~/llama-cpp/llama-b8589/llama-server` | 同左 |
| rpc-server | `~/llama-cpp/llama-b8589/rpc-server` | 同左 |
| RPC 端口 | — | 50052 |
| API 端口 | 8080 | — |
| WiFi | en1 (10.9.1.54) | en1 iBRO (10.9.1.155) |
| 代理 | xray 10808 + mihomo 7890 | 无代理 |
| HF 镜像 | hf-mirror.com（已加 Xray 直连） | 同左 |

## 踩坑记录（必读！）

1. **代理是所有内网问题的第一嫌疑人** → 启动 llama-server 时必须 `env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY`
2. **Studio rpc-server 必须加 `--device MTL0`** → 否则 BLAS 后端会在 RMS_NORM 操作时崩溃（`ggml-blas.cpp:252: unsupported op RMS_NORM`）
3. **Studio 的 macOS 权限必须授予 rpc-server** → 网络访问、传入连接都要允许
4. **RPC server Metal shader 编译需要 ~15 秒** → 首次启动后等够时间再连
5. **Exo 也能组网但用 MLX 格式** → HF 下载太慢暂时不用
6. **HF 镜像 hf-mirror.com 已加入 Xray 直连规则** → 不走代理
7. **Studio Xcode 坏了** → `/usr/bin/python3` 和 `strings` 等系统工具有 USDKit 错误，用 `/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11` 替代
8. **Mini 的 all_proxy=socks5:// 会导致 httpx 崩溃** → Exo 和 HF 下载都受影响

## 决策记录

见 `2-Projects/gpustack-cluster/04-决策记录.md`

---
*最后更新: 2026-03-31 17:35*
