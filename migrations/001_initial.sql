CREATE TABLE people (
  id TEXT PRIMARY KEY,
  employee_no TEXT UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('candidate','probation','active','retired','left','graduated','dismissed')),
  authorization_version INTEGER NOT NULL DEFAULT 1 CHECK (authorization_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_people_status ON people(status);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL UNIQUE REFERENCES people(id),
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','locked','suspended','disabled')),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE password_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_version INTEGER NOT NULL DEFAULT 1 CHECK (password_version > 0),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  changed_at TEXT NOT NULL
) STRICT;

CREATE TABLE wecom_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  corp_id TEXT NOT NULL,
  wecom_userid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  bound_at TEXT NOT NULL,
  UNIQUE (corp_id, wecom_userid),
  UNIQUE (person_id, corp_id)
) STRICT;

CREATE TABLE organization_terms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','scheduled','active','archived')),
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (starts_at < ends_at)
) STRICT;
CREATE INDEX idx_terms_status_time ON organization_terms(status, starts_at, ends_at);

CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES departments(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  rank_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  term_id TEXT NOT NULL REFERENCES organization_terms(id),
  department_id TEXT NOT NULL REFERENCES departments(id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','scheduled','active','ended','cancelled')),
  approved_by TEXT REFERENCES people(id),
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (starts_at < ends_at)
) STRICT;
CREATE INDEX idx_appointments_person_status ON appointments(person_id, status, starts_at, ends_at);
CREATE INDEX idx_appointments_term_status ON appointments(term_id, status);
CREATE INDEX idx_appointments_department ON appointments(department_id, status);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  logo_url TEXT,
  client_secret_hash TEXT,
  application_type TEXT NOT NULL DEFAULT 'web' CHECK (application_type IN ('web','native')),
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'client_secret_post',
  access_mode TEXT NOT NULL DEFAULT 'rules' CHECK (access_mode IN ('all_active','rules')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE application_redirect_uris (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (application_id, redirect_uri)
) STRICT;

CREATE TABLE application_access_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('person','department','position')),
  subject_id TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
) STRICT;
CREATE INDEX idx_access_rules_app_time ON application_access_rules(application_id, starts_at, ends_at);
CREATE INDEX idx_access_rules_subject ON application_access_rules(subject_type, subject_id);

CREATE TABLE wecom_login_transactions (
  id TEXT PRIMARY KEY,
  interaction_uid TEXT NOT NULL,
  browser_secret_hash TEXT NOT NULL,
  oauth_state_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','scanned','approved','denied','expired','consumed')),
  person_id TEXT REFERENCES people(id),
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_wecom_tx_interaction ON wecom_login_transactions(interaction_uid);
CREATE INDEX idx_wecom_tx_state ON wecom_login_transactions(oauth_state_hash);
CREATE INDEX idx_wecom_tx_expiry ON wecom_login_transactions(status, expires_at);

CREATE TABLE interaction_csrf_tokens (
  interaction_uid TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE oidc_objects (
  model TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  grant_id TEXT,
  user_code TEXT,
  uid TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (model, id)
) STRICT;
CREATE INDEX idx_oidc_grant ON oidc_objects(grant_id);
CREATE INDEX idx_oidc_user_code ON oidc_objects(model, user_code);
CREATE INDEX idx_oidc_uid ON oidc_objects(model, uid);
CREATE INDEX idx_oidc_expiry ON oidc_objects(expires_at);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  actor_person_id TEXT REFERENCES people(id),
  event_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('success','failure','denied')),
  detail_json TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_audit_event_time ON audit_logs(event_type, created_at);
CREATE INDEX idx_audit_actor_time ON audit_logs(actor_person_id, created_at);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id, created_at);
