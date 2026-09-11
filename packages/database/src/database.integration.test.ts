import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import {
  allocateFolio,
  appendAuditEvent,
  applyFoundationMigrations,
  assignMatterAtomically,
  assertApplicationRoleIsRlsSafe,
  assertTenantTablesUseForcedRls,
  createDatabase,
  insertIntegrationJob,
  setInstitutionContext,
  withAuditedTenantTransaction,
  type Database,
  type DatabaseTransaction,
} from './index.js';

const institutionA = '00000000-0000-4000-8000-000000000001';
const institutionB = '00000000-0000-4000-8000-000000000002';
const userA = '00000000-0000-4000-8000-000000000003';
const userB = '00000000-0000-4000-8000-000000000013';
const matterA = '00000000-0000-4000-8000-000000000004';
const matterB = '00000000-0000-4000-8000-000000000005';
const typeA = '00000000-0000-4000-8000-000000000006';
const versionA = '00000000-0000-4000-8000-000000000007';
const expedienteA = '00000000-0000-4000-8000-000000000008';
const transferA = '00000000-0000-4000-8000-000000000009';
const unitA = '00000000-0000-4000-8000-000000000020';
const unitB = '00000000-0000-4000-8000-000000000021';
const now = new Date('2026-09-07T12:00:00.000Z');

describe('PostgreSQL foundation', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let database: Database | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    database = createDatabase(container.getConnectionUri());
    await sql`CREATE ROLE ici_app NOLOGIN NOSUPERUSER NOBYPASSRLS`.execute(database);
    await applyFoundationMigrations(database);
    await database.insertInto('institutions').values([
      { id: institutionA, code: 'A', name: 'Institution A', status: 'ACTIVE' },
      { id: institutionB, code: 'B', name: 'Institution B', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('roles').values({ id: '00000000-0000-4000-8000-000000000010', code: 'GESTOR', name: 'Gestor' }).execute();
    await database.insertInto('organizational_units').values([
      { id: unitA, institution_id: institutionA, code: 'UNIT-A', name: 'Unit A', status: 'ACTIVE' },
      { id: unitB, institution_id: institutionB, code: 'UNIT-B', name: 'Unit B', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('users').values([
      { id: userA, institution_id: institutionA, display_name: 'User A', status: 'ACTIVE' },
      { id: userB, institution_id: institutionB, display_name: 'User B', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('expediente_types').values({ id: typeA, institution_id: institutionA, code: 'TEST', name: 'Test type', status: 'ACTIVE' }).execute();
    await database.insertInto('expediente_type_versions').values({
      id: versionA,
      institution_id: institutionA,
      expediente_type_id: typeA,
      version_number: 1,
      status: 'PUBLISHED',
      schema_json: { type: 'object', properties: { title: { type: 'string' } } },
      archival_mapping_json: { level: 'File' },
      created_at: now,
      published_at: now,
    }).execute();
    await database.insertInto('expedientes').values({
      id: expedienteA,
      institution_id: institutionA,
      folio: 'EXP-2026-000001',
      folio_year: 2026,
      sequence_number: 1,
      status: 'OPEN',
      expediente_type_version_id: versionA,
      metadata: { title: 'JSONB record', nested: { value: 42 } },
      opened_at: now,
    }).execute();
    await database.insertInto('archive_transfers').values({ id: transferA, institution_id: institutionA, expediente_id: expedienteA, status: 'DRAFT' }).execute();

    await sql`CREATE ROLE ici_test_app NOLOGIN NOSUPERUSER NOBYPASSRLS`.execute(database);
    await sql`GRANT USAGE ON SCHEMA public TO ici_test_app`.execute(database);
    await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ici_test_app`.execute(database);
    await sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ici_test_app`.execute(database);
    await assertApplicationRoleIsRlsSafe(database, 'ici_test_app');
    await assertTenantTablesUseForcedRls(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await container?.stop();
  });

  function db(): Database {
    if (database === undefined) throw new Error('Database test container did not start');
    return database;
  }

  async function asTenant<T>(institution: string, callback: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
    return db().transaction().execute(async (transaction) => {
      await sql`SET LOCAL ROLE ici_test_app`.execute(transaction);
      await setInstitutionContext(transaction, institution);
      return callback(transaction);
    });
  }

  it('runs the real database health query and persists JSONB', async () => {
    const result = await sql<{ ok: number }>`select 1 as ok`.execute(db());
    expect(result.rows[0]?.ok).toBe(1);
    const row = await db().selectFrom('expedientes').select(['metadata']).where('id', '=', expedienteA).executeTakeFirstOrThrow();
    expect(row.metadata).toEqual({ title: 'JSONB record', nested: { value: 42 } });
  });

  it('isolates tenant reads, updates, inserts, and child foreign keys with RLS', async () => {
    await db().insertInto('matters').values([
      { id: matterA, institution_id: institutionA, folio: 'OP-2026-000001', folio_year: 2026, sequence_number: 1, status: 'RECEIVED', received_at: now, intake_metadata: { sender: 'A' } },
      { id: matterB, institution_id: institutionB, folio: 'OP-2026-000001', folio_year: 2026, sequence_number: 1, status: 'RECEIVED', received_at: now, intake_metadata: { sender: 'B' } },
    ]).execute();

    await asTenant(institutionA, async (transaction) => {
      const hidden = await transaction.selectFrom('matters').selectAll().where('id', '=', matterB).execute();
      expect(hidden).toHaveLength(0);
      const update = await transaction.updateTable('matters').set({ status: 'VOIDED' }).where('id', '=', matterB).executeTakeFirst();
      expect(Number(update.numUpdatedRows)).toBe(0);
    });
    await expect(asTenant(institutionA, async (transaction) => transaction.updateTable('users').set({ institution_id: institutionB }).where('id', '=', userA).execute())).rejects.toThrow();

    await expect(asTenant(institutionA, async (transaction) => transaction.insertInto('matters').values({ id: '00000000-0000-4000-8000-000000000011', institution_id: institutionB, folio: 'OP-2026-000002', folio_year: 2026, sequence_number: 2, status: 'RECEIVED', received_at: now, intake_metadata: { sender: 'B' } }).execute())).rejects.toThrow();
    await expect(asTenant(institutionA, async (transaction) => transaction.insertInto('matter_assignments').values({ id: '00000000-0000-4000-8000-000000000012', institution_id: institutionA, matter_id: matterB, unit_id: unitA }).execute())).rejects.toThrow();
  });

  it('fails closed when tenant context is missing', async () => {
    await expect(db().transaction().execute(async (transaction) => {
      await sql`SET LOCAL ROLE ici_test_app`.execute(transaction);
      const rows = await transaction.selectFrom('matters').selectAll().execute();
      expect(rows).toHaveLength(0);
      await transaction.insertInto('matters').values({ id: '00000000-0000-4000-8000-000000000014', institution_id: institutionA, folio: 'OP-2026-000003', folio_year: 2026, sequence_number: 3, status: 'RECEIVED', received_at: now, intake_metadata: { sender: 'A' } }).execute();
    })).rejects.toThrow();
  });

  it('allocates unique institution-scoped folios atomically under concurrency', async () => {
    const allocations = await Promise.all(Array.from({ length: 32 }, () => asTenant(institutionA, async (transaction) => allocateFolio(transaction, { institutionId: institutionA, folioKind: 'MATTER', folioYear: 2026 }))));
    const sequences = allocations.map((allocation) => allocation.sequenceNumber).sort((left, right) => left - right);
    expect(sequences).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
    expect(new Set(allocations.map((allocation) => allocation.folio)).size).toBe(32);
    const otherTenant = await asTenant(institutionB, async (transaction) => allocateFolio(transaction, { institutionId: institutionB, folioKind: 'MATTER', folioYear: 2026 }));
    expect(otherTenant.sequenceNumber).toBe(1);
    expect(otherTenant.folio).toBe('OP-2026-000001');
  });

  it('keeps committed folios immutable and protects their numeric identity', async () => {
    await expect(db().updateTable('matters').set({ folio: 'OP-2026-000099', sequence_number: '99' }).where('id', '=', matterA).execute()).rejects.toThrow(/immutable/i);
    await expect(db().insertInto('matters').values({ institution_id: institutionA, folio: 'OP-2026-000001', folio_year: 2026, sequence_number: 2, status: 'RECEIVED', received_at: now, intake_metadata: { sender: 'duplicate folio' } }).execute()).rejects.toThrow();
    await expect(db().insertInto('matters').values({ institution_id: institutionA, folio: 'OP-2026-000099', folio_year: 2026, sequence_number: 1, status: 'RECEIVED', received_at: now, intake_metadata: { sender: 'duplicate sequence' } }).execute()).rejects.toThrow();
  });

  it('commits mutation and audit together and rolls both back on failure', async () => {
    const committedMatter = '00000000-0000-4000-8000-000000000015';
    await withAuditedTenantTransaction(db(), { institutionId: institutionA, eventType: 'matter.registered', aggregateType: 'matter', aggregateId: committedMatter, correlationId: 'corr-commit', eventData: { state: 'RECEIVED' } }, async (transaction) => {
      await transaction.insertInto('matters').values({ id: committedMatter, institution_id: institutionA, folio: 'OP-2026-000004', folio_year: 2026, sequence_number: 4, status: 'RECEIVED', received_at: now, intake_metadata: { sender: 'A' } }).execute();
    });
    expect(await db().selectFrom('audit_events').selectAll().where('aggregate_id', '=', committedMatter).execute()).toHaveLength(1);

    const rolledBackMatter = '00000000-0000-4000-8000-000000000016';
    await expect(withAuditedTenantTransaction(db(), { institutionId: institutionA, eventType: 'matter.registered', aggregateType: 'matter', aggregateId: rolledBackMatter, correlationId: 'corr-rollback' }, async (transaction) => {
      await transaction.insertInto('matters').values({ id: rolledBackMatter, institution_id: institutionA, folio: 'OP-2026-000005', folio_year: 2026, sequence_number: 5, status: 'RECEIVED', received_at: now, intake_metadata: { sender: 'rollback' } }).execute();
      throw new Error('abort transaction');
    })).rejects.toThrow('abort transaction');
    expect(await db().selectFrom('matters').selectAll().where('id', '=', rolledBackMatter).execute()).toHaveLength(0);
    expect(await db().selectFrom('audit_events').selectAll().where('aggregate_id', '=', rolledBackMatter).execute()).toHaveLength(0);

    const assignmentId = '00000000-0000-4000-8000-000000000028';
    await expect(assignMatterAtomically(db(), {
      institutionId: institutionA,
      matterId: matterA,
      assignmentId,
      unitId: unitA,
      actorUserId: '00000000-0000-4000-8000-999999999999',
      correlationId: 'corr-assignment-rollback',
      command: 'assignMatter',
      fromStatus: 'RECEIVED',
      assignedAt: now,
    })).rejects.toThrow();
    expect((await db().selectFrom('matters').select('status').where('id', '=', matterA).executeTakeFirstOrThrow()).status).toBe('RECEIVED');
    expect(await db().selectFrom('matter_assignments').select('id').where('id', '=', assignmentId).execute()).toHaveLength(0);
    expect(await db().selectFrom('audit_events').select('id').where('correlation_id', '=', 'corr-assignment-rollback').execute()).toHaveLength(0);
  });

  it('keeps audit events append-only', async () => {
    await appendAuditEvent(db(), { institutionId: institutionA, eventType: 'test', aggregateType: 'matter', aggregateId: matterA, correlationId: 'corr-append-only' });
    const inserted = await db().selectFrom('audit_events').select('id').where('correlation_id', '=', 'corr-append-only').executeTakeFirstOrThrow();
    await expect(db().updateTable('audit_events').set({ event_type: 'changed' }).where('id', '=', inserted.id).execute()).rejects.toThrow(/append-only/i);
    await expect(db().deleteFrom('audit_events').where('id', '=', inserted.id).execute()).rejects.toThrow(/append-only/i);
  });

  it('protects published definitions and approved manifests in persistence', async () => {
    await expect(db().updateTable('expediente_type_versions').set({ schema_json: { changed: true } }).where('id', '=', versionA).execute()).rejects.toThrow(/immutable/i);
    await expect(db().deleteFrom('expediente_type_versions').where('id', '=', versionA).execute()).rejects.toThrow(/cannot be deleted/i);
    const draftVersion = '00000000-0000-4000-8000-000000000022';
    await db().insertInto('expediente_type_versions').values({ id: draftVersion, institution_id: institutionA, expediente_type_id: typeA, version_number: 2, status: 'DRAFT', schema_json: { type: 'object' }, archival_mapping_json: {}, created_at: now }).execute();
    await expect(db().insertInto('expedientes').values({ institution_id: institutionA, folio: 'EXP-2026-000099', folio_year: 2026, sequence_number: 99, status: 'OPEN', expediente_type_version_id: draftVersion, metadata: {}, opened_at: now }).execute()).rejects.toThrow(/published type version/i);
    await db().updateTable('expediente_type_versions').set({ status: 'PUBLISHED', published_at: now }).where('id', '=', draftVersion).execute();
    await db().updateTable('expediente_type_versions').set({ status: 'RETIRED' }).where('id', '=', draftVersion).execute();
    await expect(db().updateTable('expediente_type_versions').set({ schema_json: { changed: true } }).where('id', '=', draftVersion).execute()).rejects.toThrow(/retired/i);
    await expect(db().updateTable('expedientes').set({ expediente_type_version_id: draftVersion }).where('id', '=', expedienteA).execute()).rejects.toThrow(/dedicated audited operation/i);
    await expect(db().insertInto('expediente_type_versions').values({ institution_id: institutionA, expediente_type_id: typeA, version_number: 4, status: 'PUBLISHED', schema_json: {}, archival_mapping_json: {}, created_at: now, published_at: now }).execute()).rejects.toThrow(/next sequential/i);
    const manifest = '00000000-0000-4000-8000-000000000017';
    await expect(db().updateTable('archive_transfers').set({ status: 'APPROVED' }).where('id', '=', transferA).execute()).rejects.toThrow(/manifest/i);
    await db().insertInto('transfer_manifests').values({ id: manifest, institution_id: institutionA, transfer_id: transferA, status: 'DRAFT', canonical_json: '{"v":1}' }).execute();
    await expect(db().updateTable('transfer_manifests').set({ status: 'APPROVED', sha256: 'a'.repeat(64), approved_by: userA, approved_at: now }).where('id', '=', manifest).execute()).rejects.toThrow();
    const canonicalSha256 = createHash('sha256').update('{"v":1}', 'utf8').digest('hex');
    await db().updateTable('transfer_manifests').set({ status: 'APPROVED', sha256: canonicalSha256, approved_by: userA, approved_at: now }).where('id', '=', manifest).execute();
    await expect(db().updateTable('transfer_manifests').set({ canonical_json: '{"v":2}' }).where('id', '=', manifest).execute()).rejects.toThrow(/immutable/i);
    await expect(db().deleteFrom('transfer_manifests').where('id', '=', manifest).execute()).rejects.toThrow(/immutable/i);
  });

  it('enforces composite tenant foreign keys and ordinary relational constraints', async () => {
    await expect(db().insertInto('document_versions').values({ institution_id: institutionA, document_id: '00000000-0000-4000-8000-000000000018', version_number: 1, original_filename: 'bad.pdf', detected_mime_type: 'application/pdf', size_bytes: 1, sha256: 'b'.repeat(64), storage_key: 'bad', malware_scan_status: 'CLEAN', created_by: userA }).execute()).rejects.toThrow();
    await expect(db().insertInto('expediente_type_versions').values({ institution_id: institutionA, expediente_type_id: typeA, version_number: 3, status: 'PUBLISHED', schema_json: {}, archival_mapping_json: {}, created_at: now }).execute()).rejects.toThrow();
  });

  it('enforces state graphs even for direct SQL updates', async () => {
    await expect(db().updateTable('matters').set({ status: 'CLOSED' }).where('id', '=', matterA).execute()).rejects.toThrow(/invalid matter state transition/i);
    await expect(db().updateTable('expedientes').set({ status: 'TRANSFERRED' }).where('id', '=', expedienteA).execute()).rejects.toThrow(/invalid expediente state transition/i);
    await expect(db().updateTable('archive_transfers').set({ status: 'COMPLETED' }).where('id', '=', transferA).execute()).rejects.toThrow(/invalid archive transfer state transition/i);
  });

  it('keeps versions attached to their logical document and binary metadata immutable', async () => {
    const documentOne = '00000000-0000-4000-8000-000000000024';
    const documentTwo = '00000000-0000-4000-8000-000000000025';
    const version = '00000000-0000-4000-8000-000000000026';
    await db().insertInto('documents').values([
      { id: documentOne, institution_id: institutionA, expediente_id: expedienteA, document_type: 'record', title: 'One' },
      { id: documentTwo, institution_id: institutionA, expediente_id: expedienteA, document_type: 'record', title: 'Two' },
    ]).execute();
    await db().insertInto('document_versions').values({ id: version, institution_id: institutionA, document_id: documentOne, version_number: 1, original_filename: 'one.pdf', detected_mime_type: 'application/pdf', size_bytes: 1, sha256: 'b'.repeat(64), storage_key: 'one', malware_scan_status: 'PENDING_SCAN', created_by: userA }).execute();
    await db().updateTable('documents').set({ current_version_id: version }).where('id', '=', documentOne).execute();
    await expect(db().updateTable('documents').set({ current_version_id: version }).where('id', '=', documentTwo).execute()).rejects.toThrow();
    await db().updateTable('document_versions').set({ malware_scan_status: 'CLEAN' }).where('id', '=', version).execute();
    await expect(db().updateTable('document_versions').set({ storage_key: 'overwritten' }).where('id', '=', version).execute()).rejects.toThrow(/immutable/i);
    await expect(db().deleteFrom('document_versions').where('id', '=', version).execute()).rejects.toThrow(/append-only/i);
    const stored = await db().selectFrom('document_versions').select(['malware_scan_status', 'access_classification_snapshot']).where('id', '=', version).executeTakeFirstOrThrow();
    expect(stored.malware_scan_status).toBe('CLEAN');
    expect(stored.access_classification_snapshot).toEqual({ legalClassification: 'PUBLIC', operationalVisibility: 'INSTITUTION' });
  });

  it('keeps assignment and transition history append-only', async () => {
    const assignmentId = '00000000-0000-4000-8000-000000000027';
    await db().insertInto('matter_assignments').values({ id: assignmentId, institution_id: institutionA, matter_id: matterA, unit_id: unitA }).execute();
    await expect(db().updateTable('matter_assignments').set({ unit_id: unitB }).where('id', '=', assignmentId).execute()).rejects.toThrow(/append-only/i);
    await expect(db().deleteFrom('matter_assignments').where('id', '=', assignmentId).execute()).rejects.toThrow(/append-only/i);
  });

  it('persists idempotent tenant-scoped integration intent without dispatching it', async () => {
    const input = { institutionId: institutionA, jobType: 'TEST_INTENT', aggregateType: 'matter', aggregateId: matterA, idempotencyKey: 'matter-a:test-intent', correlationId: 'corr-job', payload: { reason: 'test' } } as const;
    await asTenant(institutionA, async (transaction) => insertIntegrationJob(transaction, input));
    await asTenant(institutionA, async (transaction) => insertIntegrationJob(transaction, input));
    const ownJobs = await asTenant(institutionA, async (transaction) => transaction.selectFrom('integration_jobs').selectAll().where('idempotency_key', '=', input.idempotencyKey).execute());
    const otherJobs = await asTenant(institutionB, async (transaction) => transaction.selectFrom('integration_jobs').selectAll().where('idempotency_key', '=', input.idempotencyKey).execute());
    expect(ownJobs).toHaveLength(1);
    expect(ownJobs[0]).toMatchObject({ status: 'PENDING', attempt_count: 0, correlation_id: 'corr-job', payload: { reason: 'test' } });
    expect(otherJobs).toHaveLength(0);
  });

  it('hardens the OIDC bootstrap lookup and enforces both active statuses', async () => {
    await db().insertInto('external_identities').values([
      { id: '00000000-0000-4000-8000-000000000040', institution_id: institutionA, user_id: userA, issuer: 'https://issuer.example', subject: 'active-subject' },
      { id: '00000000-0000-4000-8000-000000000041', institution_id: institutionA, user_id: userA, issuer: 'https://issuer.example', subject: 'inactive-institution-subject' },
      { id: '00000000-0000-4000-8000-000000000042', institution_id: institutionB, user_id: userB, issuer: 'https://issuer.example', subject: 'inactive-user-subject' },
    ]).execute();
    const resolveAsApplication = async (subject: string) => db().transaction().execute(async (transaction) => {
      await sql`SET LOCAL ROLE ici_app`.execute(transaction);
      return sql<{ institution_id: string; institution_status: string; user_id: string; user_status: string }>`SELECT * FROM public.ici_resolve_external_identity('https://issuer.example', ${subject})`.execute(transaction);
    });
    const active = await resolveAsApplication('active-subject');
    expect(active.rows[0]).toMatchObject({ institution_id: institutionA, institution_status: 'ACTIVE', user_id: userA, user_status: 'ACTIVE' });
    await db().updateTable('institutions').set({ status: 'SUSPENDED' }).where('id', '=', institutionA).execute();
    await db().updateTable('users').set({ status: 'DISABLED' }).where('id', '=', userB).execute();
    const inactiveInstitution = await resolveAsApplication('inactive-institution-subject');
    expect(inactiveInstitution.rows[0]?.institution_status).toBe('SUSPENDED');
    const inactiveUser = await resolveAsApplication('inactive-user-subject');
    expect(inactiveUser.rows[0]?.user_status).toBe('DISABLED');
    expect(inactiveUser.rows[0]?.institution_status).toBe('ACTIVE');
  });

  it('restricts bootstrap execution to ici_app and uses a controlled definer search path', async () => {
    await sql`CREATE ROLE ici_public_test NOLOGIN`.execute(db());
    const functionInfo = await sql<{ security_type: string; proconfig: string[] | null; execute_public: boolean; execute_app: boolean }>`
      SELECT p.prosecdef::text AS security_type,
             p.proconfig,
             has_function_privilege('ici_public_test', 'public.ici_resolve_external_identity(text,text)', 'EXECUTE') AS execute_public,
             has_function_privilege('ici_app', 'public.ici_resolve_external_identity(text,text)', 'EXECUTE') AS execute_app
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'ici_resolve_external_identity'
    `.execute(db());
    expect(functionInfo.rows[0]).toMatchObject({ security_type: 'true', execute_public: false, execute_app: true });
    expect(functionInfo.rows[0]?.proconfig).toContain('search_path=pg_catalog');
    await expect(db().transaction().execute(async (transaction) => {
      await sql`SET LOCAL ROLE ici_public_test`.execute(transaction);
      await sql`SELECT * FROM public.ici_resolve_external_identity('https://issuer.example', 'active-subject')`.execute(transaction);
    })).rejects.toThrow(/permission denied/i);
  });
});
