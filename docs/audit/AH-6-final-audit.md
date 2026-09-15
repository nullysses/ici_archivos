# AH-6 — Final audit and repository reconciliation

Status: **accepted and frozen**  
Audit date: 2026-09-15  
Audited baseline: `954d42412fcd9d7e11d364fe1d293194cdf8f39e`

## Scope

AH-6 is a documentation and verification tranche. It does not add runtime
behavior, migrations, routes, capabilities, roles, or external integrations.
The audit reconciles the implementation with `ICI_Archivos_MVP.md`,
`ICI_Archivos_Foundational_ADRs.md`, and the repository engineering rules.

## Reconciled implementation state

- Step 5 matter operations and the document/malware pipeline are complete and
  frozen.
- Step 6 expediente operations are complete and frozen: expediente core,
  matter linkage, expediente-owned documents, closure, durable transfer intent,
  and the end-to-end acceptance scenario.
- Transfer approval freezes the canonical manifest and creates the durable
  `archive_transfer.preserve` intent in the same transaction. Submission and
  preservation execution remain behind the trusted worker boundary.
- AtoM and Archivematica adapters are not implemented. Their ports and spike
  evidence remain separate from the active workflow, as required by the MVP and
  ADRs.

## Frozen security and provenance decisions

- Tenant and actor identity are server-derived; PostgreSQL RLS remains the
  tenant boundary.
- Matter operational authorization uses the latest assignment unit, falling
  back to the destination unit before first assignment.
- Operational visibility is fail-closed for missing or unsupported values.
- Named assignment targets require an active exact-unit
  `user_role_assignments` membership effective at assignment time.
- `closeMatter` requires the pre-existing expediente link and cannot create or
  replace it.
- Expediente-owned documents are institution-scoped until the expediente has an
  authoritative organizational scope; linked matters never provide that scope.
- Document bytes remain immutable and quarantined until a CLEAN malware result.

## Frozen audit corrections

| Finding | Resolution | Checkpoint |
| --- | --- | --- |
| AH-1 — expediente closure could precede retained-document readiness | Closure validates every retained current and historical version that enters a transfer manifest; DB defense-in-depth was added. | `cf2faca` |
| AH-2 — approval did not create preservation intent | Approval atomically creates one durable `archive_transfer.preserve` job; `/submit` is not a human step. | `ee216b6` |
| AH-3 — reject/cancel semantics were ambiguous | Pre-approval rejection and post-approval safe cancellation are distinct lifecycle/audit paths. | `71d6f78` |
| AH-4 — generic transition helpers were escape hatches | Application-facing transitions require hardened, authorized operations. | `ca7bbf8` |
| AH-5 — manifest ordering and mapping validation were underspecified | Canonical JSON is locale-independent and archival mapping is explicitly validated as `{ levelOfDescription: "File" }`. | `954d424` |
| AH-6 — documentation and verification drift | README, this audit, and measured verification now describe the current repository state. | this commit |

## Verification record

The current repository was verified with Docker/Testcontainers available:

| Check | Result |
| --- | --- |
| Unit tests | 70 passed |
| PostgreSQL integration tests | 79 passed |
| Playwright E2E | 1 passed |
| Statement coverage | 27.35% (719/2628) |
| Branch coverage | 17.73% (405/2284) |
| Function coverage | 20.93% (152/726) |
| Line coverage | 28.97% (534/1843) |
| Lint | passed |
| Typecheck | passed |
| Build | passed |
| `git diff --check` | passed |

Coverage is recorded as an audit baseline, not as a new quality threshold.

Migrations `001` through `010` are unchanged byte-for-byte. No migration was
required for AH-6.

## Main-roadmap boundary

The next functional work belongs to the main roadmap: separately scoped AtoM
and Archivematica adapters, their pinned-version spike evidence, and deployment
hardening. AH-6 does not implement or imply those integrations, nor does it
start a new workflow block.
