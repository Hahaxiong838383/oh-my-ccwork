/**
 * 飞书知识库服务
 *
 * 功能：
 * 1. 创建/获取知识库：根据知识库名称搜索或创建知识库
 * 2. 按周创建文档：一周一份文档（如 `2026年第8周报告`）
 * 3. 增量更新报告：在周文档中以时间戳标题（如 `02-24 IPO市场日报`）添加每日报告内容
 * 4. 权限管理：创建文档后自动给用户添加编辑权限
 */
export interface WikiSpace {
    spaceId: string;
    name: string;
    nodeId: string;
}
export interface WikiDocument {
    nodeId: string;
    token: string;
    title: string;
    url: string;
}
export interface DailyReportResult {
    success: boolean;
    docNodeId?: string;
    docToken?: string;
    docUrl?: string;
    dateStr?: string;
    error?: string;
}
/**
 * 飞书知识库服务
 *
 * 用于将每日报告存储到飞书知识库
 */
export declare class WikiService {
    private accessToken;
    private tokenExpireTime;
    private useUserToken;
    constructor(options?: {
        useUserToken?: boolean;
    });
    /**
     * 获取飞书访问令牌
     */
    private getAccessToken;
    /**
     * 搜索知识库节点
     *
     * @param spaceName 知识库名称
     */
    searchKnowledgeBase(spaceName: string): Promise<WikiSpace | null>;
    /**
     * 创建知识库
     *
     * @param spaceName 知识库名称
     */
    createKnowledgeBase(spaceName: string): Promise<WikiSpace | null>;
    /**
     * 创建或获取知识库
     *
     * @param spaceName 知识库名称
     */
    createOrGetKnowledgeBase(spaceName: string): Promise<WikiSpace | null>;
    /**
     * 获取知识库中的文档列表
     *
     * @param spaceId 知识库 ID
     */
    listDocuments(spaceId: string): Promise<WikiDocument[]>;
    /**
     * 在知识库中创建文档
     *
     * @param spaceId 知识库 ID
     * @param title 文档标题
     * @param content 文档内容（Markdown 格式）
     */
    createDocument(spaceId: string, title: string, content?: string): Promise<WikiDocument | null>;
    /**
     * 给文档添加协作者权限
     *
     * @param docToken 文档 token
     * @param userOpenId 用户的 open_id（需要用户授权后获取）
     * @param permission 权限级别：view(可读)、edit(可编辑)、full_access(可管理)
     */
    addCollaborator(docToken: string, userOpenId: string, permission?: "view" | "edit" | "full_access"): Promise<boolean>;
    /**
     * 创建文档并自动添加当前用户为协作者
     *
     * @param spaceId 知识库 ID
     * @param title 文档标题
     * @param content 文档内容
     * @param userOpenId 用户的 open_id（可选，不提供则不添加权限）
     */
    createDocumentWithPermission(spaceId: string, title: string, content?: string, userOpenId?: string): Promise<WikiDocument | null>;
    /**
     * 更新文档内容
     *
     * @param docToken 文档 token
     * @param content 内容（Markdown）
     */
    updateDocumentContent(docToken: string, content: string): Promise<boolean>;
    /**
     * 获取文档内容
     *
     * @param docToken 文档 token
     */
    getDocumentContent(docToken: string): Promise<string | null>;
    /**
     * 按周获取或创建文档
     *
     * @param spaceId 知识库 ID
     * @param weekNumber 周数
     * @param year 年份
     */
    getOrCreateWeeklyDoc(spaceId: string, weekNumber: number, year: number): Promise<WikiDocument | null>;
    /**
     * 在文档中追加每日报告
     *
     * @param docToken 文档 token
     * @param date 日期
     * @param content 报告内容
     * @param reportType 报告类型（默认"日报"）
     */
    appendDailyReport(docToken: string, date: Date, content: string, reportType?: string): Promise<DailyReportResult>;
    /**
     * 简单的 Markdown 转飞书文档块
     *
     * @param markdown Markdown 内容
     */
    private markdownToBlocks;
    /**
     * 从文档 JSON 中提取纯文本
     */
    private extractTextFromDoc;
}
export declare const wikiService: WikiService;
export declare function saveDailyReportToWiki(knowledgeBaseName: string, date: Date, content: string, reportType?: string, userOpenId?: string, options?: {
    useUserToken?: boolean;
}): Promise<DailyReportResult>;
//# sourceMappingURL=wiki-service.d.ts.map