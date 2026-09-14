import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { applyFoundationMigrations, createDatabase, persistExpedienteTransition, type Database } from './index.js';
import type { AuthorizationContext } from '@ici/domain';

const institutionId = '44000000-0000-4000-8000-000000000001';
const userId = '44000000-0000-4000-8000-000000000002';
const unitId = '44000000-0000-4000-8000-00000000000c';
const typeId = '44000000-0000-4000-8000-000000000003';
const typeVersionId = '44000000-0000-4000-8000-000000000004';
const expedienteId = '44000000-0000-4000-8000-000000000005';
const matterId = '44000000-0000-4000-8000-000000000006';
const linkedDocumentId = '44000000-0000-4000-8000-000000000007';
const linkedDirtyVersionId = '44000000-0000-4000-8000-000000000008';
const linkedCleanVersionId = '44000000-0000-4000-8000-000000000009';
const expedienteDocumentId = '44000000-0000-4000-8000-00000000000a';
const expedienteVersionId = '44000000-0000-4000-8000-00000000000b';

describe('expediente closure retained-document invariant', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let database: Database | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    database = createDatabase(container.getConnectionUri());
    await sql`CREATE ROLE ici_app NOLOGIN NOSUPERUSER NOBYPASSRLS`.execute(database);
    await applyFoundationMigrations(database);
    await database.insertInto('institutions').values({ id: institutionId, code: 'AH1', name: 'AH-1 test institution', status: 'ACTIVE' }).execute();
    await database.insertInto('users').values({ id: userId, institution_id: institutionId, display_name: 'AH-1 operator', status: 'ACTIVE' }).execute();
    await database.insertInto('organizational_units').values({ id: unitId, institution_id: institutionId, code: 'AH1-UNIT', name: 'AH-1 unit', status: 'ACTIVE' }).execute();
    await database.insertInto('expediente_types').values({ id: typeId, institution_id: institutionId, code: 'AH1-TYPE', name: 'AH-1 type', status: 'ACTIVE' }).execute();
    await database.insertInto('expediente_type_versions').values({ id: typeVersionId, institution_id: institutionId, expediente_type_id: typeId, version_number: 1, status: 'PUBLISHED', schema_json: { type: 'object' }, archival_mapping_json: { levelOfDescription: 'File' }, published_at: new Date('2026-01-01T00:00:00.000Z') }).execute();
    await database.insertInto('expedientes').values({ id: expedienteId, institution_id: institutionId, folio: 'EXP-2026-000001', folio_year: 2026, sequence_number: 1, status: 'OPEN', expediente_type_version_id: typeVersionId, metadata: { title: 'AH-1' }, opened_at: new Date('2026-01-01T00:00:00.000Z') }).execute();
    await database.insertInto('matters').values({ id: matterId, institution_id: institutionId, folio: 'OP-2026-000001', folio_year: 2026, sequence_number: 1, status: 'RECEIVED', received_at: new Date('2026-01-01T00:00:00.000Z'), intake_metadata: { operationalVisibility: 'INSTITUTION' }, linked_expediente_id: expedienteId, destination_unit_id: unitId, created_by: userId }).execute();
    await database.insertInto('matter_assignments').values({ id: '44000000-0000-4000-8000-00000000000d', institution_id: institutionId, matter_id: matterId, unit_id: unitId, user_id: userId }).execute();
    await database.updateTable('matters').set({ status: 'ASSIGNED' }).where('id', '=', matterId).execute();
    await database.updateTable('matters').set({ status: 'IN_PROGRESS' }).where('id', '=', matterId).execute();
    await database.updateTable('matters').set({ status: 'RESOLVED', resolution_metadata: { outcome: 'AH-1 fixture' } }).where('id', '=', matterId).execute();
    await database.insertInto('documents').values([
      { id: linkedDocumentId, institution_id: institutionId, matter_id: matterId, expediente_id: null, document_type: 'record', title: 'Linked matter document' },
      { id: expedienteDocumentId, institution_id: institutionId, matter_id: null, expediente_id: expedienteId, document_type: 'record', title: 'Expediente document' },
    ]).execute();
    await database.insertInto('document_versions').values([
      { id: linkedDirtyVersionId, institution_id: institutionId, document_id: linkedDocumentId, version_number: 1, original_filename: 'history.pdf', detected_mime_type: 'application/pdf', size_bytes: 1, sha256: 'a'.repeat(64), storage_key: 'ah1-history-v1', malware_scan_status: 'PENDING_SCAN', created_by: userId },
      { id: linkedCleanVersionId, institution_id: institutionId, document_id: linkedDocumentId, version_number: 2, original_filename: 'current.pdf', detected_mime_type: 'application/pdf', size_bytes: 1, sha256: 'b'.repeat(64), storage_key: 'ah1-history-v2', malware_scan_status: 'PENDING_SCAN', created_by: userId, replacement_reason: 'Current clean version' },
      { id: expedienteVersionId, institution_id: institutionId, document_id: expedienteDocumentId, version_number: 1, original_filename: 'expediente.pdf', detected_mime_type: 'application/pdf', size_bytes: 1, sha256: 'c'.repeat(64), storage_key: 'ah1-expediente-v1', malware_scan_status: 'PENDING_SCAN', created_by: userId },
    ]).execute();
    await database.updateTable('document_versions').set({ malware_scan_status: 'CLEAN' }).where('institution_id', '=', institutionId).where('id', 'in', [linkedCleanVersionId, expedienteVersionId]).execute();
    await database.updateTable('documents').set({ current_version_id: linkedCleanVersionId }).where('id', '=', linkedDocumentId).execute();
    await database.updateTable('documents').set({ current_version_id: expedienteVersionId }).where('id', '=', expedienteDocumentId).execute();
    await database.updateTable('matters').set({ status: 'CLOSED', closure_metadata: { reason: 'AH-1 fixture' } }).where('id', '=', matterId).execute();
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
    await container?.stop();
  });

  function db(): Database {
    if (database === undefined) throw new Error('database unavailable');
    return database;
  }

  it('rejects closure when a retained linked-matter history version is not clean', async () => {
    const authorization: AuthorizationContext = { userId, institutionId, institutionCapabilities: new Set(['expediente.close']), unitCapabilities: new Map() };
    await expect(db().updateTable('expedientes').set({ status: 'CLOSED' }).where('institution_id', '=', institutionId).where('id', '=', expedienteId).execute()).rejects.toThrow(/retained document versions/i);
    await expect(persistExpedienteTransition(db(), { institutionId, aggregateId: expedienteId, actorUserId: userId, correlationId: 'ah1-rejected-close', command: 'closeExpediente', fromStatus: 'OPEN', toStatus: 'CLOSED', eventData: { metadataValid: true, closureMetadata: { reason: 'Should fail' } }, authorizationContext: authorization })).rejects.toMatchObject({ code: 'DOCUMENTS_NOT_CLEAN' });
    expect((await db().selectFrom('expedientes').select('status').where('id', '=', expedienteId).executeTakeFirstOrThrow()).status).toBe('OPEN');
    await db().updateTable('document_versions').set({ malware_scan_status: 'CLEAN' }).where('institution_id', '=', institutionId).where('id', '=', linkedDirtyVersionId).execute();
    await persistExpedienteTransition(db(), { institutionId, aggregateId: expedienteId, actorUserId: userId, correlationId: 'ah1-accepted-close', command: 'closeExpediente', fromStatus: 'OPEN', toStatus: 'CLOSED', eventData: { metadataValid: true, closureMetadata: { reason: 'All retained versions clean' } }, authorizationContext: authorization });
    expect((await db().selectFrom('expedientes').select('status').where('id', '=', expedienteId).executeTakeFirstOrThrow()).status).toBe('CLOSED');
    expect(await db().selectFrom('expediente_state_events').select('command').where('institution_id', '=', institutionId).where('expediente_id', '=', expedienteId).where('command', '=', 'closeExpediente').execute()).toHaveLength(1);
    expect(await db().selectFrom('audit_events').select('event_type').where('institution_id', '=', institutionId).where('aggregate_type', '=', 'expediente').where('aggregate_id', '=', expedienteId).where('event_type', '=', 'expediente.closed').execute()).toHaveLength(1);
  });
});
