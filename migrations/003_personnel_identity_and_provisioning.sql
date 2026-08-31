ALTER TABLE people ADD COLUMN grade_year INTEGER;
ALTER TABLE people ADD COLUMN permanent_member INTEGER NOT NULL DEFAULT 0 CHECK (permanent_member IN (0,1));
ALTER TABLE people ADD COLUMN source_system TEXT;
ALTER TABLE people ADD COLUMN source_record_id TEXT;
ALTER TABLE people ADD COLUMN migration_batch_id TEXT;
ALTER TABLE appointments ADD COLUMN source_system TEXT;
ALTER TABLE appointments ADD COLUMN source_record_id TEXT;
ALTER TABLE appointments ADD COLUMN migration_batch_id TEXT;
ALTER TABLE applications ADD COLUMN provisioning_enabled INTEGER NOT NULL DEFAULT 0 CHECK (provisioning_enabled IN (0,1));

CREATE UNIQUE INDEX uq_people_source_record
  ON people(source_system, source_record_id)
  WHERE source_system IS NOT NULL AND source_record_id IS NOT NULL;

CREATE TABLE person_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL REFERENCES people(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_by TEXT REFERENCES people(id),
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_person_status_history_person ON person_status_history(person_id, effective_at);

CREATE TABLE migration_batches (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  source_exported_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('previewed','committed','rolled_back','failed')),
  summary_json TEXT NOT NULL,
  created_by TEXT REFERENCES people(id),
  created_at TEXT NOT NULL,
  committed_at TEXT,
  rolled_back_at TEXT,
  UNIQUE (source_system, source_fingerprint)
) STRICT;

CREATE TABLE migration_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES migration_batches(id) ON DELETE CASCADE,
  source_record_id TEXT,
  user_id TEXT,
  conflict_type TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  resolution TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_migration_conflicts_batch ON migration_conflicts(batch_id, conflict_type);

CREATE TABLE quick_registration_tokens (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT,
  display_name TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_by TEXT REFERENCES people(id),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_quick_registration_expiry ON quick_registration_tokens(expires_at, consumed_at);

CREATE TABLE turnover_runs (
  id TEXT PRIMARY KEY,
  target_term_id TEXT NOT NULL REFERENCES organization_terms(id),
  status TEXT NOT NULL CHECK (status IN ('preparing','completed','cancelled')),
  started_by TEXT NOT NULL REFERENCES people(id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  summary_json TEXT NOT NULL
) STRICT;

CREATE TABLE turnover_account_snapshots (
  turnover_id TEXT NOT NULL REFERENCES turnover_runs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  previous_status TEXT NOT NULL,
  PRIMARY KEY (turnover_id, account_id)
) STRICT;

CREATE TRIGGER trg_wecom_identity_matches_person_insert
BEFORE INSERT ON wecom_identities
WHEN NEW.wecom_userid <> NEW.person_id
BEGIN
  SELECT RAISE(ABORT, 'wecom_userid must equal canonical people.id');
END;

CREATE TRIGGER trg_wecom_identity_matches_person_update
BEFORE UPDATE OF person_id, wecom_userid ON wecom_identities
WHEN NEW.wecom_userid <> NEW.person_id
BEGIN
  SELECT RAISE(ABORT, 'wecom_userid must equal canonical people.id');
END;
