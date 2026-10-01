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
are present in the package and its AIP is verified through Storage Service.
Archivematica's native DIP upload is not treated as proof that the resulting
Items are attached to the intended AtoM File because the pinned public APIs do
not expose that correlation reliably. AtoM publication and direct DIP/SWORD
calls remain outside ICI's boundary. Transfer and ingest `USER_INPUT`,
incomplete SIP/AIP evidence, and unavailable public proof of DIP delivery are
surfaced as intervention outcomes, not silently classified as successful
preservation.

## Archivista work area

The authenticated `/archive` area is a read-oriented projection of the frozen
transfer and preservation evidence. It groups closed expedientes ready for
preparation and transfers into approval, active-preservation, intervention,
and completed queues. Transfer detail reads expose the immutable manifest,
classification path, AtoM/Archivematica references, staging evidence, and
authoritative activity. `USER_INPUT`, reconciliation, and the M11
`PRESERVATION_INTERVENTION_REQUIRED` boundary remain explicit human-action
states; the UI never marks a transfer complete from a DIP UUID alone and never
offers blind resubmission.
## Administración M15

La aplicación mantiene la administración dentro de `/admin` y reutiliza las
capabilities institucionales existentes. Las superficies implementadas son:

- configuración institucional limitada a propiedades editables soportadas;
- unidades organizacionales, con desactivación en lugar de borrado;
- usuarios, roles/grants y membresías de unidad, con revocación histórica;
- drafts y publicación de versiones de tipos de expediente;
- consulta de la clasificación archivística.

Todas las mutaciones administrativas pasan por servicios tenant-scoped y
generan `audit_events`. La autenticación continúa delegada a OIDC; ICI no
administra contraseñas ni credenciales del proveedor de identidad. La
clasificación se presenta como sólo lectura porque el dominio congelado no
define una capability mutacional autorizada para modificarla.

La política de delegación vigente es explícita: `identity.manage`, evaluada a
nivel institucional, autoriza delegar cualquier rol registrado dentro de la
misma institución, incluso al propio administrador. Cada asignación conserva
su scope institucional o de unidad, queda auditada y puede revocarse sin
eliminar el historial.

El editor de tipos conserva el schema JSON completo al cambiar etiquetas de
campos. Cuando encuentra construcciones fuera del subconjunto seguro de la
interfaz, muestra el draft en sólo lectura en lugar de reconstruirlo o perder
restricciones.
