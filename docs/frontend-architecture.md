# Frontend UX foundation

The web application uses a task-oriented shell rather than exposing database
aggregates as its primary navigation. The stable top-level areas are:

- Inicio / Mi trabajo
- Asuntos
- Expedientes
- Archivo
- Administración (capability-gated)

Routes are grouped under `/work`, `/matters`, `/expedientes`, `/archive`, and
`/admin`. Workflow pages can be added below these boundaries without changing
the shell. Server state is loaded through TanStack Query and the single API
boundary in `apps/web/src/api.ts`.

Navigation is a presentation aid only. The backend remains authoritative for
authorization. The `/auth/me` response exposes institution and unit-scoped
capabilities so the shell can hide unavailable areas without inferring access
from role labels. Presentation checks are explicit: `canInstitution` is used
for institution-wide actions, `canInUnit` requires the selected unit, and
`canAnywhere` only answers whether a capability exists in either scope; a unit
grant is never promoted to an institution grant.

The health query accepts the API's intentional HTTP 503 degraded response so
the shell can distinguish an available API with a down database from a network
failure.

Shared presentation conventions live in `apps/web/src/ux.tsx`: folios,
lifecycle badges, loading, empty, error, forbidden, not-found, and
confirmation states. Status uses text and a marker, never color alone. MUI
focus-visible styles provide the keyboard focus baseline.

Milestone 13 operational routes live in `apps/web/src/operational.tsx`:
`/matters` is the capability-filtered inbox and `/matters/:matterId` is the
workspace for assignment, notes, linkage, and lifecycle commands. The
`/expedientes` surfaces create/list/detail workspaces and document upload and
immutable-version presentation. Lookup endpoints are deliberately narrow and
tenant-scoped; unit-scoped assignment is filtered to the exact authorized
units. Archive transfer and preservation controls remain outside this UX.
