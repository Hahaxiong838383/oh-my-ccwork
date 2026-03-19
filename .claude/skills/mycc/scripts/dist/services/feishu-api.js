/**
 * 飞书 API 服务
 * 提供多维表格、文档等飞书开放能力
 */
import Lark from "@larksuiteoapi/node-sdk";
// 懒加载飞书客户端，避免在 loadEnvFile 前初始化导致凭证为空
let _client = null;
function getClient() {
    if (!_client) {
        _client = new Lark.Client({
            appId: process.env.FEISHU_APP_ID || "",
            appSecret: process.env.FEISHU_APP_SECRET || "",
            domain: Lark.Domain.Feishu,
        });
    }
    return _client;
}
// 兼容旧代码的 client 引用（懒加载）
const client = new Proxy({}, {
    get(_target, prop) {
        return getClient()[prop];
    },
});
/**
 * 创建多维表格
 * @param name 表格名称
 * @param folderId 文件夹 ID（可选，默认创建在根目录）
 */
export async function createBitable(name, folderId) {
    try {
        // 使用 bitable API 创建多维表格
        const response = await getClient().bitable.app.create({
            requestBody: {
                name: name,
                parent_node: folderId || "",
            },
        });
        if (response.code === 0) {
            return { success: true, data: response.data };
        }
        else {
            return { success: false, error: response.msg };
        }
    }
    catch (error) {
        console.error("[FeishuAPI] 创建多维表格失败:", error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * 获取多维表格信息
 * @param token 表格 token
 */
export async function getBitable(token) {
    try {
        const response = await getClient().bitable.app.get({
            path: {
                app_token: token,
            },
        });
        if (response.code === 0) {
            return { success: true, data: response.data };
        }
        else {
            return { success: false, error: response.msg };
        }
    }
    catch (error) {
        console.error("[FeishuAPI] 获取多维表格失败:", error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * 在多维表格中创建工作表
 * @param token 表格 token
 * @param name 工作表名称
 */
export async function createBitableSheet(token, name) {
    try {
        const response = await getClient().bitable.table.create({
            path: {
                app_token: token,
            },
            requestBody: {
                table_name: name,
            },
        });
        if (response.code === 0) {
            return { success: true, data: response.data };
        }
        else {
            return { success: false, error: response.msg };
        }
    }
    catch (error) {
        console.error("[FeishuAPI] 创建工作表失败:", error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * 添加字段到工作表
 * @param token 表格 token
 * @param tableId 工作表 ID
 * @param fieldName 字段名称
 * @param fieldType 字段类型
 */
export async function addBitableField(token, tableId, fieldName, fieldType) {
    try {
        // 字段类型映射
        const typeMap = {
            text: 1,
            number: 2,
            date: 3,
            select: 4,
            multiSelect: 5,
            user: 7,
            checkbox: 9,
        };
        const response = await getClient().bitable.field.create({
            path: {
                app_token: token,
                table_id: tableId,
            },
            requestBody: {
                field_name: fieldName,
                type: typeMap[fieldType] || 1,
            },
        });
        if (response.code === 0) {
            return { success: true, data: response.data };
        }
        else {
            return { success: false, error: response.msg };
        }
    }
    catch (error) {
        console.error("[FeishuAPI] 添加字段失败:", error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * 创建员工花名册多维表格
 */
export async function createEmployeeRoster(name) {
    try {
        // 1. 创建多维表格
        const createResult = await createBitable(name);
        if (!createResult.success) {
            return createResult;
        }
        const bitableToken = createResult.data?.app_token;
        if (!bitableToken) {
            return { success: false, error: "无法获取多维表格 token" };
        }
        // 2. 获取表格信息获取工作表列表
        const metadataResult = await getBitable(bitableToken);
        const tables = metadataResult.data?.tables || [];
        let tableId;
        if (tables.length > 0) {
            tableId = tables[0].table_id;
        }
        if (!tableId) {
            // 如果没有默认工作表，创建一个
            const sheetResult = await createBitableSheet(bitableToken, "员工花名册");
            if (!sheetResult.success) {
                return { success: true, data: { token: bitableToken, name: name } }; // 表格已创建，返回基本信息
            }
            tableId = sheetResult.data?.table_id;
        }
        // 3. 添加花名册字段
        const fields = [
            { name: "姓名", type: "text" },
            { name: "工号", type: "text" },
            { name: "部门", type: "text" },
            { name: "职位", type: "text" },
            { name: "手机", type: "text" },
            { name: "邮箱", type: "text" },
            { name: "入职日期", type: "date" },
            { name: "状态", type: "select" },
        ];
        for (const field of fields) {
            if (tableId) {
                await addBitableField(bitableToken, tableId, field.name, field.type);
            }
        }
        return {
            success: true,
            data: {
                token: bitableToken,
                name: name,
                url: `https://feishu.cn/bitable/${bitableToken}`,
            },
        };
    }
    catch (error) {
        console.error("[FeishuAPI] 创建员工花名册失败:", error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
export { client };
//# sourceMappingURL=feishu-api.js.map