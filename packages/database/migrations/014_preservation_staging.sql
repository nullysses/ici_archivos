CREATE TABLE IF NOT EXISTS preservation_staging_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  archive_transfer_id uuid NOT NULL,
  location_uuid uuid NOT NULL,
  relative_path text NOT NULL CHECK (length(trim(relative_path)) > 0 AND left(relative_path, 1) <> '/' AND position('..' in relative_path) = 0),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-fA-F]{64}$'),
  status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'STAGED', 'RECONCILIATION_REQUIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  UNIQUE (institution_id, archive_transfer_id),
  FOREIGN KEY (institution_id, archive_transfer_id) REFERENCES archive_transfers (institution_id, id)
);

ALTER TABLE preservation_staging_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE preservation_staging_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS preservation_staging_records_tenant_isolation ON preservation_staging_records;
CREATE POLICY preservation_staging_records_tenant_isolation ON preservation_staging_records
  USING (institution_id::text = current_setting('app.institution_id', true))
  WITH CHECK (institution_id::text = current_setting('app.institution_id', true));

CREATE INDEX IF NOT EXISTS preservation_staging_records_status_idx
  ON preservation_staging_records (institution_id, status);
