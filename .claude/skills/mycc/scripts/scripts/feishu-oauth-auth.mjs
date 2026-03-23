/**
 * 飞书用户访问令牌授权启动脚本
 *
 * 使用方法：
 * npx tsx scripts/feishu-oauth-auth.mjs
 */

import { initFeishuOAuth, doOAuthFlow, getTokenInfo, isAuthorized, manualRefresh } from "../src/services/feishu-oauth.js";
import qrcodeTerminal from "qrcode-terminal";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 加载环境变量（从 scripts 目录的父目录）
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error("❌ 请在 .env 文件中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET");
  console.log("\n示例配置：");
  console.log("FEISHU_APP_ID=cli_xxxxxxxxxxxxx");
  console.log("FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxx");
  process.exit(1);
}

// 授权回调地址（本地服务器）
const redirectUri = "http://localhost:18081/callback";

async function main() {
  console.log("=".repeat(50));
  console.log("  飞书用户访问令牌授权工具");
  console.log("=".repeat(50));
  console.log();

  // 初始化
  initFeishuOAuth({
    appId,
    appSecret,
    redirectUri,
  });

  // 检查是否已授权
  if (isAuthorized()) {
    console.log("✅ 已存在有效令牌");
    const info = getTokenInfo();
    if (info) {
      console.log(`   令牌过期时间: ${new Date(info.expiresAt).toLocaleString()}`);
      console.log(`   刷新令牌过期时间: ${new Date(info.refreshExpiresAt).toLocaleString()}`);
    }
    console.log();

    // 询问是否重新授权
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const answer = await new Promise<string>((resolve) => {
      rl.question("是否重新授权? (y/N): ", (ans) => {
        rl.close();
        resolve(ans.toLowerCase());
      });
    });

    if (answer !== "y") {
      console.log("退出");
      process.exit(0);
    }
    console.log();
  }

  // 开始授权流程
  console.log("📱 正在生成授权二维码...");
  console.log();

  // 获取授权 URL 并生成终端二维码
  const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=feishu_oauth`;

  // 在终端显示二维码
  qrcodeTerminal.generate(authUrl, { small: true });

  console.log();
  console.log("📋 请使用飞书扫码授权");
  console.log(`🔗 授权链接: ${authUrl}`);
  console.log();

  // 同时保存二维码图片到文件
  const { generateAuthQRCode, saveAuthQRCodeToFile } = await import("../src/services/feishu-oauth.js");
  const qrCodePath = path.join(__dirname, "feishu-user-auth-qr.png");
  await saveAuthQRCodeToFile(qrCodePath);
  console.log(`📷 二维码已保存到: ${qrCodePath}`);
  console.log();

  // 启动授权流程（会启动本地服务器等待回调）
  try {
    const tokenData = await doOAuthFlow();

    console.log();
    console.log("=".repeat(50));
    console.log("  ✅ 授权成功！");
    console.log("=".repeat(50));
    console.log(`🔑 令牌类型: ${tokenData.tokenType}`);
    console.log(`📝 权限范围: ${tokenData.scope}`);
    console.log(`⏰ 令牌过期时间: ${new Date(tokenData.expiresAt).toLocaleString()}`);
    console.log(`🔄 刷新令牌过期时间: ${new Date(tokenData.refreshExpiresAt).toLocaleString()}`);
    console.log();
    console.log("💡 自动刷新已启动，程序将持续运行");
    console.log("   按 Ctrl+C 退出");

    // 保持进程运行
    process.on("SIGINT", () => {
      console.log("\n\n👋 授权服务已停止");
      process.exit(0);
    });
  } catch (error) {
    console.error("❌ 授权失败:", error);
    process.exit(1);
  }
}

main();
