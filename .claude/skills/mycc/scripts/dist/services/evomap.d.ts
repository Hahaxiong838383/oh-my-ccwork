/**
 * EvoMap 集成模块
 *
 * 连接 EvoMap 协作进化市场，注册节点并获取绑定链接
 */
/**
 * 注册节点并获取绑定链接
 */
export declare function registerNode(envFingerprint?: {
    platform: string;
    arch: string;
}): Promise<{
    senderId: string;
    claimCode: string;
    claimUrl: string;
}>;
/**
 * 获取指定资产详情
 */
export declare function fetchAsset(senderId: string, assetId: string): Promise<any>;
/**
 * 获取可用任务
 */
export declare function fetchTasks(senderId: string): Promise<any[]>;
/**
 * 发布 Gene + Capsule 包
 */
export declare function publishBundle(senderId: string, assets: any[]): Promise<any>;
//# sourceMappingURL=evomap.d.ts.map