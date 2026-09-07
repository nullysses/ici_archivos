# AtoM–Archivematica feasibility spike

This isolated development harness proves the external-system boundary for the
ICI Archivos MVP. It checks out and verifies these exact upstream sources:

- AtoM 2.10.2;
- Archivematica 1.18.0;
- Archivematica Storage Service 0.24.0.

It is not the ICI application deployment and is not a production topology.
Archivematica documents Docker Compose as a development environment; its
supported production installation uses Ubuntu 24.04 and Ansible. The spike uses
the upstream development Compose files with small local overrides for a shared
network, shared SWORD deposit volume, and removal of `latest` image references.

## What the harness proves

1. The pinned source commits build and start.
2. AtoM's documented REST API creates a Fonds/Section/Series/File hierarchy.
3. Archivematica accepts an API-submitted transfer associated with the File slug.
4. The worker pipeline stores an AIP and uploads a hierarchical DIP through
   AtoM's native SWORD integration.
5. The resulting AtoM Item and digital object can be retrieved through the API.
6. JSON evidence for each step is retained under `.state/runs/<run-id>/`.

## Host requirements

- Linux or WSL2 with Docker Desktop WSL integration enabled;
- Docker Engine 23 or newer;
- Docker Compose 2.17 or newer;
- Git, GNU Make, curl, jq, and base64;
- at least 8 GiB RAM available for the combined development stack;
- enough disk for source builds, databases, AIPs, and DIPs.

Docker is currently unavailable in the workspace's WSL distribution, so the
runtime acceptance path cannot be executed here until WSL integration is enabled.

## Bootstrap

Copy `.env.example` to `.env`, then run:

```bash
make check
make fetch
make bootstrap
```

`make bootstrap` is intentionally explicit and destructive to the spike's
vendor databases. It must never point at shared or production vendor instances.
It initializes development users supplied by the upstream projects:

- AtoM: `demo` / `demo`, email `demo@example.com`;
- Archivematica Dashboard: `test` / `test`, API key `test`;
- Storage Service: `test` / `test`, API key `test`.

These credentials are forbidden outside this isolated local spike.

## One-time vendor administration

Some integration configuration has no supported public API and is therefore a
visible precondition rather than browser automation or database manipulation.

### AtoM

Open <http://127.0.0.1:63001> and sign in.

1. Confirm `arRestApiPlugin` and `qtSwordPlugin` are enabled. Bootstrap enables
   both, but the UI is the authoritative confirmation.
2. Generate a REST API key for the `demo` user and place it in `.env` as
   `ATOM_API_KEY`.
3. Under the Levels of description taxonomy, add `Section` if it is absent.
   AtoM's initial English level catalogue does not include Section.
4. Create an archival institution/repository for the spike.

AtoM 2.10's documented information-object create endpoint does not create an
archival institution or accept a repository relation. Consequently, repository
creation and association are configuration/reference-data concerns. The future
ICI adapter should resolve a preconfigured Series slug; it must not access AtoM's
database to work around this API boundary.

### Archivematica

Open <http://127.0.0.1:62080> and sign in.

1. Under Administration → DIP upload → AtoM, configure:
   - upload URL: `http://atom/index.php`;
   - login email: `demo@example.com`;
   - login password: `demo`;
   - AtoM version: `2`;
   - rsync target: `/tmp`;
   - rsync command: blank;
   - debug mode: enabled.
2. Fetch AtoM levels of description and confirm Fonds, Section, Series, File,
   and Item are visible.
3. Create a processing configuration named `ici-mvp`. It must make every
   decision required for this synthetic transfer, including:
   - run antivirus and fail on detection;
   - normalize for preservation and access;
   - create a single SIP;
   - store the AIP;
   - generate a DIP;
   - upload the DIP to AtoM.

The local Compose overrides attach AtoM and Archivematica to one bridge network.
They also mount a dedicated Docker volume at `/tmp` in the AtoM application,
AtoM worker, and Archivematica MCP client. This is the common-filesystem mode
documented by Archivematica, so SSH/rsync is unnecessary for the spike.

## Execute the smoke test

After vendor administration is complete:

```bash
make preflight
make hierarchy
# In AtoM, associate the newly created Fonds with the spike repository. The
# documented REST create endpoint cannot set that relation.
make transfer
make status
make verify
```

`make status` stops immediately if Archivematica reports `FAILED`, `REJECTED`,
or `USER_INPUT`. Use `make logs` and the dashboard for diagnostics. It never
silently chooses an Archivematica decision.

For another attempt, set a new `SPIKE_RUN_ID` in `.env`. A submitted run ID is
never reused because preservation submission is not safe to deduplicate by
guessing. The future ICI worker must own an explicit idempotency key and persist
the returned transfer UUID.

## Passing evidence

`make verify` passes only when it finds all of the following:

- a completed Archivematica `Store AIP` job;
- a completed DIP-upload job;
- at least one Item beneath the target AtoM File;
- a non-empty digital object downloadable from that Item.

The run directory retains the AtoM create responses, Archivematica transfer and
ingest UUIDs/statuses, detailed jobs, final AtoM tree, and downloaded test object.
Those artifacts form the compatibility evidence for ADR-001.

## Official references

- <https://www.accesstomemory.org/en/docs/2.10/dev-manual/api/create-io/>
- <https://www.archivematica.org/en/docs/archivematica-1.18/dev-manual/api/api-reference-archivematica/>
- <https://www.archivematica.org/en/docs/archivematica-1.18/admin-manual/installation-setup/integrations/atom-setup/>
- <https://www.archivematica.org/en/docs/archivematica-1.18/admin-manual/installation-setup/customization/dashboard-config/>
