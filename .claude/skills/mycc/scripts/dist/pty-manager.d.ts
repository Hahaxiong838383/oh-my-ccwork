/**
 * PTY Manager - 管理多个 CLI 终端会话
 *
 * 支持 claude / codex / gemini 等 CLI 的远程终端访问
 * 通过 node-pty 创建伪终端，WebSocket 转发输入输出
 */
interface IPty {
    onData: (callback: (data: string) => void) => {
        dispose: () => void;
    };
    onExit: (callback: (e: {
        exitCode: number;
        signal?: number;
    }) => void) => {
        dispose: () => void;
    };
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    kill: (signal?: string) => void;
    pid: number;
}
export interface CliInfo {
    name: string;
    command: string;
    detectCmd: string;
    version: string | null;
    available: boolean;
}
export interface TerminalSession {
    id: string;
    cli: string;
    pty: IPty;
    createdAt: Date;
    cols: number;
    rows: number;
}
export declare function detectClis(): CliInfo[];
export declare class PTYManager {
    private sessions;
    private maxSessions;
    constructor(maxSessions?: number);
    create(cli: string, command: string, cols?: number, rows?: number, cwd?: string): Promise<TerminalSession>;
    get(id: string): TerminalSession | undefined;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;
    list(): Array<{
        id: string;
        cli: string;
        createdAt: Date;
    }>;
    killAll(): void;
    get count(): number;
}
export {};
//# sourceMappingURL=pty-manager.d.ts.map