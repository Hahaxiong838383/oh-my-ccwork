/**
 * 飞书知识库服务
 *
 * 功能：
 * 1. 创建/获取知识库：根据知识库名称搜索或创建知识库
 * 2. 按周创建文档：一周一份文档（如 `2026年第8周报告`）
 * 3. 增量更新报告：在周文档中以时间戳标题（如 `02-24 IPO市场日报`）添加每日报告内容
 * 4. 权限管理：创建文档后自动给用户添加编辑权限
 */

import Lark from "@larksuiteoapi/node-sdk";

// 懒加载飞书客户端
let _client: Lark.Client | null = null;

function getClient(): Lark.Client {
  if (!_client) {
    _client = new Lark.Client({
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
      domain: Lark.Domain.Feishu,
    });
  }
  return _client;
}

// ============================================
// 类型定义
// ============================================

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

// ============================================
// 工具函数
// ============================================

/**
 * 解析周数
 * @param date 日期对象
 * @returns 周数（1-53）
 */
function getWeekNumber(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1);
  const diff = date.getTime() - start.getTime();
  const oneWeek = 1000 * 60 * 60 * 24 * 7;
  return Math.ceil((diff + start.getDay() * 86400000) / oneWeek);
}

/**
 * 格式化日期为 MM-DD 格式
 */
function formatDateStr(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day}`;
}

/**
 * 格式化日期为 YYYY-MM-DD 格式
 */
function formatFullDateStr(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 构建周文档标题
 */
function buildWeeklyDocTitle(year: number, week: number): string {
  return `${year}年第${week}周报告`;
}

/**
 * 构建每日报告标题
 */
function buildDailyReportTitle(date: Date, reportType: string = "日报"): string {
  return `${formatDateStr(date)} ${reportType}`;
}

// ============================================
// WikiService 类
// ============================================

/**
 * 飞书知识库服务
 *
 * 用于将每日报告存储到飞书知识库
 */
export class WikiService {
  private accessToken: string | null = null;
  private tokenExpireTime: number = 0;
  private useUserToken: boolean = false;

  constructor(options?: { useUserToken?: boolean }) {
    // 如果设置为 true，则使用用户 token（需要用户授权）
    // 用户 token 可以通过环境变量 FEISHU_USER_ACCESS_TOKEN 配置
    this.useUserToken = options?.useUserToken ?? process.env.FEISHU_USE_USER_TOKEN === "true";
  }

  /**
   * 获取飞书访问令牌
   */
  private async getAccessToken(): Promise<string | null> {
    // 如果使用用户 token，直接从环境变量获取
    if (this.useUserToken) {
      const userToken = process.env.FEISHU_USER_ACCESS_TOKEN;
      if (userToken) {
        return userToken;
      }
      console.error("[WikiService] 使用用户 token 但未配置 FEISHU_USER_ACCESS_TOKEN");
      return null;
    }

    // 检查缓存的令牌是否有效
    if (this.accessToken && Date.now() < this.tokenExpireTime) {
      return this.accessToken;
    }

    try {
      const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: process.env.FEISHU_APP_ID,
          app_secret: process.env.FEISHU_APP_SECRET,
        }),
      });

      const data = await response.json();
      if (data.code === 0) {
        // 提前 5 分钟刷新令牌
        this.tokenExpireTime = Date.now() + (data.expire - 300) * 1000;
        this.accessToken = data.tenant_access_token;
        return this.accessToken;
      }

      console.error("[WikiService] 获取 token 失败:", data);
      return null;
    } catch (error) {
      console.error("[WikiService] 获取 token 错误:", error);
      return null;
    }
  }

  /**
   * 搜索知识库节点
   *
   * @param spaceName 知识库名称
   */
  async searchKnowledgeBase(spaceName: string): Promise<WikiSpace | null> {
    const token = await this.getAccessToken();
    if (!token) {
      console.error("[WikiService] 无法获取访问令牌");
      return null;
    }

    try {
      // 使用 wiki_v2_spaces API 获取知识库列表
      const response = await fetch("https://open.feishu.cn/open-apis/wiki/v2/spaces?page_size=50", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (data.code === 0 && data.data?.items) {
        // 查找匹配的知识库
        const space = data.data.items.find(
          (item: any) => item.name === spaceName || item.name.includes(spaceName)
        );

        if (space) {
          console.log(`[WikiService] 找到知识库: ${space.name} (${space.space_id})`);
          return {
            spaceId: space.space_id,
            name: space.name,
            nodeId: space.node_id || "",
          };
        }
      }

      console.log(`[WikiService] 未找到知识库: ${spaceName}`);
      return null;
    } catch (error) {
      console.error("[WikiService] 搜索知识库失败:", error);
      return null;
    }
  }

  /**
   * 创建知识库
   *
   * @param spaceName 知识库名称
   */
  async createKnowledgeBase(spaceName: string): Promise<WikiSpace | null> {
    const token = await this.getAccessToken();
    if (!token) {
      console.error("[WikiService] 无法获取访问令牌");
      return null;
    }

    try {
      // 创建知识库（空间）
      const response = await fetch("https://open.feishu.cn/open-apis/wiki/v2/spaces", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: spaceName,
          space_type: "wiki", // 知识库类型
        }),
      });

      const data = await response.json();

      if (data.code === 0 && data.data) {
        console.log(`[WikiService] 创建知识库成功: ${spaceName}`);
        return {
          spaceId: data.data.space_id,
          name: spaceName,
          nodeId: data.data.node_id || "",
        };
      }

      console.error("[WikiService] 创建知识库失败:", data.msg);
      return null;
    } catch (error) {
      console.error("[WikiService] 创建知识库错误:", error);
      return null;
    }
  }

  /**
   * 创建或获取知识库
   *
   * @param spaceName 知识库名称
   */
  async createOrGetKnowledgeBase(spaceName: string): Promise<WikiSpace | null> {
    // 先尝试搜索
    const existing = await this.searchKnowledgeBase(spaceName);
    if (existing) {
      return existing;
    }

    // 搜索不到则创建
    return await this.createKnowledgeBase(spaceName);
  }

  /**
   * 获取知识库中的文档列表
   *
   * @param spaceId 知识库 ID
   */
  async listDocuments(spaceId: string): Promise<WikiDocument[]> {
    const token = await this.getAccessToken();
    if (!token) {
      return [];
    }

    try {
      const response = await fetch(
        `https://open.feishu.cn/open-apis/wiki/v1/spaces/${spaceId}/nodes?page_size=50`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${token}`,
          },
        }
      );

      const data = await response.json();

      if (data.code === 0 && data.data?.items) {
        return data.data.items.map((item: any) => ({
          nodeId: item.node_id,
          token: item.obj_token || "",
          title: item.title || "",
          url: `https://feishu.cn/wiki/${item.node_id}`,
        }));
      }

      return [];
    } catch (error) {
      console.error("[WikiService] 获取文档列表失败:", error);
      return [];
    }
  }

  /**
   * 在知识库中创建文档
   *
   * @param spaceId 知识库 ID
   * @param title 文档标题
   * @param content 文档内容（Markdown 格式）
   */
  async createDocument(
    spaceId: string,
    title: string,
    content: string = ""
  ): Promise<WikiDocument | null> {
    const token = await this.getAccessToken();
    if (!token) {
      console.error("[WikiService] 无法获取访问令牌");
      return null;
    }

    try {
      // 先创建空白文档
      const createResponse = await fetch("https://open.feishu.cn/open-apis/doc/v3/documents/create", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          folder_token: spaceId, // 知识库 ID 作为父文件夹
          title: title,
          document_type: "wiki",
        }),
      });

      const createData = await createResponse.json();

      if (createData.code === 0 && createData.data) {
        const docToken = createData.data.document?.obj_token;
        const nodeId = createData.data.node_id;

        // 如果有内容，更新文档
        if (content && docToken) {
          await this.updateDocumentContent(docToken, content);
        }

        console.log(`[WikiService] 创建文档成功: ${title}`);

        return {
          nodeId: nodeId || "",
          token: docToken || "",
          title: title,
          url: `https://feishu.cn/wiki/${nodeId}`,
        };
      }

      console.error("[WikiService] 创建文档失败:", createData.msg);
      return null;
    } catch (error) {
      console.error("[WikiService] 创建文档错误:", error);
      return null;
    }
  }

  /**
   * 给文档添加协作者权限
   *
   * @param docToken 文档 token
   * @param userOpenId 用户的 open_id（需要用户授权后获取）
   * @param permission 权限级别：view(可读)、edit(可编辑)、full_access(可管理)
   */
  async addCollaborator(
    docToken: string,
    userOpenId: string,
    permission: "view" | "edit" | "full_access" = "edit"
  ): Promise<boolean> {
    const token = await this.getAccessToken();
    if (!token) {
      console.error("[WikiService] 无法获取访问令牌");
      return false;
    }

    try {
      const response = await fetch(
        "https://open.feishu.cn/open-apis/drive/v1/permission_members",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            token: docToken,
            member_type: "openid",
            member_id: userOpenId,
            perm: permission,
          }),
        }
      );

      const data = await response.json();

      if (data.code === 0) {
        console.log(`[WikiService] 添加协作者成功: ${userOpenId}, 权限: ${permission}`);
        return true;
      }

      console.error("[WikiService] 添加协作者失败:", data.msg);
      return false;
    } catch (error) {
      console.error("[WikiService] 添加协作者错误:", error);
      return false;
    }
  }

  /**
   * 创建文档并自动添加当前用户为协作者
   *
   * @param spaceId 知识库 ID
   * @param title 文档标题
   * @param content 文档内容
   * @param userOpenId 用户的 open_id（可选，不提供则不添加权限）
   */
  async createDocumentWithPermission(
    spaceId: string,
    title: string,
    content: string = "",
    userOpenId?: string
  ): Promise<WikiDocument | null> {
    // 先创建文档
    const doc = await this.createDocument(spaceId, title, content);

    // 如果提供了用户 open_id，则添加协作者权限
    if (doc && userOpenId) {
      await this.addCollaborator(doc.token, userOpenId, "edit");
    }

    return doc;
  }

  /**
   * 更新文档内容
   *
   * @param docToken 文档 token
   * @param content 内容（Markdown）
   */
  async updateDocumentContent(docToken: string, content: string): Promise<boolean> {
    const token = await this.getAccessToken();
    if (!token) {
      return false;
    }

    try {
      // 将 Markdown 转换为飞书文档块
      const blocks = this.markdownToBlocks(content);

      const response = await fetch(
        `https://open.feishu.cn/open-apis/doc/v3/documents/${docToken}/blocks`,
        {
          method: "PATCH",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            blocks: blocks,
          }),
        }
      );

      const data = await response.json();

      if (data.code === 0) {
        console.log(`[WikiService] 文档内容更新成功: ${docToken}`);
        return true;
      }

      console.error("[WikiService] 更新文档失败:", data.msg);
      return false;
    } catch (error) {
      console.error("[WikiService] 更新文档错误:", error);
      return false;
    }
  }

  /**
   * 获取文档内容
   *
   * @param docToken 文档 token
   */
  async getDocumentContent(docToken: string): Promise<string | null> {
    const token = await this.getAccessToken();
    if (!token) {
      return null;
    }

    try {
      const response = await fetch(
        `https://open.feishu.cn/open-apis/doc/v3/documents/${docToken}`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${token}`,
          },
        }
      );

      const data = await response.json();

      if (data.code === 0 && data.data) {
        return JSON.stringify(data.data, null, 2);
      }

      return null;
    } catch (error) {
      console.error("[WikiService] 获取文档内容失败:", error);
      return null;
    }
  }

  /**
   * 按周获取或创建文档
   *
   * @param spaceId 知识库 ID
   * @param weekNumber 周数
   * @param year 年份
   */
  async getOrCreateWeeklyDoc(
    spaceId: string,
    weekNumber: number,
    year: number
  ): Promise<WikiDocument | null> {
    const title = buildWeeklyDocTitle(year, weekNumber);

    // 搜索现有文档
    const docs = await this.listDocuments(spaceId);
    const existing = docs.find((doc) => doc.title === title);

    if (existing) {
      console.log(`[WikiService] 找到周文档: ${title}`);
      return existing;
    }

    // 创建新文档
    console.log(`[WikiService] 创建周文档: ${title}`);
    return await this.createDocument(spaceId, title);
  }

  /**
   * 在文档中追加每日报告
   *
   * @param docToken 文档 token
   * @param date 日期
   * @param content 报告内容
   * @param reportType 报告类型（默认"日报"）
   */
  async appendDailyReport(
    docToken: string,
    date: Date,
    content: string,
    reportType: string = "日报"
  ): Promise<DailyReportResult> {
    const title = buildDailyReportTitle(date, reportType);
    const dateStr = formatFullDateStr(date);

    try {
      // 构建新内容：标题 + 内容
      const newContent = `\n## ${title}\n\n${content}\n`;

      // 获取现有内容
      const existingContent = await this.getDocumentContent(docToken);

      // 追加内容（这里简化处理：直接覆盖整个文档内容）
      // 实际生产中可以使用 block API 进行增量更新
      const fullContent = existingContent
        ? `${this.extractTextFromDoc(existingContent)}\n${newContent}`
        : newContent;

      const success = await this.updateDocumentContent(docToken, fullContent);

      if (success) {
        return {
          success: true,
          docToken: docToken,
          dateStr: dateStr,
        };
      }

      return {
        success: false,
        error: "更新文档失败",
      };
    } catch (error) {
      console.error("[WikiService] 追加报告失败:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 简单的 Markdown 转飞书文档块
   *
   * @param markdown Markdown 内容
   */
  private markdownToBlocks(markdown: string): any[] {
    const blocks: any[] = [];
    const lines = markdown.split("\n");

    for (const line of lines) {
      if (line.startsWith("## ")) {
        // 二级标题
        blocks.push({
          block_type: 1, // paragraph
          paragraph: {
            style: {
              heading: 2,
            },
            elements: [
              {
                text_run: {
                  content: line.substring(3),
                },
              },
            ],
          },
        });
      } else if (line.startsWith("# ")) {
        // 一级标题
        blocks.push({
          block_type: 1,
          paragraph: {
            style: {
              heading: 1,
            },
            elements: [
              {
                text_run: {
                  content: line.substring(2),
                },
              },
            ],
          },
        });
      } else if (line.trim() === "") {
        // 空行
        blocks.push({
          block_type: 1,
          paragraph: {
            elements: [],
          },
        });
      } else {
        // 普通段落
        blocks.push({
          block_type: 1,
          paragraph: {
            elements: [
              {
                text_run: {
                  content: line,
                },
              },
            ],
          },
        });
      }
    }

    return blocks;
  }

  /**
   * 从文档 JSON 中提取纯文本
   */
  private extractTextFromDoc(docJson: string): string {
    try {
      const doc = JSON.parse(docJson);
      const elements = doc.document?.elements || [];

      return elements
        .map((block: any) => {
          if (block.paragraph?.elements) {
            return block.paragraph.elements
              .map((el: any) => el.text_run?.content || "")
              .join("");
          }
          return "";
        })
        .join("\n");
    } catch {
      return "";
    }
  }
}

// ============================================
// 导出服务实例
// ============================================

export const wikiService = new WikiService();

// ============================================
// 便捷函数
// ============================================

/**
 * 将每日报告保存到知识库
 *
 * @param knowledgeBaseName 知识库名称
 * @param date 日期
 * @param content 报告内容
 * @param reportType 报告类型（默认"日报"）
 * @param userOpenId 用户的 open_id（可选，提供后自动添加编辑权限）
 * @param options 选项（useUserToken: 使用用户 token 而非应用 token）
 */
// 默认用户 open_id（从环境变量获取，支持配置）
const DEFAULT_USER_OPEN_ID = process.env.FEISHU_RECEIVE_USER_ID || "";

export async function saveDailyReportToWiki(
  knowledgeBaseName: string,
  date: Date,
  content: string,
  reportType: string = "日报",
  userOpenId: string = DEFAULT_USER_OPEN_ID,
  options?: { useUserToken?: boolean }
): Promise<DailyReportResult> {
  const wiki = new WikiService(options);

  // 1. 创建或获取知识库
  const space = await wiki.createOrGetKnowledgeBase(knowledgeBaseName);
  if (!space) {
    return { success: false, error: "无法创建或获取知识库" };
  }

  // 2. 获取或创建周文档
  const weekNumber = getWeekNumber(date);
  const year = date.getFullYear();
  const doc = await wiki.getOrCreateWeeklyDoc(space.spaceId, weekNumber, year);
  if (!doc) {
    return { success: false, error: "无法创建周文档" };
  }

  // 3. 如果提供了用户 open_id，添加协作者权限
  if (userOpenId) {
    await wiki.addCollaborator(doc.token, userOpenId, "edit");
  }

  // 4. 追加每日报告
  const result = await wiki.appendDailyReport(doc.token, date, content, reportType);

  return {
    success: result.success,
    docNodeId: doc.nodeId,
    docToken: doc.token,
    docUrl: doc.url,
    dateStr: result.dateStr,
    error: result.error,
  };
}
