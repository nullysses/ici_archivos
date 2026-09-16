# Architecture

ICI Archivos is a TypeScript modular monolith with three deployable processes:

```text
browser -> web -> API -> PostgreSQL
                    -> S3-compatible storage
                    -> transactional outbox
                              |
                              v
                         Redis/BullMQ -> worker -> AtoM
                                                -> Archivematica
```

The web process is a React SPA. Fastify is the HTTP adapter around application
and domain modules. The worker executes recoverable external integration work.
Both API and worker use the same domain, database, contracts, and adapter
packages; they do not communicate through private HTTP endpoints.

## Ownership boundaries

- ICI is authoritative for active administrative workflow, permissions,
  document lineage, audit history, and the approved transfer manifest.
- AtoM is authoritative for archival description and access after transfer.
- Archivematica is authoritative for preservation processing, AIPs, and DIPs.

## Dependency direction

Domain code imports no framework or vendor adapter. Applications may import the
domain and ports. Infrastructure packages implement ports. Vendor DTOs remain
inside their adapter package and are transformed at the boundary.

## Initial runtime boundary

The local ICI stack contains PostgreSQL, Redis, and MinIO. AtoM and
Archivematica remain an independently operated integration stack so application
development does not require preservation services for ordinary domain tests.

## Production preservation boundary

The worker's `PreservationExecutionPort` implementation is the only composition
point for the preservation vendors. It reloads the approved manifest from
PostgreSQL, synchronizes the frozen AtoM hierarchy and expediente File, streams
CLEAN objects into a deterministic package under
`ARCHIVEMATICA_TRANSFER_SOURCE_ROOT`, and delegates transfer, ingest, AIP, and
DIP observations to the pinned Archivematica 1.18.0 / Storage Service 0.24.0
adapter. Migration 014's staging record distinguishes an unambiguous staged
package from an uncertain crash window; uncertain evidence requires
reconciliation rather than overwrite or blind resubmission.

The completion contract is evidence-based: the exact approved manifest bytes
are present in the package and its AIP is verified through Storage Service; the
AtoM documented read response must report the target File's digital object after
Archivematica's native DIP upload. AtoM publication and direct DIP/SWORD calls
remain outside ICI's boundary. Transfer and ingest `USER_INPUT`, incomplete
SIP/AIP evidence, and unavailable public proof of DIP delivery are surfaced as
intervention outcomes, not silently classified as successful preservation.
