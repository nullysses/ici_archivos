import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { applyFoundationMigrations, createDatabase, type Database } from './index.js';

const institutionA = '70000000-0000-4000-8000-000000000001';
const institutionB = '70000000-0000-4000-8000-000000000002';
const userA = '70000000-0000-4000-8000-000000000003';
const userB = '70000000-0000-4000-8000-000000000004';
const matterA = '70000000-0000-4000-8000-000000000005';
const matterB = '70000000-0000-4000-8000-000000000006';
const documentA = '70000000-0000-4000-8000-000000000007';
const documentB = '70000000-0000-4000-8000-000000000008';
const documentSerial = '70000000-0000-4000-8000-000000000009';
const documentState = '70000000-0000-4000-8000-00000000000a';
const now = new Date('2026-09-11T12:00:00.000Z');

describe('document-intake hardening migration', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let database: Database | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    database = createDatabase(container.getConnectionUri());
    await sql`CREATE ROLE ici_app NOLOGIN NOSUPERUSER NOBYPASSRLS`.execute(database);
    await applyFoundationMigrations(database);
    await database.insertInto('institutions').values([
      { id: institutionA, code: 'INTAKE-A', name: 'Intake A', status: 'ACTIVE' },
      { id: institutionB, code: 'INTAKE-B', name: 'Intake B', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('users').values([
      { id: userA, institution_id: institutionA, display_name: 'A', status: 'ACTIVE' },
      { id: userB, institution_id: institutionB, display_name: 'B', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('matters').values([
      { id: matterA, institution_id: institutionA, folio: 'OP-2026-000701', folio_year: 2026, sequence_number: 701, status: 'RECEIVED', received_at: now, intake_metadata: { operationalVisibility: 'INSTITUTION' } },
      { id: matterB, institution_id: institutionB, folio: 'OP-2026-000701', folio_year: 2026, sequence_number: 701, status: 'RECEIVED', received_at: now, intake_metadata: { operationalVisibility: 'INSTITUTION' } },
    ]).execute();
    await database.insertInto('documents').values([
      { id: documentA, institution_id: institutionA, matter_id: matterA, document_type: 'record', title: 'A' },
      { id: documentB, institution_id: institutionB, matter_id: matterB, document_type: 'record', title: 'B' },
      { id: documentSerial, institution_id: institutionA, matter_id: matterA, document_type: 'record', title: 'Serial' },
      { id: documentState, institution_id: institutionA, matter_id: matterA, document_type: 'record', title: 'State' },
    ]).execute();
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
    await container?.stop();
  });

  function db(): Database {
    if (database === undefined) throw new Error('Database unavailable');
    return database;
  }

  const versionValues = (id: string, documentId: string, storageKey: string, versionNumber = 1) => ({
    id,
    institution_id: institutionA,
    document_id: documentId,
    version_number: versionNumber,
    original_filename: `${id}.pdf`,
    detected_mime_type: 'application/pdf',
    declared_mime_type: 'application/pdf',
    size_bytes: 12,
    sha256: id.replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
    storage_key: storageKey,
    malware_scan_status: 'PENDING_SCAN' as const,
    created_by: userA,
  });

  it('enforces malware transitions and append-only scan attempts', async () => {
    const version = '70000000-0000-4000-8000-000000000010';
    await db().insertInto('document_versions').values(versionValues(version, documentA, 'state-one')).execute();
    await db().updateTable('document_versions').set({ malware_scan_status: 'CLEAN' }).where('id', '=', version).execute();
    await expect(db().updateTable('document_versions').set({ malware_scan_status: 'INFECTED' }).where('id', '=', version).execute()).rejects.toThrow(/invalid malware scan transition/i);

    const scan = '70000000-0000-4000-8000-000000000011';
    await db().insertInto('malware_scans').values({ id: scan, institution_id: institutionA, document_version_id: version, engine: 'clamd', result: 'CLEAN', scanned_at: now }).execute();
    await expect(db().updateTable('malware_scans').set({ result: 'INFECTED' }).where('id', '=', scan).execute()).rejects.toThrow(/append-only/i);
    await expect(db().deleteFrom('malware_scans').where('id', '=', scan).execute()).rejects.toThrow(/append-only/i);
  });

  it('allows only the documented retry and quarantine transitions', async () => {
    const version = '70000000-0000-4000-8000-000000000012';
    await db().insertInto('document_versions').values(versionValues(version, documentState, 'state-two')).execute();
    await db().updateTable('document_versions').set({ malware_scan_status: 'SCAN_FAILED' }).where('id', '=', version).execute();
    await db().updateTable('document_versions').set({ malware_scan_status: 'PENDING_SCAN' }).where('id', '=', version).execute();
    await db().updateTable('document_versions').set({ malware_scan_status: 'INFECTED' }).where('id', '=', version).execute();
    await db().updateTable('document_versions').set({ malware_scan_status: 'QUARANTINED' }).where('id', '=', version).execute();
    await expect(db().updateTable('document_versions').set({ malware_scan_status: 'CLEAN' }).where('id', '=', version).execute()).rejects.toThrow(/invalid malware scan transition/i);
  });

  it('enforces institution-scoped storage-key uniqueness without deduplicating hashes', async () => {
    const first = '70000000-0000-4000-8000-000000000013';
    await db().insertInto('document_versions').values({ ...versionValues(first, documentA, 'shared-storage-key', 2), replacement_reason: 'Storage key test' }).execute();
    const sameInstitutionDocument = '70000000-0000-4000-8000-000000000014';
    await db().insertInto('documents').values({ id: sameInstitutionDocument, institution_id: institutionA, matter_id: matterA, document_type: 'record', title: 'Same tenant' }).execute();
    await expect(db().insertInto('document_versions').values(versionValues('70000000-0000-4000-8000-000000000015', sameInstitutionDocument, 'shared-storage-key')).execute()).rejects.toThrow(/storage_key/i);
    await expect(db().insertInto('document_versions').values({ ...versionValues('70000000-0000-4000-8000-000000000016', documentB, 'shared-storage-key'), institution_id: institutionB, created_by: userB }).execute()).resolves.toBeDefined();
  });

  it('serializes direct SQL version creation by locking the logical document before MAX', async () => {
    const firstId = '70000000-0000-4000-8000-000000000017';
    const secondId = '70000000-0000-4000-8000-000000000018';
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => { signalFirst = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = db().transaction().execute(async (transaction) => {
      await transaction.insertInto('document_versions').values(versionValues(firstId, documentSerial, 'serial-one')).execute();
      signalFirst();
      await firstRelease;
    });
    await firstReady;
    const second = db().transaction().execute((transaction) => transaction.insertInto('document_versions').values({ ...versionValues(secondId, documentSerial, 'serial-two', 2), replacement_reason: 'Replacement' }).execute());
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseFirst();
    await Promise.all([first, second]);
    const versions = await db().selectFrom('document_versions').select(['version_number', 'id']).where('document_id', '=', documentSerial).orderBy('version_number').execute();
    expect(versions.map((row) => row.version_number)).toEqual([1, 2]);
    await db().updateTable('documents').set({ current_version_id: secondId }).where('id', '=', documentSerial).execute();
  });
});
