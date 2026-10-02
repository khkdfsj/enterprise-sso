CREATE TABLE trusted_http_origins (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by TEXT REFERENCES people(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (host, port)
) STRICT;

CREATE INDEX idx_trusted_http_origins_status ON trusted_http_origins(status, host, port);

INSERT INTO trusted_http_origins(id,host,port,note,status,created_by,created_at,updated_at)
VALUES
  ('initial-http-181','210.47.163.181',80,'现有内网服务器','active',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('initial-http-118','210.47.163.118',80,'现有内网服务器','active',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('initial-http-113','210.47.163.113',80,'现有内网服务器','active',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('initial-http-003','10.2.0.3',80,'现有内网服务器','active',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
