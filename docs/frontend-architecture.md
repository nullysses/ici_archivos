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
from role labels.

Shared presentation conventions live in `apps/web/src/ux.tsx`: folios,
lifecycle badges, loading, empty, error, forbidden, not-found, and
confirmation states. Status uses text and a marker, never color alone. MUI
focus-visible styles provide the keyboard focus baseline.
