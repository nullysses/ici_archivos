import { Type, type Static } from '@sinclair/typebox';

const Uuid = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const ErrorSchema = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String() }) }, { additionalProperties: false });

export const DocumentIdParamsSchema = Type.Object({ documentId: Uuid }, { additionalProperties: false, $id: 'DocumentIdParams' });
export const MatterDocumentParamsSchema = Type.Object({ matterId: Uuid }, { additionalProperties: false, $id: 'MatterDocumentParams' });
export const DocumentVersionContentParamsSchema = Type.Object({ versionId: Uuid }, { additionalProperties: false, $id: 'DocumentVersionContentParams' });

export const DocumentUploadFieldsSchema = Type.Object({
  documentType: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.String({ minLength: 1, maxLength: 1000 }),
}, { additionalProperties: false, $id: 'DocumentUploadFields' });
export type DocumentUploadFields = Static<typeof DocumentUploadFieldsSchema>;

export const DocumentVersionUploadFieldsSchema = Type.Object({ replacementReason: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false, $id: 'DocumentVersionUploadFields' });
export type DocumentVersionUploadFields = Static<typeof DocumentVersionUploadFieldsSchema>;

export const DocumentVersionResponseSchema = Type.Object({
  id: Uuid,
  documentId: Uuid,
  versionNumber: Type.Integer({ minimum: 1 }),
  originalFilename: Type.String(),
  detectedMimeType: Type.String(),
  declaredMimeType: Type.Union([Type.String(), Type.Null()]),
  sizeBytes: Type.String({ pattern: '^[0-9]+$' }),
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  storageKey: Type.String(),
  malwareScanStatus: Type.Union([Type.Literal('PENDING_SCAN'), Type.Literal('CLEAN'), Type.Literal('INFECTED'), Type.Literal('SCAN_FAILED'), Type.Literal('QUARANTINED')]),
  createdBy: Uuid,
  createdAt: DateTime,
  replacementReason: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type DocumentVersionResponse = Static<typeof DocumentVersionResponseSchema>;

export const DocumentResponseSchema = Type.Object({
  id: Uuid,
  matterId: Uuid,
  documentType: Type.String(),
  title: Type.String(),
  currentVersionId: Type.Union([Uuid, Type.Null()]),
  accessClassificationId: Type.Union([Uuid, Type.Null()]),
  createdAt: DateTime,
  updatedAt: DateTime,
  versions: Type.Array(DocumentVersionResponseSchema),
}, { additionalProperties: false });
export type DocumentResponse = Static<typeof DocumentResponseSchema>;

export const MatterDocumentsResponseSchema = Type.Object({ items: Type.Array(DocumentResponseSchema) }, { additionalProperties: false, $id: 'MatterDocumentsResponse' });
export type MatterDocumentsResponse = Static<typeof MatterDocumentsResponseSchema>;
export const DocumentVersionsResponseSchema = Type.Object({ items: Type.Array(DocumentVersionResponseSchema) }, { additionalProperties: false, $id: 'DocumentVersionsResponse' });
export type DocumentVersionsResponse = Static<typeof DocumentVersionsResponseSchema>;
export const DocumentUploadResponseSchema = Type.Object({ document: DocumentResponseSchema, version: DocumentVersionResponseSchema }, { additionalProperties: false, $id: 'DocumentUploadResponse' });
export type DocumentUploadResponse = Static<typeof DocumentUploadResponseSchema>;
export { ErrorSchema as DocumentErrorSchema };
