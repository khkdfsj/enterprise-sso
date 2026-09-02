ALTER TABLE applications ADD COLUMN created_by TEXT REFERENCES people(id);

CREATE INDEX idx_applications_created_by
  ON applications(created_by, created_at DESC);

UPDATE applications
SET created_by=(
  SELECT c.created_by
  FROM agent_service_registrations r
  JOIN agent_api_credentials c ON c.id=r.credential_id
  WHERE r.application_id=applications.id
  ORDER BY r.created_at DESC
  LIMIT 1
)
WHERE created_by IS NULL;

UPDATE applications
SET created_by=(
  SELECT l.actor_person_id
  FROM audit_logs l
  WHERE l.event_type='application_create'
    AND l.target_id=applications.client_id
    AND l.actor_person_id IS NOT NULL
  ORDER BY l.id DESC
  LIMIT 1
)
WHERE created_by IS NULL;
