# ICI Archivos

Government records workflow coordinating operational records, AtoM archival
description/access, and Archivematica digital preservation.

## Architecture

![ICI Archivos architecture map](architecture_map.png)

## Status

**Step 5 — Matter workflow and document pipeline: complete and frozen.**

The implemented path covers matter registration, assignment, workflow transitions,
document intake and versioning, quarantine, durable malware scanning, CLEAN
promotion and protected download. The local development stack includes PostgreSQL,
MinIO and private-network ClamAV with the worker and migration jobs running in
Docker Compose. Full register-to-resolve integration coverage is in place.

Next: **Step 6 — Expedientes and archival transfer.**

![ICI Archivos implementation status — Step 5 complete](docs/status/ici-archivos-status-step-5-complete.jpg)

## Prerequisites

- Node.js 22.12 or newer
- pnpm 11.1.3
- Docker Engine with Docker Compose for local dependencies

Development is supported on WSL2/Linux. Native Windows shells are not a supported
development environment.

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

The Compose stack also runs the pinned database migration job, a worker, a
pinned ClamAV daemon on the private Compose network, and an idempotent MinIO
bootstrap job. The bootstrap creates the private
`S3_QUARANTINE_BUCKET`/`S3_CLEAN_BUCKET` buckets and a restricted application
user; it never publishes clamd's TCP port. `pnpm dev` starts only the host API
and web processes; it loads `infra/compose/.env` so the API can use MinIO at
`http://127.0.0.1:9000`. The malware worker remains in Compose, where
`CLAMAV_HOST=clamav` and `S3_ENDPOINT=http://minio:9000` are reachable.

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

A policy decision is intentionally deferred before Step 6: assigning a specific
user currently requires that the user be active and belong to the same
institution, but does not prove an explicit association with the selected
assignment unit. Decide whether a target user must have explicit
membership/authorization in that unit (and which existing relation is
authoritative for that proof), or whether assignment to any active user in the
institution is intentionally permitted. This does not reopen the completed Step
5 implementation tranche.
