-- Forward-only correction for matter-owned documents introduced in 005.
CREATE OR REPLACE FUNCTION ici_guard_current_document_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE expediente_status text;
DECLARE matter_status text;
BEGIN
  IF NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id THEN RETURN NEW; END IF;
  IF (NEW.expediente_id IS NULL) = (NEW.matter_id IS NULL) THEN
    RAISE EXCEPTION 'A logical document must have exactly one parent' USING ERRCODE='23514';
  END IF;
  IF NEW.expediente_id IS NOT NULL THEN
    SELECT status INTO expediente_status FROM expedientes WHERE institution_id=NEW.institution_id AND id=NEW.expediente_id;
    IF expediente_status IS DISTINCT FROM 'OPEN' THEN RAISE EXCEPTION 'Current document version is frozen while the expediente is not open' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT status INTO matter_status FROM matters WHERE institution_id=NEW.institution_id AND id=NEW.matter_id;
    IF matter_status IS NULL OR matter_status IN ('CLOSED', 'VOIDED') THEN RAISE EXCEPTION 'Current document version is frozen while the matter is terminal' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$;
