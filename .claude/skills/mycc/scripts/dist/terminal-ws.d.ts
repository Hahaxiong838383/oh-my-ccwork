/**
 * Terminal WebSocket Handler
 *
 * 处理 /ws 路径的 WebSocket 连接，提供远程终端功能
 * 复用 mycc 已有的认证体系（authToken）
 */
import type http from "http";
import { type CliInfo } from "./pty-manager.js";
export declare class TerminalWsHandler {
    private wss;
    private ptyManager;
    private availableClis;
    private validateToken;
    private heartbeatTimer;
    constructor(server: http.Server, validateToken: (token: string) => boolean, maxSessions?: number);
    private sendJson;
    private handleMessage;
    getAvailableClis(): CliInfo[];
    stop(): void;
}
//# sourceMappingURL=terminal-ws.d.ts.map