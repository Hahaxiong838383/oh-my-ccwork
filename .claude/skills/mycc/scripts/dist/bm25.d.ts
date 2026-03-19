/**
 * BM25 关键词索引模块
 *
 * 实现经典的 BM25 检索算法，用于历史对话的关键词搜索
 * 参考 SimpleMem 的词法层索引设计
 *
 * BM25 公式:
 * Score(Q, D) = Σ IDF(qi) * (f(qi, D) * (k1 + 1)) / (f(qi, D) + k1 * (1 - b + b * |D| / avgdl))
 */
export interface BM25Index {
    /** 文档 ID -> 文档内容 */
    documents: Map<string, string>;
    /** 词项 -> 文档ID集合及词频 */
    invertedIndex: Map<string, Map<string, number>>;
    /** 文档长度 */
    docLengths: Map<string, number>;
    /** 平均文档长度 */
    avgdl: number;
    /** 文档总数 */
    N: number;
    /** IDF 缓存 */
    idfCache: Map<string, number>;
}
export interface SearchResult {
    sessionId: string;
    score: number;
    preview: string;
}
/**
 * 构建 BM25 索引
 * 扫描指定目录下的所有 .jsonl 文件建立索引
 */
export declare function buildBM25Index(projectDir: string): BM25Index;
/**
 * 搜索历史对话
 * @param query 查询关键词
 * @param index BM25 索引
 * @param limit 返回结果数量
 */
export declare function searchBM25(query: string, index: BM25Index, limit?: number): SearchResult[];
/**
 * 获取或重建索引（带缓存）
 */
export declare function getOrBuildIndex(projectDir: string, forceRebuild?: boolean): BM25Index;
/**
 * 清除索引缓存
 */
export declare function clearIndexCache(): void;
//# sourceMappingURL=bm25.d.ts.map