import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { applyFoundationMigrations, createDatabase, createPreservationStagingStore, type Database } from './index.js';

const institutionId = '77000000-0000-4000-8000-000000000001';
const expedienteId = '77000000-0000-4000-8000-000000000002';
const transferId = '77000000-0000-4000-8000-000000000003';
const locationUuid = '77000000-0000-4000-8000-000000000004';
const typeId = '77000000-0000-4000-8000-000000000005';
const typeVersionId = '77000000-0000-4000-8000-000000000006';

describe('durable preservation staging', () => {
  let database: Database | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    database = createDatabase(container.getConnectionUri());
    await sql`CREATE ROLE ici_app NOLOGIN NOSUPERUSER NOBYPASSRLS`.execute(database);
    await applyFoundationMigrations(database);
    await database.insertInto('institutions').values({ id: institutionId, code: 'STAGE', name: 'Staging test', status: 'ACTIVE' }).execute();
    await database.insertInto('expediente_types').values({ id: typeId, institution_id: institutionId, code: 'STAGE', name: 'Stage', status: 'ACTIVE' }).execute();
    await database.insertInto('expediente_type_versions').values({ id: typeVersionId, institution_id: institutionId, expediente_type_id: typeId, version_number: 1, status: 'PUBLISHED', schema_json: { type: 'object' }, archival_mapping_json: { levelOfDescription: 'File' }, created_at: new Date(), published_at: new Date() }).execute();
    await database.insertInto('expedientes').values({ id: expedienteId, institution_id: institutionId, folio: 'EXP-2046-000001', folio_year: 2046, sequence_number: 1, status: 'OPEN', expediente_type_version_id: typeVersionId, metadata: {}, opened_at: new Date() }).execute();
    await database.insertInto('archive_transfers').values({ id: transferId, institution_id: institutionId, expediente_id: expedienteId, status: 'DRAFT' }).execute();
  }, 120_000);
  afterAll(async () => { await database?.destroy(); await container?.stop(); });
  function db(): Database { if (database === undefined) throw new Error('database unavailable'); return database; }

  it('reserves one staging record and fences its completion', async () => {
    const store = createPreservationStagingStore(db());
    const input = { institutionId, archiveTransferId: transferId, locationUuid, relativePath: 'ici/transfer/hash', manifestSha256: 'a'.repeat(64) };
    const [first, second] = await Promise.all([store.reserve(input), store.reserve(input)]);
    expect([first.reserved, second.reserved].filter(Boolean)).toHaveLength(1);
    const staged = await store.markStaged({ institutionId, archiveTransferId: transferId, manifestSha256: input.manifestSha256 });
    expect(staged.status).toBe('STAGED');
    await expect(store.find({ institutionId: '77000000-0000-4000-0000-000000000099', archiveTransferId: transferId })).resolves.toBeUndefined();
  });
});
