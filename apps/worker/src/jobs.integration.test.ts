import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { applyFoundationMigrations, acceptMatterDocumentUploadAtomically, createDatabase, type Database } from '@ici/database';
import type { DocumentStoragePort } from '@ici/integration-storage';
import type { MalwareScannerPort } from '@ici/integration-malware';
import { runMalwareScanOnce, type MalwareScanWorkerDependencies } from './jobs.js';

const institutionId = '33000000-0000-4000-8000-000000000001';
const userId = '33000000-0000-4000-8000-000000000002';
const unitId = '33000000-0000-4000-8000-000000000003';
const classificationId = '33000000-0000-4000-8000-000000000004';

describe('durable malware worker', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let database: Database | undefined;
  const objects = new Map<string, Uint8Array>();
  const storage: DocumentStoragePort = {
    async put(input) { const reader = input.body.getReader(); const chunks: Uint8Array[] = []; while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); } const value = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0)); let offset = 0; for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.byteLength; } objects.set(`${input.zone}:${input.key}`, value); },
    open(input) { const value = objects.get(`${input.zone}:${input.key}`); if (value === undefined) return Promise.reject(new Error('missing object')); return Promise.resolve(new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } })); },
    head(input) { const value = objects.get(`${input.zone}:${input.key}`); return Promise.resolve(value === undefined ? undefined : { sizeBytes: BigInt(value.byteLength) }); },
    copy(input) { const value = objects.get(`${input.from}:${input.key}`); if (value === undefined) return Promise.reject(new Error('missing source')); objects.set(`${input.to}:${input.key}`, value); return Promise.resolve(); },
    remove(input) { objects.delete(`${input.zone}:${input.key}`); return Promise.resolve(); },
  };
  let scannerVerdict: 'CLEAN' | 'INFECTED' = 'CLEAN';
  const scanner: MalwareScannerPort = { scan() { return Promise.resolve({ verdict: scannerVerdict, engine: 'test-clamd', scannedAt: new Date() }); } };

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
    const accepted = await acceptMatterDocumentUploadAtomically(db(), { documentId, versionId, institutionId, matterId, documentType: 'official', title: 'Worker test', originalFilename: 'test.pdf', detectedMimeType: 'application/pdf', sizeBytes: '4', sha256: 'a'.repeat(64), storageKey: key, malwareScanStatus: 'PENDING_SCAN', createdBy: userId, correlationId: `worker-${versionId}`, authorizationContext: { userId, institutionId, institutionCapabilities: new Set(['records.read', 'document.version_open']), unitCapabilities: new Map() } });
    objects.set(`QUARANTINE:${key}`, new Uint8Array([1, 2, 3, 4]));
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
});
