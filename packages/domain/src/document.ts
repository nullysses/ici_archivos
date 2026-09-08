import { type Document, type DocumentVersion, type DocumentId, type DocumentVersionId, type ExpedienteId, type InstitutionId, type JsonObject, type MalwareScanStatus, type UserId, type DomainEvent, DomainInvariantError, requireNonBlank } from './types.js';

export interface CreateDocumentInput {
  readonly id: DocumentId;
  readonly institutionId: InstitutionId;
  readonly expedienteId: ExpedienteId;
  readonly documentType: string;
  readonly title: string;
  readonly createdAt: Date;
}

export function createDocument(input: CreateDocumentInput): Document {
  return { ...input, documentType: requireNonBlank(input.documentType, 'Document type'), title: requireNonBlank(input.title, 'Document title'), latestVersionNumber: 0 };
}

export interface CreateDocumentVersionInput {
  readonly id: DocumentVersionId;
  readonly originalFilename: string;
  readonly detectedMimeType: string;
  readonly declaredMimeType?: string;
  readonly sizeBytes: bigint;
  readonly sha256: string;
  readonly storageKey: string;
  readonly accessClassificationSnapshot?: JsonObject;
  readonly malwareScanStatus: MalwareScanStatus;
  readonly createdBy: UserId;
  readonly createdAt: Date;
  readonly replacementReason?: string;
}

export interface DocumentVersionMutation {
  readonly document: Document;
  readonly version: DocumentVersion;
  readonly events: readonly DomainEvent[];
}

export function createDocumentVersion(document: Document, expedienteIsOpen: boolean, input: CreateDocumentVersionInput): DocumentVersionMutation {
  if (!expedienteIsOpen) throw new DomainInvariantError('EXPEDIENTE_NOT_OPEN', 'Routine document version creation requires an open expediente');
  if (input.malwareScanStatus !== 'PENDING_SCAN') throw new DomainInvariantError('INVALID_INITIAL_SCAN_STATUS', 'A new document version must begin pending malware scan');
  if (document.latestVersionNumber > 0 && (input.replacementReason === undefined || input.replacementReason.trim().length === 0)) throw new DomainInvariantError('REPLACEMENT_REASON_REQUIRED', 'A replacement document version requires a reason');
  requireNonBlank(input.originalFilename, 'Original filename');
  requireNonBlank(input.detectedMimeType, 'Detected MIME type');
  requireNonBlank(input.storageKey, 'Storage key');
  if (input.sizeBytes < 0n) throw new DomainInvariantError('INVALID_SIZE', 'Document size cannot be negative');
  if (!/^[0-9a-f]{64}$/i.test(input.sha256)) throw new DomainInvariantError('INVALID_SHA256', 'Document SHA-256 must contain 64 hexadecimal characters');
  const version: DocumentVersion = {
    id: input.id,
    institutionId: document.institutionId,
    documentId: document.id,
    versionNumber: document.latestVersionNumber + 1,
    originalFilename: input.originalFilename,
    detectedMimeType: input.detectedMimeType,
    declaredMimeType: input.declaredMimeType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    storageKey: input.storageKey,
    accessClassificationSnapshot: input.accessClassificationSnapshot ?? { legalClassification: 'PUBLIC', operationalVisibility: 'INSTITUTION' },
    malwareScanStatus: input.malwareScanStatus,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
    replacementReason: input.replacementReason,
  };
  const nextDocument: Document = { ...document, currentVersionId: version.id, latestVersionNumber: version.versionNumber };
  const event: DomainEvent = { aggregateId: document.id, eventType: 'document.version_created', occurredAt: input.createdAt, payload: { versionId: version.id, versionNumber: version.versionNumber } };
  return { document: nextDocument, version, events: [event] };
}
