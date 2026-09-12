import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { applyFoundationMigrations, acceptMatterDocumentUploadAtomically, assignMatterAtomically, authorizeMatterDocumentVersionDownload, claimMalwareScanJobs, createDatabase, persistMatterTransition, registerMatterAtomically, type Database } from '@ici/database';
import type { DocumentStoragePort } from '@ici/integration-storage';
import type { MalwareScannerPort } from '@ici/integration-malware';
import type { AuthorizationContext, Capability } from '@ici/database';
import { runMalwareScanOnce, type MalwareScanWorkerDependencies } from './jobs.js';

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
    await database.insertInto('access_classifications').values({ id: classificationId, institution_id: institutionId, legal_classification: 'PUBLIC', operational_visibility: 'INSTITUTION' }).execute();
  }, 120_000);
  afterAll(async () => { await database?.destroy(); await container?.stop(); });
  function db(): Database { if (database === undefined) throw new Error('database unavailable'); return database; }
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
});
