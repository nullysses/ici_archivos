# ICI Archivos

Government records workflow coordinating operational records, AtoM archival
description/access, and Archivematica digital preservation.

## Prerequisites

- Node.js 22.12 or newer
- pnpm 11.1.3
- Docker Engine with Docker Compose for local dependencies

## First run

```bash
pnpm install
cp infra/compose/.env.example infra/compose/.env
pnpm infra:up
pnpm dev
```

Open <http://127.0.0.1:5174>. The web application requests `/api/health`, which
Vite proxies to the API at <http://127.0.0.1:3000/health>.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm check` runs lint, typecheck, unit tests, and builds. Integration tests need
a running Docker daemon but do not use the local Compose database.

## Workspace

```text
apps/
  api/       Fastify HTTP adapter
  web/       React operational interface
  worker/    BullMQ integration worker
packages/
  config/    Environment parsing
  contracts/ Runtime TypeBox HTTP contracts
  database/  Kysely/PostgreSQL boundary
  domain/    Framework-independent domain types
  integrations/
infra/
  compose/   ICI local dependencies
  spikes/    External-system feasibility harnesses
docs/
```

The AtoM–Archivematica feasibility harness has its own instructions in
`infra/spikes/archival-integration/README.md` and is deliberately not started by
the normal ICI development environment.

## Assignment authorization decisions

For operational authorization, the effective unit is the latest
`matter_assignments.unit_id` once a matter has been assigned. Before the first
assignment, `matters.destination_unit_id` remains the relevant unit. Matter
reads, inbox visibility, and subsequent workflow authorization should converge
on this rule.

One Step 5 policy decision remains to be clarified before the assignment model
is considered frozen: assigning a specific user currently requires that the
user be active and belong to the same institution, but does not prove an
explicit association with the selected assignment unit. Decide whether a target
user must have explicit membership/authorization in that unit (and which
existing relation is authoritative for that proof), or whether assignment to
any active user in the institution is intentionally permitted.
