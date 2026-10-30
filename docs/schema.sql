-- 个人信息管家 · 建表脚本
--
-- 执行方式：通过云服务 MCP 工具 workbuddy_cloudservice_db_exec_sql，
-- 每条语句一次调用，DDL 用 mode = "migrate"。
-- 应用代码不执行 DDL。
--
-- 约定：所有表都是「仅本人可见可写」的私有数据，
--      owner_id 为 TEXT（auth.uid() 返回 text，不是 uuid），由 DEFAULT 在服务端填充，
--      客户端 INSERT 时不要传 owner_id。

-- 资料
CREATE TABLE notes (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    TEXT        NOT NULL DEFAULT auth.uid(),
  owner_name  TEXT,
  title       TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  category    TEXT        DEFAULT '未分类',
  summary     TEXT,
  keywords    TEXT[]      DEFAULT '{}',
  key_points  TEXT[]      DEFAULT '{}',
  pinned      BOOLEAN     DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE notes IS '用户随手记录的资料，含 AI 自动生成的分类/摘要/关键词/重点';

-- 待办（可由资料派生，note_id 指向来源）
CREATE TABLE todos (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id     TEXT        NOT NULL DEFAULT auth.uid(),
  owner_name   TEXT,
  title        TEXT        NOT NULL,
  detail       TEXT,
  status       TEXT        NOT NULL DEFAULT 'pending',
  priority     TEXT        NOT NULL DEFAULT 'medium',
  due_date     DATE,
  category     TEXT        DEFAULT '未分类',
  note_id      BIGINT,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE todos IS '待办事项，可由资料自动派生';

-- 资料之间的关联（由大模型给出理由与相关度）
CREATE TABLE note_links (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id        TEXT        NOT NULL DEFAULT auth.uid(),
  note_id         BIGINT      NOT NULL,
  related_note_id BIGINT      NOT NULL,
  reason          TEXT,
  score           NUMERIC     DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE note_links IS '资料之间的关联边，含关联理由与相关度';

-- 智能问答会话消息
CREATE TABLE chat_messages (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id        TEXT        NOT NULL DEFAULT auth.uid(),
  conversation_id TEXT        NOT NULL,
  role            TEXT        NOT NULL,
  content         TEXT        NOT NULL,
  refs            TEXT[]      DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE chat_messages IS '智能问答的会话记录';

-- 阶段总结
CREATE TABLE reports (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id      TEXT        NOT NULL DEFAULT auth.uid(),
  period_start  DATE        NOT NULL,
  period_end    DATE        NOT NULL,
  title         TEXT        NOT NULL,
  summary       TEXT,
  highlights    TEXT[]      DEFAULT '{}',
  next_actions  TEXT[]      DEFAULT '{}',
  stats         JSONB       DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE reports IS '阶段总结与后续行动建议';

-- ---------------------------- 索引 ----------------------------

CREATE INDEX notes_owner_created_idx ON notes (owner_id, created_at DESC);
CREATE INDEX todos_owner_status_idx ON todos (owner_id, status, due_date);
CREATE INDEX note_links_note_idx ON note_links (note_id);
CREATE INDEX note_links_related_idx ON note_links (related_note_id);
CREATE INDEX chat_messages_conv_idx ON chat_messages (owner_id, conversation_id, created_at);
CREATE INDEX reports_owner_idx ON reports (owner_id, created_at DESC);

-- ------------------------- RLS：仅本人 -------------------------
-- 每张表两条必备：表级 GRANT + 行级 POLICY，缺任一条都会报 42501。

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notes TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.todos TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.note_links TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_messages TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reports TO authenticated, anon;

-- notes
DROP POLICY IF EXISTS notes_owner_rw ON notes;
CREATE POLICY notes_owner_rw ON notes FOR ALL TO authenticated, anon
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- todos
DROP POLICY IF EXISTS todos_owner_rw ON todos;
CREATE POLICY todos_owner_rw ON todos FOR ALL TO authenticated, anon
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- note_links
DROP POLICY IF EXISTS note_links_owner_rw ON note_links;
CREATE POLICY note_links_owner_rw ON note_links FOR ALL TO authenticated, anon
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- chat_messages
DROP POLICY IF EXISTS chat_messages_owner_rw ON chat_messages;
CREATE POLICY chat_messages_owner_rw ON chat_messages FOR ALL TO authenticated, anon
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- reports
DROP POLICY IF EXISTS reports_owner_rw ON reports;
CREATE POLICY reports_owner_rw ON reports FOR ALL TO authenticated, anon
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
