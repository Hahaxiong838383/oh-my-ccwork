# Admin UI v2.2 交接文档

## 已完成（v2.0 + v2.1 + v2.2）

### v2.0 — 项目级架构图谱（commit 66a3ece）
- 新增 `src/services/graph-scanner.ts`：动态扫描三层（代码/数据/配置）
- 新增 `GET /admin/api/graph` 后端 API（server.ts）
- deploy.sh 新增配置层快照生成（docs/skills/multi-agent）
- 前端 admin-ui.html 图谱改为 API 数据源 + 筛选器 + 四种边类型
- 修复 ADMIN_USER TDZ 初始化顺序 + dotenv # 截断 + session token 认证

### v2.1 — 视觉优化（commit ccd2b6f）
- 节点缩小（dir 10, file 2-6）+ 标签抬高避免遮挡
- 所有节点显示名称（去掉 fan-in 过滤）
- 紧凑布局（间距砍半，排斥力 -50）
- 修复 nodeOpacity 不存在导致滚轮缩放失效（改用 hex alpha）
- 修复快照缺少 docs/multi-agent 根目录导致 4 个孤立节点
- contain 边颜色加深到 0.3 透明度

### v2.2 — 右键查看节点内容（commit 6713158）
- 后端新增 `GET /admin/api/graph/content?id=xxx` 路由
  - 代码层：搜索 src/ 及子目录，路径安全检查
  - 数据层：读 dataDir 下文件，二进制文件友好提示
  - 配置层：从快照 contentPreviews 读取（Air 文件部署时快照）
  - 500 行截断保护，防止大文件撑爆前端
- 前端 `onNodeRightClick` + `_showNodeContent()` modal
  - 全屏暗色遮罩 + 居中弹窗（max 900px, 85vh）
  - ESC / 点击遮罩关闭
  - 复制按钮一键复制内容
  - 目录节点友好提示（不请求 API）
  - loading 状态 + 错误处理
- deploy.sh 快照新增 `contentPreviews` 字段
  - CLAUDE.md + docs/*.md + multi-agent/*.md 前 200 行
  - 修复 Air 上 node 不在 PATH（用 `$NODE_BIN` fallback）

## 经验教训

1. `.env` 含 `#` 必须加引号（dotenv 把 # 当注释）
2. `nodeOpacity` 在本地托管的 3d-force-graph 版本不存在，调用会导致 JS 报错中断所有交互
3. 多 session 并行改 server.ts 导致 TDZ 崩溃，部署后必须检查 pm2 logs
4. deploy.sh 的 `node -e` 中不能用 `__dirname`，要用 bash 变量传入
5. 快照的 scanDir 需要手动插入根目录 item（docs/multi-agent），否则 hasDocs=false
6. **Air 上 node 不在默认 PATH**（位于 `~/local/node/bin/node`），deploy.sh 需要 fallback 查找
7. **快照内的 `\n` 转义**：node -e 中 split('\n') 在 bash heredoc 里需要用 `\\n`

## 公网访问
- URL: http://cli4.hahaxiong.cc:19080/admin
- 登录: admin / Hahaxiong83*#
- 链路: FRP(阿里云:19080) → Mini:19080 → SSH隧道 → Studio:19080

## 回滚点
- admin-ui-v2.2: commit 6713158
- admin-ui-v2.1: commit ccd2b6f
- admin-ui-v2.0: commit 66a3ece
- admin-ui-v1.5: tag admin-ui-v1.5

## 后续方向（v2.3+）
- 代码高亮（引入 highlight.js 或 Prism）
- Markdown 渲染（引入 marked.js）
- 搜索节点功能（输入文件名快速定位）
- 节点双击展开/折叠子树
