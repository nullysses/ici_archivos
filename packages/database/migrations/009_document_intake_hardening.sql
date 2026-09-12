-- Forward-only document-intake hardening. Earlier migrations remain immutable.

-- A storage key identifies one immutable object within an institution. Hashes
-- deliberately remain non-unique: duplicate bytes may be distinct records.
ALTER TABLE public.document_versions
  ADD CONSTRAINT document_versions_institution_storage_key_unique
  UNIQUE (institution_id, storage_key);

-- Malware scan attempts are historical evidence and must never be rewritten.
DROP TRIGGER IF EXISTS malware_scans_append_only ON public.malware_scans;
CREATE TRIGGER malware_scans_append_only
  BEFORE UPDATE OR DELETE ON public.malware_scans
  FOR EACH ROW EXECUTE FUNCTION public.ici_reject_append_only_mutation();

-- Database-level malware state machine. New versions are still constrained to
-- PENDING_SCAN by the existing document-version creation guard.
CREATE OR REPLACE FUNCTION public.ici_guard_malware_scan_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.malware_scan_status IS DISTINCT FROM OLD.malware_scan_status THEN
    IF NOT (
      (OLD.malware_scan_status = 'PENDING_SCAN' AND NEW.malware_scan_status IN ('CLEAN', 'INFECTED', 'SCAN_FAILED')) OR
      (OLD.malware_scan_status = 'SCAN_FAILED' AND NEW.malware_scan_status = 'PENDING_SCAN') OR
      (OLD.malware_scan_status = 'INFECTED' AND NEW.malware_scan_status = 'QUARANTINED')
    ) THEN
      RAISE EXCEPTION 'Invalid malware scan transition from % to %', OLD.malware_scan_status, NEW.malware_scan_status USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS document_versions_malware_scan_guard ON public.document_versions;
CREATE TRIGGER document_versions_malware_scan_guard
  BEFORE UPDATE OF malware_scan_status ON public.document_versions
  FOR EACH ROW EXECUTE FUNCTION public.ici_guard_malware_scan_transition();

-- Restore the database defense-in-depth lock that serializes direct SQL
-- version creation. The logical document row is locked before MAX() is read.
CREATE OR REPLACE FUNCTION public.ici_guard_new_document_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_expediente_id uuid;
  parent_matter_id uuid;
  parent_expediente_status text;
  parent_matter_status text;
  latest_version integer;
BEGIN
  SELECT d.expediente_id, d.matter_id
    INTO parent_expediente_id, parent_matter_id
  FROM public.documents AS d
  WHERE d.institution_id = NEW.institution_id
    AND d.id = NEW.document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Logical document does not exist in this institution' USING ERRCODE = '23503';
  END IF;
  IF (parent_expediente_id IS NULL) = (parent_matter_id IS NULL) THEN
    RAISE EXCEPTION 'A logical document must have exactly one parent' USING ERRCODE = '23514';
  END IF;

  IF parent_expediente_id IS NOT NULL THEN
    SELECT e.status INTO parent_expediente_status
    FROM public.expedientes AS e
    WHERE e.institution_id = NEW.institution_id
      AND e.id = parent_expediente_id;
    IF parent_expediente_status IS DISTINCT FROM 'OPEN' THEN
      RAISE EXCEPTION 'Document versions may only be created while the expediente is open' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT m.status INTO parent_matter_status
    FROM public.matters AS m
    WHERE m.institution_id = NEW.institution_id
      AND m.id = parent_matter_id;
    IF parent_matter_status IS NULL OR parent_matter_status IN ('CLOSED', 'VOIDED') THEN
      RAISE EXCEPTION 'Document versions may not be created for terminal matters' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.malware_scan_status <> 'PENDING_SCAN' THEN
    RAISE EXCEPTION 'A new document version must begin pending malware scan' USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(max(v.version_number), 0)
    INTO latest_version
  FROM public.document_versions AS v
  WHERE v.institution_id = NEW.institution_id
    AND v.document_id = NEW.document_id;
  IF NEW.version_number <> latest_version + 1 THEN
    RAISE EXCEPTION 'Document version number must be the next sequential value' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

