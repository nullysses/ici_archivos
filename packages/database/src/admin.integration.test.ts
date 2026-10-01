import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { applyFoundationMigrations, createAdminAssignment, createAdminExpedienteType, createAdminUnit, createDatabase, findAdminUsers, publishAdminExpedienteDraft, revokeAdminAssignment, updateAdminExpedienteDraft, updateAdminUnit, type Database } from './index.js';
import type { AuthorizationContext } from '@ici/domain';

const institutionA = '68000000-0000-4000-8000-000000000001';
const institutionB = '68000000-0000-4000-8000-000000000002';
const userA = '68000000-0000-4000-8000-000000000003';
const userB = '68000000-0000-4000-8000-000000000004';
const roleId = '68000000-0000-4000-8000-000000000005';

const adminAuthorization = (institutionId: string, userId: string): AuthorizationContext => ({
  institutionId,
  userId,
  institutionCapabilities: new Set(['identity.manage', 'expediente_type.manage_draft', 'expediente_type.publish', 'institution.configure'] as const),
  unitCapabilities: new Map(),
});

describe('M15 administrative persistence', () => {
  let database: Database | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    database = createDatabase(container.getConnectionUri());
    await applyFoundationMigrations(database);
    await database.insertInto('institutions').values([
      { id: institutionA, code: 'ADMIN-A', name: 'Admin A', status: 'ACTIVE' },
      { id: institutionB, code: 'ADMIN-B', name: 'Admin B', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('users').values([
      { id: userA, institution_id: institutionA, display_name: 'Admin A', status: 'ACTIVE' },
      { id: userB, institution_id: institutionB, display_name: 'Admin B', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('roles').values({ id: roleId, code: 'ADMIN_TEST', name: 'Administrative test role' }).execute();
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
    await container?.stop();
  });

  function db(): Database {
    if (database === undefined) throw new Error('Database test container did not start');
    return database;
  }

  it('keeps organizational hierarchy tenant-scoped and rejects cycles', async () => {
    const root = await createAdminUnit(db(), { institutionId: institutionA, actorUserId: userA, code: 'ROOT', name: 'Root', correlationId: 'm15-unit-root', authorizationContext: adminAuthorization(institutionA, userA) });
    const child = await createAdminUnit(db(), { institutionId: institutionA, actorUserId: userA, code: 'CHILD', name: 'Child', parentId: root.id, correlationId: 'm15-unit-child', authorizationContext: adminAuthorization(institutionA, userA) });
    await expect(updateAdminUnit(db(), { institutionId: institutionA, actorUserId: userA, unitId: root.id, parentId: child.id, correlationId: 'm15-unit-cycle', authorizationContext: adminAuthorization(institutionA, userA) })).rejects.toMatchObject({ code: 'UNIT_HIERARCHY_INVALID' });
    await expect(createAdminUnit(db(), { institutionId: institutionA, actorUserId: userA, code: 'FOREIGN-PARENT', name: 'Foreign parent', parentId: '68000000-0000-4000-8000-000000000099', correlationId: 'm15-unit-foreign', authorizationContext: adminAuthorization(institutionA, userA) })).rejects.toMatchObject({ code: 'UNIT_PARENT_NOT_FOUND' });
  });

  it('audits scoped assignment and prevents cross-institution assignment', async () => {
    await createAdminAssignment(db(), { institutionId: institutionA, actorUserId: userA, userId: userA, roleId, correlationId: 'm15-assignment-create', authorizationContext: adminAuthorization(institutionA, userA) });
    const users = await findAdminUsers(db(), { institutionId: institutionA, authorizationContext: adminAuthorization(institutionA, userA) });
    const assignment = users.find((user) => user.id === userA)?.assignments[0];
    expect(assignment?.role_code).toBe('ADMIN_TEST');
    if (assignment === undefined) throw new Error('Expected assignment');
    await revokeAdminAssignment(db(), { institutionId: institutionA, actorUserId: userA, assignmentId: assignment.id, correlationId: 'm15-assignment-revoke', authorizationContext: adminAuthorization(institutionA, userA) });
    await expect(createAdminAssignment(db(), { institutionId: institutionA, actorUserId: userA, userId: userB, roleId, correlationId: 'm15-assignment-cross-tenant', authorizationContext: adminAuthorization(institutionA, userA) })).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('preserves every schema field and restriction through draft editing and freezes it on publish', async () => {
    const schema = { type: 'object', properties: { title: { type: 'string', title: 'Title', minLength: 3 }, year: { type: 'integer', minimum: 1900, maximum: 2100 } }, required: ['title', 'year'], additionalProperties: false };
    await createAdminExpedienteType(db(), { institutionId: institutionA, actorUserId: userA, code: 'ADMIN-TYPE', name: 'Administrative type', schema, correlationId: 'm15-type-create', authorizationContext: adminAuthorization(institutionA, userA) });
    const draft = await db().selectFrom('expediente_type_versions').select(['id']).where('institution_id', '=', institutionA).where('status', '=', 'DRAFT').where('expediente_type_id', 'in', db().selectFrom('expediente_types').select('id').where('code', '=', 'ADMIN-TYPE')).executeTakeFirstOrThrow();
    const edited = { ...schema, properties: { ...schema.properties, title: { ...schema.properties.title, title: 'Título' } } };
    await updateAdminExpedienteDraft(db(), { institutionId: institutionA, actorUserId: userA, versionId: draft.id, schema: edited, correlationId: 'm15-type-update', authorizationContext: adminAuthorization(institutionA, userA) });
    expect((await db().selectFrom('expediente_type_versions').select('schema_json').where('id', '=', draft.id).executeTakeFirstOrThrow()).schema_json).toEqual(edited);
    await publishAdminExpedienteDraft(db(), { institutionId: institutionA, actorUserId: userA, versionId: draft.id, correlationId: 'm15-type-publish', authorizationContext: adminAuthorization(institutionA, userA) });
    await expect(updateAdminExpedienteDraft(db(), { institutionId: institutionA, actorUserId: userA, versionId: draft.id, schema: edited, correlationId: 'm15-type-published-update', authorizationContext: adminAuthorization(institutionA, userA) })).rejects.toMatchObject({ code: 'VERSION_IMMUTABLE' });
  });
});
