# Mac 算力集群 — 交接文档

> 给下一个 session 看的。读完就能续上。

## 当前状态（2026-04-02 08:17）

### ✅ Studio 单机部署成功，Qwen3.5-27B-4bit 已在线

**架构**：Studio 单机 mlx-lm.server，Mini + 局域网设备通过 API 调用
**模型**：Qwen3.5-27B-4bit（MLX 原生，16GB）
**性能**：20 tok/s，测评 97.5%
**API**：`http://192.168.100.2:8000/v1/chat/completions`（雷电）
**Open WebUI**：`http://localhost:3000`（Mini 上，连 Studio 后端）

### 服务状态

| 服务 | 位置 | 状态 | 端口 |
|------|------|------|------|
| mlx-lm.server | Studio | ✅ 运行中 | 8000 |
| Ollama | Studio | ✅ 运行中 | 11434 |
| Open WebUI | Mini | ✅ 运行中 | 3000 |
| Exo | 两台 | ⏸️ 暂停 | 52415/52416 |

### 测评结果（2026-04-01）

| 维度 | 得分 |
|------|------|
| 数学推理 | 100% (50/50) |
| 逻辑推理 | 96.7% (29/30) |
| 中文理解 | 100% (30/30 + 大海捞针全通) |
| 实用能力 | 93.3% (28/30) |
| **总评** | **97.5%** |
| 推理速度 | 16.5-20.2 tok/s |

报告：`2-Projects/qwen-eval/results/report_20260401.md`

## 已完成

- ✅ 雷电直连：Mini 192.168.100.1 ↔ Studio 192.168.100.2（<1ms）
- ✅ SSH 免密：`ssh macstudio`（用户 fu-121，密码 1234）
- ✅ mlx-lm v0.31.1 + Qwen3.5-27B-4bit 部署并验证
- ✅ Ollama v0.19.0 安装（~/bin/ollama），qwen3:30b 下载中
- ✅ Open WebUI v0.8.12 安装并启动
- ✅ Studio Xcode CLT / OpenSSL 3.6.1 / Python 3.11 修复
- ✅ Exo SIGSEGV 根因定位（RDMA，TB4 不支持）
- ✅ Exo model card patch（supports_tensor=false）
- ✅ Exo 单节点 9B-4bit 推理验证通过
- ✅ 测评项目 qwen-eval 完整实现并跑通
- ✅ 启动/测试脚本编写
- ✅ Xray 直连规则优化（hf-mirror.com）
- ✅ Studio 永不休眠

## 待完成

- ⏳ Ollama qwen3:30b 下载（Mini 拉取 + 自动 rsync 脚本 /tmp/auto-sync-ollama.sh）
- ⏳ Open WebUI 连接 Studio 模型配置（首次打开需注册管理员）
- 📋 mlx-lm.server 开机自启（launchd plist）
- 📋 Ollama 开机自启
- 📋 Open WebUI 开机自启

## 启动命令速查

### mlx-lm.server（Studio 上）
```bash
ssh macstudio 'HF_ENDPOINT=https://hf-mirror.com nohup /opt/homebrew/bin/python3.11 -m mlx_lm.server \
  --model mlx-community/Qwen3.5-27B-4bit \
  --host 0.0.0.0 --port 8000 \
  > /tmp/mlx-server.log 2>&1 &'
```

### Ollama（Studio 上）
```bash
ssh macstudio 'OLLAMA_HOST=0.0.0.0:11434 nohup ~/bin/ollama serve > /tmp/ollama-server.log 2>&1 &'
```

### Open WebUI（Mini 上）
```bash
HF_ENDPOINT=https://hf-mirror.com \
NO_PROXY="192.168.100.0/24,localhost,127.0.0.1" \
OPENAI_API_BASE_URLS="http://192.168.100.2:8000/v1" \
OPENAI_API_KEYS="not-needed" \
nohup /opt/homebrew/bin/open-webui serve --host 0.0.0.0 --port 3000 \
  > /tmp/open-webui.log 2>&1 &
```

### 快速测试
```bash
curl http://192.168.100.2:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mlx-community/Qwen3.5-27B-4bit","messages":[{"role":"user","content":"你好"}]}'
```

### 测评
```bash
cd ~/mycc/2-Projects/qwen-eval && /opt/homebrew/bin/python3.11 run_all.py
```

## 关键配置

| 项目 | Mini | Studio |
|------|------|--------|
| IP（雷电） | 192.168.100.1 (en3) | 192.168.100.2 (en5) |
| macOS | 26.2 | 26.4 |
| SSH | — | `ssh macstudio` (fu-121/1234) |
| WiFi | en1 (10.9.1.54) | en1 (10.9.1.155) |
| Python | 3.11 (homebrew) | 3.11 (homebrew, SSL 已修复) |
| mlx-lm | — | v0.31.1 |
| Ollama | v0.18.3 (homebrew) | v0.19.0 (~/bin/ollama) |
| Open WebUI | v0.8.12 | — |
| 代理 | xray 10808 | 无代理 |
| HF 镜像 | hf-mirror.com | 同左 |
| Thunderbolt | TB4 (40Gb/s) | TB4 (40Gb/s) |
| RDMA | 不支持（TB4） | 同左 |

## Qwen3.5 thinking 模式注意事项

Qwen3.5 默认启用 thinking 模式：
- **content** 字段只有最终回答（可能很短）
- **reasoning** 字段包含完整思考链
- thinking tokens 计入 max_tokens 预算

关闭 thinking 模式（推荐用于测评和结构化任务）：
```python
extra_body={"chat_template_kwargs": {"enable_thinking": False}}
```

## 踩坑记录

1-15：见上一版 HANDOFF（Exo 相关踩坑仍然有效）

16. **Exo SIGSEGV 根因 = RDMA** → TB4 不支持 RDMA，Exo 双节点分布式在当前硬件不可行
17. **Exo Ring 跨节点也需要 RDMA** → 单节点 OK，跨节点 blocked
18. **Studio Python SSL 模块坏** → brew reinstall openssl@3 + python@3.11 + brew link 修复
19. **pip install 走 Studio WiFi 极慢** → Mini 下载 wheel 后 scp 到 Studio 离线安装
20. **Open WebUI 首次启动下载 embedding 模型** → 需设 HF_ENDPOINT=hf-mirror.com 走中国镜像
21. **Qwen3.5 thinking 模式导致 stream TPS 失真** → stream 只返回 content（极短），thinking tokens 不可见。测速用非流式 + enable_thinking=False
22. **Ollama 库没有 Qwen3.5** → 太新未收录，用 qwen3:30b（MoE）替代或直接用 mlx-lm

## 决策记录

- **方案选择**：Studio 单机 mlx-lm > Ollama > Exo 双节点（RDMA blocked）> llama.cpp RPC
- **模型选择**：Qwen3.5-27B-4bit Dense（16GB）> MoE 30B/35B（激活仅3B）> Q8（29GB 太紧）
- **工具选择**：mlx-lm（MLX 原生最快）> Ollama（GGUF，方便）> llama-server（备用）

---
*最后更新: 2026-04-02 08:17*
