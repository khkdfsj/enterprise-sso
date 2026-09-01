CREATE TABLE agent_api_credentials (
  id TEXT PRIMARY KEY,
  agent_identity TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  expires_at TEXT,
  last_used_at TEXT,
  created_by TEXT NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE INDEX idx_agent_credentials_status_expiry
  ON agent_api_credentials(status, expires_at);

CREATE TABLE agent_service_registrations (
  application_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES agent_api_credentials(id),
  agent_identity TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (credential_id, request_id)
) STRICT;

CREATE INDEX idx_agent_services_credential
  ON agent_service_registrations(credential_id, created_at DESC);

CREATE TABLE agent_package_tokens (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES agent_api_credentials(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_agent_package_tokens_expiry
  ON agent_package_tokens(expires_at, consumed_at);
