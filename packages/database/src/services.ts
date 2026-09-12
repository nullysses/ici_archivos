import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { ArchiveTransferState, AuthorizationContext, Capability, ExpedienteMetadataValidator, JsonObject, JsonValue, MatterState, ExpedienteState, InstitutionId } from '@ici/domain';
import { canPerform, DomainInvariantError } from '@ici/domain';
import type { Database, DatabaseTransaction } from './index.js';
import type { DocumentsTable, DocumentVersionsTable, IntegrationJobsTable, MatterNotesTable, MattersTable } from './schema.js';
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

export type MatterReadModel = Selectable<MattersTable> & { readonly effective_unit_id?: string | null };

async function currentMatterAssignment(transaction: DatabaseTransaction, institutionId: string, matterId: string): Promise<{ readonly unit_id: string; readonly user_id: string | null } | undefined> {
  return transaction.selectFrom('matter_assignments').select(['unit_id', 'user_id']).where('institution_id', '=', institutionId).where('matter_id', '=', matterId).orderBy('assigned_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
}

async function effectiveMatterUnit(transaction: DatabaseTransaction, institutionId: string, matterId: string, destinationUnitId: string | null): Promise<string | null> {
  const assignment = await currentMatterAssignment(transaction, institutionId, matterId);
  return assignment?.unit_id ?? destinationUnitId;
}

export async function findMatterById(database: Database, institutionId: InstitutionId | string, matterId: string): Promise<MatterReadModel | undefined> {
  return withTenantTransaction(database, institutionId, async (transaction) => {
    const matter = await transaction.selectFrom('matters').selectAll().where('institution_id', '=', institutionId).where('id', '=', matterId).executeTakeFirst();
    if (matter === undefined) return undefined;
    return { ...matter, effective_unit_id: await effectiveMatterUnit(transaction, String(institutionId), matterId, matter.destination_unit_id) };
  });
}

export async function findMatterByFolio(database: Database, institutionId: InstitutionId | string, folio: string): Promise<MatterReadModel | undefined> {
  return withTenantTransaction(database, institutionId, async (transaction) => {
    const matter = await transaction.selectFrom('matters').selectAll().where('institution_id', '=', institutionId).where('folio', '=', folio).executeTakeFirst();
    if (matter === undefined) return undefined;
    return { ...matter, effective_unit_id: await effectiveMatterUnit(transaction, String(institutionId), matter.id, matter.destination_unit_id) };
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
  /** Trusted, server-derived context. Required for startMatter unit-scope checks. */
  readonly authorizationContext?: AuthorizationContext;
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
  assertTransition(input.command, input.fromStatus, input.toStatus, matterTransitions);
  if (input.command === 'startMatter' && input.eventData?.authorizedUnitIds !== undefined) throw new DomainInvariantError('INVALID_AUTHORIZATION_EVIDENCE', 'Authorization evidence must not be supplied in event data');
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
    eventData: input.command === 'voidMatter' && reason !== undefined ? { ...(input.eventData ?? {}), reason } : input.eventData,
  }, async (transaction) => {
    const current = await transaction.selectFrom('matters').select(['status', 'linked_expediente_id', 'destination_unit_id', 'intake_metadata']).where('institution_id', '=', input.institutionId).where('id', '=', input.aggregateId).forUpdate().executeTakeFirst();
    if (current === undefined) throw new Error('Matter not found');
    if (current.status !== input.fromStatus) throw new DomainInvariantError('STALE_STATE', `Matter is ${current.status}, expected ${input.fromStatus}`);
    const transitionAt = (await sql<{ occurred_at: Date }>`select clock_timestamp() as occurred_at`.execute(transaction)).rows[0]?.occurred_at;
    if (transitionAt === undefined) throw new Error('Transition timestamp was not generated');
    const effectiveUnit = await effectiveMatterUnit(transaction, String(input.institutionId), input.aggregateId, current.destination_unit_id);
    const authorization = input.authorizationContext;
    if (input.command === 'startMatter' || input.command === 'resolveMatter' || input.command === 'voidMatter') {
      if (input.actorUserId === undefined || authorization === undefined || authorization.institutionId !== String(input.institutionId) || authorization.userId !== input.actorUserId) throw new DomainInvariantError('AUTHORIZATION_CONTEXT_REQUIRED', `${input.command} requires matching server-derived authorization context`);
    }
    if (input.command === 'resolveMatter' && !canPerform(authorization as AuthorizationContext, 'matter.resolve', effectiveUnit ?? undefined)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot resolve matters for the effective unit');
    if (input.command === 'voidMatter' && !canPerform(authorization as AuthorizationContext, 'matter.void', effectiveUnit ?? undefined)) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor cannot void matters for the effective unit');
    const changes: { status: MatterState; updated_at: Date; resolution_metadata?: JsonObject; closure_metadata?: JsonObject; linked_expediente_id?: string } = { status: input.toStatus as MatterState, updated_at: transitionAt };
    if (input.command === 'startMatter') {
      if (input.actorUserId === undefined) throw new DomainInvariantError('ACTOR_REQUIRED', 'startMatter requires an actor');
      const assignment = await currentMatterAssignment(transaction, String(input.institutionId), input.aggregateId);
      if (assignment === undefined || (assignment.user_id !== input.actorUserId && !canPerform(authorization as AuthorizationContext, 'matter.start', assignment.unit_id))) throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor is not the current assignee or authorized to start matters for the assigned unit');
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
    await transaction.insertInto('matter_state_events').values({ institution_id: input.institutionId, matter_id: input.aggregateId, from_status: input.fromStatus, to_status: input.toStatus as MatterState, command: input.command, ...(input.actorUserId === undefined ? {} : { actor_user_id: input.actorUserId }), ...(reason === undefined ? {} : { reason }), event_data: input.eventData ?? {}, occurred_at: transitionAt }).execute();
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

export async function recordMalwareScanResultAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly jobId: string; readonly versionId: string; readonly scanId: string; readonly result: 'CLEAN' | 'INFECTED' | 'SCAN_FAILED'; readonly engine: string; readonly engineVersion?: string; readonly signatureVersion?: string; readonly scannedAt?: Date; readonly error?: string; readonly correlationId: string; }): Promise<void> {
  if (input.result === 'SCAN_FAILED' && (input.error === undefined || input.error.length > 4000)) throw new DomainInvariantError('INVALID_JOB_ERROR', 'Scan failure errors are limited to 4000 characters');
  await withTenantTransaction(database, input.institutionId, async (transaction) => {
    const job = await transaction.selectFrom('integration_jobs').select(['status', 'aggregate_id', 'job_type', 'aggregate_type']).where('institution_id', '=', input.institutionId).where('id', '=', input.jobId).forUpdate().executeTakeFirst();
    if (job?.status !== 'RUNNING' || job.aggregate_id !== input.versionId || job.job_type !== 'document.malware_scan' || job.aggregate_type !== 'document_version') throw new DomainInvariantError('INVALID_JOB_STATE', 'Malware scan job is not running for this version');
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
    await transaction.updateTable('integration_jobs').set(input.result === 'SCAN_FAILED' ? { status: 'FAILED', last_error: input.error ?? 'Malware scan failed', updated_at: scannedAt } : { status: 'SUCCEEDED', updated_at: scannedAt }).where('institution_id', '=', input.institutionId).where('id', '=', input.jobId).where('status', '=', 'RUNNING').executeTakeFirstOrThrow();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, eventType: input.result === 'CLEAN' ? 'document.malware_clean' : input.result === 'INFECTED' ? 'document.malware_infected' : 'document.malware_scan_failed', aggregateType: 'document_version', aggregateId: input.versionId, correlationId: input.correlationId, eventData: { result: input.result, scanId: input.scanId } });
  });
}

export async function prepareMalwareRetryAtomically(database: Database, input: { readonly institutionId: InstitutionId | string; readonly jobId: string; readonly versionId: string; readonly nextAttemptAt: Date; readonly actorUserId?: string; readonly correlationId: string }): Promise<void> {
  await withTenantTransaction(database, input.institutionId, async (transaction) => {
    const job = await transaction.selectFrom('integration_jobs').select(['status', 'aggregate_id', 'job_type', 'aggregate_type']).where('institution_id', '=', input.institutionId).where('id', '=', input.jobId).forUpdate().executeTakeFirst();
    const version = await transaction.selectFrom('document_versions').select('malware_scan_status').where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).forUpdate().executeTakeFirst();
    if (job?.status !== 'FAILED' || job.aggregate_id !== input.versionId || job.job_type !== 'document.malware_scan' || job.aggregate_type !== 'document_version' || version?.malware_scan_status !== 'SCAN_FAILED') throw new DomainInvariantError('INVALID_SCAN_STATE', 'Only a failed malware scan may be retried');
    await transaction.updateTable('document_versions').set({ malware_scan_status: 'PENDING_SCAN' }).where('institution_id', '=', input.institutionId).where('id', '=', input.versionId).execute();
    await transaction.updateTable('integration_jobs').set({ status: 'PENDING', next_attempt_at: input.nextAttemptAt, updated_at: await databaseTimestamp(transaction, 'Retry') }).where('institution_id', '=', input.institutionId).where('id', '=', input.jobId).execute();
    await appendAuditEvent(transaction, { institutionId: input.institutionId, actorUserId: input.actorUserId, eventType: 'document.malware_scan_retry_scheduled', aggregateType: 'document_version', aggregateId: input.versionId, correlationId: input.correlationId, eventData: { jobId: input.jobId, nextAttemptAt: input.nextAttemptAt.toISOString() } });
  });
}

export async function claimMalwareScanJobs(database: Database, institutionId: InstitutionId | string, limit: number, now: Date = new Date()): Promise<readonly Selectable<IntegrationJobsTable>[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainInvariantError('INVALID_JOB_BATCH', 'Job claim limit must be between 1 and 100');
  return withTenantTransaction(database, institutionId, async (transaction) => {
    const result = await sql<Selectable<IntegrationJobsTable>>`
      WITH due AS (
        SELECT id FROM integration_jobs
        WHERE institution_id = ${institutionId}
          AND job_type = 'document.malware_scan'
          AND status = 'PENDING'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE integration_jobs AS jobs
      SET status = 'RUNNING', attempt_count = jobs.attempt_count + 1,
          next_attempt_at = NULL, updated_at = clock_timestamp()
      FROM due
      WHERE jobs.id = due.id AND jobs.institution_id = ${institutionId}
      RETURNING jobs.*
    `.execute(transaction);
    return result.rows;
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
