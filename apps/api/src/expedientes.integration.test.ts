import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { acceptExpedienteDocumentUploadAtomically, applyFoundationMigrations, authorizeDocumentVersionUploadPreflight, beginArchiveTransferPreservationAtomically, cancelArchiveTransferAtomically, claimArchiveTransferPreservationJobs, completeArchiveTransferPreservationAtomically, createDatabase, failArchiveTransferPreservationAtomically, type Database } from '@ici/database';
import { createApp } from './app.js';
import type { AuthenticatedPrincipal } from './auth.js';
import { createExpedienteApplicationService } from './expedientes.js';
import { createArchiveTransferApplicationService } from './transfers.js';

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
const documentClassification = '21000000-0000-4000-8000-00000000000c';
const documentExpediente = '21000000-0000-4000-8000-00000000000d';

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
      { id: publishedVersionA, institution_id: institutionA, expediente_type_id: typeA, version_number: 1, status: 'PUBLISHED', schema_json: schema, archival_mapping_json: { levelOfDescription: 'File' }, published_at: new Date('2026-01-01T00:00:00.000Z') },
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
      authorization: { userId: userA, institutionId: institutionA, institutionCapabilities: new Set(['expediente.create', 'records.read', 'expediente.edit_open', 'document.version_open']), unitCapabilities: new Map() },
    };
    app = await createApp({
      authenticateAccessToken: () => Promise.resolve(principal),
      expedienteService: createExpedienteApplicationService(database),
      archiveTransferService: createArchiveTransferApplicationService(database),
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

  it('accepts an expediente-owned first document with a durable malware job and immutable classification snapshot', async () => {
    await db().insertInto('access_classifications').values({ id: documentClassification, institution_id: institutionA, legal_classification: 'PUBLIC', operational_visibility: 'INSTITUTION' }).execute();
    await db().insertInto('expedientes').values({ id: documentExpediente, institution_id: institutionA, folio: 'EXP-2026-000901', folio_year: 2026, sequence_number: 901, status: 'OPEN', expediente_type_version_id: publishedVersionA, metadata: { title: 'Document owner' }, opened_at: new Date('2026-01-01T00:00:00.000Z') }).execute();
    const documentId = '21000000-0000-4000-8000-00000000000e';
    const versionId = '21000000-0000-4000-8000-00000000000f';
    const accepted = await acceptExpedienteDocumentUploadAtomically(db(), {
      institutionId: institutionA, expedienteId: documentExpediente, documentId, versionId,
      documentType: 'resolution', title: 'Resolution', accessClassificationId: documentClassification,
      originalFilename: 'resolution.pdf', detectedMimeType: 'application/pdf', declaredMimeType: 'application/pdf',
      sizeBytes: 12, sha256: 'a'.repeat(64), storageKey: `v1/${institutionA}/${versionId}`, malwareScanStatus: 'PENDING_SCAN',
      createdBy: userA, correlationId: 'expediente-document-acceptance', authorizationContext: principal.authorization,
    });
    expect(accepted.document).toMatchObject({ expediente_id: documentExpediente, matter_id: null, current_version_id: versionId, access_classification_id: documentClassification });
    expect(accepted.version).toMatchObject({ version_number: 1, malware_scan_status: 'PENDING_SCAN', access_classification_snapshot: { legalClassification: 'PUBLIC', operationalVisibility: 'INSTITUTION' } });
    expect(accepted.job).toMatchObject({ job_type: 'document.malware_scan', aggregate_type: 'document_version', aggregate_id: versionId, status: 'PENDING' });
    expect(await db().selectFrom('audit_events').select('event_type').where('aggregate_id', '=', documentId).orderBy('occurred_at').execute()).toEqual([{ event_type: 'document.created' }, { event_type: 'document.version_created' }]);
  });

  it('reports a closed expediente as a state conflict during version preflight', async () => {
    await db().updateTable('document_versions').set({ malware_scan_status: 'CLEAN' }).where('id', '=', '21000000-0000-4000-8000-00000000000f').execute();
    await db().updateTable('expedientes').set({ status: 'CLOSED' }).where('id', '=', documentExpediente).execute();
    await expect(authorizeDocumentVersionUploadPreflight(db(), { institutionId: institutionA, documentId: '21000000-0000-4000-8000-00000000000e', actorUserId: userA, authorizationContext: principal.authorization })).rejects.toMatchObject({ code: 'EXPEDIENTE_NOT_OPEN' });
    await db().updateTable('expedientes').set({ status: 'OPEN' }).where('id', '=', documentExpediente).execute();
  });

  it('rejects unpublished, foreign, and invalid metadata before commit', async () => {
    for (const version of [draftVersionA, retiredVersionA, publishedVersionB]) {
      const response = await api().inject({ method: 'POST', url: '/expedientes', headers: { authorization: 'Bearer test' }, payload: { expedienteTypeVersionId: version, metadata: { title: 'Solicitud' } } });
      expect(response.statusCode).toBe(400);
    }
    const invalid = await api().inject({ method: 'POST', url: '/expedientes', headers: { authorization: 'Bearer test' }, payload: { expedienteTypeVersionId: publishedVersionA, metadata: {} } });
    expect(invalid.statusCode).toBe(400);
    expect(await db().selectFrom('expedientes').select('id').where('institution_id', '=', institutionA).where('id', '!=', documentExpediente).execute()).toHaveLength(1);
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

  it('closes an expediente through the authenticated path and audits the closure atomically', async () => {
    principal = {
      ...principal,
      authorization: {
        ...principal.authorization,
        institutionCapabilities: new Set(['expediente.create', 'records.read', 'expediente.close']),
        unitCapabilities: new Map(),
      },
    };
    const created = await api().inject({ method: 'POST', url: '/expedientes', headers: { authorization: 'Bearer test' }, payload: { expedienteTypeVersionId: publishedVersionA, metadata: { title: 'Closure test' } } });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    const closed = await api().inject({ method: 'POST', url: `/expedientes/${id}/close`, headers: { authorization: 'Bearer test' }, payload: { closureMetadata: { reason: 'Ready for transfer' } } });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ id, status: 'CLOSED' });

    const row = await db().selectFrom('expedientes').select(['status', 'closed_at']).where('institution_id', '=', institutionA).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('CLOSED');
    expect(row.closed_at).not.toBeNull();
    const stateEvent = await db().selectFrom('expediente_state_events').select(['command', 'event_data']).where('institution_id', '=', institutionA).where('expediente_id', '=', id).where('command', '=', 'closeExpediente').executeTakeFirstOrThrow();
    expect(stateEvent.event_data).toMatchObject({ metadataValid: true, closureMetadata: { reason: 'Ready for transfer' } });
    const audit = await db().selectFrom('audit_events').select(['event_type', 'event_data']).where('institution_id', '=', institutionA).where('aggregate_type', '=', 'expediente').where('aggregate_id', '=', id).where('event_type', '=', 'expediente.closed').executeTakeFirstOrThrow();
    expect(audit.event_data).toMatchObject({ metadataValid: true, closureMetadata: { reason: 'Ready for transfer' } });

    const repeated = await api().inject({ method: 'POST', url: `/expedientes/${id}/close`, headers: { authorization: 'Bearer test' }, payload: { closureMetadata: { reason: 'Again' } } });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({ error: { code: 'INVALID_TRANSITION' } });
  });

  it('creates and approves a canonical transfer manifest for a closed expediente', async () => {
    principal = {
      ...principal,
      authorization: {
        ...principal.authorization,
        institutionCapabilities: new Set(['expediente.create', 'records.read', 'archive_transfer.prepare', 'archive_transfer.approve', 'archive_transfer.retry']),
        unitCapabilities: new Map(),
      },
    };
    const created = await api().inject({ method: 'POST', url: '/expedientes', headers: { authorization: 'Bearer test' }, payload: { expedienteTypeVersionId: publishedVersionA, metadata: { title: 'Transfer source' } } });
    const expedienteId = created.json<{ id: string }>().id;
    await db().updateTable('expedientes').set({ status: 'CLOSED', closed_at: new Date('2026-09-14T00:00:00.000Z') }).where('institution_id', '=', institutionA).where('id', '=', expedienteId).execute();

    const draft = await api().inject({ method: 'POST', url: `/expedientes/${expedienteId}/archive-transfers`, headers: { authorization: 'Bearer test' }, payload: {} });
    expect(draft.statusCode).toBe(201);
    const draftBody = draft.json<{ id: string; status: string; expedienteId: string; manifest: { id: string; status: string; canonicalJson: string; sha256: string | null; documents: unknown[] } }>();
    expect(draftBody).toMatchObject({ status: 'DRAFT', expedienteId, manifest: { status: 'DRAFT', sha256: null, documents: [] } });
    expect((await db().selectFrom('expedientes').select('status').where('institution_id', '=', institutionA).where('id', '=', expedienteId).executeTakeFirst())?.status).toBe('TRANSFER_PENDING');
    const canonical = JSON.parse(draftBody.manifest.canonicalJson) as { expedienteId: string; folio: string; documents: unknown[] };
    expect(canonical).toMatchObject({ expedienteId, documents: [] });

    const approved = await api().inject({ method: 'POST', url: `/archive-transfers/${draftBody.id}/approve`, headers: { authorization: 'Bearer test' }, payload: {} });
    expect(approved.statusCode).toBe(200);
    const approvedBody = approved.json<{ status: string; manifest: { status: string; sha256: string | null } }>();
    expect(approvedBody.status).toBe('APPROVED');
    expect(approvedBody.manifest.status).toBe('APPROVED');
    expect(approvedBody.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    const cancelExpedienteResponse = await api().inject({ method: 'POST', url: '/expedientes', headers: { authorization: 'Bearer test' }, payload: { expedienteTypeVersionId: publishedVersionA, metadata: { title: 'Cancellation source' } } });
    const cancelExpedienteId = cancelExpedienteResponse.json<{ id: string }>().id;
    await db().updateTable('expedientes').set({ status: 'CLOSED', closed_at: new Date('2026-09-14T00:00:00.000Z') }).where('institution_id', '=', institutionA).where('id', '=', cancelExpedienteId).execute();
    const cancelDraft = await api().inject({ method: 'POST', url: `/expedientes/${cancelExpedienteId}/archive-transfers`, headers: { authorization: 'Bearer test' }, payload: {} });
    const cancelDraftBody = cancelDraft.json<{ id: string; manifest: { canonicalJson: string } }>();
    expect((await api().inject({ method: 'POST', url: `/archive-transfers/${cancelDraftBody.id}/approve`, headers: { authorization: 'Bearer test' }, payload: {} })).statusCode).toBe(200);
    const cancelResponse = await api().inject({ method: 'POST', url: `/archive-transfers/${cancelDraftBody.id}/cancel`, headers: { authorization: 'Bearer test' }, payload: { reason: 'Cancelled before submission' } });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json<{ status: string; manifest: { canonicalJson: string; status: string } }>()).toMatchObject({ status: 'CANCELLED', manifest: { status: 'APPROVED', canonicalJson: cancelDraftBody.manifest.canonicalJson } });
    expect((await db().selectFrom('expedientes').select('status').where('id', '=', cancelExpedienteId).executeTakeFirstOrThrow()).status).toBe('CLOSED');
    const cancelledJobs = await db().selectFrom('integration_jobs').select(['status', 'id']).where('institution_id', '=', institutionA).where('aggregate_id', '=', cancelDraftBody.id).execute();
    expect(cancelledJobs).toHaveLength(1);
    expect(cancelledJobs[0]?.status).toBe('CANCELLED');
    expect(cancelledJobs[0]?.id).toBeTruthy();
    const submittedJob = await db().selectFrom('integration_jobs').selectAll().where('institution_id', '=', institutionA).where('aggregate_id', '=', draftBody.id).executeTakeFirstOrThrow();
    expect(submittedJob).toMatchObject({ job_type: 'archive_transfer.preserve', aggregate_type: 'archive_transfer', status: 'PENDING', idempotency_key: `archive-transfer-preserve:${draftBody.id}` });
    expect((await db().selectFrom('archive_transfers').select('status').where('id', '=', draftBody.id).executeTakeFirstOrThrow()).status).toBe('APPROVED');
    const firstClaim = await claimArchiveTransferPreservationJobs(db(), institutionA, 1);
    const claimedJob = firstClaim.find((job) => job.id === submittedJob.id);
    expect(claimedJob?.status).toBe('RUNNING');
    expect(claimedJob?.claim_token).toBeTruthy();
    expect(claimedJob?.attempt_count).toBe(1);
    const claimToken = claimedJob?.claim_token ?? '';
    await beginArchiveTransferPreservationAtomically(db(), { institutionId: institutionA, transferId: draftBody.id, jobId: submittedJob.id, claimToken, correlationId: 'transfer-preserving' });
    expect((await db().selectFrom('archive_transfers').select('status').where('id', '=', draftBody.id).executeTakeFirstOrThrow()).status).toBe('PRESERVING');
    await failArchiveTransferPreservationAtomically(db(), { institutionId: institutionA, transferId: draftBody.id, jobId: submittedJob.id, claimToken, reason: 'Temporary preservation outage', correlationId: 'transfer-failed' });
    expect(await db().selectFrom('integration_jobs').select(['status', 'last_error']).where('id', '=', submittedJob.id).executeTakeFirstOrThrow()).toMatchObject({ status: 'FAILED', last_error: 'Temporary preservation outage' });
    expect((await db().selectFrom('archive_transfers').select('status').where('id', '=', draftBody.id).executeTakeFirstOrThrow()).status).toBe('FAILED');
    const retried = await api().inject({ method: 'POST', url: `/archive-transfers/${draftBody.id}/retry`, headers: { authorization: 'Bearer test' }, payload: {} });
    expect(retried.statusCode).toBe(200);
    expect(retried.json<{ status: string }>().status).toBe('SUBMITTED');
    expect(await db().selectFrom('integration_jobs').select(['id', 'status', 'attempt_count', 'last_error']).where('id', '=', submittedJob.id).executeTakeFirstOrThrow()).toMatchObject({ id: submittedJob.id, status: 'PENDING', attempt_count: 1, last_error: null });
    const secondClaim = await claimArchiveTransferPreservationJobs(db(), institutionA, 1);
    const reclaimedJob = secondClaim.find((job) => job.id === submittedJob.id);
    expect(reclaimedJob?.claim_token).toBeTruthy();
    expect(reclaimedJob?.claim_token).not.toBe(claimToken);
    await expect(beginArchiveTransferPreservationAtomically(db(), { institutionId: institutionA, transferId: draftBody.id, jobId: submittedJob.id, claimToken, correlationId: 'stale-transfer-claim' })).rejects.toThrow(/claim/i);
    await beginArchiveTransferPreservationAtomically(db(), { institutionId: institutionA, transferId: draftBody.id, jobId: submittedJob.id, claimToken: reclaimedJob?.claim_token ?? '', correlationId: 'transfer-preserving-retry' });
    await completeArchiveTransferPreservationAtomically(db(), { institutionId: institutionA, transferId: draftBody.id, jobId: submittedJob.id, claimToken: reclaimedJob?.claim_token ?? '', correlationId: 'transfer-completed', approvedManifestPreserved: true, aipStored: true, archivalIntegrationCompleted: true });
    expect((await db().selectFrom('integration_jobs').select('status').where('id', '=', submittedJob.id).executeTakeFirstOrThrow()).status).toBe('SUCCEEDED');
    expect((await db().selectFrom('archive_transfers').select('status').where('id', '=', draftBody.id).executeTakeFirstOrThrow()).status).toBe('COMPLETED');
    expect((await db().selectFrom('expedientes').select('status').where('id', '=', expedienteId).executeTakeFirstOrThrow()).status).toBe('TRANSFERRED');
    expect(await db().selectFrom('expediente_state_events').select(['from_status', 'to_status', 'command']).where('institution_id', '=', institutionA).where('expediente_id', '=', expedienteId).execute()).toEqual(expect.arrayContaining([{ from_status: 'TRANSFER_PENDING', to_status: 'TRANSFERRED', command: 'completeTransfer' }]));
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionA).where('aggregate_type', '=', 'archive_transfer').where('aggregate_id', '=', draftBody.id).execute()).toEqual(expect.arrayContaining([{ event_type: 'archive_transfer.submitted' }, { event_type: 'archive_transfer.preserving' }, { event_type: 'archive_transfer.failed' }, { event_type: 'archive_transfer.retried' }, { event_type: 'archive_transfer.completed' }]));
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionA).where('aggregate_type', '=', 'expediente').where('aggregate_id', '=', expedienteId).execute()).toEqual(expect.arrayContaining([{ event_type: 'expediente.transfer_completed' }]));
    expect((await api().inject({ method: 'GET', url: `/archive-transfers/${draftBody.id}`, headers: { authorization: 'Bearer test' } })).statusCode).toBe(200);
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionA).where('aggregate_id', '=', draftBody.id).execute()).toEqual(expect.arrayContaining([{ event_type: 'archive_transfer.created' }, { event_type: 'archive_transfer.approved' }]));
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionA).where('aggregate_type', '=', 'expediente').where('aggregate_id', '=', expedienteId).execute()).toEqual(expect.arrayContaining([{ event_type: 'expediente.transfer_prepared' }]));
    expect(await db().selectFrom('expediente_state_events').select(['from_status', 'to_status', 'command']).where('institution_id', '=', institutionA).where('expediente_id', '=', expedienteId).execute()).toEqual(expect.arrayContaining([{ from_status: 'CLOSED', to_status: 'TRANSFER_PENDING', command: 'prepareTransfer' }]));
  });

  it('serializes preservation begin against cancellation without a deadlock', async () => {
    principal = {
      ...principal,
      authorization: {
        ...principal.authorization,
        institutionCapabilities: new Set(['expediente.create', 'records.read', 'archive_transfer.prepare', 'archive_transfer.approve']),
        unitCapabilities: new Map(),
      },
    };
    const created = await api().inject({ method: 'POST', url: '/expedientes', headers: { authorization: 'Bearer test' }, payload: { expedienteTypeVersionId: publishedVersionA, metadata: { title: 'Lock ordering' } } });
    const expedienteId = created.json<{ id: string }>().id;
    await db().updateTable('expedientes').set({ status: 'CLOSED', closed_at: new Date('2026-09-14T00:00:00.000Z') }).where('institution_id', '=', institutionA).where('id', '=', expedienteId).execute();
    const draft = await api().inject({ method: 'POST', url: `/expedientes/${expedienteId}/archive-transfers`, headers: { authorization: 'Bearer test' }, payload: {} });
    const draftBody = draft.json<{ id: string }>();
    expect((await api().inject({ method: 'POST', url: `/archive-transfers/${draftBody.id}/approve`, headers: { authorization: 'Bearer test' }, payload: {} })).statusCode).toBe(200);
    const job = await db().selectFrom('integration_jobs').selectAll().where('institution_id', '=', institutionA).where('aggregate_id', '=', draftBody.id).executeTakeFirstOrThrow();
    const [claimed] = await claimArchiveTransferPreservationJobs(db(), institutionA, 1);
    expect(claimed?.id).toBe(job.id);
    const claimToken = claimed?.claim_token ?? '';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        Promise.allSettled([
          beginArchiveTransferPreservationAtomically(db(), { institutionId: institutionA, transferId: draftBody.id, jobId: job.id, claimToken, correlationId: 'concurrent-begin' }),
          cancelArchiveTransferAtomically(db(), { institutionId: institutionA, transferId: draftBody.id, actorUserId: userA, reason: 'Cancellation race', correlationId: 'concurrent-cancel', authorizationContext: principal.authorization }),
        ]),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('transfer lifecycle operations deadlocked')), 5000); }),
      ]);
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = settled.find((result) => result.status === 'rejected');
      expect(rejected?.status).toBe('rejected');
      if (rejected?.status === 'rejected') {
        const code = (rejected.reason as { code?: string }).code;
        expect(['CANCELLATION_NOT_SAFE', 'INVALID_TRANSITION']).toContain(code);
        expect(code).not.toBe('40P01');
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    const finalRaceStatus = (await db().selectFrom('archive_transfers').select('status').where('institution_id', '=', institutionA).where('id', '=', draftBody.id).executeTakeFirstOrThrow()).status;
    expect(finalRaceStatus).toBe('PRESERVING');
  });
});
