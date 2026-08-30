CREATE TABLE system_role_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL REFERENCES people(id),
  role TEXT NOT NULL CHECK (role IN ('super_admin','security_admin','personnel_admin','application_admin','audit_viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  granted_by TEXT REFERENCES people(id),
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (person_id, role),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
) STRICT;
CREATE INDEX idx_system_roles_person ON system_role_assignments(person_id, status, starts_at, ends_at);

CREATE TABLE term_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id TEXT NOT NULL UNIQUE REFERENCES organization_terms(id),
  published_by TEXT NOT NULL REFERENCES people(id),
  effective_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  activated_at TEXT
) STRICT;

CREATE UNIQUE INDEX uq_appointments_primary_per_term
  ON appointments(person_id, term_id)
  WHERE is_primary=1 AND status IN ('draft','pending','scheduled','active');
