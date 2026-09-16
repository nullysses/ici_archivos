CREATE TABLE IF NOT EXISTS archivematica_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  archive_transfer_id uuid NOT NULL,
  submission_status text NOT NULL CHECK (submission_status IN ('PENDING', 'SUBMITTED', 'RECONCILIATION_REQUIRED', 'FAILED')),
  archivematica_transfer_uuid uuid,
  sip_uuid uuid,
  aip_uuid uuid,
  dip_uuid uuid,
  processing_configuration text NOT NULL,
  transfer_source_location_uuid uuid NOT NULL,
  transfer_source_relative_path text NOT NULL CHECK (length(trim(transfer_source_relative_path)) > 0),
  last_remote_status text,
  last_ingest_status text,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  UNIQUE (institution_id, archive_transfer_id),
  UNIQUE (institution_id, archivematica_transfer_uuid),
  FOREIGN KEY (institution_id, archive_transfer_id) REFERENCES archive_transfers (institution_id, id)
);

ALTER TABLE archivematica_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE archivematica_transfers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archivematica_transfers_tenant_isolation ON archivematica_transfers;
CREATE POLICY archivematica_transfers_tenant_isolation ON archivematica_transfers
  USING (institution_id::text = current_setting('app.institution_id', true))
  WITH CHECK (institution_id::text = current_setting('app.institution_id', true));

CREATE INDEX IF NOT EXISTS archivematica_transfers_status_idx
  ON archivematica_transfers (institution_id, submission_status);
