import {
  type DomainEvent,
  type EntityId,
  type Expediente,
  type JsonObject,
  type Matter,
  type MatterAssignment,
  type MatterId,
  type MatterState,
  type OrganizationalUnitId,
  type InstitutionId,
  type UserId,
  DomainInvariantError,
  invalidTransition,
  requireNonBlank,
} from './types.js';
import { canPerform, type AuthorizationContext } from './authorization.js';

export interface RegisterMatterInput {
  readonly id: MatterId;
  readonly institutionId: InstitutionId;
  readonly folio: string;
  readonly receivedAt: Date;
  readonly intake: JsonObject;
}

export interface DomainMutation<T> {
  readonly aggregate: T;
  readonly events: readonly DomainEvent[];
}

function event(aggregateId: EntityId, eventType: string, payload: JsonObject, occurredAt: Date): DomainEvent {
  return { aggregateId, eventType, occurredAt, payload };
}

export function registerMatter(input: RegisterMatterInput): DomainMutation<Matter> {
  if (!/^OP-[0-9]{4}-[0-9]{6}$/.test(input.folio)) throw new DomainInvariantError('INVALID_FOLIO', 'Matter folio must use OP-YYYY-NNNNNN');
  if (input.folio.endsWith('-000000')) throw new DomainInvariantError('INVALID_FOLIO', 'Matter folio sequence must be positive');
  if (Object.keys(input.intake).length === 0) throw new DomainInvariantError('INVALID_INTAKE', 'Matter intake metadata is required');
  const aggregate: Matter = { ...input, state: 'RECEIVED' };
  return { aggregate, events: [event(input.id, 'matter.registered', { state: 'RECEIVED' }, input.receivedAt)] };
}

export interface AssignMatterInput {
  readonly assignmentId: EntityId;
  readonly unitId: OrganizationalUnitId;
  readonly userId?: UserId;
  readonly assignedAt: Date;
}

function assignment(matter: Matter, input: AssignMatterInput, reason?: string): MatterAssignment {
  return {
    id: input.assignmentId,
    institutionId: matter.institutionId,
    matterId: matter.id,
    unitId: input.unitId,
    userId: input.userId,
    reason,
    assignedAt: input.assignedAt,
  };
}

export function assignMatter(matter: Matter, input: AssignMatterInput): DomainMutation<Matter> {
  if (matter.state !== 'RECEIVED') invalidTransition('matter', matter.state, 'assignMatter');
  const next = { ...matter, state: 'ASSIGNED' as const, currentAssignment: assignment(matter, input) };
  return { aggregate: next, events: [event(matter.id, 'matter.assigned', { state: 'ASSIGNED', unitId: input.unitId, ...(input.userId ? { userId: input.userId } : {}) }, input.assignedAt)] };
}

export interface ReassignMatterInput extends AssignMatterInput {
  readonly reason: string;
}

export function reassignMatter(matter: Matter, input: ReassignMatterInput): DomainMutation<Matter> {
  if (matter.state !== 'ASSIGNED' && matter.state !== 'IN_PROGRESS') invalidTransition('matter', matter.state, 'reassignMatter');
  const reason = requireNonBlank(input.reason, 'Reassignment reason');
  const next = { ...matter, state: 'ASSIGNED' as const, currentAssignment: assignment(matter, input, reason) };
  return { aggregate: next, events: [event(matter.id, 'matter.reassigned', { state: 'ASSIGNED', reason, unitId: input.unitId, ...(input.userId ? { userId: input.userId } : {}) }, input.assignedAt)] };
}

export interface StartMatterInput {
  readonly actorUserId: UserId;
  readonly authorizationContext: AuthorizationContext;
  readonly startedAt: Date;
}

export function startMatter(matter: Matter, input: StartMatterInput): DomainMutation<Matter> {
  if (matter.state !== 'ASSIGNED') invalidTransition('matter', matter.state, 'startMatter');
  const currentAssignment = matter.currentAssignment;
  const authorization = input.authorizationContext;
  if (authorization.userId !== input.actorUserId || authorization.institutionId !== matter.institutionId) {
    throw new DomainInvariantError('NOT_AUTHORIZED', 'Authorization context does not match the matter actor and institution');
  }
  if (currentAssignment === undefined || (currentAssignment.userId !== input.actorUserId && !canPerform(authorization, 'matter.start', currentAssignment.unitId))) {
    throw new DomainInvariantError('NOT_AUTHORIZED', 'Actor is not the current assignee or an authorized member of the assigned unit');
  }
  const next = { ...matter, state: 'IN_PROGRESS' as const };
  return { aggregate: next, events: [event(matter.id, 'matter.started', { state: 'IN_PROGRESS' }, input.startedAt)] };
}

export function resolveMatter(matter: Matter, resolutionMetadata: JsonObject, resolvedAt: Date): DomainMutation<Matter> {
  if (matter.state !== 'IN_PROGRESS') invalidTransition('matter', matter.state, 'resolveMatter');
  if (Object.keys(resolutionMetadata).length === 0) throw new DomainInvariantError('INVALID_RESOLUTION', 'Resolution metadata is required');
  const next = { ...matter, state: 'RESOLVED' as const, resolutionMetadata };
  return { aggregate: next, events: [event(matter.id, 'matter.resolved', { state: 'RESOLVED', resolution: resolutionMetadata }, resolvedAt)] };
}

export function linkMatterToExpediente(matter: Matter, expediente: Pick<Expediente, 'id' | 'institutionId' | 'state'>, linkedAt: Date): DomainMutation<Matter> {
  if (matter.state === 'CLOSED' || matter.state === 'VOIDED') invalidTransition('matter', matter.state, 'linkMatterToExpediente');
  if (matter.institutionId !== expediente.institutionId) throw new DomainInvariantError('CROSS_TENANT_REFERENCE', 'Matter and expediente must belong to the same institution');
  if (expediente.state !== 'OPEN') throw new DomainInvariantError('EXPEDIENTE_NOT_OPEN', 'A matter can only be linked to an open expediente');
  const next = { ...matter, linkedExpedienteId: expediente.id };
  return { aggregate: next, events: [event(matter.id, 'matter.linked_to_expediente', { expedienteId: expediente.id }, linkedAt)] };
}

export function reopenMatter(matter: Matter, reason: string, linkedExpediente: Pick<Expediente, 'id' | 'institutionId' | 'state'>, reopenedAt: Date): DomainMutation<Matter> {
  if (matter.state !== 'RESOLVED') invalidTransition('matter', matter.state, 'reopenMatter');
  if (matter.linkedExpedienteId !== linkedExpediente.id || matter.institutionId !== linkedExpediente.institutionId || linkedExpediente.state !== 'OPEN') throw new DomainInvariantError('EXPEDIENTE_NOT_OPEN', 'A resolved matter can only reopen while its linked expediente is open');
  reason = requireNonBlank(reason, 'Reopen reason');
  const next = { ...matter, state: 'IN_PROGRESS' as const };
  return { aggregate: next, events: [event(matter.id, 'matter.reopened', { state: 'IN_PROGRESS', reason }, reopenedAt)] };
}

export function closeMatter(matter: Matter, closureMetadata: JsonObject, closedAt: Date): DomainMutation<Matter> {
  if (matter.state !== 'RESOLVED') invalidTransition('matter', matter.state, 'closeMatter');
  if (Object.keys(closureMetadata).length === 0) throw new DomainInvariantError('INVALID_CLOSURE', 'Closure metadata is required');
  if (matter.linkedExpedienteId === undefined) throw new DomainInvariantError('EXPEDIENTE_LINK_REQUIRED', 'A matter must already be linked to an expediente before closure');
  const next = { ...matter, state: 'CLOSED' as const, closureMetadata };
  return { aggregate: next, events: [event(matter.id, 'matter.closed', { state: 'CLOSED', expedienteId: matter.linkedExpedienteId, closure: closureMetadata }, closedAt)] };
}

export function voidMatter(matter: Matter, reason: string, voidedAt: Date): DomainMutation<Matter> {
  if (matter.state !== 'RECEIVED' && matter.state !== 'ASSIGNED') invalidTransition('matter', matter.state, 'voidMatter');
  reason = requireNonBlank(reason, 'Void reason');
  const next = { ...matter, state: 'VOIDED' as const };
  return { aggregate: next, events: [event(matter.id, 'matter.voided', { state: 'VOIDED', reason }, voidedAt)] };
}

export function assertMatterState(state: string): MatterState {
  const states: readonly MatterState[] = ['RECEIVED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'VOIDED'];
  if (!states.includes(state as MatterState)) throw new DomainInvariantError('INVALID_STATE', `Unknown matter state ${state}`);
  return state as MatterState;
}
