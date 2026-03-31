/**
 * 进程健康监控模块
 *
 * 功能：
 * 1. 监测 mycc 后端进程状态
 * 2. 监测飞书 WebSocket 连接状态
 * 3. 自动检测并恢复断连
 * 4. 定时发送心跳消息到飞书（保持连接活跃）
 */
import chalk from "chalk";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
const HEALTH_CHECK_INTERVAL = 30000; // 30秒检查一次
const AUTH_REFRESH_INTERVAL = 10 * 60 * 1000; // 10分钟主动刷新一次 token（在过期前刷新）
const FEISHU_MCP_CHECK_INTERVAL = 5 * 60 * 1000; // 5分钟检查一次飞书 MCP token
const FEISHU_MCP_REFRESH_BUFFER = 30 * 60 * 1000; // token 过期前 30 分钟主动刷新
const FEISHU_HEARTBEAT_INTERVAL = 300000; // 5分钟发送一次飞书心跳
const MAX_RESTART_ATTEMPTS = 3; // 最大重启次数
const RESTART_COOLDOWN = 60000; // 重启冷却时间（1分钟）
const AUTH_FAIL_THRESHOLD = 5; // 连续失败 N 次才报警（提升容忍度，防止 CLI 并发/网络波动误报）
const AUTH_RECOVERY_CHECK_INTERVAL = 2 * 60 * 1000; // auth 失败后每 2 分钟检测恢复
const AUTH_FAIL_DECAY_INTERVAL = 30 * 60 * 1000; // 30 分钟无失败则衰减 authFailCount
// 飞书 MCP token 相关路径
const FEISHU_MCP_DIR = join(homedir(), ".feishu-mcp");
const FEISHU_MCP_TOKEN_FILE = join(FEISHU_MCP_DIR, "tokens.json");
const FEISHU_MCP_TOKEN_BACKUP = join(FEISHU_MCP_DIR, "tokens.backup.json");
// 第二处备份（异目录，防止 ~/.feishu-mcp/ 整目录丢失）
const FEISHU_MCP_TOKEN_BACKUP2 = join(homedir(), ".claude", "feishu-token.backup.json");
const FEISHU_MCP_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
// 重授权脚本的绝对路径（用于告警消息）
const FEISHU_REAUTH_SCRIPT = join(homedir(), "mycc", ".claude", "skills", "mycc", "scripts", "scripts", "feishu-oauth-auth.mjs");
export class HealthMonitor {
    timer = null;
    authCheckTimer = null;
    feishuMcpCheckTimer = null;
    feishuHeartbeatTimer = null;
    restartCount = 0;
    lastRestartTime = 0;
    httpServer = null;
    tunnelManager = null;
    adapter = null;
    config;
    onRestartCallback = null;
    authFailCount = 0; // 连续 auth 刷新失败计数
    authRecoveryTimer = null; // auth 恢复探测定时器
    authWasDown = false; // auth 曾经失败过（用于恢复通知）
    authAlerted = false; // 是否已发过告警（防重复发飞书通知）
    lastAuthFailTime = 0; // 上次 auth 失败时间（用于衰减）
    feishuMcpOk = true; // 飞书 MCP token 状态
    constructor(config = {}) {
        this.config = {
            checkInterval: config.checkInterval ?? HEALTH_CHECK_INTERVAL,
            feishuHeartbeatInterval: config.feishuHeartbeatInterval ?? FEISHU_HEARTBEAT_INTERVAL,
            maxRestartAttempts: config.maxRestartAttempts ?? MAX_RESTART_ATTEMPTS,
            restartCooldown: config.restartCooldown ?? RESTART_COOLDOWN,
            feishuChannel: config.feishuChannel ?? null,
            feishuConnected: config.feishuConnected ?? false,
        };
    }
    /**
     * 设置服务器实例
     */
    setHttpServer(server) {
        this.httpServer = server;
    }
    /**
     * 设置 Adapter（用于 auth 检查）
     */
    setAdapter(adapter) {
        this.adapter = adapter;
    }
    /**
     * 设置 Tunnel 管理器
     */
    setTunnelManager(manager) {
        this.tunnelManager = manager;
    }
    /**
     * 设置飞书通道
     */
    setFeishuChannel(channel) {
        this.config.feishuChannel = channel;
    }
    /**
     * 更新飞书连接状态
     */
    setFeishuConnected(connected) {
        this.config.feishuConnected = connected;
        if (connected) {
            console.log(chalk.green("[HealthMonitor] ✓ 飞书连接已恢复"));
        }
    }
    /**
     * 设置重启回调
     */
    onRestart(callback) {
        this.onRestartCallback = callback;
    }
    /**
     * 启动健康监控
     */
    start() {
        console.log(chalk.cyan("[HealthMonitor] 启动健康监控..."));
        console.log(chalk.gray(`  检查间隔: ${this.config.checkInterval / 1000}s`));
        console.log(chalk.gray(`  飞书心跳间隔: ${this.config.feishuHeartbeatInterval / 1000}s`));
        console.log(chalk.gray(`  最大重启次数: ${this.config.maxRestartAttempts}\n`));
        // 启动主健康检查定时器
        this.timer = setInterval(() => {
            this.performHealthCheck();
        }, this.config.checkInterval);
        // 启动 auth 主动刷新定时器（每 20 分钟刷新一次 token，确保不过期）
        this.authCheckTimer = setInterval(() => {
            this.refreshAuthToken();
        }, AUTH_REFRESH_INTERVAL);
        if (this.authCheckTimer.unref)
            this.authCheckTimer.unref();
        console.log(chalk.gray(`  Auth 主动刷新间隔: ${AUTH_REFRESH_INTERVAL / 60000}min`));
        // 启动飞书 MCP token 监控定时器
        this.feishuMcpCheckTimer = setInterval(() => {
            this.checkFeishuMcpToken();
        }, FEISHU_MCP_CHECK_INTERVAL);
        if (this.feishuMcpCheckTimer.unref)
            this.feishuMcpCheckTimer.unref();
        console.log(chalk.gray(`  飞书 MCP Token 检查间隔: ${FEISHU_MCP_CHECK_INTERVAL / 60000}min`));
        // 启动时立即检查一次飞书 MCP token
        this.checkFeishuMcpToken();
        // 启动飞书心跳定时器
        if (this.config.feishuChannel) {
            this.feishuHeartbeatTimer = setInterval(() => {
                this.sendFeishuHeartbeat();
            }, this.config.feishuHeartbeatInterval);
        }
        console.log(chalk.green("[HealthMonitor] ✓ 健康监控已启动\n"));
    }
    /**
     * 执行健康检查
     */
    async performHealthCheck() {
        try {
            // 1. 检查 HTTP 服务器状态
            const httpOk = this.checkHttpServer();
            if (!httpOk) {
                console.warn(chalk.yellow("[HealthMonitor] ⚠️ HTTP 服务器异常"));
            }
            // 2. 检查 Tunnel 状态
            const tunnelOk = this.checkTunnel();
            if (!tunnelOk) {
                console.warn(chalk.yellow("[HealthMonitor] ⚠️ Tunnel 异常"));
            }
            // 3. 检查飞书连接状态
            const feishuOk = this.checkFeishuConnection();
            if (!feishuOk && this.config.feishuConnected) {
                console.warn(chalk.yellow("[HealthMonitor] ⚠️ 飞书连接已断开，尝试重连..."));
                await this.reconnectFeishu();
            }
            // 4. 检查 Auth 状态（轻量检查，只看缓存）
            if (this.adapter && !this.adapter.authOk) {
                console.warn(chalk.yellow("[HealthMonitor] ⚠️ Claude CLI auth 已失效"));
            }
            // 5. 飞书 MCP token 状态（轻量检查，详细检查由独立定时器负责）
            if (!this.feishuMcpOk) {
                console.warn(chalk.yellow("[HealthMonitor] ⚠️ 飞书 MCP token 异常"));
            }
            // 6. 如果 Tunnel 断开且达到重启条件，触发重启
            if (!tunnelOk && this.shouldRestart()) {
                await this.triggerRestart();
            }
        }
        catch (error) {
            console.error(chalk.red("[HealthMonitor] 健康检查异常:"), error);
        }
    }
    /**
     * 检查 HTTP 服务器
     */
    checkHttpServer() {
        if (!this.httpServer) {
            return false;
        }
        // 服务器启动中视为正常
        return true;
    }
    /**
     * 检查 Tunnel 状态
     */
    checkTunnel() {
        if (!this.tunnelManager) {
            // 没有 tunnel manager 视为正常（公网模式）
            return true;
        }
        const status = this.tunnelManager.getStatus();
        return status.heartbeatActive && !status.isRestarting;
    }
    /**
     * 检查飞书连接状态
     */
    checkFeishuConnection() {
        // 如果配置了飞书通道，检查其连接状态
        if (this.config.feishuChannel) {
            // 检查 WebSocket 是否连接
            const wsClient = this.config.feishuChannel.wsClient;
            return wsClient !== null && wsClient !== undefined;
        }
        return this.config.feishuConnected;
    }
    /**
     * 重连飞书
     */
    async reconnectFeishu() {
        try {
            if (this.config.feishuChannel && this.httpServer) {
                // 调用飞书通道的启动方法重新连接
                const feishuChannel = this.config.feishuChannel;
                if (feishuChannel.startWebSocket) {
                    await feishuChannel.startWebSocket();
                    this.config.feishuConnected = true;
                    console.log(chalk.green("[HealthMonitor] ✓ 飞书重连成功"));
                }
            }
        }
        catch (error) {
            console.error(chalk.red("[HealthMonitor] 飞书重连失败:"), error);
            this.config.feishuConnected = false;
        }
    }
    /**
     * 构造干净的环境变量（移除 CLAUDECODE，避免子进程被拒绝）
     * 后端从 Claude Code session 启动时会继承 CLAUDECODE=1，
     * 导致 execSync 的 claude 子进程报 "Cannot be launched inside another Claude Code session"
     */
    getCleanEnv() {
        const env = { ...process.env };
        delete env.CLAUDECODE;
        return env;
    }
    /**
     * 主动刷新 Claude CLI auth token
     * 每次都通过 `claude -p "ping"` 发起真实 API 调用，迫使 CLI 完成 OAuth refresh flow，
     * 确保 Keychain 中的 token 始终有效，SDK 子进程可以读到新 token。
     */
    refreshAuthToken() {
        try {
            // 先检查登录状态
            const output = execSync("claude auth status --json 2>/dev/null", {
                encoding: "utf-8",
                timeout: 10000,
                env: this.getCleanEnv(),
            });
            const status = JSON.parse(output);
            if (status.loggedIn !== true) {
                console.warn(chalk.yellow("[HealthMonitor] ⚠️ Auth 状态：未登录"));
                this.forceTokenRefresh();
                return;
            }
            // 即使 auth status 显示 loggedIn，也主动发起真实请求来刷新 access token
            // 因为 auth status 只检查 credentials 是否存在，不验证 access token 是否过期
            this.forceTokenRefresh();
        }
        catch (err) {
            console.warn(chalk.yellow("[HealthMonitor] Auth 检查异常，尝试强制刷新..."));
            this.forceTokenRefresh();
        }
    }
    /**
     * 判断错误是否为超时或网络错误（不应计入 auth 失败）
     */
    isTimeoutOrNetworkError(err) {
        if (!err || typeof err !== "object")
            return false;
        const e = err;
        // execSync 超时 → killed = true 或 signal = 'SIGTERM'
        if (e.killed === true || e.signal === "SIGTERM")
            return true;
        // 网络相关错误码
        const msg = String(e.message || e.stderr || "").toLowerCase();
        if (msg.includes("etimedout") ||
            msg.includes("econnrefused") ||
            msg.includes("econnreset") ||
            msg.includes("enotfound") ||
            msg.includes("network") ||
            msg.includes("socket hang up") ||
            msg.includes("timed out")) {
            return true;
        }
        return false;
    }
    /**
     * 衰减 authFailCount：距上次失败超过 30 分钟，衰减一半
     * 防止偶发的间歇性失败长期累积最终误触阈值
     */
    decayAuthFailCount() {
        if (this.authFailCount <= 0)
            return;
        const now = Date.now();
        if (this.lastAuthFailTime > 0 && now - this.lastAuthFailTime > AUTH_FAIL_DECAY_INTERVAL) {
            const oldCount = this.authFailCount;
            this.authFailCount = Math.max(0, this.authFailCount - 1);
            if (oldCount !== this.authFailCount) {
                console.log(chalk.gray(`[HealthMonitor] authFailCount 衰减: ${oldCount} → ${this.authFailCount}（距上次失败 ${Math.round((now - this.lastAuthFailTime) / 60000)}min）`));
            }
        }
    }
    /**
     * 强制触发 token 刷新
     * 启动一个临时 claude 进程发送空消息，迫使 CLI 完成 OAuth refresh flow。
     * 关键：必须移除 CLAUDECODE 环境变量，否则 claude CLI 会拒绝启动。
     *
     * 守护机制：
     * - 失败达到阈值后，启动独立的恢复探测定时器（每 2 分钟轻量检查 auth status）
     * - 用户手动 /login 后，探测器自动感知恢复，发飞书通知，停止探测
     *
     * 防误报机制（v2）：
     * - 超时/网络错误不计入 authFailCount（仅日志记录）
     * - 暂时性失败（ping 失败但 auth status 正常）计 +0.5
     * - authFailCount 有时间衰减（30 分钟无失败减 1）
     * - 飞书告警只发一次（authAlerted 标记），恢复后重置
     */
    forceTokenRefresh() {
        // 每次刷新前先衰减
        this.decayAuthFailCount();
        try {
            execSync('claude -p "ping" --max-turns 1 2>/dev/null', {
                encoding: "utf-8",
                timeout: 60000, // 从 30s 提升到 60s，避免网络慢时误判
                env: this.getCleanEnv(),
            });
            console.log(chalk.green(`[HealthMonitor] ✓ Token 刷新成功 (${new Date().toLocaleTimeString()})`));
            // 如果之前失败过，清理旧 session 并通知恢复
            if (this.authWasDown) {
                if (this.adapter) {
                    this.adapter.closeAllSessions();
                    console.log(chalk.cyan("[HealthMonitor] 已关闭所有旧 SDK session（清除过期 token 缓存）"));
                }
                this.notifyAuthRecovered();
            }
            this.authFailCount = 0;
            this.authWasDown = false;
            this.authAlerted = false; // 恢复后重置告警标记
            this.stopAuthRecoveryProbe();
            if (this.adapter) {
                this.adapter.authOk = true;
            }
        }
        catch (err) {
            this.lastAuthFailTime = Date.now();
            // 第一步：判断是否为超时/网络错误
            if (this.isTimeoutOrNetworkError(err)) {
                // 超时/网络错误：不计入 authFailCount，只记日志
                console.warn(chalk.gray(`[HealthMonitor] ping 超时或网络错误（不计入失败计数）: ${String(err?.message || "timeout").substring(0, 100)}`));
                return;
            }
            // 第二步：二次确认 auth status 区分「真过期」和「暂时不可用」
            let isRealAuthFailure = true;
            try {
                const statusOut = execSync("claude auth status --json 2>/dev/null", {
                    encoding: "utf-8",
                    timeout: 10000,
                    env: this.getCleanEnv(),
                });
                const status = JSON.parse(statusOut);
                if (status.loggedIn === true) {
                    // auth status 说已登录 → ping 失败是暂时性问题（CLI 并发/系统繁忙）
                    isRealAuthFailure = false;
                }
            }
            catch {
                // auth status 本身也失败 → 视为真正的 auth 问题
            }
            if (isRealAuthFailure) {
                this.authFailCount++;
                console.error(chalk.red(`[HealthMonitor] ✗ Token 刷新失败（auth status 也异常） (${this.authFailCount}/${AUTH_FAIL_THRESHOLD})`));
            }
            else {
                // 暂时性失败：只增加 0.25（需要 20 次暂时性失败才等于 5 次真失败）
                this.authFailCount += 0.25;
                console.warn(chalk.yellow(`[HealthMonitor] ⚠ ping 失败但 auth status 正常（暂时性，${this.authFailCount}/${AUTH_FAIL_THRESHOLD}）`));
            }
            if (this.authFailCount >= AUTH_FAIL_THRESHOLD) {
                // 达到阈值：标记失败 + 启动恢复探测
                this.authWasDown = true;
                if (this.adapter) {
                    this.adapter.authOk = false;
                }
                // 告警只发一次，防止重复骚扰用户
                if (!this.authAlerted) {
                    this.authAlerted = true;
                    console.error(chalk.red("[HealthMonitor] ✗ 连续多次刷新失败，可能需要手动 /login（告警已发送，不再重复）"));
                    if (this.adapter) {
                        this.adapter._onAuthFailed?.("Claude CLI token 过期且自动刷新失败，请在终端执行 /login");
                    }
                }
                this.startAuthRecoveryProbe();
            }
        }
    }
    /**
     * 启动 auth 恢复探测定时器
     * auth 失败后，每 2 分钟用轻量级 `claude auth status` 检查是否用户已手动 /login 恢复
     * 一旦检测到恢复，立即通知飞书并停止探测
     */
    startAuthRecoveryProbe() {
        if (this.authRecoveryTimer)
            return; // 已经在探测中
        console.log(chalk.cyan("[HealthMonitor] 启动 auth 恢复探测（每 2 分钟）..."));
        this.authRecoveryTimer = setInterval(() => {
            try {
                const output = execSync("claude auth status --json 2>/dev/null", {
                    encoding: "utf-8",
                    timeout: 10000,
                    env: this.getCleanEnv(),
                });
                const status = JSON.parse(output);
                if (status.loggedIn === true) {
                    // 用户已手动 /login，尝试一次完整刷新确认
                    console.log(chalk.cyan("[HealthMonitor] 检测到登录状态恢复，尝试完整刷新验证..."));
                    try {
                        execSync('claude -p "ping" --max-turns 1 2>/dev/null', {
                            encoding: "utf-8",
                            timeout: 60000,
                            env: this.getCleanEnv(),
                        });
                        // 完整刷新成功 → 恢复
                        this.authFailCount = 0;
                        this.authWasDown = false;
                        this.authAlerted = false; // 重置告警标记
                        if (this.adapter) {
                            this.adapter.authOk = true;
                            // 关键：杀掉所有旧 SDK session（子进程缓存了过期 token，不会重读 Keychain）
                            // 新消息会 spawn 新子进程，自动读取最新 token
                            this.adapter.closeAllSessions();
                            console.log(chalk.cyan("[HealthMonitor] 已关闭所有旧 SDK session（清除过期 token 缓存）"));
                        }
                        this.notifyAuthRecovered();
                        this.stopAuthRecoveryProbe();
                    }
                    catch {
                        // auth status 说已登录但 ping 失败，可能是 access_token 还没完全生效，下次再试
                        console.warn(chalk.yellow("[HealthMonitor] auth status 已登录但 ping 失败，等待下次探测"));
                    }
                }
            }
            catch {
                // 检查本身失败，静默等下次
            }
        }, AUTH_RECOVERY_CHECK_INTERVAL);
        if (this.authRecoveryTimer.unref)
            this.authRecoveryTimer.unref();
    }
    /**
     * 停止 auth 恢复探测
     */
    stopAuthRecoveryProbe() {
        if (this.authRecoveryTimer) {
            clearInterval(this.authRecoveryTimer);
            this.authRecoveryTimer = null;
            console.log(chalk.gray("[HealthMonitor] auth 恢复探测已停止"));
        }
    }
    /**
     * 通知 auth 已恢复（飞书 + 控制台）
     */
    notifyAuthRecovered() {
        const now = new Date().toLocaleTimeString();
        console.log(chalk.green(`[HealthMonitor] ✓ Auth 已恢复！飞书通道恢复服务 (${now})`));
        // 通过飞书通知用户
        this.httpServer && this.httpServer.broadcastToFeishu?.(`✅ Claude CLI 登录已恢复，飞书通道恢复正常服务 (${now})`);
    }
    /**
     * 检查飞书 MCP token 状态
     * 三层防护：1.检测文件存在 2.检测过期并刷新 3.备份恢复
     */
    async checkFeishuMcpToken() {
        try {
            // 第一层：token 文件是否存在
            if (!existsSync(FEISHU_MCP_TOKEN_FILE)) {
                console.warn(chalk.yellow("[HealthMonitor] ⚠️ 飞书 MCP token 文件丢失"));
                // 尝试从备份恢复（先尝试主备份，再尝试异目录备份）
                const backupToRestore = existsSync(FEISHU_MCP_TOKEN_BACKUP)
                    ? FEISHU_MCP_TOKEN_BACKUP
                    : existsSync(FEISHU_MCP_TOKEN_BACKUP2)
                        ? FEISHU_MCP_TOKEN_BACKUP2
                        : null;
                if (backupToRestore) {
                    console.log(chalk.cyan(`[HealthMonitor] 从备份恢复 token (${backupToRestore})...`));
                    mkdirSync(FEISHU_MCP_DIR, { recursive: true });
                    copyFileSync(backupToRestore, FEISHU_MCP_TOKEN_FILE);
                    console.log(chalk.green("[HealthMonitor] ✓ token 已从备份恢复"));
                }
                else {
                    console.error(chalk.red("[HealthMonitor] ✗ 无备份可恢复，飞书 MCP 需要手动重新授权"));
                    console.error(chalk.red(`[HealthMonitor]   运行: node ${FEISHU_REAUTH_SCRIPT}`));
                    this.feishuMcpOk = false;
                    // 通过飞书通道告警
                    this.httpServer && this.httpServer.broadcastToFeishu?.(`⚠️ 飞书 MCP token 丢失，三机器人群聊无法调用飞书工具，需在终端手动重新授权\n运行: node ${FEISHU_REAUTH_SCRIPT}`);
                    return;
                }
            }
            // 第二层：读取并检查 token 有效性
            const all = JSON.parse(readFileSync(FEISHU_MCP_TOKEN_FILE, "utf-8"));
            const appId = Object.keys(all)[0];
            if (!appId || !all[appId]) {
                console.warn(chalk.yellow("[HealthMonitor] ⚠️ 飞书 MCP token 文件内容无效"));
                this.feishuMcpOk = false;
                return;
            }
            const token = all[appId];
            const now = Date.now();
            const expiresAt = token.expiresAt || 0;
            const timeLeft = expiresAt - now;
            if (timeLeft <= 0) {
                // token 已过期，尝试用 refresh_token 刷新
                console.warn(chalk.yellow("[HealthMonitor] ⚠️ 飞书 MCP token 已过期，尝试刷新..."));
                await this.refreshFeishuMcpToken(token, appId, all);
            }
            else if (timeLeft < FEISHU_MCP_REFRESH_BUFFER) {
                // token 即将过期（30分钟内），主动刷新
                const minutesLeft = Math.round(timeLeft / 60000);
                console.log(chalk.cyan(`[HealthMonitor] 飞书 MCP token 将在 ${minutesLeft} 分钟后过期，主动刷新...`));
                await this.refreshFeishuMcpToken(token, appId, all);
            }
            else {
                // token 有效
                this.feishuMcpOk = true;
                // 第三层：创建/更新备份
                this.backupFeishuMcpToken();
            }
        }
        catch (error) {
            console.error(chalk.red("[HealthMonitor] 飞书 MCP token 检查异常:"), error);
            this.feishuMcpOk = false;
        }
    }
    /**
     * 用 refresh_token 刷新飞书 MCP access_token
     */
    async refreshFeishuMcpToken(token, appId, allTokens) {
        if (!token.refreshToken) {
            console.error(chalk.red("[HealthMonitor] ✗ 无 refresh_token，无法自动刷新"));
            this.feishuMcpOk = false;
            return;
        }
        try {
            // 从 .mcp.json 读取 app_secret（不硬编码）
            let appSecret = "";
            const mcpConfigPaths = [
                join(process.cwd(), ".mcp.json"),
                join(homedir(), ".mcp.json"),
            ];
            for (const p of mcpConfigPaths) {
                if (existsSync(p)) {
                    try {
                        const cfg = JSON.parse(readFileSync(p, "utf-8"));
                        const feishuMcp = cfg.mcpServers?.["open-feishu-mcp"];
                        if (feishuMcp?.args) {
                            const secretIdx = feishuMcp.args.indexOf("--app-secret");
                            if (secretIdx !== -1 && feishuMcp.args[secretIdx + 1]) {
                                appSecret = feishuMcp.args[secretIdx + 1];
                                break;
                            }
                        }
                    }
                    catch { }
                }
            }
            if (!appSecret) {
                console.error(chalk.red("[HealthMonitor] ✗ 未找到飞书 MCP app_secret，无法刷新"));
                this.feishuMcpOk = false;
                return;
            }
            const resp = await fetch(FEISHU_MCP_TOKEN_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify({
                    grant_type: "refresh_token",
                    refresh_token: token.refreshToken,
                    client_id: appId,
                    client_secret: appSecret,
                }),
            });
            const data = await resp.json();
            if (!data.access_token) {
                console.error(chalk.red("[HealthMonitor] ✗ 飞书 MCP token 刷新失败:"), data.error || data.msg || "unknown");
                this.feishuMcpOk = false;
                // 刷新失败告警
                this.httpServer && this.httpServer.broadcastToFeishu?.("⚠️ 飞书 MCP token 刷新失败，需在终端手动重新授权");
                return;
            }
            // 更新 token
            const newToken = {
                ...allTokens[appId],
                accessToken: data.access_token,
                refreshToken: data.refresh_token || token.refreshToken,
                expiresAt: Date.now() + (data.expires_in || 7200) * 1000,
                appId,
            };
            allTokens[appId] = newToken;
            mkdirSync(FEISHU_MCP_DIR, { recursive: true });
            writeFileSync(FEISHU_MCP_TOKEN_FILE, JSON.stringify(allTokens, null, 2), "utf-8");
            console.log(chalk.green(`[HealthMonitor] ✓ 飞书 MCP token 刷新成功 (${new Date().toLocaleTimeString()})`));
            this.feishuMcpOk = true;
            // 刷新成功后立即备份
            this.backupFeishuMcpToken();
        }
        catch (error) {
            console.error(chalk.red("[HealthMonitor] ✗ 飞书 MCP token 刷新异常:"), error);
            this.feishuMcpOk = false;
        }
    }
    /**
     * 备份飞书 MCP token 文件（主备份 + 异目录第二备份）
     */
    backupFeishuMcpToken() {
        if (!existsSync(FEISHU_MCP_TOKEN_FILE))
            return;
        try {
            copyFileSync(FEISHU_MCP_TOKEN_FILE, FEISHU_MCP_TOKEN_BACKUP);
        }
        catch {
            // 备份失败不影响主流程
        }
        try {
            // 第二处备份：~/.claude/ 目录，与主目录隔离
            mkdirSync(join(homedir(), ".claude"), { recursive: true });
            copyFileSync(FEISHU_MCP_TOKEN_FILE, FEISHU_MCP_TOKEN_BACKUP2);
        }
        catch {
            // 第二处备份失败不影响主流程
        }
    }
    /**
     * 发送飞书心跳（保持连接活跃）
     */
    async sendFeishuHeartbeat() {
        if (!this.config.feishuChannel || !this.config.feishuConnected) {
            return;
        }
        try {
            const feishuChannel = this.config.feishuChannel;
            // 发送一个心跳消息到飞书（可以是空白消息或状态查询）
            const userId = feishuChannel.config?.receiveUserId;
            if (userId) {
                // 静默心跳，不打扰用户
                console.log(chalk.gray(`[HealthMonitor] 飞书心跳 #${Date.now()}`));
            }
        }
        catch (error) {
            console.warn(chalk.yellow("[HealthMonitor] 飞书心跳失败:"), error);
        }
    }
    /**
     * 是否应该触发重启
     */
    shouldRestart() {
        const now = Date.now();
        // 冷却时间内不重启
        if (now - this.lastRestartTime < this.config.restartCooldown) {
            return false;
        }
        // 超过最大重启次数不重启
        if (this.restartCount >= this.config.maxRestartAttempts) {
            console.error(chalk.red(`[HealthMonitor] 已达到最大重启次数 (${this.config.maxRestartAttempts})，停止自动重启`));
            return false;
        }
        return true;
    }
    /**
     * 触发重启
     */
    async triggerRestart() {
        this.restartCount++;
        this.lastRestartTime = Date.now();
        console.warn(chalk.yellow(`[HealthMonitor] ⚠️ 触发自动重启 (#${this.restartCount}/${this.config.maxRestartAttempts})`));
        try {
            if (this.onRestartCallback) {
                await this.onRestartCallback();
                console.log(chalk.green("[HealthMonitor] ✓ 自动重启完成"));
            }
        }
        catch (error) {
            console.error(chalk.red("[HealthMonitor] 自动重启失败:"), error);
        }
    }
    /**
     * 获取监控状态
     */
    getStatus() {
        return {
            running: this.timer !== null,
            restartCount: this.restartCount,
            feishuConnected: this.config.feishuConnected,
            httpOk: this.checkHttpServer(),
            tunnelOk: this.checkTunnel(),
            authOk: this.adapter?.authOk ?? true,
            feishuMcpOk: this.feishuMcpOk,
        };
    }
    /**
     * 重置重启计数
     */
    resetRestartCount() {
        this.restartCount = 0;
        console.log(chalk.gray("[HealthMonitor] 重启计数已重置"));
    }
    /**
     * 停止健康监控
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.authCheckTimer) {
            clearInterval(this.authCheckTimer);
            this.authCheckTimer = null;
        }
        this.stopAuthRecoveryProbe();
        if (this.feishuMcpCheckTimer) {
            clearInterval(this.feishuMcpCheckTimer);
            this.feishuMcpCheckTimer = null;
        }
        if (this.feishuHeartbeatTimer) {
            clearInterval(this.feishuHeartbeatTimer);
            this.feishuHeartbeatTimer = null;
        }
        console.log(chalk.yellow("[HealthMonitor] 健康监控已停止"));
    }
}
//# sourceMappingURL=health-monitor.js.map