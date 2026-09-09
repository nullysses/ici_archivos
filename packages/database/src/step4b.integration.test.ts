import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import {
  appendAuditEvent,
  applyFoundationMigrations,
  approveTransferAndManifestAtomically,
  createDatabase,
  createDocumentVersionMetadataAtomically,
  createExpedienteSchemaValidator,
  developmentSeedIds,
  publishExpedienteTypeVersionAtomically,
  resolveEffectivePermissions,
  seedDevelopmentReferenceData,
  tenantRepositories,
  withTenantContextTransaction,
  withTenantTransaction,
  type Database,
} from './index.js';

const institutionA = developmentSeedIds.institution;
const institutionB = '90000000-0000-4000-8000-000000000002';
const matterA = '90000000-0000-4000-8000-000000000003';
const matterB = '90000000-0000-4000-8000-000000000004';
const typeA = '90000000-0000-4000-8000-000000000005';
const versionA = '90000000-0000-4000-8000-000000000006';
const expedienteA = '90000000-0000-4000-8000-000000000007';
const documentA = '90000000-0000-4000-8000-000000000008';
const documentVersionOne = '90000000-0000-4000-8000-000000000009';
const documentVersionTwo = '90000000-0000-4000-8000-000000000010';
const transferA = '90000000-0000-4000-8000-000000000011';
const manifestA = '90000000-0000-4000-8000-000000000012';
const fixedNow = new Date('2026-09-09T12:00:00.000Z');

describe('Step 4b PostgreSQL persistence foundation', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let ownerDatabase: Database | undefined;
  let applicationDatabase: Database | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    const ownerUri = container.getConnectionUri();
    ownerDatabase = createDatabase(ownerUri);
    await sql`CREATE ROLE ici_app LOGIN NOSUPERUSER NOBYPASSRLS`.execute(ownerDatabase);
    await applyFoundationMigrations(ownerDatabase);
    const ownerUrl = new URL(ownerUri);
    const passwordStatement = await sql<{ statement: string }>`SELECT format('ALTER ROLE ici_app PASSWORD %L', ${ownerUrl.password}::text) AS statement`.execute(ownerDatabase);
    await sql.raw(passwordStatement.rows[0]?.statement ?? '').execute(ownerDatabase);
    const applicationUrl = new URL(ownerUri);
    applicationUrl.username = 'ici_app';
    applicationDatabase = createDatabase(applicationUrl.toString(), { maxConnections: 1 });

    await seedDevelopmentReferenceData(ownerDatabase);
    await ownerDatabase.insertInto('institutions').values({ id: institutionB, code: 'STEP4B-B', name: 'Step 4b B', status: 'ACTIVE' }).execute();
    await withTenantTransaction(ownerDatabase, institutionA, async (tx) => {
      await tx.insertInto('expediente_types').values({ id: typeA, institution_id: institutionA, code: 'STEP4B', name: 'Step 4b type', status: 'ACTIVE' }).execute();
      await tx.insertInto('expediente_type_versions').values({ id: versionA, institution_id: institutionA, expediente_type_id: typeA, version_number: 1, status: 'PUBLISHED', schema_json: { type: 'object' }, archival_mapping_json: {}, created_at: fixedNow, published_at: fixedNow }).execute();
      await tx.insertInto('expedientes').values({ id: expedienteA, institution_id: institutionA, folio: 'EXP-2026-000501', folio_year: 2026, sequence_number: 501, status: 'OPEN', expediente_type_version_id: versionA, metadata: { subject: 'Step 4b' }, opened_at: fixedNow }).execute();
      await tx.insertInto('matters').values({ id: matterA, institution_id: institutionA, folio: 'OP-2026-000501', folio_year: 2026, sequence_number: 501, status: 'RECEIVED', received_at: fixedNow, intake_metadata: { subject: 'A' }, linked_expediente_id: expedienteA }).execute();
      await tx.insertInto('matter_state_events').values({ institution_id: institutionA, matter_id: matterA, to_status: 'RECEIVED', command: 'registerMatter', event_data: {}, occurred_at: fixedNow }).execute();
      await tx.insertInto('documents').values({ id: documentA, institution_id: institutionA, expediente_id: expedienteA, document_type: 'record', title: 'Document' }).execute();
      await tx.insertInto('archive_transfers').values({ id: transferA, institution_id: institutionA, expediente_id: expedienteA, status: 'DRAFT' }).execute();
      await tx.insertInto('transfer_manifests').values({ id: manifestA, institution_id: institutionA, transfer_id: transferA, status: 'DRAFT', canonical_json: '{"version":1}' }).execute();
      await appendAuditEvent(tx, { institutionId: institutionA, actorUserId: developmentSeedIds.adminUser, eventType: 'fixture.created', aggregateType: 'matter', aggregateId: matterA, correlationId: 'step4b-fixture' });
    });
    await withTenantTransaction(ownerDatabase, institutionB, async (tx) => {
      await tx.insertInto('matters').values({ id: matterB, institution_id: institutionB, folio: 'OP-2026-000501', folio_year: 2026, sequence_number: 501, status: 'RECEIVED', received_at: fixedNow, intake_metadata: { subject: 'B' } }).execute();
    });
    await createDocumentVersionMetadataAtomically(applicationDatabase, { institutionId: institutionA, documentId: documentA, versionId: documentVersionOne, originalFilename: 'v1.pdf', detectedMimeType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64), storageKey: 'v1', malwareScanStatus: 'PENDING_SCAN', createdBy: developmentSeedIds.adminUser, correlationId: 'doc-v1' });
    await createDocumentVersionMetadataAtomically(applicationDatabase, { institutionId: institutionA, documentId: documentA, versionId: documentVersionTwo, originalFilename: 'v2.pdf', detectedMimeType: 'application/pdf', sizeBytes: 11, sha256: 'b'.repeat(64), storageKey: 'v2', malwareScanStatus: 'PENDING_SCAN', createdBy: developmentSeedIds.adminUser, replacementReason: 'Correction', correlationId: 'doc-v2' });
    const manifestHash = createHash('sha256').update('{"version":1}', 'utf8').digest('hex');
    await approveTransferAndManifestAtomically(applicationDatabase, { institutionId: institutionA, transferId: transferA, manifestId: manifestA, actorUserId: developmentSeedIds.adminUser, correlationId: 'transfer-approved', sha256: manifestHash, approvedAt: fixedNow });
  }, 120_000);

  afterAll(async () => {
    await applicationDatabase?.destroy();
    await ownerDatabase?.destroy();
    await container?.stop();
  });

  function owner(): Database { if (ownerDatabase === undefined) throw new Error('Owner database unavailable'); return ownerDatabase; }
  function app(): Database { if (applicationDatabase === undefined) throw new Error('Application database unavailable'); return applicationDatabase; }

  it('keeps tenant, actor, and correlation context local to commit and pool reuse', async () => {
    await withTenantContextTransaction(app(), { institutionId: institutionA, actorUserId: developmentSeedIds.adminUser, correlationId: 'ctx-a' }, async (tx) => {
      const context = await sql<{ tenant: string; actor: string; correlation: string }>`SELECT current_setting('app.institution_id', true) AS tenant, current_setting('app.actor_user_id', true) AS actor, current_setting('app.correlation_id', true) AS correlation`.execute(tx);
      expect(context.rows[0]).toEqual({ tenant: institutionA, actor: developmentSeedIds.adminUser, correlation: 'ctx-a' });
    });
    await app().transaction().execute(async (tx) => {
      const context = await sql<{ tenant: string | null; actor: string | null }>`SELECT nullif(current_setting('app.institution_id', true), '') AS tenant, nullif(current_setting('app.actor_user_id', true), '') AS actor`.execute(tx);
      expect(context.rows[0]).toEqual({ tenant: null, actor: null });
      expect(await tx.selectFrom('matters').select('id').execute()).toHaveLength(0);
    });
    await withTenantTransaction(app(), institutionB, async (tx) => expect((await tenantRepositories(tx, institutionB).matters.byId(matterB))?.id).toBe(matterB));
  });

  it('clears tenant context after rollback on the same pooled connection', async () => {
    await expect(withTenantTransaction(app(), institutionA, () => Promise.reject(new Error('rollback')))).rejects.toThrow('rollback');
    await app().transaction().execute(async (tx) => {
      const context = await sql<{ tenant: string | null }>`SELECT nullif(current_setting('app.institution_id', true), '') AS tenant`.execute(tx);
      expect(context.rows[0]?.tenant).toBeNull();
      expect(await tx.selectFrom('matters').select('id').execute()).toHaveLength(0);
    });
  });

  it('exercises tenant-scoped repository read models under RLS', async () => {
    await withTenantTransaction(app(), institutionA, async (tx) => {
      const repositories = tenantRepositories(tx, institutionA);
      expect((await repositories.matters.byFolio('OP-2026-000501'))?.id).toBe(matterA);
      expect(await repositories.matters.states(matterA)).toHaveLength(1);
      expect((await repositories.expedientes.byFolio('EXP-2026-000501'))?.id).toBe(expedienteA);
      expect((await repositories.expedientes.typeVersion(expedienteA))?.id).toBe(versionA);
      expect(await repositories.expedientes.linkedMatters(expedienteA)).toHaveLength(1);
      expect(await repositories.documents.versions(documentA)).toHaveLength(2);
      expect((await repositories.documents.currentVersion(documentA))?.id).toBe(documentVersionTwo);
      expect((await repositories.transfers.approvedManifest(transferA))?.id).toBe(manifestA);
      expect(await repositories.audit.forCorrelation('step4b-fixture')).toHaveLength(1);
    });
    await withTenantTransaction(app(), institutionB, async (tx) => {
      const repositories = tenantRepositories(tx, institutionB);
      expect(await repositories.matters.byId(matterA)).toBeUndefined();
      expect(await repositories.expedientes.byId(expedienteA)).toBeUndefined();
      expect(await repositories.documents.byId(documentA)).toBeUndefined();
      expect(await repositories.transfers.byId(transferA)).toBeUndefined();
      expect(await repositories.expedienteTypes.versionById(versionA)).toBeUndefined();
    });
  });

  it('seeds deterministic reference data idempotently without credentials', async () => {
    await seedDevelopmentReferenceData(owner());
    await seedDevelopmentReferenceData(owner());
    expect(Number((await owner().selectFrom('roles').select(({ fn }) => fn.countAll<number>().as('count')).executeTakeFirstOrThrow()).count)).toBe(5);
    expect(Number((await owner().selectFrom('permissions').select(({ fn }) => fn.countAll<number>().as('count')).executeTakeFirstOrThrow()).count)).toBe(22);
    expect(Number((await owner().selectFrom('role_permissions').select(({ fn }) => fn.countAll<number>().as('count')).executeTakeFirstOrThrow()).count)).toBe(28);
    expect((await owner().selectFrom('institutions').select('id').where('code', '=', 'TEST').executeTakeFirstOrThrow()).id).toBe(institutionA);
    const credentialColumns = await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* '(password|secret|credential)'`.execute(owner());
    expect(credentialColumns.rows).toHaveLength(0);
    await withTenantTransaction(app(), institutionA, async (tx) => expect(await tx.selectFrom('external_identities').select('id').execute()).toHaveLength(0));
  });

  it('resolves the union of institution-scoped role permissions without administrator escalation', async () => {
    await withTenantTransaction(app(), institutionA, async (tx) => {
      const authorizationTime = new Date('2026-09-10T00:00:00.000Z');
      const administrator = await resolveEffectivePermissions(tx, institutionA, developmentSeedIds.adminUser, authorizationTime);
      expect([...administrator].sort()).toEqual(['archive_transfer.retry', 'identity.manage', 'institution.configure', 'records.read']);
      await tx.insertInto('user_role_assignments').values({ id: '90000000-0000-4000-8000-000000000020', institution_id: institutionA, user_id: developmentSeedIds.adminUser, role_id: '10000000-0000-4000-8000-000000000002', effective_from: fixedNow }).execute();
      const union = await resolveEffectivePermissions(tx, institutionA, developmentSeedIds.adminUser, authorizationTime);
      expect(union.has('matter.register')).toBe(true);
      expect(union.has('matter.assign')).toBe(true);
      expect(union.has('identity.manage')).toBe(true);
      expect(union.has('archive_transfer.approve')).toBe(false);
      expect((await resolveEffectivePermissions(tx, institutionB, developmentSeedIds.adminUser, authorizationTime)).size).toBe(0);
    });
  });

  it('persists the complete integration-job retry lifecycle and tenant idempotency', async () => {
    const jobId = '90000000-0000-4000-8000-000000000030';
    const key = 'shared-key';
    await withTenantTransaction(app(), institutionA, async (tx) => {
      const repository = tenantRepositories(tx, institutionA);
      await repository.createIntegrationJob({ id: jobId, jobType: 'TEST', aggregateType: 'matter', aggregateId: matterA, idempotencyKey: key, correlationId: 'job-a', payload: {} });
      await repository.createIntegrationJob({ id: '90000000-0000-4000-8000-000000000031', jobType: 'TEST', aggregateType: 'matter', aggregateId: matterA, idempotencyKey: key, correlationId: 'duplicate', payload: {} });
      await repository.markJobAttempt(jobId, fixedNow);
      await repository.markJobFailed(jobId, 'temporary');
      const retryAt = new Date(fixedNow.getTime() + 60_000);
      await repository.scheduleJobRetry(jobId, retryAt);
      expect(await repository.jobs.retryable(fixedNow)).toHaveLength(0);
      await expect(repository.markJobAttempt(jobId, fixedNow)).rejects.toThrow(/expected state/i);
      await repository.markJobAttempt(jobId, retryAt);
      await repository.markJobSucceeded(jobId);
      expect(await repository.createIntegrationJob({ jobType: 'TEST', aggregateType: 'matter', aggregateId: matterA, idempotencyKey: key, correlationId: 'duplicate-2', payload: {} })).toMatchObject({ id: jobId });
      expect(await repository.jobs.byId(jobId)).toMatchObject({ status: 'SUCCEEDED', attempt_count: 2, last_error: 'temporary' });
    });
    await withTenantTransaction(app(), institutionB, async (tx) => {
      const repository = tenantRepositories(tx, institutionB);
      const other = await repository.createIntegrationJob({ id: '90000000-0000-4000-8000-000000000032', jobType: 'TEST', aggregateType: 'matter', aggregateId: matterB, idempotencyKey: key, correlationId: 'job-b', payload: {} });
      expect(other).toMatchObject({ institution_id: institutionB });
      expect(await repository.jobs.byId(jobId)).toBeUndefined();
    });
  });

  it('enforces migration 003 job bounds, transitions, durability, and terminal immutability', async () => {
    await withTenantTransaction(app(), institutionA, async (tx) => {
      const id = '90000000-0000-4000-8000-000000000040';
      await tx.insertInto('integration_jobs').values({ id, institution_id: institutionA, job_type: 'TEST', aggregate_type: 'matter', aggregate_id: matterA, status: 'PENDING', idempotency_key: 'migration-003', correlation_id: 'migration-003', attempt_count: 0, payload: {} }).execute();
    });
    await expect(withTenantTransaction(app(), institutionA, async (tx) => {
      const id = '90000000-0000-4000-8000-000000000040';
      await tx.updateTable('integration_jobs').set({ status: 'SUCCEEDED' }).where('id', '=', id).execute();
    })).rejects.toThrow(/invalid integration job transition/i);
    await withTenantTransaction(app(), institutionA, async (tx) => {
      const id = '90000000-0000-4000-8000-000000000040';
      await tx.updateTable('integration_jobs').set({ status: 'RUNNING', attempt_count: 1 }).where('id', '=', id).execute();
    });
    await expect(withTenantTransaction(app(), institutionA, async (tx) => {
      const id = '90000000-0000-4000-8000-000000000040';
      await tx.updateTable('integration_jobs').set({ status: 'FAILED', last_error: 'x'.repeat(4001) }).where('id', '=', id).execute();
    })).rejects.toThrow(/last_error_size/i);
    await withTenantTransaction(app(), institutionA, async (tx) => {
      const id = '90000000-0000-4000-8000-000000000040';
      await tx.updateTable('integration_jobs').set({ status: 'SUCCEEDED' }).where('id', '=', id).execute();
    });
    await expect(withTenantTransaction(app(), institutionA, async (tx) => {
      await tx.updateTable('integration_jobs').set({ status: 'FAILED' }).where('id', '=', '90000000-0000-4000-8000-000000000040').execute();
    })).rejects.toThrow();
    await expect(withTenantTransaction(app(), institutionA, async (tx) => {
      await tx.deleteFrom('integration_jobs').where('id', '=', '90000000-0000-4000-8000-000000000040').execute();
    })).rejects.toThrow(/durable/i);
  });

  it('installs the Step 4b lookup indexes without a duplicate transfer index', async () => {
    const indexes = await sql<{ indexname: string; indexdef: string }>`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`.execute(owner());
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get('user_role_assignments_effective_idx')).toContain('institution_id');
    expect(byName.get('audit_events_actor_idx')).toContain('actor_user_id');
    expect(byName.get('audit_events_correlation_idx')).toContain('correlation_id');
    expect(byName.get('documents_expediente_created_idx')).toContain('created_at');
    expect(byName.has('archive_transfers_expediente_idx')).toBe(false);
    expect(byName.has('transfers_expediente_idx')).toBe(true);
  });

  it('requires concrete JSON Schema validation before publication and preserves published contents', async () => {
    const validator = createExpedienteSchemaValidator();
    const invalid = '90000000-0000-4000-8000-000000000050';
    const valid = '90000000-0000-4000-8000-000000000051';
    await withTenantTransaction(owner(), institutionA, async (tx) => tx.insertInto('expediente_type_versions').values({ id: invalid, institution_id: institutionA, expediente_type_id: typeA, version_number: 2, status: 'DRAFT', schema_json: { type: 17 }, archival_mapping_json: {}, created_at: fixedNow }).execute());
    await expect(publishExpedienteTypeVersionAtomically(app(), { institutionId: institutionA, versionId: invalid, correlationId: 'invalid-schema', publishedAt: fixedNow }, (schema) => validator.validateDefinition(schema))).rejects.toThrow(/schema/i);
    await withTenantTransaction(owner(), institutionA, async (tx) => {
      await tx.deleteFrom('expediente_type_versions').where('id', '=', invalid).execute();
      await tx.insertInto('expediente_type_versions').values({ id: valid, institution_id: institutionA, expediente_type_id: typeA, version_number: 2, status: 'DRAFT', schema_json: { type: 'object', required: ['subject'], properties: { subject: { type: 'string' } } }, archival_mapping_json: {}, created_at: fixedNow }).execute();
    });
    await publishExpedienteTypeVersionAtomically(app(), { institutionId: institutionA, versionId: valid, correlationId: 'valid-schema', publishedAt: fixedNow }, (schema) => validator.validateDefinition(schema));
    await withTenantTransaction(app(), institutionA, async (tx) => {
      expect(await tenantRepositories(tx, institutionA).expedienteTypes.versionById(valid)).toMatchObject({ status: 'PUBLISHED' });
      await expect(tx.updateTable('expediente_type_versions').set({ schema_json: {} }).where('id', '=', valid).execute()).rejects.toThrow(/immutable/i);
    });
  });
});
