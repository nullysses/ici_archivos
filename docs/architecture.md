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

