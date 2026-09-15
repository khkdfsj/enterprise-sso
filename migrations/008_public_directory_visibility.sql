ALTER TABLE people ADD COLUMN public_directory_visible INTEGER NOT NULL DEFAULT 1
  CHECK (public_directory_visible IN (0,1));

CREATE INDEX idx_people_public_directory
  ON people(public_directory_visible, status, id);
