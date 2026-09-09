-- Forward-only Step 4b review fixes. Migration 003 is retained because it may
-- already have been applied outside a disposable development database.

-- Migration 001 already provides the same transfer lookup path under
-- transfers_expediente_idx, so remove the duplicate name created by 003.
DROP INDEX IF EXISTS archive_transfers_expediente_idx;

-- The 003 index reused the name of the two-column 001 index and was therefore
-- skipped. Use a distinct name for ordered expediente document reads.
CREATE INDEX IF NOT EXISTS documents_expediente_created_idx
  ON documents (institution_id, expediente_id, created_at);

-- Integration jobs are durable intent. The application role must not be able
-- to erase pending or historical intent directly.
CREATE OR REPLACE FUNCTION ici_guard_integration_job_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Integration jobs are durable and cannot be deleted' USING ERRCODE = '55006';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Integration jobs begin PENDING' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('RUNNING', 'CANCELLED')) OR
    (OLD.status = 'RUNNING' AND NEW.status IN ('SUCCEEDED', 'FAILED')) OR
    (OLD.status = 'FAILED' AND NEW.status IN ('PENDING', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'Invalid integration job transition from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('SUCCEEDED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Completed or cancelled integration jobs are immutable' USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER integration_jobs_state_machine ON integration_jobs;
CREATE TRIGGER integration_jobs_state_machine
  BEFORE INSERT OR UPDATE OR DELETE ON integration_jobs
  FOR EACH ROW EXECUTE FUNCTION ici_guard_integration_job_transition();
