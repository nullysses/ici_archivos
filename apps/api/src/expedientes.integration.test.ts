import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { applyFoundationMigrations, createDatabase, type Database } from '@ici/database';
import { createApp } from './app.js';
import type { AuthenticatedPrincipal } from './auth.js';
import { createExpedienteApplicationService } from './expedientes.js';

const institutionA = '21000000-0000-4000-8000-000000000001';
const institutionB = '21000000-0000-4000-8000-000000000002';
const userA = '21000000-0000-4000-8000-000000000003';
const userB = '21000000-0000-4000-8000-00000000000a';
const typeA = '21000000-0000-4000-8000-000000000004';
const publishedVersionA = '21000000-0000-4000-8000-000000000005';
const draftVersionA = '21000000-0000-4000-8000-000000000006';
const retiredVersionA = '21000000-0000-4000-8000-000000000007';
const typeB = '21000000-0000-4000-8000-000000000008';
const publishedVersionB = '21000000-0000-4000-8000-000000000009';

describe('expediente core HTTP API with real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let database: Database | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let principal: AuthenticatedPrincipal;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    database = createDatabase(container.getConnectionUri());
    await sql`CREATE ROLE ici_app NOLOGIN NOSUPERUSER NOBYPASSRLS`.execute(database);
    await applyFoundationMigrations(database);
    await database.insertInto('institutions').values([
      { id: institutionA, code: 'EXP-A', name: 'Expediente A', status: 'ACTIVE' },
      { id: institutionB, code: 'EXP-B', name: 'Expediente B', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('users').values([
      { id: userA, institution_id: institutionA, display_name: 'Expediente operator', status: 'ACTIVE' },
      { id: userB, institution_id: institutionB, display_name: 'Other operator', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('expediente_types').values([
      { id: typeA, institution_id: institutionA, code: 'TYPE-A', name: 'Type A', status: 'ACTIVE' },
      { id: typeB, institution_id: institutionB, code: 'TYPE-B', name: 'Type B', status: 'ACTIVE' },
    ]).execute();
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
    await database.insertInto('expediente_type_versions').values([
      { id: publishedVersionA, institution_id: institutionA, expediente_type_id: typeA, version_number: 1, status: 'PUBLISHED', schema_json: schema, archival_mapping_json: {}, published_at: new Date('2026-01-01T00:00:00.000Z') },
      { id: draftVersionA, institution_id: institutionA, expediente_type_id: typeA, version_number: 3, status: 'DRAFT', schema_json: schema, archival_mapping_json: {} },
      { id: retiredVersionA, institution_id: institutionA, expediente_type_id: typeA, version_number: 2, status: 'DRAFT', schema_json: schema, archival_mapping_json: {} },
      { id: publishedVersionB, institution_id: institutionB, expediente_type_id: typeB, version_number: 1, status: 'PUBLISHED', schema_json: schema, archival_mapping_json: {}, published_at: new Date('2026-01-01T00:00:00.000Z') },
    ]).execute();
    await database.updateTable('expediente_type_versions').set({ status: 'PUBLISHED', published_at: new Date('2026-01-01T00:00:00.000Z') }).where('id', '=', retiredVersionA).execute();
    await database.updateTable('expediente_type_versions').set({ status: 'RETIRED' }).where('id', '=', retiredVersionA).execute();
    principal = {
      userId: userA,
      institutionId: institutionA,
      issuer: 'https://issuer.example.test',
      subject: 'expediente-subject',
      authorization: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(['expediente.create', 'records.read']), unitCapabilities: new Map() },
    };
    app = await createApp({
      authenticateAccessToken: () => Promise.resolve(principal),
      expedienteService: createExpedienteApplicationService(database),
      checkDatabase: () => Promise.resolve(true),
      version: 'test',
      webOrigin: 'http://localhost',
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await database?.destroy();
    await container?.stop();
  });

  function api(): Awaited<ReturnType<typeof createApp>> {
    if (app === undefined) throw new Error('API unavailable');
    return app;
  }

  function db(): Database {
    if (database === undefined) throw new Error('Database unavailable');
    return database;
  }

  it('creates and reads an expediente with a pinned published version atomically', async () => {
    const response = await api().inject({ method: 'POST', url: '/expedientes', headers: { authorization: 'Bearer test' }, payload: { expedienteTypeVersionId: publishedVersionA, metadata: { title: 'Solicitud' } } });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ id: string; folio: string; status: string; expedienteTypeVersionId: string; metadata: { title: string } }>();
    expect(body.folio).toMatch(/^EXP-[0-9]{4}-[0-9]{6}$/);
    expect(body).toMatchObject({ status: 'OPEN', expedienteTypeVersionId: publishedVersionA, metadata: { title: 'Solicitud' } });
    expect((await db().selectFrom('expedientes').selectAll().where('id', '=', body.id).execute())).toHaveLength(1);
    expect((await db().selectFrom('expediente_state_events').selectAll().where('expediente_id', '=', body.id).execute())).toHaveLength(1);
    expect((await db().selectFrom('audit_events').selectAll().where('aggregate_id', '=', body.id).where('event_type', '=', 'expediente.created').execute())).toHaveLength(1);
    const read = await api().inject({ method: 'GET', url: `/expedientes/${body.id}`, headers: { authorization: 'Bearer test' } });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: body.id, folio: body.folio, status: 'OPEN', expedienteTypeVersionId: publishedVersionA });
  });

  it('rejects unpublished, foreign, and invalid metadata before commit', async () => {
    for (const version of [draftVersionA, retiredVersionA, publishedVersionB]) {
      const response = await api().inject({ method: 'POST', url: '/expedientes', headers: { authorization: 'Bearer test' }, payload: { expedienteTypeVersionId: version, metadata: { title: 'Solicitud' } } });
      expect(response.statusCode).toBe(400);
    }
    const invalid = await api().inject({ method: 'POST', url: '/expedientes', headers: { authorization: 'Bearer test' }, payload: { expedienteTypeVersionId: publishedVersionA, metadata: {} } });
    expect(invalid.statusCode).toBe(400);
    expect(await db().selectFrom('expedientes').select('id').where('institution_id', '=', institutionA).execute()).toHaveLength(1);
  });

  it('requires institution-scoped capabilities and rejects system-field injection', async () => {
    principal = { ...principal, authorization: { ...principal.authorization, institutionCapabilities: new Set(), unitCapabilities: new Map([['21000000-0000-4000-8000-000000000010', new Set(['expediente.create'])]]) } };
    expect((await api().inject({ method: 'POST', url: '/expedientes', headers: { authorization: 'Bearer test' }, payload: { expedienteTypeVersionId: publishedVersionA, metadata: { title: 'Nope' } } })).statusCode).toBe(403);
    principal = { ...principal, authorization: { ...principal.authorization, institutionCapabilities: new Set(['expediente.create', 'records.read']), unitCapabilities: new Map() } };
    const injected = await api().inject({ method: 'POST', url: '/expedientes', headers: { authorization: 'Bearer test' }, payload: { expedienteTypeVersionId: publishedVersionA, metadata: { title: 'Nope' }, status: 'CLOSED', institutionId: institutionB, folio: 'EXP-2026-999999' } });
    expect(injected.statusCode).toBe(400);
  });

  it('rejects reads without institution-wide records.read and conceals foreign IDs', async () => {
    const created = await api().inject({ method: 'POST', url: '/expedientes', headers: { authorization: 'Bearer test' }, payload: { expedienteTypeVersionId: publishedVersionA, metadata: { title: 'Read test' } } });
    const id = created.json<{ id: string }>().id;
    principal = { ...principal, authorization: { ...principal.authorization, institutionCapabilities: new Set(), unitCapabilities: new Map([['21000000-0000-4000-8000-000000000010', new Set(['records.read'])]]) } };
    expect((await api().inject({ method: 'GET', url: `/expedientes/${id}`, headers: { authorization: 'Bearer test' } })).statusCode).toBe(403);
    principal = { ...principal, authorization: { ...principal.authorization, institutionCapabilities: new Set(['records.read']), unitCapabilities: new Map() } };
    expect((await api().inject({ method: 'GET', url: `/expedientes/${id}`, headers: { authorization: 'Bearer test' } })).statusCode).toBe(200);
    const foreign = await createExpedienteApplicationService(db()).create({ id: '21000000-0000-4000-8000-00000000000b', institutionId: institutionB, actorUserId: userB, correlationId: 'foreign-expediente', request: { expedienteTypeVersionId: publishedVersionB, metadata: { title: 'Foreign' } } });
    expect((await api().inject({ method: 'GET', url: `/expedientes/${foreign.id}`, headers: { authorization: 'Bearer test' } })).statusCode).toBe(404);
  });

  it('allocates distinct sequential folios for concurrent creations', async () => {
    const service = createExpedienteApplicationService(db());
    const inputs = Array.from({ length: 5 }, (_, index) => ({ id: `21000000-0000-4000-8000-0000000001${String(index + 1).padStart(2, '0')}`, institutionId: institutionA, actorUserId: userA, correlationId: `concurrent-${index}`, request: { expedienteTypeVersionId: publishedVersionA, metadata: { title: `Concurrent ${index}` } } }));
    const created = await Promise.all(inputs.map((input) => service.create(input)));
    const sequences = created.map((row) => Number(row.sequence_number)).sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(5);
    expect(sequences).toEqual([3, 4, 5, 6, 7]);
  });
});
