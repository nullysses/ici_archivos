import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { applyFoundationMigrations, createArchivematicaTransferStore, createDatabase, type Database } from './index.js';

const institutionId = '88000000-0000-4000-8000-000000000001';
const typeId = '88000000-0000-4000-8000-000000000002';
const versionId = '88000000-0000-4000-8000-000000000003';
const expedienteId = '88000000-0000-4000-8000-000000000004';
const transferId = '88000000-0000-4000-8000-000000000005';
const locationId = '88000000-0000-4000-8000-000000000006';

describe('Archivematica durable references', () => {
  let database: Database | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    database = createDatabase(container.getConnectionUri());
    await sql`CREATE ROLE ici_app NOLOGIN NOSUPERUSER NOBYPASSRLS`.execute(database);
    await applyFoundationMigrations(database);
    await database.insertInto('institutions').values({ id: institutionId, code: 'ARCH', name: 'Archivematica test', status: 'ACTIVE' }).execute();
    await database.insertInto('expediente_types').values({ id: typeId, institution_id: institutionId, code: 'ARCH', name: 'Arch', status: 'ACTIVE' }).execute();
    await database.insertInto('expediente_type_versions').values({ id: versionId, institution_id: institutionId, expediente_type_id: typeId, version_number: 1, status: 'PUBLISHED', schema_json: { type: 'object' }, archival_mapping_json: { levelOfDescription: 'File' }, created_at: new Date(), published_at: new Date() }).execute();
    await database.insertInto('expedientes').values({ id: expedienteId, institution_id: institutionId, folio: 'EXP-2026-000001', folio_year: 2026, sequence_number: 1, status: 'OPEN', expediente_type_version_id: versionId, metadata: {}, opened_at: new Date() }).execute();
    await database.insertInto('archive_transfers').values({ id: transferId, institution_id: institutionId, expediente_id: expedienteId, status: 'DRAFT' }).execute();
  }, 120_000);
  afterAll(async () => { await database?.destroy(); await container?.stop(); });
  function db(): Database { if (database === undefined) throw new Error('Database unavailable'); return database; }

  it('reserves once, persists references, preserves them across observations, and isolates tenants', async () => {
    const store = createArchivematicaTransferStore(db());
    const input = { institutionId, archiveTransferId: transferId, processingConfiguration: 'automated', transferSourceLocationUuid: locationId, transferSourceRelativePath: 'transfer-1' };
    const [first, second] = await Promise.all([store.reserve(input), store.reserve(input)]);
    expect([first.reserved, second.reserved].filter(Boolean)).toHaveLength(1);
    const saved = await store.saveSubmission({ institutionId, archiveTransferId: transferId, archivematicaTransferUuid: '99000000-0000-4000-8000-000000000001' });
    await store.saveObservation({ institutionId, archiveTransferId: transferId, sipUuid: '99000000-0000-4000-8000-000000000002', aipUuid: '99000000-0000-4000-8000-000000000003' });
    const observed = await store.find({ institutionId, archiveTransferId: transferId });
    expect(saved.submissionStatus).toBe('SUBMITTED');
    expect(observed).toMatchObject({ archivematicaTransferUuid: '99000000-0000-4000-8000-000000000001', sipUuid: '99000000-0000-4000-8000-000000000002', aipUuid: '99000000-0000-4000-8000-000000000003' });
    await expect(store.saveObservation({ institutionId, archiveTransferId: transferId, sipUuid: '99000000-0000-4000-8000-000000000099' })).rejects.toMatchObject({ code: 'ARCHIVEMATICA_IDENTITY_CONFLICT' });
    await expect(store.find({ institutionId, archiveTransferId: transferId })).resolves.toMatchObject({ sipUuid: '99000000-0000-4000-8000-000000000002' });
    await expect(store.find({ institutionId: '88000000-0000-4000-0000-000000000099', archiveTransferId: transferId })).resolves.toBeUndefined();
  });
});
