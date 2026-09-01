ALTER TABLE applications ADD COLUMN home_url TEXT;
ALTER TABLE applications ADD COLUMN health_check_url TEXT;
ALTER TABLE applications ADD COLUMN integration_status TEXT NOT NULL DEFAULT 'ready'
  CHECK (integration_status IN ('configuring','testing','ready','error'));
ALTER TABLE applications ADD COLUMN monitor_until TEXT;
ALTER TABLE applications ADD COLUMN last_check_at TEXT;
ALTER TABLE applications ADD COLUMN last_check_status TEXT
  CHECK (last_check_status IS NULL OR last_check_status IN ('success','failure'));
ALTER TABLE applications ADD COLUMN last_check_http_status INTEGER;
ALTER TABLE applications ADD COLUMN last_check_message TEXT;
ALTER TABLE applications ADD COLUMN auth_test_at TEXT;
ALTER TABLE applications ADD COLUMN logout_test_at TEXT;

CREATE TABLE application_connectivity_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('success','failure')),
  http_status INTEGER,
  response_ms INTEGER,
  message TEXT,
  checked_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_application_checks_app_time
  ON application_connectivity_checks(application_id, checked_at DESC);
CREATE INDEX idx_applications_monitor_until
  ON applications(monitor_until, status);
