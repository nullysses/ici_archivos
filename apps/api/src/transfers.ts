import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ArchiveTransferApproveRequestSchema,
  ArchiveTransferCreateRequestSchema,
  ArchiveTransferExpedienteParamsSchema,
  ArchiveTransferIdParamsSchema,
  ArchiveTransferResponseSchema,
  ArchiveTransferSubmitRequestSchema,
  ArchiveTransferRetryRequestSchema,
  ArchiveTransferCancelRequestSchema,
  MatterErrorSchema,
  type ArchiveTransferApproveRequest,
  type ArchiveTransferCreateRequest,
  type ArchiveTransferExpedienteParams,
  type ArchiveTransferIdParams,
  type ArchiveTransferResponse,
  type ArchiveTransferSubmitRequest,
  type ArchiveTransferRetryRequest,
  type ArchiveTransferCancelRequest,
} from '@ici/contracts';
import {
  approveArchiveTransferManifestAtomically,
  cancelArchiveTransferAtomically,
  canPerform,
  createArchiveTransferAndDraftManifestAtomically,
  findArchiveTransferWithManifest,
  retryArchiveTransferAtomically,
  submitArchiveTransferAtomically,
  type ArchiveTransferReadModel,
  type Database,
} from '@ici/database';
import type { AuthenticatedPrincipal } from './auth.js';
import type { AuthenticateRequest } from './auth-plugin.js';
import { createAuthenticationGuard } from './auth-plugin.js';

export class TransferHttpError extends Error {
  public constructor(
    readonly statusCode: 400 | 403 | 404 | 409,
    readonly code: 'INVALID_REQUEST' | 'FORBIDDEN' | 'TRANSFER_NOT_FOUND' | 'INVALID_TRANSITION',
    message: string,
  ) {
    super(message);
    this.name = 'TransferHttpError';
  }
}

export interface ArchiveTransferApplicationService {
  create(input: { readonly institutionId: string; readonly expedienteId: string; readonly transferId: string; readonly manifestId: string; readonly actorUserId: string; readonly correlationId: string; readonly authorization: AuthenticatedPrincipal['authorization'] }): Promise<ArchiveTransferReadModel>;
  approve(input: { readonly institutionId: string; readonly transferId: string; readonly actorUserId: string; readonly correlationId: string; readonly authorization: AuthenticatedPrincipal['authorization'] }): Promise<ArchiveTransferReadModel>;
  submit(input: { readonly institutionId: string; readonly transferId: string; readonly actorUserId: string; readonly correlationId: string; readonly authorization: AuthenticatedPrincipal['authorization'] }): Promise<ArchiveTransferReadModel>;
  retry(input: { readonly institutionId: string; readonly transferId: string; readonly actorUserId: string; readonly correlationId: string; readonly authorization: AuthenticatedPrincipal['authorization'] }): Promise<ArchiveTransferReadModel>;
  cancel(input: { readonly institutionId: string; readonly transferId: string; readonly actorUserId: string; readonly reason: string; readonly correlationId: string; readonly authorization: AuthenticatedPrincipal['authorization'] }): Promise<ArchiveTransferReadModel>;
  byId(institutionId: string, transferId: string): Promise<ArchiveTransferReadModel | undefined>;
}

export function createArchiveTransferApplicationService(database: Database): ArchiveTransferApplicationService {
  return {
    create: (input) => createArchiveTransferAndDraftManifestAtomically(database, {
      institutionId: input.institutionId,
      expedienteId: input.expedienteId,
      transferId: input.transferId,
      manifestId: input.manifestId,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      authorizationContext: input.authorization,
    }),
    approve: (input) => approveArchiveTransferManifestAtomically(database, {
      institutionId: input.institutionId,
      transferId: input.transferId,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      authorizationContext: input.authorization,
    }),
    submit: (input) => submitArchiveTransferAtomically(database, {
      institutionId: input.institutionId,
      transferId: input.transferId,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      authorizationContext: input.authorization,
    }),
    retry: (input) => retryArchiveTransferAtomically(database, {
      institutionId: input.institutionId,
      transferId: input.transferId,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      authorizationContext: input.authorization,
    }),
    cancel: (input) => cancelArchiveTransferAtomically(database, {
      institutionId: input.institutionId,
      transferId: input.transferId,
      actorUserId: input.actorUserId,
      reason: input.reason,
      correlationId: input.correlationId,
      authorizationContext: input.authorization,
    }),
    byId: (institutionId, transferId) => findArchiveTransferWithManifest(database, { institutionId, transferId }),
  };
}

function authenticatedPreHandler(authenticate: AuthenticateRequest) {
  const guard = createAuthenticationGuard(authenticate);
  return (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void => {
    void guard(request, reply).then(() => { if (!reply.sent) done(); }).catch(done);
  };
}

export function installArchiveTransferRoutes(app: FastifyInstance, service: ArchiveTransferApplicationService, authenticate: AuthenticateRequest): void {
  const preHandler = authenticatedPreHandler(authenticate);
  const errors = { 400: MatterErrorSchema, 401: MatterErrorSchema, 403: MatterErrorSchema, 404: MatterErrorSchema, 409: MatterErrorSchema } as const;

  app.post<{ Params: ArchiveTransferExpedienteParams; Body: ArchiveTransferCreateRequest; Reply: ArchiveTransferResponse }>(
    '/expedientes/:expedienteId/archive-transfers',
    { preHandler, schema: { params: ArchiveTransferExpedienteParamsSchema, body: ArchiveTransferCreateRequestSchema, response: { 201: ArchiveTransferResponseSchema, ...errors } } },
    async (request, reply) => {
      try {
        const principal = request.principal;
        const result = await service.create({ expedienteId: request.params.expedienteId, transferId: randomUUID(), manifestId: randomUUID(), institutionId: principal.institutionId, actorUserId: principal.userId, correlationId: request.id, authorization: principal.authorization });
        return reply.code(201).send(toArchiveTransferResponse(result));
      } catch (error) { throw mapTransferError(error); }
    },
  );

  app.get<{ Params: ArchiveTransferIdParams; Reply: ArchiveTransferResponse }>(
    '/archive-transfers/:transferId',
    { preHandler, schema: { params: ArchiveTransferIdParamsSchema, response: { 200: ArchiveTransferResponseSchema, ...errors } } },
    async (request, reply) => {
      const result = await service.byId(request.principal.institutionId, request.params.transferId);
      if (result === undefined) throw new TransferHttpError(404, 'TRANSFER_NOT_FOUND', 'Archive transfer not found');
      if (!canPerform(request.principal.authorization, 'records.read')) throw new TransferHttpError(403, 'FORBIDDEN', 'Access denied');
      return reply.code(200).send(toArchiveTransferResponse(result));
    },
  );

  app.post<{ Params: ArchiveTransferIdParams; Body: ArchiveTransferApproveRequest; Reply: ArchiveTransferResponse }>(
    '/archive-transfers/:transferId/approve',
    { preHandler, schema: { params: ArchiveTransferIdParamsSchema, body: ArchiveTransferApproveRequestSchema, response: { 200: ArchiveTransferResponseSchema, ...errors } } },
    async (request, reply) => {
      try {
        const principal = request.principal;
        const result = await service.approve({ transferId: request.params.transferId, institutionId: principal.institutionId, actorUserId: principal.userId, correlationId: request.id, authorization: principal.authorization });
        return reply.code(200).send(toArchiveTransferResponse(result));
      } catch (error) { throw mapTransferError(error); }
    },
  );

  app.post<{ Params: ArchiveTransferIdParams; Body: ArchiveTransferSubmitRequest; Reply: ArchiveTransferResponse }>(
    '/archive-transfers/:transferId/submit',
    { preHandler, schema: { params: ArchiveTransferIdParamsSchema, body: ArchiveTransferSubmitRequestSchema, response: { 200: ArchiveTransferResponseSchema, ...errors } } },
    async (request, reply) => {
      try {
        const principal = request.principal;
        const result = await service.submit({ transferId: request.params.transferId, institutionId: principal.institutionId, actorUserId: principal.userId, correlationId: request.id, authorization: principal.authorization });
        return reply.code(200).send(toArchiveTransferResponse(result));
      } catch (error) { throw mapTransferError(error); }
    },
  );

  app.post<{ Params: ArchiveTransferIdParams; Body: ArchiveTransferRetryRequest; Reply: ArchiveTransferResponse }>(
    '/archive-transfers/:transferId/retry',
    { preHandler, schema: { params: ArchiveTransferIdParamsSchema, body: ArchiveTransferRetryRequestSchema, response: { 200: ArchiveTransferResponseSchema, ...errors } } },
    async (request, reply) => {
      try {
        const principal = request.principal;
        const result = await service.retry({ transferId: request.params.transferId, institutionId: principal.institutionId, actorUserId: principal.userId, correlationId: request.id, authorization: principal.authorization });
        return reply.code(200).send(toArchiveTransferResponse(result));
      } catch (error) { throw mapTransferError(error); }
    },
  );

  app.post<{ Params: ArchiveTransferIdParams; Body: ArchiveTransferCancelRequest; Reply: ArchiveTransferResponse }>(
    '/archive-transfers/:transferId/cancel',
    { preHandler, schema: { params: ArchiveTransferIdParamsSchema, body: ArchiveTransferCancelRequestSchema, response: { 200: ArchiveTransferResponseSchema, ...errors } } },
    async (request, reply) => {
      try {
        const principal = request.principal;
        const result = await service.cancel({ transferId: request.params.transferId, institutionId: principal.institutionId, actorUserId: principal.userId, reason: request.body.reason, correlationId: request.id, authorization: principal.authorization });
        return reply.code(200).send(toArchiveTransferResponse(result));
      } catch (error) { throw mapTransferError(error); }
    },
  );
}

function mapTransferError(error: unknown): TransferHttpError {
  if (error instanceof TransferHttpError) return error;
  const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
  if (code === 'NOT_AUTHORIZED' || code === 'AUTHORIZATION_CONTEXT_REQUIRED') return new TransferHttpError(403, 'FORBIDDEN', 'Access denied');
  if (code === 'EXPEDIENTE_NOT_FOUND' || code === 'TRANSFER_NOT_FOUND' || code === 'MANIFEST_NOT_FOUND') return new TransferHttpError(404, 'TRANSFER_NOT_FOUND', 'Archive transfer not found');
  if (code === 'EXPEDIENTE_NOT_CLOSED' || code === 'EXPEDIENTE_NOT_TRANSFER_PENDING' || code === 'TRANSFER_NOT_READY' || code === 'DOCUMENTS_NOT_CLEAN' || code === 'INVALID_TRANSITION' || code === 'MANIFEST_IMMUTABLE' || code === 'MANIFEST_NOT_APPROVED' || code === 'MANIFEST_HASH_MISMATCH' || code === 'INVALID_JOB_STATE' || code === 'CANCELLATION_NOT_SAFE' || code === 'TRANSFER_NOT_COMPLETE') return new TransferHttpError(409, 'INVALID_TRANSITION', 'Archive transfer cannot proceed in its current state');
  if (code === 'REASON_REQUIRED' || code === 'INVALID_JOB_ERROR') return new TransferHttpError(400, 'INVALID_REQUEST', 'Request validation failed');
  throw error;
}

function toArchiveTransferResponse(model: ArchiveTransferReadModel): ArchiveTransferResponse {
  let parsed: unknown;
  try { parsed = JSON.parse(model.manifest.canonical_json) as unknown; } catch { throw new Error('Stored transfer manifest is invalid JSON'); }
  const parsedDocuments = isRecord(parsed) ? parsed.documents : undefined;
  const documents = Array.isArray(parsedDocuments) ? parsedDocuments.filter(isRecord).map((document) => ({
    documentId: String(document.documentId),
    versionId: String(document.versionId),
    versionNumber: Number(document.versionNumber),
    filename: String(document.filename),
    sha256: String(document.sha256),
    sizeBytes: String(document.sizeBytes),
    mimeType: String(document.mimeType),
    current: document.current === true,
  })) : [];
  return {
    id: model.transfer.id,
    expedienteId: model.transfer.expediente_id,
    status: model.transfer.status,
    createdAt: new Date(model.transfer.created_at).toISOString(),
    updatedAt: new Date(model.transfer.updated_at).toISOString(),
    manifest: {
      id: model.manifest.id,
      transferId: model.manifest.transfer_id,
      status: model.manifest.status,
      canonicalJson: model.manifest.canonical_json,
      sha256: model.manifest.sha256,
      approvedBy: model.manifest.approved_by,
      approvedAt: model.manifest.approved_at === null ? null : new Date(model.manifest.approved_at).toISOString(),
      documents,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
