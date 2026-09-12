import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import {
  appendAuditEvent,
  assignMatterAtomically,
  applyFoundationMigrations,
  approveTransferAndManifestAtomically,
  acceptMatterDocumentUploadAtomically,
  acceptMatterDocumentVersionUploadAtomically,
  authorizeMatterDocumentDownload,
  claimMalwareScanJobs,
  canPerform,
  createDatabase,
  createDocumentVersionMetadataAtomically,
  createExpedienteSchemaValidator,
  developmentSeedIds,
  persistMatterTransition,
  prepareMalwareRetryAtomically,
  publishExpedienteTypeVersionAtomically,
  registerMatterAtomically,
  recordMalwareScanResultAtomically,
  resolveAuthorizationContext,
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
const classificationA = '90000000-0000-4000-8000-000000000013';
const matterDocumentA = '90000000-0000-4000-8000-000000000014';
const matterDocumentVersionA = '90000000-0000-4000-8000-000000000015';

function assignmentAuthorization(userId: string, institutionId: string) {
  return { userId, institutionId, institutionCapabilities: new Set(['matter.assign'] as const), unitCapabilities: new Map() };
}

function documentAuthorization(userId: string, institutionId: string) {
  return { userId, institutionId, institutionCapabilities: new Set(['records.read', 'document.version_open'] as const), unitCapabilities: new Map() };
}

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
      await tx.insertInto('access_classifications').values({ id: classificationA, institution_id: institutionA, legal_classification: 'PUBLIC', operational_visibility: 'INSTITUTION' }).execute();
      await tx.insertInto('matters').values({ id: matterA, institution_id: institutionA, folio: 'OP-2026-000501', folio_year: 2026, sequence_number: 501, status: 'RECEIVED', received_at: fixedNow, intake_metadata: { subject: 'A', operationalVisibility: 'INSTITUTION' }, linked_expediente_id: expedienteA, access_classification_id: classificationA }).execute();
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

  it('accepts a matter document with a durable malware job and atomically records scan outcomes', async () => {
    const document = await acceptMatterDocumentUploadAtomically(app(), {
      institutionId: institutionA,
      matterId: matterA,
      documentId: matterDocumentA,
      versionId: matterDocumentVersionA,
      documentType: 'record',
      title: 'Matter document',
      originalFilename: 'received.pdf',
      detectedMimeType: 'application/pdf',
      declaredMimeType: 'application/pdf',
      sizeBytes: 12,
      sha256: 'c'.repeat(64),
      storageKey: 'v1/matter-document',
      malwareScanStatus: 'PENDING_SCAN',
      createdBy: developmentSeedIds.adminUser,
      correlationId: 'matter-document-accepted',
      authorizationContext: documentAuthorization(developmentSeedIds.adminUser, institutionA),
    });
    expect(document.version.version_number).toBe(1);
    expect(document.version.malware_scan_status).toBe('PENDING_SCAN');
    expect(document.document.current_version_id).toBe(matterDocumentVersionA);
    expect(document.job.idempotency_key).toBe(`malware-scan:${matterDocumentVersionA}`);
    const audits = await withTenantTransaction(app(), institutionA, (tx) => tx.selectFrom('audit_events').select('event_type').where('aggregate_id', '=', matterDocumentA).orderBy('occurred_at').execute());
    expect(audits.map((row) => row.event_type)).toEqual(['document.created', 'document.version_created']);

    const claimed = await claimMalwareScanJobs(app(), institutionA, 1, fixedNow);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.attempt_count).toBe(1);
    await recordMalwareScanResultAtomically(app(), { institutionId: institutionA, jobId: claimed[0]?.id ?? '', claimToken: claimed[0]?.claim_token ?? '', versionId: matterDocumentVersionA, scanId: '90000000-0000-4000-8000-000000000016', result: 'CLEAN', engine: 'clamd', scannedAt: fixedNow, correlationId: 'matter-document-scan' });
    const download = await authorizeMatterDocumentDownload(app(), { institutionId: institutionA, documentId: matterDocumentA, versionId: matterDocumentVersionA, authorizationContext: documentAuthorization(developmentSeedIds.adminUser, institutionA) });
    expect(download.sha256).toBe('c'.repeat(64));
    expect(download.sizeBytes).toBe('12');
    const replacement = await acceptMatterDocumentVersionUploadAtomically(app(), {
      institutionId: institutionA,
      documentId: matterDocumentA,
      versionId: '90000000-0000-4000-8000-00000000001a',
      originalFilename: 'replacement.pdf',
      detectedMimeType: 'application/pdf',
      sizeBytes: 13,
      sha256: 'e'.repeat(64),
      storageKey: 'v1/matter-document-replacement',
      malwareScanStatus: 'PENDING_SCAN',
      createdBy: developmentSeedIds.adminUser,
      replacementReason: 'Corrected source file',
      correlationId: 'matter-document-replacement',
      authorizationContext: documentAuthorization(developmentSeedIds.adminUser, institutionA),
    });
    expect(replacement.version.version_number).toBe(2);
  });

  it('serializes failed malware scans and durable retries', async () => {
    const document = '90000000-0000-4000-8000-000000000017';
    const version = '90000000-0000-4000-8000-000000000018';
    await acceptMatterDocumentUploadAtomically(app(), { institutionId: institutionA, matterId: matterA, documentId: document, versionId: version, documentType: 'record', title: 'Retry document', originalFilename: 'retry.pdf', detectedMimeType: 'application/pdf', sizeBytes: 4, sha256: 'd'.repeat(64), storageKey: 'v1/retry-document', malwareScanStatus: 'PENDING_SCAN', createdBy: developmentSeedIds.adminUser, correlationId: 'retry-accept', authorizationContext: documentAuthorization(developmentSeedIds.adminUser, institutionA) });
    const claimed = (await claimMalwareScanJobs(app(), institutionA, 10, fixedNow)).find((job) => job.aggregate_id === version);
    expect(claimed).toBeDefined();
    await recordMalwareScanResultAtomically(app(), { institutionId: institutionA, jobId: claimed?.id ?? '', claimToken: claimed?.claim_token ?? '', versionId: version, scanId: '90000000-0000-4000-8000-000000000019', result: 'SCAN_FAILED', engine: 'clamd', error: 'daemon unavailable', scannedAt: fixedNow, correlationId: 'retry-failed' });
    await prepareMalwareRetryAtomically(app(), { institutionId: institutionA, jobId: claimed?.id ?? '', versionId: version, nextAttemptAt: new Date(fixedNow.getTime() + 60_000), correlationId: 'retry-scheduled' });
    const retry = (await claimMalwareScanJobs(app(), institutionA, 10, new Date(fixedNow.getTime() + 60_001))).find((job) => job.aggregate_id === version);
    expect(retry?.attempt_count).toBe(2);
  });

  it('rejects unrelated integration jobs and inconsistent matter visibility', async () => {
    const unrelatedJob = '90000000-0000-4000-8000-00000000001b';
    await withTenantTransaction(owner(), institutionA, async (tx) => {
      await tx.insertInto('integration_jobs').values({ id: unrelatedJob, institution_id: institutionA, job_type: 'atom.sync', aggregate_type: 'document_version', aggregate_id: matterDocumentVersionA, status: 'PENDING', idempotency_key: 'unrelated-document-job', correlation_id: 'unrelated-document-job', attempt_count: 0, payload: {} }).execute();
      await tx.updateTable('integration_jobs').set({ status: 'RUNNING', attempt_count: 1 }).where('id', '=', unrelatedJob).execute();
    });
      await expect(recordMalwareScanResultAtomically(app(), { institutionId: institutionA, jobId: unrelatedJob, claimToken: 'not-the-claim', versionId: matterDocumentVersionA, scanId: '90000000-0000-4000-8000-00000000001c', result: 'CLEAN', engine: 'clamd', correlationId: 'unrelated-document-job' })).rejects.toThrow(/malware scan job/i);

    const mismatchClassification = '90000000-0000-4000-8000-00000000001d';
    const mismatchMatter = '90000000-0000-4000-8000-00000000001e';
    const mismatchDocument = '90000000-0000-4000-8000-00000000001f';
    await withTenantTransaction(owner(), institutionA, async (tx) => {
      await tx.insertInto('access_classifications').values({ id: mismatchClassification, institution_id: institutionA, legal_classification: 'PUBLIC', operational_visibility: 'UNIT' }).execute();
      await tx.insertInto('matters').values({ id: mismatchMatter, institution_id: institutionA, folio: 'OP-2026-000605', folio_year: 2026, sequence_number: 605, status: 'RECEIVED', received_at: fixedNow, intake_metadata: { operationalVisibility: 'INSTITUTION' }, access_classification_id: mismatchClassification }).execute();
    });
    await expect(acceptMatterDocumentUploadAtomically(app(), { institutionId: institutionA, matterId: mismatchMatter, documentId: mismatchDocument, versionId: '90000000-0000-4000-8000-000000000020', documentType: 'record', title: 'Mismatch', originalFilename: 'mismatch.pdf', detectedMimeType: 'application/pdf', sizeBytes: 1, sha256: 'f'.repeat(64), storageKey: 'mismatch', malwareScanStatus: 'PENDING_SCAN', createdBy: developmentSeedIds.adminUser, correlationId: 'visibility-mismatch', authorizationContext: documentAuthorization(developmentSeedIds.adminUser, institutionA) })).rejects.toThrow(/visibility/i);
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
      const authorizationTime = new Date('2026-09-12T00:00:00.000Z');
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

  it('preserves capability provenance across active unit assignments', async () => {
    const user = '90000000-0000-4000-8000-000000000100';
    const firstUnit = '90000000-0000-4000-8000-000000000102';
    const secondUnit = '90000000-0000-4000-8000-000000000103';
    const officialiaRole = '10000000-0000-4000-8000-000000000002';
    const gestorRole = '10000000-0000-4000-8000-000000000003';
    const at = new Date('2026-09-10T00:00:00.000Z');
    await withTenantTransaction(app(), institutionA, async (tx) => {
      await tx.insertInto('organizational_units').values([
        { id: firstUnit, institution_id: institutionA, code: 'SCOPE-A', name: 'Scope A', status: 'ACTIVE' },
        { id: secondUnit, institution_id: institutionA, code: 'SCOPE-B', name: 'Scope B', status: 'ACTIVE' },
      ]).execute();
      await tx.insertInto('users').values({ id: user, institution_id: institutionA, display_name: 'Scoped user', status: 'ACTIVE' }).execute();
      await tx.insertInto('user_role_assignments').values([
        { id: '90000000-0000-4000-8000-000000000110', institution_id: institutionA, user_id: user, role_id: officialiaRole, unit_id: firstUnit, effective_from: fixedNow },
        { id: '90000000-0000-4000-8000-000000000111', institution_id: institutionA, user_id: user, role_id: gestorRole, unit_id: secondUnit, effective_from: fixedNow },
        { id: '90000000-0000-4000-8000-000000000112', institution_id: institutionA, user_id: user, role_id: gestorRole, unit_id: secondUnit, effective_from: fixedNow },
        { id: '90000000-0000-4000-8000-000000000113', institution_id: institutionA, user_id: user, role_id: gestorRole, unit_id: firstUnit, effective_from: new Date('2026-09-01T00:00:00.000Z'), effective_until: new Date('2026-09-09T00:00:00.000Z') },
        { id: '90000000-0000-4000-8000-000000000114', institution_id: institutionA, user_id: user, role_id: officialiaRole, unit_id: secondUnit, effective_from: new Date('2026-09-11T00:00:00.000Z') },
      ]).execute();
      const context = await resolveAuthorizationContext(tx, institutionA, user, at);
      expect(canPerform(context, 'matter.assign', firstUnit)).toBe(true);
      expect(canPerform(context, 'matter.start', secondUnit)).toBe(true);
      expect(canPerform(context, 'matter.start', firstUnit)).toBe(false);
      expect(canPerform(context, 'matter.assign', secondUnit)).toBe(false);
      expect(canPerform(context, 'matter.start')).toBe(false);
      expect(context.unitCapabilities.get(secondUnit)).toContain('matter.start');
      expect(context.unitCapabilities.size).toBe(2);
      expect(await resolveEffectivePermissions(tx, institutionA, user, at)).toEqual(new Set());
    });
  });

  it('resolves institution-wide and unit-specific grants without losing scope', async () => {
    const user = '90000000-0000-4000-8000-000000000101';
    const firstUnit = '90000000-0000-4000-8000-000000000117';
    const secondUnit = '90000000-0000-4000-8000-000000000118';
    const officialiaRole = '10000000-0000-4000-8000-000000000002';
    const gestorRole = '10000000-0000-4000-8000-000000000003';
    await withTenantTransaction(app(), institutionA, async (tx) => {
      await tx.insertInto('organizational_units').values([
        { id: firstUnit, institution_id: institutionA, code: 'MIXED-A', name: 'Mixed A', status: 'ACTIVE' },
        { id: secondUnit, institution_id: institutionA, code: 'MIXED-B', name: 'Mixed B', status: 'ACTIVE' },
      ]).execute();
      await tx.insertInto('users').values({ id: user, institution_id: institutionA, display_name: 'Mixed scope user', status: 'ACTIVE' }).execute();
      await tx.insertInto('user_role_assignments').values([
        { id: '90000000-0000-4000-8000-000000000115', institution_id: institutionA, user_id: user, role_id: gestorRole, effective_from: fixedNow },
        { id: '90000000-0000-4000-8000-000000000119', institution_id: institutionA, user_id: user, role_id: officialiaRole, unit_id: firstUnit, effective_from: fixedNow },
      ]).execute();
      const context = await resolveAuthorizationContext(tx, institutionA, user, new Date('2026-09-10T00:00:00.000Z'));
      expect(canPerform(context, 'matter.start')).toBe(true);
      expect(canPerform(context, 'matter.start', firstUnit)).toBe(true);
      expect(canPerform(context, 'matter.start', secondUnit)).toBe(true);
      expect(canPerform(context, 'matter.assign', firstUnit)).toBe(true);
      expect(canPerform(context, 'matter.assign', secondUnit)).toBe(false);
    });
  });

  it('keeps scoped authorization isolated by institution through RLS', async () => {
    const otherInstitutionUser = '90000000-0000-4000-8000-000000000104';
    const otherInstitutionUnit = '90000000-0000-4000-8000-000000000105';
    const gestorRole = '10000000-0000-4000-8000-000000000003';
    await withTenantTransaction(owner(), institutionB, async (tx) => {
      await tx.insertInto('organizational_units').values({ id: otherInstitutionUnit, institution_id: institutionB, code: 'SCOPE-B', name: 'Other scope', status: 'ACTIVE' }).execute();
      await tx.insertInto('users').values({ id: otherInstitutionUser, institution_id: institutionB, display_name: 'Other scoped user', status: 'ACTIVE' }).execute();
      await tx.insertInto('user_role_assignments').values({ id: '90000000-0000-4000-8000-000000000116', institution_id: institutionB, user_id: otherInstitutionUser, role_id: gestorRole, unit_id: otherInstitutionUnit, effective_from: fixedNow }).execute();
    });
    await withTenantTransaction(app(), institutionA, async (tx) => {
      const context = await resolveAuthorizationContext(tx, institutionA, otherInstitutionUser, new Date('2026-09-10T00:00:00.000Z'));
      expect(context.institutionCapabilities.size).toBe(0);
      expect(context.unitCapabilities.size).toBe(0);
    });
    await withTenantTransaction(app(), institutionB, async (tx) => {
      const context = await resolveAuthorizationContext(tx, institutionB, otherInstitutionUser, new Date('2026-09-10T00:00:00.000Z'));
      expect(canPerform(context, 'matter.start', otherInstitutionUnit)).toBe(true);
    });
  });

  it('starts assigned matters for the current assignee or a server-authorized unit member', async () => {
    const actor = '90000000-0000-4000-8000-000000000120';
    const otherUser = '90000000-0000-4000-8000-000000000121';
    const authorizedUnit = '90000000-0000-4000-8000-000000000122';
    const directOnlyUnit = '90000000-0000-4000-8000-000000000136';
    const directMatter = '90000000-0000-4000-8000-000000000123';
    const unitMatter = '90000000-0000-4000-8000-000000000124';
    const gestorRole = '10000000-0000-4000-8000-000000000003';
    const authorizationContext = await withTenantTransaction(app(), institutionA, async (tx) => {
      await tx.insertInto('organizational_units').values([
        { id: authorizedUnit, institution_id: institutionA, code: 'START', name: 'Start unit', status: 'ACTIVE' },
        { id: directOnlyUnit, institution_id: institutionA, code: 'DIRECT', name: 'Direct assignment unit', status: 'ACTIVE' },
      ]).execute();
      await tx.insertInto('users').values([
        { id: actor, institution_id: institutionA, display_name: 'Actor', status: 'ACTIVE' },
        { id: otherUser, institution_id: institutionA, display_name: 'Other', status: 'ACTIVE' },
      ]).execute();
      await tx.insertInto('user_role_assignments').values({ id: '90000000-0000-4000-8000-000000000125', institution_id: institutionA, user_id: actor, role_id: gestorRole, unit_id: authorizedUnit, effective_from: fixedNow }).execute();
      return resolveAuthorizationContext(tx, institutionA, actor, new Date('2026-09-10T00:00:00.000Z'));
    });
    await registerMatterAtomically(app(), { id: directMatter, institutionId: institutionA, receivedAt: fixedNow, intakeMetadata: { subject: 'direct' }, correlationId: 'fixture-direct', actorUserId: actor, year: 2026 });
    await registerMatterAtomically(app(), { id: unitMatter, institutionId: institutionA, receivedAt: fixedNow, intakeMetadata: { subject: 'unit' }, correlationId: 'fixture-unit', actorUserId: actor, year: 2026 });
    await assignMatterAtomically(app(), { institutionId: institutionA, matterId: directMatter, assignmentId: '90000000-0000-4000-8000-000000000126', unitId: directOnlyUnit, userId: actor, actorUserId: actor, correlationId: 'fixture-direct-assignment', command: 'assignMatter', fromStatus: 'RECEIVED', assignedAt: fixedNow, authorizationContext: assignmentAuthorization(actor, institutionA) });
    await assignMatterAtomically(app(), { institutionId: institutionA, matterId: unitMatter, assignmentId: '90000000-0000-4000-8000-000000000127', unitId: authorizedUnit, userId: otherUser, actorUserId: actor, correlationId: 'fixture-unit-assignment', command: 'assignMatter', fromStatus: 'RECEIVED', assignedAt: fixedNow, authorizationContext: assignmentAuthorization(actor, institutionA) });
    await persistMatterTransition(app(), { institutionId: institutionA, aggregateId: directMatter, actorUserId: actor, authorizationContext, correlationId: 'start-direct', command: 'startMatter', fromStatus: 'ASSIGNED', toStatus: 'IN_PROGRESS' });
    await persistMatterTransition(app(), { institutionId: institutionA, aggregateId: unitMatter, actorUserId: actor, authorizationContext, correlationId: 'start-unit', command: 'startMatter', fromStatus: 'ASSIGNED', toStatus: 'IN_PROGRESS' });
    await withTenantTransaction(app(), institutionA, async (tx) => {
      expect((await tenantRepositories(tx, institutionA).matters.byId(directMatter))?.status).toBe('IN_PROGRESS');
      expect((await tenantRepositories(tx, institutionA).matters.byId(unitMatter))?.status).toBe('IN_PROGRESS');
      expect(await tenantRepositories(tx, institutionA).audit.forCorrelation('start-direct')).toHaveLength(1);
      expect(await tenantRepositories(tx, institutionA).audit.forCorrelation('start-unit')).toHaveLength(1);
    });
  });

  it('rejects cross-product and forged startMatter authorization without persisting partial state', async () => {
    const actor = '90000000-0000-4000-8000-000000000130';
    const assignee = '90000000-0000-4000-8000-000000000131';
    const assignedUnit = '90000000-0000-4000-8000-000000000132';
    const startUnit = '90000000-0000-4000-8000-000000000140';
    const matter = '90000000-0000-4000-8000-000000000133';
    const officialiaRole = '10000000-0000-4000-8000-000000000002';
    const gestorRole = '10000000-0000-4000-8000-000000000003';
    const authorizationContext = await withTenantTransaction(app(), institutionA, async (tx) => {
      await tx.insertInto('organizational_units').values([
        { id: assignedUnit, institution_id: institutionA, code: 'DENY', name: 'Denied unit', status: 'ACTIVE' },
        { id: startUnit, institution_id: institutionA, code: 'START-ELSEWHERE', name: 'Start elsewhere', status: 'ACTIVE' },
      ]).execute();
      await tx.insertInto('users').values([
        { id: actor, institution_id: institutionA, display_name: 'Unscoped actor', status: 'ACTIVE' },
        { id: assignee, institution_id: institutionA, display_name: 'Assignee', status: 'ACTIVE' },
      ]).execute();
      await tx.insertInto('user_role_assignments').values([
        { id: '90000000-0000-4000-8000-000000000134', institution_id: institutionA, user_id: actor, role_id: officialiaRole, unit_id: assignedUnit, effective_from: fixedNow },
        { id: '90000000-0000-4000-8000-000000000137', institution_id: institutionA, user_id: actor, role_id: gestorRole, unit_id: startUnit, effective_from: fixedNow },
      ]).execute();
      const context = await resolveAuthorizationContext(tx, institutionA, actor, new Date('2026-09-10T00:00:00.000Z'));
      expect(canPerform(context, 'matter.assign', assignedUnit)).toBe(true);
      expect(canPerform(context, 'matter.start', startUnit)).toBe(true);
      expect(canPerform(context, 'matter.start', assignedUnit)).toBe(false);
      return context;
    });
    await registerMatterAtomically(app(), { id: matter, institutionId: institutionA, receivedAt: fixedNow, intakeMetadata: { subject: 'denied' }, correlationId: 'fixture-denied', actorUserId: actor, year: 2026 });
    await assignMatterAtomically(app(), { institutionId: institutionA, matterId: matter, assignmentId: '90000000-0000-4000-8000-000000000135', unitId: assignedUnit, userId: assignee, actorUserId: actor, correlationId: 'fixture-denied-assignment', command: 'assignMatter', fromStatus: 'RECEIVED', assignedAt: fixedNow, authorizationContext: assignmentAuthorization(actor, institutionA) });
    const baseInput = { institutionId: institutionA, aggregateId: matter, actorUserId: actor, authorizationContext, command: 'startMatter', fromStatus: 'ASSIGNED', toStatus: 'IN_PROGRESS' } as const;
    await expect(persistMatterTransition(app(), { ...baseInput, correlationId: 'start-denied' })).rejects.toThrow(/not the current assignee/i);
    await expect(persistMatterTransition(app(), { ...baseInput, correlationId: 'start-forged', eventData: { authorizedUnitIds: [assignedUnit] } })).rejects.toThrow(/must not be supplied in event data/i);
    await withTenantTransaction(app(), institutionA, async (tx) => {
      expect((await tenantRepositories(tx, institutionA).matters.byId(matter))?.status).toBe('ASSIGNED');
      expect(await tenantRepositories(tx, institutionA).matters.states(matter)).toHaveLength(2);
      expect(await tenantRepositories(tx, institutionA).audit.forCorrelation('start-denied')).toHaveLength(0);
      expect(await tenantRepositories(tx, institutionA).audit.forCorrelation('start-forged')).toHaveLength(0);
    });
  });

  it('allows startMatter through an institution-wide matter.start grant', async () => {
    const actor = '90000000-0000-4000-8000-000000000141';
    const assignee = '90000000-0000-4000-8000-000000000142';
    const assignedUnit = '90000000-0000-4000-8000-000000000143';
    const matter = '90000000-0000-4000-8000-000000000144';
    const gestorRole = '10000000-0000-4000-8000-000000000003';
    const authorizationContext = await withTenantTransaction(app(), institutionA, async (tx) => {
      await tx.insertInto('organizational_units').values({ id: assignedUnit, institution_id: institutionA, code: 'INSTITUTION-START', name: 'Institution start unit', status: 'ACTIVE' }).execute();
      await tx.insertInto('users').values([
        { id: actor, institution_id: institutionA, display_name: 'Institution-wide actor', status: 'ACTIVE' },
        { id: assignee, institution_id: institutionA, display_name: 'Institution-wide assignee', status: 'ACTIVE' },
      ]).execute();
      await tx.insertInto('user_role_assignments').values({ id: '90000000-0000-4000-8000-000000000145', institution_id: institutionA, user_id: actor, role_id: gestorRole, effective_from: fixedNow }).execute();
      return resolveAuthorizationContext(tx, institutionA, actor, new Date('2026-09-10T00:00:00.000Z'));
    });
    await registerMatterAtomically(app(), { id: matter, institutionId: institutionA, receivedAt: fixedNow, intakeMetadata: { subject: 'institution-wide start' }, correlationId: 'fixture-institution-start', actorUserId: actor, year: 2026 });
    await assignMatterAtomically(app(), { institutionId: institutionA, matterId: matter, assignmentId: '90000000-0000-4000-8000-000000000146', unitId: assignedUnit, userId: assignee, actorUserId: actor, correlationId: 'fixture-institution-start-assignment', command: 'assignMatter', fromStatus: 'RECEIVED', assignedAt: fixedNow, authorizationContext: assignmentAuthorization(actor, institutionA) });
    await persistMatterTransition(app(), { institutionId: institutionA, aggregateId: matter, actorUserId: actor, authorizationContext, correlationId: 'start-institution-wide', command: 'startMatter', fromStatus: 'ASSIGNED', toStatus: 'IN_PROGRESS' });
    await withTenantTransaction(app(), institutionA, async (tx) => {
      expect((await tenantRepositories(tx, institutionA).matters.byId(matter))?.status).toBe('IN_PROGRESS');
      expect(await tenantRepositories(tx, institutionA).audit.forCorrelation('start-institution-wide')).toHaveLength(1);
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

  it('creates and promotes versions for non-terminal matter-owned documents atomically', async () => {
    const matter = '90000000-0000-4000-8000-000000000060';
    const document = '90000000-0000-4000-8000-000000000061';
    await withTenantTransaction(owner(), institutionA, async (tx) => {
      await tx.insertInto('matters').values({ id: matter, institution_id: institutionA, folio: 'OP-2026-000601', folio_year: 2026, sequence_number: 601, status: 'RECEIVED', received_at: fixedNow, intake_metadata: { subject: 'matter document', operationalVisibility: 'INSTITUTION' }, access_classification_id: classificationA }).execute();
    });
    await acceptMatterDocumentUploadAtomically(app(), { institutionId: institutionA, matterId: matter, documentId: document, versionId: '90000000-0000-4000-8000-000000000062', documentType: 'record', title: 'Matter document', originalFilename: 'one.pdf', detectedMimeType: 'application/pdf', sizeBytes: 1, sha256: 'c'.repeat(64), storageKey: 'matter-one', malwareScanStatus: 'PENDING_SCAN', createdBy: developmentSeedIds.adminUser, correlationId: 'matter-v1', authorizationContext: documentAuthorization(developmentSeedIds.adminUser, institutionA) });
    await withTenantTransaction(owner(), institutionA, async (tx) => { await sql`ALTER TABLE matters DISABLE TRIGGER USER`.execute(tx); await tx.updateTable('matters').set({ status: 'IN_PROGRESS' }).where('id', '=', matter).execute(); await sql`ALTER TABLE matters ENABLE TRIGGER USER`.execute(tx); });
    await acceptMatterDocumentVersionUploadAtomically(app(), { institutionId: institutionA, documentId: document, versionId: '90000000-0000-4000-8000-000000000063', originalFilename: 'two.pdf', detectedMimeType: 'application/pdf', sizeBytes: 2, sha256: 'd'.repeat(64), storageKey: 'matter-two', malwareScanStatus: 'PENDING_SCAN', createdBy: developmentSeedIds.adminUser, replacementReason: 'replacement', correlationId: 'matter-v2', authorizationContext: documentAuthorization(developmentSeedIds.adminUser, institutionA) });
    await withTenantTransaction(app(), institutionA, async (tx) => {
      expect(await tenantRepositories(tx, institutionA).documents.versions(document)).toMatchObject([{ version_number: 2 }, { version_number: 1 }]);
      expect((await tenantRepositories(tx, institutionA).documents.byId(document))?.current_version_id).toBe('90000000-0000-4000-8000-000000000063');
      expect(await tenantRepositories(tx, institutionA).audit.forCorrelation('matter-v1')).toHaveLength(2);
    });
  });

  it('rejects CLOSED and VOIDED matter and closed expediente document versions without audit', async () => {
    const voidedMatter = '90000000-0000-4000-8000-000000000064';
    const voidedMatterDocument = '90000000-0000-4000-8000-000000000065';
    const closedExpedienteDocument = '90000000-0000-4000-8000-000000000066';
    const closedMatter = '90000000-0000-4000-8000-000000000073';
    const closedMatterDocument = '90000000-0000-4000-8000-000000000074';
    await withTenantTransaction(owner(), institutionA, async (tx) => {
      await tx.insertInto('matters').values([
        { id: voidedMatter, institution_id: institutionA, folio: 'OP-2026-000602', folio_year: 2026, sequence_number: 602, status: 'RECEIVED', received_at: fixedNow, intake_metadata: { subject: 'voided terminal' } },
        { id: closedMatter, institution_id: institutionA, folio: 'OP-2026-000604', folio_year: 2026, sequence_number: 604, status: 'RECEIVED', received_at: fixedNow, intake_metadata: { subject: 'closed terminal' } },
      ]).execute();
      await sql`ALTER TABLE matters DISABLE TRIGGER USER`.execute(tx);
      await tx.updateTable('matters').set({ status: 'VOIDED' }).where('id', '=', voidedMatter).execute();
      await tx.updateTable('matters').set({ status: 'CLOSED' }).where('id', '=', closedMatter).execute();
      await sql`ALTER TABLE matters ENABLE TRIGGER USER`.execute(tx);
      await tx.insertInto('documents').values([
        { id: voidedMatterDocument, institution_id: institutionA, matter_id: voidedMatter, document_type: 'record', title: 'voided terminal' },
        { id: closedMatterDocument, institution_id: institutionA, matter_id: closedMatter, document_type: 'record', title: 'closed terminal' },
        { id: closedExpedienteDocument, institution_id: institutionA, expediente_id: expedienteA, document_type: 'record', title: 'closed exp' },
      ]).execute();
    });
    await createDocumentVersionMetadataAtomically(app(), {
      institutionId: institutionA,
      documentId: closedExpedienteDocument,
      versionId: '90000000-0000-4000-8000-000000000080',
      originalFilename: 'open.pdf',
      detectedMimeType: 'application/pdf',
      sizeBytes: 1,
      sha256: '2'.repeat(64),
      storageKey: 'open-expediente',
      malwareScanStatus: 'PENDING_SCAN',
      createdBy: developmentSeedIds.adminUser,
      correlationId: 'open-expediente',
    });
    await withTenantTransaction(owner(), institutionA, async (tx) => {
      await sql`ALTER TABLE expedientes DISABLE TRIGGER USER`.execute(tx); await tx.updateTable('expedientes').set({ status: 'CLOSED' }).where('id', '=', expedienteA).execute(); await sql`ALTER TABLE expedientes ENABLE TRIGGER USER`.execute(tx);
    });
    const input = (documentId: string, versionId: string, correlationId: string) => ({ institutionId: institutionA, documentId, versionId, originalFilename: 'blocked.pdf', detectedMimeType: 'application/pdf', sizeBytes: 1, sha256: 'e'.repeat(64), storageKey: versionId, malwareScanStatus: 'PENDING_SCAN' as const, createdBy: developmentSeedIds.adminUser, replacementReason: 'blocked replacement', correlationId });
    await expect(createDocumentVersionMetadataAtomically(app(), input(voidedMatterDocument, '90000000-0000-4000-8000-000000000067', 'voided-matter'))).rejects.toThrow();
    await expect(createDocumentVersionMetadataAtomically(app(), input(closedExpedienteDocument, '90000000-0000-4000-8000-000000000068', 'closed-exp'))).rejects.toThrow();
    await expect(createDocumentVersionMetadataAtomically(app(), input(closedMatterDocument, '90000000-0000-4000-8000-000000000075', 'closed-matter'))).rejects.toThrow();
    await withTenantTransaction(app(), institutionA, async (tx) => {
      for (const [documentId, correlationId] of [[voidedMatterDocument, 'voided-matter'], [closedMatterDocument, 'closed-matter']] as const) {
        expect(await tenantRepositories(tx, institutionA).documents.versions(documentId)).toHaveLength(0);
        expect(await tenantRepositories(tx, institutionA).audit.forCorrelation(correlationId)).toHaveLength(0);
      }
      expect(await tenantRepositories(tx, institutionA).documents.versions(closedExpedienteDocument)).toMatchObject([{ version_number: 1 }]);
      expect((await tenantRepositories(tx, institutionA).documents.byId(closedExpedienteDocument))?.current_version_id).toBe('90000000-0000-4000-8000-000000000080');
      expect(await tenantRepositories(tx, institutionA).audit.forCorrelation('open-expediente')).toHaveLength(1);
      expect(await tenantRepositories(tx, institutionA).audit.forCorrelation('closed-exp')).toHaveLength(0);
    });
  });

  it('fails closed for malformed logical documents with invalid parent ownership', async () => {
    const noParent = '90000000-0000-4000-8000-000000000076';
    const bothParents = '90000000-0000-4000-8000-000000000078';
    await sql`ALTER TABLE documents DROP CONSTRAINT documents_exactly_one_parent_check`.execute(owner());
    try {
      await withTenantTransaction(owner(), institutionA, async (tx) => {
        await tx.insertInto('documents').values([
          { id: noParent, institution_id: institutionA, document_type: 'record', title: 'No-parent fixture' },
          { id: bothParents, institution_id: institutionA, expediente_id: expedienteA, matter_id: matterA, document_type: 'record', title: 'Both-parents fixture' },
        ]).execute();
      });
      const input = (documentId: string, versionId: string, correlationId: string) => ({ institutionId: institutionA, documentId, versionId, originalFilename: 'invalid.pdf', detectedMimeType: 'application/pdf', sizeBytes: 1, sha256: '1'.repeat(64), storageKey: correlationId, malwareScanStatus: 'PENDING_SCAN' as const, createdBy: developmentSeedIds.adminUser, correlationId });
      await expect(createDocumentVersionMetadataAtomically(app(), input(noParent, '90000000-0000-4000-8000-000000000077', 'invalid-no-parent'))).rejects.toThrow(/exactly one parent/i);
      await expect(createDocumentVersionMetadataAtomically(app(), input(bothParents, '90000000-0000-4000-8000-000000000079', 'invalid-both-parents'))).rejects.toThrow(/exactly one parent/i);
      await withTenantTransaction(app(), institutionA, async (tx) => {
        for (const [documentId, correlationId] of [[noParent, 'invalid-no-parent'], [bothParents, 'invalid-both-parents']] as const) {
          expect(await tenantRepositories(tx, institutionA).documents.versions(documentId)).toHaveLength(0);
          expect(await tenantRepositories(tx, institutionA).audit.forCorrelation(correlationId)).toHaveLength(0);
        }
      });
    } finally {
      await withTenantTransaction(owner(), institutionA, async (tx) => { await tx.deleteFrom('documents').where('id', 'in', [noParent, bothParents]).execute(); });
      await sql`ALTER TABLE documents ADD CONSTRAINT documents_exactly_one_parent_check CHECK ((expediente_id IS NOT NULL AND matter_id IS NULL) OR (expediente_id IS NULL AND matter_id IS NOT NULL))`.execute(owner());
    }
  });

  it('serializes concurrent versions for one matter-owned logical document', async () => {
    const matter = '90000000-0000-4000-8000-000000000069';
    const document = '90000000-0000-4000-8000-000000000070';
    await withTenantTransaction(owner(), institutionA, async (tx) => {
      await tx.insertInto('matters').values({ id: matter, institution_id: institutionA, folio: 'OP-2026-000603', folio_year: 2026, sequence_number: 603, status: 'RECEIVED', received_at: fixedNow, intake_metadata: { subject: 'concurrent', operationalVisibility: 'INSTITUTION' }, access_classification_id: classificationA }).execute();
    });
    await acceptMatterDocumentUploadAtomically(app(), { institutionId: institutionA, matterId: matter, documentId: document, versionId: '90000000-0000-4000-8000-000000000071', documentType: 'record', title: 'Concurrent', originalFilename: 'initial.pdf', detectedMimeType: 'application/pdf', sizeBytes: 1, sha256: 'a'.repeat(64), storageKey: 'initial-concurrent', malwareScanStatus: 'PENDING_SCAN', createdBy: developmentSeedIds.adminUser, correlationId: 'concurrent-initial', authorizationContext: documentAuthorization(developmentSeedIds.adminUser, institutionA) });
    const version = (id: string, hash: string, correlationId: string) => acceptMatterDocumentVersionUploadAtomically(app(), { institutionId: institutionA, documentId: document, versionId: id, originalFilename: `${id}.pdf`, detectedMimeType: 'application/pdf', sizeBytes: 1, sha256: hash, storageKey: id, malwareScanStatus: 'PENDING_SCAN', createdBy: developmentSeedIds.adminUser, replacementReason: 'concurrent request', correlationId, authorizationContext: documentAuthorization(developmentSeedIds.adminUser, institutionA) });
    await Promise.all([version('90000000-0000-4000-8000-000000000072', 'f'.repeat(64), 'concurrent-1'), version('90000000-0000-4000-8000-000000000073', '0'.repeat(64), 'concurrent-2')]);
    await withTenantTransaction(app(), institutionA, async (tx) => {
      const versions = await tenantRepositories(tx, institutionA).documents.versions(document);
      expect(versions.map((row) => row.version_number).sort()).toEqual([1, 2, 3]);
      expect((await tenantRepositories(tx, institutionA).documents.byId(document))?.current_version_id).toBe(versions[0]?.id);
    });
  });
});
