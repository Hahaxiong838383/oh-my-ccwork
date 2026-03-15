/**
 * Tunnel Provider 接口抽象
 *
 * 支持的隧道方案：
 * - CloudflareProvider: Quick Tunnel（随机 URL，无需配置）
 * - NamedCloudflareProvider: Named Tunnel（固定域名，解决 CNAME Cross-User Banned）
 * - SSHProvider（待实现）
 */

import type { ChildProcess } from "child_process";
import { spawn, execSync } from "child_process";
import { detectCloudflaredPath, NULL_DEVICE } from "./platform.js";

const isWindows = process.platform === "win32";

// ============ 接口定义 ============

export interface TunnelResult {
  url: string;
  proc?: ChildProcess;
}

export interface TunnelProvider {
  /**
   * 启动隧道
   * @param localPort 本地服务端口
   * @returns 隧道 URL 和进程引用
   */
  start(localPort: number): Promise<TunnelResult>;

  /**
   * 停止隧道
   */
  stop(): void;

  /**
   * 健康检查
   * @returns true 表示隧道正常
   */
  healthCheck(): Promise<boolean>;

  /**
   * 获取 Provider 名称
   */
  getName(): string;
}

// ============ CloudflareProvider 实现 ============

export class CloudflareProvider implements TunnelProvider {
  private proc: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private startTimeout: number;
  private localPort: number = 0;

  /**
   * @param startTimeout 启动超时时间（毫秒），默认 60 秒
   * cloudflared 连接 Cloudflare Edge 可能需要较长时间，特别是网络不稳定时
   */
  constructor(startTimeout: number = 60000) {
    this.startTimeout = startTimeout;
  }

  async start(localPort: number): Promise<TunnelResult> {
    this.localPort = localPort;  // 保存端口号用于后续清理
    return new Promise((resolve, reject) => {
      // 获取 cloudflared 路径
      const cloudflaredPath = detectCloudflaredPath();
      const proc = spawn(cloudflaredPath, [
        'tunnel',
        '--config', NULL_DEVICE,
        '--url', `http://localhost:${localPort}`
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      this.proc = proc;
      let resolved = false;
      // quick tunnel URL 格式: word1-word2-word3-word4.trycloudflare.com
      // 必须包含至少一个连字符，排除 api.trycloudflare.com 等系统域名
      const urlPattern = /https:\/\/[a-z0-9]+-[a-z0-9-]+\.trycloudflare\.com/;

      const handleOutput = (data: Buffer) => {
        const output = data.toString();
        const match = output.match(urlPattern);
        if (match && !resolved) {
          resolved = true;
          this.tunnelUrl = match[0];
          resolve({ url: match[0], proc });
        }
      };

      proc.stdout?.on("data", handleOutput);
      proc.stderr?.on("data", handleOutput);

      proc.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          this.proc = null;
          reject(new Error(`Tunnel 启动失败: ${err.message}`));
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // 超时，杀掉进程
          try {
            proc.kill();
          } catch {}
          this.proc = null;
          reject(new Error("Tunnel 启动超时"));
        }
      }, this.startTimeout);
    });
  }

  stop(): void {
    if (this.proc) {
      try {
        // 直接强杀，不搞优雅那套
        this.proc.kill("SIGKILL");
      } catch {}
      this.proc = null;
    }

    // 杀掉所有 cloudflared 子进程（shell spawn 可能留下孤儿）
    // 注意：killPortProcess 杀的是 HTTP Server，不是 cloudflared！
    // cloudflared 不占用 localPort，它只是转发到 localhost:localPort
    try {
      if (isWindows) {
        // Windows: 按进程名杀
        execSync('taskkill /F /IM cloudflared.exe 2>nul', { stdio: 'ignore' });
      } else {
        // Unix: 按命令行模式匹配杀
        execSync("pkill -9 -f 'cloudflared tunnel' 2>/dev/null || true", { stdio: 'ignore' });
      }
    } catch {
      // 静默处理失败
    }

    this.tunnelUrl = null;
    this.localPort = 0;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.tunnelUrl) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${this.tunnelUrl}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  getName(): string {
    return "cloudflare";
  }

  /**
   * 获取当前隧道 URL
   */
  getUrl(): string | null {
    return this.tunnelUrl;
  }

  /**
   * 获取进程引用（用于外部监控）
   */
  getProc(): ChildProcess | null {
    return this.proc;
  }
}

// ============ NamedCloudflareProvider 实现 ============
// 解决 Error 1014: CNAME Cross-User Banned
// Quick Tunnel 生成 *.trycloudflare.com URL，CNAME 过去被 Cloudflare 拦截
// Named Tunnel 使用 {uuid}.cfargotunnel.com，不触发此限制

export class NamedCloudflareProvider implements TunnelProvider {
  private proc: ChildProcess | null = null;
  private tunnelToken: string;
  private tunnelId: string;
  private tunnelUrl: string | null = null;
  private hostname: string;
  private startTimeout: number;

  /**
   * @param tunnelToken Cloudflare Tunnel Token（从 Dashboard 获取）
   * @param hostname 绑定的域名（如 cli.hahaxiong.top）
   * @param startTimeout 启动超时时间（毫秒），默认 120 秒
   */
  constructor(tunnelToken: string, hostname: string, startTimeout: number = 120000) {
    this.tunnelToken = tunnelToken;
    this.hostname = hostname;
    this.startTimeout = startTimeout;
    this.tunnelId = this.extractTunnelId(tunnelToken);
  }

  /**
   * 从 tunnel token 中提取 tunnel UUID
   * Token 格式：base64({"a":"account_tag","t":"tunnel_id","s":"tunnel_secret"})
   */
  private extractTunnelId(token: string): string {
    try {
      const decoded = JSON.parse(Buffer.from(token, "base64").toString());
      if (!decoded.t) {
        throw new Error("Token 中缺少 tunnel ID (字段 t)");
      }
      return decoded.t;
    } catch (err) {
      throw new Error(`无效的 tunnel token: ${(err as Error).message}`);
    }
  }

  /**
   * 获取 tunnel UUID（用于创建 CNAME 指向 {uuid}.cfargotunnel.com）
   */
  getTunnelId(): string {
    return this.tunnelId;
  }

  async start(localPort: number): Promise<TunnelResult> {
    return new Promise((resolve, reject) => {
      const cloudflaredPath = detectCloudflaredPath();
      const proc = spawn(cloudflaredPath, [
        "tunnel", "run", "--token", this.tunnelToken,
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      this.proc = proc;
      let resolved = false;

      // Named Tunnel 就绪标志：cloudflared 会在 stderr 输出连接注册信息
      const readyPattern = /Registered tunnel connection|Connection [a-z0-9-]+ registered/i;

      const handleOutput = (data: Buffer) => {
        const output = data.toString();
        if (readyPattern.test(output) && !resolved) {
          resolved = true;
          this.tunnelUrl = `https://${this.hostname}`;
          resolve({ url: this.tunnelUrl, proc });
        }
      };

      proc.stdout?.on("data", handleOutput);
      proc.stderr?.on("data", handleOutput);

      proc.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          this.proc = null;
          reject(new Error(`Named Tunnel 启动失败: ${err.message}`));
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { proc.kill(); } catch {}
          this.proc = null;
          reject(new Error("Named Tunnel 启动超时"));
        }
      }, this.startTimeout);
    });
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {}
      this.proc = null;
    }

    try {
      if (isWindows) {
        execSync('taskkill /F /IM cloudflared.exe 2>nul', { stdio: "ignore" });
      } else {
        execSync("pkill -9 -f 'cloudflared tunnel' 2>/dev/null || true", { stdio: "ignore" });
      }
    } catch {}

    this.tunnelUrl = null;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.tunnelUrl) return false;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${this.tunnelUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  getName(): string {
    return "cloudflare-named";
  }

  getUrl(): string | null {
    return this.tunnelUrl;
  }

  getProc(): ChildProcess | null {
    return this.proc;
  }
}
