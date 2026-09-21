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

const ArchivalPathNodeSchema = Type.Object({
  id: Uuid,
  nodeType: Type.Union([Type.Literal('FONDS'), Type.Literal('SECTION'), Type.Literal('SERIES'), Type.Literal('SUBSERIES')]),
  code: Type.String(),
  name: Type.String(),
}, { additionalProperties: false });
export type ArchivalPathNode = Static<typeof ArchivalPathNodeSchema>;

const TransferInterventionSchema = Type.Object({
  kind: Type.Union([Type.Literal('USER_INPUT'), Type.Literal('RECONCILIATION'), Type.Literal('PRESERVATION_INTERVENTION'), Type.Literal('FAILURE')]),
  message: Type.String(),
}, { additionalProperties: false });
export type TransferIntervention = Static<typeof TransferInterventionSchema>;

const TransferEvidenceSchema = Type.Object({
  submissionStatus: Type.Union([Type.Literal('PENDING'), Type.Literal('SUBMITTED'), Type.Literal('RECONCILIATION_REQUIRED'), Type.Literal('FAILED')]),
  archivematicaTransferUuid: Type.Union([Uuid, Type.Null()]),
  sipUuid: Type.Union([Uuid, Type.Null()]),
  aipUuid: Type.Union([Uuid, Type.Null()]),
  dipUuid: Type.Union([Uuid, Type.Null()]),
  lastRemoteStatus: Type.Union([Type.String(), Type.Null()]),
  lastIngestStatus: Type.Union([Type.String(), Type.Null()]),
  lastCheckedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
}, { additionalProperties: false });
export type TransferEvidence = Static<typeof TransferEvidenceSchema>;

const TransferStagingSchema = Type.Object({
  status: Type.Union([Type.Literal('IN_PROGRESS'), Type.Literal('STAGED'), Type.Literal('RECONCILIATION_REQUIRED')]),
  locationUuid: Uuid,
  relativePath: Type.String(),
  manifestSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
}, { additionalProperties: false });
export type TransferStaging = Static<typeof TransferStagingSchema>;

const TransferActivitySchema = Type.Object({
  id: Uuid,
  eventType: Type.String(),
  occurredAt: Type.String({ format: 'date-time' }),
  actorUserId: Type.Union([Uuid, Type.Null()]),
}, { additionalProperties: false });
export type TransferActivity = Static<typeof TransferActivitySchema>;

const TransferJobSchema = Type.Object({
  status: Type.Union([Type.Literal('PENDING'), Type.Literal('RUNNING'), Type.Literal('SUCCEEDED'), Type.Literal('FAILED'), Type.Literal('CANCELLED')]),
  attemptCount: Type.Integer({ minimum: 0 }),
  lastError: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type TransferJob = Static<typeof TransferJobSchema>;

const AtomReferenceSchema = Type.Object({ id: Type.String({ pattern: '^[0-9]+$' }), slug: Type.String() }, { additionalProperties: false });
export type AtomReference = Static<typeof AtomReferenceSchema>;

const TransferQueueItemSchema = Type.Object({
  transferId: Uuid,
  expedienteId: Uuid,
  expedienteFolio: Type.String(),
  transferStatus: ArchiveTransferResponseSchema.properties.status,
  manifestStatus: TransferManifestSchema.properties.status,
  updatedAt: Type.String({ format: 'date-time' }),
  createdAt: Type.String({ format: 'date-time' }),
  category: Type.Union([Type.Literal('POR_APROBAR'), Type.Literal('EN_PRESERVACION'), Type.Literal('REQUIEREN_ATENCION'), Type.Literal('COMPLETADOS'), Type.Literal('OTROS')]),
  archivalPath: Type.Array(ArchivalPathNodeSchema),
  intervention: Type.Union([TransferInterventionSchema, Type.Null()]),
}, { additionalProperties: false });
export type ArchiveTransferQueueItem = Static<typeof TransferQueueItemSchema>;

export const ArchiveTransferQueueResponseSchema = Type.Object({
  readyForPreparation: Type.Array(Type.Object({ expedienteId: Uuid, expedienteFolio: Type.String(), status: Type.Literal('CLOSED'), archivalPath: Type.Array(ArchivalPathNodeSchema) }, { additionalProperties: false })),
  transfers: Type.Array(TransferQueueItemSchema),
}, { additionalProperties: false, $id: 'ArchiveTransferQueueResponse' });
export type ArchiveTransferQueueResponse = Static<typeof ArchiveTransferQueueResponseSchema>;

export const ArchiveTransferWorkspaceResponseSchema = Type.Object({
  transfer: ArchiveTransferResponseSchema,
  expediente: Type.Object({ id: Uuid, folio: Type.String(), status: Type.String() }, { additionalProperties: false }),
  archivalPath: Type.Array(ArchivalPathNodeSchema),
  atom: Type.Object({ parent: Type.Union([AtomReferenceSchema, Type.Null()]), file: Type.Union([AtomReferenceSchema, Type.Null()]) }, { additionalProperties: false }),
  evidence: Type.Union([TransferEvidenceSchema, Type.Null()]),
  staging: Type.Union([TransferStagingSchema, Type.Null()]),
  intervention: Type.Union([TransferInterventionSchema, Type.Null()]),
  job: Type.Union([TransferJobSchema, Type.Null()]),
  activity: Type.Array(TransferActivitySchema),
}, { additionalProperties: false, $id: 'ArchiveTransferWorkspaceResponse' });
export type ArchiveTransferWorkspaceResponse = Static<typeof ArchiveTransferWorkspaceResponseSchema>;
