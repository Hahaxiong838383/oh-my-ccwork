/**
 * Embedding 服务 — 调用本地 Ollama 生成向量
 *
 * 模型：Qwen3-Embedding-0.6B（512 维 MRL）
 * 端口：Ollama 默认 11434
 * 设计：fire-and-forget，Ollama 不可用时静默返回 null
 */
export interface VectorItem {
    id: string;
    category: string;
    text: string;
    stars: number;
    vector: number[];
}
export interface VectorIndex {
    model: string;
    dimensions: number;
    updated_at: string;
    items: VectorItem[];
}
/** 调用 Ollama /api/embed 获取 embedding 向量 */
export declare function embed(text: string): Promise<number[] | null>;
/** 批量 embed（逐条调用，避免 Ollama 内存压力） */
export declare function embedBatch(texts: string[], onProgress?: (done: number, total: number) => void): Promise<Array<number[] | null>>;
/** 获取向量索引文件路径 */
export declare function getIndexPath(cwd: string): string;
/** 读取向量索引（不存在或解析失败返回空索引） */
export declare function loadVectorIndex(cwd: string): VectorIndex;
/** 保存向量索引 */
export declare function saveVectorIndex(cwd: string, index: VectorIndex): void;
/** 余弦相似度（两个等长 float32 数组） */
export declare function cosineSim(a: number[], b: number[]): number;
/** 在索引中搜索最相似的 items，返回带分数的结果 */
export declare function vectorSearch(queryVec: number[], index: VectorIndex, topK?: number): Array<{
    item: VectorItem;
    similarity: number;
}>;
/** 检查 Ollama 是否可用且模型已加载 */
export declare function isOllamaReady(): Promise<boolean>;
//# sourceMappingURL=embedding.d.ts.map