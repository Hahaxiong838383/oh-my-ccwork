/**
 * 飞书 API 服务
 * 提供多维表格、文档等飞书开放能力
 */
import Lark from "@larksuiteoapi/node-sdk";
declare const client: Lark.Client;
/**
 * 创建多维表格
 * @param name 表格名称
 * @param folderId 文件夹 ID（可选，默认创建在根目录）
 */
export declare function createBitable(name: string, folderId?: string): Promise<{
    success: boolean;
    data?: any;
    error?: string;
}>;
/**
 * 获取多维表格信息
 * @param token 表格 token
 */
export declare function getBitable(token: string): Promise<{
    success: boolean;
    data?: any;
    error?: string;
}>;
/**
 * 在多维表格中创建工作表
 * @param token 表格 token
 * @param name 工作表名称
 */
export declare function createBitableSheet(token: string, name: string): Promise<{
    success: boolean;
    data?: any;
    error?: string;
}>;
/**
 * 添加字段到工作表
 * @param token 表格 token
 * @param tableId 工作表 ID
 * @param fieldName 字段名称
 * @param fieldType 字段类型
 */
export declare function addBitableField(token: string, tableId: string, fieldName: string, fieldType: "text" | "number" | "date" | "select" | "multiSelect" | "user" | "checkbox"): Promise<{
    success: boolean;
    data?: any;
    error?: string;
}>;
/**
 * 创建员工花名册多维表格
 */
export declare function createEmployeeRoster(name: string): Promise<{
    success: boolean;
    data?: any;
    error?: string;
}>;
export { client };
//# sourceMappingURL=feishu-api.d.ts.map