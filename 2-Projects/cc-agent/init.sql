CREATE EXTENSION IF NOT EXISTS pgroonga;

-- 文档表（wiki 页 + 导入素材共表）
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    path TEXT NOT NULL UNIQUE,
    title TEXT,
    content TEXT,
    tags TEXT[] DEFAULT '{}',
    source_type TEXT DEFAULT 'manual',
    trust_level TEXT DEFAULT 'verified',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 文本分块（全文搜索用）
CREATE TABLE document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    header_breadcrumb TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- PGroonga 全文索引
CREATE INDEX idx_chunks_content ON document_chunks USING pgroonga (content);
CREATE INDEX idx_docs_content ON documents USING pgroonga (content);
CREATE INDEX idx_docs_title ON documents USING pgroonga (title);
CREATE INDEX idx_docs_path ON documents (path);
CREATE INDEX idx_docs_trust ON documents (trust_level);

-- 模型用量统计
CREATE TABLE model_usage (
    id BIGSERIAL PRIMARY KEY,
    model_name TEXT NOT NULL,
    task_type TEXT,
    agent_name TEXT,
    input_tokens INT,
    output_tokens INT,
    latency_ms INT,
    cost_usd NUMERIC(10,6),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_usage_model ON model_usage (model_name, created_at);
CREATE INDEX idx_usage_agent ON model_usage (agent_name, created_at);
