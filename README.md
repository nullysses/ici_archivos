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
