import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { AuthorizationContext, Capability, ExpedienteMetadataValidator, JsonObject, JsonValue, MatterState, ExpedienteState, InstitutionId } from '@ici/domain';
import { canPerform, DomainInvariantError } from '@ici/domain';
import type { Database, DatabaseTransaction } from './index.js';
import type { ArchiveTransfersTable, ArchivalClassificationNodesTable, AtomMappingsTable, ArchivematicaTransfersTable, DocumentsTable, DocumentVersionsTable, PreservationStagingRecordsTable, ExpedientesTable, IntegrationJobsTable, MatterNotesTable, MattersTable, TransferManifestsTable, ExpedienteTypeVersionsTable } from './schema.js';
import { allocateFolio, appendAuditEvent, withAuditedTenantTransaction, withTenantContextTransaction, withTenantTransaction } from './index.js';

const matterTransitions: Readonly<Record<string, { readonly from: readonly string[]; readonly to: string }>> = {
  registerMatter: { from: [], to: 'RECEIVED' },
  assignMatter: { from: ['RECEIVED'], to: 'ASSIGNED' },
  reassignMatter: { from: ['ASSIGNED', 'IN_PROGRESS'], to: 'ASSIGNED' },
  startMatter: { from: ['ASSIGNED'], to: 'IN_PROGRESS' },
  resolveMatter: { from: ['IN_PROGRESS'], to: 'RESOLVED' },
  reopenMatter: { from: ['RESOLVED'], to: 'IN_PROGRESS' },
  closeMatter: { from: ['RESOLVED'], to: 'CLOSED' },
  voidMatter: { from: ['RECEIVED', 'ASSIGNED'], to: 'VOIDED' },
};

const expedienteTransitions: Readonly<Record<string, { readonly from: readonly string[]; readonly to: string }>> = {
  createExpediente: { from: [], to: 'OPEN' },
  closeExpediente: { from: ['OPEN'], to: 'CLOSED' },
  reopenExpediente: { from: ['CLOSED'], to: 'OPEN' },
  prepareTransfer: { from: ['CLOSED'], to: 'TRANSFER_PENDING' },
  rejectTransfer: { from: ['TRANSFER_PENDING'], to: 'CLOSED' },
  cancelTransfer: { from: ['TRANSFER_PENDING'], to: 'CLOSED' },
  completeTransfer: { from: ['TRANSFER_PENDING'], to: 'TRANSFERRED' },
  voidExpediente: { from: ['OPEN'], to: 'VOIDED' },
};

const matterAuditEvents: Readonly<Record<string, string>> = {
  assignMatter: 'matter.assigned',
  reassignMatter: 'matter.reassigned',
  startMatter: 'matter.started',
  resolveMatter: 'matter.resolved',
  reopenMatter: 'matter.reopened',
  closeMatter: 'matter.closed',
  voidMatter: 'matter.voided',
};

const matterLifecycleAuditEvents = new Set(Object.values(matterAuditEvents).concat('matter.registered'));

const expedienteAuditEvents: Readonly<Record<string, string>> = {
  closeExpediente: 'expediente.closed',
  reopenExpediente: 'expediente.reopened',
  prepareTransfer: 'expediente.transfer_prepared',
  rejectTransfer: 'expediente.transfer_rejected',
  cancelTransfer: 'expediente.transfer_cancelled',
  completeTransfer: 'expediente.transfer_completed',
  voidExpediente: 'expediente.voided',
};

function auditEventType(events: Readonly<Record<string, string>>, command: string): string {
  const eventType = events[command];
  if (eventType === undefined) throw new DomainInvariantError('INVALID_COMMAND', `Unknown command ${command}`);
  return eventType;
}

function assertTransition(command: string, from: string, to: string, allowed: Readonly<Record<string, { readonly from: readonly string[]; readonly to: string }>>): void {
  const transition = allowed[command];
  if (transition === undefined || !transition.from.includes(from) || transition.to !== to) throw new DomainInvariantError('INVALID_TRANSITION', `${command} is not allowed from ${from} to ${to}`);
}

function booleanEventValue(data: JsonObject | undefined, key: string): boolean | undefined {
  const value = data?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectEventValue(data: JsonObject | undefined, key: string): JsonObject | undefined {
  const value: JsonValue | undefined = data?.[key];
  return value !== undefined && isJsonObject(value) ? value : undefined;
}

function requireReason(reason: string | undefined, command: string): string {
  if (reason === undefined || reason.trim().length === 0) throw new DomainInvariantError('REASON_REQUIRED', `${command} requires a reason`);
  return reason;
}

function canonicalManifestSha256(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

export interface RegisterMatterPersistenceInput {
  readonly id: string;
  readonly institutionId: InstitutionId | string;
  readonly receivedAt: Date;
  readonly createdBy?: string;
  readonly intakeMetadata: JsonObject;
  readonly correlationId: string;
  readonly actorUserId?: string;
  readonly year: number;
  /** Optional for legacy fixtures; operational registration supplies both. */
  readonly destinationUnitId?: string;
  readonly accessClassificationId?: string;
}

export async function registerMatterAtomically(database: Database, input: RegisterMatterPersistenceInput): Promise<{ readonly folio: string }> {
  if (Object.keys(input.intakeMetadata).length === 0) throw new DomainInvariantError('INVALID_INTAKE', 'Matter intake metadata is required');
  if ((input.destinationUnitId === undefined) !== (input.accessClassificationId === undefined)) throw new DomainInvariantError('INVALID_INTAKE_REFERENCES', 'Destination unit and access classification must be supplied together');
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.destinationUnitId !== undefined && input.accessClassificationId !== undefined) {
      const unit = await transaction.selectFrom('organizational_units').select('id').where('institution_id', '=', input.institutionId).where('id', '=', input.destinationUnitId).where('status', '=', 'ACTIVE').executeTakeFirst();
      if (unit === undefined) throw new DomainInvariantError('DESTINATION_UNIT_NOT_FOUND', 'Destination unit was not found');
      const classification = await transaction.selectFrom('access_classifications').select('id').where('institution_id', '=', input.institutionId).where('id', '=', input.accessClassificationId).executeTakeFirst();
      if (classification === undefined) throw new DomainInvariantError('ACCESS_CLASSIFICATION_NOT_FOUND', 'Access classification was not found');
    }
    const allocated = await allocateFolio(transaction, { institutionId: input.institutionId, folioKind: 'MATTER', folioYear: input.year });
    await transaction.insertInto('matters').values({
      id: input.id,
      institution_id: input.institutionId,
      folio: allocated.folio,
      folio_year: input.year,
      sequence_number: allocated.sequenceNumber,
      status: 'RECEIVED',
      received_at: input.receivedAt,
      intake_metadata: input.intakeMetadata,
      ...(input.createdBy === undefined ? {} : { created_by: input.createdBy }),
      ...(input.destinationUnitId === undefined ? {} : { destination_unit_id: input.destinationUnitId }),
      ...(input.accessClassificationId === undefined ? {} : { access_classification_id: input.accessClassificationId }),
    }).execute();
    await transaction.insertInto('matter_state_events').values({
      institution_id: input.institutionId,
      matter_id: input.id,
      to_status: 'RECEIVED',
      command: 'registerMatter',
      ...(input.actorUserId === undefined ? {} : { actor_user_id: input.actorUserId }),
      event_data: { folio: allocated.folio },
      occurred_at: input.receivedAt,
    }).execute();
    await appendAuditEvent(transaction, {
      institutionId: input.institutionId,
      actorUserId: input.actorUserId,
      eventType: 'matter.registered',
      aggregateType: 'matter',
      aggregateId: input.id,
      correlationId: input.correlationId,
      afterData: { status: 'RECEIVED', folio: allocated.folio },
    });
    return allocated;
  });
}

export type MatterReadModel = Selectable<MattersTable> & { readonly effective_unit_id?: string | null; readonly assignment_unit_id?: string | null; readonly assignment_user_id?: string | null; readonly assignment_assigned_at?: Date | string | null };

async function currentMatterAssignment(transaction: DatabaseTransaction, institutionId: string, matterId: string): Promise<{ readonly unit_id: string; readonly user_id: string | null } | undefined> {
  return transaction.selectFrom('matter_assignments').select(['unit_id', 'user_id']).where('institution_id', '=', institutionId).where('matter_id', '=', matterId).orderBy('assigned_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
}

async function effectiveMatterUnit(transaction: DatabaseTransaction, institutionId: string, matterId: string, destinationUnitId: string | null): Promise<string | null> {
  const assignment = await currentMatterAssignment(transaction, institutionId, matterId);
  return assignment?.unit_id ?? destinationUnitId;
}

export interface MatterDocumentReadModel {
  readonly document: Selectable<DocumentsTable>;
  readonly versions: readonly Selectable<DocumentVersionsTable>[];
}

/** Short, non-locking preflight used before object-storage I/O. Final acceptance rechecks all of this under lock. */
export async function authorizeMatterDocumentUploadPreflight(database: Database, input: {
  readonly institutionId: InstitutionId | string;
  readonly matterId?: string;
  readonly documentId?: string;
  readonly authorizationContext: AuthorizationContext;
  readonly actorUserId: string;
}): Promise<void> {
  await withTenantTransaction(database, input.institutionId, async (transaction) => {
    let matterId = input.matterId;
    if (input.documentId !== undefined) {
      const document = await transaction.selectFrom('documents').select(['matter_id', 'expediente_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).executeTakeFirst();
      if (document === undefined || document.matter_id === null || document.expediente_id !== null) throw new DomainInvariantError('DOCUMENT_NOT_FOUND', 'Document was not found');
      matterId = document.matter_id;
    }
    if (matterId === undefined) throw new DomainInvariantError('MATTER_NOT_FOUND', 'Matter was not found');
    const matter = await transaction.selectFrom('matters').select(['status', 'destination_unit_id', 'intake_metadata', 'access_classification_id']).where('institution_id', '=', input.institutionId).where('id', '=', matterId).executeTakeFirst();
    if (matter === undefined) throw new DomainInvariantError('MATTER_NOT_FOUND', 'Matter was not found');
    await assertMatterDocumentAuthorization(transaction, String(input.institutionId), matterId, matter, input.authorizationContext, input.actorUserId);
  });
}

export async function findMatterDocuments(database: Database, institutionId: InstitutionId | string, matterId: string): Promise<readonly MatterDocumentReadModel[]> {
  return withTenantTransaction(database, institutionId, async (transaction) => {
    const documents = await transaction.selectFrom('documents').selectAll().where('institution_id', '=', institutionId).where('matter_id', '=', matterId).orderBy('created_at').orderBy('id').execute();
    const result: MatterDocumentReadModel[] = [];
    for (const document of documents) {
      const versions = await transaction.selectFrom('document_versions').selectAll().where('institution_id', '=', institutionId).where('document_id', '=', document.id).orderBy('version_number').execute();
      result.push({ document, versions });
    }
    return result;
  });
}

export async function findMatterDocumentsAuthorized(database: Database, input: { readonly institutionId: InstitutionId | string; readonly matterId: string; readonly authorizationContext: AuthorizationContext }): Promise<readonly MatterDocumentReadModel[] | undefined> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const matter = await transaction.selectFrom('matters').select(['destination_unit_id', 'intake_metadata']).where('institution_id', '=', input.institutionId).where('id', '=', input.matterId).forShare().executeTakeFirst();
    if (matter === undefined) return undefined;
    const visibility = matter.intake_metadata.operationalVisibility;
    if (visibility !== 'INSTITUTION' && visibility !== 'UNIT') throw new DomainInvariantError('NOT_AUTHORIZED', 'Matter visibility is not supported');
    const unit = await effectiveMatterUnit(transaction, String(input.institutionId), input.matterId, matter.destination_unit_id);
    if (!canPerform(input.authorizationContext, 'records.read', unit ?? undefined)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot read the effective matter unit');
    const documents = await transaction.selectFrom('documents').selectAll().where('institution_id', '=', input.institutionId).where('matter_id', '=', input.matterId).orderBy('created_at').orderBy('id').execute();
    const result: MatterDocumentReadModel[] = [];
    for (const document of documents) {
      const versions = await transaction.selectFrom('document_versions').selectAll().where('institution_id', '=', input.institutionId).where('document_id', '=', document.id).orderBy('version_number').execute();
      result.push({ document, versions });
    }
    return result;
  });
}

export async function findMatterDocumentVersions(database: Database, institutionId: InstitutionId | string, documentId: string): Promise<MatterDocumentReadModel | undefined> {
  return withTenantTransaction(database, institutionId, async (transaction) => {
    const document = await transaction.selectFrom('documents').selectAll().where('institution_id', '=', institutionId).where('id', '=', documentId).where('matter_id', 'is not', null).where('expediente_id', 'is', null).executeTakeFirst();
    if (document === undefined) return undefined;
    const versions = await transaction.selectFrom('document_versions').selectAll().where('institution_id', '=', institutionId).where('document_id', '=', documentId).orderBy('version_number').execute();
    return { document, versions };
  });
}

/** Tenant-scoped internal reload used after a successful mutation. */
export async function findDocumentVersions(database: Database, institutionId: InstitutionId | string, documentId: string): Promise<MatterDocumentReadModel | undefined> {
  return withTenantTransaction(database, institutionId, async (transaction) => {
    const document = await transaction.selectFrom('documents').selectAll().where('institution_id', '=', institutionId).where('id', '=', documentId).executeTakeFirst();
    if (document === undefined) return undefined;
    const versions = await transaction.selectFrom('document_versions').selectAll().where('institution_id', '=', institutionId).where('document_id', '=', documentId).orderBy('version_number').execute();
    return { document, versions };
  });
}

export async function findMatterDocumentVersionsAuthorized(database: Database, input: { readonly institutionId: InstitutionId | string; readonly documentId: string; readonly authorizationContext: AuthorizationContext }): Promise<MatterDocumentReadModel | undefined> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const row = await transaction.selectFrom('documents as d').innerJoin('matters as m', (join) => join.onRef('m.id', '=', 'd.matter_id').onRef('m.institution_id', '=', 'd.institution_id')).select(['d.id', 'd.matter_id', 'd.expediente_id', 'm.destination_unit_id', 'm.intake_metadata']).where('d.institution_id', '=', input.institutionId).where('d.id', '=', input.documentId).where('d.matter_id', 'is not', null).where('d.expediente_id', 'is', null).forShare().executeTakeFirst();
    if (row === undefined || row.matter_id === null) return undefined;
    const visibility = row.intake_metadata.operationalVisibility;
    if (visibility !== 'INSTITUTION' && visibility !== 'UNIT') throw new DomainInvariantError('NOT_AUTHORIZED', 'Matter visibility is not supported');
    const unit = await effectiveMatterUnit(transaction, String(input.institutionId), row.matter_id, row.destination_unit_id);
    if (!canPerform(input.authorizationContext, 'records.read', unit ?? undefined)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot read the effective matter unit');
    const document = await transaction.selectFrom('documents').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).executeTakeFirstOrThrow();
    const versions = await transaction.selectFrom('document_versions').selectAll().where('institution_id', '=', input.institutionId).where('document_id', '=', input.documentId).orderBy('version_number').execute();
    return { document, versions };
  });
}

/** Institution-scoped read model for documents owned directly by an expediente. */
export async function findExpedienteDocumentsAuthorized(database: Database, input: { readonly institutionId: InstitutionId | string; readonly expedienteId: string; readonly authorizationContext: AuthorizationContext }): Promise<readonly MatterDocumentReadModel[] | undefined> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const expediente = await transaction.selectFrom('expedientes').select('id').where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteId).forShare().executeTakeFirst();
    if (expediente === undefined) return undefined;
    if (input.authorizationContext.institutionId !== String(input.institutionId) || !canPerform(input.authorizationContext, 'records.read')) throw new DomainInvariantError('NOT_AUTHORIZED', 'Expediente documents require institution-scoped records.read');
    const documents = await transaction.selectFrom('documents').selectAll().where('institution_id', '=', input.institutionId).where('expediente_id', '=', input.expedienteId).where('matter_id', 'is', null).orderBy('created_at').orderBy('id').execute();
    const result: MatterDocumentReadModel[] = [];
    for (const document of documents) {
      await assertExpedienteDocumentClassification(transaction, String(input.institutionId), document.access_classification_id);
      const versions = await transaction.selectFrom('document_versions').selectAll().where('institution_id', '=', input.institutionId).where('document_id', '=', document.id).orderBy('version_number').execute();
      result.push({ document, versions });
    }
    return result;
  });
}

export type DocumentOwner = 'MATTER' | 'EXPEDIENTE';

export async function authorizeExpedienteDocumentUploadPreflight(database: Database, input: { readonly institutionId: InstitutionId | string; readonly expedienteId: string; readonly accessClassificationId: string; readonly actorUserId: string; readonly authorizationContext: AuthorizationContext }): Promise<void> {
  await withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.authorizationContext.institutionId !== String(input.institutionId) || input.authorizationContext.userId !== input.actorUserId || !canPerform(input.authorizationContext, 'expediente.edit_open')) throw new DomainInvariantError('NOT_AUTHORIZED', 'Expediente document creation is not authorized');
    const expediente = await transaction.selectFrom('expedientes').select('status').where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteId).executeTakeFirst();
    if (expediente === undefined) throw new DomainInvariantError('EXPEDIENTE_NOT_FOUND', 'Expediente not found');
    if (expediente.status !== 'OPEN') throw new DomainInvariantError('EXPEDIENTE_NOT_OPEN', 'Expediente is not open');
    await classificationSnapshot(transaction, String(input.institutionId), input.accessClassificationId, 'INSTITUTION');
  });
}

/** Generic version-upload preflight. Parentage is always read from PostgreSQL. */
export async function authorizeDocumentVersionUploadPreflight(database: Database, input: { readonly institutionId: InstitutionId | string; readonly documentId: string; readonly actorUserId: string; readonly authorizationContext: AuthorizationContext }): Promise<DocumentOwner> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const document = await transaction.selectFrom('documents').select(['matter_id', 'expediente_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).executeTakeFirst();
    if (document === undefined || (document.matter_id === null) === (document.expediente_id === null)) throw new DomainInvariantError('DOCUMENT_NOT_FOUND', 'Document was not found');
    if (input.authorizationContext.institutionId !== String(input.institutionId) || input.authorizationContext.userId !== input.actorUserId) throw new DomainInvariantError('AUTHORIZATION_CONTEXT_REQUIRED', 'Document authorization context does not match the actor');
    if (document.matter_id !== null) {
      const matter = await transaction.selectFrom('matters').select(['status', 'destination_unit_id', 'intake_metadata', 'access_classification_id']).where('institution_id', '=', input.institutionId).where('id', '=', document.matter_id).executeTakeFirst();
      if (matter === undefined) throw new DomainInvariantError('DOCUMENT_NOT_FOUND', 'Document was not found');
      await assertMatterDocumentAuthorization(transaction, String(input.institutionId), document.matter_id, matter, input.authorizationContext, input.actorUserId);
      return 'MATTER';
    }
    const expediente = await transaction.selectFrom('expedientes').select('status').where('institution_id', '=', input.institutionId).where('id', '=', document.expediente_id).executeTakeFirst();
    if (expediente === undefined) throw new DomainInvariantError('DOCUMENT_NOT_FOUND', 'Document was not found');
    if (expediente.status !== 'OPEN') throw new DomainInvariantError('EXPEDIENTE_NOT_OPEN', 'Expediente is not open');
    if (!canPerform(input.authorizationContext, 'document.version_open')) throw new DomainInvariantError('NOT_AUTHORIZED', 'Expediente document version is not authorized');
    return 'EXPEDIENTE';
  });
}

/** Generic authorized version read; dispatches by the persisted document parent. */
export async function findDocumentVersionsAuthorized(database: Database, input: { readonly institutionId: InstitutionId | string; readonly documentId: string; readonly authorizationContext: AuthorizationContext }): Promise<MatterDocumentReadModel | undefined> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const document = await transaction.selectFrom('documents').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).executeTakeFirst();
    if (document === undefined || (document.matter_id === null) === (document.expediente_id === null)) return undefined;
    if (input.authorizationContext.institutionId !== String(input.institutionId)) throw new DomainInvariantError('AUTHORIZATION_CONTEXT_REQUIRED', 'Document authorization context does not match the tenant');
    if (document.expediente_id !== null) {
      if (!canPerform(input.authorizationContext, 'records.read')) throw new DomainInvariantError('NOT_AUTHORIZED', 'Expediente documents require institution-scoped records.read');
      await assertExpedienteDocumentClassification(transaction, String(input.institutionId), document.access_classification_id);
    } else {
      const matter = await transaction.selectFrom('matters').select(['destination_unit_id', 'intake_metadata']).where('institution_id', '=', input.institutionId).where('id', '=', document.matter_id).forShare().executeTakeFirst();
      if (matter === undefined || matter.intake_metadata.operationalVisibility !== 'INSTITUTION' && matter.intake_metadata.operationalVisibility !== 'UNIT') throw new DomainInvariantError('NOT_AUTHORIZED', 'Matter visibility is not supported');
      const unit = await effectiveMatterUnit(transaction, String(input.institutionId), document.matter_id!, matter.destination_unit_id);
      if (!canPerform(input.authorizationContext, 'records.read', unit ?? undefined)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot read the effective matter unit');
    }
    const versions = await transaction.selectFrom('document_versions').selectAll().where('institution_id', '=', input.institutionId).where('document_id', '=', document.id).orderBy('version_number').execute();
    return { document, versions };
  });
}

async function assertExpedienteDocumentClassification(transaction: DatabaseTransaction, institutionId: string, classificationId: string | null): Promise<void> {
  if (classificationId === null) throw new DomainInvariantError('NOT_AUTHORIZED', 'Expediente document classification is not supported');
  const classification = await transaction.selectFrom('access_classifications').select('operational_visibility').where('institution_id', '=', institutionId).where('id', '=', classificationId).executeTakeFirst();
  if (classification?.operational_visibility !== 'INSTITUTION') throw new DomainInvariantError('NOT_AUTHORIZED', 'Expediente document classification is not supported');
}

export async function findMatterById(database: Database, institutionId: InstitutionId | string, matterId: string): Promise<MatterReadModel | undefined> {
  return withTenantTransaction(database, institutionId, async (transaction) => {
    const matter = await transaction.selectFrom('matters').selectAll().where('institution_id', '=', institutionId).where('id', '=', matterId).executeTakeFirst();
    if (matter === undefined) return undefined;
    const assignment = await transaction.selectFrom('matter_assignments').select(['unit_id', 'user_id', 'assigned_at']).where('institution_id', '=', institutionId).where('matter_id', '=', matterId).orderBy('assigned_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    return { ...matter, effective_unit_id: await effectiveMatterUnit(transaction, String(institutionId), matterId, matter.destination_unit_id), assignment_unit_id: assignment?.unit_id ?? null, assignment_user_id: assignment?.user_id ?? null, assignment_assigned_at: assignment?.assigned_at ?? null };
  });
}

export async function findMatterByFolio(database: Database, institutionId: InstitutionId | string, folio: string): Promise<MatterReadModel | undefined> {
  return withTenantTransaction(database, institutionId, async (transaction) => {
    const matter = await transaction.selectFrom('matters').selectAll().where('institution_id', '=', institutionId).where('folio', '=', folio).executeTakeFirst();
    if (matter === undefined) return undefined;
    const assignment = await transaction.selectFrom('matter_assignments').select(['unit_id', 'user_id', 'assigned_at']).where('institution_id', '=', institutionId).where('matter_id', '=', matter.id).orderBy('assigned_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    return { ...matter, effective_unit_id: await effectiveMatterUnit(transaction, String(institutionId), matter.id, matter.destination_unit_id), assignment_unit_id: assignment?.unit_id ?? null, assignment_user_id: assignment?.user_id ?? null, assignment_assigned_at: assignment?.assigned_at ?? null };
  });
}

export interface CreateExpedientePersistenceInput {
  readonly id: string;
  readonly institutionId: InstitutionId | string;
  readonly expedienteTypeVersionId: string;
  readonly metadata: JsonObject;
  /** Deprecated fixture fields; authoritative timestamps are generated in PostgreSQL. */
  readonly openedAt?: Date;
  readonly correlationId: string;
  readonly actorUserId?: string;
  readonly year?: number;
}

export async function createExpedienteAtomically(database: Database, input: CreateExpedientePersistenceInput, validateMetadata: ExpedienteMetadataValidator): Promise<{ readonly folio: string }> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const typeVersion = await transaction.selectFrom('expediente_type_versions').select(['status', 'schema_json']).where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteTypeVersionId).forUpdate().executeTakeFirst();
    if (typeVersion?.status !== 'PUBLISHED') throw new DomainInvariantError('TYPE_VERSION_NOT_PUBLISHED', 'An expediente requires a published type version');
    if (!validateMetadata(typeVersion.schema_json, input.metadata)) throw new DomainInvariantError('INVALID_METADATA', 'Expediente metadata does not satisfy its published type version');
    const openedAt = (await sql<{ opened_at: Date }>`select clock_timestamp() as opened_at`.execute(transaction)).rows[0]?.opened_at;
    if (openedAt === undefined) throw new Error('Expediente creation timestamp was not generated');
    const year = openedAt.getUTCFullYear();
    const allocated = await allocateFolio(transaction, { institutionId: input.institutionId, folioKind: 'EXPEDIENTE', folioYear: year });
    await transaction.insertInto('expedientes').values({ id: input.id, institution_id: input.institutionId, folio: allocated.folio, folio_year: year, sequence_number: allocated.sequenceNumber, status: 'OPEN', expediente_type_version_id: input.expedienteTypeVersionId, metadata: input.metadata, opened_at: openedAt }).execute();
    await transaction.insertInto('expediente_state_events').values({ institution_id: input.institutionId, expediente_id: input.id, to_status: 'OPEN', command: 'createExpediente', ...(input.actorUserId === undefined ? {} : { actor_user_id: input.actorUserId }), event_data: { folio: allocated.folio }, occurred_at: openedAt }).execute();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'expediente.created', aggregateType: 'expediente', aggregateId: input.id, correlationId: input.correlationId, afterData: { status: 'OPEN', folio: allocated.folio, expedienteTypeVersionId: input.expedienteTypeVersionId } });
    return allocated;
  });
}

export type ExpedienteReadModel = Selectable<ExpedientesTable>;

export async function setExpedienteArchivalParentAtomically(database: Database, input: {
  readonly institutionId: InstitutionId | string;
  readonly expedienteId: string;
  readonly archivalParentNodeId: string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly authorizationContext: AuthorizationContext;
}): Promise<ExpedienteReadModel> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.authorizationContext.institutionId !== String(input.institutionId) || input.authorizationContext.userId !== input.actorUserId || !canPerform(input.authorizationContext, 'archive_transfer.prepare')) {
      throw new DomainInvariantError('NOT_AUTHORIZED', 'Archival parent assignment is not authorized');
    }
    const expediente = await transaction.selectFrom('expedientes').select(['status', 'archival_parent_node_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteId).forUpdate().executeTakeFirst();
    if (expediente === undefined) throw new DomainInvariantError('EXPEDIENTE_NOT_FOUND', 'Expediente not found');
    if (expediente.status !== 'OPEN' && expediente.status !== 'CLOSED') throw new DomainInvariantError('ARCHIVAL_PARENT_IMMUTABLE', 'The archival parent cannot change after transfer preparation');
    const parent = await transaction.selectFrom('archival_classification_nodes').select(['id', 'node_type']).where('institution_id', '=', input.institutionId).where('id', '=', input.archivalParentNodeId).forShare().executeTakeFirst();
    if (parent === undefined || (parent.node_type !== 'SERIES' && parent.node_type !== 'SUBSERIES')) throw new DomainInvariantError('ARCHIVAL_PARENT_INVALID', 'The archival parent must be a SERIES or SUBSERIES in the same institution');
    if (expediente.archival_parent_node_id === input.archivalParentNodeId) return transaction.selectFrom('expedientes').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteId).executeTakeFirstOrThrow();
    const changedAt = await databaseTimestamp(transaction, 'Expediente archival parent assignment');
    await transaction.updateTable('expedientes').set({ archival_parent_node_id: input.archivalParentNodeId, updated_at: changedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteId).execute();
    await appendAuditEvent(transaction, {
      institutionId: input.institutionId,
      actorUserId: input.actorUserId,
      eventType: expediente.archival_parent_node_id === null ? 'expediente.archival_parent_set' : 'expediente.archival_parent_changed',
      aggregateType: 'expediente',
      aggregateId: input.expedienteId,
      correlationId: input.correlationId,
      beforeData: { archivalParentNodeId: expediente.archival_parent_node_id },
      afterData: { archivalParentNodeId: input.archivalParentNodeId },
      eventData: { nodeType: parent.node_type },
    });
    return transaction.selectFrom('expedientes').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteId).executeTakeFirstOrThrow();
  });
}

export async function findExpedienteById(database: Database, institutionId: InstitutionId | string, expedienteId: string): Promise<ExpedienteReadModel | undefined> {
  return withTenantTransaction(database, institutionId, (transaction) => transaction
    .selectFrom('expedientes')
    .selectAll()
    .where('institution_id', '=', institutionId)
    .where('id', '=', expedienteId)
    .executeTakeFirst());
}

export async function findExpedientesAuthorized(database: Database, input: { readonly institutionId: InstitutionId | string; readonly authorizationContext: AuthorizationContext }): Promise<readonly ExpedienteReadModel[]> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.authorizationContext.institutionId !== String(input.institutionId) || !canPerform(input.authorizationContext, 'records.read')) throw new DomainInvariantError('NOT_AUTHORIZED', 'Expediente list requires institution-scoped records.read');
    return transaction.selectFrom('expedientes').selectAll().where('institution_id', '=', input.institutionId).orderBy('opened_at', 'desc').orderBy('id').execute();
  });
}

export type PublishedExpedienteTypeVersionReadModel = Pick<Selectable<ExpedienteTypeVersionsTable>, 'id' | 'expediente_type_id' | 'version_number' | 'schema_json'> & { readonly code: string; readonly name: string };
export async function findPublishedExpedienteTypeVersions(database: Database, input: { readonly institutionId: InstitutionId | string; readonly authorizationContext: AuthorizationContext }): Promise<readonly PublishedExpedienteTypeVersionReadModel[]> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.authorizationContext.institutionId !== String(input.institutionId) || !canPerform(input.authorizationContext, 'expediente.create')) throw new DomainInvariantError('NOT_AUTHORIZED', 'Expediente types require expediente.create');
    return transaction.selectFrom('expediente_type_versions as v').innerJoin('expediente_types as t', (join) => join.onRef('t.id', '=', 'v.expediente_type_id').onRef('t.institution_id', '=', 'v.institution_id')).select(['v.id', 'v.expediente_type_id', 'v.version_number', 'v.schema_json', 't.code', 't.name']).where('v.institution_id', '=', input.institutionId).where('v.status', '=', 'PUBLISHED').where('t.status', '=', 'ACTIVE').orderBy('t.name').orderBy('v.version_number', 'desc').execute();
  });
}

export type OrganizationalUnitLookupPurpose = 'assign' | 'register' | 'read';
export async function findActiveOrganizationalUnits(database: Database, input: { readonly institutionId: InstitutionId | string; readonly authorizationContext: AuthorizationContext; readonly purpose?: OrganizationalUnitLookupPurpose }): Promise<readonly { readonly id: string; readonly code: string; readonly name: string }[]> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.authorizationContext.institutionId !== String(input.institutionId)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Assignment units require the active institution');
    const purpose = input.purpose ?? 'assign';
    const capability = purpose === 'register' ? 'matter.register' : purpose === 'read' ? 'records.read' : 'matter.assign';
    const institutionWide = canPerform(input.authorizationContext, capability);
    const authorizedUnits = [...input.authorizationContext.unitCapabilities.entries()].filter(([, capabilities]) => capabilities.has(capability)).map(([unitId]) => unitId);
    if (!institutionWide && authorizedUnits.length === 0) throw new DomainInvariantError('NOT_AUTHORIZED', `Organizational unit lookup requires ${capability}`);
    let query = transaction.selectFrom('organizational_units').select(['id', 'code', 'name']).where('institution_id', '=', input.institutionId).where('status', '=', 'ACTIVE');
    if (!institutionWide) query = query.where('id', 'in', authorizedUnits);
    return query.orderBy('name').execute();
  });
}

export async function findActiveUsersForUnit(database: Database, input: { readonly institutionId: InstitutionId | string; readonly unitId: string; readonly authorizationContext: AuthorizationContext }): Promise<readonly { readonly id: string; readonly display_name: string }[]> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.authorizationContext.institutionId !== String(input.institutionId) || !canPerform(input.authorizationContext, 'matter.assign', input.unitId)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Assignment users require matter.assign for the selected unit');
    return transaction.selectFrom('users as u').innerJoin('user_role_assignments as a', (join) => join.onRef('a.user_id', '=', 'u.id').onRef('a.institution_id', '=', 'u.institution_id')).select(['u.id', 'u.display_name']).where('u.institution_id', '=', input.institutionId).where('u.status', '=', 'ACTIVE').where('a.unit_id', '=', input.unitId).where('a.effective_from', '<=', new Date()).where((eb) => eb.or([eb('a.effective_until', 'is', null), eb('a.effective_until', '>', new Date())])).distinct().orderBy('u.display_name').execute();
  });
}

export type AccessClassificationLookupPurpose = 'matter' | 'document';
export async function findAccessClassifications(database: Database, input: { readonly institutionId: InstitutionId | string; readonly authorizationContext: AuthorizationContext; readonly purpose?: AccessClassificationLookupPurpose }): Promise<readonly { readonly id: string; readonly legal_classification: string; readonly operational_visibility: string }[]> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const purpose = input.purpose ?? 'matter';
    const capability = purpose === 'document' ? 'expediente.edit_open' : 'matter.register';
    if (input.authorizationContext.institutionId !== String(input.institutionId) || !canPerform(input.authorizationContext, capability)) throw new DomainInvariantError('NOT_AUTHORIZED', `Access classifications require ${capability}`);
    return transaction.selectFrom('access_classifications').select(['id', 'legal_classification', 'operational_visibility']).where('institution_id', '=', input.institutionId).orderBy('legal_classification').execute();
  });
}

export interface StateTransitionPersistenceInput {
  readonly institutionId: InstitutionId | string;
  readonly aggregateId: string;
  readonly actorUserId?: string;
  readonly correlationId: string;
  readonly command: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly reason?: string;
  readonly eventData?: JsonObject;
  /** Trusted, server-derived context. Required for startMatter unit-scope checks. */
  readonly authorizationContext?: AuthorizationContext;
}

function requireMatchingTransitionAuthorization(input: StateTransitionPersistenceInput): AuthorizationContext {
  const authorization = input.authorizationContext;
  if (input.actorUserId === undefined || authorization === undefined || authorization.institutionId !== String(input.institutionId) || authorization.userId !== input.actorUserId) {
    throw new DomainInvariantError('AUTHORIZATION_CONTEXT_REQUIRED', `${input.command} requires matching server-derived authorization context`);
  }
  return authorization;
}

function requireTransitionCapability(authorization: AuthorizationContext, capability: Capability, unitId?: string): void {
  if (!canPerform(authorization, capability, unitId)) {
    throw new DomainInvariantError('NOT_AUTHORIZED', `Transition requires ${capability}`);
  }
}

export interface MatterAssignmentPersistenceInput {
  readonly institutionId: InstitutionId | string;
  readonly matterId: string;
  readonly assignmentId: string;
  readonly unitId: string;
  readonly userId?: string;
  readonly actorUserId?: string;
  readonly correlationId: string;
  readonly command: 'assignMatter' | 'reassignMatter';
  readonly fromStatus: 'RECEIVED' | 'ASSIGNED' | 'IN_PROGRESS';
  readonly reason?: string;
  /** Legacy fixture hint; authoritative assignment time is generated after the lock. */
  readonly assignedAt?: Date;
  /** Trusted server-derived authorization. Required for application commands. */
  readonly authorizationContext: AuthorizationContext;
}

export async function assignMatterAtomically(database: Database, input: MatterAssignmentPersistenceInput): Promise<void> {
  const toStatus = 'ASSIGNED' as const;
  assertTransition(input.command, input.fromStatus, toStatus, matterTransitions);
  if (input.command === 'reassignMatter') requireReason(input.reason, input.command);
  await withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: auditEventType(matterAuditEvents, input.command), aggregateType: 'matter', aggregateId: input.matterId, correlationId: input.correlationId, beforeData: { status: input.fromStatus }, afterData: { status: toStatus }, eventData: { assignmentId: input.assignmentId, unitId: input.unitId, ...(input.userId === undefined ? {} : { userId: input.userId }), ...(input.reason === undefined ? {} : { reason: input.reason }) } }, async (transaction) => {
    const current = await transaction.selectFrom('matters').select(['status', 'destination_unit_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.matterId).forUpdate().executeTakeFirst();
    if (current === undefined) throw new Error('Matter not found');
    if (current.status !== input.fromStatus) throw new DomainInvariantError('STALE_STATE', `Matter is ${current.status}, expected ${input.fromStatus}`);
    const authorization = input.authorizationContext;
    if (authorization.institutionId !== String(input.institutionId) || authorization.userId !== input.actorUserId) throw new DomainInvariantError('NOT_AUTHORIZED', 'Assignment authorization context does not match the actor');
    const sourceUnitId = await effectiveMatterUnit(transaction, String(input.institutionId), input.matterId, current.destination_unit_id);
    if (!canPerform(authorization, 'matter.assign', sourceUnitId ?? undefined) || (sourceUnitId !== input.unitId && !canPerform(authorization, 'matter.assign', input.unitId))) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot assign for the effective matter units');
    const timestampResult = await sql<{ assigned_at: Date }>`select clock_timestamp() as assigned_at`.execute(transaction);
    const assignedAt = timestampResult.rows[0]?.assigned_at;
    if (assignedAt === undefined) throw new Error('Assignment timestamp was not generated');
    const unit = await transaction.selectFrom('organizational_units').select('id').where('institution_id', '=', input.institutionId).where('id', '=', input.unitId).where('status', '=', 'ACTIVE').executeTakeFirst();
    if (unit === undefined) throw new DomainInvariantError('TARGET_UNIT_NOT_FOUND', 'Assignment target unit was not found');
    if (input.userId !== undefined) {
      const user = await transaction.selectFrom('users').select('id').where('institution_id', '=', input.institutionId).where('id', '=', input.userId).where('status', '=', 'ACTIVE').executeTakeFirst();
      if (user === undefined) throw new DomainInvariantError('TARGET_USER_NOT_FOUND', 'Assignment target user was not found');
      const membership = await transaction.selectFrom('user_role_assignments')
        .select('id')
        .where('institution_id', '=', input.institutionId)
        .where('user_id', '=', input.userId)
        .where('unit_id', '=', input.unitId)
        .where('effective_from', '<=', assignedAt)
        .where((expression) => expression.or([
          expression('effective_until', 'is', null),
          expression('effective_until', '>', assignedAt),
        ]))
        .executeTakeFirst();
      if (membership === undefined) throw new DomainInvariantError('TARGET_USER_NOT_IN_UNIT', 'Assignment target user is not an active member of the target unit');
    }
    await transaction.insertInto('matter_assignments').values({ id: input.assignmentId, institution_id: input.institutionId, matter_id: input.matterId, unit_id: input.unitId, ...(input.userId === undefined ? {} : { user_id: input.userId }), ...(input.reason === undefined ? {} : { reason: input.reason }), assigned_at: assignedAt }).execute();
    await transaction.updateTable('matters').set({ status: toStatus, updated_at: new Date() }).where('institution_id', '=', input.institutionId).where('id', '=', input.matterId).execute();
    await transaction.insertInto('matter_state_events').values({ institution_id: input.institutionId, matter_id: input.matterId, from_status: input.fromStatus, to_status: toStatus, command: input.command, ...(input.actorUserId === undefined ? {} : { actor_user_id: input.actorUserId }), ...(input.reason === undefined ? {} : { reason: input.reason }), event_data: { assignmentId: input.assignmentId, unitId: input.unitId, ...(input.userId === undefined ? {} : { userId: input.userId }) }, occurred_at: assignedAt }).execute();
  });
}

export interface MatterInboxReadModel extends MatterReadModel {
  readonly assignment_unit_id: string;
  readonly assignment_user_id: string | null;
  readonly assignment_assigned_at: Date | string;
}

export async function findMatterInbox(
  database: Database,
  institutionId: InstitutionId | string,
  userId: string,
  authorizedUnitIds: readonly string[],
  institutionWideRead: boolean,
): Promise<readonly MatterInboxReadModel[]> {
  return withTenantTransaction(database, institutionId, async (transaction) => {
    const unitPredicate = authorizedUnitIds.length === 0
      ? sql`false`
      : sql`a.unit_id in (${sql.join(authorizedUnitIds.map((id) => sql`${id}`), sql`, `)})`;
    const result = await sql<MatterInboxReadModel>`
      select m.*, a.unit_id as assignment_unit_id, a.user_id as assignment_user_id,
             a.assigned_at as assignment_assigned_at
      from matters m
      cross join lateral (
        select ma.unit_id, ma.user_id, ma.assigned_at
        from matter_assignments ma
        where ma.institution_id = m.institution_id and ma.matter_id = m.id
        order by ma.assigned_at desc, ma.id desc
        limit 1
      ) a
      where m.institution_id = ${institutionId}
        and (a.user_id = ${userId} or ${institutionWideRead} or ${unitPredicate})
      order by m.updated_at desc, m.id desc
    `.execute(transaction);
    return result.rows;
  });
}

export async function persistMatterTransition(database: Database, input: StateTransitionPersistenceInput): Promise<void> {
  if (!['startMatter', 'resolveMatter', 'reopenMatter', 'closeMatter', 'voidMatter'].includes(input.command)) {
    throw new DomainInvariantError('TRANSITION_REQUIRES_HARDENED_OPERATION', `${input.command} must use its lifecycle-specific operation`);
  }
  assertTransition(input.command, input.fromStatus, input.toStatus, matterTransitions);
  if (input.command === 'startMatter' && input.eventData?.authorizedUnitIds !== undefined) throw new DomainInvariantError('INVALID_AUTHORIZATION_EVIDENCE', 'Authorization evidence must not be supplied in event data');
  const reason = input.command === 'reopenMatter' || input.command === 'voidMatter' ? requireReason(input.reason, input.command) : input.reason;
  await withTenantContextTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, correlationId: input.correlationId }, async (transaction) => {
    const current = await transaction.selectFrom('matters').select(['status', 'linked_expediente_id', 'destination_unit_id', 'intake_metadata']).where('institution_id', '=', input.institutionId).where('id', '=', input.aggregateId).forUpdate().executeTakeFirst();
    if (current === undefined) throw new Error('Matter not found');
    if (current.status !== input.fromStatus) throw new DomainInvariantError('STALE_STATE', `Matter is ${current.status}, expected ${input.fromStatus}`);
    const transitionAt = (await sql<{ occurred_at: Date }>`select clock_timestamp() as occurred_at`.execute(transaction)).rows[0]?.occurred_at;
    if (transitionAt === undefined) throw new Error('Transition timestamp was not generated');
    const effectiveUnit = await effectiveMatterUnit(transaction, String(input.institutionId), input.aggregateId, current.destination_unit_id);
    const authorization = requireMatchingTransitionAuthorization(input);
    if (input.command === 'resolveMatter' && !canPerform(authorization, 'matter.resolve', effectiveUnit ?? undefined)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot resolve matters for the effective unit');
    if (input.command === 'voidMatter' && !canPerform(authorization, 'matter.void', effectiveUnit ?? undefined)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot void matters for the effective unit');
    if (input.command === 'closeMatter') requireTransitionCapability(authorization, 'matter.close', effectiveUnit ?? undefined);
    if (input.command === 'reopenMatter') requireTransitionCapability(authorization, 'matter.reopen', effectiveUnit ?? undefined);
    const changes: { status: MatterState; updated_at: Date; resolution_metadata?: JsonObject; closure_metadata?: JsonObject; linked_expediente_id?: string } = { status: input.toStatus as MatterState, updated_at: transitionAt };
    if (input.command === 'startMatter') {
      if (input.actorUserId === undefined) throw new DomainInvariantError('ACTOR_REQUIRED', 'startMatter requires an actor');
      const assignment = await currentMatterAssignment(transaction, String(input.institutionId), input.aggregateId);
      if (assignment === undefined || (assignment.user_id !== input.actorUserId && !canPerform(authorization, 'matter.start', assignment.unit_id))) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor is not the current assignee or authorized to start matters for the assigned unit');
    }
    if (input.command === 'resolveMatter') {
      const resolution = objectEventValue(input.eventData, 'resolutionMetadata');
      if (resolution === undefined || Object.keys(resolution).length === 0) throw new DomainInvariantError('INVALID_RESOLUTION', 'resolveMatter requires resolution metadata');
      changes.resolution_metadata = resolution;
    }
    if (input.command === 'reopenMatter') {
      if (current.linked_expediente_id === null) throw new DomainInvariantError('EXPEDIENTE_NOT_OPEN', 'A resolved matter can only reopen while its linked expediente is open');
      const linked = await transaction.selectFrom('expedientes').select('status').where('institution_id', '=', input.institutionId).where('id', '=', current.linked_expediente_id).executeTakeFirst();
      if (linked?.status !== 'OPEN') throw new DomainInvariantError('EXPEDIENTE_NOT_OPEN', 'A resolved matter can only reopen while its linked expediente is open');
    }
    let authoritativeEventData = input.eventData;
    if (input.command === 'closeMatter') {
      const linkedExpedienteId = current.linked_expediente_id;
      const closureMetadata = objectEventValue(input.eventData, 'closureMetadata');
      if (linkedExpedienteId === null) throw new DomainInvariantError('EXPEDIENTE_LINK_REQUIRED', 'Matter must already be linked to an expediente before closure');
      if (closureMetadata === undefined || Object.keys(closureMetadata).length === 0) throw new DomainInvariantError('INVALID_CLOSURE', 'closeMatter requires closure metadata');
      changes.closure_metadata = closureMetadata;
      authoritativeEventData = { ...(input.eventData ?? {}), linkedExpedienteId };
    }
    await transaction.updateTable('matters').set(changes).where('institution_id', '=', input.institutionId).where('id', '=', input.aggregateId).execute();
    await transaction.insertInto('matter_state_events').values({ institution_id: input.institutionId, matter_id: input.aggregateId, from_status: input.fromStatus, to_status: input.toStatus as MatterState, command: input.command, ...(input.actorUserId === undefined ? {} : { actor_user_id: input.actorUserId }), ...(reason === undefined ? {} : { reason }), event_data: authoritativeEventData ?? {}, occurred_at: transitionAt }).execute();
    await appendAuditEvent(transaction, {
      institutionId: input.institutionId,
      actorUserId: input.actorUserId,
      eventType: auditEventType(matterAuditEvents, input.command),
      aggregateType: 'matter',
      aggregateId: input.aggregateId,
      correlationId: input.correlationId,
      beforeData: { status: input.fromStatus },
      afterData: { status: input.toStatus },
      eventData: input.command === 'voidMatter' && reason !== undefined ? { ...(authoritativeEventData ?? {}), reason } : authoritativeEventData,
    });
  });
}

export async function linkMatterToExpedienteAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly matterId: string; readonly expedienteId: string; readonly actorUserId: string; readonly correlationId: string; readonly authorizationContext: AuthorizationContext }): Promise<void> {
  await withTenantContextTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, correlationId: input.correlationId }, async (transaction) => {
    const matter = await transaction.selectFrom('matters').select(['status', 'linked_expediente_id', 'destination_unit_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.matterId).forUpdate().executeTakeFirst();
    if (matter === undefined) throw new Error('Matter not found');
    if (matter.linked_expediente_id !== null) throw new DomainInvariantError('MATTER_ALREADY_LINKED', 'Matter is already linked to an expediente');
    if (matter.status === 'CLOSED' || matter.status === 'VOIDED') throw new DomainInvariantError('INVALID_TRANSITION', `linkMatterToExpediente is not allowed from ${matter.status}`);
    if (input.authorizationContext.institutionId !== String(input.institutionId) || input.authorizationContext.userId !== input.actorUserId) throw new DomainInvariantError('AUTHORIZATION_CONTEXT_REQUIRED', 'Link authorization context does not match the actor and institution');
    const effectiveUnit = await effectiveMatterUnit(transaction, String(input.institutionId), input.matterId, matter.destination_unit_id);
    if (!canPerform(input.authorizationContext, 'expediente.edit_open', effectiveUnit ?? undefined)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot edit open expedientes for the effective matter unit');
    const expediente = await transaction.selectFrom('expedientes').select('status').where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteId).forShare().executeTakeFirst();
    if (expediente?.status !== 'OPEN') throw new DomainInvariantError('EXPEDIENTE_NOT_OPEN', 'A matter can only be linked to an open expediente');
    const linkedAt = (await sql<{ linked_at: Date }>`select clock_timestamp() as linked_at`.execute(transaction)).rows[0]?.linked_at;
    if (linkedAt === undefined) throw new Error('Link timestamp was not generated');
    await transaction.updateTable('matters').set({ linked_expediente_id: input.expedienteId, updated_at: linkedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.matterId).execute();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'matter.linked_to_expediente', aggregateType: 'matter', aggregateId: input.matterId, correlationId: input.correlationId, beforeData: { linkedExpedienteId: null }, afterData: { linkedExpedienteId: input.expedienteId }, eventData: { expedienteId: input.expedienteId } });
  });
}

export async function addMatterNoteAtomically(database: Database, input: { readonly id: string; readonly institutionId: InstitutionId | string; readonly matterId: string; readonly authorUserId: string; readonly content: string; readonly noteType?: 'NOTE' | 'RESPONSE'; readonly correlationId: string; readonly authorizationContext: AuthorizationContext }): Promise<MatterNoteReadModel> {
  if (input.content.trim().length === 0 || input.content.length > 10_000) throw new DomainInvariantError('INVALID_NOTE', 'A note must contain at most 10,000 characters');
  return withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.authorUserId, eventType: 'matter.note_added', aggregateType: 'matter', aggregateId: input.matterId, correlationId: input.correlationId, eventData: { noteId: input.id, noteType: input.noteType ?? 'NOTE' } }, async (transaction) => {
    const matter = await transaction.selectFrom('matters').select(['status', 'destination_unit_id', 'intake_metadata']).where('institution_id', '=', input.institutionId).where('id', '=', input.matterId).forUpdate().executeTakeFirst();
    if (matter === undefined) throw new Error('Matter not found');
    if (matter.status === 'CLOSED' || matter.status === 'VOIDED') throw new DomainInvariantError('INVALID_TRANSITION', 'Notes cannot be added to terminal matters');
    if (input.authorizationContext.institutionId !== String(input.institutionId) || input.authorizationContext.userId !== input.authorUserId) throw new DomainInvariantError('AUTHORIZATION_CONTEXT_REQUIRED', 'Note authorization context does not match the actor');
    const visibility = matter.intake_metadata.operationalVisibility;
    if (visibility !== 'INSTITUTION' && visibility !== 'UNIT') throw new DomainInvariantError('NOT_AUTHORIZED', 'Matter visibility is not supported');
    const effectiveUnit = await effectiveMatterUnit(transaction, String(input.institutionId), input.matterId, matter.destination_unit_id);
    if (!canPerform(input.authorizationContext, 'records.read', effectiveUnit ?? undefined)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot read the effective matter unit');
    const writeCapabilities: readonly Capability[] = ['matter.assign', 'matter.void', 'matter.start', 'matter.resolve', 'matter.reopen', 'matter.close'];
    if (!writeCapabilities.some((capability) => canPerform(input.authorizationContext, capability, effectiveUnit ?? undefined))) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot write matter notes for the effective unit');
    const createdAt = (await sql<{ created_at: Date }>`select clock_timestamp() as created_at`.execute(transaction)).rows[0]?.created_at;
    if (createdAt === undefined) throw new Error('Note timestamp was not generated');
    await transaction.insertInto('matter_notes').values({ id: input.id, institution_id: input.institutionId, matter_id: input.matterId, author_user_id: input.authorUserId, note_type: input.noteType ?? 'NOTE', content: input.content, created_at: createdAt }).execute();
    return { id: input.id, institution_id: input.institutionId, matter_id: input.matterId, author_user_id: input.authorUserId, note_type: input.noteType ?? 'NOTE', content: input.content, created_at: createdAt };
  });
}

export type MatterNoteReadModel = Selectable<MatterNotesTable>;

/**
 * Lists notes only after checking the matter's current operational visibility
 * and effective-unit read capability while the matter row is locked. This
 * keeps note authorization and retrieval in one transaction, preventing a
 * reassignment from racing between the authorization check and the read.
 */
export async function findMatterNotesAuthorized(
  database: Database,
  input: {
    readonly institutionId: InstitutionId | string;
    readonly matterId: string;
    readonly authorizationContext: AuthorizationContext;
  },
): Promise<readonly MatterNoteReadModel[]> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const matter = await transaction
      .selectFrom('matters')
      .select(['destination_unit_id', 'intake_metadata'])
      .where('institution_id', '=', input.institutionId)
      .where('id', '=', input.matterId)
      .forUpdate()
      .executeTakeFirst();
    if (matter === undefined) throw new Error('Matter not found');
    if (input.authorizationContext.institutionId !== String(input.institutionId)) {
      throw new DomainInvariantError('AUTHORIZATION_CONTEXT_REQUIRED', 'Note authorization context does not match the tenant');
    }
    const visibility = matter.intake_metadata.operationalVisibility;
    if (visibility !== 'INSTITUTION' && visibility !== 'UNIT') {
      throw new DomainInvariantError('NOT_AUTHORIZED', 'Matter visibility is not supported');
    }
    const effectiveUnit = await effectiveMatterUnit(transaction, String(input.institutionId), input.matterId, matter.destination_unit_id);
    if (!canPerform(input.authorizationContext, 'records.read', effectiveUnit ?? undefined)) {
      throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot read the effective matter unit');
    }
    return transaction
      .selectFrom('matter_notes')
      .selectAll()
      .where('institution_id', '=', input.institutionId)
      .where('matter_id', '=', input.matterId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  });
}

export interface MatterActivityReadModel {
  readonly id: string;
  readonly kind: 'state' | 'audit';
  readonly event_type: string;
  readonly command?: string;
  readonly from_status: string | null;
  readonly to_status: string | null;
  readonly actor_user_id: string | null;
  readonly reason: string | null;
  readonly event_data: JsonObject;
  readonly occurred_at: Date | string;
}

export async function findMatterActivityAuthorized(database: Database, input: { readonly institutionId: InstitutionId | string; readonly matterId: string; readonly authorizationContext: AuthorizationContext }): Promise<readonly MatterActivityReadModel[] | undefined> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const matter = await transaction.selectFrom('matters').select(['id', 'destination_unit_id', 'intake_metadata']).where('institution_id', '=', input.institutionId).where('id', '=', input.matterId).forShare().executeTakeFirst();
    if (matter === undefined) return undefined;
    const visibility = matter.intake_metadata.operationalVisibility;
    const unit = await effectiveMatterUnit(transaction, String(input.institutionId), input.matterId, matter.destination_unit_id);
    if (visibility !== 'INSTITUTION' && visibility !== 'UNIT' || !canPerform(input.authorizationContext, 'records.read', unit ?? undefined)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot read matter activity');
    const states = await transaction.selectFrom('matter_state_events').selectAll().where('institution_id', '=', input.institutionId).where('matter_id', '=', input.matterId).execute();
    const audits = await transaction.selectFrom('audit_events').selectAll().where('institution_id', '=', input.institutionId).where('aggregate_type', '=', 'matter').where('aggregate_id', '=', input.matterId).execute();
    return [...states.map((event) => ({ id: event.id, kind: 'state' as const, event_type: event.command, command: event.command, from_status: event.from_status, to_status: event.to_status, actor_user_id: event.actor_user_id, reason: event.reason, event_data: event.event_data, occurred_at: event.occurred_at })), ...audits.filter((event) => !matterLifecycleAuditEvents.has(event.event_type)).map((event) => ({ id: event.id, kind: 'audit' as const, event_type: event.event_type, from_status: null, to_status: null, actor_user_id: event.actor_user_id, reason: null, event_data: event.event_data, occurred_at: event.occurred_at }))].sort((left, right) => new Date(left.occurred_at).getTime() - new Date(right.occurred_at).getTime());
  });
}

export async function persistExpedienteTransition(database: Database, input: StateTransitionPersistenceInput): Promise<void> {
  const transitionCapabilities: Readonly<Record<string, Capability>> = {
    closeExpediente: 'expediente.close',
    reopenExpediente: 'expediente.reopen',
  };
  const capability = transitionCapabilities[input.command];
  if (capability === undefined) {
    throw new DomainInvariantError('TRANSITION_REQUIRES_HARDENED_OPERATION', `${input.command} must use its lifecycle-specific operation`);
  }
  assertTransition(input.command, input.fromStatus, input.toStatus, expedienteTransitions);
  const reason = input.command === 'reopenExpediente' || input.command === 'rejectTransfer' || input.command === 'cancelTransfer' || input.command === 'voidExpediente' ? requireReason(input.reason, input.command) : input.reason;
  await withAuditedTenantTransaction(database, {
    institutionId: input.institutionId,
    actorUserId: input.actorUserId,
    eventType: auditEventType(expedienteAuditEvents, input.command),
    aggregateType: 'expediente',
    aggregateId: input.aggregateId,
    correlationId: input.correlationId,
    beforeData: { status: input.fromStatus },
    afterData: { status: input.toStatus },
    eventData: input.eventData,
  }, async (transaction) => {
    const current = await transaction.selectFrom('expedientes').select('status').where('institution_id', '=', input.institutionId).where('id', '=', input.aggregateId).forUpdate().executeTakeFirst();
    if (current === undefined) throw new Error('Expediente not found');
    if (current.status !== input.fromStatus) throw new DomainInvariantError('STALE_STATE', `Expediente is ${current.status}, expected ${input.fromStatus}`);
    const authorization = requireMatchingTransitionAuthorization(input);
    requireTransitionCapability(authorization, capability);
    if (input.command === 'closeExpediente') {
      const closureMetadata = objectEventValue(input.eventData, 'closureMetadata');
      if (booleanEventValue(input.eventData, 'metadataValid') !== true || closureMetadata === undefined || Object.keys(closureMetadata).length === 0) throw new DomainInvariantError('INVALID_METADATA', 'closeExpediente requires non-empty validated metadata');
      const invalidMatter = await transaction.selectFrom('matters').select('id').where('institution_id', '=', input.institutionId).where('linked_expediente_id', '=', input.aggregateId).where('status', 'not in', ['CLOSED', 'VOIDED']).executeTakeFirst();
      if (invalidMatter !== undefined) throw new DomainInvariantError('MATTERS_NOT_CLOSED', 'All linked matters must be CLOSED or VOIDED');
      const unsafeDocument = await transaction.selectFrom('documents').leftJoin('matters', (join) => join.onRef('matters.institution_id', '=', 'documents.institution_id').onRef('matters.id', '=', 'documents.matter_id')).leftJoin('document_versions', (join) => join.onRef('document_versions.institution_id', '=', 'documents.institution_id').onRef('document_versions.document_id', '=', 'documents.id')).select('documents.id').where('documents.institution_id', '=', input.institutionId).where((expression) => expression.or([
        expression('documents.expediente_id', '=', input.aggregateId),
        expression.and([expression('documents.matter_id', 'is not', null), expression('matters.linked_expediente_id', '=', input.aggregateId)]),
      ])).where((expression) => expression.or([expression('document_versions.id', 'is', null), expression('document_versions.malware_scan_status', '<>', 'CLEAN')])).executeTakeFirst();
      if (unsafeDocument !== undefined) throw new DomainInvariantError('DOCUMENTS_NOT_CLEAN', 'All retained document versions must have a clean malware scan');
    }
    if (input.command === 'reopenExpediente') {
      const approvedTransfer = await transaction.selectFrom('archive_transfers').select('id').where('institution_id', '=', input.institutionId).where('expediente_id', '=', input.aggregateId).where('status', 'in', ['APPROVED', 'SUBMITTED', 'PRESERVING', 'COMPLETED', 'FAILED']).executeTakeFirst();
      if (approvedTransfer !== undefined) throw new DomainInvariantError('TRANSFER_ALREADY_APPROVED', 'An expediente cannot reopen after transfer approval');
    }
    if (input.command === 'prepareTransfer' && (booleanEventValue(input.eventData, 'archivalMappingValid') !== true || booleanEventValue(input.eventData, 'draftManifestReady') !== true)) throw new DomainInvariantError('TRANSFER_NOT_READY', 'Archival mapping and draft manifest must validate');
    if (input.command === 'completeTransfer' && (booleanEventValue(input.eventData, 'approvedManifestPreserved') !== true || booleanEventValue(input.eventData, 'aipStored') !== true || booleanEventValue(input.eventData, 'archivalIntegrationCompleted') !== true)) throw new DomainInvariantError('TRANSFER_NOT_COMPLETE', 'Approved manifest, preservation package, and archival integration are required');
    if (input.command === 'voidExpediente') {
      const closedMatter = await transaction.selectFrom('matters').select('id').where('institution_id', '=', input.institutionId).where('linked_expediente_id', '=', input.aggregateId).where('status', '=', 'CLOSED').executeTakeFirst();
      if (closedMatter !== undefined) throw new DomainInvariantError('CLOSED_MATTER_DEPENDENCY', 'An expediente with a closed substantive matter cannot be voided');
    }
    const now = new Date();
    await transaction.updateTable('expedientes').set({ status: input.toStatus as ExpedienteState, updated_at: now, ...(input.command === 'closeExpediente' ? { closed_at: now } : {}), ...(input.command === 'reopenExpediente' ? { closed_at: null } : {}) }).where('institution_id', '=', input.institutionId).where('id', '=', input.aggregateId).execute();
    await transaction.insertInto('expediente_state_events').values({ institution_id: input.institutionId, expediente_id: input.aggregateId, from_status: input.fromStatus, to_status: input.toStatus as ExpedienteState, command: input.command, ...(input.actorUserId === undefined ? {} : { actor_user_id: input.actorUserId }), ...(reason === undefined ? {} : { reason }), event_data: input.eventData ?? {}, occurred_at: now }).execute();
  });
}

export interface DocumentVersionMetadataInput {
  readonly institutionId: InstitutionId | string;
  readonly documentId: string;
  readonly versionId: string;
  readonly originalFilename: string;
  readonly detectedMimeType: string;
  readonly declaredMimeType?: string;
  readonly sizeBytes: string | number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly accessClassificationSnapshot?: JsonObject;
  readonly malwareScanStatus: 'PENDING_SCAN' | 'CLEAN' | 'INFECTED' | 'SCAN_FAILED' | 'QUARANTINED';
  readonly createdBy: string;
  readonly replacementReason?: string;
  readonly correlationId: string;
}

export async function createDocumentVersionMetadataAtomically(database: Database, input: DocumentVersionMetadataInput): Promise<number> {
  if (input.malwareScanStatus !== 'PENDING_SCAN') throw new DomainInvariantError('INVALID_INITIAL_SCAN_STATUS', 'A new document version must begin pending malware scan');
  return withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.createdBy, eventType: 'document.version_created', aggregateType: 'document', aggregateId: input.documentId, correlationId: input.correlationId, eventData: { versionId: input.versionId } }, async (transaction) => {
    const document = await transaction.selectFrom('documents').select(['expediente_id', 'matter_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).forUpdate().executeTakeFirst();
    if (document === undefined) throw new Error('Document not found');
    if ((document.expediente_id === null) === (document.matter_id === null)) throw new DomainInvariantError('INVALID_DOCUMENT_PARENT', 'A logical document must have exactly one parent');
    if (document.matter_id !== null) throw new DomainInvariantError('MATTER_DOCUMENT_ACCEPTANCE_REQUIRED', 'Matter-owned documents must use the authenticated intake acceptance operation');
    const expediente = await transaction.selectFrom('expedientes').select('status').where('institution_id', '=', input.institutionId).where('id', '=', document.expediente_id).executeTakeFirst();
    if (expediente?.status !== 'OPEN') throw new DomainInvariantError('EXPEDIENTE_NOT_OPEN', 'Routine document version creation requires an open expediente');
    const latest = await transaction.selectFrom('document_versions').select(({ fn }) => fn.max('version_number').as('latest_version')).where('institution_id', '=', input.institutionId).where('document_id', '=', input.documentId).executeTakeFirst();
    const versionNumber = Number(latest?.latest_version ?? 0) + 1;
    if (versionNumber > 1 && (input.replacementReason === undefined || input.replacementReason.trim().length === 0)) throw new DomainInvariantError('REPLACEMENT_REASON_REQUIRED', 'A replacement document version requires a reason');
    await transaction.insertInto('document_versions').values({ id: input.versionId, institution_id: input.institutionId, document_id: input.documentId, version_number: versionNumber, original_filename: input.originalFilename, detected_mime_type: input.detectedMimeType, ...(input.declaredMimeType === undefined ? {} : { declared_mime_type: input.declaredMimeType }), size_bytes: input.sizeBytes, sha256: input.sha256, storage_key: input.storageKey, access_classification_snapshot: input.accessClassificationSnapshot ?? { legalClassification: 'PUBLIC', operationalVisibility: 'INSTITUTION' }, malware_scan_status: input.malwareScanStatus, created_by: input.createdBy, ...(input.replacementReason === undefined ? {} : { replacement_reason: input.replacementReason }) }).execute();
    await transaction.updateTable('documents').set({ current_version_id: input.versionId, updated_at: new Date() }).where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).execute();
    return versionNumber;
  });
}

export interface MatterDocumentUploadPersistenceInput extends DocumentVersionMetadataInput {
  readonly matterId: string;
  readonly documentType: string;
  readonly title: string;
  readonly authorizationContext: AuthorizationContext;
}

export interface AcceptedMatterDocumentUpload {
  readonly document: Selectable<DocumentsTable>;
  readonly version: Selectable<DocumentVersionsTable>;
  readonly job: Selectable<IntegrationJobsTable>;
}

function requireDocumentMetadata(input: DocumentVersionMetadataInput): void {
  if (input.originalFilename.trim().length === 0 || input.detectedMimeType.trim().length === 0 || input.storageKey.trim().length === 0) {
    throw new DomainInvariantError('INVALID_DOCUMENT_METADATA', 'Document filename, detected MIME type, and storage key are required');
  }
  if (!/^[0-9a-f]{64}$/i.test(input.sha256)) throw new DomainInvariantError('INVALID_SHA256', 'Document SHA-256 must contain 64 hexadecimal characters');
  let size: bigint;
  try { size = BigInt(input.sizeBytes); } catch { throw new DomainInvariantError('INVALID_SIZE', 'Document size must be an integer'); }
  if (size < 0n) throw new DomainInvariantError('INVALID_SIZE', 'Document size cannot be negative');
}

async function databaseTimestamp(transaction: DatabaseTransaction, alias: string): Promise<Date> {
  const result = await sql<{ value: Date }>`select clock_timestamp() as value`.execute(transaction);
  const timestamp = result.rows[0]?.value;
  if (timestamp === undefined) throw new Error(`${alias} timestamp was not generated`);
  return timestamp;
}

async function assertMatterDocumentAuthorization(
  transaction: DatabaseTransaction,
  institutionId: string,
  matterId: string,
  matter: { readonly destination_unit_id: string | null; readonly intake_metadata: JsonObject; readonly status: string; readonly access_classification_id: string | null },
  authorization: AuthorizationContext,
  actorUserId: string,
): Promise<string | null> {
  if (authorization.institutionId !== institutionId || authorization.userId !== actorUserId) throw new DomainInvariantError('AUTHORIZATION_CONTEXT_REQUIRED', 'Document authorization context does not match the actor');
  if (matter.status === 'CLOSED' || matter.status === 'VOIDED') throw new DomainInvariantError('MATTER_NOT_OPEN', 'Documents cannot be accepted for a terminal matter');
  const visibility = matter.intake_metadata.operationalVisibility;
  if (visibility !== 'INSTITUTION' && visibility !== 'UNIT') throw new DomainInvariantError('NOT_AUTHORIZED', 'Matter visibility is not supported');
  const effectiveUnit = await effectiveMatterUnit(transaction, institutionId, matterId, matter.destination_unit_id);
  if (!canPerform(authorization, 'records.read', effectiveUnit ?? undefined) || !canPerform(authorization, 'document.version_open', effectiveUnit ?? undefined)) {
    throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot add document versions for the effective matter unit');
  }
  return effectiveUnit;
}

async function classificationSnapshot(transaction: DatabaseTransaction, institutionId: string, classificationId: string | null, expectedOperationalVisibility: JsonValue | undefined): Promise<JsonObject> {
  if (classificationId === null) throw new DomainInvariantError('ACCESS_CLASSIFICATION_REQUIRED', 'Matter access classification is required for document intake');
  const classification = await transaction.selectFrom('access_classifications').selectAll().where('institution_id', '=', institutionId).where('id', '=', classificationId).executeTakeFirst();
  if (classification === undefined) throw new DomainInvariantError('ACCESS_CLASSIFICATION_NOT_FOUND', 'Matter access classification was not found');
  if (expectedOperationalVisibility !== undefined && expectedOperationalVisibility !== classification.operational_visibility) {
    throw new DomainInvariantError('INCONSISTENT_ACCESS_CLASSIFICATION', 'Matter operational visibility must match its access classification');
  }
  return {
    legalClassification: classification.legal_classification,
    operationalVisibility: classification.operational_visibility,
    ...(classification.legal_basis === null ? {} : { legalBasis: classification.legal_basis }),
    ...(classification.reason === null ? {} : { reason: classification.reason }),
    ...(classification.classification_authority === null ? {} : { classificationAuthority: classification.classification_authority }),
    ...(classification.classified_at === null ? {} : { classifiedAt: classification.classified_at.toISOString() }),
    ...(classification.review_expires_at === null ? {} : { reviewExpiresAt: classification.review_expires_at.toISOString() }),
  };
}

async function insertMalwareScanJob(transaction: DatabaseTransaction, input: { readonly institutionId: string; readonly versionId: string; readonly storageKey: string; readonly sizeBytes: string | number; readonly correlationId: string }): Promise<Selectable<IntegrationJobsTable>> {
  const idempotencyKey = `malware-scan:${input.versionId}`;
  await transaction.insertInto('integration_jobs').values({
    institution_id: input.institutionId,
    job_type: 'document.malware_scan',
    aggregate_type: 'document_version',
    aggregate_id: input.versionId,
    status: 'PENDING',
    idempotency_key: idempotencyKey,
    correlation_id: input.correlationId,
    attempt_count: 0,
    payload: { storageKey: input.storageKey, expectedSizeBytes: String(input.sizeBytes) },
  }).onConflict((conflict) => conflict.columns(['institution_id', 'idempotency_key']).doNothing()).execute();
  const job = await transaction.selectFrom('integration_jobs').selectAll().where('institution_id', '=', input.institutionId).where('idempotency_key', '=', idempotencyKey).executeTakeFirst();
  if (job === undefined) throw new Error('Malware scan job was not persisted');
  return job;
}

/** Accepts the first streamed matter document after the stream has completed. */
export async function acceptMatterDocumentUploadAtomically(database: Database, input: MatterDocumentUploadPersistenceInput): Promise<AcceptedMatterDocumentUpload> {
  requireDocumentMetadata(input);
  if (input.documentType.trim().length === 0 || input.title.trim().length === 0) throw new DomainInvariantError('INVALID_DOCUMENT_METADATA', 'Document type and title are required');
  if (input.malwareScanStatus !== 'PENDING_SCAN') throw new DomainInvariantError('INVALID_INITIAL_SCAN_STATUS', 'A new document version must begin pending malware scan');
  if (input.replacementReason !== undefined) throw new DomainInvariantError('INVALID_DOCUMENT_METADATA', 'The first document version cannot have a replacement reason');
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const matter = await transaction.selectFrom('matters').select(['status', 'destination_unit_id', 'intake_metadata', 'access_classification_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.matterId).forUpdate().executeTakeFirst();
    if (matter === undefined) throw new Error('Matter not found');
    await assertMatterDocumentAuthorization(transaction, String(input.institutionId), input.matterId, matter, input.authorizationContext, input.createdBy);
    const snapshot = await classificationSnapshot(transaction, String(input.institutionId), matter.access_classification_id, matter.intake_metadata.operationalVisibility);
    const acceptedAt = await databaseTimestamp(transaction, 'Document acceptance');
    await transaction.insertInto('documents').values({ id: input.documentId, institution_id: input.institutionId, matter_id: input.matterId, document_type: input.documentType, title: input.title, access_classification_id: matter.access_classification_id, created_at: acceptedAt, updated_at: acceptedAt }).execute();
    await transaction.insertInto('document_versions').values({ id: input.versionId, institution_id: input.institutionId, document_id: input.documentId, version_number: 1, original_filename: input.originalFilename, detected_mime_type: input.detectedMimeType, ...(input.declaredMimeType === undefined ? {} : { declared_mime_type: input.declaredMimeType }), size_bytes: input.sizeBytes, sha256: input.sha256, storage_key: input.storageKey, access_classification_snapshot: snapshot, malware_scan_status: 'PENDING_SCAN', created_by: input.createdBy, created_at: acceptedAt }).execute();
    await transaction.updateTable('documents').set({ current_version_id: input.versionId, updated_at: acceptedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).execute();
    const job = await insertMalwareScanJob(transaction, { institutionId: String(input.institutionId), versionId: input.versionId, storageKey: input.storageKey, sizeBytes: input.sizeBytes, correlationId: input.correlationId });
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.createdBy, eventType: 'document.created', aggregateType: 'document', aggregateId: input.documentId, correlationId: input.correlationId, afterData: { matterId: input.matterId, documentType: input.documentType } });
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.createdBy, eventType: 'document.version_created', aggregateType: 'document', aggregateId: input.documentId, correlationId: input.correlationId, eventData: { versionId: input.versionId, versionNumber: 1 } });
    const document = await transaction.selectFrom('documents').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).executeTakeFirstOrThrow();
    const version = await transaction.selectFrom('document_versions').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).executeTakeFirstOrThrow();
    return { document, version, job };
  });
}

/** Accepts a replacement version for a matter-owned logical document. */
export async function acceptMatterDocumentVersionUploadAtomically(database: Database, input: DocumentVersionMetadataInput & { readonly authorizationContext: AuthorizationContext }): Promise<{ readonly version: Selectable<DocumentVersionsTable>; readonly job: Selectable<IntegrationJobsTable> }> {
  requireDocumentMetadata(input);
  if (input.malwareScanStatus !== 'PENDING_SCAN') throw new DomainInvariantError('INVALID_INITIAL_SCAN_STATUS', 'A new document version must begin pending malware scan');
  if (input.replacementReason === undefined || input.replacementReason.trim().length === 0) throw new DomainInvariantError('REPLACEMENT_REASON_REQUIRED', 'A replacement document version requires a reason');
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const document = await transaction.selectFrom('documents').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).forUpdate().executeTakeFirst();
    if (document === undefined) throw new Error('Document not found');
    if (document.matter_id === null || document.expediente_id !== null) throw new DomainInvariantError('INVALID_DOCUMENT_PARENT', 'This operation only accepts matter-owned documents');
    const matter = await transaction.selectFrom('matters').select(['status', 'destination_unit_id', 'intake_metadata', 'access_classification_id']).where('institution_id', '=', input.institutionId).where('id', '=', document.matter_id).forUpdate().executeTakeFirst();
    if (matter === undefined) throw new Error('Matter not found');
    await assertMatterDocumentAuthorization(transaction, String(input.institutionId), document.matter_id, matter, input.authorizationContext, input.createdBy);
    const latest = await transaction.selectFrom('document_versions').select(({ fn }) => fn.max('version_number').as('latest_version')).where('institution_id', '=', input.institutionId).where('document_id', '=', input.documentId).executeTakeFirst();
    const versionNumber = Number(latest?.latest_version ?? 0) + 1;
    const acceptedAt = await databaseTimestamp(transaction, 'Document acceptance');
    const snapshot = await classificationSnapshot(transaction, String(input.institutionId), matter.access_classification_id, matter.intake_metadata.operationalVisibility);
    await transaction.insertInto('document_versions').values({ id: input.versionId, institution_id: input.institutionId, document_id: input.documentId, version_number: versionNumber, original_filename: input.originalFilename, detected_mime_type: input.detectedMimeType, ...(input.declaredMimeType === undefined ? {} : { declared_mime_type: input.declaredMimeType }), size_bytes: input.sizeBytes, sha256: input.sha256, storage_key: input.storageKey, access_classification_snapshot: snapshot, malware_scan_status: 'PENDING_SCAN', created_by: input.createdBy, replacement_reason: input.replacementReason, created_at: acceptedAt }).execute();
    await transaction.updateTable('documents').set({ current_version_id: input.versionId, updated_at: acceptedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).execute();
    const job = await insertMalwareScanJob(transaction, { institutionId: String(input.institutionId), versionId: input.versionId, storageKey: input.storageKey, sizeBytes: input.sizeBytes, correlationId: input.correlationId });
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.createdBy, eventType: 'document.version_created', aggregateType: 'document', aggregateId: input.documentId, correlationId: input.correlationId, eventData: { versionId: input.versionId, versionNumber } });
    const version = await transaction.selectFrom('document_versions').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).executeTakeFirstOrThrow();
    return { version, job };
  });
}

export interface ExpedienteDocumentUploadPersistenceInput extends DocumentVersionMetadataInput {
  readonly expedienteId: string;
  readonly documentType: string;
  readonly title: string;
  readonly accessClassificationId: string;
  readonly authorizationContext: AuthorizationContext;
}

/** Accepts the first document owned directly by an expediente. */
export async function acceptExpedienteDocumentUploadAtomically(database: Database, input: ExpedienteDocumentUploadPersistenceInput): Promise<AcceptedMatterDocumentUpload> {
  requireDocumentMetadata(input);
  if (input.documentType.trim().length === 0 || input.title.trim().length === 0 || input.accessClassificationId.trim().length === 0) throw new DomainInvariantError('INVALID_DOCUMENT_METADATA', 'Document metadata is required');
  if (input.malwareScanStatus !== 'PENDING_SCAN') throw new DomainInvariantError('INVALID_INITIAL_SCAN_STATUS', 'A new document version must begin pending malware scan');
  if (input.replacementReason !== undefined) throw new DomainInvariantError('INVALID_DOCUMENT_METADATA', 'The first document version cannot have a replacement reason');
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.authorizationContext.institutionId !== String(input.institutionId) || input.authorizationContext.userId !== input.createdBy) throw new DomainInvariantError('AUTHORIZATION_CONTEXT_REQUIRED', 'Document authorization context does not match the actor');
    if (!canPerform(input.authorizationContext, 'expediente.edit_open')) throw new DomainInvariantError('NOT_AUTHORIZED', 'Expediente document creation requires institution-scoped expediente.edit_open');
    const expediente = await transaction.selectFrom('expedientes').select(['id', 'status']).where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteId).forUpdate().executeTakeFirst();
    if (expediente === undefined) throw new DomainInvariantError('EXPEDIENTE_NOT_FOUND', 'Expediente not found');
    if (expediente.status !== 'OPEN') throw new DomainInvariantError('EXPEDIENTE_NOT_OPEN', 'Expediente is not open');
    const snapshot = await classificationSnapshot(transaction, String(input.institutionId), input.accessClassificationId, 'INSTITUTION');
    const acceptedAt = await databaseTimestamp(transaction, 'Expediente document acceptance');
    await transaction.insertInto('documents').values({ id: input.documentId, institution_id: input.institutionId, expediente_id: input.expedienteId, matter_id: null, document_type: input.documentType, title: input.title, access_classification_id: input.accessClassificationId, created_at: acceptedAt, updated_at: acceptedAt }).execute();
    await transaction.insertInto('document_versions').values({ id: input.versionId, institution_id: input.institutionId, document_id: input.documentId, version_number: 1, original_filename: input.originalFilename, detected_mime_type: input.detectedMimeType, ...(input.declaredMimeType === undefined ? {} : { declared_mime_type: input.declaredMimeType }), size_bytes: input.sizeBytes, sha256: input.sha256, storage_key: input.storageKey, access_classification_snapshot: snapshot, malware_scan_status: 'PENDING_SCAN', created_by: input.createdBy, created_at: acceptedAt }).execute();
    await transaction.updateTable('documents').set({ current_version_id: input.versionId, updated_at: acceptedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).execute();
    const job = await insertMalwareScanJob(transaction, { institutionId: String(input.institutionId), versionId: input.versionId, storageKey: input.storageKey, sizeBytes: input.sizeBytes, correlationId: input.correlationId });
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.createdBy, eventType: 'document.created', aggregateType: 'document', aggregateId: input.documentId, correlationId: input.correlationId, afterData: { expedienteId: input.expedienteId, documentType: input.documentType, accessClassificationId: input.accessClassificationId } });
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.createdBy, eventType: 'document.version_created', aggregateType: 'document', aggregateId: input.documentId, correlationId: input.correlationId, eventData: { versionId: input.versionId, versionNumber: 1 } });
    const document = await transaction.selectFrom('documents').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).executeTakeFirstOrThrow();
    const version = await transaction.selectFrom('document_versions').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).executeTakeFirstOrThrow();
    return { document, version, job };
  });
}

/** Accepts a replacement version for an expediente-owned logical document. */
export async function acceptExpedienteDocumentVersionUploadAtomically(database: Database, input: DocumentVersionMetadataInput & { readonly authorizationContext: AuthorizationContext }): Promise<{ readonly version: Selectable<DocumentVersionsTable>; readonly job: Selectable<IntegrationJobsTable> }> {
  requireDocumentMetadata(input);
  if (input.malwareScanStatus !== 'PENDING_SCAN') throw new DomainInvariantError('INVALID_INITIAL_SCAN_STATUS', 'A new document version must begin pending malware scan');
  if (input.replacementReason === undefined || input.replacementReason.trim().length === 0) throw new DomainInvariantError('REPLACEMENT_REASON_REQUIRED', 'A replacement document version requires a reason');
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.authorizationContext.institutionId !== String(input.institutionId) || input.authorizationContext.userId !== input.createdBy) throw new DomainInvariantError('AUTHORIZATION_CONTEXT_REQUIRED', 'Document authorization context does not match the actor');
    const document = await transaction.selectFrom('documents').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).forUpdate().executeTakeFirst();
    if (document === undefined) throw new Error('Document not found');
    if (document.expediente_id === null || document.matter_id !== null) throw new DomainInvariantError('INVALID_DOCUMENT_PARENT', 'This operation only accepts expediente-owned documents');
    const expediente = await transaction.selectFrom('expedientes').select(['id', 'status']).where('institution_id', '=', input.institutionId).where('id', '=', document.expediente_id).forUpdate().executeTakeFirst();
    if (expediente === undefined) throw new Error('Document not found');
    if (expediente.status !== 'OPEN') throw new DomainInvariantError('EXPEDIENTE_NOT_OPEN', 'Expediente is not open');
    if (!canPerform(input.authorizationContext, 'document.version_open')) throw new DomainInvariantError('NOT_AUTHORIZED', 'Expediente document version is not authorized');
    const latest = await transaction.selectFrom('document_versions').select(({ fn }) => fn.max('version_number').as('latest_version')).where('institution_id', '=', input.institutionId).where('document_id', '=', input.documentId).executeTakeFirst();
    const versionNumber = Number(latest?.latest_version ?? 0) + 1;
    const snapshot = await classificationSnapshot(transaction, String(input.institutionId), document.access_classification_id, 'INSTITUTION');
    const acceptedAt = await databaseTimestamp(transaction, 'Expediente document version acceptance');
    await transaction.insertInto('document_versions').values({ id: input.versionId, institution_id: input.institutionId, document_id: input.documentId, version_number: versionNumber, original_filename: input.originalFilename, detected_mime_type: input.detectedMimeType, ...(input.declaredMimeType === undefined ? {} : { declared_mime_type: input.declaredMimeType }), size_bytes: input.sizeBytes, sha256: input.sha256, storage_key: input.storageKey, access_classification_snapshot: snapshot, malware_scan_status: 'PENDING_SCAN', created_by: input.createdBy, replacement_reason: input.replacementReason, created_at: acceptedAt }).execute();
    await transaction.updateTable('documents').set({ current_version_id: input.versionId, updated_at: acceptedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).execute();
    const job = await insertMalwareScanJob(transaction, { institutionId: String(input.institutionId), versionId: input.versionId, storageKey: input.storageKey, sizeBytes: input.sizeBytes, correlationId: input.correlationId });
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.createdBy, eventType: 'document.version_created', aggregateType: 'document', aggregateId: input.documentId, correlationId: input.correlationId, eventData: { versionId: input.versionId, versionNumber } });
    const version = await transaction.selectFrom('document_versions').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).executeTakeFirstOrThrow();
    return { version, job };
  });
}

export interface AuthorizedDocumentDownload {
  readonly versionId: string;
  readonly storageKey: string;
  readonly originalFilename: string;
  readonly detectedMimeType: string;
  readonly sizeBytes: string;
  readonly sha256: string;
}

export async function authorizeMatterDocumentDownload(database: Database, input: { readonly institutionId: InstitutionId | string; readonly documentId: string; readonly versionId: string; readonly authorizationContext: AuthorizationContext }): Promise<AuthorizedDocumentDownload> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const row = await transaction.selectFrom('documents as d').innerJoin('document_versions as v', (join) => join.onRef('v.institution_id', '=', 'd.institution_id').onRef('v.document_id', '=', 'd.id')).innerJoin('matters as m', (join) => join.onRef('m.institution_id', '=', 'd.institution_id').onRef('m.id', '=', 'd.matter_id')).select(['v.id as version_id', 'v.storage_key', 'v.original_filename', 'v.detected_mime_type', 'v.size_bytes', 'v.sha256', 'v.malware_scan_status', 'm.id as matter_id', 'm.status', 'm.destination_unit_id', 'm.intake_metadata']).where('d.institution_id', '=', input.institutionId).where('d.id', '=', input.documentId).where('v.id', '=', input.versionId).where('d.matter_id', 'is not', null).executeTakeFirst();
    if (row === undefined) throw new Error('Document not found');
    if (input.authorizationContext.institutionId !== String(input.institutionId)) throw new DomainInvariantError('AUTHORIZATION_CONTEXT_REQUIRED', 'Document authorization context does not match the tenant');
    const visibility = row.intake_metadata.operationalVisibility;
    if (visibility !== 'INSTITUTION' && visibility !== 'UNIT') throw new DomainInvariantError('NOT_AUTHORIZED', 'Matter visibility is not supported');
    const effectiveUnit = await effectiveMatterUnit(transaction, String(input.institutionId), row.matter_id, row.destination_unit_id);
    if (!canPerform(input.authorizationContext, 'records.read', effectiveUnit ?? undefined)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot read the effective matter unit');
    if (row.malware_scan_status !== 'CLEAN') throw new DomainInvariantError('DOCUMENT_NOT_AVAILABLE', 'Document is not available for download');
    return { versionId: row.version_id, storageKey: row.storage_key, originalFilename: row.original_filename, detectedMimeType: row.detected_mime_type, sizeBytes: row.size_bytes, sha256: row.sha256 };
  });
}

export async function authorizeMatterDocumentVersionDownload(database: Database, input: { readonly institutionId: InstitutionId | string; readonly versionId: string; readonly authorizationContext: AuthorizationContext }): Promise<AuthorizedDocumentDownload> {
  const documentId = await withTenantTransaction(database, input.institutionId, async (transaction) => {
    const row = await transaction.selectFrom('document_versions').select('document_id').where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).executeTakeFirst();
    return row?.document_id;
  });
  if (documentId === undefined) throw new Error('Document not found');
  return authorizeMatterDocumentDownload(database, { institutionId: input.institutionId, documentId, versionId: input.versionId, authorizationContext: input.authorizationContext });
}

/** Ownership-aware protected download authorization. */
export async function authorizeDocumentVersionDownload(database: Database, input: { readonly institutionId: InstitutionId | string; readonly versionId: string; readonly authorizationContext: AuthorizationContext }): Promise<AuthorizedDocumentDownload> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const row = await transaction.selectFrom('documents as d').innerJoin('document_versions as v', (join) => join.onRef('v.institution_id', '=', 'd.institution_id').onRef('v.document_id', '=', 'd.id')).select(['d.id as document_id', 'd.matter_id', 'd.expediente_id', 'v.id as version_id', 'v.storage_key', 'v.original_filename', 'v.detected_mime_type', 'v.size_bytes', 'v.sha256', 'v.malware_scan_status']).where('d.institution_id', '=', input.institutionId).where('v.id', '=', input.versionId).executeTakeFirst();
    if (row === undefined || (row.matter_id === null) === (row.expediente_id === null)) throw new Error('Document not found');
    if (input.authorizationContext.institutionId !== String(input.institutionId)) throw new DomainInvariantError('AUTHORIZATION_CONTEXT_REQUIRED', 'Document authorization context does not match the tenant');
    if (row.expediente_id !== null) {
      if (!canPerform(input.authorizationContext, 'records.read')) throw new DomainInvariantError('NOT_AUTHORIZED', 'Expediente documents require institution-scoped records.read');
      const document = await transaction.selectFrom('documents').select('access_classification_id').where('institution_id', '=', input.institutionId).where('id', '=', row.document_id).executeTakeFirst();
      await assertExpedienteDocumentClassification(transaction, String(input.institutionId), document?.access_classification_id ?? null);
    } else {
      const matter = await transaction.selectFrom('matters').select(['destination_unit_id', 'intake_metadata']).where('institution_id', '=', input.institutionId).where('id', '=', row.matter_id).forShare().executeTakeFirst();
      if (matter === undefined || (matter.intake_metadata.operationalVisibility !== 'INSTITUTION' && matter.intake_metadata.operationalVisibility !== 'UNIT')) throw new DomainInvariantError('NOT_AUTHORIZED', 'Matter visibility is not supported');
      const unit = await effectiveMatterUnit(transaction, String(input.institutionId), row.matter_id!, matter.destination_unit_id);
      if (!canPerform(input.authorizationContext, 'records.read', unit ?? undefined)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot read the effective matter unit');
    }
    if (row.malware_scan_status !== 'CLEAN') throw new DomainInvariantError('DOCUMENT_NOT_AVAILABLE', 'Document is not available for download');
    return { versionId: row.version_id, storageKey: row.storage_key, originalFilename: row.original_filename, detectedMimeType: row.detected_mime_type, sizeBytes: row.size_bytes, sha256: row.sha256 };
  });
}

export async function recordMalwareScanResultAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly jobId: string; readonly claimToken: string; readonly versionId: string; readonly scanId: string; readonly result: 'CLEAN' | 'INFECTED' | 'SCAN_FAILED'; readonly engine: string; readonly engineVersion?: string; readonly signatureVersion?: string; readonly scannedAt?: Date; readonly error?: string; readonly correlationId: string; }): Promise<void> {
  if (input.result === 'SCAN_FAILED' && (input.error === undefined || input.error.length > 4000)) throw new DomainInvariantError('INVALID_JOB_ERROR', 'Scan failure errors are limited to 4000 characters');
  await withTenantTransaction(database, input.institutionId, async (transaction) => {
    const job = await transaction.selectFrom('integration_jobs').select(['status', 'aggregate_id', 'job_type', 'aggregate_type', 'claim_token']).where('institution_id', '=', input.institutionId).where('id', '=', input.jobId).forUpdate().executeTakeFirst();
    if (job?.status !== 'RUNNING' || job.claim_token !== input.claimToken || job.aggregate_id !== input.versionId || job.job_type !== 'document.malware_scan' || job.aggregate_type !== 'document_version') throw new DomainInvariantError('INVALID_JOB_STATE', 'Malware scan job is not running for this version and claim');
    const version = await transaction.selectFrom('document_versions').select('malware_scan_status').where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).forUpdate().executeTakeFirst();
    if (version?.malware_scan_status !== 'PENDING_SCAN') throw new DomainInvariantError('INVALID_SCAN_STATE', 'Document version is not pending malware scan');
    const scannedAt = input.scannedAt ?? await databaseTimestamp(transaction, 'Malware scan');
    await transaction.insertInto('malware_scans').values({ id: input.scanId, institution_id: input.institutionId, document_version_id: input.versionId, engine: input.engine, ...(input.engineVersion === undefined ? {} : { engine_version: input.engineVersion }), ...(input.signatureVersion === undefined ? {} : { signature_version: input.signatureVersion }), result: input.result, scanned_at: scannedAt, created_at: scannedAt }).execute();
    if (input.result === 'INFECTED') {
      await transaction.updateTable('document_versions').set({ malware_scan_status: 'INFECTED' }).where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).execute();
      await transaction.updateTable('document_versions').set({ malware_scan_status: 'QUARANTINED' }).where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).execute();
    } else {
      await transaction.updateTable('document_versions').set({ malware_scan_status: input.result }).where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).execute();
    }
    await transaction.updateTable('integration_jobs').set(input.result === 'SCAN_FAILED' ? { status: 'FAILED', last_error: input.error ?? 'Malware scan failed', lease_expires_at: null, claim_token: null, updated_at: scannedAt } : { status: 'SUCCEEDED', lease_expires_at: null, claim_token: null, updated_at: scannedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.jobId).where('status', '=', 'RUNNING').where('claim_token', '=', input.claimToken).executeTakeFirstOrThrow();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, eventType: input.result === 'CLEAN' ? 'document.malware_clean' : input.result === 'INFECTED' ? 'document.malware_infected' : 'document.malware_scan_failed', aggregateType: 'document_version', aggregateId: input.versionId, correlationId: input.correlationId, eventData: { result: input.result, scanId: input.scanId } });
  });
}

export async function prepareMalwareRetryAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly jobId: string; readonly versionId: string; readonly nextAttemptAt: Date; readonly actorUserId?: string; readonly correlationId: string }): Promise<void> {
  await withTenantTransaction(database, input.institutionId, async (transaction) => {
    const job = await transaction.selectFrom('integration_jobs').select(['status', 'aggregate_id', 'job_type', 'aggregate_type']).where('institution_id', '=', input.institutionId).where('id', '=', input.jobId).forUpdate().executeTakeFirst();
    const version = await transaction.selectFrom('document_versions').select('malware_scan_status').where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).forUpdate().executeTakeFirst();
    if (job?.status !== 'FAILED' || job.aggregate_id !== input.versionId || job.job_type !== 'document.malware_scan' || job.aggregate_type !== 'document_version' || version?.malware_scan_status !== 'SCAN_FAILED') throw new DomainInvariantError('INVALID_SCAN_STATE', 'Only a failed malware scan may be retried');
    await transaction.updateTable('document_versions').set({ malware_scan_status: 'PENDING_SCAN' }).where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).execute();
    await transaction.updateTable('integration_jobs').set({ status: 'PENDING', next_attempt_at: input.nextAttemptAt, lease_expires_at: null, claim_token: null, updated_at: await databaseTimestamp(transaction, 'Retry') }).where('institution_id', '=', input.institutionId).where('id', '=', input.jobId).execute();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'document.malware_scan_retry_scheduled', aggregateType: 'document_version', aggregateId: input.versionId, correlationId: input.correlationId, eventData: { jobId: input.jobId, nextAttemptAt: input.nextAttemptAt.toISOString() } });
  });
}

export async function claimMalwareScanJobs(database: Database, institutionId: InstitutionId | string, limit: number, now: Date = new Date(), leaseSeconds = 300): Promise<readonly Selectable<IntegrationJobsTable>[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainInvariantError('INVALID_JOB_BATCH', 'Job claim limit must be between 1 and 100');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 86_400) throw new DomainInvariantError('INVALID_JOB_LEASE', 'Job lease must be between 1 and 86400 seconds');
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
  return withTenantTransaction(database, institutionId, async (transaction) => {
    const result = await sql<Selectable<IntegrationJobsTable>>`
      WITH due AS (
        SELECT id FROM integration_jobs
        WHERE institution_id = ${institutionId}
          AND job_type = 'document.malware_scan'
          AND ((status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}))
            OR (status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ${now}))
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE integration_jobs AS jobs
      SET status = 'RUNNING', attempt_count = jobs.attempt_count + 1,
          next_attempt_at = NULL,
          lease_expires_at = ${leaseExpiresAt},
          claim_token = md5(random()::text || clock_timestamp()::text || jobs.id::text),
          updated_at = clock_timestamp()
      FROM due
      WHERE jobs.id = due.id AND jobs.institution_id = ${institutionId}
      RETURNING jobs.*
    `.execute(transaction);
    return result.rows;
  });
}

export interface MalwareScanTarget {
  readonly storageKey: string;
  readonly status: DocumentVersionsTable['malware_scan_status'];
  readonly sha256: string;
  readonly sizeBytes: string;
}

/** Loads the authoritative scan target after a job has been claimed. Payloads are hints only. */
export async function findMalwareScanTarget(database: Database, input: { readonly institutionId: InstitutionId | string; readonly jobId: string; readonly claimToken: string; readonly versionId: string }): Promise<MalwareScanTarget | undefined> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const row = await transaction.selectFrom('integration_jobs as j').innerJoin('document_versions as v', (join) => join.onRef('v.id', '=', 'j.aggregate_id').onRef('v.institution_id', '=', 'j.institution_id')).select(['v.storage_key as storageKey', 'v.malware_scan_status as status', 'v.sha256', 'v.size_bytes as sizeBytes']).where('j.institution_id', '=', input.institutionId).where('j.id', '=', input.jobId).where('j.claim_token', '=', input.claimToken).where('j.status', '=', 'RUNNING').where('j.job_type', '=', 'document.malware_scan').where('j.aggregate_type', '=', 'document_version').where('j.aggregate_id', '=', input.versionId).executeTakeFirst();
    return row;
  });
}

export async function publishExpedienteTypeVersionAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly versionId: string; readonly actorUserId?: string; readonly correlationId: string; readonly publishedAt: Date }, validateSchemaDefinition: (schema: JsonObject) => void): Promise<void> {
  await withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'expediente_type_version.published', aggregateType: 'expediente_type_version', aggregateId: input.versionId, correlationId: input.correlationId, afterData: { status: 'PUBLISHED', publishedAt: input.publishedAt.toISOString() } }, async (transaction) => {
    const draft = await transaction.selectFrom('expediente_type_versions').select(['status', 'schema_json', 'archival_mapping_json']).where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).forUpdate().executeTakeFirst();
    if (draft === undefined) throw new Error('Expediente type version not found');
    if (draft.status !== 'DRAFT') throw new DomainInvariantError('VERSION_NOT_DRAFT', 'Only a draft version may be published');
    validateSchemaDefinition(draft.schema_json);
    assertValidArchivalMapping(draft.archival_mapping_json);
    await transaction.updateTable('expediente_type_versions').set({ status: 'PUBLISHED', published_at: input.publishedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).execute();
  });
}

export async function approveTransferManifestAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly manifestId: string; readonly actorUserId: string; readonly correlationId: string; readonly sha256: string; readonly approvedAt: Date }): Promise<void> {
  const normalizedSha256 = input.sha256.toLowerCase();
  await withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'transfer_manifest.approved', aggregateType: 'transfer_manifest', aggregateId: input.manifestId, correlationId: input.correlationId, afterData: { status: 'APPROVED', sha256: normalizedSha256 } }, async (transaction) => {
    const draft = await transaction.selectFrom('transfer_manifests').select(['status', 'canonical_json']).where('institution_id', '=', input.institutionId).where('id', '=', input.manifestId).forUpdate().executeTakeFirst();
    if (draft === undefined) throw new Error('Transfer manifest not found');
    if (draft.status !== 'DRAFT') throw new DomainInvariantError('MANIFEST_IMMUTABLE', 'Only a draft manifest may be approved');
    if (canonicalManifestSha256(draft.canonical_json) !== normalizedSha256) throw new DomainInvariantError('MANIFEST_HASH_MISMATCH', 'Manifest SHA-256 must match the canonical JSON bytes');
    await transaction.updateTable('transfer_manifests').set({ status: 'APPROVED', sha256: normalizedSha256, approved_by: input.actorUserId, approved_at: input.approvedAt, updated_at: input.approvedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.manifestId).execute();
  });
}

export async function approveTransferAndManifestAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly transferId: string; readonly manifestId: string; readonly actorUserId: string; readonly correlationId: string; readonly sha256: string; readonly approvedAt: Date }): Promise<void> {
  const normalizedSha256 = input.sha256.toLowerCase();
  await withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'archive_transfer.approved', aggregateType: 'archive_transfer', aggregateId: input.transferId, correlationId: input.correlationId, afterData: { status: 'APPROVED', manifestId: input.manifestId } }, async (transaction) => {
    const transfer = await transaction.selectFrom('archive_transfers').select('status').where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).forUpdate().executeTakeFirst();
    if (transfer?.status !== 'DRAFT') throw new DomainInvariantError('INVALID_TRANSITION', 'Only a draft archive transfer may be approved');
    const manifest = await transaction.selectFrom('transfer_manifests').select(['status', 'canonical_json']).where('institution_id', '=', input.institutionId).where('id', '=', input.manifestId).where('transfer_id', '=', input.transferId).forUpdate().executeTakeFirst();
    if (manifest?.status !== 'DRAFT') throw new DomainInvariantError('MANIFEST_IMMUTABLE', 'Only a draft transfer manifest may be approved');
    if (canonicalManifestSha256(manifest.canonical_json) !== normalizedSha256) throw new DomainInvariantError('MANIFEST_HASH_MISMATCH', 'Manifest SHA-256 must match the canonical JSON bytes');
    await transaction.updateTable('transfer_manifests').set({ status: 'APPROVED', sha256: normalizedSha256, approved_by: input.actorUserId, approved_at: input.approvedAt, updated_at: input.approvedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.manifestId).execute();
    await transaction.updateTable('archive_transfers').set({ status: 'APPROVED', updated_at: input.approvedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).execute();
  });
}

export interface ArchiveTransferReadModel {
  readonly transfer: Selectable<ArchiveTransfersTable>;
  readonly manifest: Selectable<TransferManifestsTable>;
}

interface ManifestDocumentRow {
  readonly documentId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly filename: string;
  readonly sha256: string;
  readonly sizeBytes: string;
  readonly mimeType: string;
  readonly current: boolean;
  readonly createdAt: Date | string;
  readonly matterId: string | null;
  readonly expedienteId: string | null;
}

/**
 * The current ICI→AtoM boundary needs one explicit, stable mapping contract:
 * an expediente is represented by an AtoM File description. Additional
 * mapping vocabulary is intentionally deferred until the adapter contract is
 * introduced; unknown keys are rejected rather than silently ignored.
 */
export function isValidArchivalMapping(value: JsonObject): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'levelOfDescription' && value.levelOfDescription === 'File';
}

function assertValidArchivalMapping(value: JsonObject): void {
  if (!isValidArchivalMapping(value)) {
    throw new DomainInvariantError('INVALID_ARCHIVAL_MAPPING', 'Archival mapping must contain only levelOfDescription: File');
  }
}

function toCanonicalManifestDocument(document: ManifestDocumentRow): Record<string, unknown> {
  return {
    documentId: document.documentId,
    versionId: document.versionId,
    versionNumber: document.versionNumber,
    filename: document.filename,
    sha256: document.sha256,
    sizeBytes: document.sizeBytes,
    mimeType: document.mimeType,
    current: document.current,
  };
}

function compareCanonicalKeys(left: string, right: string): number {
  // Relational comparison is a locale-independent UTF-16 code-unit order.
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Serializes JSON with recursively sorted object keys and no locale/runtime ordering. */
export function canonicalManifestJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new DomainInvariantError('INVALID_CANONICAL_VALUE', 'Manifest contains a non-JSON value');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalManifestJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareCanonicalKeys(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalManifestJson(entry)}`).join(',')}}`;
  }
  throw new DomainInvariantError('INVALID_CANONICAL_VALUE', 'Manifest contains a non-JSON value');
}

/** Creates a closed-expediente transfer and its deterministic draft manifest atomically. */
export async function createArchiveTransferAndDraftManifestAtomically(database: Database, input: {
  readonly institutionId: InstitutionId | string;
  readonly expedienteId: string;
  readonly transferId: string;
  readonly manifestId: string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly authorizationContext: AuthorizationContext;
}): Promise<ArchiveTransferReadModel> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.authorizationContext.institutionId !== String(input.institutionId) || input.authorizationContext.userId !== input.actorUserId || !canPerform(input.authorizationContext, 'archive_transfer.prepare')) {
      throw new DomainInvariantError('NOT_AUTHORIZED', 'Transfer preparation is not authorized');
    }
    const expediente = await transaction.selectFrom('expedientes').select(['id', 'folio', 'status', 'metadata', 'closed_at', 'expediente_type_version_id', 'archival_parent_node_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteId).forUpdate().executeTakeFirst();
    if (expediente === undefined) throw new DomainInvariantError('EXPEDIENTE_NOT_FOUND', 'Expediente not found');
    if (expediente.status !== 'CLOSED') throw new DomainInvariantError('EXPEDIENTE_NOT_CLOSED', 'Only a closed expediente can be prepared for transfer');
    if (expediente.archival_parent_node_id === null) throw new DomainInvariantError('ARCHIVAL_PARENT_REQUIRED', 'An archival parent is required before transfer preparation');
    const archivalParent = await transaction.selectFrom('archival_classification_nodes').select(['id', 'node_type']).where('institution_id', '=', input.institutionId).where('id', '=', expediente.archival_parent_node_id).forShare().executeTakeFirst();
    if (archivalParent === undefined || (archivalParent.node_type !== 'SERIES' && archivalParent.node_type !== 'SUBSERIES')) throw new DomainInvariantError('ARCHIVAL_PARENT_INVALID', 'The archival parent must be a SERIES or SUBSERIES in the same institution');
    const typeVersion = await transaction.selectFrom('expediente_type_versions').select('archival_mapping_json').where('institution_id', '=', input.institutionId).where('id', '=', expediente.expediente_type_version_id).executeTakeFirst();
    if (typeVersion === undefined) throw new DomainInvariantError('TRANSFER_NOT_READY', 'The expediente archival mapping is not valid');
    assertValidArchivalMapping(typeVersion.archival_mapping_json);

    const documents = await transaction.selectFrom('documents as d').leftJoin('matters as m', (join) => join.onRef('m.institution_id', '=', 'd.institution_id').onRef('m.id', '=', 'd.matter_id')).select([
      'd.id as documentId', 'd.matter_id as matterId', 'd.expediente_id as expedienteId', 'd.current_version_id as currentVersionId', 'd.created_at as createdAt',
    ]).where('d.institution_id', '=', input.institutionId).where((expression) => expression.or([
      expression('d.expediente_id', '=', input.expedienteId),
      expression.and([expression('d.matter_id', 'is not', null), expression('m.linked_expediente_id', '=', input.expedienteId)]),
    ])).orderBy('d.created_at').orderBy('d.id').execute();
    const manifestDocuments: ManifestDocumentRow[] = [];
    for (const document of documents) {
      const versions = await transaction.selectFrom('document_versions').select(['id as versionId', 'version_number as versionNumber', 'original_filename as filename', 'sha256', 'size_bytes as sizeBytes', 'detected_mime_type as mimeType', 'malware_scan_status as malwareScanStatus', 'created_at as createdAt']).where('institution_id', '=', input.institutionId).where('document_id', '=', document.documentId).orderBy('version_number').execute();
      for (const version of versions) {
        if (version.malwareScanStatus !== 'CLEAN') throw new DomainInvariantError('DOCUMENTS_NOT_CLEAN', 'All manifest document versions must have a clean malware scan');
        manifestDocuments.push({ documentId: document.documentId, versionId: version.versionId, versionNumber: version.versionNumber, filename: version.filename, sha256: version.sha256, sizeBytes: String(version.sizeBytes), mimeType: version.mimeType, current: document.currentVersionId === version.versionId, createdAt: version.createdAt, matterId: document.matterId, expedienteId: document.expedienteId });
      }
    }
    const canonicalJson = canonicalManifestJson({ transferId: input.transferId, expedienteId: input.expedienteId, folio: expediente.folio, archivalParentNodeId: expediente.archival_parent_node_id, closedAt: expediente.closed_at === null ? null : new Date(expediente.closed_at).toISOString(), metadataSnapshot: expediente.metadata, documents: manifestDocuments.map(toCanonicalManifestDocument) });
    const createdAt = await databaseTimestamp(transaction, 'Archive transfer creation');
    await transaction.insertInto('archive_transfers').values({ id: input.transferId, institution_id: input.institutionId, expediente_id: input.expedienteId, status: 'DRAFT', created_by: input.actorUserId, created_at: createdAt, updated_at: createdAt }).execute();
    await transaction.insertInto('transfer_manifests').values({ id: input.manifestId, institution_id: input.institutionId, transfer_id: input.transferId, status: 'DRAFT', canonical_json: canonicalJson, created_at: createdAt, updated_at: createdAt }).execute();
    await transaction.updateTable('expedientes').set({ status: 'TRANSFER_PENDING', updated_at: createdAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteId).where('status', '=', 'CLOSED').execute();
    await transaction.insertInto('expediente_state_events').values({ institution_id: input.institutionId, expediente_id: input.expedienteId, from_status: 'CLOSED', to_status: 'TRANSFER_PENDING', command: 'prepareTransfer', actor_user_id: input.actorUserId, event_data: { archivalMappingValid: true, draftManifestReady: true, archivalParentNodeId: expediente.archival_parent_node_id, transferId: input.transferId, manifestId: input.manifestId }, occurred_at: createdAt }).execute();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'archive_transfer.created', aggregateType: 'archive_transfer', aggregateId: input.transferId, correlationId: input.correlationId, afterData: { status: 'DRAFT', expedienteId: input.expedienteId, manifestId: input.manifestId } });
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'transfer_manifest.created', aggregateType: 'transfer_manifest', aggregateId: input.manifestId, correlationId: input.correlationId, afterData: { status: 'DRAFT', transferId: input.transferId } });
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'expediente.transfer_prepared', aggregateType: 'expediente', aggregateId: input.expedienteId, correlationId: input.correlationId, beforeData: { status: 'CLOSED' }, afterData: { status: 'TRANSFER_PENDING' }, eventData: { archivalParentNodeId: expediente.archival_parent_node_id, transferId: input.transferId, manifestId: input.manifestId } });
    return { transfer: await transaction.selectFrom('archive_transfers').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).executeTakeFirstOrThrow(), manifest: await transaction.selectFrom('transfer_manifests').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.manifestId).executeTakeFirstOrThrow() };
  });
}

/** Approves a draft transfer and freezes its canonical manifest in one transaction. */
export async function approveArchiveTransferManifestAtomically(database: Database, input: {
  readonly institutionId: InstitutionId | string;
  readonly transferId: string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly authorizationContext: AuthorizationContext;
}): Promise<ArchiveTransferReadModel> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.authorizationContext.institutionId !== String(input.institutionId) || input.authorizationContext.userId !== input.actorUserId || !canPerform(input.authorizationContext, 'archive_transfer.approve')) {
      throw new DomainInvariantError('NOT_AUTHORIZED', 'Transfer approval is not authorized');
    }
    const transfer = await transaction.selectFrom('archive_transfers').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).forUpdate().executeTakeFirst();
    if (transfer === undefined) throw new DomainInvariantError('TRANSFER_NOT_FOUND', 'Archive transfer not found');
    if (transfer.status !== 'DRAFT') throw new DomainInvariantError('INVALID_TRANSITION', 'Only a draft transfer may be approved');
    const expediente = await transaction.selectFrom('expedientes').select(['status']).where('institution_id', '=', input.institutionId).where('id', '=', transfer.expediente_id).forUpdate().executeTakeFirst();
    if (expediente?.status !== 'TRANSFER_PENDING') throw new DomainInvariantError('EXPEDIENTE_NOT_TRANSFER_PENDING', 'Only a transfer-pending expediente may have an approved transfer');
    const manifest = await transaction.selectFrom('transfer_manifests').selectAll().where('institution_id', '=', input.institutionId).where('transfer_id', '=', input.transferId).forUpdate().executeTakeFirst();
    if (manifest === undefined) throw new DomainInvariantError('MANIFEST_NOT_FOUND', 'Transfer manifest not found');
    if (manifest.status !== 'DRAFT') throw new DomainInvariantError('MANIFEST_IMMUTABLE', 'Only a draft transfer manifest may be approved');
    const sha256 = canonicalManifestSha256(manifest.canonical_json);
    const approvedAt = await databaseTimestamp(transaction, 'Transfer approval');
    await transaction.updateTable('transfer_manifests').set({ status: 'APPROVED', sha256, approved_by: input.actorUserId, approved_at: approvedAt, updated_at: approvedAt }).where('institution_id', '=', input.institutionId).where('id', '=', manifest.id).execute();
    await transaction.updateTable('archive_transfers').set({ status: 'APPROVED', updated_at: approvedAt }).where('institution_id', '=', input.institutionId).where('id', '=', transfer.id).execute();
    await transaction.insertInto('integration_jobs').values({ institution_id: input.institutionId, job_type: 'archive_transfer.preserve', aggregate_type: 'archive_transfer', aggregate_id: transfer.id, status: 'PENDING', idempotency_key: `archive-transfer-preserve:${transfer.id}`, correlation_id: input.correlationId, attempt_count: 0, payload: { transferId: transfer.id, expedienteId: transfer.expediente_id, manifestId: manifest.id, manifestSha256: sha256 } }).execute();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'transfer_manifest.approved', aggregateType: 'transfer_manifest', aggregateId: manifest.id, correlationId: input.correlationId, beforeData: { status: 'DRAFT' }, afterData: { status: 'APPROVED', sha256 }, eventData: { transferId: transfer.id } });
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'archive_transfer.approved', aggregateType: 'archive_transfer', aggregateId: transfer.id, correlationId: input.correlationId, beforeData: { status: 'DRAFT' }, afterData: { status: 'APPROVED', manifestId: manifest.id } });
    return { transfer: await transaction.selectFrom('archive_transfers').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', transfer.id).executeTakeFirstOrThrow(), manifest: await transaction.selectFrom('transfer_manifests').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', manifest.id).executeTakeFirstOrThrow() };
  });
}

export async function findArchiveTransferWithManifest(database: Database, input: { readonly institutionId: InstitutionId | string; readonly transferId: string }): Promise<ArchiveTransferReadModel | undefined> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const transfer = await transaction.selectFrom('archive_transfers').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).executeTakeFirst();
    if (transfer === undefined) return undefined;
    const manifest = await transaction.selectFrom('transfer_manifests').selectAll().where('institution_id', '=', input.institutionId).where('transfer_id', '=', input.transferId).executeTakeFirst();
    if (manifest === undefined) return undefined;
    return { transfer, manifest };
  });
}

export const atomObjectTypes = {
  archivalClassificationNode: 'ARCHIVAL_CLASSIFICATION_NODE',
  expediente: 'EXPEDIENTE',
} as const;

export interface ArchivalClassificationPathRecord {
  readonly id: string;
  readonly institutionId: string;
  readonly parentId: string | null;
  readonly nodeType: ArchivalClassificationNodesTable['node_type'];
  readonly code: string;
  readonly name: string;
}

function expectedArchivalParentType(nodeType: ArchivalClassificationNodesTable['node_type']): ArchivalClassificationNodesTable['node_type'] | null {
  switch (nodeType) {
    case 'FONDS': return null;
    case 'SECTION': return 'FONDS';
    case 'SERIES': return 'SECTION';
    case 'SUBSERIES': return 'SERIES';
  }
}

/** Loads and validates a tenant-scoped classification path without issuing
 * any vendor calls. The result is root-first and rejects malformed chains. */
export async function loadArchivalClassificationPath(database: Database, input: { readonly institutionId: InstitutionId | string; readonly targetNodeId: string }): Promise<readonly ArchivalClassificationPathRecord[]> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const reverse: ArchivalClassificationPathRecord[] = [];
    const visited = new Set<string>();
    let nodeId: string | null = input.targetNodeId;
    while (nodeId !== null) {
      if (visited.has(nodeId)) throw new DomainInvariantError('ARCHIVAL_HIERARCHY_INVALID', 'The archival classification hierarchy contains a cycle');
      visited.add(nodeId);
      const row = await transaction.selectFrom('archival_classification_nodes').select(['id', 'institution_id', 'parent_id', 'node_type', 'code', 'name']).where('institution_id', '=', input.institutionId).where('id', '=', nodeId).forShare().executeTakeFirst();
      if (row === undefined) throw new DomainInvariantError('ARCHIVAL_NODE_NOT_FOUND', 'Archival classification node not found');
      const expectedParentType = expectedArchivalParentType(row.node_type);
      if (expectedParentType === null) {
        if (row.parent_id !== null) throw new DomainInvariantError('ARCHIVAL_HIERARCHY_INVALID', 'A Fonds node must be a root node');
      } else if (row.parent_id === null) {
        throw new DomainInvariantError('ARCHIVAL_HIERARCHY_INVALID', `${row.node_type} must have a ${expectedParentType} parent`);
      }
      reverse.push({ id: row.id, institutionId: row.institution_id, parentId: row.parent_id, nodeType: row.node_type, code: row.code, name: row.name });
      nodeId = row.parent_id;
      if (nodeId !== null) {
        const parent = await transaction.selectFrom('archival_classification_nodes').select('node_type').where('institution_id', '=', input.institutionId).where('id', '=', nodeId).forShare().executeTakeFirst();
        if (parent === undefined || parent.node_type !== expectedParentType) throw new DomainInvariantError('ARCHIVAL_HIERARCHY_INVALID', `${row.node_type} has an invalid parent type`);
      }
    }
    return reverse.reverse();
  });
}

export interface AtomMappingPersistenceRecord {
  readonly institutionId: string;
  readonly iciObjectType: 'ARCHIVAL_CLASSIFICATION_NODE' | 'EXPEDIENTE';
  readonly iciObjectId: string;
  readonly atomInformationObjectId: string | null;
  readonly atomSlug: string | null;
  readonly syncStatus: 'PENDING' | 'SYNCED' | 'FAILED';
}

function toAtomMappingRecord(row: Selectable<AtomMappingsTable>): AtomMappingPersistenceRecord {
  return {
    institutionId: row.institution_id,
    iciObjectType: row.ici_object_type as AtomMappingPersistenceRecord['iciObjectType'],
    iciObjectId: row.ici_object_id,
    atomInformationObjectId: row.atom_information_object_id,
    atomSlug: row.atom_slug,
    syncStatus: row.sync_status,
  };
}

/** Reads an external mapping in a short tenant-scoped transaction. */
export async function findAtomMapping(database: Database, input: { readonly institutionId: InstitutionId | string; readonly iciObjectType: AtomMappingPersistenceRecord['iciObjectType']; readonly iciObjectId: string }): Promise<AtomMappingPersistenceRecord | undefined> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const row = await transaction.selectFrom('atom_mappings').selectAll().where('institution_id', '=', input.institutionId).where('ici_object_type', '=', input.iciObjectType).where('ici_object_id', '=', input.iciObjectId).executeTakeFirst();
    return row === undefined ? undefined : toAtomMappingRecord(row);
  });
}

/** Reserves the local identity before making a remote POST. A caller that did
 * not create the row must reconcile the previous attempt instead of posting
 * again, which closes the remote-create/local-commit crash window. */
export async function reserveAtomMapping(database: Database, input: { readonly institutionId: InstitutionId | string; readonly iciObjectType: AtomMappingPersistenceRecord['iciObjectType']; readonly iciObjectId: string }): Promise<{ readonly record: AtomMappingPersistenceRecord; readonly reserved: boolean }> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const now = await databaseTimestamp(transaction, 'AtoM mapping reservation');
    const inserted = await transaction.insertInto('atom_mappings').values({ institution_id: input.institutionId, ici_object_type: input.iciObjectType, ici_object_id: input.iciObjectId, atom_information_object_id: null, atom_slug: null, sync_status: 'PENDING', last_synced_at: null, created_at: now, updated_at: now }).onConflict((oc) => oc.columns(['institution_id', 'ici_object_type', 'ici_object_id']).doNothing()).executeTakeFirst();
    const row = await transaction.selectFrom('atom_mappings').selectAll().where('institution_id', '=', input.institutionId).where('ici_object_type', '=', input.iciObjectType).where('ici_object_id', '=', input.iciObjectId).executeTakeFirstOrThrow();
    return { record: toAtomMappingRecord(row), reserved: inserted.numInsertedOrUpdatedRows === 1n };
  });
}

/** Upserts only validated external identity; it never clears an existing identity. */
export async function saveAtomMapping(database: Database, input: {
  readonly institutionId: InstitutionId | string;
  readonly iciObjectType: AtomMappingPersistenceRecord['iciObjectType'];
  readonly iciObjectId: string;
  readonly atomInformationObjectId: string;
  readonly atomSlug: string;
  readonly syncStatus: 'SYNCED' | 'FAILED';
}): Promise<AtomMappingPersistenceRecord> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const syncedAt = await databaseTimestamp(transaction, 'AtoM mapping persistence');
    const existing = await transaction.selectFrom('atom_mappings').selectAll().where('institution_id', '=', input.institutionId).where('ici_object_type', '=', input.iciObjectType).where('ici_object_id', '=', input.iciObjectId).forUpdate().executeTakeFirst();
    if (existing !== undefined && existing.atom_information_object_id !== null && (existing.atom_information_object_id !== input.atomInformationObjectId || existing.atom_slug !== input.atomSlug)) throw new DomainInvariantError('ATOM_MAPPING_CONFLICT', 'An ICI object already points to a different AtoM description');
    const lastSyncedAt = input.syncStatus === 'SYNCED' ? syncedAt : existing?.last_synced_at ?? null;
    await transaction.insertInto('atom_mappings').values({ institution_id: input.institutionId, ici_object_type: input.iciObjectType, ici_object_id: input.iciObjectId, atom_information_object_id: input.atomInformationObjectId, atom_slug: input.atomSlug, sync_status: input.syncStatus, last_synced_at: lastSyncedAt, created_at: syncedAt, updated_at: syncedAt }).onConflict((oc) => oc.columns(['institution_id', 'ici_object_type', 'ici_object_id']).doUpdateSet(({ eb }) => ({ atom_information_object_id: eb.ref('excluded.atom_information_object_id'), atom_slug: eb.ref('excluded.atom_slug'), sync_status: eb.ref('excluded.sync_status'), last_synced_at: eb.ref('excluded.last_synced_at'), updated_at: eb.ref('excluded.updated_at') }))).execute();
    const row = await transaction.selectFrom('atom_mappings').selectAll().where('institution_id', '=', input.institutionId).where('ici_object_type', '=', input.iciObjectType).where('ici_object_id', '=', input.iciObjectId).executeTakeFirstOrThrow();
    return toAtomMappingRecord(row);
  });
}

/** Records a retryable sync failure without erasing a previously validated
 * external identity. */
export async function markAtomMappingFailed(database: Database, input: { readonly institutionId: InstitutionId | string; readonly iciObjectType: AtomMappingPersistenceRecord['iciObjectType']; readonly iciObjectId: string }): Promise<AtomMappingPersistenceRecord> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const changedAt = await databaseTimestamp(transaction, 'AtoM mapping failure');
    const existing = await transaction.selectFrom('atom_mappings').selectAll().where('institution_id', '=', input.institutionId).where('ici_object_type', '=', input.iciObjectType).where('ici_object_id', '=', input.iciObjectId).forUpdate().executeTakeFirst();
    if (existing === undefined) {
      await transaction.insertInto('atom_mappings').values({ institution_id: input.institutionId, ici_object_type: input.iciObjectType, ici_object_id: input.iciObjectId, atom_information_object_id: null, atom_slug: null, sync_status: 'FAILED', last_synced_at: null, created_at: changedAt, updated_at: changedAt }).execute();
    } else {
      await transaction.updateTable('atom_mappings').set({ sync_status: 'FAILED', updated_at: changedAt }).where('institution_id', '=', input.institutionId).where('id', '=', existing.id).execute();
    }
    return toAtomMappingRecord(await transaction.selectFrom('atom_mappings').selectAll().where('institution_id', '=', input.institutionId).where('ici_object_type', '=', input.iciObjectType).where('ici_object_id', '=', input.iciObjectId).executeTakeFirstOrThrow());
  });
}

/** Structural adapter for @ici/integration-atom; network calls remain outside
 * database transactions and this object keeps all reads tenant-scoped. */
export function createAtomMappingStore(database: Database): {
  readonly find: (input: { readonly institutionId: InstitutionId | string; readonly iciObjectType: AtomMappingPersistenceRecord['iciObjectType']; readonly iciObjectId: string }) => Promise<AtomMappingPersistenceRecord | undefined>;
  readonly reserve: (input: { readonly institutionId: InstitutionId | string; readonly iciObjectType: AtomMappingPersistenceRecord['iciObjectType']; readonly iciObjectId: string }) => Promise<{ readonly record: AtomMappingPersistenceRecord; readonly reserved: boolean }>;
  readonly save: (input: { readonly institutionId: InstitutionId | string; readonly iciObjectType: AtomMappingPersistenceRecord['iciObjectType']; readonly iciObjectId: string; readonly atomInformationObjectId: string; readonly atomSlug: string; readonly syncStatus: 'SYNCED' | 'FAILED' }) => Promise<AtomMappingPersistenceRecord>;
  readonly markFailed: (input: { readonly institutionId: InstitutionId | string; readonly iciObjectType: AtomMappingPersistenceRecord['iciObjectType']; readonly iciObjectId: string }) => Promise<AtomMappingPersistenceRecord>;
} {
  return {
    find: (input) => findAtomMapping(database, input),
    reserve: (input) => reserveAtomMapping(database, input),
    save: (input) => saveAtomMapping(database, input),
    markFailed: (input) => markAtomMappingFailed(database, input),
  };
}

export interface ArchivematicaTransferPersistenceRecord {
  readonly institutionId: string;
  readonly archiveTransferId: string;
  readonly submissionStatus: 'PENDING' | 'SUBMITTED' | 'RECONCILIATION_REQUIRED' | 'FAILED';
  readonly archivematicaTransferUuid: string | null;
  readonly sipUuid: string | null;
  readonly aipUuid: string | null;
  readonly dipUuid: string | null;
  readonly processingConfiguration: string;
  readonly transferSourceLocationUuid: string;
  readonly transferSourceRelativePath: string;
  readonly lastRemoteStatus: string | null;
  readonly lastIngestStatus: string | null;
  readonly lastCheckedAt: Date | null;
}

function toArchivematicaRecord(row: Selectable<ArchivematicaTransfersTable>): ArchivematicaTransferPersistenceRecord {
  return {
    institutionId: row.institution_id,
    archiveTransferId: row.archive_transfer_id,
    submissionStatus: row.submission_status,
    archivematicaTransferUuid: row.archivematica_transfer_uuid,
    sipUuid: row.sip_uuid,
    aipUuid: row.aip_uuid,
    dipUuid: row.dip_uuid,
    processingConfiguration: row.processing_configuration,
    transferSourceLocationUuid: row.transfer_source_location_uuid,
    transferSourceRelativePath: row.transfer_source_relative_path,
    lastRemoteStatus: row.last_remote_status,
    lastIngestStatus: row.last_ingest_status,
    lastCheckedAt: row.last_checked_at,
  };
}

export async function findArchivematicaTransfer(database: Database, input: { readonly institutionId: InstitutionId | string; readonly archiveTransferId: string }): Promise<ArchivematicaTransferPersistenceRecord | undefined> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const row = await transaction.selectFrom('archivematica_transfers').selectAll().where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirst();
    return row === undefined ? undefined : toArchivematicaRecord(row);
  });
}

export async function reserveArchivematicaTransfer(database: Database, input: {
  readonly institutionId: InstitutionId | string;
  readonly archiveTransferId: string;
  readonly processingConfiguration: string;
  readonly transferSourceLocationUuid: string;
  readonly transferSourceRelativePath: string;
}): Promise<{ readonly record: ArchivematicaTransferPersistenceRecord; readonly reserved: boolean }> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const now = await databaseTimestamp(transaction, 'Archivematica submission reservation');
    const inserted = await transaction.insertInto('archivematica_transfers').values({
      institution_id: input.institutionId,
      archive_transfer_id: input.archiveTransferId,
      submission_status: 'PENDING',
      archivematica_transfer_uuid: null,
      sip_uuid: null,
      aip_uuid: null,
      dip_uuid: null,
      processing_configuration: input.processingConfiguration,
      transfer_source_location_uuid: input.transferSourceLocationUuid,
      transfer_source_relative_path: input.transferSourceRelativePath,
      last_remote_status: null,
      last_ingest_status: null,
      last_checked_at: null,
      created_at: now,
      updated_at: now,
    }).onConflict((oc) => oc.columns(['institution_id', 'archive_transfer_id']).doNothing()).executeTakeFirst();
    const row = await transaction.selectFrom('archivematica_transfers').selectAll().where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirstOrThrow();
    return { record: toArchivematicaRecord(row), reserved: inserted.numInsertedOrUpdatedRows === 1n };
  });
}

export async function saveArchivematicaSubmission(database: Database, input: {
  readonly institutionId: InstitutionId | string;
  readonly archiveTransferId: string;
  readonly archivematicaTransferUuid: string;
}): Promise<ArchivematicaTransferPersistenceRecord> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const now = await databaseTimestamp(transaction, 'Archivematica submission');
    const existing = await transaction.selectFrom('archivematica_transfers').selectAll().where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).forUpdate().executeTakeFirst();
    if (existing === undefined) throw new DomainInvariantError('ARCHIVEMATICA_RESERVATION_REQUIRED', 'Archivematica submission must be reserved before remote mutation');
    if (existing.archivematica_transfer_uuid !== null && existing.archivematica_transfer_uuid !== input.archivematicaTransferUuid) throw new DomainInvariantError('ARCHIVEMATICA_MAPPING_CONFLICT', 'A transfer already has a different Archivematica identity');
    await transaction.updateTable('archivematica_transfers').set({ submission_status: 'SUBMITTED', archivematica_transfer_uuid: input.archivematicaTransferUuid, updated_at: now }).where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirstOrThrow();
    return toArchivematicaRecord(await transaction.selectFrom('archivematica_transfers').selectAll().where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirstOrThrow());
  });
}

export async function markArchivematicaReconciliationRequired(database: Database, input: { readonly institutionId: InstitutionId | string; readonly archiveTransferId: string }): Promise<ArchivematicaTransferPersistenceRecord> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const now = await databaseTimestamp(transaction, 'Archivematica reconciliation');
    await transaction.updateTable('archivematica_transfers').set({ submission_status: 'RECONCILIATION_REQUIRED', updated_at: now }).where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirstOrThrow();
    return toArchivematicaRecord(await transaction.selectFrom('archivematica_transfers').selectAll().where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirstOrThrow());
  });
}

export async function saveArchivematicaObservation(database: Database, input: {
  readonly institutionId: InstitutionId | string;
  readonly archiveTransferId: string;
  readonly lastRemoteStatus?: string;
  readonly lastIngestStatus?: string;
  readonly sipUuid?: string;
  readonly aipUuid?: string;
  readonly dipUuid?: string;
}): Promise<ArchivematicaTransferPersistenceRecord> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const now = await databaseTimestamp(transaction, 'Archivematica observation');
    const existing = await transaction.selectFrom('archivematica_transfers').selectAll().where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).forUpdate().executeTakeFirst();
    if (existing === undefined) throw new DomainInvariantError('ARCHIVEMATICA_RESERVATION_REQUIRED', 'Archivematica transfer record was not found');
    const stableIdentities: readonly [string, string | null, string | undefined][] = [
      ['SIP', existing.sip_uuid, input.sipUuid],
      ['AIP', existing.aip_uuid, input.aipUuid],
      ['DIP', existing.dip_uuid, input.dipUuid],
    ];
    for (const [label, persisted, observed] of stableIdentities) {
      if (observed !== undefined && persisted !== null && persisted !== observed) {
        throw new DomainInvariantError('ARCHIVEMATICA_IDENTITY_CONFLICT', `${label} identity cannot be replaced once persisted`);
      }
    }
    const updates = {
      ...(input.lastRemoteStatus === undefined ? {} : { last_remote_status: input.lastRemoteStatus }),
      ...(input.lastIngestStatus === undefined ? {} : { last_ingest_status: input.lastIngestStatus }),
      ...(input.sipUuid === undefined ? {} : { sip_uuid: input.sipUuid }),
      ...(input.aipUuid === undefined ? {} : { aip_uuid: input.aipUuid }),
      ...(input.dipUuid === undefined ? {} : { dip_uuid: input.dipUuid }),
      last_checked_at: now,
      updated_at: now,
    };
    await transaction.updateTable('archivematica_transfers').set(updates).where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirstOrThrow();
    return toArchivematicaRecord(await transaction.selectFrom('archivematica_transfers').selectAll().where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirstOrThrow());
  });
}

export function createArchivematicaTransferStore(database: Database): {
  readonly find: (input: { readonly institutionId: InstitutionId | string; readonly archiveTransferId: string }) => Promise<ArchivematicaTransferPersistenceRecord | undefined>;
  readonly reserve: (input: { readonly institutionId: InstitutionId | string; readonly archiveTransferId: string; readonly processingConfiguration: string; readonly transferSourceLocationUuid: string; readonly transferSourceRelativePath: string }) => Promise<{ readonly record: ArchivematicaTransferPersistenceRecord; readonly reserved: boolean }>;
  readonly saveSubmission: (input: { readonly institutionId: InstitutionId | string; readonly archiveTransferId: string; readonly archivematicaTransferUuid: string }) => Promise<ArchivematicaTransferPersistenceRecord>;
  readonly markReconciliationRequired: (input: { readonly institutionId: InstitutionId | string; readonly archiveTransferId: string }) => Promise<ArchivematicaTransferPersistenceRecord>;
  readonly saveObservation: (input: { readonly institutionId: InstitutionId | string; readonly archiveTransferId: string; readonly lastRemoteStatus?: string; readonly lastIngestStatus?: string; readonly sipUuid?: string; readonly aipUuid?: string; readonly dipUuid?: string }) => Promise<ArchivematicaTransferPersistenceRecord>;
} {
  return {
    find: (input) => findArchivematicaTransfer(database, input),
    reserve: (input) => reserveArchivematicaTransfer(database, input),
    saveSubmission: (input) => saveArchivematicaSubmission(database, input),
    markReconciliationRequired: (input) => markArchivematicaReconciliationRequired(database, input),
    saveObservation: (input) => saveArchivematicaObservation(database, input),
  };
}

export interface PreservationStagingPersistenceRecord {
  readonly institutionId: string;
  readonly archiveTransferId: string;
  readonly locationUuid: string;
  readonly relativePath: string;
  readonly manifestSha256: string;
  readonly status: 'IN_PROGRESS' | 'STAGED' | 'RECONCILIATION_REQUIRED';
}

function toPreservationStagingRecord(row: Selectable<PreservationStagingRecordsTable>): PreservationStagingPersistenceRecord {
  return { institutionId: row.institution_id, archiveTransferId: row.archive_transfer_id, locationUuid: row.location_uuid, relativePath: row.relative_path, manifestSha256: row.manifest_sha256, status: row.status };
}

export async function findPreservationStaging(database: Database, input: { readonly institutionId: InstitutionId | string; readonly archiveTransferId: string }): Promise<PreservationStagingPersistenceRecord | undefined> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const row = await transaction.selectFrom('preservation_staging_records').selectAll().where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirst();
    return row === undefined ? undefined : toPreservationStagingRecord(row);
  });
}

export async function reservePreservationStaging(database: Database, input: { readonly institutionId: InstitutionId | string; readonly archiveTransferId: string; readonly locationUuid: string; readonly relativePath: string; readonly manifestSha256: string }): Promise<{ readonly record: PreservationStagingPersistenceRecord; readonly reserved: boolean }> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const now = await databaseTimestamp(transaction, 'Preservation staging reservation');
    const inserted = await transaction.insertInto('preservation_staging_records').values({ institution_id: input.institutionId, archive_transfer_id: input.archiveTransferId, location_uuid: input.locationUuid, relative_path: input.relativePath, manifest_sha256: input.manifestSha256, status: 'IN_PROGRESS', created_at: now, updated_at: now }).onConflict((oc) => oc.columns(['institution_id', 'archive_transfer_id']).doNothing()).executeTakeFirst();
    const row = await transaction.selectFrom('preservation_staging_records').selectAll().where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirstOrThrow();
    return { record: toPreservationStagingRecord(row), reserved: inserted.numInsertedOrUpdatedRows === 1n };
  });
}

export async function markPreservationStaged(database: Database, input: { readonly institutionId: InstitutionId | string; readonly archiveTransferId: string; readonly manifestSha256: string }): Promise<PreservationStagingPersistenceRecord> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const now = await databaseTimestamp(transaction, 'Preservation staging complete');
    await transaction.updateTable('preservation_staging_records').set({ status: 'STAGED', manifest_sha256: input.manifestSha256, updated_at: now }).where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).where('status', '=', 'IN_PROGRESS').where('manifest_sha256', '=', input.manifestSha256).executeTakeFirstOrThrow();
    return toPreservationStagingRecord(await transaction.selectFrom('preservation_staging_records').selectAll().where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirstOrThrow());
  });
}

export async function markPreservationStagingReconciliationRequired(database: Database, input: { readonly institutionId: InstitutionId | string; readonly archiveTransferId: string }): Promise<PreservationStagingPersistenceRecord> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const now = await databaseTimestamp(transaction, 'Preservation staging reconciliation');
    await transaction.updateTable('preservation_staging_records').set({ status: 'RECONCILIATION_REQUIRED', updated_at: now }).where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirstOrThrow();
    return toPreservationStagingRecord(await transaction.selectFrom('preservation_staging_records').selectAll().where('institution_id', '=', input.institutionId).where('archive_transfer_id', '=', input.archiveTransferId).executeTakeFirstOrThrow());
  });
}

export function createPreservationStagingStore(database: Database): {
  readonly find: (input: { readonly institutionId: string; readonly archiveTransferId: string }) => Promise<PreservationStagingPersistenceRecord | undefined>;
  readonly reserve: (input: { readonly institutionId: string; readonly archiveTransferId: string; readonly locationUuid: string; readonly relativePath: string; readonly manifestSha256: string }) => Promise<{ readonly record: PreservationStagingPersistenceRecord; readonly reserved: boolean }>;
  readonly markStaged: (input: { readonly institutionId: string; readonly archiveTransferId: string; readonly manifestSha256: string }) => Promise<PreservationStagingPersistenceRecord>;
  readonly markReconciliationRequired: (input: { readonly institutionId: string; readonly archiveTransferId: string }) => Promise<PreservationStagingPersistenceRecord>;
} {
  return { find: (input) => findPreservationStaging(database, input), reserve: (input) => reservePreservationStaging(database, input), markStaged: (input) => markPreservationStaged(database, input), markReconciliationRequired: (input) => markPreservationStagingReconciliationRequired(database, input) };
}

export interface PreservationPackageVersionRecord {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly storageKey: string;
  readonly filename: string;
  readonly sha256: string;
  readonly sizeBytes: string;
  readonly mimeType: string;
}

export interface ApprovedPreservationPackageContext {
  readonly institutionId: string;
  readonly transferId: string;
  readonly expedienteId: string;
  readonly manifestId: string;
  readonly manifestSha256: string;
  readonly canonicalManifestJson: string;
  readonly versions: readonly PreservationPackageVersionRecord[];
}

export async function loadApprovedPreservationPackageContext(database: Database, input: { readonly institutionId: InstitutionId | string; readonly transferId: string }): Promise<ApprovedPreservationPackageContext> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const transfer = await transaction.selectFrom('archive_transfers').select(['id', 'expediente_id', 'status']).where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).executeTakeFirst();
    if (transfer === undefined) throw new DomainInvariantError('TRANSFER_NOT_FOUND', 'Archive transfer not found');
    if (transfer.status !== 'PRESERVING') throw new DomainInvariantError('INVALID_TRANSITION', 'Only a preserving transfer can build a preservation package');
    const manifest = await loadApprovedArchiveManifest(transaction, input.institutionId, input.transferId);
    let parsed: unknown;
    try { parsed = JSON.parse(manifest.canonical_json) as unknown; } catch { throw new DomainInvariantError('MANIFEST_INVALID', 'Approved manifest JSON is invalid'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as Record<string, unknown>).documents)) throw new DomainInvariantError('MANIFEST_INVALID', 'Approved manifest documents are invalid');
    const entries = (parsed as Record<string, unknown>).documents as unknown[];
    const ids = entries.map((entry) => (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).versionId === 'string' ? (entry as Record<string, unknown>).versionId as string : undefined));
    if (ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) throw new DomainInvariantError('MANIFEST_INVALID', 'Approved manifest version identities are invalid');
    const versions = entries.length === 0 ? [] : await transaction.selectFrom('document_versions').select(['id', 'version_number', 'storage_key', 'original_filename', 'sha256', 'size_bytes', 'detected_mime_type', 'malware_scan_status']).where('institution_id', '=', input.institutionId).where('id', 'in', ids as string[]).execute();
    if (versions.length !== ids.length) throw new DomainInvariantError('DOCUMENT_VERSION_NOT_FOUND', 'An approved manifest document version is missing');
    const byId = new Map(versions.map((version) => [version.id, version]));
    for (const entry of entries) {
      const value = entry as Record<string, unknown>;
      const version = byId.get(value.versionId as string);
      if (version === undefined || value.versionNumber !== version.version_number || value.filename !== version.original_filename || value.sha256 !== version.sha256 || String(value.sizeBytes) !== String(version.size_bytes) || value.mimeType !== version.detected_mime_type) throw new DomainInvariantError('MANIFEST_INVALID', 'Approved manifest metadata diverges from the authoritative document version');
    }
    const ordered = ids.map((id) => byId.get(id!));
    if (ordered.some((version) => version === undefined || version.malware_scan_status !== 'CLEAN')) throw new DomainInvariantError('DOCUMENTS_NOT_CLEAN', 'All approved preservation versions must be CLEAN');
    return { institutionId: String(input.institutionId), transferId: transfer.id, expedienteId: transfer.expediente_id, manifestId: manifest.id, manifestSha256: manifest.sha256!, canonicalManifestJson: manifest.canonical_json, versions: ordered.map((version) => ({ versionId: version!.id, versionNumber: version!.version_number, storageKey: version!.storage_key, filename: version!.original_filename, sha256: version!.sha256, sizeBytes: String(version!.size_bytes), mimeType: version!.detected_mime_type })) };
  });
}

export function createArchivalClassificationPathLoader(database: Database): {
  readonly load: (input: { readonly institutionId: string; readonly targetNodeId: string }) => Promise<readonly ArchivalClassificationPathRecord[]>;
} {
  return { load: (input) => loadArchivalClassificationPath(database, input) };
}

export interface ApprovedExpedienteAtomSyncContext {
  readonly institutionId: string;
  readonly transferId: string;
  readonly expedienteId: string;
  readonly expedienteFolio: string;
  readonly archivalParentNodeId: string;
  readonly canonicalManifestJson: string;
  readonly manifestSha256: string;
}

/** Loads the approved manifest snapshot and its authoritative mapped parent.
 * No transaction is held while an external adapter performs network I/O. */
export async function loadApprovedExpedienteAtomSyncContext(database: Database, input: { readonly institutionId: InstitutionId | string; readonly transferId: string }): Promise<ApprovedExpedienteAtomSyncContext> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const transfer = await transaction.selectFrom('archive_transfers').select(['id', 'expediente_id', 'status']).where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).executeTakeFirst();
    if (transfer === undefined) throw new DomainInvariantError('TRANSFER_NOT_FOUND', 'Archive transfer not found');
    if (transfer.status !== 'APPROVED' && transfer.status !== 'SUBMITTED' && transfer.status !== 'PRESERVING') throw new DomainInvariantError('INVALID_TRANSITION', 'Only an approved or active transfer can be synchronized to AtoM');
    const manifest = await transaction.selectFrom('transfer_manifests').selectAll().where('institution_id', '=', input.institutionId).where('transfer_id', '=', input.transferId).executeTakeFirst();
    if (manifest === undefined || manifest.status !== 'APPROVED' || manifest.sha256 === null) throw new DomainInvariantError('MANIFEST_NOT_APPROVED', 'An approved manifest is required');
    if (canonicalManifestSha256(manifest.canonical_json) !== manifest.sha256.toLowerCase()) throw new DomainInvariantError('MANIFEST_HASH_MISMATCH', 'The approved manifest hash does not match its canonical JSON');
    let snapshot: unknown;
    try { snapshot = JSON.parse(manifest.canonical_json) as unknown; } catch { throw new DomainInvariantError('MANIFEST_INVALID', 'Approved manifest JSON is invalid'); }
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new DomainInvariantError('MANIFEST_INVALID', 'Approved manifest must be an object');
    const snapshotObject = snapshot as Record<string, unknown>;
    if (snapshotObject.expedienteId !== transfer.expediente_id || typeof snapshotObject.archivalParentNodeId !== 'string') throw new DomainInvariantError('MANIFEST_INVALID', 'Approved manifest does not contain the authoritative expediente parent snapshot');
    const expediente = await transaction.selectFrom('expedientes').select(['id', 'folio', 'status', 'archival_parent_node_id']).where('institution_id', '=', input.institutionId).where('id', '=', transfer.expediente_id).executeTakeFirst();
    if (expediente === undefined) throw new DomainInvariantError('EXPEDIENTE_NOT_FOUND', 'Expediente not found');
    if (expediente.status !== 'TRANSFER_PENDING' || expediente.archival_parent_node_id !== snapshotObject.archivalParentNodeId) throw new DomainInvariantError('MANIFEST_INVALID', 'The expediente parent no longer matches the approved manifest');
    const parent = await transaction.selectFrom('archival_classification_nodes').select(['id', 'node_type']).where('institution_id', '=', input.institutionId).where('id', '=', expediente.archival_parent_node_id).executeTakeFirst();
    if (parent === undefined || (parent.node_type !== 'SERIES' && parent.node_type !== 'SUBSERIES')) throw new DomainInvariantError('ARCHIVAL_PARENT_INVALID', 'The archival parent is not a valid Series or Subseries');
    const parentMapping = await transaction.selectFrom('atom_mappings').select(['sync_status', 'atom_information_object_id', 'atom_slug']).where('institution_id', '=', input.institutionId).where('ici_object_type', '=', atomObjectTypes.archivalClassificationNode).where('ici_object_id', '=', parent.id).executeTakeFirst();
    if (parentMapping?.sync_status !== 'SYNCED' || parentMapping.atom_information_object_id === null || parentMapping.atom_slug === null) throw new DomainInvariantError('ATOM_PARENT_MAPPING_REQUIRED', 'The archival parent must have a valid AtoM mapping before expediente synchronization');
    return { institutionId: String(input.institutionId), transferId: transfer.id, expedienteId: expediente.id, expedienteFolio: expediente.folio, archivalParentNodeId: parent.id, canonicalManifestJson: manifest.canonical_json, manifestSha256: manifest.sha256 };
  });
}

/** Structural adapter for the vendor package's approved-context loader. */
export function createApprovedExpedienteAtomSyncContextLoader(database: Database): {
  readonly load: (input: { readonly institutionId: string; readonly transferId: string }) => Promise<ApprovedExpedienteAtomSyncContext>;
} {
  return { load: (input) => loadApprovedExpedienteAtomSyncContext(database, input) };
}

const archivePreservationJobType = 'archive_transfer.preserve';
const archivePreservationAggregateType = 'archive_transfer';

async function loadApprovedArchiveManifest(transaction: DatabaseTransaction, institutionId: InstitutionId | string, transferId: string): Promise<Selectable<TransferManifestsTable>> {
  const manifest = await transaction.selectFrom('transfer_manifests').selectAll().where('institution_id', '=', institutionId).where('transfer_id', '=', transferId).forUpdate().executeTakeFirst();
  if (manifest === undefined || manifest.status !== 'APPROVED' || manifest.sha256 === null || manifest.approved_by === null || manifest.approved_at === null) throw new DomainInvariantError('MANIFEST_NOT_APPROVED', 'An approved immutable manifest is required');
  if (canonicalManifestSha256(manifest.canonical_json) !== manifest.sha256.toLowerCase()) throw new DomainInvariantError('MANIFEST_HASH_MISMATCH', 'The approved manifest hash does not match its canonical JSON');
  return manifest;
}

async function loadArchivePreservationJob(transaction: DatabaseTransaction, institutionId: InstitutionId | string, transferId: string, jobId: string, claimToken: string, requireRunning = true): Promise<Selectable<IntegrationJobsTable>> {
  const job = await transaction.selectFrom('integration_jobs').selectAll().where('institution_id', '=', institutionId).where('id', '=', jobId).forUpdate().executeTakeFirst();
  const now = new Date();
  if (job === undefined || job.job_type !== archivePreservationJobType || job.aggregate_type !== archivePreservationAggregateType || job.aggregate_id !== transferId || (requireRunning && job.status !== 'RUNNING') || job.claim_token !== claimToken || job.lease_expires_at === null || job.lease_expires_at <= now) throw new DomainInvariantError('INVALID_JOB_STATE', 'Archive preservation claim is invalid or expired');
  return job;
}

export async function claimArchiveTransferPreservationJobs(database: Database, institutionId: InstitutionId | string, limit: number, now = new Date(), leaseSeconds = 300): Promise<readonly Selectable<IntegrationJobsTable>[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainInvariantError('INVALID_JOB_BATCH', 'Job claim limit must be between 1 and 100');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 86_400) throw new DomainInvariantError('INVALID_JOB_LEASE', 'Job lease must be between 1 and 86400 seconds');
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
  return withTenantTransaction(database, institutionId, async (transaction) => {
    const candidates = await transaction.selectFrom('integration_jobs').selectAll().where('institution_id', '=', institutionId).where('job_type', '=', archivePreservationJobType).where('aggregate_type', '=', archivePreservationAggregateType).where((expression) => expression.or([
      expression.and([expression('status', '=', 'PENDING'), expression.or([expression('next_attempt_at', 'is', null), expression('next_attempt_at', '<=', now)])]),
      expression.and([expression('status', '=', 'RUNNING'), expression('lease_expires_at', 'is not', null), expression('lease_expires_at', '<=', now)]),
    ])).orderBy('created_at').orderBy('id').forUpdate().skipLocked().limit(limit).execute();
    const claimed: Selectable<IntegrationJobsTable>[] = [];
    for (const candidate of candidates) {
      const updated = await transaction.updateTable('integration_jobs').set({ status: 'RUNNING', attempt_count: candidate.attempt_count + 1, next_attempt_at: null, lease_expires_at: leaseExpiresAt, claim_token: randomUUID(), updated_at: await databaseTimestamp(transaction, 'Archive transfer claim') }).where('institution_id', '=', institutionId).where('id', '=', candidate.id).returningAll().executeTakeFirstOrThrow();
      claimed.push(updated);
    }
    return claimed;
  });
}

export async function beginArchiveTransferPreservationAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly transferId: string; readonly jobId: string; readonly claimToken: string; readonly correlationId: string }): Promise<void> {
  await withTenantTransaction(database, input.institutionId, async (transaction) => {
    const transfer = await transaction.selectFrom('archive_transfers').select(['status', 'expediente_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).forUpdate().executeTakeFirst();
    if (transfer?.status !== 'APPROVED' && transfer?.status !== 'SUBMITTED' && transfer?.status !== 'PRESERVING') throw new DomainInvariantError('INVALID_TRANSITION', 'Only an approved, submitted, or preserving transfer may begin preservation');
    await loadArchivePreservationJob(transaction, input.institutionId, input.transferId, input.jobId, input.claimToken);
    const expediente = await transaction.selectFrom('expedientes').select('status').where('institution_id', '=', input.institutionId).where('id', '=', transfer.expediente_id).forUpdate().executeTakeFirst();
    if (expediente?.status !== 'TRANSFER_PENDING') throw new DomainInvariantError('EXPEDIENTE_NOT_TRANSFER_PENDING', 'The expediente is not pending transfer');
    await loadApprovedArchiveManifest(transaction, String(input.institutionId), input.transferId);
    const occurredAt = await databaseTimestamp(transaction, 'Archive preservation start');
    if (transfer.status === 'APPROVED') {
      await transaction.updateTable('archive_transfers').set({ status: 'SUBMITTED', updated_at: occurredAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).execute();
      await appendAuditEvent(transaction, { institutionId: input.institutionId, eventType: 'archive_transfer.submitted', aggregateType: archivePreservationAggregateType, aggregateId: input.transferId, correlationId: input.correlationId, beforeData: { status: 'APPROVED' }, afterData: { status: 'SUBMITTED' }, eventData: { jobId: input.jobId, jobType: archivePreservationJobType } });
    }
    if (transfer.status !== 'PRESERVING') {
      await transaction.updateTable('archive_transfers').set({ status: 'PRESERVING', updated_at: occurredAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).execute();
      await appendAuditEvent(transaction, { institutionId: input.institutionId, eventType: 'archive_transfer.preserving', aggregateType: archivePreservationAggregateType, aggregateId: input.transferId, correlationId: input.correlationId, beforeData: { status: 'SUBMITTED' }, afterData: { status: 'PRESERVING' }, eventData: { jobId: input.jobId } });
    }
  });
}

export async function failArchiveTransferPreservationAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly transferId: string; readonly jobId: string; readonly claimToken: string; readonly reason: string; readonly correlationId: string }): Promise<void> {
  if (input.reason.trim().length === 0 || input.reason.length > 4000) throw new DomainInvariantError('INVALID_JOB_ERROR', 'Transfer failure reason must contain between 1 and 4000 characters');
  await withTenantTransaction(database, input.institutionId, async (transaction) => {
    const transfer = await transaction.selectFrom('archive_transfers').select(['status', 'expediente_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).forUpdate().executeTakeFirst();
    if (transfer === undefined) throw new DomainInvariantError('TRANSFER_NOT_FOUND', 'Archive transfer not found');
    if (transfer.status !== 'SUBMITTED' && transfer.status !== 'PRESERVING') throw new DomainInvariantError('INVALID_TRANSITION', 'Only submitted or preserving transfers may fail');
    await loadArchivePreservationJob(transaction, input.institutionId, input.transferId, input.jobId, input.claimToken);
    const expediente = await transaction.selectFrom('expedientes').select('status').where('institution_id', '=', input.institutionId).where('id', '=', transfer.expediente_id).forUpdate().executeTakeFirst();
    if (expediente?.status !== 'TRANSFER_PENDING') throw new DomainInvariantError('EXPEDIENTE_NOT_TRANSFER_PENDING', 'The expediente is not pending transfer');
    const failedAt = await databaseTimestamp(transaction, 'Archive preservation failure');
    await transaction.updateTable('archive_transfers').set({ status: 'FAILED', updated_at: failedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).execute();
    await transaction.updateTable('integration_jobs').set({ status: 'FAILED', last_error: input.reason, lease_expires_at: null, claim_token: null, updated_at: failedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.jobId).where('status', '=', 'RUNNING').where('claim_token', '=', input.claimToken).executeTakeFirstOrThrow();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, eventType: 'archive_transfer.failed', aggregateType: archivePreservationAggregateType, aggregateId: input.transferId, correlationId: input.correlationId, beforeData: { status: transfer.status }, afterData: { status: 'FAILED' }, eventData: { jobId: input.jobId, reason: input.reason } });
  });
}

export async function retryArchiveTransferAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly transferId: string; readonly actorUserId: string; readonly correlationId: string; readonly authorizationContext: AuthorizationContext }): Promise<ArchiveTransferReadModel> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.authorizationContext.institutionId !== String(input.institutionId) || input.authorizationContext.userId !== input.actorUserId || !canPerform(input.authorizationContext, 'archive_transfer.retry')) throw new DomainInvariantError('NOT_AUTHORIZED', 'Transfer retry is not authorized');
    const transfer = await transaction.selectFrom('archive_transfers').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).forUpdate().executeTakeFirst();
    if (transfer === undefined) throw new DomainInvariantError('TRANSFER_NOT_FOUND', 'Archive transfer not found');
    if (transfer.status !== 'FAILED') throw new DomainInvariantError('INVALID_TRANSITION', 'Only a failed transfer may be retried');
    const expediente = await transaction.selectFrom('expedientes').select('status').where('institution_id', '=', input.institutionId).where('id', '=', transfer.expediente_id).forUpdate().executeTakeFirst();
    if (expediente?.status !== 'TRANSFER_PENDING') throw new DomainInvariantError('EXPEDIENTE_NOT_TRANSFER_PENDING', 'The expediente is not pending transfer');
    await loadApprovedArchiveManifest(transaction, String(input.institutionId), input.transferId);
    const job = await transaction.selectFrom('integration_jobs').selectAll().where('institution_id', '=', input.institutionId).where('idempotency_key', '=', `archive-transfer-preserve:${input.transferId}`).forUpdate().executeTakeFirst();
    if (job?.status !== 'FAILED' || job.job_type !== archivePreservationJobType || job.aggregate_type !== archivePreservationAggregateType || job.aggregate_id !== input.transferId) throw new DomainInvariantError('INVALID_JOB_STATE', 'The transfer preservation intent cannot be retried');
    const retriedAt = await databaseTimestamp(transaction, 'Archive transfer retry');
    await transaction.updateTable('archive_transfers').set({ status: 'SUBMITTED', updated_at: retriedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).execute();
    await transaction.updateTable('integration_jobs').set({ status: 'PENDING', next_attempt_at: null, lease_expires_at: null, claim_token: null, last_error: null, updated_at: retriedAt }).where('institution_id', '=', input.institutionId).where('id', '=', job.id).execute();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'archive_transfer.retried', aggregateType: archivePreservationAggregateType, aggregateId: input.transferId, correlationId: input.correlationId, beforeData: { status: 'FAILED' }, afterData: { status: 'SUBMITTED' }, eventData: { jobId: job.id } });
    return { transfer: await transaction.selectFrom('archive_transfers').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).executeTakeFirstOrThrow(), manifest: await transaction.selectFrom('transfer_manifests').selectAll().where('institution_id', '=', input.institutionId).where('transfer_id', '=', input.transferId).executeTakeFirstOrThrow() };
  });
}

export async function completeArchiveTransferPreservationAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly transferId: string; readonly jobId: string; readonly claimToken: string; readonly correlationId: string; readonly approvedManifestPreserved: boolean; readonly aipStored: boolean; readonly archivalIntegrationCompleted: boolean }): Promise<void> {
  if (!input.approvedManifestPreserved || !input.aipStored || !input.archivalIntegrationCompleted) throw new DomainInvariantError('TRANSFER_NOT_COMPLETE', 'All preservation completion evidence is required');
  await withTenantTransaction(database, input.institutionId, async (transaction) => {
    const transfer = await transaction.selectFrom('archive_transfers').select(['status', 'expediente_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).forUpdate().executeTakeFirst();
    if (transfer?.status !== 'PRESERVING') throw new DomainInvariantError('INVALID_TRANSITION', 'Only a preserving transfer may complete');
    await loadArchivePreservationJob(transaction, input.institutionId, input.transferId, input.jobId, input.claimToken);
    const manifest = await loadApprovedArchiveManifest(transaction, String(input.institutionId), input.transferId);
    const expediente = await transaction.selectFrom('expedientes').select('status').where('institution_id', '=', input.institutionId).where('id', '=', transfer.expediente_id).forUpdate().executeTakeFirst();
    if (expediente?.status !== 'TRANSFER_PENDING') throw new DomainInvariantError('EXPEDIENTE_NOT_TRANSFER_PENDING', 'The expediente is not pending transfer');
    const completedAt = await databaseTimestamp(transaction, 'Archive transfer completion');
    await transaction.updateTable('archive_transfers').set({ status: 'COMPLETED', updated_at: completedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).execute();
    await transaction.updateTable('integration_jobs').set({ status: 'SUCCEEDED', lease_expires_at: null, claim_token: null, updated_at: completedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.jobId).where('status', '=', 'RUNNING').where('claim_token', '=', input.claimToken).executeTakeFirstOrThrow();
    await transaction.updateTable('expedientes').set({ status: 'TRANSFERRED', updated_at: completedAt }).where('institution_id', '=', input.institutionId).where('id', '=', transfer.expediente_id).where('status', '=', 'TRANSFER_PENDING').executeTakeFirstOrThrow();
    await transaction.insertInto('expediente_state_events').values({ institution_id: input.institutionId, expediente_id: transfer.expediente_id, from_status: 'TRANSFER_PENDING', to_status: 'TRANSFERRED', command: 'completeTransfer', actor_user_id: null, event_data: { approvedManifestPreserved: true, aipStored: true, archivalIntegrationCompleted: true, transferId: input.transferId, manifestId: manifest.id }, occurred_at: completedAt }).execute();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, eventType: 'archive_transfer.completed', aggregateType: archivePreservationAggregateType, aggregateId: input.transferId, correlationId: input.correlationId, beforeData: { status: 'PRESERVING' }, afterData: { status: 'COMPLETED' }, eventData: { jobId: input.jobId } });
    await appendAuditEvent(transaction, { institutionId: input.institutionId, eventType: 'expediente.transfer_completed', aggregateType: 'expediente', aggregateId: transfer.expediente_id, correlationId: input.correlationId, beforeData: { status: 'TRANSFER_PENDING' }, afterData: { status: 'TRANSFERRED' }, eventData: { approvedManifestPreserved: true, aipStored: true, archivalIntegrationCompleted: true, transferId: input.transferId, manifestId: manifest.id } });
  });
}

export async function cancelArchiveTransferAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly transferId: string; readonly actorUserId: string; readonly reason: string; readonly correlationId: string; readonly authorizationContext: AuthorizationContext }): Promise<ArchiveTransferReadModel> {
  if (input.reason.trim().length === 0 || input.reason.length > 4000) throw new DomainInvariantError('REASON_REQUIRED', 'Cancellation reason must contain between 1 and 4000 characters');
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    if (input.authorizationContext.institutionId !== String(input.institutionId) || input.authorizationContext.userId !== input.actorUserId || !canPerform(input.authorizationContext, 'archive_transfer.approve')) throw new DomainInvariantError('NOT_AUTHORIZED', 'Transfer cancellation is not authorized');
    const transfer = await transaction.selectFrom('archive_transfers').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).forUpdate().executeTakeFirst();
    if (transfer === undefined) throw new DomainInvariantError('TRANSFER_NOT_FOUND', 'Archive transfer not found');
    if (transfer.status !== 'DRAFT' && transfer.status !== 'APPROVED' && transfer.status !== 'SUBMITTED' && transfer.status !== 'FAILED') throw new DomainInvariantError('INVALID_TRANSITION', 'Transfer cannot be cancelled in its current state');
    const job = await transaction.selectFrom('integration_jobs').selectAll().where('institution_id', '=', input.institutionId).where('idempotency_key', '=', `archive-transfer-preserve:${input.transferId}`).forUpdate().executeTakeFirst();
    if ((transfer.status === 'SUBMITTED' || transfer.status === 'FAILED') && job === undefined) throw new DomainInvariantError('INVALID_JOB_STATE', 'A submitted transfer requires a durable preservation intent');
    if ((transfer.status === 'APPROVED' || transfer.status === 'SUBMITTED') && job?.status === 'RUNNING') throw new DomainInvariantError('CANCELLATION_NOT_SAFE', 'Claimed preservation work cannot be cancelled safely');
    if (transfer.status === 'SUBMITTED' && job?.status !== 'PENDING') throw new DomainInvariantError('CANCELLATION_NOT_SAFE', 'Claimed preservation work cannot be cancelled safely');
    if (transfer.status === 'FAILED' && job?.status !== 'FAILED') throw new DomainInvariantError('INVALID_JOB_STATE', 'The failed transfer intent is inconsistent');
    if (transfer.status === 'FAILED') {
      const preservationStarted = await transaction.selectFrom('audit_events').select('id').where('institution_id', '=', input.institutionId).where('aggregate_type', '=', 'archive_transfer').where('aggregate_id', '=', input.transferId).where('event_type', '=', 'archive_transfer.preserving').executeTakeFirst();
      if (preservationStarted !== undefined) throw new DomainInvariantError('CANCELLATION_NOT_SAFE', 'A failed transfer with started preservation cannot be cancelled safely');
    }
    const expediente = await transaction.selectFrom('expedientes').select('status').where('institution_id', '=', input.institutionId).where('id', '=', transfer.expediente_id).forUpdate().executeTakeFirst();
    if (expediente?.status !== 'TRANSFER_PENDING') throw new DomainInvariantError('EXPEDIENTE_NOT_TRANSFER_PENDING', 'The expediente is not pending transfer');
    const cancelledAt = await databaseTimestamp(transaction, 'Archive transfer cancellation');
    await transaction.updateTable('archive_transfers').set({ status: 'CANCELLED', updated_at: cancelledAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).execute();
    if (job !== undefined && (job.status === 'PENDING' || job.status === 'FAILED')) await transaction.updateTable('integration_jobs').set({ status: 'CANCELLED', lease_expires_at: null, claim_token: null, updated_at: cancelledAt }).where('institution_id', '=', input.institutionId).where('id', '=', job.id).execute();
    await transaction.updateTable('expedientes').set({ status: 'CLOSED', updated_at: cancelledAt }).where('institution_id', '=', input.institutionId).where('id', '=', transfer.expediente_id).where('status', '=', 'TRANSFER_PENDING').executeTakeFirstOrThrow();
    const expedienteCommand = transfer.status === 'DRAFT' ? 'rejectTransfer' : 'cancelTransfer';
    const expedienteAuditEvent = transfer.status === 'DRAFT' ? 'expediente.transfer_rejected' : 'expediente.transfer_cancelled';
    await transaction.insertInto('expediente_state_events').values({ institution_id: input.institutionId, expediente_id: transfer.expediente_id, from_status: 'TRANSFER_PENDING', to_status: 'CLOSED', command: expedienteCommand, actor_user_id: input.actorUserId, reason: input.reason, event_data: { transferId: input.transferId, reason: input.reason, ...(expedienteCommand === 'cancelTransfer' ? { cancellation: true } : { rejection: true }) }, occurred_at: cancelledAt }).execute();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'archive_transfer.cancelled', aggregateType: archivePreservationAggregateType, aggregateId: input.transferId, correlationId: input.correlationId, beforeData: { status: transfer.status }, afterData: { status: 'CANCELLED' }, eventData: { reason: input.reason } });
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: expedienteAuditEvent, aggregateType: 'expediente', aggregateId: transfer.expediente_id, correlationId: input.correlationId, beforeData: { status: 'TRANSFER_PENDING' }, afterData: { status: 'CLOSED' }, eventData: { transferId: input.transferId, reason: input.reason, ...(expedienteCommand === 'cancelTransfer' ? { cancellation: true } : { rejection: true }) } });
    return { transfer: await transaction.selectFrom('archive_transfers').selectAll().where('institution_id', '=', input.institutionId).where('id', '=', input.transferId).executeTakeFirstOrThrow(), manifest: await transaction.selectFrom('transfer_manifests').selectAll().where('institution_id', '=', input.institutionId).where('transfer_id', '=', input.transferId).executeTakeFirstOrThrow() };
  });
}

export async function assertTransactionUsesTenantContext(transaction: DatabaseTransaction, expectedInstitutionId?: InstitutionId | string): Promise<void> {
  const result = await transaction.selectNoFrom(() => sql<string | null>`ici_current_institution_id()::text`.as('institution_id')).executeTakeFirst();
  if (result?.institution_id === null || result?.institution_id === undefined) throw new Error('Transaction has no institution context');
  if (expectedInstitutionId !== undefined && result.institution_id !== expectedInstitutionId) throw new Error(`Transaction institution context is ${result.institution_id}, expected ${expectedInstitutionId}`);
}
