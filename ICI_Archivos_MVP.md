# ICI Archivos — MVP Technical Scope

**Status:** Draft MVP specification  
**Date:** 2026-09-07  
**Working name:** ICI Archivos  
**Primary objective:** Deliver a usable end-to-end government records workflow without rebuilding archival preservation and archival-description capabilities that already exist in mature open-source systems.

---

## 1. Product thesis

ICI Archivos should **not** be a replacement for AtoM or Archivematica.

The MVP should combine three layers:

1. **ICI Archivos** — operational records management, *control de gestión*, configurable expediente lifecycle, permissions, auditability, and integrations.
2. **AtoM (Access to Memory)** — standards-based archival description, archival hierarchy, long-term access/search, and archival publication.
3. **Archivematica** — digital-preservation workflow, normalization, fixity, AIP generation/storage, and DIP generation.

The custom application owns the government/business process.  
AtoM owns archival description and access.  
Archivematica owns preservation processing.

This separation is the central architectural decision for the MVP.


### Recommended implementation baseline

```text
React + Vite + MUI
        │
        ▼
Fastify + TypeBox
        │
        ├──────── PostgreSQL + JSONB
        ├──────── S3/MinIO
        └──────── outbox → BullMQ/Redis → worker
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                        AtoM                 Archivematica
```

ICI-owned application code is TypeScript. The application remains a **modular monolith plus worker**. AtoM and Archivematica remain external products integrated through explicit adapters.

---

## 2. MVP goal

Demonstrate one complete vertical workflow:

> **Oficialía de partes → registro → gestión/turnado → documentos → expediente → cierre → transferencia archivística → preservación digital → consulta archivística**

A successful MVP proves that ICI Archivos can coordinate the full lifecycle while delegating specialized preservation and archival-description tasks to existing open-source infrastructure.

---

## 3. MVP scope

### 3.1 Oficialía de partes

The system must allow an authorized user to register an incoming matter.

Minimum fields:

- Folio
- Fecha/hora de recepción
- Tipo de recepción
- Remitente
- Destinatario / unidad administrativa
- Asunto
- Descripción
- Clasificación inicial
- Prioridad
- Fecha límite, when applicable
- One or more attached digital documents
- Optional reference to physical originals

The application generates an immutable internal identifier independent from human-facing folio numbering.

### 3.2 Control de gestión

An incoming matter can be:

- assigned to a unit or responsible person;
- re-assigned;
- annotated;
- responded to;
- associated with additional documents;
- marked pending;
- marked completed;
- linked to related matters;
- converted or incorporated into an expediente.

The system records a complete event history.

### 3.3 Expedientes

An expediente is a first-class object in ICI Archivos.

The MVP must support configurable expediente types rather than a single hard-coded schema.

Each expediente type defines:

- required metadata;
- optional metadata;
- document categories;
- validation rules;
- retention/classification metadata;
- archival destination metadata;
- allowed lifecycle states.

Example states:

`BORRADOR → ABIERTO → EN_TRÁMITE → CERRADO → TRANSFERIBLE → TRANSFERIDO`

Expediente metadata should be stored using a flexible document-oriented structure.

### 3.4 Documents

Every document has:

- UUID
- original filename
- MIME type
- size
- cryptographic checksum
- upload timestamp
- uploader
- source
- document category
- version
- expediente association
- access classification
- preservation status
- optional signature metadata

The MVP must never treat the filename as the document identity.

### 3.5 Audit trail

All significant actions must produce append-only audit events:

- creation;
- edit;
- assignment;
- re-assignment;
- document upload;
- document replacement/version creation;
- expediente closure;
- archival transfer;
- Archivematica submission;
- preservation result;
- AtoM publication/registration;
- permission changes.

Audit records should include:

- actor
- timestamp
- event type
- affected object
- previous state when relevant
- new state when relevant
- request/correlation ID
- client metadata as appropriate

The MVP does not require blockchain or external notarization.

---

## 4. Recommended architecture

```text
                         ┌──────────────────────┐
                         │   ICI Archivos UI    │
                         │  Web application     │
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │   ICI Archivos API   │
                         │ workflow + domain    │
                         └──────┬─────┬─────┬───┘
                                │     │     │
              ┌─────────────────┘     │     └──────────────────┐
              │                       │                        │
     ┌────────▼────────┐     ┌────────▼────────┐      ┌────────▼──────────┐
     │ Operational DB │     │ Object Storage  │      │ Integration Jobs  │
     │ + JSON metadata│     │ original files  │      │ / Outbox / Queue  │
     └─────────────────┘     └─────────────────┘      └───────┬───────────┘
                                                               │
                                          ┌────────────────────┴──────────────┐
                                          │                                   │
                                ┌─────────▼─────────┐              ┌──────────▼─────────┐
                                │  Archivematica   │              │       AtoM         │
                                │ preservation     │─────────────▶│ archival access    │
                                │ AIP / DIP        │  DIP upload  │ description/search│
                                └───────────────────┘              └────────────────────┘
```

---

## 5. Recommended implementation stack

The custom ICI Archivos layer should deliberately use a conventional, low-friction stack. AtoM and Archivematica already introduce substantial operational complexity; the application code owned by ICI should therefore optimize for maintainability, explicit contracts, and easy institutional deployment rather than novelty.

### 5.1 Stack baseline

| Layer | Recommended technology | Rationale |
|---|---|---|
| Language | **TypeScript** | Shared types and tooling across UI, API, worker, and integration adapters |
| Frontend | **React + Vite** | Conventional SPA; no SSR requirement |
| UI components | **MUI** | Strong forms, tables, dialogs, accessibility primitives, and admin UI coverage |
| Client data | **TanStack Query** | Explicit server-state caching and mutation handling |
| Routing | **React Router** | Simple operational application routing |
| API | **Node.js + Fastify** | Small, explicit HTTP layer with strong schema support and low framework overhead |
| Validation/contracts | **TypeBox + JSON Schema/OpenAPI** | Runtime validation plus static TypeScript types and machine-readable contracts |
| Database | **PostgreSQL + JSONB** | Relational workflow integrity with flexible expediente metadata |
| SQL access | **Kysely** or narrowly scoped `pg` repositories | Keeps SQL visible and permits advanced PostgreSQL features |
| Object storage | **S3-compatible storage**; MinIO locally | Portable document storage boundary |
| Background jobs | **BullMQ + Redis** | Retries, delayed jobs, concurrency, and integration recovery |
| Archival description | **AtoM** | Archival hierarchy, description, access, and publication |
| Preservation | **Archivematica + Storage Service** | Transfer/ingest workflow, normalization, AIP/DIP generation and storage |
| Authentication | **OIDC/OAuth2 adapter**; local authentication only for MVP development | Keeps institutional identity replaceable |
| Reverse proxy | **Caddy or nginx** | TLS termination and service routing |
| Deployment | **Docker Compose** initially | Reproducible MVP deployment without premature orchestration |
| Unit/integration tests | **Vitest + Testcontainers** | Fast TypeScript tests with real PostgreSQL/Redis dependencies where needed |
| Browser tests | **Playwright** | End-to-end workflow verification |
| Monorepo | **pnpm workspaces** | Shared packages without introducing Nx/Turborepo prematurely |

### 5.2 Why TypeScript end-to-end

Use TypeScript for all code owned by ICI Archivos. This gives the project one primary implementation language while AtoM and Archivematica remain external products behind adapters. Shared packages should contain only stable cross-application concepts, not arbitrary internals.

### 5.3 Fastify rather than NestJS

Use **Fastify** for the MVP. ICI Archivos is primarily a domain-heavy transactional application with several external integrations; it does not require framework-level dependency injection to prove the MVP. Keep domain code independent from Fastify request objects.

### 5.4 React SPA rather than Next.js

Use **React + Vite + React Router + TanStack Query + MUI**. Do **not** use Next.js for the MVP: there is no meaningful SEO or SSR requirement, and a conventional SPA preserves a clean `browser → ICI API → services` boundary.

### 5.5 PostgreSQL rather than MongoDB

Although expediente metadata is flexible, the system as a whole is strongly transactional and relational. Use PostgreSQL relational columns for universal workflow data and JSONB for configurable expediente metadata. Promote only genuinely universal domain concepts to columns.

Representative table:

```text
expedientes
------------
id                 UUID
organization_id    UUID
type_id             UUID
folio               TEXT
status              TEXT
metadata            JSONB
opened_at           TIMESTAMPTZ
closed_at           TIMESTAMPTZ
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
```

This preserves transactions, constraints, indexes, and auditability without operating MongoDB solely for schemaless fields.

### 5.6 SQL access: prefer visible SQL

Use **Kysely** as the default query layer, or `pg` with a small repository abstraction. Avoid making a heavyweight ORM architectural. The project is likely to benefit from JSONB operators, GIN and partial indexes, CTEs, explicit transactions, row locking, full-text search, and possibly row-level security.

### 5.7 Object storage

Document bytes must not live inside PostgreSQL. Define a `DocumentStoragePort` and start with an S3-compatible adapter. Use **MinIO** in development and point the same boundary at approved institutional object storage later.

### 5.8 Background jobs

Use **BullMQ + Redis** initially for AtoM/Archivematica integration, checksums, transfer manifests, retries, and reconciliation. Durable business intent must remain in PostgreSQL via an outbox/integration-jobs table. Do not introduce Kafka or RabbitMQ merely for the MVP.

### 5.9 Authentication

Keep authentication behind an identity adapter. Local accounts are acceptable for development; institutional deployment should prefer **OIDC/OAuth2**. Authorization remains an ICI API/domain responsibility.

### 5.10 Testing

- **Vitest** for domain and mapping tests.
- **Testcontainers** for PostgreSQL/Redis-backed integration behavior.
- **Playwright** for the end-to-end acceptance scenario.
- Dedicated AtoM/Archivematica test instances for integration contracts rather than permanent mocks.

### 5.11 Deployment doctrine

Start with **Docker Compose**, not Kubernetes. The initial service boundary is:

```text
reverse-proxy
ici-web
ici-api
ici-worker
postgres
redis
minio
atom
archivematica
archivematica-storage-service
```

### 5.12 Architecture style: modular monolith + worker

Do **not** decompose the ICI-owned application into microservices at the start. AtoM and Archivematica already create distributed-system boundaries; adding internally distributed services before the domain stabilizes mostly adds network failure modes and distributed transaction problems. Split modules only when an actual scaling, deployment, security, or ownership requirement appears.

### 5.13 Explicit stack non-goals

For the MVP, avoid adding **Next.js, NestJS, MongoDB, Prisma as a mandatory persistence abstraction, Kafka, RabbitMQ, Elasticsearch/OpenSearch, Kubernetes, GraphQL, event sourcing, CQRS infrastructure, bespoke identity infrastructure, or bespoke archival/preservation engines** unless a concrete requirement later justifies one of them.

---

## 6. AtoM responsibility

AtoM becomes the **archival description and access system**, not the operational workflow database.

ICI Archivos should create and update archival descriptions through the AtoM API where possible.

Current AtoM 2.10 API documentation includes endpoints for:

- browsing information objects;
- creating information objects;
- reading information objects;
- updating information objects;
- deleting information objects;
- downloading associated digital objects;
- adding physical objects.

That is sufficient for the MVP to automate creation of the archival target hierarchy instead of requiring operators to duplicate basic metadata manually.

### Mapping example

ICI expediente:

```json
{
  "folio": "ICI-2026-000142",
  "title": "Convenio de colaboración",
  "classification": "2C.4",
  "openedAt": "2026-09-06",
  "closedAt": "2026-10-18"
}
```

AtoM information object:

```json
{
  "identifier": "ICI-2026-000142",
  "title": "Convenio de colaboración",
  "level_of_description": "File",
  "dates": [...],
  "notes": [...],
  "parent_slug": "series-2c4"
}
```

ICI Archivos stores:

```text
atom_information_object_id
atom_slug
atom_sync_status
atom_last_synced_at
```

AtoM remains authoritative for the archival description after formal transfer unless a later governance decision specifies bidirectional synchronization.

---

## 7. Archivematica responsibility

Archivematica becomes the **preservation engine**.

ICI Archivos submits closed/transferred digital records to Archivematica and monitors the preservation workflow.

Archivematica's current APIs expose transfer/ingest workflow functions and Storage Service operations. The MVP should use these APIs instead of automating the Archivematica web UI.

### Preservation flow

```text
Expediente closed
      ↓
Archival transfer approved
      ↓
Create/confirm corresponding AtoM description
      ↓
Create preservation transfer package
      ↓
Submit transfer to Archivematica
      ↓
Archivematica processing
      ↓
SIP / AIP produced
      ↓
AIP stored
      ↓
DIP produced
      ↓
DIP uploaded to AtoM
      ↓
ICI records resulting IDs/status
```

Archivematica already supports direct DIP upload to AtoM. Its integration expects a target AtoM archival description, which is another reason to create the AtoM information object before the preservation transfer.

### MVP processing policy

Do **not** expose the entire Archivematica decision tree through ICI Archivos.

Configure one institution-approved Archivematica processing configuration for MVP transfers.

ICI Archivos should display:

- queued;
- transferring;
- awaiting intervention;
- ingesting;
- AIP stored;
- DIP uploaded;
- failed.

For failures, expose the Archivematica unit identifier and a diagnostic link/reference for an administrator.

---

## 8. ICI-specific customization layer

The product's value is primarily here.

### 8.1 Configurable expediente types

Example definition:

```json
{
  "code": "CONTRATO",
  "name": "Contrato",
  "fields": [
    {
      "key": "counterparty",
      "label": "Contraparte",
      "type": "string",
      "required": true
    },
    {
      "key": "effectiveDate",
      "label": "Fecha de vigencia",
      "type": "date",
      "required": true
    },
    {
      "key": "amount",
      "label": "Monto",
      "type": "money",
      "required": false
    }
  ]
}
```

The UI renders the form from the definition.

Do not implement arbitrary executable form logic in the MVP.

### 8.2 Classification/retention metadata

Support fields for:

- fondo;
- sección;
- serie;
- subserie;
- classification code;
- documentary values;
- retention periods;
- access restrictions;
- disposition.

The first MVP can treat these as configurable reference data.

Full automated disposition scheduling can follow later.

### 8.3 Organizational model

Minimum hierarchy:

```text
Institution
  └── Administrative unit
        └── Users
```

A record belongs to one institution and has a responsible administrative unit.

---

## 9. Authentication and authorization

MVP roles:

### Administrator

- configuration;
- users;
- organizational units;
- expediente types;
- archival mappings;
- integration administration.

### Oficialía

- register incoming matters;
- attach documents;
- assign initial destination.

### Gestor

- work assigned matters;
- add responses/documents;
- create or associate expedientes.

### Archivista

- validate archival metadata;
- approve transfers;
- initiate/retry preservation actions;
- access preservation status.

### Consulta

- read permitted records.

Authorization must be enforced server-side.

Do not rely on UI visibility as an access-control mechanism.

---

## 10. Search

The MVP should distinguish two search domains.

### Active/administrative records

Search ICI Archivos for:

- folio;
- sender;
- subject;
- expediente;
- metadata fields;
- date ranges;
- responsible unit;
- status.

### Historical/archive records

Use AtoM search or proxy users into the AtoM access interface.

Do not attempt to reproduce all AtoM archival search behavior in the first ICI UI.

A later version can provide federated search.

---

## 11. SAGA interoperability

The MVP should **prepare for SAGA interoperability**, not claim complete compliance before a formal field-by-field requirements matrix exists.

Implement an explicit transformation layer:

```text
ICI domain model
       ↓
Canonical archival DTO
       ↓
AtoM adapter
SAGA adapter
CSV/XML export adapter
```

No SAGA-specific semantics should leak into the core expediente model unless they represent genuine domain concepts.

Deliverable for the MVP:

`docs/saga-mapping.md`

with:

- required SAGA field;
- ICI source field;
- transformation;
- cardinality;
- status;
- unresolved issue.

---

## 12. Electronic signatures

Electronic signatures are part of the intended product but **not required for the first functioning vertical slice**.

The domain model should reserve:

```text
signature_provider
signature_type
signer_identifier
signed_at
certificate_metadata
signature_payload_ref
verification_status
```

Implement a `SignaturePort` now, but use a stub/no-op implementation until SAT-certified advanced electronic signature requirements and legal integration details are fully specified.

Do not invent a proprietary cryptographic signature scheme.

---

## 13. Digital preservation boundary

ICI Archivos is responsible for:

- the operational copy;
- upload checksum;
- version lineage;
- access permissions;
- transfer manifest;
- correlation with Archivematica.

Archivematica is responsible for preservation processing and preservation package generation.

ICI Archivos should store the Archivematica result references, not reproduce its preservation metadata model in the operational database.

---

## 14. Transfer manifest

When an expediente is transferred, ICI Archivos generates an immutable manifest.

Example:

```json
{
  "transferId": "3ce89e5d-...",
  "expedienteId": "f04d...",
  "folio": "ICI-2026-000142",
  "closedAt": "2026-10-18T18:44:21Z",
  "metadataSnapshot": {},
  "documents": [
    {
      "documentId": "d1...",
      "versionId": "v3...",
      "filename": "convenio.pdf",
      "sha256": "...",
      "size": 381992
    }
  ]
}
```

This manifest becomes the boundary between operational management and preservation.

After transfer approval, the snapshot itself is immutable.

---

## 15. Integration reliability

AtoM and Archivematica operations must not execute inside the same synchronous database transaction as user actions.

Use an outbox/job pattern.

Example:

```text
1. User approves transfer.
2. ICI transaction:
   - marks transfer APPROVED
   - writes integration job
   - commits
3. Worker creates/verifies AtoM description.
4. Worker submits Archivematica transfer.
5. Worker polls or receives status.
6. ICI records external identifiers and status.
```

Integration jobs require:

- idempotency key;
- retry count;
- status;
- last error;
- correlation ID;
- next retry time.

This prevents a temporary AtoM/Archivematica outage from corrupting the business workflow.

---

## 16. Minimal API surface

```http
POST   /matters
GET    /matters/:id
PATCH  /matters/:id
POST   /matters/:id/assignments
POST   /matters/:id/documents

POST   /expedientes
GET    /expedientes/:id
PATCH  /expedientes/:id
POST   /expedientes/:id/documents
POST   /expedientes/:id/close

POST   /expedientes/:id/archive-transfers
GET    /archive-transfers/:id
POST   /archive-transfers/:id/approve
POST   /archive-transfers/:id/retry

GET    /search
GET    /audit-events

GET    /admin/expediente-types
POST   /admin/expediente-types
PATCH  /admin/expediente-types/:id
```

---

## 17. MVP screens

Only build screens necessary for the vertical slice.

1. Login
2. Inbox / assigned matters
3. Register incoming matter
4. Matter detail
5. Create/select expediente
6. Expediente detail
7. Document upload/version list
8. Close expediente
9. Archival transfer review
10. Preservation status
11. Search
12. Basic administration

AtoM remains the initial historical/archive browsing interface.

Archivematica remains the deep administrative preservation interface.

ICI can link into both where administrator intervention is required.

---

## 18. Deployment topology

For the MVP, Docker Compose is appropriate.

```text
ici-web
ici-api
ici-worker
postgres
minio
atom
atom dependencies
archivematica
archivematica-storage-service
archivematica dependencies
reverse-proxy
```

Do not force every dependency into one application container.

For a demonstration environment, all services may reside on one sufficiently capable host. Production sizing and security topology should be treated separately.

---

## 19. Security baseline

Required before calling the MVP deployable:

- TLS;
- server-side authorization;
- password hashing or delegated identity provider;
- secure service credentials;
- secrets outside source control;
- cryptographic file hashes;
- immutable audit events at application level;
- database backups;
- object-storage backups/version policy;
- least-privilege service accounts;
- file-size limits;
- MIME validation;
- malware scanning hook;
- rate limiting on authentication and upload endpoints;
- no public Archivematica administrative interface.

A later hardening phase should cover formal threat modeling, retention, key management, and institutional security controls.

---

## 20. Explicit non-goals for MVP

Do not include unless required to complete the vertical slice:

- full SAGA certification/compliance;
- full legal electronic-signature workflow;
- SAT advanced-signature provider integration;
- OCR;
- AI classification;
- automatic retention/disposition execution;
- federated archival search;
- public citizen portal;
- mobile application;
- collaborative document editing;
- custom preservation engine;
- custom archival-description engine;
- replacement for AtoM;
- replacement for Archivematica.

---

## 21. Recommended implementation order

### Phase 0 — Infrastructure

- Docker Compose environment
- PostgreSQL
- object storage
- AtoM
- Archivematica + Storage Service
- confirm native Archivematica → AtoM DIP upload

### Phase 1 — Operational core

- users/roles
- organizational units
- matters
- assignments
- document upload
- audit events

**Exit condition:** oficialía can receive a document and route it.

### Phase 2 — Expedientes

- expediente types
- JSONB dynamic metadata
- create/link expediente
- lifecycle states
- closure
- transfer manifest

**Exit condition:** a real matter can become a closed expediente with documents and metadata.

### Phase 3 — AtoM adapter

- API authentication
- create target archival description
- map ICI metadata
- persist AtoM ID/slug
- retry/idempotency

**Exit condition:** transfer approval creates or resolves the correct AtoM description automatically.

### Phase 4 — Archivematica adapter

- submit transfer
- configured processing profile
- monitor status
- persist AIP/DIP references
- native DIP delivery to AtoM

**Exit condition:** a closed expediente travels from ICI through Archivematica and appears under the expected AtoM description.

### Phase 5 — Demo hardening

- errors/retries
- permission review
- search
- backup/restore test
- audit review
- realistic sample collection

---

## 22. MVP acceptance scenario

The demonstration should use one realistic expediente.

### Scenario

1. An Oficialía user receives an official PDF.
2. ICI creates folio `ICI-2026-000001`.
3. The matter is assigned to Unidad Jurídica.
4. A Gestor opens expediente `JUR-2026-000001`.
5. Additional documents are uploaded during processing.
6. Every important action appears in the audit history.
7. The Gestor closes the expediente.
8. An Archivista reviews and approves archival transfer.
9. ICI freezes the metadata/document manifest.
10. ICI creates or resolves the target AtoM archival description.
11. ICI submits the transfer to Archivematica.
12. Archivematica processes and stores the AIP.
13. Archivematica generates/uploads the DIP to AtoM.
14. ICI displays the completed preservation state and external identifiers.
15. The archivist opens the resulting record in AtoM and can access the archival description/digital object according to permissions.

If this scenario works reliably, the architectural MVP is successful.

---

## 23. Repository structure

```text
ici-archivos/
├── apps/
│   ├── web/
│   ├── api/
│   └── worker/
├── packages/
│   ├── domain/
│   ├── contracts/
│   ├── config/
│   └── integrations/
│       ├── atom/
│       ├── archivematica/
│       ├── storage/
│       └── signatures/
├── infra/
│   ├── docker/
│   └── compose/
├── docs/
│   ├── architecture.md
│   ├── atom-mapping.md
│   ├── saga-mapping.md
│   ├── preservation-flow.md
│   └── security.md
└── README.md
```

---

## 24. Architectural rules

1. **Do not fork AtoM or Archivematica unless an integration requirement cannot be satisfied through configuration, API, plugin, or a narrowly maintained patch.**
2. **ICI Archivos is the system of record for active administrative workflow.**
3. **AtoM is the system of record for archival description after formal transfer.**
4. **Archivematica is the preservation processor and preservation-package authority.**
5. **Every external integration is behind an adapter.**
6. **Every cross-system operation is idempotent and retryable.**
7. **Every transferred expediente has an immutable manifest.**
8. **Dynamic expediente metadata uses versioned definitions.**
9. **Authorization is enforced in the API.**
10. **The MVP ends at a working vertical slice, not at feature completeness.**

---

## 25. Codex-assisted implementation

### 25.1 Recommended model

As of **2026-09-07**, use **GPT-6 Astra with High reasoning** in Codex when it is available to the account. This project is a particularly good fit because it spans a multi-package TypeScript repository, database migrations, Docker services, AtoM and Archivematica APIs, idempotent background workflows, and repository-wide verification.

Astra is still rolling out to Plus accounts. If it is not selectable, use **GPT-5.6 Sol with High reasoning**. Sol is a strong fallback and is sufficient for the full MVP.

Practical allocation:

| Work | Model |
|---|---|
| Repository/scaffold | **GPT-6 Astra / High** |
| Domain model and state transitions | **GPT-6 Astra / High** |
| PostgreSQL schema/migrations | **GPT-6 Astra / High** |
| AtoM adapter | **GPT-6 Astra / High** |
| Archivematica adapter | **GPT-6 Astra / High** |
| Cross-system debugging | **GPT-6 Astra / High** |
| Authorization/security-sensitive changes | **GPT-6 Astra / High**, then human review |
| Straightforward CRUD/UI | **GPT-5.6 Sol / Medium or High** |
| Small tests/refactors | **GPT-5.6 Sol / Medium** |
| Astra unavailable | **GPT-5.6 Sol / High** for everything |

Use Astra for repository-wide reasoning rather than spending limited Astra usage on repetitive component work. Current OpenAI guidance requires **Codex CLI 0.153.0 or newer** for Astra.

### 25.2 Codex working doctrine

Do not ask Codex to “build the whole MVP” in one task. Use vertically testable milestones:

```text
1. Scaffold monorepo + local infrastructure
2. Implement domain entities/state transitions
3. Implement PostgreSQL persistence
4. Implement oficialía → matter workflow
5. Implement expediente lifecycle
6. Implement document/object storage
7. Implement immutable transfer manifest
8. Implement integration outbox/worker
9. Implement AtoM adapter
10. Implement Archivematica adapter
11. Wire transfer → AtoM → Archivematica → AtoM
12. Automate acceptance scenario
```

Each milestone should end with typecheck, lint, tests, migration verification where applicable, and one explicit acceptance step. Codex should run these checks rather than merely generate patches.

### 25.3 Repository instructions for Codex

Create a root `AGENTS.md` containing at least these rules:

```md
# ICI Archivos engineering rules

## Architecture
- ICI Archivos is a modular monolith plus background worker.
- AtoM owns archival description/access after formal transfer.
- Archivematica owns preservation processing and AIP/DIP generation.
- External systems must be accessed through adapters.
- Do not add microservices without an explicit requirement.

## Data
- PostgreSQL is authoritative for active administrative workflow.
- Configurable expediente metadata lives in versioned JSONB-backed schemas.
- Document bytes live in object storage, never PostgreSQL.
- Significant state changes require audit events.
- Archival transfer manifests are immutable after approval.

## Integrations
- Cross-system operations must be idempotent and retryable.
- User HTTP transactions must not depend synchronously on AtoM or Archivematica availability.
- Persist integration intent before executing remote work.
- Never automate an external web UI when a supported API exists.

## TypeScript
- Strict TypeScript.
- Avoid `any` unless documented and isolated at an external boundary.
- Validate external input at runtime.
- Keep domain code independent of Fastify, React, BullMQ, and vendor APIs.

## Database
- Prefer explicit SQL/Kysely.
- Migrations are append-only once shared.
- Every schema change requires a migration.
- Use transactions for domain state transitions.

## Tests
- Add or update tests with behavior changes.
- Prefer domain tests for business rules.
- Use real PostgreSQL through Testcontainers for persistence behavior.
- Run typecheck and tests before considering a task complete.

## Scope
- Do not introduce new infrastructure or frameworks without explaining the requirement they satisfy.
- Prefer the smallest implementation that advances the current MVP vertical slice.
```

### 25.4 Initial Codex task

The first Codex task should be approximately:

```text
Read ICI_Archivos_MVP.md and AGENTS.md.

Scaffold the ICI Archivos monorepo using pnpm workspaces with:
- apps/web: React + Vite + TypeScript
- apps/api: Fastify + TypeScript
- apps/worker: TypeScript worker
- packages/domain
- packages/contracts
- packages/database
- packages/integrations
- infra/docker

Add strict shared TypeScript configuration, Vitest, ESLint, and a root
typecheck/test workflow.

Add Docker Compose services for PostgreSQL, Redis and MinIO only.
Do not add AtoM or Archivematica yet.

Implement a health endpoint in the API and a minimal web page that verifies
the API connection. Do not implement business functionality yet.

Run the typechecker and tests and fix failures before finishing.
Document exact local startup commands in README.md.
```

This is intentionally infrastructure-only. The next Codex task should implement the first real vertical domain slice rather than expanding the scaffold.

### 25.5 Model-source note

The model recommendation is time-sensitive. Current OpenAI references as of 2026-09-07:

- GPT-6 Astra: https://openai.com/index/gpt-6-astra/
- ChatGPT Work and Codex: https://help.openai.com/en/articles/20001275/
- GPT-5.6 model family: https://platform.openai.com/docs/models/

---

## 26. First development target

The first meaningful implementation milestone is deliberately smaller than the full MVP:

> **Register one incoming document, route it, create an expediente, attach the document, close the expediente, and produce the immutable archival transfer manifest.**

Only after that works should the AtoM and Archivematica adapters be connected.

This isolates the ICI domain model from integration complexity and provides a stable object to hand to the archival stack.
