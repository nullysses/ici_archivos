import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { ArchiveTransferState, ExpedienteMetadataValidator, JsonObject, JsonValue, MatterState, ExpedienteState, InstitutionId } from '@ici/domain';
import { DomainInvariantError } from '@ici/domain';
import type { Database, DatabaseTransaction } from './index.js';
import { allocateFolio, appendAuditEvent, withAuditedTenantTransaction, withTenantTransaction } from './index.js';

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

const expedienteAuditEvents: Readonly<Record<string, string>> = {
  closeExpediente: 'expediente.closed',
  reopenExpediente: 'expediente.reopened',
  prepareTransfer: 'expediente.transfer_prepared',
  rejectTransfer: 'expediente.transfer_rejected',
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

function stringEventValue(data: JsonObject | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
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

function stringArrayEventValue(data: JsonObject | undefined, key: string): readonly string[] {
  const value = data?.[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return [];
  return value;
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
}

export async function registerMatterAtomically(database: Database, input: RegisterMatterPersistenceInput): Promise<{ readonly folio: string }> {
  if (Object.keys(input.intakeMetadata).length === 0) throw new DomainInvariantError('INVALID_INTAKE', 'Matter intake metadata is required');
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
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

export interface CreateExpedientePersistenceInput {
  readonly id: string;
  readonly institutionId: InstitutionId | string;
  readonly expedienteTypeVersionId: string;
  readonly metadata: JsonObject;
  readonly openedAt: Date;
  readonly correlationId: string;
  readonly actorUserId?: string;
  readonly year: number;
}

export async function createExpedienteAtomically(database: Database, input: CreateExpedientePersistenceInput, validateMetadata: ExpedienteMetadataValidator): Promise<{ readonly folio: string }> {
  return withTenantTransaction(database, input.institutionId, async (transaction) => {
    const typeVersion = await transaction.selectFrom('expediente_type_versions').select(['status', 'schema_json']).where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteTypeVersionId).forUpdate().executeTakeFirst();
    if (typeVersion?.status !== 'PUBLISHED') throw new DomainInvariantError('TYPE_VERSION_NOT_PUBLISHED', 'An expediente requires a published type version');
    if (!validateMetadata(typeVersion.schema_json, input.metadata)) throw new DomainInvariantError('INVALID_METADATA', 'Expediente metadata does not satisfy its published type version');
    const allocated = await allocateFolio(transaction, { institutionId: input.institutionId, folioKind: 'EXPEDIENTE', folioYear: input.year });
    await transaction.insertInto('expedientes').values({ id: input.id, institution_id: input.institutionId, folio: allocated.folio, folio_year: input.year, sequence_number: allocated.sequenceNumber, status: 'OPEN', expediente_type_version_id: input.expedienteTypeVersionId, metadata: input.metadata, opened_at: input.openedAt }).execute();
    await transaction.insertInto('expediente_state_events').values({ institution_id: input.institutionId, expediente_id: input.id, to_status: 'OPEN', command: 'createExpediente', ...(input.actorUserId === undefined ? {} : { actor_user_id: input.actorUserId }), event_data: { folio: allocated.folio }, occurred_at: input.openedAt }).execute();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'expediente.created', aggregateType: 'expediente', aggregateId: input.id, correlationId: input.correlationId, afterData: { status: 'OPEN', folio: allocated.folio, expedienteTypeVersionId: input.expedienteTypeVersionId } });
    return allocated;
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
  readonly assignedAt: Date;
}

export async function assignMatterAtomically(database: Database, input: MatterAssignmentPersistenceInput): Promise<void> {
  const toStatus = 'ASSIGNED' as const;
  assertTransition(input.command, input.fromStatus, toStatus, matterTransitions);
  if (input.command === 'reassignMatter') requireReason(input.reason, input.command);
  await withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: auditEventType(matterAuditEvents, input.command), aggregateType: 'matter', aggregateId: input.matterId, correlationId: input.correlationId, beforeData: { status: input.fromStatus }, afterData: { status: toStatus }, eventData: input.reason === undefined ? {} : { reason: input.reason } }, async (transaction) => {
    const current = await transaction.selectFrom('matters').select('status').where('institution_id', '=', input.institutionId).where('id', '=', input.matterId).forUpdate().executeTakeFirst();
    if (current === undefined) throw new Error('Matter not found');
    if (current.status !== input.fromStatus) throw new DomainInvariantError('STALE_STATE', `Matter is ${current.status}, expected ${input.fromStatus}`);
    await transaction.insertInto('matter_assignments').values({ id: input.assignmentId, institution_id: input.institutionId, matter_id: input.matterId, unit_id: input.unitId, ...(input.userId === undefined ? {} : { user_id: input.userId }), ...(input.reason === undefined ? {} : { reason: input.reason }), assigned_at: input.assignedAt }).execute();
    await transaction.updateTable('matters').set({ status: toStatus, updated_at: new Date() }).where('institution_id', '=', input.institutionId).where('id', '=', input.matterId).execute();
    await transaction.insertInto('matter_state_events').values({ institution_id: input.institutionId, matter_id: input.matterId, from_status: input.fromStatus, to_status: toStatus, command: input.command, ...(input.actorUserId === undefined ? {} : { actor_user_id: input.actorUserId }), ...(input.reason === undefined ? {} : { reason: input.reason }), event_data: { assignmentId: input.assignmentId, unitId: input.unitId }, occurred_at: input.assignedAt }).execute();
  });
}

export async function persistMatterTransition(database: Database, input: StateTransitionPersistenceInput): Promise<void> {
  assertTransition(input.command, input.fromStatus, input.toStatus, matterTransitions);
  const reason = input.command === 'reopenMatter' || input.command === 'voidMatter' ? requireReason(input.reason, input.command) : input.reason;
  await withAuditedTenantTransaction(database, {
    institutionId: input.institutionId,
    actorUserId: input.actorUserId,
    eventType: auditEventType(matterAuditEvents, input.command),
    aggregateType: 'matter',
    aggregateId: input.aggregateId,
    correlationId: input.correlationId,
    beforeData: { status: input.fromStatus },
    afterData: { status: input.toStatus },
    eventData: input.eventData,
  }, async (transaction) => {
    const current = await transaction.selectFrom('matters').select(['status', 'linked_expediente_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.aggregateId).forUpdate().executeTakeFirst();
    if (current === undefined) throw new Error('Matter not found');
    if (current.status !== input.fromStatus) throw new DomainInvariantError('STALE_STATE', `Matter is ${current.status}, expected ${input.fromStatus}`);
    const changes: { status: MatterState; updated_at: Date; resolution_metadata?: JsonObject; closure_metadata?: JsonObject; linked_expediente_id?: string } = { status: input.toStatus as MatterState, updated_at: new Date() };
    if (input.command === 'startMatter') {
      if (input.actorUserId === undefined) throw new DomainInvariantError('ACTOR_REQUIRED', 'startMatter requires an actor');
      const assignment = await transaction.selectFrom('matter_assignments').select(['unit_id', 'user_id']).where('institution_id', '=', input.institutionId).where('matter_id', '=', input.aggregateId).orderBy('assigned_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
      const authorizedUnitIds = stringArrayEventValue(input.eventData, 'authorizedUnitIds');
      if (assignment === undefined || (assignment.user_id !== input.actorUserId && !authorizedUnitIds.includes(assignment.unit_id))) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor is not the current assignee or an authorized member of the assigned unit');
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
    if (input.command === 'closeMatter') {
      const linkedExpedienteId = stringEventValue(input.eventData, 'linkedExpedienteId');
      const closureMetadata = objectEventValue(input.eventData, 'closureMetadata');
      if (linkedExpedienteId === undefined || closureMetadata === undefined || Object.keys(closureMetadata).length === 0) throw new DomainInvariantError('INVALID_CLOSURE', 'closeMatter requires a linked expediente and closure metadata');
      changes.linked_expediente_id = linkedExpedienteId;
      changes.closure_metadata = closureMetadata;
    }
    await transaction.updateTable('matters').set(changes).where('institution_id', '=', input.institutionId).where('id', '=', input.aggregateId).execute();
    await transaction.insertInto('matter_state_events').values({ institution_id: input.institutionId, matter_id: input.aggregateId, from_status: input.fromStatus, to_status: input.toStatus as MatterState, command: input.command, ...(input.actorUserId === undefined ? {} : { actor_user_id: input.actorUserId }), ...(reason === undefined ? {} : { reason }), event_data: input.eventData ?? {}, occurred_at: new Date() }).execute();
  });
}

export async function linkMatterToExpedienteAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly matterId: string; readonly expedienteId: string; readonly actorUserId?: string; readonly correlationId: string }): Promise<void> {
  await withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'matter.linked_to_expediente', aggregateType: 'matter', aggregateId: input.matterId, correlationId: input.correlationId, afterData: { expedienteId: input.expedienteId } }, async (transaction) => {
    const matter = await transaction.selectFrom('matters').select('status').where('institution_id', '=', input.institutionId).where('id', '=', input.matterId).forUpdate().executeTakeFirst();
    if (matter === undefined) throw new Error('Matter not found');
    if (matter.status === 'CLOSED' || matter.status === 'VOIDED') throw new DomainInvariantError('INVALID_TRANSITION', `linkMatterToExpediente is not allowed from ${matter.status}`);
    const expediente = await transaction.selectFrom('expedientes').select('status').where('institution_id', '=', input.institutionId).where('id', '=', input.expedienteId).executeTakeFirst();
    if (expediente?.status !== 'OPEN') throw new DomainInvariantError('EXPEDIENTE_NOT_OPEN', 'A matter can only be linked to an open expediente');
    await transaction.updateTable('matters').set({ linked_expediente_id: input.expedienteId, updated_at: new Date() }).where('institution_id', '=', input.institutionId).where('id', '=', input.matterId).execute();
  });
}

export async function persistExpedienteTransition(database: Database, input: StateTransitionPersistenceInput): Promise<void> {
  assertTransition(input.command, input.fromStatus, input.toStatus, expedienteTransitions);
  const reason = input.command === 'reopenExpediente' || input.command === 'rejectTransfer' || input.command === 'voidExpediente' ? requireReason(input.reason, input.command) : input.reason;
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
    if (input.command === 'closeExpediente') {
      if (booleanEventValue(input.eventData, 'metadataValid') !== true) throw new DomainInvariantError('INVALID_METADATA', 'closeExpediente requires validated metadata');
      const invalidMatter = await transaction.selectFrom('matters').select('id').where('institution_id', '=', input.institutionId).where('linked_expediente_id', '=', input.aggregateId).where('status', 'not in', ['CLOSED', 'VOIDED']).executeTakeFirst();
      if (invalidMatter !== undefined) throw new DomainInvariantError('MATTERS_NOT_CLOSED', 'All linked matters must be CLOSED or VOIDED');
      const unsafeDocument = await transaction.selectFrom('documents').leftJoin('document_versions', (join) => join.onRef('document_versions.institution_id', '=', 'documents.institution_id').onRef('document_versions.id', '=', 'documents.current_version_id')).select('documents.id').where('documents.institution_id', '=', input.institutionId).where('documents.expediente_id', '=', input.aggregateId).where((expression) => expression.or([expression('documents.current_version_id', 'is', null), expression('document_versions.malware_scan_status', '<>', 'CLEAN')])).executeTakeFirst();
      if (unsafeDocument !== undefined) throw new DomainInvariantError('DOCUMENTS_NOT_CLEAN', 'All current document versions must have a clean malware scan');
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

const archiveTransferTransitions: Readonly<Record<string, { readonly from: readonly string[]; readonly to: string }>> = {
  approveTransfer: { from: ['DRAFT'], to: 'APPROVED' },
  submitTransfer: { from: ['APPROVED'], to: 'SUBMITTED' },
  beginPreservation: { from: ['SUBMITTED'], to: 'PRESERVING' },
  completeArchiveTransfer: { from: ['PRESERVING'], to: 'COMPLETED' },
  failTransfer: { from: ['SUBMITTED', 'PRESERVING'], to: 'FAILED' },
  retryFailedTransfer: { from: ['FAILED'], to: 'SUBMITTED' },
  cancelTransfer: { from: ['DRAFT', 'APPROVED', 'SUBMITTED', 'PRESERVING', 'FAILED'], to: 'CANCELLED' },
};

const archiveTransferAuditEvents: Readonly<Record<string, string>> = {
  approveTransfer: 'archive_transfer.approved',
  submitTransfer: 'archive_transfer.submitted',
  beginPreservation: 'archive_transfer.preserving',
  completeArchiveTransfer: 'archive_transfer.completed',
  failTransfer: 'archive_transfer.failed',
  retryFailedTransfer: 'archive_transfer.retried',
  cancelTransfer: 'archive_transfer.cancelled',
};

export async function persistArchiveTransferTransition(database: Database, input: StateTransitionPersistenceInput): Promise<void> {
  assertTransition(input.command, input.fromStatus, input.toStatus, archiveTransferTransitions);
  if ((input.command === 'failTransfer' || input.command === 'cancelTransfer')) requireReason(input.reason, input.command);
  if (input.command === 'cancelTransfer' && booleanEventValue(input.eventData, 'cancellationIsSafe') !== true) throw new DomainInvariantError('CANCELLATION_NOT_SAFE', 'Transfer cancellation must be confirmed safe');
  await withAuditedTenantTransaction(database, {
    institutionId: input.institutionId,
    actorUserId: input.actorUserId,
    eventType: auditEventType(archiveTransferAuditEvents, input.command),
    aggregateType: 'archive_transfer',
    aggregateId: input.aggregateId,
    correlationId: input.correlationId,
    beforeData: { status: input.fromStatus },
    afterData: { status: input.toStatus },
    eventData: input.eventData,
  }, async (transaction) => {
    const current = await transaction.selectFrom('archive_transfers').select('status').where('institution_id', '=', input.institutionId).where('id', '=', input.aggregateId).forUpdate().executeTakeFirst();
    if (current === undefined) throw new Error('Archive transfer not found');
    if (current.status !== input.fromStatus) throw new DomainInvariantError('STALE_STATE', `Archive transfer is ${current.status}, expected ${input.fromStatus}`);
    await transaction.updateTable('archive_transfers').set({ status: input.toStatus as ArchiveTransferState, updated_at: new Date() }).where('institution_id', '=', input.institutionId).where('id', '=', input.aggregateId).execute();
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
    const document = await transaction.selectFrom('documents').select(['expediente_id']).where('institution_id', '=', input.institutionId).where('id', '=', input.documentId).forUpdate().executeTakeFirst();
    if (document === undefined) throw new Error('Document not found');
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

export async function publishExpedienteTypeVersionAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly versionId: string; readonly actorUserId?: string; readonly correlationId: string; readonly publishedAt: Date }, validateSchemaDefinition: (schema: JsonObject) => void): Promise<void> {
  await withAuditedTenantTransaction(database, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'expediente_type_version.published', aggregateType: 'expediente_type_version', aggregateId: input.versionId, correlationId: input.correlationId, afterData: { status: 'PUBLISHED', publishedAt: input.publishedAt.toISOString() } }, async (transaction) => {
    const draft = await transaction.selectFrom('expediente_type_versions').select(['status', 'schema_json']).where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).forUpdate().executeTakeFirst();
    if (draft === undefined) throw new Error('Expediente type version not found');
    if (draft.status !== 'DRAFT') throw new DomainInvariantError('VERSION_NOT_DRAFT', 'Only a draft version may be published');
    validateSchemaDefinition(draft.schema_json);
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

export async function assertTransactionUsesTenantContext(transaction: DatabaseTransaction, expectedInstitutionId?: InstitutionId | string): Promise<void> {
  const result = await transaction.selectNoFrom(() => sql<string | null>`ici_current_institution_id()::text`.as('institution_id')).executeTakeFirst();
  if (result?.institution_id === null || result?.institution_id === undefined) throw new Error('Transaction has no institution context');
  if (expectedInstitutionId !== undefined && result.institution_id !== expectedInstitutionId) throw new Error(`Transaction institution context is ${result.institution_id}, expected ${expectedInstitutionId}`);
}
