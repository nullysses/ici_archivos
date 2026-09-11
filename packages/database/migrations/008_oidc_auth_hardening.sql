-- Harden the pre-RLS identity bootstrap lookup. This function is deliberately
-- narrow and read-only: it discovers tenant identity before a tenant context
-- exists, then normal application code enters an RLS-scoped transaction.
DROP FUNCTION IF EXISTS public.ici_resolve_external_identity(text, text);

CREATE OR REPLACE FUNCTION public.ici_resolve_external_identity(input_issuer text, input_subject text)
RETURNS TABLE(institution_id uuid, institution_status text, user_id uuid, user_status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT identity.institution_id,
         institution.status,
         identity.user_id,
         account.status
  FROM public.external_identities AS identity
  JOIN public.institutions AS institution
    ON institution.id = identity.institution_id
  JOIN public.users AS account
    ON account.institution_id = identity.institution_id
   AND account.id = identity.user_id
  WHERE identity.issuer = input_issuer
    AND identity.subject = input_subject
$$;

REVOKE ALL ON FUNCTION public.ici_resolve_external_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ici_resolve_external_identity(text, text) TO ici_app;
