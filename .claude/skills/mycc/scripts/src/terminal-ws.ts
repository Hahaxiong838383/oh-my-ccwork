/**
 * Terminal WebSocket Handler
 *
 * 处理 /ws 路径的 WebSocket 连接，提供远程终端功能
 * 复用 mycc 已有的认证体系（authToken）
 */

import { WebSocketServer, WebSocket } from "ws";
import type http from "http";
import { PTYManager, detectClis, type CliInfo } from "./pty-manager.js";

interface AuthenticatedWs extends WebSocket {
  authenticated?: boolean;
  isAlive?: boolean;
}

interface WsMessage {
  type: string;
  [key: string]: any;
}

export class TerminalWsHandler {
  private wss: WebSocketServer;
  private ptyManager: PTYManager;
  private availableClis: CliInfo[];
  private validateToken: (token: string) => boolean;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    server: http.Server,
    validateToken: (token: string) => boolean,
    maxSessions: number = 10
  ) {
    this.validateToken = validateToken;
    this.ptyManager = new PTYManager(maxSessions);
    this.availableClis = detectClis();

    // Log detected CLIs
    console.log("[Terminal] CLI 检测结果:");
    for (const cli of this.availableClis) {
      const icon = cli.available ? "✓" : "✗";
      const ver = cli.available ? `(${cli.version})` : "(未安装)";
      console.log(`  ${icon} ${cli.name} ${ver}`);
    }

    // Create WebSocket server on /ws path
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws: AuthenticatedWs, _req: http.IncomingMessage) => {
      ws.isAlive = true;
      ws.authenticated = false;

      ws.on("pong", () => {
        ws.isAlive = true;
      });

      ws.on("message", (raw) => {
        let msg: WsMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          this.sendJson(ws, { type: "error", error: "Invalid JSON" });
          return;
        }

        this.handleMessage(ws, msg);
      });
    });

    // Heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.wss.clients.forEach((ws: AuthenticatedWs) => {
        if (!ws.isAlive) {
          ws.terminate();
          return;
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    this.wss.on("close", () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
      }
    });
  }

  private sendJson(ws: WebSocket, data: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private handleMessage(ws: AuthenticatedWs, msg: WsMessage): void {
    switch (msg.type) {
      case "auth": {
        // 使用 mycc 的 authToken 或密码认证
        if (this.validateToken(msg.token || msg.password || "")) {
          ws.authenticated = true;
          this.sendJson(ws, {
            type: "auth_ok",
            clis: this.availableClis,
            sessions: this.ptyManager.list(),
          });
        } else {
          this.sendJson(ws, { type: "auth_fail" });
        }
        break;
      }

      case "create": {
        if (!ws.authenticated) {
          this.sendJson(ws, { type: "error", error: "Not authenticated" });
          return;
        }

        const cli = this.availableClis.find((c) => c.name === msg.cli);
        if (!cli) {
          this.sendJson(ws, { type: "error", error: `CLI "${msg.cli}" not available` });
          return;
        }

        const cols = msg.cols || 80;
        const rows = msg.rows || 24;
        const cwd = msg.cwd || undefined;

        this.ptyManager
          .create(cli.name, cli.command, cols, rows, cwd)
          .then((session) => {
            this.sendJson(ws, {
              type: "created",
              sessionId: session.id,
              cli: session.cli,
            });

            // Forward PTY output to WebSocket
            session.pty.onData((data: string) => {
              this.sendJson(ws, {
                type: "output",
                sessionId: session.id,
                data,
              });
            });

            // Handle PTY exit
            session.pty.onExit((e: { exitCode: number }) => {
              this.sendJson(ws, {
                type: "exit",
                sessionId: session.id,
                exitCode: e.exitCode,
              });
              this.ptyManager.kill(session.id);
            });
          })
          .catch((err: Error) => {
            this.sendJson(ws, { type: "error", error: err.message });
          });
        break;
      }

      case "input": {
        if (!ws.authenticated) return;
        try {
          this.ptyManager.write(msg.sessionId, msg.data);
        } catch (e) {
          this.sendJson(ws, { type: "error", error: (e as Error).message });
        }
        break;
      }

      case "resize": {
        if (!ws.authenticated) return;
        try {
          this.ptyManager.resize(msg.sessionId, msg.cols, msg.rows);
        } catch (e) {
          this.sendJson(ws, { type: "error", error: (e as Error).message });
        }
        break;
      }

      case "close": {
        if (!ws.authenticated) return;
        this.ptyManager.kill(msg.sessionId);
        this.sendJson(ws, { type: "closed", sessionId: msg.sessionId });
        break;
      }

      case "list": {
        if (!ws.authenticated) return;
        this.sendJson(ws, {
          type: "sessions",
          sessions: this.ptyManager.list(),
        });
        break;
      }

      default:
        this.sendJson(ws, { type: "error", error: `Unknown type: ${msg.type}` });
    }
  }

  getAvailableClis(): CliInfo[] {
    return this.availableClis;
  }

  stop(): void {
    this.ptyManager.killAll();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.wss.close();
  }
}
