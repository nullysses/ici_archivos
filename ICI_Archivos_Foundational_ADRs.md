# ICI Archivos — Foundational Architecture Decision Records

**Status:** Accepted for MVP implementation  
**Date:** 2026-09-07  
**Scope:** Decisions that must be fixed before the initial database and domain model are implemented.

These ADRs are intentionally conservative. They define the stable domain boundaries for the MVP while leaving institution-specific policy values configurable.

---

# ADR-001 — Supported AtoM / Archivematica versions

**Status:** Accepted

## Decision

The first certified ICI Archivos integration target is:

| Component | Supported MVP version |
|---|---:|
| AtoM | **2.10.2** |
| Archivematica | **1.18.0** |
| Archivematica Storage Service | **0.24.0** |

ICI Archivos will pin exact deployment versions. Docker images, packages, and integration tests must not use floating `latest` tags.

The MVP compatibility matrix contains one supported combination:

| AtoM | Archivematica | Storage Service | ICI status |
|---|---|---|---|
| 2.10.2 | 1.18.0 | 0.24.0 | **Certified MVP target** |
| Any other combination | Any other combination | Any other combination | **Unsupported until integration-tested** |

Archivematica 1.18 documentation states that it has been tested with and recommends the latest AtoM, and that AtoM 2.2+ is required for hierarchical DIP functionality. As of 2026-09-07, AtoM 2.10.2 is the current stable AtoM release and Archivematica 1.18.0 / Storage Service 0.24.0 are the current stable Archivematica releases.

Required integration features:

- AtoM REST API enabled.
- AtoM SWORD plugin enabled for Archivematica DIP upload.
- Archivematica API enabled and authenticated.
- Archivematica Storage Service API enabled and authenticated.
- Hierarchical DIP integration smoke-tested.

## Upgrade rule

A version upgrade is not accepted merely because the upstream project calls it compatible.

Before changing any pinned version, CI/staging must pass:

1. create AtoM hierarchy;
2. create/update expediente description;
3. submit test transfer;
4. produce/store AIP;
5. upload hierarchical DIP to AtoM;
6. verify resulting digital objects and hierarchy;
7. retry an intentionally interrupted integration job.

No ICI domain code may depend on undocumented database internals of AtoM or Archivematica.

## Consequence

The adapters target documented APIs rather than vendor database schemas, and version upgrades become explicit compatibility events.

---

# ADR-002 — Institution isolation and tenancy

**Status:** Accepted

## Decision

ICI Archivos is **multi-tenant in the domain and database from day one**, even though the first production deployment may contain only one institution.

Tenancy model:

- one shared PostgreSQL database;
- one shared schema;
- every tenant-owned aggregate carries `institution_id`;
- uniqueness constraints include the institution boundary where appropriate;
- server-side authorization always operates under an institution context;
- PostgreSQL Row-Level Security is enabled for tenant-owned tables.

The application database role must not own the tables and must not bypass RLS. Migrations use a separate privileged role.

A worker job always contains `institution_id`; the worker establishes the same tenant context before reading or mutating tenant data.

Global tables are limited to genuine platform concepts such as:

- permission definitions;
- supported MIME-type catalogue;
- migration metadata.

Institution-specific configuration is always tenant-owned.

## Data-model rule

The following classes of records must contain `institution_id` directly, even when it could theoretically be inferred through joins:

- matters;
- expedientes;
- documents;
- document versions;
- assignments;
- expediente types and versions;
- archival classifications;
- transfers;
- audit events;
- integration jobs;
- users/identity memberships;
- folio counters.

This deliberate denormalization makes tenant boundaries auditable and enforceable.

## Consequence

ICI can begin with one institution without creating a single-tenant schema that later requires invasive migration for deployment in another government or institution.

---

# ADR-003 — Folios, uniqueness, and concurrency

**Status:** Accepted

## Decision

Internal identity and human folio identity are separate.

### Internal identity

Every aggregate uses a UUID primary key.

Human folios are never foreign keys and never determine object identity.

### Initial folio formats

Matter / oficialía:

```text
OP-{YYYY}-{NNNNNN}
```

Example:

```text
OP-2026-000143
```

Expediente:

```text
EXP-{YYYY}-{NNNNNN}
```

Example:

```text
EXP-2026-000081
```

The display format is institution-configurable later, but the initial sequence semantics are fixed.

### Uniqueness boundary

Folios are unique within an institution:

```text
UNIQUE (institution_id, folio)
```

The underlying sequential number is also protected:

```text
UNIQUE (institution_id, folio_kind, folio_year, sequence_number)
```

### Counter storage

Use:

```text
folio_counters
--------------
institution_id
folio_kind
folio_year
next_value
```

with:

```text
PRIMARY KEY (institution_id, folio_kind, folio_year)
```

Allocation is atomic using a PostgreSQL row update / upsert with `RETURNING`.

Never use:

```sql
MAX(folio) + 1
```

### Issuance rules

- A folio is considered issued only when the creating transaction commits.
- A committed folio is immutable.
- A committed folio is never reassigned.
- Gaps are permitted.
- Cancellation/voiding retains the original folio.
- Folio correction means correcting metadata, not renumbering the object.

## Consequence

Concurrent intake cannot generate duplicate folios and business numbering remains independent from stable database identity.

---

# ADR-004 — Matter lifecycle

**Status:** Accepted

## Decision

Matter states are:

```text
RECEIVED
ASSIGNED
IN_PROGRESS
RESOLVED
CLOSED
VOIDED
```

There is no persisted `DRAFT` matter in the MVP. A successful registration transaction creates `RECEIVED`.

## State-transition matrix

| Command | From | To | Preconditions |
|---|---|---|---|
| `registerMatter` | — | `RECEIVED` | Required intake metadata valid; initial files clean or pending scan according to upload transaction |
| `assignMatter` | `RECEIVED` | `ASSIGNED` | Destination unit/user exists and is authorized |
| `reassignMatter` | `ASSIGNED` | `ASSIGNED` | Reason recorded |
| `reassignMatter` | `IN_PROGRESS` | `ASSIGNED` | Reason recorded; new assignee must explicitly start work |
| `startMatter` | `ASSIGNED` | `IN_PROGRESS` | Actor is current assignee or authorized member of assigned unit |
| `resolveMatter` | `IN_PROGRESS` | `RESOLVED` | Resolution metadata recorded |
| `reopenMatter` | `RESOLVED` | `IN_PROGRESS` | Reason recorded; linked expediente is still `OPEN` |
| `closeMatter` | `RESOLVED` | `CLOSED` | Matter is linked to an expediente; closure metadata valid |
| `voidMatter` | `RECEIVED` | `VOIDED` | Reason recorded |
| `voidMatter` | `ASSIGNED` | `VOIDED` | No substantive processing has begun; reason recorded |

`CLOSED` and `VOIDED` are terminal.

If a new issue arises after closure, create a related matter rather than rewriting history.

Assignment changes are first-class audit events even when the matter state remains `ASSIGNED`.

---

# ADR-005 — Expediente lifecycle and transfer lifecycle

**Status:** Accepted

## Decision

Expediente states are:

```text
OPEN
CLOSED
TRANSFER_PENDING
TRANSFERRED
VOIDED
```

An expediente is created directly as `OPEN`. There is no persisted `DRAFT` expediente in the MVP.

## Expediente transition matrix

| Command | From | To | Preconditions |
|---|---|---|---|
| `createExpediente` | — | `OPEN` | Published expediente-type version selected; required creation fields valid |
| `closeExpediente` | `OPEN` | `CLOSED` | Required metadata valid; linked matters are `CLOSED` or `VOIDED`; included document versions passed malware scan |
| `reopenExpediente` | `CLOSED` | `OPEN` | No transfer has been approved; reason recorded |
| `prepareTransfer` | `CLOSED` | `TRANSFER_PENDING` | Archival mapping validates; draft manifest can be generated |
| `rejectTransfer` | `TRANSFER_PENDING` | `CLOSED` | Transfer has not been approved; rejection reason recorded |
| `completeTransfer` | `TRANSFER_PENDING` | `TRANSFERRED` | Approved manifest preserved; AIP stored; required AtoM hierarchy/DIP integration completed |
| `voidExpediente` | `OPEN` | `VOIDED` | Created in error; no closed substantive matter depends on it; reason recorded |

`TRANSFERRED` and `VOIDED` are terminal for the original aggregate.

A post-transfer correction does not move a transferred expediente back to `OPEN`.

## Separate archival-transfer states

`archive_transfer` is a separate aggregate:

```text
DRAFT
APPROVED
SUBMITTED
PRESERVING
COMPLETED
FAILED
CANCELLED
```

Rules:

- `DRAFT` manifest may be regenerated.
- `APPROVED` freezes the manifest.
- `FAILED` may be retried without changing the approved manifest.
- Cancelling is allowed only before irreversible preservation completion.
- A correction after `COMPLETED` creates a supplemental transfer.

## Consequence

Operational expediente state is not polluted with transport/retry details from Archivematica.

---

# ADR-006 — Permissions and roles

**Status:** Accepted

## Decision

Authorization is capability-based.

Roles are seeded bundles of permissions, not hard-coded `if role === ...` checks.

MVP roles:

```text
ADMINISTRATOR
OFICIALIA
GESTOR
ARCHIVISTA
CONSULTA
```

`ADMINISTRATOR` is a platform/configuration role and is **not automatically an operational records superuser**.

Emergency/manual data correction requires a separately granted operational permission and is always audited.

## Command permissions

| Command / capability | Oficialía | Gestor | Archivista | Administrador | Consulta |
|---|:---:|:---:|:---:|:---:|:---:|
| Register matter | ✓ | — | — | — | — |
| Assign/reassign matter | ✓ | — | — | — | — |
| Void unprocessed matter | ✓ | — | — | — | — |
| Start assigned matter | — | ✓ | — | — | — |
| Resolve matter | — | ✓ | — | — | — |
| Reopen resolved matter | — | ✓ | — | — | — |
| Close matter | — | ✓ | — | — | — |
| Create expediente | — | ✓ | — | — | — |
| Edit open expediente | — | ✓ | — | — | — |
| Add/version document in open expediente | — | ✓ | — | — | — |
| Close expediente | — | ✓ | — | — | — |
| Reopen closed expediente | — | ✓ | ✓ | — | — |
| Prepare archival transfer | — | — | ✓ | — | — |
| Approve/reject transfer | — | — | ✓ | — | — |
| Retry preservation integration | — | — | ✓ | ✓* | — |
| Correct archival description after transfer | — | — | ✓ | — | — |
| Publish AtoM description | — | — | ✓ | — | — |
| Manage users/roles | — | — | — | ✓ | — |
| Manage institution configuration | — | — | — | ✓ | — |
| Manage expediente-type drafts | — | — | ✓ | ✓ | — |
| Publish expediente-type version | — | — | ✓ | — | — |
| Read permitted records | ✓ | ✓ | ✓ | ✓ | ✓ |

`✓*` means technical retry only; it does not grant authority to approve or alter archival content.

Every permission is also constrained by:

- institution;
- administrative unit where applicable;
- effective access classification;
- current aggregate state.

---

# ADR-007 — Expediente-type definition versioning

**Status:** Accepted

## Decision

An expediente type has stable identity plus immutable published versions.

Schema concept:

```text
expediente_types
----------------
id
institution_id
code
name
status

expediente_type_versions
------------------------
id
institution_id
expediente_type_id
version_number
status
schema_json
archival_mapping_json
created_at
published_at
```

Version states:

```text
DRAFT
PUBLISHED
RETIRED
```

Rules:

1. A `DRAFT` version may be edited.
2. Publishing makes `schema_json` and `archival_mapping_json` immutable.
3. Every publish operation increments `version_number`.
4. Every expediente references `expediente_type_version_id`, not merely the type.
5. Existing expedientes remain pinned to the version with which they were created.
6. A new type definition never silently mutates existing expediente validation.
7. Migrating an existing expediente to a newer type version is an explicit audited command.
8. A published version may be retired for new creation but remains readable forever.
9. Required-field removal, field-type changes, new fields, mapping changes, and validation changes all require a new version.
10. Field identity uses a stable machine key; display labels may be translated without changing field identity.

The dynamic metadata schema is expressed as versioned JSON Schema-compatible data.

## Consequence

Configuration evolution cannot retroactively invalidate historical expedientes.

---

# ADR-008 — Document identity and versioning

**Status:** Accepted

## Decision

A logical document and its binary versions are separate objects.

```text
documents
---------
id
institution_id
expediente_id
document_type
title
current_version_id
access_classification_id
created_at

document_versions
-----------------
id
institution_id
document_id
version_number
original_filename
detected_mime_type
declared_mime_type
size_bytes
sha256
storage_key
malware_scan_status
created_by
created_at
replacement_reason
```

## Rules

- Binary objects are immutable.
- Uploading a replacement never overwrites storage.
- A replacement creates a new `document_version`.
- `version_number` is monotonically increasing per logical document.
- The previous version remains preserved and queryable.
- Replacement requires a reason.
- The original filename is metadata, not identity.
- Server-detected MIME type is authoritative for policy enforcement.
- SHA-256 is calculated for every version.
- Duplicate bytes are not automatically treated as the same logical document.
- A genuinely different record is a new `document`, not a new version.
- Routine version creation is allowed only while the expediente is `OPEN`.
- Closing an expediente freezes its current document-version selection.
- Reopening before transfer may create additional versions.
- After transfer, no manifest-bound version can be replaced in place.

## Archival rule

All document versions retained in the expediente at transfer time are included in the preservation package and manifest.

The manifest identifies:

- logical document;
- version number;
- current/non-current status;
- hash;
- size;
- MIME type.

## Consequence

The system preserves evidentiary history and never destroys a previously accepted file through an ordinary “replace” operation.

---

# ADR-009 — Transfer manifest immutability and corrections

**Status:** Accepted

## Decision

A transfer manifest has two phases.

### Draft

Before archival approval:

- generated from current expediente state;
- may be regenerated;
- may be discarded;
- has no preservation authority.

### Approved

Approval creates an immutable canonical manifest.

The approved record stores:

```text
manifest_id
institution_id
transfer_id
canonical_json
sha256
approved_by
approved_at
```

The canonical JSON bytes referenced by `sha256` are immutable.

Database updates to the approved manifest payload are prohibited by application logic and database protection.

## Post-transfer correction policy

### Before approval

Reopen/edit the expediente as necessary and generate a new draft manifest.

### After approval but before successful preservation

The approved manifest cannot change.

If content is wrong:

1. cancel the transfer if cancellation remains safe;
2. create a replacement transfer;
3. approve a new manifest;
4. retain the cancelled manifest and audit history.

### After completed transfer

The original manifest, AIP references, and audit trail remain immutable.

Corrections are handled as follows:

#### Descriptive correction only

Examples:

- typo in title;
- corrected descriptive note;
- corrected non-binary metadata.

Create:

```text
archival_correction
```

with:

- reason;
- actor;
- timestamp;
- old value;
- new value;
- legal/administrative basis when required.

Then update the AtoM description through the adapter.

The original transfer manifest is not rewritten.

#### Binary addition or replacement

Create a **supplemental transfer** with its own immutable manifest:

```text
supplements_transfer_id = <original transfer>
correction_reason = ...
```

The original AIP/manifest is retained.

#### Removal/destruction request

Ordinary editing cannot delete transferred evidence.

Deletion requires a future explicit disposition/deaccession workflow with independent authorization. The MVP records the request but does not physically destroy preserved packages.

## Consequence

“Correction” never means rewriting preservation history.

---

# ADR-010 — AtoM hierarchy and field mapping

**Status:** Accepted

## Decision

ICI uses the following archival hierarchy in AtoM:

```text
Archival institution / Repository
└── Fonds
    └── Section
        └── Series
            └── Subseries (optional)
                └── File          ← ICI expediente
                    └── Item      ← transferred document version
```

If no subseries exists, `File` is placed directly under `Series`.

### Ownership

- ICI owns active administrative records and classification configuration.
- AtoM owns archival description/access after formal transfer.
- ICI retains external AtoM IDs/slugs for correlation.

### Hierarchy mapping

| ICI concept | AtoM concept |
|---|---|
| Institution | Archival institution / repository |
| Archival fonds | Fonds |
| Classification section | Section |
| Series | Series |
| Subseries | Subseries |
| Expediente | File |
| Transferred document version | Item |

AtoM has a 1:1 relationship between an archival description and its attached digital object. Therefore each transferred document version that is exposed through the DIP is represented by an `Item` description rather than attaching multiple files directly to the expediente-level `File` description.

### File / expediente mapping

| ICI field | AtoM field/concept |
|---|---|
| `expediente.folio` | `identifier` |
| expediente title | `title` |
| constant | `level_of_description = File` |
| parent classification node | `parent_id` / `parent_slug` |
| opened/closed dates | `dates` |
| subject / archival description | `description` |
| creator/originating unit | `names` / creator relation where supported |
| access/classification summary | `rights` and/or controlled notes through adapter mapping |
| ICI UUID | source/control note for correlation |

### Item / document-version mapping

| ICI field | AtoM field/concept |
|---|---|
| document stable identifier + version | `identifier` |
| document title or original filename | `title` |
| constant | `level_of_description = Item` |
| expediente AtoM object | parent |
| creation/upload/document date | `dates` |
| MIME/format information | `format` |
| ICI document/version IDs | source/control note |
| access classification | rights/controlled note |
| DIP file | digital object |

### Publication policy

AtoM default publication status for ICI-created descriptions is **Draft**.

A successful preservation transfer does not imply public disclosure.

Only `ARCHIVISTA` with publish permission may publish a description, and publication is subject to access classification.

## Adapter rule

The domain model contains no AtoM slugs, payload shapes, or taxonomy IDs except in integration-reference records.

A mapping table stores:

```text
ici_object_type
ici_object_id
atom_information_object_id
atom_slug
last_synced_at
sync_status
```

## Consequence

The archival hierarchy follows conventional fonds/series/file/item structure and works with AtoM’s one-description/one-digital-object model.

---

# ADR-011 — Authentication

**Status:** Accepted

## Decision

The deployable MVP uses **OIDC authentication**.

Reference self-hosted provider: **Keycloak**.

Local development may use a development-only identity provider or seeded development identities, but production code does not store or verify user passwords.

ICI user identity is modeled independently from the OIDC provider:

```text
users
-----
id
institution_id
display_name
status

external_identities
-------------------
id
institution_id
user_id
issuer
subject
email_snapshot
last_seen_at
```

Identity key:

```text
(issuer, subject)
```

not email address.

Roles and permissions remain in ICI, not in Keycloak, for the MVP. OIDC establishes identity; ICI establishes application authorization.

Local-development authentication must be impossible to enable accidentally in a production environment.

## Consequence

The MVP does not acquire a password-authentication subsystem that would later need replacement for government deployment.

---

# ADR-012 — File intake, malware, MIME, and access classification

**Status:** Accepted

## Decision

File policy is institution-configurable within a fixed security model.

## Size

Initial policy:

- default maximum: **500 MiB per file**;
- MVP absolute safety ceiling: **2 GiB per file**;
- storage uses streaming/multipart semantics; files are never loaded wholly into API memory;
- size is stored as a 64-bit integer.

An institution may lower the default limit without schema changes.

## MIME policy

The browser-provided MIME type and extension are advisory only.

The server performs independent format/MIME identification.

Initial normal-document allowlist:

```text
application/pdf

image/jpeg
image/png
image/tiff

text/plain
text/csv
text/xml
application/xml

application/vnd.openxmlformats-officedocument.wordprocessingml.document
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
application/vnd.openxmlformats-officedocument.presentationml.presentation

application/vnd.oasis.opendocument.text
application/vnd.oasis.opendocument.spreadsheet
application/vnd.oasis.opendocument.presentation

message/rfc822
```

Archive/container formats and institution-specific preservation formats may be enabled explicitly by configuration.

Executable/script formats are not accepted through normal official-document intake.

Unknown types are quarantined rather than silently accepted.

## Malware scanning

Every uploaded binary begins as:

```text
PENDING_SCAN
```

It cannot be downloaded by ordinary users, linked into a closable expediente, or transferred to preservation until scanning succeeds.

Statuses:

```text
PENDING_SCAN
CLEAN
INFECTED
SCAN_FAILED
QUARANTINED
```

ICI uses **ClamAV via `clamd`** for initial upload scanning.

On `INFECTED`:

- object remains quarantined;
- no ordinary download;
- no preservation submission;
- security/audit event created.

On `SCAN_FAILED`:

- fail closed;
- retry scan;
- do not treat as clean.

Archivematica performs its own preservation-stage antivirus scan as a second independent control; Archivematica 1.18 provides ClamAV-based virus scanning.

The scan record stores:

- engine;
- engine version;
- signature/database version when available;
- scan timestamp;
- result.

## Access classification

Legal information classification and operational UI visibility are separate concepts.

### Legal classification

Initial values:

```text
PUBLIC
RESERVED
CONFIDENTIAL
```

`PUBLIC` is the default.

For `RESERVED`, the system requires:

- legal basis;
- reason;
- classification authority;
- classified timestamp;
- reservation/review expiry date when applicable.

For `CONFIDENTIAL`, the system requires:

- legal basis;
- reason/category;
- classification authority;
- classified timestamp.

This reflects the current Mexican transparency framework, which distinguishes reserved and confidential information and requires public versions where a document contains classified portions.

### Operational visibility

Separate field/policy:

```text
INSTITUTION
UNIT
RESTRICTED_GROUP
```

Operational visibility controls which authenticated workers can see the record. It does not purport to determine the legal public-access classification.

### Inheritance

An expediente may define a default legal classification, but each document/version stores its explicit classification snapshot.

Publication decisions are evaluated per archival description/digital object rather than assuming that every document in an expediente has identical disclosure status.

## Consequence

Security controls do not conflate “my unit cannot see this operationally” with “the public is legally prohibited from seeing this.”

---

# Resulting initial domain/schema commitments

These ADRs imply the following minimum persistent concepts:

```text
institutions
users
external_identities
roles
permissions
role_permissions
user_role_assignments

organizational_units

folio_counters

matters
matter_assignments
matter_state_events

expediente_types
expediente_type_versions
expedientes
expediente_state_events

documents
document_versions
malware_scans
access_classifications

archival_classification_nodes
atom_mappings

archive_transfers
transfer_manifests
archival_corrections

audit_events
integration_jobs
```

All tenant-owned records carry `institution_id`.

The domain model must use explicit commands/state transitions rather than allowing arbitrary status updates.

---

# Exit-condition assessment

**Passed for the initial domain/database model.**

There are no remaining unresolved decisions in the listed foundational areas that should require changing the basic aggregate boundaries or database shape.

Institution-specific values remain configurable without affecting the core model:

- folio display template;
- organizational structure;
- expediente-type schemas;
- archival classification catalogue;
- file-size limits below the safety ceiling;
- enabled MIME profiles;
- OIDC issuer/client configuration;
- access-policy assignments.

Future legal/policy refinement may add validation rules or workflows, but the schema deliberately provides versioned definitions, immutable event/history records, external identity mappings, and correction/supplement mechanisms so those refinements do not require rewriting the foundational model.

---

# Authoritative implementation references

- AtoM 2.10 documentation: https://www.accesstomemory.org/en/docs/2.10/
- AtoM stable downloads: https://www.accesstomemory.org/en/download/
- AtoM information-object API: https://www.accesstomemory.org/en/docs/2.10/dev-manual/api/create-io/
- Archivematica 1.18 documentation: https://www.archivematica.org/en/docs/archivematica-1.18/
- Archivematica API overview: https://www.archivematica.org/en/docs/archivematica-1.18/dev-manual/api/api-overview/
- Archivematica / AtoM integration: https://www.archivematica.org/docs/latest/admin-manual/installation-setup/integrations/atom-setup/
- Archivematica antivirus administration: https://www.archivematica.org/en/docs/archivematica-1.18/admin-manual/installation-setup/customization/antivirus-admin/
- Mexican General Transparency and Access to Public Information Law (current law published 2025-03-20): https://www.diputados.gob.mx/LeyesBiblio/pdf/LGTAIP.pdf
- Mexican General Archives Law: https://www.diputados.gob.mx/LeyesBiblio/pdf/LGA.pdf
