-- AH-1: an expediente may close only when every retained document version is
-- clean. Retained documents are expediente-owned documents and documents whose
-- matter is linked to this expediente; current and historical versions are
-- included in the check.
CREATE OR REPLACE FUNCTION public.ici_guard_expediente_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
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
      SELECT 1
      FROM public.matters
      WHERE institution_id = NEW.institution_id
        AND linked_expediente_id = NEW.id
        AND status NOT IN ('CLOSED', 'VOIDED')
    ) THEN
      RAISE EXCEPTION 'All linked matters must be closed or voided' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.documents AS documents
      LEFT JOIN public.matters AS matters
        ON matters.institution_id = documents.institution_id
       AND matters.id = documents.matter_id
      LEFT JOIN public.document_versions AS versions
        ON versions.institution_id = documents.institution_id
       AND versions.document_id = documents.id
      WHERE documents.institution_id = NEW.institution_id
        AND (
          documents.expediente_id = NEW.id
          OR (documents.matter_id IS NOT NULL AND matters.linked_expediente_id = NEW.id)
        )
        AND (versions.id IS NULL OR versions.malware_scan_status <> 'CLEAN')
    ) THEN
      RAISE EXCEPTION 'All retained document versions must have a clean malware scan' USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := coalesce(NEW.closed_at, now());
  END IF;
  IF OLD.status = 'CLOSED' AND NEW.status = 'OPEN' THEN
    IF EXISTS (
      SELECT 1
      FROM public.archive_transfers
      WHERE institution_id = NEW.institution_id
        AND expediente_id = NEW.id
        AND status IN ('APPROVED', 'SUBMITTED', 'PRESERVING', 'COMPLETED', 'FAILED')
    ) THEN
      RAISE EXCEPTION 'An expediente cannot reopen after transfer approval' USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := NULL;
  END IF;
  IF OLD.status = 'TRANSFER_PENDING' AND NEW.status = 'TRANSFERRED' AND NOT EXISTS (
    SELECT 1
    FROM public.archive_transfers
    WHERE institution_id = NEW.institution_id
      AND expediente_id = NEW.id
      AND status = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'A completed archival transfer is required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
