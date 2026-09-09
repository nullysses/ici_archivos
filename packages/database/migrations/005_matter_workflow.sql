-- Step 5 operational-matter extensions. Earlier migrations remain unchanged.
ALTER TABLE matters
  ADD COLUMN destination_unit_id uuid,
  ADD COLUMN access_classification_id uuid,
  ADD CONSTRAINT matters_destination_unit_fk
    FOREIGN KEY (institution_id, destination_unit_id)
    REFERENCES organizational_units (institution_id, id),
  ADD CONSTRAINT matters_access_classification_fk
    FOREIGN KEY (institution_id, access_classification_id)
    REFERENCES access_classifications (institution_id, id);

ALTER TABLE documents
  ALTER COLUMN expediente_id DROP NOT NULL,
  ADD COLUMN matter_id uuid,
  ADD CONSTRAINT documents_matter_fk
    FOREIGN KEY (institution_id, matter_id)
    REFERENCES matters (institution_id, id),
  ADD CONSTRAINT documents_exactly_one_parent_check
    CHECK ((expediente_id IS NULL) <> (matter_id IS NULL));
CREATE INDEX documents_matter_idx ON documents (institution_id, matter_id, created_at)
  WHERE matter_id IS NOT NULL;

CREATE TABLE matter_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  matter_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  note_type text NOT NULL DEFAULT 'NOTE' CHECK (note_type IN ('NOTE', 'RESPONSE')),
  content text NOT NULL CHECK (length(trim(content)) > 0 AND length(content) <= 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, matter_id) REFERENCES matters (institution_id, id),
  FOREIGN KEY (institution_id, author_user_id) REFERENCES users (institution_id, id)
);
CREATE INDEX matter_notes_history_idx ON matter_notes (institution_id, matter_id, created_at);
ALTER TABLE matter_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY matter_notes_tenant_isolation ON matter_notes
  USING (institution_id = ici_current_institution_id())
  WITH CHECK (institution_id = ici_current_institution_id());
CREATE TRIGGER matter_notes_append_only
  BEFORE UPDATE OR DELETE ON matter_notes
  FOR EACH ROW EXECUTE FUNCTION ici_reject_append_only_mutation();

-- Matter-owned versions are permitted while the matter remains operational;
-- expediente-owned versions retain the frozen Step 4 open-expediente rule.
CREATE OR REPLACE FUNCTION ici_guard_new_document_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_expediente_status text;
DECLARE parent_matter_status text;
DECLARE latest_version integer;
BEGIN
  SELECT e.status INTO parent_expediente_status
  FROM documents d JOIN expedientes e ON e.institution_id=d.institution_id AND e.id=d.expediente_id
  WHERE d.institution_id=NEW.institution_id AND d.id=NEW.document_id;
  SELECT m.status INTO parent_matter_status
  FROM documents d JOIN matters m ON m.institution_id=d.institution_id AND m.id=d.matter_id
  WHERE d.institution_id=NEW.institution_id AND d.id=NEW.document_id;
  IF parent_expediente_status IS NULL AND parent_matter_status IS NULL THEN
    RAISE EXCEPTION 'Logical document does not exist in this institution' USING ERRCODE='23503';
  END IF;
  IF parent_expediente_status IS NOT NULL AND parent_expediente_status <> 'OPEN' THEN
    RAISE EXCEPTION 'Document versions may only be created while the expediente is open' USING ERRCODE='23514';
  END IF;
  IF parent_matter_status IN ('CLOSED', 'VOIDED') THEN
    RAISE EXCEPTION 'Document versions may not be created for terminal matters' USING ERRCODE='23514';
  END IF;
  IF NEW.malware_scan_status <> 'PENDING_SCAN' THEN RAISE EXCEPTION 'A new document version must begin pending malware scan' USING ERRCODE='23514'; END IF;
  SELECT coalesce(max(version_number),0) INTO latest_version FROM document_versions WHERE institution_id=NEW.institution_id AND document_id=NEW.document_id;
  IF NEW.version_number <> latest_version+1 THEN RAISE EXCEPTION 'Document version number must be the next sequential value' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
