import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { acceptExpedienteDocumentUploadAtomically, acceptMatterDocumentUploadAtomically, approveArchiveTransferManifestAtomically, applyFoundationMigrations, assignMatterAtomically, authorizeDocumentVersionUploadPreflight, authorizeMatterDocumentVersionDownload, claimArchiveTransferPreservationJobs, claimMalwareScanJobs, createArchiveTransferAndDraftManifestAtomically, createDatabase, createExpedienteAtomically, createExpedienteSchemaValidator, linkMatterToExpedienteAtomically, persistExpedienteTransition, persistMatterTransition, registerMatterAtomically, type Database } from '@ici/database';
import type { DocumentStoragePort } from '@ici/integration-storage';
import type { MalwareScannerPort } from '@ici/integration-malware';
import type { AuthorizationContext, Capability } from '@ici/database';
import { runArchiveTransferPreservationOnce, runMalwareScanOnce, type ArchiveTransferWorkerDependencies, type MalwareScanWorkerDependencies, type PreservationExecutionInput } from './jobs.js';

const institutionId = '33000000-0000-4000-8000-000000000001';
const userId = '33000000-0000-4000-8000-000000000002';
const unitId = '33000000-0000-4000-8000-000000000003';
const classificationId = '33000000-0000-4000-8000-000000000004';

describe('durable malware worker', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let database: Database | undefined;
  const objects = new Map<string, Uint8Array>();
  let streamFailure: Error | undefined;
  const storage: DocumentStoragePort = {
    async put(input) { const reader = input.body.getReader(); const chunks: Uint8Array[] = []; while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); } const value = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0)); let offset = 0; for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.byteLength; } objects.set(`${input.zone}:${input.key}`, value); },
    open(input) { const value = objects.get(`${input.zone}:${input.key}`); if (value === undefined) return Promise.reject(new Error('missing object')); return Promise.resolve(new ReadableStream({ start(controller) { controller.enqueue(value.subarray(0, 2)); if (streamFailure === undefined) { controller.enqueue(value.subarray(2)); controller.close(); } else controller.error(streamFailure); } })); },
    head(input) { const value = objects.get(`${input.zone}:${input.key}`); return Promise.resolve(value === undefined ? undefined : { sizeBytes: BigInt(value.byteLength) }); },
    copy(input) { const value = objects.get(`${input.from}:${input.key}`); if (value === undefined) return Promise.reject(new Error('missing source')); objects.set(`${input.to}:${input.key}`, value); return Promise.resolve(); },
    remove(input) { objects.delete(`${input.zone}:${input.key}`); return Promise.resolve(); },
  };
  let scannerVerdict: 'CLEAN' | 'INFECTED' = 'CLEAN';
  let scannerFailure: Error | undefined;
  const scanner: MalwareScannerPort = { async scan(body) { if (scannerFailure !== undefined) throw scannerFailure; const reader = body.getReader(); while (!(await reader.read()).done) { /* consume the complete stream so integrity checks run */ } return { verdict: scannerVerdict, engine: 'test-clamd', scannedAt: new Date() }; } };

  afterEach(() => { scannerFailure = undefined; streamFailure = undefined; scannerVerdict = 'CLEAN'; });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    database = createDatabase(container.getConnectionUri());
    await sql`CREATE ROLE ici_app NOLOGIN NOSUPERUSER NOBYPASSRLS`.execute(database);
    await applyFoundationMigrations(database);
    await database.insertInto('institutions').values({ id: institutionId, code: 'WORKER', name: 'Worker test', status: 'ACTIVE' }).execute();
    await database.insertInto('users').values({ id: userId, institution_id: institutionId, display_name: 'Worker user', status: 'ACTIVE' }).execute();
    await database.insertInto('organizational_units').values({ id: unitId, institution_id: institutionId, code: 'WORKER-UNIT', name: 'Worker unit', status: 'ACTIVE' }).execute();
    await database.insertInto('roles').values({ id: '33000000-0000-4000-8000-000000000005', code: 'WORKER_ROLE', name: 'Worker role' }).execute();
    await database.insertInto('user_role_assignments').values({ id: '33000000-0000-4000-8000-000000000006', institution_id: institutionId, user_id: userId, role_id: '33000000-0000-4000-8000-000000000005', unit_id: unitId, effective_from: new Date('2020-01-01T00:00:00.000Z') }).execute();
    await database.insertInto('access_classifications').values({ id: classificationId, institution_id: institutionId, legal_classification: 'PUBLIC', operational_visibility: 'INSTITUTION' }).execute();
  }, 120_000);
  afterAll(async () => { await database?.destroy(); await container?.stop(); });
  function db(): Database { if (database === undefined) throw new Error('database unavailable'); return database; }

  async function createApprovedArchiveTransfer(sequence: number): Promise<{ readonly transferId: string; readonly expedienteId: string; readonly jobId: string }> {
    const suffix = String(sequence).padStart(2, '0');
    const typeId = `33000000-0000-4000-8000-0000000000${40 + sequence}`;
    const typeVersionId = `33000000-0000-4000-8000-0000000001${suffix}`;
    const expedienteId = `33000000-0000-4000-8000-0000000002${suffix}`;
    const transferId = `33000000-0000-4000-8000-0000000003${suffix}`;
    const manifestId = `33000000-0000-4000-8000-0000000004${suffix}`;
    const authorization: AuthorizationContext = {
      userId,
      institutionId,
      institutionCapabilities: new Set<Capability>(['expediente.create', 'expediente.close', 'records.read', 'archive_transfer.prepare', 'archive_transfer.approve']),
      unitCapabilities: new Map<string, ReadonlySet<Capability>>(),
    };
    const validator = createExpedienteSchemaValidator();
    await db().insertInto('expediente_types').values({ id: typeId, institution_id: institutionId, code: `WORKER-${suffix}`, name: `Worker transfer ${suffix}`, status: 'ACTIVE' }).execute();
    await db().insertInto('expediente_type_versions').values({ id: typeVersionId, institution_id: institutionId, expediente_type_id: typeId, version_number: 1, status: 'PUBLISHED', schema_json: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }, archival_mapping_json: { levelOfDescription: 'File' }, published_at: new Date('2026-01-01T00:00:00.000Z') }).execute();
    await createExpedienteAtomically(db(), { id: expedienteId, institutionId, expedienteTypeVersionId: typeVersionId, metadata: { title: `Worker transfer ${suffix}` }, actorUserId: userId, correlationId: `worker-transfer-create-${suffix}` }, validator.validateMetadata);
    await persistExpedienteTransition(db(), { institutionId, aggregateId: expedienteId, actorUserId: userId, correlationId: `worker-transfer-close-${suffix}`, command: 'closeExpediente', fromStatus: 'OPEN', toStatus: 'CLOSED', eventData: { metadataValid: true, closureMetadata: { reason: 'Ready for preservation worker' } }, authorizationContext: authorization });
    await createArchiveTransferAndDraftManifestAtomically(db(), { institutionId, expedienteId, transferId, manifestId, actorUserId: userId, correlationId: `worker-transfer-draft-${suffix}`, authorizationContext: authorization });
    await approveArchiveTransferManifestAtomically(db(), { institutionId, transferId, actorUserId: userId, correlationId: `worker-transfer-approve-${suffix}`, authorizationContext: authorization });
    const job = await db().selectFrom('integration_jobs').select('id').where('institution_id', '=', institutionId).where('aggregate_id', '=', transferId).where('job_type', '=', 'archive_transfer.preserve').executeTakeFirstOrThrow();
    return { transferId, expedienteId, jobId: job.id };
  }
  async function createPendingVersion(versionId: string, documentId: string): Promise<string> {
    const key = `v1/${institutionId}/${versionId}`;
    const matterId = `33000000-0000-4000-8000-${versionId.slice(-12)}`;
    await db().insertInto('matters').values({ id: matterId, institution_id: institutionId, folio: `OP-2045-${versionId.slice(-6)}`, folio_year: 2045, sequence_number: Number.parseInt(versionId.slice(-6), 10) || 1, status: 'RECEIVED', received_at: new Date(), intake_metadata: { operationalVisibility: 'INSTITUTION' }, destination_unit_id: unitId, access_classification_id: classificationId, created_by: userId }).execute();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const accepted = await acceptMatterDocumentUploadAtomically(db(), { documentId, versionId, institutionId, matterId, documentType: 'official', title: 'Worker test', originalFilename: 'test.pdf', detectedMimeType: 'application/pdf', sizeBytes: String(bytes.byteLength), sha256: createHash('sha256').update(bytes).digest('hex'), storageKey: key, malwareScanStatus: 'PENDING_SCAN', createdBy: userId, correlationId: `worker-${versionId}`, authorizationContext: { userId, institutionId, institutionCapabilities: new Set(['records.read', 'document.version_open']), unitCapabilities: new Map() } });
    objects.set(`QUARANTINE:${key}`, bytes);
    return accepted.job.id;
  }

  it('claims, scans clean, promotes, and cleans quarantine', async () => {
    const versionId = '33000000-0000-4000-8000-000000000011';
    const documentId = '33000000-0000-4000-8000-000000000012';
    await createPendingVersion(versionId, documentId);
    scannerVerdict = 'CLEAN';
    const dependencies: MalwareScanWorkerDependencies = { database: db(), storage, scanner };
    expect(await runMalwareScanOnce(dependencies, 10)).toBe(1);
    expect((await db().selectFrom('document_versions').select('malware_scan_status').where('id', '=', versionId).executeTakeFirstOrThrow()).malware_scan_status).toBe('CLEAN');
    expect((await db().selectFrom('integration_jobs').select('status').where('aggregate_id', '=', versionId).executeTakeFirstOrThrow()).status).toBe('SUCCEEDED');
    expect(objects.has(`CLEAN:v1/${institutionId}/${versionId}`)).toBe(true);
    expect(objects.has(`QUARANTINE:v1/${institutionId}/${versionId}`)).toBe(false);
  });

  it('records infected verdict without exposing or deleting quarantine', async () => {
    const versionId = '33000000-0000-4000-8000-000000000013';
    const documentId = '33000000-0000-4000-8000-000000000014';
    await createPendingVersion(versionId, documentId);
    scannerVerdict = 'INFECTED';
    await runMalwareScanOnce({ database: db(), storage, scanner });
    expect((await db().selectFrom('document_versions').select('malware_scan_status').where('id', '=', versionId).executeTakeFirstOrThrow()).malware_scan_status).toBe('QUARANTINED');
    expect(objects.has(`QUARANTINE:v1/${institutionId}/${versionId}`)).toBe(true);
  });

  it('reclaims a stale running job with a fresh claim', async () => {
    const versionId = '33000000-0000-4000-8000-000000000015';
    const documentId = '33000000-0000-4000-8000-000000000016';
    const jobId = await createPendingVersion(versionId, documentId);
    const firstClaim = await claimMalwareScanJobs(db(), institutionId, 1, new Date('2045-01-01T00:00:00Z'), 1);
    expect(firstClaim.find((job) => job.id === jobId)?.status).toBe('RUNNING');
    scannerVerdict = 'CLEAN';
    expect(await runMalwareScanOnce({ database: db(), storage, scanner }, 10, new Date('2045-01-01T00:00:02Z'), 1)).toBe(1);
    expect(await db().selectFrom('integration_jobs').select(['status', 'attempt_count']).where('id', '=', jobId).executeTakeFirstOrThrow()).toMatchObject({ status: 'SUCCEEDED', attempt_count: 2 });
  });

  it('fails closed when scanned bytes do not match the authoritative hash', async () => {
    const versionId = '33000000-0000-4000-8000-000000000017';
    const documentId = '33000000-0000-4000-8000-000000000018';
    await createPendingVersion(versionId, documentId);
    objects.set(`QUARANTINE:v1/${institutionId}/${versionId}`, new Uint8Array([9, 9, 9, 9]));
    scannerVerdict = 'CLEAN';
    await runMalwareScanOnce({ database: db(), storage, scanner });
    expect((await db().selectFrom('document_versions').select('malware_scan_status').where('id', '=', versionId).executeTakeFirstOrThrow()).malware_scan_status).toBe('SCAN_FAILED');
    expect((await db().selectFrom('integration_jobs').select('status').where('aggregate_id', '=', versionId).executeTakeFirstOrThrow()).status).toBe('FAILED');
    expect(objects.has(`CLEAN:v1/${institutionId}/${versionId}`)).toBe(false);
  });

  it('records scan failure when the scanner rejects before consuming the stream', async () => {
    const versionId = '33000000-0000-4000-8000-000000000019';
    const documentId = '33000000-0000-4000-8000-000000000020';
    await createPendingVersion(versionId, documentId);
    scannerFailure = new Error('clamd connection refused');
    await expect(runMalwareScanOnce({ database: db(), storage, scanner })).resolves.toBe(1);
    scannerFailure = undefined;
    expect((await db().selectFrom('document_versions').select('malware_scan_status').where('id', '=', versionId).executeTakeFirstOrThrow()).malware_scan_status).toBe('SCAN_FAILED');
  });

  it('records scan failure when the quarantine stream fails mid-read', async () => {
    const versionId = '33000000-0000-4000-8000-000000000021';
    const documentId = '33000000-0000-4000-8000-000000000022';
    await createPendingVersion(versionId, documentId);
    streamFailure = new Error('storage stream interrupted');
    await expect(runMalwareScanOnce({ database: db(), storage, scanner })).resolves.toBe(1);
    streamFailure = undefined;
    expect((await db().selectFrom('document_versions').select('malware_scan_status').where('id', '=', versionId).executeTakeFirstOrThrow()).malware_scan_status).toBe('SCAN_FAILED');
  });

  it('completes the operational register-to-resolve document pipeline', async () => {
    const matterId = '33000000-0000-4000-8000-000000000023';
    const documentId = '33000000-0000-4000-8000-000000000024';
    const versionId = '33000000-0000-4000-8000-000000000025';
    const assignmentId = '33000000-0000-4000-8000-000000000026';
    const bytes = new TextEncoder().encode('%PDF-1.7 complete pipeline\\n');
    const key = `v1/${institutionId}/${versionId}`;
    const authorization: AuthorizationContext = {
      userId,
      institutionId,
      institutionCapabilities: new Set<Capability>(['matter.assign', 'matter.start', 'matter.resolve', 'records.read', 'document.version_open']),
      unitCapabilities: new Map<string, ReadonlySet<Capability>>(),
    };

    await registerMatterAtomically(db(), {
      id: matterId,
      institutionId,
      receivedAt: new Date('2026-09-10T12:00:00.000Z'),
      createdBy: userId,
      actorUserId: userId,
      intakeMetadata: { sender: 'pipeline', subject: 'pipeline', description: 'pipeline', priority: 'NORMAL', channel: 'EMAIL', operationalVisibility: 'INSTITUTION' },
      correlationId: `pipeline-${matterId}`,
      year: 2026,
      destinationUnitId: unitId,
      accessClassificationId: classificationId,
    });
    await assignMatterAtomically(db(), {
      institutionId,
      matterId,
      assignmentId,
      unitId,
      userId,
      actorUserId: userId,
      correlationId: `pipeline-assign-${matterId}`,
      command: 'assignMatter',
      fromStatus: 'RECEIVED',
      authorizationContext: authorization,
    });
    await persistMatterTransition(db(), {
      institutionId,
      aggregateId: matterId,
      actorUserId: userId,
      correlationId: `pipeline-start-${matterId}`,
      command: 'startMatter',
      fromStatus: 'ASSIGNED',
      toStatus: 'IN_PROGRESS',
      authorizationContext: authorization,
    });
    await storage.put({ zone: 'QUARANTINE', key, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), sha256: createHash('sha256').update(bytes).digest('hex') });
    const accepted = await acceptMatterDocumentUploadAtomically(db(), {
      documentId,
      versionId,
      institutionId,
      matterId,
      documentType: 'official',
      title: 'Complete pipeline evidence',
      originalFilename: 'evidence.pdf',
      detectedMimeType: 'application/pdf',
      declaredMimeType: 'application/pdf',
      sizeBytes: String(bytes.byteLength),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      storageKey: key,
      malwareScanStatus: 'PENDING_SCAN',
      createdBy: userId,
      correlationId: `pipeline-upload-${matterId}`,
      authorizationContext: { ...authorization, institutionCapabilities: new Set<Capability>([...authorization.institutionCapabilities, 'matter.register']) },
    });
    expect(accepted.version.malware_scan_status).toBe('PENDING_SCAN');
    expect(accepted.job.job_type).toBe('document.malware_scan');
    expect(await runMalwareScanOnce({ database: db(), storage, scanner })).toBe(1);
    expect((await db().selectFrom('document_versions').select('malware_scan_status').where('id', '=', versionId).executeTakeFirstOrThrow()).malware_scan_status).toBe('CLEAN');
    expect(objects.has(`CLEAN:${key}`)).toBe(true);
    expect(objects.has(`QUARANTINE:${key}`)).toBe(false);
    const authorizedDownload = await authorizeMatterDocumentVersionDownload(db(), { institutionId, versionId, authorizationContext: authorization });
    expect(authorizedDownload).toMatchObject({ versionId, storageKey: key, detectedMimeType: 'application/pdf', sizeBytes: String(bytes.byteLength) });
    const downloaded = await storage.open({ zone: 'CLEAN', key });
    const downloadedReader = downloaded.getReader();
    const downloadedChunks: Uint8Array[] = [];
    while (true) {
      const next = await downloadedReader.read();
      if (next.done) break;
      downloadedChunks.push(next.value);
    }
    const downloadedBytes = new Uint8Array(downloadedChunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let downloadedOffset = 0;
    for (const chunk of downloadedChunks) {
      downloadedBytes.set(chunk, downloadedOffset);
      downloadedOffset += chunk.byteLength;
    }
    expect(new TextDecoder().decode(downloadedBytes)).toContain('%PDF-1.7 complete pipeline');
    await persistMatterTransition(db(), {
      institutionId,
      aggregateId: matterId,
      actorUserId: userId,
      correlationId: `pipeline-resolve-${matterId}`,
      command: 'resolveMatter',
      fromStatus: 'IN_PROGRESS',
      toStatus: 'RESOLVED',
      eventData: { resolutionMetadata: { outcome: 'document processed' } },
      authorizationContext: authorization,
    });
    expect((await db().selectFrom('matters').select(['status', 'resolution_metadata']).where('id', '=', matterId).executeTakeFirstOrThrow())).toMatchObject({ status: 'RESOLVED', resolution_metadata: { outcome: 'document processed' } });
    expect((await db().selectFrom('matter_state_events').select('to_status').where('matter_id', '=', matterId).orderBy('occurred_at').orderBy('id').execute()).map((event) => event.to_status)).toEqual(['RECEIVED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED']);
    expect((await db().selectFrom('audit_events').select('event_type').where('aggregate_id', '=', matterId).execute()).map((event) => event.event_type)).toEqual(expect.arrayContaining(['matter.registered', 'matter.assigned', 'matter.started', 'matter.resolved']));
  });

  it('completes the Step 6 expediente lifecycle through clean closure', async () => {
    const typeId = '33000000-0000-4000-8000-000000000027';
    const typeVersionId = '33000000-0000-4000-8000-000000000028';
    const expedienteId = '33000000-0000-4000-8000-000000000029';
    const matterId = '33000000-0000-4000-8000-000000000030';
    const assignmentId = '33000000-0000-4000-8000-000000000031';
    const documentId = '33000000-0000-4000-8000-000000000032';
    const versionId = '33000000-0000-4000-8000-000000000033';
    const correlation = `step6-${expedienteId}`;
    const authorization: AuthorizationContext = {
      userId,
      institutionId,
      institutionCapabilities: new Set<Capability>([
        'expediente.create', 'expediente.edit_open', 'expediente.close', 'records.read', 'document.version_open',
        'matter.assign', 'matter.start', 'matter.resolve', 'matter.close', 'archive_transfer.prepare', 'archive_transfer.approve',
      ]),
      unitCapabilities: new Map<string, ReadonlySet<Capability>>(),
    };
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
    await db().insertInto('expediente_types').values({ id: typeId, institution_id: institutionId, code: 'STEP6', name: 'Step 6 type', status: 'ACTIVE' }).execute();
    await db().insertInto('expediente_type_versions').values({ id: typeVersionId, institution_id: institutionId, expediente_type_id: typeId, version_number: 1, status: 'PUBLISHED', schema_json: schema, archival_mapping_json: { levelOfDescription: 'File' }, published_at: new Date('2026-01-01T00:00:00.000Z') }).execute();
    const validator = createExpedienteSchemaValidator();
    await createExpedienteAtomically(db(), { id: expedienteId, institutionId, expedienteTypeVersionId: typeVersionId, metadata: { title: 'Integrated expediente' }, actorUserId: userId, correlationId: `${correlation}-create` }, validator.validateMetadata);
    const expediente = await db().selectFrom('expedientes').selectAll().where('institution_id', '=', institutionId).where('id', '=', expedienteId).executeTakeFirstOrThrow();
    expect(expediente.status).toBe('OPEN');
    expect(expediente.folio).toMatch(/^EXP-[0-9]{4}-[0-9]{6}$/);
    expect(expediente.expediente_type_version_id).toBe(typeVersionId);
    expect(await db().selectFrom('expediente_state_events').select('to_status').where('institution_id', '=', institutionId).where('expediente_id', '=', expedienteId).execute()).toEqual([{ to_status: 'OPEN' }]);
    expect((await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionId).where('aggregate_type', '=', 'expediente').where('aggregate_id', '=', expedienteId).execute()).map((event) => event.event_type)).toContain('expediente.created');

    await registerMatterAtomically(db(), { id: matterId, institutionId, receivedAt: new Date('2026-09-14T12:00:00.000Z'), createdBy: userId, actorUserId: userId, intakeMetadata: { sender: 'step6', subject: 'Integrated workflow', description: 'End-to-end expediente workflow', priority: 'NORMAL', channel: 'EMAIL', operationalVisibility: 'INSTITUTION' }, correlationId: `${correlation}-matter`, year: 2026, destinationUnitId: unitId, accessClassificationId: classificationId });
    await assignMatterAtomically(db(), { institutionId, matterId, assignmentId, unitId, userId, actorUserId: userId, correlationId: `${correlation}-assign`, command: 'assignMatter', fromStatus: 'RECEIVED', authorizationContext: authorization });
    await persistMatterTransition(db(), { institutionId, aggregateId: matterId, actorUserId: userId, correlationId: `${correlation}-start`, command: 'startMatter', fromStatus: 'ASSIGNED', toStatus: 'IN_PROGRESS', authorizationContext: authorization });
    expect((await db().selectFrom('matters').select('status').where('id', '=', matterId).executeTakeFirstOrThrow()).status).toBe('IN_PROGRESS');

    await linkMatterToExpedienteAtomically(db(), { institutionId, matterId, expedienteId, actorUserId: userId, correlationId: `${correlation}-link`, authorizationContext: authorization });
    expect(await db().selectFrom('matters').select(['status', 'linked_expediente_id']).where('id', '=', matterId).executeTakeFirstOrThrow()).toMatchObject({ status: 'IN_PROGRESS', linked_expediente_id: expedienteId });
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionId).where('aggregate_type', '=', 'matter').where('aggregate_id', '=', matterId).execute()).toEqual(expect.arrayContaining([{ event_type: 'matter.linked_to_expediente' }]));
    expect(await db().selectFrom('matter_state_events').select('command').where('institution_id', '=', institutionId).where('matter_id', '=', matterId).execute()).not.toEqual(expect.arrayContaining([{ command: 'linkMatterToExpediente' }]));

    const bytes = new TextEncoder().encode('%PDF-1.7 step6 expediente evidence\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const storageKey = `v1/${institutionId}/${versionId}`;
    await storage.put({ zone: 'QUARANTINE', key: storageKey, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), sha256 });
    const accepted = await acceptExpedienteDocumentUploadAtomically(db(), { institutionId, expedienteId, documentId, versionId, documentType: 'official', title: 'Expediente evidence', accessClassificationId: classificationId, originalFilename: 'evidence.pdf', detectedMimeType: 'application/pdf', declaredMimeType: 'application/pdf', sizeBytes: String(bytes.byteLength), sha256, storageKey, malwareScanStatus: 'PENDING_SCAN', createdBy: userId, correlationId: `${correlation}-document`, authorizationContext: authorization });
    expect(accepted.document).toMatchObject({ matter_id: null, expediente_id: expedienteId, current_version_id: versionId });
    expect(accepted.version).toMatchObject({ version_number: 1, malware_scan_status: 'PENDING_SCAN' });
    expect(accepted.job).toMatchObject({ job_type: 'document.malware_scan', aggregate_id: versionId, status: 'PENDING' });
    expect(accepted.version.access_classification_snapshot).toMatchObject({ legalClassification: 'PUBLIC', operationalVisibility: 'INSTITUTION' });
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionId).where('aggregate_id', '=', documentId).execute()).toEqual(expect.arrayContaining([{ event_type: 'document.created' }, { event_type: 'document.version_created' }]));

    await expect(persistExpedienteTransition(db(), { institutionId, aggregateId: expedienteId, actorUserId: userId, correlationId: `${correlation}-close-early`, command: 'closeExpediente', fromStatus: 'OPEN', toStatus: 'CLOSED', eventData: { metadataValid: true, closureMetadata: { reason: 'Matter still active' } }, authorizationContext: authorization })).rejects.toThrow(/linked matters/i);
    expect((await db().selectFrom('expedientes').select('status').where('id', '=', expedienteId).executeTakeFirstOrThrow()).status).toBe('OPEN');
    expect(await db().selectFrom('expediente_state_events').select('command').where('expediente_id', '=', expedienteId).where('command', '=', 'closeExpediente').execute()).toHaveLength(0);
    expect(await db().selectFrom('audit_events').select('event_type').where('aggregate_type', '=', 'expediente').where('aggregate_id', '=', expedienteId).where('event_type', '=', 'expediente.closed').execute()).toHaveLength(0);

    await persistMatterTransition(db(), { institutionId, aggregateId: matterId, actorUserId: userId, correlationId: `${correlation}-resolve`, command: 'resolveMatter', fromStatus: 'IN_PROGRESS', toStatus: 'RESOLVED', eventData: { resolutionMetadata: { outcome: 'Resolved for archive' } }, authorizationContext: authorization });
    await persistMatterTransition(db(), { institutionId, aggregateId: matterId, actorUserId: userId, correlationId: `${correlation}-close-matter`, command: 'closeMatter', fromStatus: 'RESOLVED', toStatus: 'CLOSED', eventData: { closureMetadata: { reason: 'Completed' } }, authorizationContext: authorization });
    const closedMatter = await db().selectFrom('matters').select(['status', 'linked_expediente_id', 'closure_metadata']).where('id', '=', matterId).executeTakeFirstOrThrow();
    expect(closedMatter).toMatchObject({ status: 'CLOSED', linked_expediente_id: expedienteId, closure_metadata: { reason: 'Completed' } });
    const matterCloseEvent = await db().selectFrom('matter_state_events').select('event_data').where('matter_id', '=', matterId).where('command', '=', 'closeMatter').executeTakeFirstOrThrow();
    expect(matterCloseEvent.event_data).toMatchObject({ linkedExpedienteId: expedienteId });
    expect(await db().selectFrom('audit_events').select('event_type').where('aggregate_type', '=', 'matter').where('aggregate_id', '=', matterId).where('event_type', '=', 'matter.linked_to_expediente').execute()).toHaveLength(1);

    await expect(persistExpedienteTransition(db(), { institutionId, aggregateId: expedienteId, actorUserId: userId, correlationId: `${correlation}-close-pending`, command: 'closeExpediente', fromStatus: 'OPEN', toStatus: 'CLOSED', eventData: { metadataValid: true, closureMetadata: { reason: 'Awaiting scan' } }, authorizationContext: authorization })).rejects.toThrow(/clean malware/i);
    expect((await db().selectFrom('expedientes').select('status').where('id', '=', expedienteId).executeTakeFirstOrThrow()).status).toBe('OPEN');
    expect(await db().selectFrom('audit_events').select('event_type').where('aggregate_type', '=', 'expediente').where('aggregate_id', '=', expedienteId).where('event_type', '=', 'expediente.closed').execute()).toHaveLength(0);

    expect(await runMalwareScanOnce({ database: db(), storage, scanner })).toBe(1);
    expect((await db().selectFrom('document_versions').select(['malware_scan_status', 'sha256', 'size_bytes']).where('id', '=', versionId).executeTakeFirstOrThrow())).toMatchObject({ malware_scan_status: 'CLEAN', sha256, size_bytes: String(bytes.byteLength) });
    expect((await db().selectFrom('integration_jobs').select('status').where('aggregate_id', '=', versionId).executeTakeFirstOrThrow()).status).toBe('SUCCEEDED');
    expect(objects.has(`CLEAN:${storageKey}`)).toBe(true);
    expect(objects.has(`QUARANTINE:${storageKey}`)).toBe(false);

    await persistExpedienteTransition(db(), { institutionId, aggregateId: expedienteId, actorUserId: userId, correlationId: `${correlation}-close-final`, command: 'closeExpediente', fromStatus: 'OPEN', toStatus: 'CLOSED', eventData: { metadataValid: true, closureMetadata: { reason: 'Ready for closure' } }, authorizationContext: authorization });
    expect((await db().selectFrom('expedientes').select(['status', 'closed_at']).where('id', '=', expedienteId).executeTakeFirstOrThrow())).toMatchObject({ status: 'CLOSED' });
    expect((await db().selectFrom('expedientes').select('closed_at').where('id', '=', expedienteId).executeTakeFirstOrThrow()).closed_at).not.toBeNull();
    expect(await db().selectFrom('expediente_state_events').select(['from_status', 'to_status', 'command']).where('expediente_id', '=', expedienteId).execute()).toEqual(expect.arrayContaining([{ from_status: 'OPEN', to_status: 'CLOSED', command: 'closeExpediente' }]));
    expect(await db().selectFrom('expediente_state_events').select('command').where('expediente_id', '=', expedienteId).where('command', '=', 'closeExpediente').execute()).toHaveLength(1);
    expect(await db().selectFrom('audit_events').select('event_type').where('aggregate_type', '=', 'expediente').where('aggregate_id', '=', expedienteId).where('event_type', '=', 'expediente.closed').execute()).toHaveLength(1);
    expect(await db().selectFrom('matters').select(['status', 'linked_expediente_id']).where('id', '=', matterId).executeTakeFirstOrThrow()).toMatchObject({ status: 'CLOSED', linked_expediente_id: expedienteId });
    expect((await db().selectFrom('documents').select(['matter_id', 'expediente_id', 'current_version_id']).where('id', '=', documentId).executeTakeFirstOrThrow())).toMatchObject({ matter_id: null, expediente_id: expedienteId, current_version_id: versionId });
    expect((await db().selectFrom('document_versions').select('malware_scan_status').where('id', '=', versionId).executeTakeFirstOrThrow()).malware_scan_status).toBe('CLEAN');
    await expect(authorizeDocumentVersionUploadPreflight(db(), { institutionId, documentId, actorUserId: userId, authorizationContext: authorization })).rejects.toThrow(/not open/i);
    expect((await db().selectFrom('matter_state_events').select('to_status').where('matter_id', '=', matterId).orderBy('occurred_at').orderBy('id').execute()).map((event) => event.to_status)).toEqual(['RECEIVED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);

    const transferId = '33000000-0000-4000-8000-000000000034';
    const manifestId = '33000000-0000-4000-8000-000000000035';
    const draft = await createArchiveTransferAndDraftManifestAtomically(db(), { institutionId, expedienteId, transferId, manifestId, actorUserId: userId, correlationId: `${correlation}-transfer-create`, authorizationContext: authorization });
    expect(draft.transfer.status).toBe('DRAFT');
    expect(draft.manifest.status).toBe('DRAFT');
    expect((await db().selectFrom('expedientes').select('status').where('institution_id', '=', institutionId).where('id', '=', expedienteId).executeTakeFirstOrThrow()).status).toBe('TRANSFER_PENDING');
    expect(await db().selectFrom('expediente_state_events').select(['from_status', 'to_status', 'command']).where('expediente_id', '=', expedienteId).where('command', '=', 'prepareTransfer').execute()).toEqual([{ from_status: 'CLOSED', to_status: 'TRANSFER_PENDING', command: 'prepareTransfer' }]);
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionId).where('aggregate_type', '=', 'archive_transfer').where('aggregate_id', '=', transferId).execute()).toEqual(expect.arrayContaining([{ event_type: 'archive_transfer.created' }]));
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionId).where('aggregate_type', '=', 'transfer_manifest').where('aggregate_id', '=', manifestId).execute()).toEqual(expect.arrayContaining([{ event_type: 'transfer_manifest.created' }]));
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionId).where('aggregate_type', '=', 'expediente').where('aggregate_id', '=', expedienteId).execute()).toEqual(expect.arrayContaining([{ event_type: 'expediente.transfer_prepared' }]));

    const draftCanonicalJson = draft.manifest.canonical_json;
    const canonical = JSON.parse(draftCanonicalJson) as { transferId: string; expedienteId: string; folio: string; closedAt: string | null; metadataSnapshot: { title: string }; documents: Array<{ documentId: string; versionId: string; versionNumber: number; filename: string; sha256: string; sizeBytes: string; mimeType: string; current: boolean }> };
    expect(canonical).toMatchObject({ transferId, expedienteId, folio: expediente.folio, metadataSnapshot: { title: 'Integrated expediente' } });
    expect(typeof canonical.closedAt).toBe('string');
    expect(canonical.documents).toEqual([{ documentId, versionId, versionNumber: 1, filename: 'evidence.pdf', sha256, sizeBytes: String(bytes.byteLength), mimeType: 'application/pdf', current: true }]);

    const approvedTransfer = await approveArchiveTransferManifestAtomically(db(), { institutionId, transferId, actorUserId: userId, correlationId: `${correlation}-transfer-approve`, authorizationContext: authorization });
    const approvedSha256 = createHash('sha256').update(draftCanonicalJson).digest('hex');
    expect(approvedTransfer.transfer.status).toBe('APPROVED');
    expect(approvedTransfer.manifest.status).toBe('APPROVED');
    expect(approvedTransfer.manifest.approved_by).toBe(userId);
    expect(approvedTransfer.manifest.approved_at).not.toBeNull();
    expect(approvedTransfer.manifest.canonical_json).toBe(draftCanonicalJson);
    expect(approvedTransfer.manifest.sha256).toBe(approvedSha256);
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionId).where('aggregate_type', '=', 'transfer_manifest').where('aggregate_id', '=', manifestId).execute()).toEqual(expect.arrayContaining([{ event_type: 'transfer_manifest.created' }, { event_type: 'transfer_manifest.approved' }]));
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionId).where('aggregate_type', '=', 'archive_transfer').where('aggregate_id', '=', transferId).execute()).toEqual(expect.arrayContaining([{ event_type: 'archive_transfer.created' }, { event_type: 'archive_transfer.approved' }]));
    expect((await db().selectFrom('expedientes').select('status').where('institution_id', '=', institutionId).where('id', '=', expedienteId).executeTakeFirstOrThrow()).status).toBe('TRANSFER_PENDING');
    expect((await db().selectFrom('archive_transfers').select('status').where('institution_id', '=', institutionId).where('id', '=', transferId).executeTakeFirstOrThrow()).status).toBe('APPROVED');
    expect((await db().selectFrom('transfer_manifests').select(['status', 'canonical_json', 'sha256', 'approved_by', 'approved_at']).where('institution_id', '=', institutionId).where('id', '=', manifestId).executeTakeFirstOrThrow())).toMatchObject({ status: 'APPROVED', canonical_json: draftCanonicalJson, sha256: approvedSha256, approved_by: userId });
    expect(await db().selectFrom('integration_jobs').select(['status', 'idempotency_key']).where('institution_id', '=', institutionId).where('job_type', '=', 'archive_transfer.preserve').where('aggregate_id', '=', transferId).execute()).toEqual([{ status: 'PENDING', idempotency_key: `archive-transfer-preserve:${transferId}` }]);
    expect((await db().selectFrom('matter_state_events').select('to_status').where('matter_id', '=', matterId).orderBy('occurred_at').orderBy('id').execute()).map((event) => event.to_status)).toEqual(['RECEIVED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
    expect((await db().selectFrom('expediente_state_events').select('to_status').where('expediente_id', '=', expedienteId).orderBy('occurred_at').orderBy('id').execute()).map((event) => event.to_status)).toEqual(['OPEN', 'CLOSED', 'TRANSFER_PENDING']);
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionId).where('aggregate_type', '=', 'expediente').where('aggregate_id', '=', expedienteId).execute()).toEqual(expect.arrayContaining([{ event_type: 'expediente.created' }, { event_type: 'expediente.closed' }, { event_type: 'expediente.transfer_prepared' }]));
  });

  it('orchestrates an approved archive preservation intent through completion', async () => {
    const fixture = await createApprovedArchiveTransfer(6);
    const executions: PreservationExecutionInput[] = [];
    const dependencies: ArchiveTransferWorkerDependencies = {
      database: db(),
      preservation: {
        execute(input) {
          executions.push(input);
          return Promise.resolve({ approvedManifestPreserved: true, aipStored: true, archivalIntegrationCompleted: true });
        },
      },
    };
    expect(await runArchiveTransferPreservationOnce(dependencies)).toBeGreaterThanOrEqual(1);
    expect(executions).toEqual(expect.arrayContaining([expect.objectContaining({ institutionId, transferId: fixture.transferId, expedienteId: fixture.expedienteId })]));
    expect((await db().selectFrom('archive_transfers').select('status').where('id', '=', fixture.transferId).executeTakeFirstOrThrow()).status).toBe('COMPLETED');
    expect((await db().selectFrom('expedientes').select('status').where('id', '=', fixture.expedienteId).executeTakeFirstOrThrow()).status).toBe('TRANSFERRED');
    expect((await db().selectFrom('integration_jobs').select(['status', 'claim_token']).where('id', '=', fixture.jobId).executeTakeFirstOrThrow())).toMatchObject({ status: 'SUCCEEDED', claim_token: null });
    expect(await db().selectFrom('audit_events').select('event_type').where('aggregate_id', '=', fixture.transferId).execute()).toEqual(expect.arrayContaining([{ event_type: 'archive_transfer.submitted' }, { event_type: 'archive_transfer.preserving' }, { event_type: 'archive_transfer.completed' }]));
  });

  it('reclaims stale archive preservation work and fails execution durably', async () => {
    const fixture = await createApprovedArchiveTransfer(7);
    const firstClaim = await claimArchiveTransferPreservationJobs(db(), institutionId, 1, new Date('2045-01-01T00:00:00Z'), 1);
    expect(firstClaim.find((job) => job.id === fixture.jobId)?.status).toBe('RUNNING');
    let executionCount = 0;
    const dependencies: ArchiveTransferWorkerDependencies = {
      database: db(),
      preservation: {
        execute() {
          executionCount += 1;
          return Promise.reject(new Error('preservation connector unavailable'));
        },
      },
    };
    expect(await runArchiveTransferPreservationOnce(dependencies, 10, new Date('2045-01-01T00:00:02Z'), 1)).toBe(1);
    expect(executionCount).toBe(1);
    expect((await db().selectFrom('archive_transfers').select('status').where('id', '=', fixture.transferId).executeTakeFirstOrThrow()).status).toBe('FAILED');
    expect((await db().selectFrom('integration_jobs').select(['status', 'attempt_count', 'last_error']).where('id', '=', fixture.jobId).executeTakeFirstOrThrow())).toMatchObject({ status: 'FAILED', attempt_count: 2, last_error: 'preservation connector unavailable' });
  });
});
