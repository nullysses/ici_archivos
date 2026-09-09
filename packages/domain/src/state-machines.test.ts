import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  approveManifest,
  approveTransfer,
  assignMatter,
  beginPreservation,
  cancelTransfer,
  closeExpediente,
  closeMatter,
  completeArchiveTransfer,
  completeTransfer,
  createArchiveTransfer,
  createDocument,
  createDocumentVersion,
  createDraftManifest,
  createExpediente,
  createExpedienteTypeDraft,
  documentId,
  documentVersionId,
  entityId,
  expedienteId,
  expedienteTypeId,
  expedienteTypeVersionId,
  failTransfer,
  institutionId,
  linkMatterToExpediente,
  editExpedienteTypeDraft,
  manifestId,
  matterId,
  nextExpedienteTypeVersionNumber,
  organizationalUnitId,
  prepareTransfer,
  publishExpedienteTypeVersion,
  reassignMatter,
  reopenExpediente,
  reopenMatter,
  rejectTransfer,
  resolveMatter,
  retryFailedTransfer,
  startMatter,
  submitTransfer,
  transferId,
  userId,
  voidExpediente,
  voidMatter,
  registerMatter,
  type Expediente,
  type AuthorizationContext,
  type Matter,
  type ExpedienteTypeVersion,
} from './index.js';

const institution = institutionId('00000000-0000-4000-8000-000000000001');
  const user = userId('00000000-0000-4000-8000-000000000002');
const unit = organizationalUnitId('00000000-0000-4000-8000-000000000003');
const expediente = expedienteId('00000000-0000-4000-8000-000000000004');
const matter = matterId('00000000-0000-4000-8000-000000000005');
const now = new Date('2026-09-07T12:00:00.000Z');
const json = { subject: 'Test' };

function authorization(actor = user): AuthorizationContext {
  return { userId: actor, institutionId: institution, institutionCapabilities: new Set(), unitCapabilities: new Map() };
}

function registeredMatter(): Matter {
  return registerMatter({ id: matter, institutionId: institution, folio: 'OP-2026-000001', receivedAt: now, intake: json }).aggregate;
}

function assignedMatter(): Matter {
  return assignMatter(registeredMatter(), { assignmentId: entityId('00000000-0000-4000-8000-000000000006'), unitId: unit, userId: user, assignedAt: now }).aggregate;
}

function inProgressMatter(): Matter {
  return startMatter(assignedMatter(), { actorUserId: user, authorizationContext: authorization(), startedAt: now }).aggregate;
}

function resolvedMatter(): Matter {
  return resolveMatter(inProgressMatter(), { resolution: 'done' }, now).aggregate;
}

function publishedTypeVersion(): ExpedienteTypeVersion {
  const draft = createExpedienteTypeDraft({
    id: expedienteTypeVersionId('00000000-0000-4000-8000-000000000007'),
    institutionId: institution,
    expedienteTypeId: expedienteTypeId('00000000-0000-4000-8000-000000000008'),
    versionNumber: 1,
    schemaJson: { type: 'object' },
    archivalMappingJson: {},
    createdAt: now,
  });
  return publishExpedienteTypeVersion(draft, now);
}

function openExpediente(): Expediente {
  return createExpediente({ id: expediente, institutionId: institution, folio: 'EXP-2026-000001', expedienteTypeVersion: publishedTypeVersion(), metadata: {}, openedAt: now }, () => true).aggregate;
}

describe('matter lifecycle commands', () => {
  it('supports every valid matter transition', () => {
    const received = registeredMatter();
    const assigned = assignMatter(received, { assignmentId: entityId('00000000-0000-4000-8000-000000000009'), unitId: unit, userId: user, assignedAt: now }).aggregate;
    const reassigned = reassignMatter(assigned, { assignmentId: entityId('00000000-0000-4000-8000-000000000010'), unitId: unit, userId: user, reason: 'Changed owner', assignedAt: now }).aggregate;
    const started = startMatter(reassigned, { actorUserId: user, authorizationContext: authorization(), startedAt: now }).aggregate;
    const reassignedWhileWorking = reassignMatter(started, { assignmentId: entityId('00000000-0000-4000-8000-000000000018'), unitId: unit, userId: user, reason: 'Changed owner again', assignedAt: now }).aggregate;
    const restarted = startMatter(reassignedWhileWorking, { actorUserId: user, authorizationContext: authorization(), startedAt: now }).aggregate;
    const resolved = resolveMatter(restarted, { resolution: 'done' }, now).aggregate;
    const linked = linkMatterToExpediente(resolved, openExpediente(), now).aggregate;
    const reopened = reopenMatter(linked, 'Additional review', openExpediente(), now).aggregate;
    const resolvedAgain = resolveMatter(reopened, { resolution: 'done again' }, now).aggregate;
    const closed = closeMatter(resolvedAgain, expediente, { closedBy: user }, now).aggregate;

    expect(received.state).toBe('RECEIVED');
    expect(assigned.state).toBe('ASSIGNED');
    expect(reassigned.state).toBe('ASSIGNED');
    expect(started.state).toBe('IN_PROGRESS');
    expect(reassignedWhileWorking.state).toBe('ASSIGNED');
    expect(closed.state).toBe('CLOSED');
    expect(voidMatter(registeredMatter(), 'Registered in error', now).aggregate.state).toBe('VOIDED');
    expect(voidMatter(assignedMatter(), 'Assigned in error', now).aggregate.state).toBe('VOIDED');
  });

  it('rejects invalid and unauthorized matter transitions', () => {
    expect(() => startMatter(registeredMatter(), { actorUserId: user, authorizationContext: authorization(), startedAt: now })).toThrow(/not allowed/);
    expect(() => resolveMatter(assignedMatter(), { resolution: 'no' }, now)).toThrow(/not allowed/);
    const otherUser = userId('00000000-0000-4000-8000-000000000011');
    expect(() => startMatter(assignedMatter(), { actorUserId: otherUser, authorizationContext: authorization(otherUser), startedAt: now })).toThrow(/authorized member/i);
    expect(() => voidMatter(inProgressMatter(), 'wrong state', now)).toThrow(/not allowed/);
    expect(() => closeMatter(resolvedMatter(), expediente, {}, now)).toThrow(/closure metadata/i);
    expect(() => reassignMatter(assignedMatter(), { assignmentId: entityId('00000000-0000-4000-8000-000000000030'), unitId: unit, userId: user, reason: ' ', assignedAt: now })).toThrow(/reason/i);
    expect(() => reopenMatter(resolvedMatter(), 'Review', openExpediente(), now)).toThrow(/linked expediente/i);
    const closed = closeMatter(resolvedMatter(), expediente, { closedBy: user }, now).aggregate;
    expect(() => assignMatter(closed, { assignmentId: entityId('00000000-0000-4000-8000-000000000031'), unitId: unit, assignedAt: now })).toThrow(/not allowed/i);
  });
});

describe('expediente lifecycle commands', () => {
  it('supports every valid expediente transition', () => {
    const open = openExpediente();
    const closed = closeExpediente(open, { linkedMatterStates: ['CLOSED', 'VOIDED'], documentScanStatuses: ['CLEAN'], closedAt: now }).aggregate;
    const reopened = reopenExpediente(closed, 'Correction', false, now).aggregate;
    const closedAgain = closeExpediente(reopened, { linkedMatterStates: ['CLOSED'], documentScanStatuses: [], closedAt: now }).aggregate;
    const pending = prepareTransfer(closedAgain, true, true, now).aggregate;
    const rejected = rejectTransfer(pending, 'Needs review', now).aggregate;
    const pendingAgain = prepareTransfer(rejected, true, true, now).aggregate;
    const transferred = completeTransfer(pendingAgain, true, true, true, now).aggregate;

    expect(open.state).toBe('OPEN');
    expect(closed.state).toBe('CLOSED');
    expect(reopened.state).toBe('OPEN');
    expect(transferred.state).toBe('TRANSFERRED');
    expect(voidExpediente(openExpediente(), 'Created in error', false, now).aggregate.state).toBe('VOIDED');
  });

  it('requires clean documents, closed matters, and transfer prerequisites', () => {
    expect(() => closeExpediente(openExpediente(), { linkedMatterStates: ['IN_PROGRESS'], documentScanStatuses: [], closedAt: now })).toThrow(/matters/i);
    expect(() => closeExpediente(openExpediente(), { linkedMatterStates: [], documentScanStatuses: ['PENDING_SCAN'], closedAt: now })).toThrow(/clean/i);
    expect(() => reopenExpediente(openExpediente(), 'no', false, now)).toThrow(/not allowed/);
    const closed = closeExpediente(openExpediente(), { linkedMatterStates: [], documentScanStatuses: [], closedAt: now }).aggregate;
    expect(() => reopenExpediente(closed, ' ', false, now)).toThrow(/reason/i);
    expect(() => reopenExpediente(closed, 'Correction', true, now)).toThrow(/approval/i);
    expect(() => prepareTransfer(closed, false, true, now)).toThrow(/mapping/i);
    const pending = prepareTransfer(closed, true, true, now).aggregate;
    expect(() => rejectTransfer(pending, ' ', now)).toThrow(/reason/i);
    expect(() => completeTransfer(pending, true, false, true, now)).toThrow(/required/i);
    expect(() => completeTransfer(closed, true, true, true, now)).toThrow(/not allowed/);
    expect(() => voidExpediente(closed, 'wrong state', false, now)).toThrow(/not allowed/);
    expect(() => voidExpediente(openExpediente(), 'Created in error', true, now)).toThrow(/closed substantive matter/i);
  });
});

describe('versioning, documents, and transfer manifests', () => {
  it('publishes immutable type versions and pins expedientes', () => {
    const published = publishedTypeVersion();
    expect(() => publishExpedienteTypeVersion(published, now)).toThrow(/draft/i);
    expect(() => editExpedienteTypeDraft(published, { changed: true }, {})).toThrow(/immutable/i);
    expect(nextExpedienteTypeVersionNumber(published.versionNumber)).toBe(2);
    expect(createExpediente({ id: expediente, institutionId: institution, folio: 'EXP-2026-000001', expedienteTypeVersion: published, metadata: {}, openedAt: now }, () => true).aggregate.expedienteTypeVersionId).toBe(published.id);
    expect(() => createExpediente({ id: expediente, institutionId: institution, folio: 'EXP-2026-000001', expedienteTypeVersion: published, metadata: {}, openedAt: now }, () => false)).toThrow(/does not satisfy/i);
    expect(() => createExpediente({ id: expediente, institutionId: institutionId('00000000-0000-4000-8000-000000000099'), folio: 'EXP-2026-000001', expedienteTypeVersion: published, metadata: {}, openedAt: now }, () => true)).toThrow(/same institution/i);
  });

  it('numbers document versions monotonically and preserves prior versions', () => {
    const document = createDocument({ id: documentId('00000000-0000-4000-8000-000000000012'), institutionId: institution, expedienteId: expediente, documentType: 'PDF', title: 'Record', createdAt: now });
    const first = createDocumentVersion(document, true, { id: documentVersionId('00000000-0000-4000-8000-000000000013'), originalFilename: 'one.pdf', detectedMimeType: 'application/pdf', sizeBytes: 1n, sha256: 'a'.repeat(64), storageKey: 'one', malwareScanStatus: 'PENDING_SCAN', createdBy: user, createdAt: now });
    const second = createDocumentVersion(first.document, true, { id: documentVersionId('00000000-0000-4000-8000-000000000014'), originalFilename: 'two.pdf', detectedMimeType: 'application/pdf', sizeBytes: 2n, sha256: 'b'.repeat(64), storageKey: 'two', malwareScanStatus: 'PENDING_SCAN', createdBy: user, createdAt: now, replacementReason: 'Corrected scan' });
    expect(first.version.versionNumber).toBe(1);
    expect(second.version.versionNumber).toBe(2);
    expect(second.document.currentVersionId).toBe(second.version.id);
    expect(() => createDocumentVersion(second.document, true, { id: documentVersionId('00000000-0000-4000-8000-000000000015'), originalFilename: 'three.pdf', detectedMimeType: 'application/pdf', sizeBytes: 3n, sha256: 'c'.repeat(64), storageKey: 'three', malwareScanStatus: 'PENDING_SCAN', createdBy: user, createdAt: now })).toThrow(/reason/i);
  });

  it('keeps transfer state separate and freezes approved manifests', () => {
    const transfer = createArchiveTransfer({ id: transferId('00000000-0000-4000-8000-000000000016'), institutionId: institution, expedienteId: expediente, createdAt: now }).aggregate;
    expect(cancelTransfer(transfer, 'Cancelled before approval', true, now).aggregate.state).toBe('CANCELLED');
    const manifest = createDraftManifest({ id: manifestId('00000000-0000-4000-8000-000000000017'), institutionId: institution, transferId: transfer.id, canonicalJson: '{"transfer":true}' });
    const frozen = approveManifest(manifest, { approvedBy: user, approvedAt: now, sha256: createHash('sha256').update(manifest.canonicalJson).digest('hex') });
    const approved = approveTransfer(transfer, frozen, now).aggregate;
    const submitted = submitTransfer(approved, now).aggregate;
    const preserving = beginPreservation(submitted, now).aggregate;
    const failed = failTransfer(preserving, 'temporary outage', now).aggregate;
    const retried = retryFailedTransfer(failed, now).aggregate;
    const completed = completeArchiveTransfer(beginPreservation(retried, now).aggregate, now).aggregate;
    expect(completed.state).toBe('COMPLETED');
    expect(frozen.state).toBe('APPROVED');
    expect(() => approveManifest(frozen, { approvedBy: user, approvedAt: now, sha256: 'e'.repeat(64) })).toThrow(/immutable/i);
    expect(() => cancelTransfer(preserving, 'Too late', false, now)).toThrow(/irreversible/i);
    expect(() => submitTransfer(transfer, now)).toThrow(/not allowed/i);
    expect(() => retryFailedTransfer(transfer, now)).toThrow(/not allowed/i);
    expect(() => completeArchiveTransfer(submitted, now)).toThrow(/not allowed/i);
    expect(() => cancelTransfer(completed, 'Too late', true, now)).toThrow(/not allowed/i);
    expect(() => createArchiveTransfer({ id: transferId('00000000-0000-4000-8000-000000000019'), institutionId: institution, expedienteId: expediente, supplementsTransferId: transfer.id, createdAt: now })).toThrow(/correction reason/i);
  });
});
