CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizational_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  parent_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  UNIQUE (institution_id, code),
  FOREIGN KEY (institution_id, parent_id) REFERENCES organizational_units (institution_id, id)
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id)
);

CREATE TABLE IF NOT EXISTS external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  user_id uuid NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  email_snapshot text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  UNIQUE (issuer, subject),
  FOREIGN KEY (institution_id, user_id) REFERENCES users (institution_id, id)
);

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id),
  permission_id uuid NOT NULL REFERENCES permissions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  user_id uuid NOT NULL,
  role_id uuid NOT NULL REFERENCES roles(id),
  unit_id uuid,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, user_id) REFERENCES users (institution_id, id),
  FOREIGN KEY (institution_id, unit_id) REFERENCES organizational_units (institution_id, id),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE TABLE IF NOT EXISTS folio_counters (
  institution_id uuid NOT NULL REFERENCES institutions(id),
  folio_kind text NOT NULL CHECK (folio_kind IN ('MATTER', 'EXPEDIENTE')),
  folio_year integer NOT NULL CHECK (folio_year BETWEEN 2000 AND 9999),
  next_value bigint NOT NULL CHECK (next_value > 0),
  PRIMARY KEY (institution_id, folio_kind, folio_year)
);

CREATE TABLE IF NOT EXISTS matters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  folio text NOT NULL,
  status text NOT NULL CHECK (status IN ('RECEIVED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'VOIDED')),
  received_at timestamptz NOT NULL,
  intake_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  linked_expediente_id uuid,
  resolution_metadata jsonb,
  closure_metadata jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  UNIQUE (institution_id, folio),
  CHECK (folio ~ '^OP-[0-9]{4}-[0-9]{6}$'),
  FOREIGN KEY (institution_id, created_by) REFERENCES users (institution_id, id)
);

CREATE TABLE IF NOT EXISTS matter_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  matter_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  user_id uuid,
  reason text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, matter_id) REFERENCES matters (institution_id, id),
  FOREIGN KEY (institution_id, unit_id) REFERENCES organizational_units (institution_id, id),
  FOREIGN KEY (institution_id, user_id) REFERENCES users (institution_id, id)
);

CREATE TABLE IF NOT EXISTS matter_state_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  matter_id uuid NOT NULL,
  from_status text CHECK (from_status IN ('RECEIVED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'VOIDED')),
  to_status text NOT NULL CHECK (to_status IN ('RECEIVED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'VOIDED')),
  command text NOT NULL,
  actor_user_id uuid,
  reason text,
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, matter_id) REFERENCES matters (institution_id, id),
  FOREIGN KEY (institution_id, actor_user_id) REFERENCES users (institution_id, id)
);

CREATE TABLE IF NOT EXISTS expediente_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  UNIQUE (institution_id, code)
);

CREATE TABLE IF NOT EXISTS expediente_type_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  expediente_type_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  schema_json jsonb NOT NULL,
  archival_mapping_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (institution_id, id),
  UNIQUE (institution_id, expediente_type_id, version_number),
  FOREIGN KEY (institution_id, expediente_type_id) REFERENCES expediente_types (institution_id, id),
  CHECK ((status = 'PUBLISHED' AND published_at IS NOT NULL) OR status <> 'PUBLISHED')
);

CREATE TABLE IF NOT EXISTS expedientes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  folio text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'TRANSFER_PENDING', 'TRANSFERRED', 'VOIDED')),
  expediente_type_version_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  UNIQUE (institution_id, folio),
  CHECK (folio ~ '^EXP-[0-9]{4}-[0-9]{6}$'),
  FOREIGN KEY (institution_id, expediente_type_version_id) REFERENCES expediente_type_versions (institution_id, id)
);

ALTER TABLE matters
  ADD CONSTRAINT matters_expediente_fk
  FOREIGN KEY (institution_id, linked_expediente_id) REFERENCES expedientes (institution_id, id);

CREATE TABLE IF NOT EXISTS expediente_state_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  expediente_id uuid NOT NULL,
  from_status text CHECK (from_status IN ('OPEN', 'CLOSED', 'TRANSFER_PENDING', 'TRANSFERRED', 'VOIDED')),
  to_status text NOT NULL CHECK (to_status IN ('OPEN', 'CLOSED', 'TRANSFER_PENDING', 'TRANSFERRED', 'VOIDED')),
  command text NOT NULL,
  actor_user_id uuid,
  reason text,
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, expediente_id) REFERENCES expedientes (institution_id, id),
  FOREIGN KEY (institution_id, actor_user_id) REFERENCES users (institution_id, id)
);

CREATE TABLE IF NOT EXISTS access_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  legal_classification text NOT NULL CHECK (legal_classification IN ('PUBLIC', 'RESERVED', 'CONFIDENTIAL')),
  operational_visibility text NOT NULL DEFAULT 'INSTITUTION' CHECK (operational_visibility IN ('INSTITUTION', 'UNIT', 'RESTRICTED_GROUP')),
  legal_basis text,
  reason text,
  classification_authority text,
  classified_at timestamptz,
  review_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  CHECK (legal_classification = 'PUBLIC' OR (legal_basis IS NOT NULL AND reason IS NOT NULL AND classification_authority IS NOT NULL AND classified_at IS NOT NULL)),
  CHECK (legal_classification <> 'RESERVED' OR review_expires_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  expediente_id uuid NOT NULL,
  document_type text NOT NULL,
  title text NOT NULL,
  current_version_id uuid,
  access_classification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, expediente_id) REFERENCES expedientes (institution_id, id),
  FOREIGN KEY (institution_id, access_classification_id) REFERENCES access_classifications (institution_id, id)
);

CREATE TABLE IF NOT EXISTS document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  document_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  original_filename text NOT NULL,
  detected_mime_type text NOT NULL,
  declared_mime_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-fA-F]{64}$'),
  storage_key text NOT NULL,
  malware_scan_status text NOT NULL CHECK (malware_scan_status IN ('PENDING_SCAN', 'CLEAN', 'INFECTED', 'SCAN_FAILED', 'QUARANTINED')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  replacement_reason text,
  UNIQUE (institution_id, id),
  UNIQUE (institution_id, document_id, version_number),
  FOREIGN KEY (institution_id, document_id) REFERENCES documents (institution_id, id),
  FOREIGN KEY (institution_id, created_by) REFERENCES users (institution_id, id),
  CHECK (version_number = 1 OR replacement_reason IS NOT NULL AND length(trim(replacement_reason)) > 0)
);

ALTER TABLE documents
  ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (institution_id, current_version_id) REFERENCES document_versions (institution_id, id);

CREATE TABLE IF NOT EXISTS malware_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  document_version_id uuid NOT NULL,
  engine text NOT NULL,
  engine_version text,
  signature_version text,
  result text NOT NULL CHECK (result IN ('PENDING_SCAN', 'CLEAN', 'INFECTED', 'SCAN_FAILED', 'QUARANTINED')),
  scanned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, document_version_id) REFERENCES document_versions (institution_id, id)
);

CREATE TABLE IF NOT EXISTS archival_classification_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  parent_id uuid,
  node_type text NOT NULL CHECK (node_type IN ('FONDS', 'SECTION', 'SERIES', 'SUBSERIES')),
  code text NOT NULL,
  name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  UNIQUE (institution_id, code),
  FOREIGN KEY (institution_id, parent_id) REFERENCES archival_classification_nodes (institution_id, id)
);

CREATE TABLE IF NOT EXISTS atom_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  ici_object_type text NOT NULL,
  ici_object_id uuid NOT NULL,
  atom_information_object_id bigint,
  atom_slug text,
  last_synced_at timestamptz,
  sync_status text NOT NULL DEFAULT 'PENDING' CHECK (sync_status IN ('PENDING', 'SYNCED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  UNIQUE (institution_id, ici_object_type, ici_object_id)
);

CREATE TABLE IF NOT EXISTS archive_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  expediente_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'APPROVED', 'SUBMITTED', 'PRESERVING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  supplements_transfer_id uuid,
  correction_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, expediente_id) REFERENCES expedientes (institution_id, id),
  FOREIGN KEY (institution_id, supplements_transfer_id) REFERENCES archive_transfers (institution_id, id),
  FOREIGN KEY (institution_id, created_by) REFERENCES users (institution_id, id),
  CHECK (supplements_transfer_id IS NULL OR (correction_reason IS NOT NULL AND length(trim(correction_reason)) > 0))
);

CREATE TABLE IF NOT EXISTS transfer_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  transfer_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'APPROVED')),
  canonical_json text NOT NULL,
  sha256 char(64),
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  UNIQUE (institution_id, transfer_id),
  FOREIGN KEY (institution_id, transfer_id) REFERENCES archive_transfers (institution_id, id),
  FOREIGN KEY (institution_id, approved_by) REFERENCES users (institution_id, id),
  CHECK ((status = 'APPROVED' AND sha256 IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL) OR status = 'DRAFT'),
  CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-fA-F]{64}$')
);

CREATE TABLE IF NOT EXISTS archival_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  transfer_id uuid NOT NULL,
  reason text NOT NULL,
  actor_user_id uuid NOT NULL,
  old_value jsonb NOT NULL,
  new_value jsonb NOT NULL,
  legal_basis text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, transfer_id) REFERENCES archive_transfers (institution_id, id),
  FOREIGN KEY (institution_id, actor_user_id) REFERENCES users (institution_id, id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  actor_user_id uuid,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  correlation_id text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (institution_id, actor_user_id) REFERENCES users (institution_id, id)
);

CREATE TABLE IF NOT EXISTS integration_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  job_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  idempotency_key text NOT NULL,
  correlation_id text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  last_error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  UNIQUE (institution_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS matters_institution_status_idx ON matters (institution_id, status);
CREATE INDEX IF NOT EXISTS matter_assignments_matter_idx ON matter_assignments (institution_id, matter_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS expediente_state_events_expediente_idx ON expediente_state_events (institution_id, expediente_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS documents_expediente_idx ON documents (institution_id, expediente_id);
CREATE INDEX IF NOT EXISTS document_versions_document_idx ON document_versions (institution_id, document_id, version_number DESC);
CREATE INDEX IF NOT EXISTS transfers_expediente_idx ON archive_transfers (institution_id, expediente_id, created_at DESC);
CREATE INDEX IF NOT EXISTS atom_mappings_object_idx ON atom_mappings (institution_id, ici_object_type, ici_object_id);
CREATE INDEX IF NOT EXISTS audit_events_aggregate_idx ON audit_events (institution_id, aggregate_type, aggregate_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS integration_jobs_ready_idx ON integration_jobs (institution_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS expediente_metadata_gin_idx ON expedientes USING gin (metadata);
CREATE INDEX IF NOT EXISTS type_versions_schema_gin_idx ON expediente_type_versions USING gin (schema_json);

CREATE OR REPLACE FUNCTION ici_current_institution_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.institution_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION ici_reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55006';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION ici_reject_append_only_mutation();

DROP TRIGGER IF EXISTS document_versions_immutable ON document_versions;
CREATE TRIGGER document_versions_immutable
  BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION ici_reject_append_only_mutation();

CREATE OR REPLACE FUNCTION ici_guard_published_type_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'Published expediente type versions remain readable and cannot be deleted' USING ERRCODE = '55006';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF OLD.status = 'PUBLISHED' AND (
    NEW.expediente_type_id IS DISTINCT FROM OLD.expediente_type_id OR
    NEW.version_number IS DISTINCT FROM OLD.version_number OR
    NEW.schema_json IS DISTINCT FROM OLD.schema_json OR
    NEW.archival_mapping_json IS DISTINCT FROM OLD.archival_mapping_json OR
    NEW.status NOT IN ('PUBLISHED', 'RETIRED')
  ) THEN
    RAISE EXCEPTION 'Published expediente type versions are immutable' USING ERRCODE = '55006';
  END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED' AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'Published timestamp cannot change' USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expediente_type_version_immutability ON expediente_type_versions;
CREATE TRIGGER expediente_type_version_immutability
  BEFORE UPDATE OR DELETE ON expediente_type_versions
  FOR EACH ROW EXECUTE FUNCTION ici_guard_published_type_version();

CREATE OR REPLACE FUNCTION ici_guard_approved_manifest() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'Approved transfer manifests are immutable' USING ERRCODE = '55006';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS approved_manifest_immutability ON transfer_manifests;
CREATE TRIGGER approved_manifest_immutability
  BEFORE UPDATE OR DELETE ON transfer_manifests
  FOR EACH ROW EXECUTE FUNCTION ici_guard_approved_manifest();

ALTER TABLE organizational_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizational_units FORCE ROW LEVEL SECURITY;
CREATE POLICY organizational_units_tenant_isolation ON organizational_units
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON users
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY external_identities_tenant_isolation ON external_identities
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE user_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY user_role_assignments_tenant_isolation ON user_role_assignments
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE folio_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE folio_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY folio_counters_tenant_isolation ON folio_counters
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE matters ENABLE ROW LEVEL SECURITY;
ALTER TABLE matters FORCE ROW LEVEL SECURITY;
CREATE POLICY matters_tenant_isolation ON matters
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE matter_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY matter_assignments_tenant_isolation ON matter_assignments
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE matter_state_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_state_events FORCE ROW LEVEL SECURITY;
CREATE POLICY matter_state_events_tenant_isolation ON matter_state_events
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE expediente_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE expediente_types FORCE ROW LEVEL SECURITY;
CREATE POLICY expediente_types_tenant_isolation ON expediente_types
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE expediente_type_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE expediente_type_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY expediente_type_versions_tenant_isolation ON expediente_type_versions
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE expedientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE expedientes FORCE ROW LEVEL SECURITY;
CREATE POLICY expedientes_tenant_isolation ON expedientes
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE expediente_state_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE expediente_state_events FORCE ROW LEVEL SECURITY;
CREATE POLICY expediente_state_events_tenant_isolation ON expediente_state_events
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE access_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_classifications FORCE ROW LEVEL SECURITY;
CREATE POLICY access_classifications_tenant_isolation ON access_classifications
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_tenant_isolation ON documents
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY document_versions_tenant_isolation ON document_versions
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE malware_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE malware_scans FORCE ROW LEVEL SECURITY;
CREATE POLICY malware_scans_tenant_isolation ON malware_scans
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE archival_classification_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE archival_classification_nodes FORCE ROW LEVEL SECURITY;
CREATE POLICY archival_classification_nodes_tenant_isolation ON archival_classification_nodes
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE atom_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE atom_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY atom_mappings_tenant_isolation ON atom_mappings
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE archive_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY archive_transfers_tenant_isolation ON archive_transfers
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE transfer_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY transfer_manifests_tenant_isolation ON transfer_manifests
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE archival_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE archival_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY archival_corrections_tenant_isolation ON archival_corrections
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_isolation ON audit_events
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());

ALTER TABLE integration_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_jobs_tenant_isolation ON integration_jobs
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());
