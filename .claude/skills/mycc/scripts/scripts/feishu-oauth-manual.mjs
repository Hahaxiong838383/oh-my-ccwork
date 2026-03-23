/**
 * 飞书用户访问令牌授权 - 手动模式
 *
 * 使用方法：
 * npx tsx scripts/feishu-oauth-manual.mjs
 */

import qrcode from "qrcode";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 加载环境变量
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error("❌ 请在 .env 文件中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET");
  process.exit(1);
}

// 移动端授权 - 不需要回调地址，用户手动复制授权码
const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=https://www.feishu.cn&state=manual`;

console.log("=".repeat(50));
console.log("  飞书用户访问令牌授权（手动模式）");
console.log("=".repeat(50));
console.log();
console.log("📱 在手机浏览器打开以下链接：");
console.log(authUrl);
console.log();

// 生成二维码保存到文件
const qrCodePath = path.join(__dirname, "feishu-manual-auth-qr.png");
await qrcode.toFile(qrCodePath, authUrl, {
  width: 400,
  margin: 2
});
console.log(`📷 二维码已保存到: ${qrCodePath}`);
console.log();

console.log("📋 授权步骤：");
console.log("1. 用手机浏览器扫描二维码打开授权页面");
console.log("2. 在飞书授权页面完成授权");
console.log("3. 授权成功后，页面会显示一个授权码（或显示 redirect_uri 错误，这很正常）");
console.log("4. 把授权码复制到这里");
console.log();
console.log("⚠️  如果页面显示 redirect_uri 错误，说明授权已经成功！");
console.log("   飞书移动端授权不会直接返回授权码到回调地址");
console.log("   请尝试以下方法：");
console.log("   1. 使用飞书开放平台后台的 OAuth 调试工具");
console.log("   2. 或者配置一个公网可访问的回调地址");
console.log();
