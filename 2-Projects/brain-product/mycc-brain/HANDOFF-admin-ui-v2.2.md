# Admin UI v2.2 交接文档

## 已完成（v2.0 + v2.1）

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

## 待做：v2.2 — 右键查看节点内容

### 需求
右键点击节点 → 弹出对话框 → 显示该文件的详细内容（代码高亮或 markdown 渲染）

### 实现方案

#### 后端：新增 API
在 `server.ts` 新增路由：
```
GET /admin/api/graph/content?id=code:server.ts
```
- 根据 node id 前缀（code:/data:/config:）定位文件路径
- code 层：`src/` + 文件名（需要搜索子目录）
- data 层：`config.dataDir` + 文件名
- config 层：从快照 JSON 解析路径，读取 mycc 根目录下的文件（但 brain 在 Studio 上，config 文件在 Air 上——需要用快照时保存内容摘要，或者只返回代码层+数据层的内容）
- 返回：`{ content: string, language: "typescript"|"markdown"|"json", lines: number }`
- 安全：限制只能读 src/、dataDir、data/ 下的文件，防止路径遍历

#### 前端：右键菜单 + 对话框
在 `_renderGraph` 的 Graph 配置中加：
```javascript
.onNodeRightClick((node, event) => {
  event.preventDefault();
  _showNodeContent(node);
})
```

`_showNodeContent(node)` 函数：
1. 创建全屏 modal overlay（暗色半透明背景）
2. fetch `/admin/api/graph/content?id=${node.id}`
3. 显示内容：代码用 `<pre><code>` 展示，markdown 原文展示
4. 顶部显示文件名、层级、分组
5. 右上角关闭按钮 + ESC 键关闭
6. 内容区可滚动，限制高度 80vh

### 关键约束
- config 层文件在 Air 上，Studio 无法直接读取 → 方案：deploy.sh 快照时把文件内容（前 200 行）也保存进快照 JSON
- 或者简化：v2.2 只支持代码层和数据层的文件内容查看，配置层显示"配置层文件仅在部署时可用"
- SpriteText 不可用，用 Canvas Sprite（已有）
- 版本号需更新到 v2.2
- 部署用 `bash deploy.sh`（会自动 tsc + 推 HTML）

### 关键文件
| 文件 | 改动 |
|------|------|
| `src/server.ts` | 新增 /admin/api/graph/content 路由 |
| `src/admin/admin-ui.html` | 新增 onNodeRightClick + modal |
| `deploy.sh` | 可选：快照增加文件内容摘要 |

### 回滚点
- admin-ui-v2.1: commit ccd2b6f
- admin-ui-v2.0: commit 66a3ece
- admin-ui-v1.5: tag admin-ui-v1.5

### 经验教训（本 session 踩的坑）
1. `.env` 含 `#` 必须加引号（dotenv 把 # 当注释）
2. `nodeOpacity` 在本地托管的 3d-force-graph 版本不存在，调用会导致 JS 报错中断所有交互
3. 多 session 并行改 server.ts 导致 TDZ 崩溃，部署后必须检查 pm2 logs
4. deploy.sh 的 `node -e` 中不能用 `__dirname`，要用 bash 变量传入
5. 快照的 scanDir 需要手动插入根目录 item（docs/multi-agent），否则 hasDocs=false

### 公网访问
- URL: http://cli4.hahaxiong.cc:19080/admin
- 登录: admin / Hahaxiong83*#
- 链路: FRP(阿里云:19080) → Mini:19080 → SSH隧道 → Studio:19080
