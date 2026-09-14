import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import {
  DocumentErrorSchema, DocumentIdParamsSchema, DocumentUploadResponseSchema,
  DocumentVersionContentParamsSchema,
  DocumentVersionsResponseSchema, MatterDocumentParamsSchema, MatterDocumentsResponseSchema,
  ExpedienteDocumentParamsSchema, ExpedienteDocumentsResponseSchema,
  type DocumentResponse, type DocumentVersionResponse,
} from '@ici/contracts';
import {
  acceptMatterDocumentUploadAtomically, acceptMatterDocumentVersionUploadAtomically,
  acceptExpedienteDocumentUploadAtomically, acceptExpedienteDocumentVersionUploadAtomically,
  authorizeMatterDocumentUploadPreflight,
  authorizeExpedienteDocumentUploadPreflight, authorizeDocumentVersionUploadPreflight, authorizeDocumentVersionDownload,
  findMatterDocumentsAuthorized, findExpedienteDocumentsAuthorized, findDocumentVersionsAuthorized, findDocumentVersions, type Database,
} from '@ici/database';
import type { AuthenticatedPrincipal } from './auth.js';
import { createAuthenticationGuard, type AuthenticateRequest } from './auth-plugin.js';
import {
  assertAllowedDetectedMimeType, DocumentSizeLimitError, documentStorageKey,
  type DocumentMimeDetector, type DocumentStoragePort,
  UnsupportedDocumentMimeError,
  FileTypeDocumentMimeDetector,
} from '@ici/integration-storage';

const DEFAULT_MAX_BYTES = 500n * 1024n * 1024n;
const HARD_MAX_BYTES = 2n * 1024n * 1024n * 1024n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DocumentApplicationDependencies {
  readonly database: Database;
  readonly storage: DocumentStoragePort;
  readonly authenticate: AuthenticateRequest;
  readonly maxBytes?: bigint;
  readonly detector?: DocumentMimeDetector;
}

export class DocumentHttpError extends Error {
  public constructor(readonly statusCode: 400 | 403 | 404 | 409 | 415, readonly code: 'INVALID_REQUEST' | 'FORBIDDEN' | 'DOCUMENT_NOT_FOUND' | 'MATTER_NOT_FOUND' | 'DOCUMENT_NOT_AVAILABLE' | 'DOCUMENT_STATE_CONFLICT' | 'UNSUPPORTED_MEDIA_TYPE', message: string) {
    super(message);
    this.name = 'DocumentHttpError';
  }
}

interface UploadResult {
  readonly filename: string;
  readonly declaredMimeType: string | undefined;
  readonly sizeBytes: string;
  readonly sha256: string;
  readonly detectedMimeType: string;
}

export async function installDocumentRoutes(app: FastifyInstance, dependencies: DocumentApplicationDependencies): Promise<void> {
  const configuredMax = dependencies.maxBytes ?? DEFAULT_MAX_BYTES;
  if (configuredMax < 0n || configuredMax > HARD_MAX_BYTES) throw new Error('Document maximum must be between zero and the hard safety ceiling');
  const configuredDependencies = { ...dependencies, maxBytes: configuredMax, detector: dependencies.detector ?? new FileTypeDocumentMimeDetector() };
  await app.register(multipart, { limits: { files: 2, parts: 10, fileSize: Number(HARD_MAX_BYTES) } });
  const guard = createAuthenticationGuard(dependencies.authenticate);
  const preHandler = (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void => { void guard(request, reply).then(() => { if (!reply.sent) done(); }).catch(done); };
  const errors = { 400: DocumentErrorSchema, 401: DocumentErrorSchema, 403: DocumentErrorSchema, 404: DocumentErrorSchema, 409: DocumentErrorSchema, 415: DocumentErrorSchema } as const;

  app.post<{ Params: { matterId: string } }>('/matters/:matterId/documents', { preHandler, schema: { params: MatterDocumentParamsSchema, response: { 202: DocumentUploadResponseSchema, ...errors } } }, async (request, reply) => {
    const principal = request.principal;
    try { await authorizeMatterDocumentUploadPreflight(dependencies.database, { institutionId: principal.institutionId, matterId: request.params.matterId, authorizationContext: principal.authorization, actorUserId: principal.userId }); } catch (error) { throw mapDocumentError(error); }
    const versionId = randomUUID();
    const storageKey = documentStorageKey(principal.institutionId, versionId);
    let parsed;
    try { parsed = await processUpload(request, configuredDependencies, storageKey); } catch (error) { throw mapDocumentError(error); }
    const fields = parsed.fields;
    if (fields.documentType === undefined || fields.title === undefined) { await safeRemove(dependencies.storage, storageKey); throw new DocumentHttpError(400, 'INVALID_REQUEST', 'documentType and title are required'); }
    const upload = parsed.upload;
    let accepted;
    try {
      accepted = await acceptMatterDocumentUploadAtomically(dependencies.database, {
        documentId: randomUUID(), versionId, institutionId: principal.institutionId, matterId: request.params.matterId,
        documentType: fields.documentType, title: fields.title, originalFilename: upload.filename,
        detectedMimeType: upload.detectedMimeType, ...(upload.declaredMimeType === undefined ? {} : { declaredMimeType: upload.declaredMimeType }),
        sizeBytes: upload.sizeBytes, sha256: upload.sha256, storageKey, malwareScanStatus: 'PENDING_SCAN', createdBy: principal.userId,
        correlationId: request.id, authorizationContext: principal.authorization,
      });
    } catch (error) {
      await safeRemove(dependencies.storage, storageKey);
      throw mapDocumentError(error);
    }
    return reply.code(202).send({ document: toDocumentResponse({ document: accepted.document, versions: [accepted.version] }), version: toVersionResponse(accepted.version) });
  });

  app.post<{ Params: { expedienteId: string } }>('/expedientes/:expedienteId/documents', { preHandler, schema: { params: ExpedienteDocumentParamsSchema, response: { 202: DocumentUploadResponseSchema, ...errors } } }, async (request, reply) => {
    const principal = request.principal;
    const versionId = randomUUID();
    const storageKey = documentStorageKey(principal.institutionId, versionId);
    let fields: { documentType?: string; title?: string; replacementReason?: string; accessClassificationId?: string } = {};
    let parsed;
    let committed = false;
    try {
      parsed = await processUpload(request, configuredDependencies, storageKey, async (currentFields) => {
        fields = currentFields;
        if (fields.documentType === undefined || fields.title === undefined || fields.accessClassificationId === undefined || fields.replacementReason !== undefined) throw new DocumentHttpError(400, 'INVALID_REQUEST', 'Expediente document metadata is invalid');
        await authorizeExpedienteDocumentUploadPreflight(dependencies.database, { institutionId: principal.institutionId, expedienteId: request.params.expedienteId, accessClassificationId: fields.accessClassificationId, authorizationContext: principal.authorization, actorUserId: principal.userId });
      });
      fields = parsed.fields;
      if (fields.documentType === undefined || fields.title === undefined || fields.accessClassificationId === undefined || fields.replacementReason !== undefined) { await safeRemove(dependencies.storage, storageKey); throw new DocumentHttpError(400, 'INVALID_REQUEST', 'Expediente document metadata is invalid'); }
      const accepted = await acceptExpedienteDocumentUploadAtomically(dependencies.database, { documentId: randomUUID(), versionId, institutionId: principal.institutionId, expedienteId: request.params.expedienteId, documentType: fields.documentType, title: fields.title, accessClassificationId: fields.accessClassificationId, originalFilename: parsed.upload.filename, detectedMimeType: parsed.upload.detectedMimeType, ...(parsed.upload.declaredMimeType === undefined ? {} : { declaredMimeType: parsed.upload.declaredMimeType }), sizeBytes: parsed.upload.sizeBytes, sha256: parsed.upload.sha256, storageKey, malwareScanStatus: 'PENDING_SCAN', createdBy: principal.userId, correlationId: request.id, authorizationContext: principal.authorization });
      committed = true;
      return reply.code(202).send({ document: toDocumentResponse({ document: accepted.document, versions: [accepted.version] }), version: toVersionResponse(accepted.version) });
    } catch (error) {
      // Cleanup is only performed before acceptance succeeds. Once acceptance returns, the object is durable evidence.
      if (!committed) await safeRemove(dependencies.storage, storageKey);
      throw mapDocumentError(error);
    }
  });

  app.post<{ Params: { documentId: string } }>('/documents/:documentId/versions', { preHandler, schema: { params: DocumentIdParamsSchema, response: { 202: DocumentUploadResponseSchema, ...errors } } }, async (request, reply) => {
    const principal = request.principal;
    let owner;
    try { owner = await authorizeDocumentVersionUploadPreflight(dependencies.database, { institutionId: principal.institutionId, documentId: request.params.documentId, authorizationContext: principal.authorization, actorUserId: principal.userId }); } catch (error) { throw mapDocumentError(error); }
    const versionId = randomUUID();
    const storageKey = documentStorageKey(principal.institutionId, versionId);
    let parsed;
    try { parsed = await processUpload(request, configuredDependencies, storageKey); } catch (error) { throw mapDocumentError(error); }
    const fields = parsed.fields;
    if (fields.replacementReason === undefined) { await safeRemove(dependencies.storage, storageKey); throw new DocumentHttpError(400, 'INVALID_REQUEST', 'replacementReason is required'); }
    const upload = parsed.upload;
    let accepted;
    try {
      accepted = owner === 'MATTER' ? await acceptMatterDocumentVersionUploadAtomically(dependencies.database, {
        documentId: request.params.documentId, versionId, institutionId: principal.institutionId, originalFilename: upload.filename,
        detectedMimeType: upload.detectedMimeType, ...(upload.declaredMimeType === undefined ? {} : { declaredMimeType: upload.declaredMimeType }),
        sizeBytes: upload.sizeBytes, sha256: upload.sha256, storageKey, malwareScanStatus: 'PENDING_SCAN', createdBy: principal.userId,
        replacementReason: fields.replacementReason, correlationId: request.id, authorizationContext: principal.authorization,
      }) : await acceptExpedienteDocumentVersionUploadAtomically(dependencies.database, {
        documentId: request.params.documentId, versionId, institutionId: principal.institutionId, originalFilename: upload.filename,
        detectedMimeType: upload.detectedMimeType, ...(upload.declaredMimeType === undefined ? {} : { declaredMimeType: upload.declaredMimeType }),
        sizeBytes: upload.sizeBytes, sha256: upload.sha256, storageKey, malwareScanStatus: 'PENDING_SCAN', createdBy: principal.userId,
        replacementReason: fields.replacementReason, correlationId: request.id, authorizationContext: principal.authorization,
      });
    } catch (error) {
      await safeRemove(dependencies.storage, storageKey);
      throw mapDocumentError(error);
    }
    const model = await findDocumentVersions(dependencies.database, principal.institutionId, request.params.documentId);
    if (model === undefined) throw new DocumentHttpError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    return reply.code(202).send({ document: toDocumentResponse(model), version: toVersionResponse(accepted.version) });
  });

  app.get<{ Params: { matterId: string } }>('/matters/:matterId/documents', { preHandler, schema: { params: MatterDocumentParamsSchema, response: { 200: MatterDocumentsResponseSchema, ...errors } } }, async (request) => {
    let models;
    try { models = await findMatterDocumentsAuthorized(dependencies.database, { institutionId: request.principal.institutionId, matterId: request.params.matterId, authorizationContext: request.principal.authorization }); }
    catch (error) { throw mapDocumentError(error); }
    if (models === undefined) throw new DocumentHttpError(404, 'MATTER_NOT_FOUND', 'Matter not found');
    return { items: models.map(toDocumentResponse) };
  });

  app.get<{ Params: { expedienteId: string } }>('/expedientes/:expedienteId/documents', { preHandler, schema: { params: ExpedienteDocumentParamsSchema, response: { 200: ExpedienteDocumentsResponseSchema, ...errors } } }, async (request) => {
    try {
      const models = await findExpedienteDocumentsAuthorized(dependencies.database, { institutionId: request.principal.institutionId, expedienteId: request.params.expedienteId, authorizationContext: request.principal.authorization });
      if (models === undefined) throw new DocumentHttpError(404, 'DOCUMENT_NOT_FOUND', 'Expediente not found');
      return { items: models.map(toDocumentResponse) };
    } catch (error) { throw mapDocumentError(error); }
  });

  app.get<{ Params: { documentId: string } }>('/documents/:documentId/versions', { preHandler, schema: { params: DocumentIdParamsSchema, response: { 200: DocumentVersionsResponseSchema, ...errors } } }, async (request) => {
    let model;
    try { model = await findDocumentVersionsAuthorized(dependencies.database, { institutionId: request.principal.institutionId, documentId: request.params.documentId, authorizationContext: request.principal.authorization }); }
    catch (error) { throw mapDocumentError(error); }
    if (model === undefined) throw new DocumentHttpError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    return { items: model.versions.map(toVersionResponse) };
  });

  app.get<{ Params: { versionId: string } }>('/document-versions/:versionId/content', { preHandler, schema: { params: DocumentVersionContentParamsSchema, response: { 400: DocumentErrorSchema, 401: DocumentErrorSchema, 403: DocumentErrorSchema, 404: DocumentErrorSchema, 409: DocumentErrorSchema } } }, async (request, reply) => {
    try {
      const version = await findVersionDocument(dependencies.database, request.principal, request.params.versionId);
      let stream: ReadableStream<Uint8Array>;
      try { stream = await dependencies.storage.open({ zone: 'CLEAN', key: version.storageKey }); }
      catch { throw new DocumentHttpError(409, 'DOCUMENT_NOT_AVAILABLE', 'Document is not available'); }
      reply.header('Content-Disposition', `attachment; filename="${safeFilename(version.originalFilename)}"`);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Type', version.detectedMimeType);
      reply.header('Content-Length', version.sizeBytes);
      return reply.send(Readable.fromWeb(stream));
    } catch (error) { throw mapDocumentError(error); }
  });
}

async function processUpload(request: FastifyRequest, dependencies: DocumentApplicationDependencies, key: string, beforeStorage?: (fields: { documentType?: string; title?: string; replacementReason?: string; accessClassificationId?: string }) => Promise<void>): Promise<{ fields: { documentType?: string; title?: string; replacementReason?: string; accessClassificationId?: string }; upload: UploadResult }> {
  const fields: { documentType?: string; title?: string; replacementReason?: string; accessClassificationId?: string } = {};
  let upload: UploadResult | undefined;
  let temporaryDirectory: string | undefined;
  let temporaryPath: string | undefined;
  let inspected: Awaited<ReturnType<typeof streamToTemporaryFile>> | undefined;
  for await (const part of request.parts()) {
    if (part.type === 'field') {
      if (part.fieldname === 'documentType' || part.fieldname === 'title' || part.fieldname === 'replacementReason' || part.fieldname === 'accessClassificationId') {
        const value = String(part.value).trim();
        const limit = part.fieldname === 'documentType' ? 200 : part.fieldname === 'title' ? 1000 : part.fieldname === 'replacementReason' ? 4000 : 100;
        if (value.length === 0 || value.length > limit) { if (upload !== undefined) await safeRemove(dependencies.storage, key); if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true }); throw new DocumentHttpError(400, 'INVALID_REQUEST', 'Multipart field is invalid'); }
        if (part.fieldname === 'accessClassificationId' && !UUID_PATTERN.test(value)) { if (upload !== undefined) await safeRemove(dependencies.storage, key); if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true }); throw new DocumentHttpError(400, 'INVALID_REQUEST', 'Access classification is invalid'); }
        fields[part.fieldname] = value;
      }
      continue;
    }
    if (upload !== undefined) { part.file.resume(); await safeRemove(dependencies.storage, key); if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true }); throw new DocumentHttpError(400, 'INVALID_REQUEST', 'Exactly one file is required'); }
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ici-document-'));
    temporaryPath = join(temporaryDirectory, 'upload.bin');
    try {
      inspected = await streamToTemporaryFile(part, temporaryPath, dependencies.maxBytes ?? DEFAULT_MAX_BYTES, dependencies.detector);
      assertAllowedDetectedMimeType(inspected.detectedMimeType);
      upload = { filename: part.filename, declaredMimeType: part.mimetype === '' ? undefined : part.mimetype, sizeBytes: inspected.sizeBytes.toString(), sha256: inspected.sha256, detectedMimeType: inspected.detectedMimeType };
    } catch (error) {
      await safeRemove(dependencies.storage, key);
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  if (upload === undefined) throw new DocumentHttpError(400, 'INVALID_REQUEST', 'Exactly one file is required');
  try {
    if (beforeStorage !== undefined) await beforeStorage(fields);
    if (temporaryPath === undefined || inspected === undefined) throw new DocumentHttpError(400, 'INVALID_REQUEST', 'Exactly one file is required');
    await dependencies.storage.put({ zone: 'QUARANTINE', key, body: Readable.toWeb(createReadStream(temporaryPath)) as ReadableStream<Uint8Array>, sha256: inspected.sha256 });
  } catch (error) {
    await safeRemove(dependencies.storage, key);
    throw error;
  } finally {
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return { fields, upload };
}

async function streamToTemporaryFile(part: { readonly file: Readable & { readonly truncated?: boolean } }, path: string, maxBytes: bigint, detector?: DocumentMimeDetector): Promise<{ readonly sizeBytes: bigint; readonly sha256: string; readonly detectedMimeType: string | undefined }> {
  const output = createWriteStream(path, { flags: 'wx' });
  const hash = createHash('sha256');
  const sniffParts: Uint8Array[] = [];
  let sniffed = 0;
  let sizeBytes = 0n;
  try {
    for await (const chunk of part.file as unknown as AsyncIterable<unknown>) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk instanceof Uint8Array ? chunk : (() => { throw new Error('Multipart stream yielded an invalid chunk'); })();
      sizeBytes += BigInt(bytes.byteLength);
      if (sizeBytes > maxBytes) throw new DocumentSizeLimitError(maxBytes);
      hash.update(bytes);
      if (sniffed < 4100) { const partBytes = bytes.subarray(0, Math.min(bytes.byteLength, 4100 - sniffed)); sniffParts.push(Uint8Array.from(partBytes)); sniffed += partBytes.byteLength; }
      if (!output.write(bytes)) await once(output, 'drain');
    }
    if (part.file.truncated === true) throw new DocumentSizeLimitError(maxBytes);
    await new Promise<void>((resolve, reject) => { output.end((error?: Error | null) => error == null ? resolve() : reject(error)); });
  } catch (error) {
    output.destroy();
    throw error;
  }
  const sniff = new Uint8Array(sniffed);
  let offset = 0;
  for (const piece of sniffParts) { sniff.set(piece, offset); offset += piece.byteLength; }
  return { sizeBytes, sha256: hash.digest('hex'), detectedMimeType: detector === undefined ? undefined : await detector.detect(sniff) };
}

function toVersionResponse(version: { id: string; document_id: string; version_number: number; original_filename: string; detected_mime_type: string; declared_mime_type: string | null; size_bytes: string; sha256: string; storage_key: string; malware_scan_status: DocumentVersionResponse['malwareScanStatus']; created_by: string; created_at: Date | string; replacement_reason: string | null }): DocumentVersionResponse {
  return { id: version.id, documentId: version.document_id, versionNumber: version.version_number, originalFilename: version.original_filename, detectedMimeType: version.detected_mime_type, declaredMimeType: version.declared_mime_type, sizeBytes: String(version.size_bytes), sha256: version.sha256, malwareScanStatus: version.malware_scan_status, createdBy: version.created_by, createdAt: new Date(version.created_at).toISOString(), replacementReason: version.replacement_reason };
}

function toDocumentResponse(model: { document: { id: string; matter_id: string | null; expediente_id: string | null; document_type: string; title: string; current_version_id: string | null; access_classification_id: string | null; created_at: Date | string; updated_at: Date | string }; versions: readonly Parameters<typeof toVersionResponse>[0][] }): DocumentResponse {
  if ((model.document.matter_id === null) === (model.document.expediente_id === null)) throw new Error('Invalid document parent invariant');
  return { id: model.document.id, matterId: model.document.matter_id, expedienteId: model.document.expediente_id, documentType: model.document.document_type, title: model.document.title, currentVersionId: model.document.current_version_id, accessClassificationId: model.document.access_classification_id, createdAt: new Date(model.document.created_at).toISOString(), updatedAt: new Date(model.document.updated_at).toISOString(), versions: model.versions.map(toVersionResponse) };
}

async function findVersionDocument(database: Database, principal: AuthenticatedPrincipal, versionId: string): Promise<{ storageKey: string; originalFilename: string; detectedMimeType: string; sizeBytes: string }> {
  const result = await authorizeDocumentVersionDownload(database, { institutionId: principal.institutionId, versionId, authorizationContext: principal.authorization });
  return { storageKey: result.storageKey, originalFilename: result.originalFilename, detectedMimeType: result.detectedMimeType, sizeBytes: result.sizeBytes };
}

async function safeRemove(storage: DocumentStoragePort, key: string): Promise<void> { try { await storage.remove({ zone: 'QUARANTINE', key }); } catch { /* cleanup is best effort */ } }
function mapDocumentError(error: unknown): Error {
  if (error instanceof DocumentHttpError) return error;
  const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
  if (code === 'NOT_AUTHORIZED' || code === 'AUTHORIZATION_CONTEXT_REQUIRED') return new DocumentHttpError(403, 'FORBIDDEN', 'Access denied');
  if (code === 'DOCUMENT_NOT_AVAILABLE') return new DocumentHttpError(409, 'DOCUMENT_NOT_AVAILABLE', 'Document is not available');
  if (code === 'MATTER_NOT_OPEN' || code === 'EXPEDIENTE_NOT_OPEN') return new DocumentHttpError(409, 'DOCUMENT_STATE_CONFLICT', 'Parent state changed during document intake');
  if (code === 'ACCESS_CLASSIFICATION_REQUIRED' || code === 'ACCESS_CLASSIFICATION_NOT_FOUND' || code === 'INCONSISTENT_ACCESS_CLASSIFICATION') return new DocumentHttpError(400, 'INVALID_REQUEST', 'Access classification is invalid');
  if (code === 'DOCUMENT_NOT_FOUND' || (error instanceof Error && error.message === 'Document not found')) return new DocumentHttpError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
  if (code === 'EXPEDIENTE_NOT_FOUND' || (error instanceof Error && error.message === 'Expediente not found')) return new DocumentHttpError(404, 'DOCUMENT_NOT_FOUND', 'Expediente not found');
  if (code === 'MATTER_NOT_FOUND' || (error instanceof Error && error.message === 'Matter not found')) return new DocumentHttpError(404, 'MATTER_NOT_FOUND', 'Matter not found');
  if (code === 'INVALID_DOCUMENT_METADATA' || code === 'REPLACEMENT_REASON_REQUIRED' || code === 'INVALID_SIZE' || code === 'INVALID_SHA256') return new DocumentHttpError(400, 'INVALID_REQUEST', 'Document metadata is invalid');
  if (error instanceof UnsupportedDocumentMimeError) return new DocumentHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Document media type is not supported');
  if (error instanceof DocumentSizeLimitError) return new DocumentHttpError(400, 'INVALID_REQUEST', 'Document exceeds the configured size limit');
  return error instanceof Error ? error : new Error('Document operation failed');
}
function safeFilename(filename: string): string { return filename.replace(/[\\"\r\n]/g, '_'); }
