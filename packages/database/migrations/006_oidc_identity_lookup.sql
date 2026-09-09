-- Controlled bootstrap lookup for OIDC identity: normal application sessions
-- still receive tenant-scoped data only after this function establishes scope.
CREATE OR REPLACE FUNCTION ici_resolve_external_identity(input_issuer text, input_subject text)
RETURNS TABLE(institution_id uuid, user_id uuid, user_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT identity.institution_id, identity.user_id, account.status
  FROM external_identities identity
  JOIN users account ON account.institution_id = identity.institution_id AND account.id = identity.user_id
  WHERE identity.issuer = input_issuer AND identity.subject = input_subject
$$;
REVOKE ALL ON FUNCTION ici_resolve_external_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ici_resolve_external_identity(text, text) TO ici_app;
