-- Step 4b lookup paths and durable-job limits.  These are deliberately
-- operational indexes, not speculative search indexes.
CREATE INDEX IF NOT EXISTS user_role_assignments_effective_idx
  ON user_role_assignments (institution_id, user_id, effective_from, effective_until);
CREATE INDEX IF NOT EXISTS external_identities_user_idx ON external_identities (institution_id, user_id);
CREATE INDEX IF NOT EXISTS expediente_state_events_expediente_idx
  ON expediente_state_events (institution_id, expediente_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS documents_expediente_idx ON documents (institution_id, expediente_id, created_at);
CREATE INDEX IF NOT EXISTS document_versions_document_idx
  ON document_versions (institution_id, document_id, version_number DESC);
CREATE INDEX IF NOT EXISTS archive_transfers_expediente_idx
  ON archive_transfers (institution_id, expediente_id, created_at DESC);
CREATE INDEX IF NOT EXISTS archival_corrections_transfer_idx
  ON archival_corrections (institution_id, transfer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx
  ON audit_events (institution_id, actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_correlation_idx
  ON audit_events (institution_id, correlation_id, occurred_at DESC);

ALTER TABLE integration_jobs
  ADD CONSTRAINT integration_jobs_last_error_size_check
  CHECK (last_error IS NULL OR length(last_error) <= 4000);

CREATE OR REPLACE FUNCTION ici_guard_integration_job_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER integration_jobs_state_machine
  BEFORE INSERT OR UPDATE ON integration_jobs
  FOR EACH ROW EXECUTE FUNCTION ici_guard_integration_job_transition();
