# Foundation migration deployment

`001_foundation.sql` is executed by the privileged migration role through
`applyFoundationMigrations`; `002_foundation_hardening.sql` upgrades existing
Step 4a databases and is also applied to fresh databases. Later forward-only
migrations, including `010_malware_job_leases.sql`, are applied in
order by the same runner. The runtime
application role must be provisioned
separately and must not own these tables, be a superuser, or have
`BYPASSRLS`. Runtime transactions set the local `app.institution_id` setting
through `setInstitutionContext` before reading or mutating tenant data.

The reference Docker Compose environment creates the database as
`ici_migrator` and creates a separate `ici_app` login during initialization.
The hardening migration grants `ici_app` runtime table/sequence privileges.
Production deployments may use different names, but must keep the ownership
and privilege split and should verify it with `assertApplicationRoleIsRlsSafe`.

The migration enables and forces Row-Level Security on every tenant-owned
table. Composite `(institution_id, id)` foreign keys prevent a child row from
crossing tenants even if an attacker knows another tenant's UUID.
