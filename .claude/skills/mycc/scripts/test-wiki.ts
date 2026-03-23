import { parseEnvFile } from './src/env-loader';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// 获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载 .env 文件
const envPath = join(__dirname, '.env');
const envContent = readFileSync(envPath, 'utf-8');
const env = parseEnvFile(envContent);

// 设置环境变量（必须在导入之前！）
Object.assign(process.env, env);

// 先测试 token 获取
const tokenResponse = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    app_id: env.FEISHU_APP_ID,
    app_secret: env.FEISHU_APP_SECRET,
  }),
});

console.log("Token 响应状态:", tokenResponse.status);
const tokenText = await tokenResponse.text();
console.log("Token 响应内容:", tokenText.substring(0, 500));

// 测试搜索知识库 API
const token = JSON.parse(tokenText).tenant_access_token;
const searchResponse = await fetch("https://open.feishu.cn/open-apis/wiki/v2/spaces/search", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ page_size: 50 }),
});

console.log("搜索知识库状态:", searchResponse.status);
const searchText = await searchResponse.text();
console.log("搜索知识库响应:", searchText.substring(0, 500));

// 动态导入（在设置环境变量之后）
const { saveDailyReportToWiki } = await import('./src/services/wiki-service');

const testContent = `
## 今日 IPO 市场概览

### 市场动态
- A 股今日无新增 IPO 申请
- 科创板审议通过 1 家企业首发申请

### 重点关注
**企业名称**：宁德时代（CATL）
**行业**：新能源汽车动力电池
**预计融资规模**：50 亿元
**审核状态**：已受理

### 投资建议
1. 关注新能源产业链龙头企业
2. 把握科创板政策红利
3. 分散投资风险，控制仓位

---
生成时间：2026-02-26
`;

// 测试保存到知识库
const result = await saveDailyReportToWiki(
  'IPO市场报告',
  new Date(),
  testContent,
  '日报'
);

console.log('结果:', JSON.stringify(result, null, 2));
