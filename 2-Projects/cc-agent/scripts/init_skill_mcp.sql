-- ============================================================
-- skill_mcp 初始化 SQL
-- 轨迹收集 + 技能管理数据表
-- ============================================================

-- 轨迹主表
CREATE TABLE IF NOT EXISTS trajectories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    task_title TEXT,
    task_description TEXT NOT NULL,
    trigger_source TEXT NOT NULL DEFAULT 'cc',
    status TEXT NOT NULL DEFAULT 'open',       -- open/completed/aborted
    outcome TEXT,                              -- success/failure/partial
    complexity_score INT DEFAULT 0,
    tool_count INT DEFAULT 0,
    summary TEXT,
    models_used JSONB NOT NULL DEFAULT '[]'::jsonb,
    tags TEXT[] NOT NULL DEFAULT '{}'::text[],
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 轨迹步骤（拆出独立表，不用大 JSON）
CREATE TABLE IF NOT EXISTS trajectory_steps (
    id BIGSERIAL PRIMARY KEY,
    trajectory_id UUID NOT NULL REFERENCES trajectories(id) ON DELETE CASCADE,
    step_no INT NOT NULL,
    phase TEXT NOT NULL,         -- plan/tool_call/reasoning/retry/fix/output
    step_type TEXT NOT NULL,     -- think/act/observe/edit/search/test
    title TEXT,
    content TEXT,
    tool_name TEXT,
    tool_args JSONB,
    tool_result TEXT,
    model_name TEXT,
    agent_name TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (trajectory_id, step_no)
);

-- 轨迹决策（单独记录，避免埋进大 JSON）
CREATE TABLE IF NOT EXISTS trajectory_decisions (
    id BIGSERIAL PRIMARY KEY,
    trajectory_id UUID NOT NULL REFERENCES trajectories(id) ON DELETE CASCADE,
    step_id BIGINT REFERENCES trajectory_steps(id) ON DELETE SET NULL,
    decision_type TEXT NOT NULL,  -- route/tool/design/security
    question TEXT NOT NULL,
    chosen_option TEXT NOT NULL,
    rationale TEXT NOT NULL,
    confidence NUMERIC(4,3),
    model_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 轨迹摩擦点
CREATE TABLE IF NOT EXISTS trajectory_frictions (
    id BIGSERIAL PRIMARY KEY,
    trajectory_id UUID NOT NULL REFERENCES trajectories(id) ON DELETE CASCADE,
    step_id BIGINT REFERENCES trajectory_steps(id) ON DELETE SET NULL,
    friction_type TEXT NOT NULL,  -- tool_error/spec_gap/auth/missing_context/model_error
    severity TEXT NOT NULL DEFAULT 'medium',
    description TEXT NOT NULL,
    resolution TEXT,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 技能注册表
CREATE TABLE IF NOT EXISTS skill_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL,    -- verified_fs/draft_wiki
    status TEXT NOT NULL,         -- active/draft/blocked/archived
    fs_path TEXT,                 -- .claude/skills/ 下的路径（verified 才有）
    wiki_path TEXT,               -- /wiki/skill-drafts/ 路径（draft 才有）
    summary TEXT,
    tags TEXT[] NOT NULL DEFAULT '{}'::text[],
    content TEXT NOT NULL,
    origin_trajectory_id UUID REFERENCES trajectories(id) ON DELETE SET NULL,
    scan_status TEXT NOT NULL DEFAULT 'pending',  -- pending/pass/warn/block
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 安全扫描结果
CREATE TABLE IF NOT EXISTS skill_scan_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id UUID NOT NULL REFERENCES skill_registry(id) ON DELETE CASCADE,
    scanner_version TEXT NOT NULL DEFAULT '1.0',
    status TEXT NOT NULL,         -- pass/warn/block
    risk_level TEXT NOT NULL,     -- low/medium/high/critical
    dangerous_commands JSONB NOT NULL DEFAULT '[]'::jsonb,
    secrets JSONB NOT NULL DEFAULT '[]'::jsonb,
    prompt_injection JSONB NOT NULL DEFAULT '[]'::jsonb,
    findings JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 通知出站队列（微信 worker 消费）
CREATE TABLE IF NOT EXISTS agent_outbox (
    id BIGSERIAL PRIMARY KEY,
    channel TEXT NOT NULL DEFAULT 'wechat',
    event_type TEXT NOT NULL,     -- skill_draft_created/scan_blocked/trajectory_completed
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    retry_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ
);

-- ============================================================
-- 索引
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_traj_session ON trajectories(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_steps_traj ON trajectory_steps(trajectory_id, step_no);
CREATE INDEX IF NOT EXISTS idx_decisions_traj ON trajectory_decisions(trajectory_id);
CREATE INDEX IF NOT EXISTS idx_frictions_traj ON trajectory_frictions(trajectory_id);
CREATE INDEX IF NOT EXISTS idx_skill_status ON skill_registry(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_content_pgroonga ON skill_registry USING pgroonga (content);
CREATE INDEX IF NOT EXISTS idx_skill_title_pgroonga ON skill_registry USING pgroonga (title);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON agent_outbox(status, created_at);
