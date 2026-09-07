# ICI Archivos engineering rules

## Architecture

- ICI Archivos is a modular monolith plus a background worker.
- ICI owns active administrative workflow; AtoM owns archival description and access after transfer; Archivematica owns preservation processing and packages.
- External systems are accessed only through explicit adapters and documented APIs.
- Cross-system work is asynchronous, idempotent, retryable, and backed by durable PostgreSQL intent.
- Do not add internal microservices without an evidenced deployment, scaling, security, or ownership requirement.

## Domain and data

- Follow the accepted foundational ADRs supplied for this project.
- Every tenant-owned aggregate and job carries `institution_id`; API and worker operations establish institution context and PostgreSQL RLS applies.
- UUIDs are identities. Human folios are immutable display identifiers, never foreign keys.
- State changes occur through explicit commands and transition rules; never expose arbitrary status updates.
- Published expediente-type versions, document binaries, approved transfer manifests, and audit events are immutable.
- PostgreSQL stores stable relational workflow data and JSONB stores versioned configurable expediente metadata.
- Document bytes belong in S3-compatible object storage, never PostgreSQL.

## Security

- Enforce capabilities in the API/domain layer; UI visibility is not authorization.
- Production authentication is OIDC. Never add application password verification.
- Never commit credentials. Development-only authentication or default vendor credentials must fail closed outside development.
- Uploaded files remain quarantined until MIME identification and malware scanning succeed.
- Do not log document contents, credentials, tokens, legal-classification reasons, or unnecessary personal data.

## Implementation

- TypeScript is the only implementation language for ICI-owned application code.
- Keep domain code independent of Fastify, React, BullMQ, and vendor payloads.
- Keep SQL visible through Kysely or narrowly scoped `pg` repositories.
- Share only stable contracts across applications.
- Do not add Next.js, NestJS, MongoDB, Prisma, Kafka, RabbitMQ, GraphQL, CQRS infrastructure, event sourcing, Kubernetes, or bespoke archival/preservation engines without a new accepted decision.

## Verification

- Every change must pass `pnpm lint`, `pnpm typecheck`, relevant tests, and `pnpm build`.
- State-transition and authorization changes require positive and negative tests.
- Persistence behavior is tested against real PostgreSQL using Testcontainers.
- The vertical acceptance workflow is tested with Playwright and dedicated vendor test instances.
- Never claim AtoM/Archivematica compatibility without retaining passing spike evidence for the pinned versions.

