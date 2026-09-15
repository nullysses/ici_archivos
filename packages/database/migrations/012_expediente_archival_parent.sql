-- Establishes the authoritative archival parent for an expediente.
-- The parent remains editable while the expediente is OPEN or CLOSED and is
-- frozen once transfer preparation moves it to TRANSFER_PENDING.
ALTER TABLE expedientes
  ADD COLUMN IF NOT EXISTS archival_parent_node_id uuid;

DO $$
BEGIN
  ALTER TABLE expedientes
    ADD CONSTRAINT expedientes_archival_parent_fk
    FOREIGN KEY (institution_id, archival_parent_node_id)
    REFERENCES archival_classification_nodes (institution_id, id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;

CREATE INDEX IF NOT EXISTS expedientes_archival_parent_idx
  ON expedientes (institution_id, archival_parent_node_id);

CREATE OR REPLACE FUNCTION public.ici_guard_expediente_archival_parent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_type text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.archival_parent_node_id IS DISTINCT FROM OLD.archival_parent_node_id
     AND OLD.status NOT IN ('OPEN', 'CLOSED') THEN
    RAISE EXCEPTION 'An expediente archival parent cannot change after transfer preparation' USING ERRCODE = '23514';
  END IF;

  IF NEW.archival_parent_node_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT node_type INTO parent_type
  FROM public.archival_classification_nodes
  WHERE institution_id = NEW.institution_id
    AND id = NEW.archival_parent_node_id;

  IF parent_type IS NULL OR parent_type NOT IN ('SERIES', 'SUBSERIES') THEN
    RAISE EXCEPTION 'An expediente archival parent must be a SERIES or SUBSERIES in the same institution' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expedientes_archival_parent_guard ON expedientes;
CREATE TRIGGER expedientes_archival_parent_guard
  BEFORE INSERT OR UPDATE OF archival_parent_node_id ON expedientes
  FOR EACH ROW
  EXECUTE FUNCTION public.ici_guard_expediente_archival_parent();
