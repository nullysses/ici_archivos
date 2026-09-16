import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import {
  applyFoundationMigrations,
  approveArchiveTransferManifestAtomically,
  createArchiveTransferAndDraftManifestAtomically,
  createDatabase,
  createExpedienteAtomically,
  createExpedienteSchemaValidator,
  findAtomMapping,
  loadApprovedExpedienteAtomSyncContext,
  markAtomMappingFailed,
  persistExpedienteTransition,
  reserveAtomMapping,
  saveAtomMapping,
  setExpedienteArchivalParentAtomically,
  type Database,
} from './index.js';
import type { AuthorizationContext } from '@ici/domain';

const institutionId = '56000000-0000-4000-8000-000000000001';
const foreignInstitutionId = '56000000-0000-4000-8000-000000000002';
const userId = '56000000-0000-4000-8000-000000000003';
const typeId = '56000000-0000-4000-8000-000000000004';
const typeVersionId = '56000000-0000-4000-8000-000000000005';
const expedienteId = '56000000-0000-4000-8000-000000000006';
const seriesId = '56000000-0000-4000-8000-000000000007';
const subseriesId = '56000000-0000-4000-8000-000000000008';
const fondsId = '56000000-0000-4000-8000-000000000009';
const foreignSeriesId = '56000000-0000-4000-8000-00000000000a';
const transferId = '56000000-0000-4000-8000-00000000000b';
const manifestId = '56000000-0000-4000-8000-00000000000c';
const fixedNow = new Date('2026-09-15T12:00:00.000Z');

describe('expediente archival parent precondition', () => {
  let database: Database | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    database = createDatabase(container.getConnectionUri());
    await sql`CREATE ROLE ici_app NOLOGIN NOSUPERUSER NOBYPASSRLS`.execute(database);
    await applyFoundationMigrations(database);
    await database.insertInto('institutions').values([
      { id: institutionId, code: 'PARENT-A', name: 'Archival parent A', status: 'ACTIVE' },
      { id: foreignInstitutionId, code: 'PARENT-B', name: 'Archival parent B', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('users').values({ id: userId, institution_id: institutionId, display_name: 'Parent operator', status: 'ACTIVE' }).execute();
    await database.insertInto('expediente_types').values({ id: typeId, institution_id: institutionId, code: 'PARENT-TYPE', name: 'Parent type', status: 'ACTIVE' }).execute();
    await database.insertInto('expediente_type_versions').values({ id: typeVersionId, institution_id: institutionId, expediente_type_id: typeId, version_number: 1, status: 'PUBLISHED', schema_json: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }, archival_mapping_json: { levelOfDescription: 'File' }, published_at: fixedNow }).execute();
    await database.insertInto('archival_classification_nodes').values([
      { id: seriesId, institution_id: institutionId, node_type: 'SERIES', code: 'SERIES-A', name: 'Series A', metadata: {} },
      { id: subseriesId, institution_id: institutionId, node_type: 'SUBSERIES', code: 'SUBSERIES-A', name: 'Subseries A', metadata: {} },
      { id: fondsId, institution_id: institutionId, node_type: 'FONDS', code: 'FONDS-A', name: 'Fonds A', metadata: {} },
      { id: foreignSeriesId, institution_id: foreignInstitutionId, node_type: 'SERIES', code: 'SERIES-B', name: 'Series B', metadata: {} },
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

  const authorization: AuthorizationContext = {
    userId,
    institutionId,
    institutionCapabilities: new Set(['archive_transfer.prepare', 'expediente.close']),
    unitCapabilities: new Map(),
  };

  it('assigns and corrects the parent before preparation, then freezes it in the manifest', async () => {
    await createExpedienteAtomically(db(), { id: expedienteId, institutionId, expedienteTypeVersionId: typeVersionId, metadata: { title: 'Parent test' }, actorUserId: userId, correlationId: 'parent-create' }, createExpedienteSchemaValidator().validateMetadata);

    await setExpedienteArchivalParentAtomically(db(), { institutionId, expedienteId, archivalParentNodeId: seriesId, actorUserId: userId, correlationId: 'parent-set', authorizationContext: authorization });
    expect((await db().selectFrom('expedientes').select('archival_parent_node_id').where('id', '=', expedienteId).executeTakeFirstOrThrow()).archival_parent_node_id).toBe(seriesId);
    await setExpedienteArchivalParentAtomically(db(), { institutionId, expedienteId, archivalParentNodeId: subseriesId, actorUserId: userId, correlationId: 'parent-correct', authorizationContext: authorization });
    expect((await db().selectFrom('expedientes').select('archival_parent_node_id').where('id', '=', expedienteId).executeTakeFirstOrThrow()).archival_parent_node_id).toBe(subseriesId);
    await expect(setExpedienteArchivalParentAtomically(db(), { institutionId, expedienteId, archivalParentNodeId: fondsId, actorUserId: userId, correlationId: 'parent-fonds', authorizationContext: authorization })).rejects.toMatchObject({ code: 'ARCHIVAL_PARENT_INVALID' });
    await expect(setExpedienteArchivalParentAtomically(db(), { institutionId, expedienteId, archivalParentNodeId: foreignSeriesId, actorUserId: userId, correlationId: 'parent-foreign', authorizationContext: authorization })).rejects.toMatchObject({ code: 'ARCHIVAL_PARENT_INVALID' });

    await persistExpedienteTransition(db(), { institutionId, aggregateId: expedienteId, actorUserId: userId, correlationId: 'parent-close', command: 'closeExpediente', fromStatus: 'OPEN', toStatus: 'CLOSED', eventData: { metadataValid: true, closureMetadata: { reason: 'Parent test' } }, authorizationContext: authorization });
    await setExpedienteArchivalParentAtomically(db(), { institutionId, expedienteId, archivalParentNodeId: seriesId, actorUserId: userId, correlationId: 'parent-correct-closed', authorizationContext: authorization });
    const draft = await createArchiveTransferAndDraftManifestAtomically(db(), { institutionId, expedienteId, transferId, manifestId, actorUserId: userId, correlationId: 'parent-prepare', authorizationContext: authorization });
    expect(draft.transfer.status).toBe('DRAFT');
    expect(JSON.parse(draft.manifest.canonical_json)).toMatchObject({ archivalParentNodeId: seriesId });
    await saveAtomMapping(db(), { institutionId, iciObjectType: 'ARCHIVAL_CLASSIFICATION_NODE', iciObjectId: seriesId, atomInformationObjectId: '77', atomSlug: 'series-a', syncStatus: 'SYNCED' });
    await approveArchiveTransferManifestAtomically(db(), { institutionId, transferId, actorUserId: userId, correlationId: 'parent-approve', authorizationContext: { ...authorization, institutionCapabilities: new Set(['archive_transfer.approve']) } });
    const syncContext = await loadApprovedExpedienteAtomSyncContext(db(), { institutionId, transferId });
    expect(syncContext.expedienteId).toBe(expedienteId);
    expect(syncContext.expedienteFolio).toMatch(/^EXP-/);
    expect(syncContext.archivalParentNodeId).toBe(seriesId);
    expect((await findAtomMapping(db(), { institutionId, iciObjectType: 'ARCHIVAL_CLASSIFICATION_NODE', iciObjectId: seriesId }))?.atomSlug).toBe('series-a');
    const failedMapping = await markAtomMappingFailed(db(), { institutionId, iciObjectType: 'ARCHIVAL_CLASSIFICATION_NODE', iciObjectId: seriesId });
    expect(failedMapping).toMatchObject({ syncStatus: 'FAILED', atomInformationObjectId: '77', atomSlug: 'series-a' });
    expect(await findAtomMapping(db(), { institutionId: foreignInstitutionId, iciObjectType: 'ARCHIVAL_CLASSIFICATION_NODE', iciObjectId: seriesId })).toBeUndefined();
    await expect(setExpedienteArchivalParentAtomically(db(), { institutionId, expedienteId, archivalParentNodeId: subseriesId, actorUserId: userId, correlationId: 'parent-after-prepare', authorizationContext: authorization })).rejects.toMatchObject({ code: 'ARCHIVAL_PARENT_IMMUTABLE' });
    await expect(db().updateTable('expedientes').set({ archival_parent_node_id: subseriesId }).where('institution_id', '=', institutionId).where('id', '=', expedienteId).execute()).rejects.toThrow(/cannot change after transfer preparation/i);
    expect(await db().selectFrom('audit_events').select('event_type').where('aggregate_type', '=', 'expediente').where('aggregate_id', '=', expedienteId).where('event_type', 'in', ['expediente.archival_parent_set', 'expediente.archival_parent_changed']).execute()).toHaveLength(3);
  });

  it('reserves one tenant mapping identity under concurrent synchronization', async () => {
    const results = await Promise.all([
      reserveAtomMapping(db(), { institutionId, iciObjectType: 'ARCHIVAL_CLASSIFICATION_NODE', iciObjectId: fondsId }),
      reserveAtomMapping(db(), { institutionId, iciObjectType: 'ARCHIVAL_CLASSIFICATION_NODE', iciObjectId: fondsId }),
    ]);
    expect(results.filter((result) => result.reserved)).toHaveLength(1);
    expect(results.map((result) => result.record.syncStatus)).toEqual(['PENDING', 'PENDING']);
    expect(await findAtomMapping(db(), { institutionId, iciObjectType: 'ARCHIVAL_CLASSIFICATION_NODE', iciObjectId: fondsId })).toMatchObject({ syncStatus: 'PENDING', atomInformationObjectId: null, atomSlug: null });
  });
});
