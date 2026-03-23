import { readFileSync } from 'fs';

const envContent = readFileSync('./.env', 'utf-8');
const env: Record<string, string> = {};
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=');
  if (key && valueParts.length > 0 && !key.startsWith('#')) {
    env[key.trim()] = valueParts.join('=').trim();
  }
});

const appId = env.FEISHU_APP_ID;
const appSecret = env.FEISHU_APP_SECRET;

async function main() {
  // 获取 app token
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const tokenData = await tokenRes.json();
  console.log('Token result:', tokenData.code === 0 ? 'success' : tokenData.msg);

  if (tokenData.tenant_access_token) {
    // 搜索知识库
    const searchRes = await fetch('https://open.feishu.cn/open-apis/wiki/v2/spaces?page_size=50', {
      headers: { 'Authorization': 'Bearer ' + tokenData.tenant_access_token }
    });
    const searchData = await searchRes.json();
    console.log('Spaces count:', searchData.data?.items?.length || 0);
    if (searchData.data?.items) {
      console.log('Spaces:');
      searchData.data.items.forEach((s: any) => {
        console.log(`  - ${s.name} (${s.space_id})`);
      });
    }
  }
}

main();
