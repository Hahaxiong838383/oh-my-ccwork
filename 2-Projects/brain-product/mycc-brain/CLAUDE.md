# mycc-brain 项目规则

## 版本管理（强制）

**版本号唯一真相源：`package.json` 的 `version` 字段。**

以下三处版本号必须始终一致：
1. `package.json` → `"version": "x.y.z"`
2. `src/server.ts` → 启动横幅 `mycc-brain vX.Y.Z`
3. `src/server.ts` → `/admin/api/status` 响应的 `version` 字段

### 升版规则

| 变更类型 | 版本位 | 示例 |
|---------|--------|------|
| 新功能（feat） | minor +1 | 0.6.0 → 0.7.0 |
| bug 修复（fix） | patch +1 | 0.6.0 → 0.6.1 |
| 重大架构变更 | major +1 | 0.6.0 → 1.0.0 |
| 重构/文档/chore | 不升版 | — |

### 强制流程

每次 `feat` 或 `fix` 提交时，**必须同时更新三处版本号**。忘记升版 = 提交不完整。

```bash
# 快速检查版本一致性
grep '"version"' package.json
grep 'version:' src/server.ts
grep 'mycc-brain v' src/server.ts
```

### 版本历史

| 版本 | 日期 | 里程碑 |
|------|------|--------|
| 0.1.0 | 2026-04-03 | 初始版本，OpenAI 兼容代理 |
| 0.2.0 | 2026-04-04 | D2 记忆注入 + 四路检索 |
| 0.3.0 | 2026-04-05 | D4 Agent Loop + MCP |
| 0.4.0 | 2026-04-06 | 自进化系统 + Admin UI |
| 0.5.0 | 2026-04-07 | 在线模型接入 + 图谱 |
| 0.5.1 | 2026-04-07 | P0 TTFT 优化 |
| 0.6.0 | 2026-04-08 | Vision P0-P2（感知+自进化+prompt自调优） |

## 部署

- Studio SSH: `studio-pub`（经 Mini 跳板）
- 部署脚本: `bash deploy.sh` 或手动 rsync + tsc + pm2 restart
- 部署后必须验证: `pm2 logs brain --lines 5 --nostream`
