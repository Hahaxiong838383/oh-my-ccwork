/**
 * 飞书用户访问令牌 (User Access Token) 授权服务
 *
 * 功能：
 * 1. 生成授权二维码链接
 * 2. 监听授权回调获取 code
 * 3. 换取 user_access_token
 * 4. 自动刷新机制
 */

import http from "http";
// @ts-ignore - qrcode types not installed
import qrcode from "qrcode";
import fs from "fs";
import path from "path";

// 配置
interface FeishuOAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  port?: number;
}

interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // 过期时间戳
  refreshExpiresAt: number; // 刷新令牌过期时间
  tokenType: string;
  scope: string;
}

// 存储令牌（生产环境应加密存储）
let currentToken: TokenData | null = null;
let authConfig: FeishuOAuthConfig | null = null;
let authCallbackResolve: ((code: string) => void) | null = null;
let httpServer: http.Server | null = null;

/**
 * 初始化授权配置
 */
export function initFeishuOAuth(config: FeishuOAuthConfig): void {
  authConfig = {
    port: config.port || 18081,
    ...config,
  };
  console.log(`[FeishuOAuth] 初始化完成，回调地址: ${authConfig.redirectUri}`);
}

/**
 * 生成授权 URL
 */
export function getAuthUrl(): string {
  if (!authConfig) {
    throw new Error("请先调用 initFeishuOAuth 初始化配置");
  }

  const params = new URLSearchParams({
    app_id: authConfig.appId,
    redirect_uri: authConfig.redirectUri,
    state: "feishu_oauth", // 防止 CSRF
  });

  return `https://open.feishu.cn/open-apis/authen/v1/authorize?${params.toString()}`;
}

/**
 * 生成授权二维码图片
 */
export async function generateAuthQRCode(): Promise<string> {
  const authUrl = getAuthUrl();
  // 生成二维码数据 URL
  const qrDataUrl = await qrcode.toDataURL(authUrl, {
    width: 300,
    margin: 2,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
  });

  console.log(`[FeishuOAuth] 授权二维码已生成`);
  console.log(`[FeishuOAuth] 授权链接: ${authUrl}`);

  return qrDataUrl;
}

/**
 * 保存二维码图片到文件
 */
export async function saveAuthQRCodeToFile(filePath: string): Promise<void> {
  const qrDataUrl = await generateAuthQRCode();
  // 移除 data:image/png;base64, 前缀
  const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
  const buffer = Buffer.from(base64Data, "base64");

  fs.writeFileSync(filePath, buffer);
  console.log(`[FeishuOAuth] 二维码已保存到: ${filePath}`);
}

/**
 * 启动本地 HTTP 服务器监听授权回调
 */
function startCallbackServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!authConfig) {
      reject(new Error("请先初始化配置"));
      return;
    }

    const port = authConfig.port!;

    // 如果服务器已存在，先关闭
    if (httpServer) {
      httpServer.close();
    }

    httpServer = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      // 检查 state 防止 CSRF
      if (state !== "feishu_oauth") {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>授权失败</h1><p>State 验证失败</p>");
        return;
      }

      if (code) {
        console.log(`[FeishuOAuth] 收到授权码: ${code.substring(0, 10)}...`);

        // 返回成功页面
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <title>授权成功</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
              .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); text-align: center; }
              .success { color: #52c41a; font-size: 48px; }
              h1 { color: #333; margin: 16px 0; }
              p { color: #666; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="success">✓</div>
              <h1>授权成功</h1>
              <p>请回到终端查看结果</p>
            </div>
          </body>
          </html>
        `);

        // 通知 Promise 完成
        if (authCallbackResolve) {
          authCallbackResolve(code);
          authCallbackResolve = null;
        }

        // 延迟关闭服务器
        setTimeout(() => {
          httpServer?.close();
          httpServer = null;
        }, 1000);
      } else {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>授权失败</h1><p>未收到授权码</p>");
      }
    });

    httpServer.listen(port, () => {
      console.log(`[FeishuOAuth] 授权回调服务器已启动: http://localhost:${port}`);
      console.log(`[FeishuOAuth] 请扫描二维码完成授权`);
    });

    httpServer.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.log(`[FeishuOAuth] 端口 ${port} 已被占用，尝试使用随机端口...`);
        httpServer?.close();
        httpServer = http.createServer((req, res) => {
          const url = new URL(req.url || "/", `http://localhost:${port}`);
          const code = url.searchParams.get("code");
          if (code && authCallbackResolve) {
            authCallbackResolve(code);
            authCallbackResolve = null;
          }
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>授权成功</h1>");
          setTimeout(() => httpServer?.close(), 1000);
        });
        httpServer.listen(0, () => {
          const addr = httpServer?.address();
          if (addr && typeof addr !== "string") {
            console.log(`[FeishuOAuth] 使用随机端口: ${addr.port}`);
          }
        });
      } else {
        reject(err);
      }
    });
  });
}

/**
 * 换取用户访问令牌
 */
async function exchangeCodeForToken(code: string): Promise<TokenData> {
  if (!authConfig) {
    throw new Error("请先初始化配置");
  }

  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/user_access_token/internal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: code,
      app_id: authConfig.appId,
      app_secret: authConfig.appSecret,
    }),
  });

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(`获取令牌失败: ${data.msg} (code: ${data.code})`);
  }

  // 计算过期时间
  const now = Date.now();
  const tokenData: TokenData = {
    accessToken: data.data.access_token,
    refreshToken: data.data.refresh_token,
    expiresAt: now + (data.data.expires_in - 300) * 1000, // 提前 5 分钟过期
    refreshExpiresAt: now + (data.data.refresh_expires_in - 3600) * 1000, // 刷新令牌提前 1 小时
    tokenType: data.data.token_type,
    scope: data.data.scope,
  };

  console.log(`[FeishuOAuth] ✓ 令牌获取成功，有效期: ${data.data.expires_in} 秒`);

  return tokenData;
}

/**
 * 刷新用户访问令牌
 */
async function refreshUserToken(): Promise<TokenData> {
  if (!currentToken?.refreshToken) {
    throw new Error("没有 refresh_token，无法刷新");
  }

  if (!authConfig) {
    throw new Error("请先初始化配置");
  }

  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/user_access_token/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: currentToken.refreshToken,
    }),
  });

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(`刷新令牌失败: ${data.msg} (code: ${data.code})`);
  }

  const now = Date.now();
  currentToken = {
    accessToken: data.data.access_token,
    refreshToken: data.data.refresh_token,
    expiresAt: now + (data.data.expires_in - 300) * 1000,
    refreshExpiresAt: now + (data.data.refresh_expires_in - 3600) * 1000,
    tokenType: data.data.token_type,
    scope: data.data.scope,
  };

  console.log(`[FeishuOAuth] ✓ 令牌刷新成功`);

  return currentToken;
}

// 自动刷新定时器
let refreshTimer: NodeJS.Timeout | null = null;

/**
 * 启动自动刷新
 */
export function startAutoRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  // 每分钟检查一次是否需要刷新
  refreshTimer = setInterval(async () => {
    if (!currentToken) {
      return;
    }

    const now = Date.now();
    const timeUntilExpiry = currentToken.expiresAt - now;
    const timeUntilRefreshExpiry = currentToken.refreshExpiresAt - now;

    // 令牌即将过期或刷新令牌即将过期
    if (timeUntilExpiry < 5 * 60 * 1000 || timeUntilRefreshExpiry < 24 * 60 * 60 * 1000) {
      try {
        console.log(`[FeishuOAuth] 令牌即将过期，开始刷新...`);
        await refreshUserToken();
      } catch (error) {
        console.error(`[FeishuOAuth] 令牌刷新失败:`, error);
      }
    }
  }, 60 * 1000); // 每分钟检查

  console.log(`[FeishuOAuth] ✓ 自动刷新已启动`);
}

/**
 * 停止自动刷新
 */
export function stopAutoRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    console.log(`[FeishuOAuth] 自动刷新已停止`);
  }
}

/**
 * 完整的授权流程
 */
export async function doOAuthFlow(): Promise<TokenData> {
  // 1. 生成二维码
  const qrDataUrl = await generateAuthQRCode();

  // 2. 启动回调服务器
  const codePromise = startCallbackServer();

  // 3. 等待用户扫码授权
  console.log(`[FeishuOAuth] 等待用户扫码授权...`);

  const code = await codePromise;

  // 4. 换取令牌
  const tokenData = await exchangeCodeForToken(code);

  // 5. 保存令牌
  currentToken = tokenData;

  // 6. 启动自动刷新
  startAutoRefresh();

  return tokenData;
}

/**
 * 获取当前有效的用户访问令牌
 */
export function getUserAccessToken(): string | null {
  if (!currentToken) {
    return null;
  }

  // 检查是否过期
  if (Date.now() > currentToken.expiresAt) {
    console.log(`[FeishuOAuth] 令牌已过期，尝试刷新...`);
    // 同步返回旧令牌，异步刷新
    refreshUserToken()
      .then((token) => {
        currentToken = token;
      })
      .catch((err) => {
        console.error(`[FeishuOAuth] 令牌刷新失败:`, err);
      });
  }

  return currentToken?.accessToken || null;
}

/**
 * 检查是否已授权
 */
export function isAuthorized(): boolean {
  return currentToken !== null && Date.now() < currentToken.expiresAt;
}

/**
 * 手动刷新令牌
 */
export async function manualRefresh(): Promise<boolean> {
  try {
    await refreshUserToken();
    return true;
  } catch (error) {
    console.error(`[FeishuOAuth] 手动刷新失败:`, error);
    return false;
  }
}

/**
 * 获取令牌信息（不含敏感数据）
 */
export function getTokenInfo(): { expiresAt: number; refreshExpiresAt: number } | null {
  if (!currentToken) {
    return null;
  }
  return {
    expiresAt: currentToken.expiresAt,
    refreshExpiresAt: currentToken.refreshExpiresAt,
  };
}

/**
 * 清理资源
 */
export function cleanup(): void {
  stopAutoRefresh();
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}
