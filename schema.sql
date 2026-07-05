-- PageDrop D1 schema
-- Apply with: npx wrangler d1 execute pagedrop_db --file=./schema.sql

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,      -- 12-char NanoID, also the R2 folder prefix
  name        TEXT,
  tags        TEXT,                  -- comma-separated
  total_size  INTEGER NOT NULL DEFAULT 0,
  file_count  INTEGER NOT NULL DEFAULT 0,
  is_public   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

-- Speeds up "WHERE name LIKE ? OR tags LIKE ?" searches
CREATE INDEX IF NOT EXISTS idx_projects_name    ON projects(name);
CREATE INDEX IF NOT EXISTS idx_projects_tags    ON projects(tags);
CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at);
