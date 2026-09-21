import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { applyFoundationMigrations, createDatabase, type Database } from '../../packages/database/dist/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { createMatterApplicationService } from '../../apps/api/src/matters.js';
import { createExpedienteApplicationService } from '../../apps/api/src/expedientes.js';
import { createArchiveTransferApplicationService } from '../../apps/api/src/transfers.js';
import { claimArchiveTransferPreservationJobs, setExpedienteArchivalParentAtomically } from '../../packages/database/dist/index.js';
import { PreservationInterventionRequired } from '../../apps/worker/src/preservation.js';
import { processClaimedArchiveTransferPreservationJob, runMalwareScanOnce } from '../../apps/worker/src/jobs.js';
import { UnauthenticatedError, type AuthenticatedPrincipal } from '../../apps/api/src/auth.js';
import type { DocumentStoragePort } from '../../packages/integrations/storage/dist/index.js';
import type { MalwareScannerPort } from '../../packages/integrations/malware/dist/index.js';

const institutionId = '22000000-0000-4000-8000-000000000001';
const userId = '22000000-0000-4000-8000-000000000002';
const unitId = '22000000-0000-4000-8000-000000000003';
const classificationId = '22000000-0000-4000-8000-000000000004';
const roleId = '22000000-0000-4000-8000-000000000005';
const membershipId = '22000000-0000-4000-8000-000000000006';
const typeId = '22000000-0000-4000-8000-000000000007';
const typeVersionId = '22000000-0000-4000-8000-000000000008';
const fondsId = '22000000-0000-4000-8000-000000000009';
const sectionId = '22000000-0000-4000-8000-00000000000a';
const seriesId = '22000000-0000-4000-8000-00000000000b';
const archiveExpedienteId = '22000000-0000-4000-8000-00000000000c';
const interventionExpedienteId = '22000000-0000-4000-8000-00000000000d';
const interventionTransferId = '22000000-0000-4000-8000-00000000000e';
const interventionManifestId = '22000000-0000-4000-8000-00000000000f';
const interventionRemoteTransferId = '22000000-0000-4000-8000-000000000010';
const interventionSipId = '22000000-0000-4000-8000-000000000011';
const interventionAipId = '22000000-0000-4000-8000-000000000011';
const interventionDipId = '22000000-0000-4000-8000-000000000012';
const transferSourceLocationId = '22000000-0000-4000-8000-000000000013';

class MemoryStorage implements DocumentStoragePort {
  private readonly objects = new Map<string, Uint8Array>();

  public async put(input: { readonly zone: 'QUARANTINE'; readonly key: string; readonly body: ReadableStream<Uint8Array> }): Promise<void> {
    const reader = input.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
    }
    const value = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.byteLength; }
    this.objects.set(`${input.zone}:${input.key}`, value);
  }

  public open(input: { readonly zone: 'QUARANTINE' | 'CLEAN'; readonly key: string }): Promise<ReadableStream<Uint8Array>> {
    const value = this.objects.get(`${input.zone}:${input.key}`);
    if (value === undefined) return Promise.reject(new Error('Stored object not found'));
    return Promise.resolve(new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } }));
  }

  public head(input: { readonly zone: 'QUARANTINE' | 'CLEAN'; readonly key: string }): Promise<{ readonly sizeBytes: bigint; readonly sha256?: string } | undefined> {
    const value = this.objects.get(`${input.zone}:${input.key}`);
    return Promise.resolve(value === undefined ? undefined : { sizeBytes: BigInt(value.byteLength), sha256: createHash('sha256').update(value).digest('hex') });
  }

  public copy(input: { readonly from: 'QUARANTINE' | 'CLEAN'; readonly to: 'QUARANTINE' | 'CLEAN'; readonly key: string }): Promise<void> {
    const source = this.objects.get(`${input.from}:${input.key}`);
    if (source === undefined) return Promise.reject(new Error('Source object not found'));
    this.objects.set(`${input.to}:${input.key}`, new Uint8Array(source));
    return Promise.resolve();
  }

  public remove(input: { readonly zone: 'QUARANTINE' | 'CLEAN'; readonly key: string }): Promise<void> { this.objects.delete(`${input.zone}:${input.key}`); return Promise.resolve(); }
}

const scanner: MalwareScannerPort = {
  async scan(body) {
    const reader = body.getReader();
    while (!(await reader.read()).done) { /* consume the complete stream */ }
    return { verdict: 'CLEAN', engine: 'e2e-scanner', scannedAt: new Date() };
  },
};

const authorization: AuthenticatedPrincipal['authorization'] = {
  userId,
  institutionId,
  institutionCapabilities: new Set(['matter.register', 'matter.assign', 'records.read', 'matter.start', 'matter.resolve', 'matter.close', 'expediente.create', 'expediente.edit_open', 'document.version_open', 'expediente.close']),
  unitCapabilities: new Map(),
};

let database: Database | undefined;
let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let scanTimer: NodeJS.Timeout | undefined;
let scanning = false;

async function main(): Promise<void> {
  const bootstrapDirectory = await mkdtemp(join(tmpdir(), 'ici-e2e-postgres-'));
  const bootstrapFile = join(bootstrapDirectory, '01-role.sql');
  await writeFile(bootstrapFile, 'CREATE ROLE ici_app NOLOGIN NOSUPERUSER NOBYPASSRLS;\n');
  try {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22')
      .withCopyFilesToContainer([{ source: bootstrapFile, target: '/docker-entrypoint-initdb.d/01-role.sql' }])
      .start();
  } finally {
    await rm(bootstrapDirectory, { recursive: true, force: true });
  }
  database = createDatabase(container.getConnectionUri());
  await applyFoundationMigrations(database);
  await database.insertInto('institutions').values({ id: institutionId, code: 'E2E', name: 'Institución E2E', status: 'ACTIVE' }).execute();
  await database.insertInto('organizational_units').values({ id: unitId, institution_id: institutionId, code: 'E2E-UNIT', name: 'Unidad E2E', status: 'ACTIVE' }).execute();
  await database.insertInto('users').values({ id: userId, institution_id: institutionId, display_name: 'Operador E2E', status: 'ACTIVE' }).execute();
  await database.insertInto('roles').values({ id: roleId, code: 'E2E_OPERATOR', name: 'Operador E2E' }).execute();
  await database.insertInto('user_role_assignments').values({ id: membershipId, institution_id: institutionId, user_id: userId, role_id: roleId, unit_id: unitId, effective_from: new Date('2020-01-01T00:00:00.000Z') }).execute();
  await database.insertInto('access_classifications').values({ id: classificationId, institution_id: institutionId, legal_classification: 'PUBLIC', operational_visibility: 'INSTITUTION' }).execute();
  await database.insertInto('expediente_types').values({ id: typeId, institution_id: institutionId, code: 'E2E', name: 'Expediente E2E', status: 'ACTIVE' }).execute();
  await database.insertInto('expediente_type_versions').values({ id: typeVersionId, institution_id: institutionId, expediente_type_id: typeId, version_number: 1, status: 'PUBLISHED', schema_json: { type: 'object', properties: { title: { type: 'string', title: 'Título' } }, required: ['title'] }, archival_mapping_json: { levelOfDescription: 'File' }, created_at: new Date(), published_at: new Date() }).execute();
  await database.insertInto('archival_classification_nodes').values([
    { id: fondsId, institution_id: institutionId, parent_id: null, node_type: 'FONDS', code: 'E2E-F', name: 'Fondo E2E', metadata: {} },
    { id: sectionId, institution_id: institutionId, parent_id: fondsId, node_type: 'SECTION', code: 'E2E-S', name: 'Sección E2E', metadata: {} },
    { id: seriesId, institution_id: institutionId, parent_id: sectionId, node_type: 'SERIES', code: 'E2E-SER', name: 'Serie E2E', metadata: {} },
  ]).execute();
  const expedienteService = createExpedienteApplicationService(database);
  await expedienteService.create({ id: archiveExpedienteId, institutionId, actorUserId: userId, correlationId: 'e2e-archive-create', request: { expedienteTypeVersionId: typeVersionId, metadata: { title: 'Transferencia archivística E2E' } } });
  const storage = new MemoryStorage();
  const archiveAuthorization = { ...authorization, institutionCapabilities: new Set([...authorization.institutionCapabilities, 'archive_transfer.prepare' as const, 'archive_transfer.approve' as const, 'archive_transfer.retry' as const, 'expediente.close' as const]) };
  await setExpedienteArchivalParentAtomically(database, { institutionId, expedienteId: archiveExpedienteId, archivalParentNodeId: seriesId, actorUserId: userId, correlationId: 'e2e-archive-parent', authorizationContext: archiveAuthorization });
  await expedienteService.close({ id: archiveExpedienteId, institutionId, actorUserId: userId, correlationId: 'e2e-archive-close', request: { closureMetadata: { reason: 'E2E archival preparation' } }, authorization: archiveAuthorization });
  await expedienteService.create({ id: interventionExpedienteId, institutionId, actorUserId: userId, correlationId: 'e2e-intervention-create', request: { expedienteTypeVersionId: typeVersionId, metadata: { title: 'Intervención archivística E2E' } } });
  await setExpedienteArchivalParentAtomically(database, { institutionId, expedienteId: interventionExpedienteId, archivalParentNodeId: seriesId, actorUserId: userId, correlationId: 'e2e-intervention-parent', authorizationContext: archiveAuthorization });
  await expedienteService.close({ id: interventionExpedienteId, institutionId, actorUserId: userId, correlationId: 'e2e-intervention-close', request: { closureMetadata: { reason: 'E2E intervention preparation' } }, authorization: archiveAuthorization });
  const archiveTransferService = createArchiveTransferApplicationService(database);
  await archiveTransferService.create({ institutionId, expedienteId: interventionExpedienteId, transferId: interventionTransferId, manifestId: interventionManifestId, actorUserId: userId, correlationId: 'e2e-intervention-transfer-create', authorization: archiveAuthorization });
  await archiveTransferService.approve({ institutionId, transferId: interventionTransferId, actorUserId: userId, correlationId: 'e2e-intervention-transfer-approve', authorization: archiveAuthorization });
  const interventionClaim = (await claimArchiveTransferPreservationJobs(database, institutionId, 1)).find((job) => job.aggregate_id === interventionTransferId);
  if (interventionClaim?.claim_token === null || interventionClaim === undefined) throw new Error('Intervention fixture could not claim preservation intent');
  await database.insertInto('archivematica_transfers').values({ institution_id: institutionId, archive_transfer_id: interventionTransferId, submission_status: 'SUBMITTED', archivematica_transfer_uuid: interventionRemoteTransferId, sip_uuid: interventionSipId, aip_uuid: interventionAipId, dip_uuid: interventionDipId, processing_configuration: 'e2e', transfer_source_location_uuid: transferSourceLocationId, transfer_source_relative_path: 'e2e/intervention', last_remote_status: 'COMPLETE', last_ingest_status: 'COMPLETE', last_checked_at: new Date() }).execute();
  await processClaimedArchiveTransferPreservationJob({
    database,
    preservation: { execute: () => Promise.reject(new PreservationInterventionRequired('AtoM Item correlation is not independently provable')) },
  }, interventionClaim);
  app = await createApp({
    authenticateAccessToken: (token) => token === 'e2e-token'
      ? Promise.resolve({ userId, institutionId, issuer: 'https://e2e.example.test', subject: 'e2e-user', authorization: archiveAuthorization })
      : Promise.reject(new UnauthenticatedError()),
    matterService: createMatterApplicationService(database),
    expedienteService: expedienteService,
    archiveTransferService,
    database,
    documentDependencies: { database, storage, maxBytes: 1024n * 1024n },
    checkDatabase: () => Promise.resolve(true),
    version: 'e2e',
    webOrigin: 'http://127.0.0.1:5174',
  });
  await app.listen({ host: '127.0.0.1', port: 3000 });
  scanTimer = setInterval(() => {
    if (scanning || database === undefined) return;
    scanning = true;
    void runMalwareScanOnce({ database, storage, scanner }).finally(() => { scanning = false; });
  }, 250);
}

async function shutdown(): Promise<void> {
  if (scanTimer !== undefined) clearInterval(scanTimer);
  await app?.close();
  await database?.destroy();
  await container?.stop();
}

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
await main();
