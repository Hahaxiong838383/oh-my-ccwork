/**
 * Web 通道
 *
 * 包装现有的 SSE 逻辑，将消息发送到 Web 客户端
 */
/**
 * Web 消息通道
 *
 * 包装 SSE 响应，将消息发送到 Web 客户端
 */
export class WebChannel {
    id = "web";
    res;
    sessionId;
    constructor(config) {
        this.res = config.res;
    }
    /**
     * 设置当前会话 ID
     * @param sessionId - 会话 ID
     */
    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }
    /**
     * 获取当前会话 ID
     */
    getSessionId() {
        return this.sessionId;
    }
    /**
     * 不需要过滤器 - Web 通道接收所有消息
     */
    // filter 方法未定义，表示接受所有消息
    /**
     * 发送消息到 Web 客户端（SSE）
     * @param event - SSE 事件
     */
    async send(event) {
        // 提取 session_id（如果有）
        if (event && typeof event === "object" && "type" in event) {
            if (event.type === "system" && "session_id" in event) {
                this.sessionId = event.session_id;
            }
        }
        // 发送 SSE 数据
        const data = JSON.stringify(event);
        this.res.write(`data: ${data}\n\n`);
    }
    /**
     * 发送完成信号
     */
    async sendDone() {
        const doneEvent = { type: "done", sessionId: this.sessionId };
        await this.send(doneEvent);
        this.res.end();
    }
    /**
     * 发送错误信号
     * @param error - 错误信息
     */
    async sendError(error) {
        const errorEvent = { type: "error", error };
        await this.send(errorEvent);
        this.res.end();
    }
}
//# sourceMappingURL=web.js.map