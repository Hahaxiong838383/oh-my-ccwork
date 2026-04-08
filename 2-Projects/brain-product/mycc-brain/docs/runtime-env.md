# Runtime Env

> Phase 2B-2 后，`mycc-brain` 的运行时环境变量来源统一到项目内自动加载，不再依赖手工临时注入。

## 加载顺序

启动时由 [env.ts](/Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/src/env.ts) 自动按以下顺序处理：

1. 当前进程已有环境变量
2. `.env.local`
3. `.env`

规则：
- `dotenv` 使用 `override=false`
- 已存在于 `process.env` 的值不会被文件覆盖
- `.env.local` 优先于 `.env`

## 当前验证阶段默认模型

默认 brain 模型：

```bash
BRAIN_DEFAULT_MODEL=cc-gemini-3.1-flash
```

对应 raw 对照模型会自动推导为：

```bash
raw-gemini-3.1-flash
```

## 建议放进 `.env.local` 的字段

```bash
BRAIN_PORT=19080
BRAIN_API_KEY=sk-brain-dev
BRAIN_DEFAULT_MODEL=cc-gemini-3.1-flash
GEMINI_PROXY_KEY=...
MINIMAX_API_KEY=...
DATA_DIR=/Users/rayman.chen/mycc/0-System
```

说明：
- `.env.local` 不入库，已在 [.gitignore](/Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/.gitignore) 忽略
- `.env.example` 提供非敏感示例字段
- Studio 常驻运行时，优先维护 `.env.local`，不要依赖“当前 shell 里临时 export”

## 代码落点

- 默认模型与数据目录常量：[env.ts](/Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/src/env.ts)
- 主配置装载：[config.ts](/Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/src/config.ts)
- API 默认模型使用：[brain-api.ts](/Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/src/brain-api.ts)
- Admin 测试/对比/agent 默认模型使用：[server.ts](/Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/src/server.ts)
- Eval 默认模型使用：[eval.ts](/Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/src/eval/eval.ts)

## 验证方式

1. 确认 `.env.local` 已存在且包含在线模型 key
2. 直接启动服务，不额外手工注入环境变量：

```bash
cd /Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain
npm start
```

3. 直连查看模型列表：

```bash
NO_PROXY='*' no_proxy='*' curl --noproxy '*' -s http://127.0.0.1:19080/v1/models
```

4. 用 `cc-gemini-3.1-flash` 做 brain 路由验证，用 `raw-gemini-3.1-flash` 做对照验证

## 当前结论

- `cc-gemini-3.1-flash` 已验证能正确消费环境感知上下文
- `raw-gemini-3.1-flash` 不知道环境状态
- 这说明默认模型、环境变量加载、brain/raw 路由分流三者都已经打通
