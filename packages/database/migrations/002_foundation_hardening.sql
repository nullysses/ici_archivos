-- Preserve the numeric identity behind human folios and make it impossible to
-- renumber a committed aggregate.
ALTER TABLE matters DISABLE ROW LEVEL SECURITY;
ALTER TABLE expedientes DISABLE ROW LEVEL SECURITY;

ALTER TABLE matters ADD COLUMN folio_year integer;
ALTER TABLE matters ADD COLUMN sequence_number bigint;
UPDATE matters
SET folio_year = substring(folio FROM 4 FOR 4)::integer,
    sequence_number = substring(folio FROM 9)::bigint;
ALTER TABLE matters ALTER COLUMN folio_year SET NOT NULL;
ALTER TABLE matters ALTER COLUMN sequence_number SET NOT NULL;
ALTER TABLE matters
  ADD CONSTRAINT matters_folio_year_check CHECK (folio_year BETWEEN 2000 AND 9999),
  ADD CONSTRAINT matters_sequence_number_check CHECK (sequence_number BETWEEN 1 AND 999999),
  ADD CONSTRAINT matters_folio_components_check
    CHECK (folio = 'OP-' || folio_year::text || '-' || lpad(sequence_number::text, 6, '0')),
  ADD CONSTRAINT matters_folio_sequence_unique UNIQUE (institution_id, folio_year, sequence_number);

ALTER TABLE expedientes ADD COLUMN folio_year integer;
ALTER TABLE expedientes ADD COLUMN sequence_number bigint;
UPDATE expedientes
SET folio_year = substring(folio FROM 5 FOR 4)::integer,
    sequence_number = substring(folio FROM 10)::bigint;
ALTER TABLE expedientes ALTER COLUMN folio_year SET NOT NULL;
ALTER TABLE expedientes ALTER COLUMN sequence_number SET NOT NULL;
ALTER TABLE expedientes
  ADD CONSTRAINT expedientes_folio_year_check CHECK (folio_year BETWEEN 2000 AND 9999),
  ADD CONSTRAINT expedientes_sequence_number_check CHECK (sequence_number BETWEEN 1 AND 999999),
  ADD CONSTRAINT expedientes_folio_components_check
    CHECK (folio = 'EXP-' || folio_year::text || '-' || lpad(sequence_number::text, 6, '0')),
  ADD CONSTRAINT expedientes_folio_sequence_unique UNIQUE (institution_id, folio_year, sequence_number);

ALTER TABLE matters ENABLE ROW LEVEL SECURITY;
ALTER TABLE matters FORCE ROW LEVEL SECURITY;
ALTER TABLE expedientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE expedientes FORCE ROW LEVEL SECURITY;

ALTER TABLE institutions
  ADD CONSTRAINT institutions_nonblank_check CHECK (length(trim(code)) > 0 AND length(trim(name)) > 0);
ALTER TABLE organizational_units
  ADD CONSTRAINT organizational_units_nonblank_check CHECK (length(trim(code)) > 0 AND length(trim(name)) > 0);
ALTER TABLE users
  ADD CONSTRAINT users_display_name_nonblank_check CHECK (length(trim(display_name)) > 0);
ALTER TABLE external_identities
  ADD CONSTRAINT external_identities_key_nonblank_check CHECK (length(trim(issuer)) > 0 AND length(trim(subject)) > 0);
ALTER TABLE roles
  ADD CONSTRAINT roles_nonblank_check CHECK (length(trim(code)) > 0 AND length(trim(name)) > 0);
ALTER TABLE permissions
  ADD CONSTRAINT permissions_nonblank_check CHECK (length(trim(code)) > 0 AND length(trim(name)) > 0);
ALTER TABLE matters
  ADD CONSTRAINT matters_intake_object_check CHECK (jsonb_typeof(intake_metadata) = 'object' AND intake_metadata <> '{}'::jsonb);
ALTER TABLE expediente_types
  ADD CONSTRAINT expediente_types_nonblank_check CHECK (length(trim(code)) > 0 AND length(trim(name)) > 0);
ALTER TABLE expediente_type_versions
  ADD CONSTRAINT expediente_type_versions_json_objects_check CHECK (jsonb_typeof(schema_json) = 'object' AND jsonb_typeof(archival_mapping_json) = 'object');
ALTER TABLE expedientes
  ADD CONSTRAINT expedientes_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object');
ALTER TABLE documents
  ADD CONSTRAINT documents_nonblank_check CHECK (length(trim(document_type)) > 0 AND length(trim(title)) > 0);
ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_nonblank_check CHECK (
    length(trim(original_filename)) > 0 AND
    length(trim(detected_mime_type)) > 0 AND
    length(trim(storage_key)) > 0
  );
ALTER TABLE transfer_manifests
  ADD CONSTRAINT transfer_manifests_canonical_nonblank_check CHECK (length(canonical_json) > 0);
ALTER TABLE archival_corrections
  ADD CONSTRAINT archival_corrections_reason_nonblank_check CHECK (length(trim(reason)) > 0);
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_nonblank_check CHECK (
    length(trim(event_type)) > 0 AND
    length(trim(aggregate_type)) > 0 AND
    length(trim(correlation_id)) > 0
  );
ALTER TABLE integration_jobs
  ADD CONSTRAINT integration_jobs_nonblank_check CHECK (
    length(trim(job_type)) > 0 AND
    length(trim(aggregate_type)) > 0 AND
    length(trim(idempotency_key)) > 0 AND
    length(trim(correlation_id)) > 0
  ),
  ADD CONSTRAINT integration_jobs_payload_object_check CHECK (jsonb_typeof(payload) = 'object');

CREATE OR REPLACE FUNCTION ici_guard_committed_folio() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.institution_id IS DISTINCT FROM OLD.institution_id OR
     NEW.folio IS DISTINCT FROM OLD.folio OR
     NEW.folio_year IS DISTINCT FROM OLD.folio_year OR
     NEW.sequence_number IS DISTINCT FROM OLD.sequence_number THEN
    RAISE EXCEPTION 'Committed folios are immutable' USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER matters_folio_immutability
  BEFORE UPDATE ON matters
  FOR EACH ROW EXECUTE FUNCTION ici_guard_committed_folio();

CREATE TRIGGER expedientes_folio_immutability
  BEFORE UPDATE ON expedientes
  FOR EACH ROW EXECUTE FUNCTION ici_guard_committed_folio();

-- Published and retired definitions remain immutable. Publishing is serialized
-- on the stable type row and must use the next version number.
ALTER TABLE expediente_type_versions
  DROP CONSTRAINT expediente_type_versions_check,
  ADD CONSTRAINT expediente_type_versions_publication_check
    CHECK (
      (status = 'DRAFT' AND published_at IS NULL) OR
      (status IN ('PUBLISHED', 'RETIRED') AND published_at IS NOT NULL)
    );

CREATE OR REPLACE FUNCTION ici_guard_type_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  latest_published integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'RETIRED' THEN
      RAISE EXCEPTION 'A type version must be published before it can be retired' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'PUBLISHED' THEN
      PERFORM 1
      FROM expediente_types
      WHERE institution_id = NEW.institution_id AND id = NEW.expediente_type_id
      FOR UPDATE;

      SELECT coalesce(max(version_number), 0)
      INTO latest_published
      FROM expediente_type_versions
      WHERE institution_id = NEW.institution_id
        AND expediente_type_id = NEW.expediente_type_id
        AND status IN ('PUBLISHED', 'RETIRED');

      IF NEW.version_number <> latest_published + 1 THEN
        RAISE EXCEPTION 'Published version number must be the next sequential value' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('PUBLISHED', 'RETIRED') THEN
      RAISE EXCEPTION 'Published expediente type versions remain readable and cannot be deleted' USING ERRCODE = '55006';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'RETIRED' THEN
    RAISE EXCEPTION 'Retired expediente type versions are immutable' USING ERRCODE = '55006';
  END IF;

  IF OLD.status = 'PUBLISHED' THEN
    IF NEW.expediente_type_id IS DISTINCT FROM OLD.expediente_type_id OR
       NEW.version_number IS DISTINCT FROM OLD.version_number OR
       NEW.schema_json IS DISTINCT FROM OLD.schema_json OR
       NEW.archival_mapping_json IS DISTINCT FROM OLD.archival_mapping_json OR
       NEW.published_at IS DISTINCT FROM OLD.published_at OR
       NEW.status NOT IN ('PUBLISHED', 'RETIRED') THEN
      RAISE EXCEPTION 'Published expediente type versions are immutable' USING ERRCODE = '55006';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'RETIRED' THEN
    RAISE EXCEPTION 'A type version must be published before it can be retired' USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('PUBLISHED', 'RETIRED') THEN
    PERFORM 1
    FROM expediente_types
    WHERE institution_id = NEW.institution_id AND id = NEW.expediente_type_id
    FOR UPDATE;

    SELECT coalesce(max(version_number), 0)
    INTO latest_published
    FROM expediente_type_versions
    WHERE institution_id = NEW.institution_id
      AND expediente_type_id = NEW.expediente_type_id
      AND id <> NEW.id
      AND status IN ('PUBLISHED', 'RETIRED');

    IF NEW.version_number <> latest_published + 1 THEN
      RAISE EXCEPTION 'Published version number must be the next sequential value' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER expediente_type_version_immutability ON expediente_type_versions;
DROP FUNCTION ici_guard_published_type_version();
CREATE TRIGGER expediente_type_version_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON expediente_type_versions
  FOR EACH ROW EXECUTE FUNCTION ici_guard_type_version();

CREATE OR REPLACE FUNCTION ici_require_published_type_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.expediente_type_version_id IS DISTINCT FROM OLD.expediente_type_version_id THEN
    RAISE EXCEPTION 'Expediente type version migration requires a dedicated audited operation' USING ERRCODE = '55006';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM expediente_type_versions
    WHERE institution_id = NEW.institution_id
      AND id = NEW.expediente_type_version_id
      AND status = 'PUBLISHED'
  ) THEN
    RAISE EXCEPTION 'Expedientes must reference a published type version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER expedientes_require_published_type_version
  BEFORE INSERT OR UPDATE OF institution_id, expediente_type_version_id ON expedientes
  FOR EACH ROW EXECUTE FUNCTION ici_require_published_type_version();

-- A current version must belong to the same logical document, not merely the
-- same institution.
ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_document_identity_unique UNIQUE (institution_id, document_id, id);
ALTER TABLE documents DROP CONSTRAINT documents_current_version_fk;
ALTER TABLE documents
  ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (institution_id, id, current_version_id)
  REFERENCES document_versions (institution_id, document_id, id);

-- A version keeps the classification decision that applied when it was
-- accepted; later changes to the logical document do not rewrite history.
ALTER TABLE document_versions
  ADD COLUMN access_classification_snapshot jsonb NOT NULL
  DEFAULT '{"legalClassification":"PUBLIC","operationalVisibility":"INSTITUTION"}'::jsonb,
  ADD CONSTRAINT document_versions_classification_snapshot_check CHECK (
    jsonb_typeof(access_classification_snapshot) = 'object' AND
    access_classification_snapshot ->> 'legalClassification' IN ('PUBLIC', 'RESERVED', 'CONFIDENTIAL') AND
    access_classification_snapshot ->> 'operationalVisibility' IN ('INSTITUTION', 'UNIT', 'RESTRICTED_GROUP')
  );

-- Binary identity and metadata are immutable. Malware state is intentionally
-- allowed to advance because scanning occurs after intake.
CREATE OR REPLACE FUNCTION ici_guard_document_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document_versions is append-only' USING ERRCODE = '55006';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.institution_id IS DISTINCT FROM OLD.institution_id OR
     NEW.document_id IS DISTINCT FROM OLD.document_id OR
     NEW.version_number IS DISTINCT FROM OLD.version_number OR
     NEW.original_filename IS DISTINCT FROM OLD.original_filename OR
     NEW.detected_mime_type IS DISTINCT FROM OLD.detected_mime_type OR
     NEW.declared_mime_type IS DISTINCT FROM OLD.declared_mime_type OR
     NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR
     NEW.sha256 IS DISTINCT FROM OLD.sha256 OR
     NEW.storage_key IS DISTINCT FROM OLD.storage_key OR
     NEW.access_classification_snapshot IS DISTINCT FROM OLD.access_classification_snapshot OR
     NEW.created_by IS DISTINCT FROM OLD.created_by OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.replacement_reason IS DISTINCT FROM OLD.replacement_reason THEN
    RAISE EXCEPTION 'Document version binary metadata is immutable' USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER document_versions_immutable ON document_versions;
CREATE TRIGGER document_versions_immutable
  BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION ici_guard_document_version();

CREATE OR REPLACE FUNCTION ici_guard_new_document_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expediente_status text;
  latest_version integer;
BEGIN
  SELECT expedientes.status
  INTO expediente_status
  FROM documents
  JOIN expedientes
    ON expedientes.institution_id = documents.institution_id
   AND expedientes.id = documents.expediente_id
  WHERE documents.institution_id = NEW.institution_id
    AND documents.id = NEW.document_id
  FOR UPDATE OF documents;

  IF expediente_status IS NULL THEN
    RAISE EXCEPTION 'Logical document does not exist in this institution' USING ERRCODE = '23503';
  END IF;
  IF expediente_status <> 'OPEN' THEN
    RAISE EXCEPTION 'Document versions may only be created while the expediente is open' USING ERRCODE = '23514';
  END IF;
  IF NEW.malware_scan_status <> 'PENDING_SCAN' THEN
    RAISE EXCEPTION 'A new document version must begin pending malware scan' USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(max(version_number), 0)
  INTO latest_version
  FROM document_versions
  WHERE institution_id = NEW.institution_id AND document_id = NEW.document_id;
  IF NEW.version_number <> latest_version + 1 THEN
    RAISE EXCEPTION 'Document version number must be the next sequential value' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_versions_creation_guard
  BEFORE INSERT ON document_versions
  FOR EACH ROW EXECUTE FUNCTION ici_guard_new_document_version();

CREATE OR REPLACE FUNCTION ici_guard_current_document_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND NOT EXISTS (
    SELECT 1
    FROM expedientes
    WHERE institution_id = NEW.institution_id
      AND id = NEW.expediente_id
      AND status = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'Current document version is frozen while the expediente is not open' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_current_version_guard
  BEFORE UPDATE OF current_version_id ON documents
  FOR EACH ROW EXECUTE FUNCTION ici_guard_current_document_version();

-- The digest protects the exact UTF-8 bytes stored as canonical_json.
ALTER TABLE transfer_manifests
  ADD CONSTRAINT transfer_manifests_canonical_digest_check
  CHECK (
    status <> 'APPROVED' OR
    sha256 = encode(digest(convert_to(canonical_json, 'UTF8'), 'sha256'), 'hex')
  );

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
  IF NEW.status = 'APPROVED' AND NOT EXISTS (
    SELECT 1
    FROM archive_transfers
    WHERE institution_id = NEW.institution_id
      AND id = NEW.transfer_id
      AND status = 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'A manifest can only be approved for a draft transfer' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Domain history is append-only just like the canonical audit log.
CREATE TRIGGER matter_assignments_append_only
  BEFORE UPDATE OR DELETE ON matter_assignments
  FOR EACH ROW EXECUTE FUNCTION ici_reject_append_only_mutation();
CREATE TRIGGER matter_state_events_append_only
  BEFORE UPDATE OR DELETE ON matter_state_events
  FOR EACH ROW EXECUTE FUNCTION ici_reject_append_only_mutation();
CREATE TRIGGER expediente_state_events_append_only
  BEFORE UPDATE OR DELETE ON expediente_state_events
  FOR EACH ROW EXECUTE FUNCTION ici_reject_append_only_mutation();
CREATE TRIGGER archival_corrections_append_only
  BEFORE UPDATE OR DELETE ON archival_corrections
  FOR EACH ROW EXECUTE FUNCTION ici_reject_append_only_mutation();

-- Reserved-information review dates are required only when applicable by the
-- ADR; the original migration made them unconditionally mandatory.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT c.conname
  INTO constraint_name
  FROM pg_constraint AS c
  WHERE c.conrelid = 'access_classifications'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%review_expires_at%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE access_classifications DROP CONSTRAINT %I', constraint_name);
  END IF;
END;
$$;

-- RLS prevents tenant changes, but these guards also constrain privileged
-- maintenance code to the documented state graph.
CREATE OR REPLACE FUNCTION ici_require_initial_status() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> TG_ARGV[0] THEN
    RAISE EXCEPTION '% must be created in % state', TG_TABLE_NAME, TG_ARGV[0] USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER matters_initial_status
  BEFORE INSERT ON matters
  FOR EACH ROW EXECUTE FUNCTION ici_require_initial_status('RECEIVED');
CREATE TRIGGER expedientes_initial_status
  BEFORE INSERT ON expedientes
  FOR EACH ROW EXECUTE FUNCTION ici_require_initial_status('OPEN');
CREATE TRIGGER archive_transfers_initial_status
  BEFORE INSERT ON archive_transfers
  FOR EACH ROW EXECUTE FUNCTION ici_require_initial_status('DRAFT');
CREATE TRIGGER transfer_manifests_initial_status
  BEFORE INSERT ON transfer_manifests
  FOR EACH ROW EXECUTE FUNCTION ici_require_initial_status('DRAFT');
CREATE TRIGGER integration_jobs_initial_status
  BEFORE INSERT ON integration_jobs
  FOR EACH ROW EXECUTE FUNCTION ici_require_initial_status('PENDING');

CREATE OR REPLACE FUNCTION ici_guard_matter_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'RECEIVED' AND NEW.status IN ('ASSIGNED', 'VOIDED')) OR
    (OLD.status = 'ASSIGNED' AND NEW.status IN ('ASSIGNED', 'IN_PROGRESS', 'VOIDED')) OR
    (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('ASSIGNED', 'RESOLVED')) OR
    (OLD.status = 'RESOLVED' AND NEW.status IN ('IN_PROGRESS', 'CLOSED'))
  ) THEN
    RAISE EXCEPTION 'Invalid matter state transition from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'RECEIVED' AND NEW.status = 'ASSIGNED' AND NOT EXISTS (
    SELECT 1 FROM matter_assignments
    WHERE institution_id = NEW.institution_id AND matter_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Assignment state requires an assignment record' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'ASSIGNED' AND NEW.status = 'IN_PROGRESS' AND NOT EXISTS (
    SELECT 1 FROM matter_assignments
    WHERE institution_id = NEW.institution_id AND matter_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Work cannot start without a current assignment' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'IN_PROGRESS' AND NEW.status = 'RESOLVED' AND NEW.resolution_metadata IS NULL THEN
    RAISE EXCEPTION 'Resolution metadata is required' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'RESOLVED' AND NEW.status = 'IN_PROGRESS' AND NOT EXISTS (
    SELECT 1 FROM expedientes
    WHERE institution_id = NEW.institution_id
      AND id = NEW.linked_expediente_id
      AND status = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'A matter may reopen only while its linked expediente is open' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'RESOLVED' AND NEW.status = 'CLOSED' AND
     (NEW.linked_expediente_id IS NULL OR NEW.closure_metadata IS NULL) THEN
    RAISE EXCEPTION 'Matter closure requires a linked expediente and closure metadata' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER matters_state_machine
  BEFORE UPDATE OF status ON matters
  FOR EACH ROW EXECUTE FUNCTION ici_guard_matter_transition();

CREATE OR REPLACE FUNCTION ici_guard_expediente_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'OPEN' AND NEW.status IN ('CLOSED', 'VOIDED')) OR
    (OLD.status = 'CLOSED' AND NEW.status IN ('OPEN', 'TRANSFER_PENDING')) OR
    (OLD.status = 'TRANSFER_PENDING' AND NEW.status IN ('CLOSED', 'TRANSFERRED'))
  ) THEN
    RAISE EXCEPTION 'Invalid expediente state transition from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'OPEN' AND NEW.status = 'CLOSED' THEN
    IF EXISTS (
      SELECT 1 FROM matters
      WHERE institution_id = NEW.institution_id
        AND linked_expediente_id = NEW.id
        AND status NOT IN ('CLOSED', 'VOIDED')
    ) THEN
      RAISE EXCEPTION 'All linked matters must be closed or voided' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM documents
      LEFT JOIN document_versions
        ON document_versions.institution_id = documents.institution_id
       AND document_versions.id = documents.current_version_id
      WHERE documents.institution_id = NEW.institution_id
        AND documents.expediente_id = NEW.id
        AND (document_versions.id IS NULL OR document_versions.malware_scan_status <> 'CLEAN')
    ) THEN
      RAISE EXCEPTION 'All current document versions must have a clean malware scan' USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := coalesce(NEW.closed_at, now());
  END IF;
  IF OLD.status = 'CLOSED' AND NEW.status = 'OPEN' THEN
    IF EXISTS (
      SELECT 1 FROM archive_transfers
      WHERE institution_id = NEW.institution_id
        AND expediente_id = NEW.id
        AND status IN ('APPROVED', 'SUBMITTED', 'PRESERVING', 'COMPLETED', 'FAILED')
    ) THEN
      RAISE EXCEPTION 'An expediente cannot reopen after transfer approval' USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := NULL;
  END IF;
  IF OLD.status = 'TRANSFER_PENDING' AND NEW.status = 'TRANSFERRED' AND NOT EXISTS (
    SELECT 1 FROM archive_transfers
    WHERE institution_id = NEW.institution_id
      AND expediente_id = NEW.id
      AND status = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'A completed archival transfer is required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER expedientes_state_machine
  BEFORE UPDATE OF status ON expedientes
  FOR EACH ROW EXECUTE FUNCTION ici_guard_expediente_transition();

CREATE OR REPLACE FUNCTION ici_guard_archive_transfer_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'CANCELLED')) OR
    (OLD.status = 'APPROVED' AND NEW.status IN ('SUBMITTED', 'CANCELLED')) OR
    (OLD.status = 'SUBMITTED' AND NEW.status IN ('PRESERVING', 'FAILED', 'CANCELLED')) OR
    (OLD.status = 'PRESERVING' AND NEW.status IN ('COMPLETED', 'FAILED', 'CANCELLED')) OR
    (OLD.status = 'FAILED' AND NEW.status IN ('SUBMITTED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'Invalid archive transfer state transition from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' AND NOT EXISTS (
    SELECT 1
    FROM transfer_manifests
    WHERE institution_id = NEW.institution_id
      AND transfer_id = NEW.id
      AND status = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'Transfer approval requires an approved immutable manifest' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER archive_transfers_state_machine
  BEFORE UPDATE OF status ON archive_transfers
  FOR EACH ROW EXECUTE FUNCTION ici_guard_archive_transfer_transition();

CREATE INDEX matter_state_events_matter_idx
  ON matter_state_events (institution_id, matter_id, occurred_at DESC);
CREATE INDEX expedientes_institution_status_idx
  ON expedientes (institution_id, status);
CREATE INDEX type_versions_type_status_idx
  ON expediente_type_versions (institution_id, expediente_type_id, status, version_number DESC);
CREATE INDEX archive_transfers_status_idx
  ON archive_transfers (institution_id, status, updated_at);

-- The reference runtime role is deliberately distinct from the migration
-- owner. Deployments may use an equivalent role name, but must apply the same
-- grants and safety properties.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ici_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO ici_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ici_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ici_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ici_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ici_app';
  END IF;
END;
$$;
