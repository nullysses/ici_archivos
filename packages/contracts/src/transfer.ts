import { Type, type Static } from '@sinclair/typebox';

const Uuid = Type.String({ format: 'uuid' });
const EmptyObject = Type.Object({}, { additionalProperties: false });

export const ArchiveTransferExpedienteParamsSchema = Type.Object({ expedienteId: Uuid }, { additionalProperties: false, $id: 'ArchiveTransferExpedienteParams' });
export type ArchiveTransferExpedienteParams = Static<typeof ArchiveTransferExpedienteParamsSchema>;

export const ArchiveTransferIdParamsSchema = Type.Object({ transferId: Uuid }, { additionalProperties: false, $id: 'ArchiveTransferIdParams' });
export type ArchiveTransferIdParams = Static<typeof ArchiveTransferIdParamsSchema>;

export const ArchiveTransferCreateRequestSchema = EmptyObject;
export type ArchiveTransferCreateRequest = Static<typeof ArchiveTransferCreateRequestSchema>;

export const ArchiveTransferApproveRequestSchema = EmptyObject;
export type ArchiveTransferApproveRequest = Static<typeof ArchiveTransferApproveRequestSchema>;

export const ArchiveTransferSubmitRequestSchema = EmptyObject;
export type ArchiveTransferSubmitRequest = Static<typeof ArchiveTransferSubmitRequestSchema>;

export const ArchiveTransferRetryRequestSchema = EmptyObject;
export type ArchiveTransferRetryRequest = Static<typeof ArchiveTransferRetryRequestSchema>;

export const ArchiveTransferCancelRequestSchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 4000 }),
}, { additionalProperties: false, $id: 'ArchiveTransferCancelRequest' });
export type ArchiveTransferCancelRequest = Static<typeof ArchiveTransferCancelRequestSchema>;

export const TransferManifestDocumentSchema = Type.Object({
  documentId: Uuid,
  versionId: Uuid,
  versionNumber: Type.Integer({ minimum: 1 }),
  filename: Type.String(),
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  sizeBytes: Type.String({ pattern: '^[0-9]+$' }),
  mimeType: Type.String(),
  current: Type.Boolean(),
}, { additionalProperties: false });
export type TransferManifestDocument = Static<typeof TransferManifestDocumentSchema>;

export const TransferManifestSchema = Type.Object({
  id: Uuid,
  transferId: Uuid,
  status: Type.Union([Type.Literal('DRAFT'), Type.Literal('APPROVED')]),
  canonicalJson: Type.String({ minLength: 1 }),
  sha256: Type.Union([Type.String({ pattern: '^[0-9a-f]{64}$' }), Type.Null()]),
  approvedBy: Type.Union([Uuid, Type.Null()]),
  approvedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  documents: Type.Array(TransferManifestDocumentSchema),
}, { additionalProperties: false, $id: 'TransferManifest' });
export type TransferManifest = Static<typeof TransferManifestSchema>;

export const ArchiveTransferResponseSchema = Type.Object({
  id: Uuid,
  expedienteId: Uuid,
  status: Type.Union([Type.Literal('DRAFT'), Type.Literal('APPROVED'), Type.Literal('SUBMITTED'), Type.Literal('PRESERVING'), Type.Literal('COMPLETED'), Type.Literal('FAILED'), Type.Literal('CANCELLED')]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  manifest: TransferManifestSchema,
}, { additionalProperties: false, $id: 'ArchiveTransferResponse' });
export type ArchiveTransferResponse = Static<typeof ArchiveTransferResponseSchema>;
