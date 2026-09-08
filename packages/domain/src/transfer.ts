import { type ArchiveTransfer, type ArchiveTransferState, type DomainEvent, type EntityId, type ExpedienteId, type InstitutionId, type JsonObject, type ManifestId, type TransferId, type UserId, DomainInvariantError, invalidTransition, requireNonBlank } from './types.js';

function event(aggregateId: EntityId, eventType: string, payload: JsonObject, occurredAt: Date): DomainEvent {
  return { aggregateId, eventType, occurredAt, payload };
}

export interface CreateArchiveTransferInput {
  readonly id: TransferId;
  readonly institutionId: InstitutionId;
  readonly expedienteId: ExpedienteId;
  readonly createdAt: Date;
  readonly supplementsTransferId?: TransferId;
  readonly correctionReason?: string;
}

export function createArchiveTransfer(input: CreateArchiveTransferInput): { readonly aggregate: ArchiveTransfer; readonly events: readonly DomainEvent[] } {
  if (input.supplementsTransferId !== undefined && (input.correctionReason === undefined || input.correctionReason.trim().length === 0)) throw new DomainInvariantError('CORRECTION_REASON_REQUIRED', 'Supplemental transfers require a correction reason');
  const aggregate: ArchiveTransfer = { ...input, state: 'DRAFT' };
  return { aggregate, events: [event(input.id, 'archive_transfer.created', { state: 'DRAFT', expedienteId: input.expedienteId }, input.createdAt)] };
}

export interface TransferMutation {
  readonly aggregate: ArchiveTransfer;
  readonly events: readonly DomainEvent[];
}

export function approveTransfer(transfer: ArchiveTransfer, manifest: ApprovedManifest, approvedAt: Date): TransferMutation {
  if (transfer.state !== 'DRAFT') invalidTransition('archive_transfer', transfer.state, 'approveTransfer');
  if (manifest.institutionId !== transfer.institutionId || manifest.transferId !== transfer.id) throw new DomainInvariantError('MANIFEST_TRANSFER_MISMATCH', 'The approved manifest must belong to the transfer being approved');
  const next = { ...transfer, state: 'APPROVED' as const };
  return { aggregate: next, events: [event(transfer.id, 'archive_transfer.approved', { state: 'APPROVED', manifestId: manifest.id }, approvedAt)] };
}

export function submitTransfer(transfer: ArchiveTransfer, submittedAt: Date): TransferMutation {
  if (transfer.state !== 'APPROVED') invalidTransition('archive_transfer', transfer.state, 'submitTransfer');
  const next = { ...transfer, state: 'SUBMITTED' as const };
  return { aggregate: next, events: [event(transfer.id, 'archive_transfer.submitted', { state: 'SUBMITTED' }, submittedAt)] };
}

export function beginPreservation(transfer: ArchiveTransfer, startedAt: Date): TransferMutation {
  if (transfer.state !== 'SUBMITTED') invalidTransition('archive_transfer', transfer.state, 'beginPreservation');
  const next = { ...transfer, state: 'PRESERVING' as const };
  return { aggregate: next, events: [event(transfer.id, 'archive_transfer.preserving', { state: 'PRESERVING' }, startedAt)] };
}

export function completeArchiveTransfer(transfer: ArchiveTransfer, completedAt: Date): TransferMutation {
  if (transfer.state !== 'PRESERVING') invalidTransition('archive_transfer', transfer.state, 'completeArchiveTransfer');
  const next = { ...transfer, state: 'COMPLETED' as const };
  return { aggregate: next, events: [event(transfer.id, 'archive_transfer.completed', { state: 'COMPLETED' }, completedAt)] };
}

export function failTransfer(transfer: ArchiveTransfer, reason: string, failedAt: Date): TransferMutation {
  if (transfer.state !== 'SUBMITTED' && transfer.state !== 'PRESERVING') invalidTransition('archive_transfer', transfer.state, 'failTransfer');
  reason = requireNonBlank(reason, 'Transfer failure reason');
  const next = { ...transfer, state: 'FAILED' as const };
  return { aggregate: next, events: [event(transfer.id, 'archive_transfer.failed', { state: 'FAILED', reason }, failedAt)] };
}

export function retryFailedTransfer(transfer: ArchiveTransfer, retriedAt: Date): TransferMutation {
  if (transfer.state !== 'FAILED') invalidTransition('archive_transfer', transfer.state, 'retryFailedTransfer');
  const next = { ...transfer, state: 'SUBMITTED' as const };
  return { aggregate: next, events: [event(transfer.id, 'archive_transfer.retried', { state: 'SUBMITTED' }, retriedAt)] };
}

export function cancelTransfer(transfer: ArchiveTransfer, reason: string, cancellationIsSafe: boolean, cancelledAt: Date): TransferMutation {
  if (transfer.state === 'COMPLETED' || transfer.state === 'CANCELLED') invalidTransition('archive_transfer', transfer.state, 'cancelTransfer');
  if (!cancellationIsSafe) throw new DomainInvariantError('CANCELLATION_NOT_SAFE', 'A transfer cannot be cancelled after irreversible preservation work');
  reason = requireNonBlank(reason, 'Cancellation reason');
  const next = { ...transfer, state: 'CANCELLED' as const };
  return { aggregate: next, events: [event(transfer.id, 'archive_transfer.cancelled', { state: 'CANCELLED', reason }, cancelledAt)] };
}

export interface DraftManifestInput {
  readonly id: ManifestId;
  readonly institutionId: InstitutionId;
  readonly transferId: TransferId;
  readonly canonicalJson: string;
}

export interface ManifestApprovalInput {
  readonly approvedBy: UserId;
  readonly approvedAt: Date;
  readonly sha256: string;
}

export interface DraftManifest {
  readonly id: ManifestId;
  readonly institutionId: InstitutionId;
  readonly transferId: TransferId;
  readonly state: 'DRAFT';
  readonly canonicalJson: string;
}

export interface ApprovedManifest {
  readonly id: ManifestId;
  readonly institutionId: InstitutionId;
  readonly transferId: TransferId;
  readonly state: 'APPROVED';
  readonly canonicalJson: string;
  readonly sha256: string;
  readonly approvedBy: UserId;
  readonly approvedAt: Date;
}

export function createDraftManifest(input: DraftManifestInput): DraftManifest {
  if (input.canonicalJson.trim().length === 0) throw new DomainInvariantError('EMPTY_MANIFEST', 'Manifest JSON cannot be empty');
  return { ...input, state: 'DRAFT' };
}

export function approveManifest(manifest: DraftManifest | ApprovedManifest, input: ManifestApprovalInput): ApprovedManifest {
  if (manifest.state !== 'DRAFT') throw new DomainInvariantError('MANIFEST_IMMUTABLE', 'Approved manifests are immutable and cannot be approved again');
  if (!/^[0-9a-f]{64}$/i.test(input.sha256)) throw new DomainInvariantError('INVALID_SHA256', 'Manifest SHA-256 must contain 64 hexadecimal characters');
  return { ...manifest, state: 'APPROVED', ...input, sha256: input.sha256.toLowerCase() };
}

export function assertArchiveTransferState(state: string): ArchiveTransferState {
  const states: readonly ArchiveTransferState[] = ['DRAFT', 'APPROVED', 'SUBMITTED', 'PRESERVING', 'COMPLETED', 'FAILED', 'CANCELLED'];
  if (!states.includes(state as ArchiveTransferState)) throw new DomainInvariantError('INVALID_STATE', `Unknown archive transfer state ${state}`);
  return state as ArchiveTransferState;
}
