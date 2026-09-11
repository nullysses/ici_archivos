import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { applyFoundationMigrations, assignMatterAtomically, createDatabase, registerMatterAtomically, type Database } from '@ici/database';
import { createApp } from './app.js';
import type { AuthenticatedPrincipal } from './auth.js';
import { createMatterApplicationService } from './matters.js';

const institutionA = '11000000-0000-4000-8000-000000000001';
const institutionB = '11000000-0000-4000-8000-000000000002';
const userA = '11000000-0000-4000-8000-000000000003';
const unitA = '11000000-0000-4000-8000-000000000004';
const unitB = '11000000-0000-4000-8000-000000000005';
const classificationA = '11000000-0000-4000-8000-000000000006';
const unitA2 = '11000000-0000-4000-8000-000000000009';
const unitA3 = '11000000-0000-4000-8000-00000000000a';
const now = '2026-09-11T12:00:00.000Z';

describe('matter HTTP API with real PostgreSQL persistence', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let database: Database | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let currentPrincipal: AuthenticatedPrincipal;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    database = createDatabase(container.getConnectionUri());
    await sql`CREATE ROLE ici_app NOLOGIN NOSUPERUSER NOBYPASSRLS`.execute(database);
    await applyFoundationMigrations(database);
    await database.insertInto('institutions').values([
      { id: institutionA, code: 'MAT-A', name: 'Matter A', status: 'ACTIVE' },
      { id: institutionB, code: 'MAT-B', name: 'Matter B', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('organizational_units').values([
      { id: unitA, institution_id: institutionA, code: 'UNIT-A', name: 'Unit A', status: 'ACTIVE' },
      { id: unitA2, institution_id: institutionA, code: 'UNIT-A2', name: 'Unit A2', status: 'ACTIVE' },
      { id: unitA3, institution_id: institutionA, code: 'UNIT-A3', name: 'Unit A3', status: 'ACTIVE' },
      { id: unitB, institution_id: institutionB, code: 'UNIT-B', name: 'Unit B', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('users').values({ id: userA, institution_id: institutionA, display_name: 'Matter operator', status: 'ACTIVE' }).execute();
    await database.insertInto('access_classifications').values({ id: classificationA, institution_id: institutionA, legal_classification: 'PUBLIC', operational_visibility: 'INSTITUTION' }).execute();
    currentPrincipal = {
      userId: userA,
      institutionId: institutionA,
      issuer: 'https://issuer.example.test',
      subject: 'subject-a',
      authorization: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(['matter.register', 'records.read']), unitCapabilities: new Map() },
    };
    app = await createApp({
      authenticateAccessToken: () => Promise.resolve(currentPrincipal),
      matterService: createMatterApplicationService(database),
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

  const payload = {
    sender: 'Secretaría de prueba', destinationUnitId: unitA, subject: 'Solicitud de información', description: 'Descripción de la solicitud', priority: 'NORMAL', channel: 'EMAIL',
    receivedAt: now, accessClassificationId: classificationA, operationalVisibility: 'INSTITUTION',
  } as const;

  it('registers through Fastify, persists state/audit atomically, and reads by id and folio', async () => {
    const created = await api().inject({ method: 'POST', url: '/matters', headers: { authorization: 'Bearer test' }, payload });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ id: string; folio: string; status: string; createdBy: string }>();
    expect(body).toMatchObject({ folio: 'OP-2026-000001', status: 'RECEIVED', createdBy: userA });
    expect((await db().selectFrom('matters').selectAll().where('id', '=', body.id).execute())).toHaveLength(1);
    expect((await db().selectFrom('matter_state_events').selectAll().where('matter_id', '=', body.id).execute())).toHaveLength(1);
    expect((await db().selectFrom('audit_events').selectAll().where('aggregate_id', '=', body.id).execute())).toHaveLength(1);
    expect((await api().inject({ method: 'GET', url: `/matters/${body.id}`, headers: { authorization: 'Bearer test' } })).statusCode).toBe(200);
    expect((await api().inject({ method: 'GET', url: `/matters/by-folio/${body.folio}`, headers: { authorization: 'Bearer test' } })).statusCode).toBe(200);
  });

  it('enforces scoped reads, tenant concealment, and stable validation errors', async () => {
    const created = await api().inject({ method: 'POST', url: '/matters', headers: { authorization: 'Bearer test' }, payload });
    const body = created.json<{ id: string }>();
    expect((await api().inject({ method: 'GET', url: `/matters/${body.id}`, headers: { authorization: 'Bearer test' } })).statusCode).toBe(200);
    await assignMatterAtomically(db(), { institutionId: institutionA, matterId: body.id, assignmentId: '11000000-0000-4000-8000-000000000010', unitId: unitA2, actorUserId: userA, correlationId: 'effective-unit-test', command: 'assignMatter', fromStatus: 'RECEIVED', assignedAt: new Date(now), authorizationContext: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(['matter.assign'] as const), unitCapabilities: new Map() } });
    currentPrincipal = { ...currentPrincipal, authorization: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(), unitCapabilities: new Map([[unitB, new Set(['records.read'])]]) } };
    expect((await api().inject({ method: 'GET', url: `/matters/${body.id}`, headers: { authorization: 'Bearer test' } })).statusCode).toBe(403);
    currentPrincipal = { ...currentPrincipal, authorization: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(), unitCapabilities: new Map([[unitA2, new Set(['records.read'])]]) } };
    expect((await api().inject({ method: 'GET', url: `/matters/${body.id}`, headers: { authorization: 'Bearer test' } })).statusCode).toBe(200);
    currentPrincipal = { ...currentPrincipal, authorization: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(), unitCapabilities: new Map([[unitB, new Set(['records.read'])]]) } };
    expect((await api().inject({ method: 'GET', url: '/matters/12000000-0000-4000-8000-000000000099', headers: { authorization: 'Bearer test' } })).statusCode).toBe(404);
    expect((await api().inject({ method: 'GET', url: '/matters/by-folio/EXP-2026-000001', headers: { authorization: 'Bearer test' } })).statusCode).toBe(400);
    currentPrincipal = { ...currentPrincipal, authorization: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(['matter.register', 'records.read']), unitCapabilities: new Map() } };
    const invalidReference = await api().inject({ method: 'POST', url: '/matters', headers: { authorization: 'Bearer test' }, payload: { ...payload, destinationUnitId: unitB } });
    expect(invalidReference.json()).toEqual({ error: { code: 'INVALID_REQUEST', message: 'Referenced intake record is invalid' } });

    const restrictedId = '11000000-0000-4000-8000-000000000007';
    await db().insertInto('matters').values({ id: restrictedId, institution_id: institutionA, folio: 'OP-2026-000003', folio_year: 2026, sequence_number: 3, status: 'RECEIVED', received_at: new Date(now), intake_metadata: { sender: 'restricted', subject: 'restricted', description: 'restricted', priority: 'NORMAL', channel: 'EMAIL', operationalVisibility: 'RESTRICTED_GROUP' }, destination_unit_id: unitA, access_classification_id: classificationA, created_by: userA }).execute();
    const restrictedRead = await api().inject({ method: 'GET', url: `/matters/${restrictedId}`, headers: { authorization: 'Bearer test' } });
    expect(restrictedRead.statusCode).toBe(403);
    const legacyId = '11000000-0000-4000-8000-000000000008';
    await db().insertInto('matters').values({ id: legacyId, institution_id: institutionA, folio: 'OP-2026-000004', folio_year: 2026, sequence_number: 4, status: 'RECEIVED', received_at: new Date(now), intake_metadata: { sender: 'legacy', subject: 'legacy', description: 'legacy', priority: 'NORMAL', channel: 'EMAIL' }, destination_unit_id: unitA, access_classification_id: classificationA, created_by: userA }).execute();
    const legacyRead = await api().inject({ method: 'GET', url: `/matters/${legacyId}`, headers: { authorization: 'Bearer test' } });
    expect(legacyRead.statusCode).toBe(403);
  });

  it('rolls back matter, folio, state event, and audit on transactional failure', async () => {
    const id = '11000000-0000-4000-8000-000000000099';
    await expect(registerMatterAtomically(db(), { id, institutionId: institutionA, receivedAt: new Date(now), createdBy: '11000000-0000-4000-8000-000000000098', actorUserId: '11000000-0000-4000-8000-000000000098', intakeMetadata: { sender: 'rollback' }, correlationId: 'matter-rollback', year: 2026, destinationUnitId: unitA, accessClassificationId: classificationA })).rejects.toThrow();
    expect(await db().selectFrom('matters').select('id').where('id', '=', id).execute()).toHaveLength(0);
    expect(await db().selectFrom('matter_state_events').select('id').where('matter_id', '=', id).execute()).toHaveLength(0);
    expect(await db().selectFrom('audit_events').select('id').where('aggregate_id', '=', id).execute()).toHaveLength(0);
    expect((await db().selectFrom('folio_counters').select('next_value').where('institution_id', '=', institutionA).where('folio_kind', '=', 'MATTER').where('folio_year', '=', 2026).executeTakeFirstOrThrow()).next_value).toBe('3');
  });

  it('assigns and reassigns atomically, validates targets, and serves the scoped inbox', async () => {
    currentPrincipal = { ...currentPrincipal, authorization: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(['matter.register']), unitCapabilities: new Map([[unitA, new Set(['matter.assign', 'records.read'])]]) } };
    const created = await api().inject({ method: 'POST', url: '/matters', headers: { authorization: 'Bearer test' }, payload: { ...payload, receivedAt: '2027-09-11T12:00:00.000Z' } });
    expect(created.statusCode).toBe(201);
    const matterId = created.json<{ id: string }>().id;
    const assigned = await api().inject({ method: 'POST', url: `/matters/${matterId}/assign`, headers: { authorization: 'Bearer test' }, payload: { unitId: unitA, userId: userA } });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json<{ status: string }>().status).toBe('ASSIGNED');
    expect(await db().selectFrom('matter_assignments').selectAll().where('matter_id', '=', matterId).execute()).toHaveLength(1);
    expect(await db().selectFrom('matter_state_events').selectAll().where('matter_id', '=', matterId).execute()).toHaveLength(2);
    expect(await db().selectFrom('audit_events').selectAll().where('aggregate_id', '=', matterId).execute()).toHaveLength(2);
    const inbox = await api().inject({ method: 'GET', url: '/matters/inbox', headers: { authorization: 'Bearer test' } });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json<{ items: Array<{ id: string; assignmentUnitId: string }> }>().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: matterId, assignmentUnitId: unitA })]));

    const missingReason = await api().inject({ method: 'POST', url: `/matters/${matterId}/reassign`, headers: { authorization: 'Bearer test' }, payload: { unitId: unitA } });
    expect(missingReason.statusCode).toBe(400);
    const invalidUser = await api().inject({ method: 'POST', url: `/matters/${matterId}/reassign`, headers: { authorization: 'Bearer test' }, payload: { unitId: unitA, userId: institutionB, reason: 'Move' } });
    expect(invalidUser.statusCode).toBe(400);
    expect(await db().selectFrom('matter_assignments').selectAll().where('matter_id', '=', matterId).execute()).toHaveLength(1);

    const reassigned = await api().inject({ method: 'POST', url: `/matters/${matterId}/reassign`, headers: { authorization: 'Bearer test' }, payload: { unitId: unitA, userId: userA, reason: 'Updated target' } });
    expect(reassigned.statusCode).toBe(200);
    expect(await db().selectFrom('matter_assignments').selectAll().where('matter_id', '=', matterId).execute()).toHaveLength(2);

    currentPrincipal = { ...currentPrincipal, authorization: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(), unitCapabilities: new Map([[unitA, new Set(['matter.assign'])]]) } };
    const sourceDenied = await api().inject({ method: 'POST', url: `/matters/${matterId}/reassign`, headers: { authorization: 'Bearer test' }, payload: { unitId: unitA2, reason: 'Cross-unit move' } });
    expect(sourceDenied.statusCode).toBe(403);
    currentPrincipal = { ...currentPrincipal, authorization: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(), unitCapabilities: new Map([[unitA, new Set(['matter.assign'])], [unitA2, new Set(['matter.assign'])]]) } };
    const sourceAndTargetAllowed = await api().inject({ method: 'POST', url: `/matters/${matterId}/reassign`, headers: { authorization: 'Bearer test' }, payload: { unitId: unitA2, reason: 'Cross-unit move' } });
    expect(sourceAndTargetAllowed.statusCode).toBe(200);
    expect(sourceAndTargetAllowed.json<{ destinationUnitId: string; status: string }>()).toMatchObject({ destinationUnitId: unitA, status: 'ASSIGNED' });
  });

  it('rejects assignment outside the principal capability scope', async () => {
    currentPrincipal = { ...currentPrincipal, authorization: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(['matter.register']), unitCapabilities: new Map([[unitA, new Set(['records.read'])]]) } };
    const created = await api().inject({ method: 'POST', url: '/matters', headers: { authorization: 'Bearer test' }, payload: { ...payload, receivedAt: '2028-09-11T12:00:00.000Z' } });
    const matterId = created.json<{ id: string }>().id;
    const forbidden = await api().inject({ method: 'POST', url: `/matters/${matterId}/assign`, headers: { authorization: 'Bearer test' }, payload: { unitId: unitB } });
    expect(forbidden.statusCode).toBe(403);
  });

  it('serializes concurrent reassignments and resolves latest unit by lock order', async () => {
    currentPrincipal = { ...currentPrincipal, authorization: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(['matter.register']), unitCapabilities: new Map([[unitA, new Set(['matter.assign'])], [unitA2, new Set(['matter.assign'])], [unitA3, new Set(['matter.assign'])]]) } };
    const created = await api().inject({ method: 'POST', url: '/matters', headers: { authorization: 'Bearer test' }, payload: { ...payload, receivedAt: '2029-09-11T12:00:00.000Z' } });
    expect(created.statusCode).toBe(201);
    const matterId = created.json<{ id: string }>().id;
    expect((await api().inject({ method: 'POST', url: `/matters/${matterId}/assign`, headers: { authorization: 'Bearer test' }, payload: { unitId: unitA } })).statusCode).toBe(200);
    let releaseLock!: () => void;
    let lockReady!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { lockReady = resolve; });
    const lockRelease = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holder = db().transaction().execute(async (transaction) => {
      await transaction.selectFrom('matters').select('id').where('id', '=', matterId).forUpdate().executeTakeFirstOrThrow();
      lockReady();
      await lockRelease;
    });
    await lockAcquired;
    const first = api().inject({ method: 'POST', url: `/matters/${matterId}/reassign`, headers: { authorization: 'Bearer test' }, payload: { unitId: unitA2, reason: 'Concurrent move 1' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = api().inject({ method: 'POST', url: `/matters/${matterId}/reassign`, headers: { authorization: 'Bearer test' }, payload: { unitId: unitA3, reason: 'Concurrent move 2' } });
    releaseLock();
    const responses = await Promise.all([first, second]);
    await holder;
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 200]);
    const assignments = await db().selectFrom('matter_assignments').selectAll().where('matter_id', '=', matterId).orderBy('assigned_at').orderBy('id').execute();
    expect(assignments).toHaveLength(3);
    expect(assignments[1]?.unit_id).toBe(unitA2);
    expect(assignments[2]?.unit_id).toBe(unitA3);
    expect(assignments[2]?.assigned_at.getTime()).toBeGreaterThan(assignments[1]?.assigned_at.getTime() ?? 0);
  });
});
