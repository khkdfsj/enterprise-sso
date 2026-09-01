INSERT OR IGNORE INTO positions(id,code,name,rank_order,status,created_at,updated_at)
VALUES ('position-member','member','委员',20,'active',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE turnover_workflows (
  id TEXT PRIMARY KEY,
  source_term_id TEXT NOT NULL REFERENCES organization_terms(id),
  target_term_id TEXT NOT NULL UNIQUE REFERENCES organization_terms(id),
  target_grade_year INTEGER NOT NULL CHECK (target_grade_year BETWEEN 2000 AND 2200),
  current_step INTEGER NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 5),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  created_by TEXT NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
) STRICT;

CREATE INDEX idx_turnover_workflows_status
  ON turnover_workflows(status, updated_at DESC);

CREATE TABLE turnover_workflow_members (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES turnover_workflows(id) ON DELETE CASCADE,
  person_id TEXT REFERENCES people(id),
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  grade_year INTEGER CHECK (grade_year IS NULL OR grade_year BETWEEN 2000 AND 2200),
  department_id TEXT NOT NULL REFERENCES departments(id),
  previous_position_id TEXT REFERENCES positions(id),
  proposed_position_id TEXT NOT NULL REFERENCES positions(id),
  source TEXT NOT NULL CHECK (source IN ('retained','new')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workflow_id, user_id)
) STRICT;

CREATE INDEX idx_turnover_workflow_members_workflow
  ON turnover_workflow_members(workflow_id, source, grade_year, user_id);
