import {
  type DomainEvent,
  type EntityId,
  type Expediente,
  type ExpedienteId,
  type ExpedienteState,
  type ExpedienteTypeVersion,
  type ExpedienteTypeVersionId,
  type ExpedienteTypeId,
  type InstitutionId,
  type JsonObject,
  type MalwareScanStatus,
  type MatterState,
  invalidTransition,
  requireNonBlank,
  DomainInvariantError,
} from './types.js';

export interface CreateExpedienteInput {
  readonly id: ExpedienteId;
  readonly institutionId: InstitutionId;
  readonly folio: string;
  readonly expedienteTypeVersion: ExpedienteTypeVersion;
  readonly metadata: JsonObject;
  readonly openedAt: Date;
}

export interface ExpedienteMutation {
  readonly aggregate: Expediente;
  readonly events: readonly DomainEvent[];
}

export type ExpedienteMetadataValidator = (schema: JsonObject, metadata: JsonObject) => boolean;

function event(aggregateId: EntityId, eventType: string, payload: JsonObject, occurredAt: Date): DomainEvent {
  return { aggregateId, eventType, occurredAt, payload };
}

export function createExpediente(input: CreateExpedienteInput, validateMetadata: ExpedienteMetadataValidator): ExpedienteMutation {
  if (!/^EXP-[0-9]{4}-[0-9]{6}$/.test(input.folio)) throw new DomainInvariantError('INVALID_FOLIO', 'Expediente folio must use EXP-YYYY-NNNNNN');
  if (input.folio.endsWith('-000000')) throw new DomainInvariantError('INVALID_FOLIO', 'Expediente folio sequence must be positive');
  if (input.expedienteTypeVersion.institutionId !== input.institutionId) throw new DomainInvariantError('CROSS_TENANT_REFERENCE', 'Expediente and type version must belong to the same institution');
  if (input.expedienteTypeVersion.state !== 'PUBLISHED') throw new DomainInvariantError('TYPE_VERSION_NOT_PUBLISHED', 'An expediente requires a published type version');
  if (!validateMetadata(input.expedienteTypeVersion.schemaJson, input.metadata)) throw new DomainInvariantError('INVALID_METADATA', 'Expediente metadata does not satisfy its published type version');
  const aggregate: Expediente = {
    id: input.id,
    institutionId: input.institutionId,
    folio: input.folio,
    state: 'OPEN',
    expedienteTypeVersionId: input.expedienteTypeVersion.id,
    metadata: input.metadata,
    openedAt: input.openedAt,
  };
  return { aggregate, events: [event(input.id, 'expediente.created', { state: 'OPEN', typeVersionId: input.expedienteTypeVersion.id }, input.openedAt)] };
}

export interface CloseExpedienteInput {
  readonly linkedMatterStates: readonly MatterState[];
  readonly documentScanStatuses: readonly MalwareScanStatus[];
  readonly closedAt: Date;
}

export function closeExpediente(expediente: Expediente, input: CloseExpedienteInput): ExpedienteMutation {
  if (expediente.state !== 'OPEN') invalidTransition('expediente', expediente.state, 'closeExpediente');
  if (input.linkedMatterStates.some((state) => state !== 'CLOSED' && state !== 'VOIDED')) throw new DomainInvariantError('MATTERS_NOT_CLOSED', 'All linked matters must be CLOSED or VOIDED');
  if (input.documentScanStatuses.some((status) => status !== 'CLEAN')) throw new DomainInvariantError('DOCUMENTS_NOT_CLEAN', 'All included document versions must have a clean malware scan');
  const next = { ...expediente, state: 'CLOSED' as const, closedAt: input.closedAt };
  return { aggregate: next, events: [event(expediente.id, 'expediente.closed', { state: 'CLOSED' }, input.closedAt)] };
}

export function reopenExpediente(expediente: Expediente, reason: string, transferApproved: boolean, reopenedAt: Date): ExpedienteMutation {
  if (expediente.state !== 'CLOSED') invalidTransition('expediente', expediente.state, 'reopenExpediente');
  if (transferApproved) throw new DomainInvariantError('TRANSFER_ALREADY_APPROVED', 'An expediente cannot reopen after transfer approval');
  reason = requireNonBlank(reason, 'Reopen reason');
  const next: Expediente = { ...expediente, state: 'OPEN', ...(deleteClosedAt(expediente)) };
  return { aggregate: next, events: [event(expediente.id, 'expediente.reopened', { state: 'OPEN', reason }, reopenedAt)] };
}

function deleteClosedAt(expediente: Expediente): { readonly closedAt?: undefined } {
  if (expediente.closedAt === undefined) return {};
  return { closedAt: undefined };
}

export function prepareTransfer(expediente: Expediente, archivalMappingValid: boolean, draftManifestReady: boolean, preparedAt: Date): ExpedienteMutation {
  if (expediente.state !== 'CLOSED') invalidTransition('expediente', expediente.state, 'prepareTransfer');
  if (!archivalMappingValid || !draftManifestReady) throw new DomainInvariantError('TRANSFER_NOT_READY', 'Archival mapping and draft manifest must validate');
  const next = { ...expediente, state: 'TRANSFER_PENDING' as const };
  return { aggregate: next, events: [event(expediente.id, 'expediente.transfer_prepared', { state: 'TRANSFER_PENDING' }, preparedAt)] };
}

export function rejectTransfer(expediente: Expediente, reason: string, rejectedAt: Date): ExpedienteMutation {
  if (expediente.state !== 'TRANSFER_PENDING') invalidTransition('expediente', expediente.state, 'rejectTransfer');
  reason = requireNonBlank(reason, 'Transfer rejection reason');
  const next = { ...expediente, state: 'CLOSED' as const };
  return { aggregate: next, events: [event(expediente.id, 'expediente.transfer_rejected', { state: 'CLOSED', reason }, rejectedAt)] };
}

export function completeTransfer(expediente: Expediente, approvedManifestPreserved: boolean, aipStored: boolean, archivalIntegrationCompleted: boolean, completedAt: Date): ExpedienteMutation {
  if (expediente.state !== 'TRANSFER_PENDING') invalidTransition('expediente', expediente.state, 'completeTransfer');
  if (!approvedManifestPreserved || !aipStored || !archivalIntegrationCompleted) throw new DomainInvariantError('TRANSFER_NOT_COMPLETE', 'Approved manifest, preservation package, and archival integration are required');
  const next = { ...expediente, state: 'TRANSFERRED' as const };
  return { aggregate: next, events: [event(expediente.id, 'expediente.transfer_completed', { state: 'TRANSFERRED' }, completedAt)] };
}

export function voidExpediente(expediente: Expediente, reason: string, hasClosedSubstantiveMatter: boolean, voidedAt: Date): ExpedienteMutation {
  if (expediente.state !== 'OPEN') invalidTransition('expediente', expediente.state, 'voidExpediente');
  if (hasClosedSubstantiveMatter) throw new DomainInvariantError('CLOSED_MATTER_DEPENDENCY', 'An expediente with a closed substantive matter cannot be voided');
  reason = requireNonBlank(reason, 'Void reason');
  const next = { ...expediente, state: 'VOIDED' as const };
  return { aggregate: next, events: [event(expediente.id, 'expediente.voided', { state: 'VOIDED', reason }, voidedAt)] };
}

export function assertExpedienteState(state: string): ExpedienteState {
  const states: readonly ExpedienteState[] = ['OPEN', 'CLOSED', 'TRANSFER_PENDING', 'TRANSFERRED', 'VOIDED'];
  if (!states.includes(state as ExpedienteState)) throw new DomainInvariantError('INVALID_STATE', `Unknown expediente state ${state}`);
  return state as ExpedienteState;
}

export interface ExpedienteTypeDraftInput {
  readonly id: ExpedienteTypeVersionId;
  readonly institutionId: InstitutionId;
  readonly expedienteTypeId: ExpedienteTypeId;
  readonly versionNumber: number;
  readonly schemaJson: JsonObject;
  readonly archivalMappingJson: JsonObject;
  readonly createdAt: Date;
}

export function createExpedienteTypeDraft(input: ExpedienteTypeDraftInput): ExpedienteTypeVersion {
  if (!Number.isInteger(input.versionNumber) || input.versionNumber < 1) throw new DomainInvariantError('INVALID_VERSION', 'Version number must be a positive integer');
  return { ...input, state: 'DRAFT' };
}

export function editExpedienteTypeDraft(version: ExpedienteTypeVersion, schemaJson: JsonObject, archivalMappingJson: JsonObject): ExpedienteTypeVersion {
  if (version.state !== 'DRAFT') throw new DomainInvariantError('PUBLISHED_VERSION_IMMUTABLE', 'Published expediente type versions are immutable and may not be edited');
  return { ...version, schemaJson, archivalMappingJson };
}

export function publishExpedienteTypeVersion(version: ExpedienteTypeVersion, publishedAt: Date): ExpedienteTypeVersion {
  if (version.state !== 'DRAFT') throw new DomainInvariantError('VERSION_NOT_DRAFT', 'Only a draft expediente type version may be published');
  return { ...version, state: 'PUBLISHED', publishedAt };
}

export function retireExpedienteTypeVersion(version: ExpedienteTypeVersion): ExpedienteTypeVersion {
  if (version.state !== 'PUBLISHED') throw new DomainInvariantError('VERSION_NOT_PUBLISHED', 'Only a published version may be retired');
  return { ...version, state: 'RETIRED' };
}

export function nextExpedienteTypeVersionNumber(current: number): number {
  if (!Number.isInteger(current) || current < 1) throw new DomainInvariantError('INVALID_VERSION', 'Current version must be a positive integer');
  return current + 1;
}
