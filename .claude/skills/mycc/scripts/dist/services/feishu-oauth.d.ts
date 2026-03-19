/**
 * 飞书用户访问令牌 (User Access Token) 授权服务
 *
 * 功能：
 * 1. 生成授权二维码链接
 * 2. 监听授权回调获取 code
 * 3. 换取 user_access_token
 * 4. 自动刷新机制
 */
interface FeishuOAuthConfig {
    appId: string;
    appSecret: string;
    redirectUri: string;
    port?: number;
}
interface TokenData {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    refreshExpiresAt: number;
    tokenType: string;
    scope: string;
}
/**
 * 初始化授权配置
 */
export declare function initFeishuOAuth(config: FeishuOAuthConfig): void;
/**
 * 生成授权 URL
 */
export declare function getAuthUrl(): string;
/**
 * 生成授权二维码图片
 */
export declare function generateAuthQRCode(): Promise<string>;
/**
 * 保存二维码图片到文件
 */
export declare function saveAuthQRCodeToFile(filePath: string): Promise<void>;
/**
 * 启动自动刷新
 */
export declare function startAutoRefresh(): void;
/**
 * 停止自动刷新
 */
export declare function stopAutoRefresh(): void;
/**
 * 完整的授权流程
 */
export declare function doOAuthFlow(): Promise<TokenData>;
/**
 * 获取当前有效的用户访问令牌
 */
export declare function getUserAccessToken(): string | null;
/**
 * 检查是否已授权
 */
export declare function isAuthorized(): boolean;
/**
 * 手动刷新令牌
 */
export declare function manualRefresh(): Promise<boolean>;
/**
 * 获取令牌信息（不含敏感数据）
 */
export declare function getTokenInfo(): {
    expiresAt: number;
    refreshExpiresAt: number;
} | null;
/**
 * 清理资源
 */
export declare function cleanup(): void;
export {};
//# sourceMappingURL=feishu-oauth.d.ts.map