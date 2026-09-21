import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ExpedienteCreateRequestSchema,
  ExpedienteIdParamsSchema,
  ExpedienteResponseSchema,
  ExpedienteCloseRequestSchema,
  MatterErrorSchema,
  type ExpedienteCreateRequest,
  type ExpedienteIdParams,
  type ExpedienteResponse,
  type ExpedienteCloseRequest,
  ExpedienteReopenRequestSchema,
  type ExpedienteReopenRequest,
  ExpedienteListResponseSchema,
  PublishedExpedienteTypeVersionsResponseSchema,
  type ExpedienteListResponse,
  type PublishedExpedienteTypeVersionsResponse,
} from '@ici/contracts';
import {
  canPerform,
  createExpedienteAtomically,
  findExpedienteById,
  type Database,
  type ExpedienteReadModel,
  type JsonObject,
  createExpedienteSchemaValidator,
  persistExpedienteTransition,
  findExpedientesAuthorized,
  findPublishedExpedienteTypeVersions,
} from '@ici/database';
import type { AuthenticateRequest } from './auth-plugin.js';
import { createAuthenticationGuard } from './auth-plugin.js';
import type { AuthenticatedPrincipal } from './auth.js';

export class ExpedienteHttpError extends Error {
  public constructor(
    readonly statusCode: 400 | 403 | 404 | 409,
    readonly code: 'INVALID_REQUEST' | 'FORBIDDEN' | 'EXPEDIENTE_NOT_FOUND' | 'INVALID_TRANSITION',
    message: string,
  ) {
    super(message);
    this.name = 'ExpedienteHttpError';
  }
}

export interface ExpedienteApplicationService {
  create(input: {
    readonly id: string;
    readonly institutionId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly request: ExpedienteCreateRequest;
  }): Promise<ExpedienteReadModel>;
  byId(institutionId: string, id: string): Promise<ExpedienteReadModel | undefined>;
  close(input: { readonly id: string; readonly institutionId: string; readonly actorUserId: string; readonly correlationId: string; readonly request: ExpedienteCloseRequest; readonly authorization: AuthenticatedPrincipal['authorization'] }): Promise<ExpedienteReadModel>;
  reopen(input: { readonly id: string; readonly institutionId: string; readonly actorUserId: string; readonly correlationId: string; readonly request: ExpedienteReopenRequest; readonly authorization: AuthenticatedPrincipal['authorization'] }): Promise<ExpedienteReadModel>;
  list(input: { readonly institutionId: string; readonly authorization: AuthenticatedPrincipal['authorization'] }): Promise<readonly ExpedienteReadModel[]>;
  publishedTypes(input: { readonly institutionId: string; readonly authorization: AuthenticatedPrincipal['authorization'] }): Promise<readonly { readonly id: string; readonly expediente_type_id: string; readonly version_number: number; readonly schema_json: Record<string, unknown>; readonly code: string; readonly name: string }[]>;
}

export function createExpedienteApplicationService(database: Database): ExpedienteApplicationService {
  const validator = createExpedienteSchemaValidator();
  return {
    async create(input) {
      await createExpedienteAtomically(database, {
        id: input.id,
        institutionId: input.institutionId,
        expedienteTypeVersionId: input.request.expedienteTypeVersionId,
        metadata: input.request.metadata as unknown as JsonObject,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
      }, validator.validateMetadata);
      const expediente = await findExpedienteById(database, input.institutionId, input.id);
      if (expediente === undefined) throw new Error('Expediente creation did not produce an expediente');
      return expediente;
    },
    byId: (institutionId, id) => findExpedienteById(database, institutionId, id),
    list: (input) => findExpedientesAuthorized(database, { institutionId: input.institutionId, authorizationContext: input.authorization }),
    publishedTypes: (input) => findPublishedExpedienteTypeVersions(database, { institutionId: input.institutionId, authorizationContext: input.authorization }),
    async close(input) {
      if (Object.keys(input.request.closureMetadata).length === 0) throw Object.assign(new Error('Closure metadata is required'), { code: 'INVALID_METADATA' });
      await persistExpedienteTransition(database, {
        institutionId: input.institutionId,
        aggregateId: input.id,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        command: 'closeExpediente',
        fromStatus: 'OPEN',
        toStatus: 'CLOSED',
        eventData: { metadataValid: true, closureMetadata: input.request.closureMetadata as unknown as JsonObject },
        authorizationContext: input.authorization,
      });
      const expediente = await findExpedienteById(database, input.institutionId, input.id);
      if (expediente === undefined) throw new Error('Expediente closure did not produce an expediente');
      return expediente;
    },
    async reopen(input) {
      await persistExpedienteTransition(database, { institutionId: input.institutionId, aggregateId: input.id, actorUserId: input.actorUserId, correlationId: input.correlationId, command: 'reopenExpediente', fromStatus: 'CLOSED', toStatus: 'OPEN', reason: input.request.reason, authorizationContext: input.authorization });
      const expediente = await findExpedienteById(database, input.institutionId, input.id);
      if (expediente === undefined) throw new Error('Expediente reopen did not produce an expediente');
      return expediente;
    },
  };
}

function authenticatedPreHandler(authenticate: AuthenticateRequest) {
  const guard = createAuthenticationGuard(authenticate);
  return (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void => {
    void guard(request, reply).then(() => { if (!reply.sent) done(); }).catch(done);
  };
}

export function installExpedienteRoutes(app: FastifyInstance, service: ExpedienteApplicationService, authenticate: AuthenticateRequest): void {
  const preHandler = authenticatedPreHandler(authenticate);
  const errors = { 400: MatterErrorSchema, 401: MatterErrorSchema, 403: MatterErrorSchema, 404: MatterErrorSchema, 409: MatterErrorSchema } as const;
  app.post<{ Body: ExpedienteCreateRequest; Reply: ExpedienteResponse }>(
    '/expedientes',
    { preHandler, preValidation: (request, _reply, done) => {
      try {
        rejectUnknownFields(request.body);
        done();
      } catch (error: unknown) {
        done(error instanceof Error ? error : new Error('Request validation failed'));
      }
    }, schema: { body: ExpedienteCreateRequestSchema, response: { 201: ExpedienteResponseSchema, ...errors } } },
    async (request, reply) => {
      const principal = request.principal;
      if (!canPerform(principal.authorization, 'expediente.create')) throw new ExpedienteHttpError(403, 'FORBIDDEN', 'Access denied');
      try {
        const created = await service.create({ id: randomUUID(), institutionId: principal.institutionId, actorUserId: principal.userId, correlationId: request.id, request: request.body });
        return reply.code(201).send(toExpedienteResponse(created));
      } catch (error) {
        throw mapExpedienteError(error);
      }
    },
  );

  app.get<{ Params: ExpedienteIdParams; Reply: ExpedienteResponse }>(
    '/expedientes/:expedienteId',
    { preHandler, schema: { params: ExpedienteIdParamsSchema, response: { 200: ExpedienteResponseSchema, ...errors } } },
    async (request, reply) => {
      const principal = request.principal;
      const expediente = await service.byId(principal.institutionId, request.params.expedienteId);
      if (expediente === undefined) throw new ExpedienteHttpError(404, 'EXPEDIENTE_NOT_FOUND', 'Expediente not found');
      if (!canPerform(principal.authorization, 'records.read')) throw new ExpedienteHttpError(403, 'FORBIDDEN', 'Access denied');
      return reply.code(200).send(toExpedienteResponse(expediente));
    },
  );

  app.get<{ Reply: ExpedienteListResponse }>('/expedientes', { preHandler, schema: { response: { 200: ExpedienteListResponseSchema, ...errors } } }, async (request, reply) => {
    try { return reply.code(200).send({ items: (await service.list({ institutionId: request.principal.institutionId, authorization: request.principal.authorization })).map(toExpedienteResponse) }); }
    catch (error) { throw mapExpedienteError(error); }
  });

  app.get<{ Reply: PublishedExpedienteTypeVersionsResponse }>(
    '/expediente-types/published',
    { preHandler, schema: { response: { 200: PublishedExpedienteTypeVersionsResponseSchema, ...errors } } },
    async (request, reply) => {
      try { return reply.code(200).send({ items: (await service.publishedTypes({ institutionId: request.principal.institutionId, authorization: request.principal.authorization })).map(toPublishedType) }); }
      catch (error) { throw mapExpedienteError(error); }
    },
  );

  app.post<{ Params: ExpedienteIdParams; Body: ExpedienteCloseRequest; Reply: ExpedienteResponse }>(
    '/expedientes/:expedienteId/close',
    { preHandler, schema: { params: ExpedienteIdParamsSchema, body: ExpedienteCloseRequestSchema, response: { 200: ExpedienteResponseSchema, ...errors } } },
    async (request, reply) => {
      const principal = request.principal;
      try {
        const closed = await service.close({ id: request.params.expedienteId, institutionId: principal.institutionId, actorUserId: principal.userId, correlationId: request.id, request: request.body, authorization: principal.authorization });
        return reply.code(200).send(toExpedienteResponse(closed));
      } catch (error) {
        throw mapExpedienteError(error);
      }
    },
  );
  app.post<{ Params: ExpedienteIdParams; Body: ExpedienteReopenRequest; Reply: ExpedienteResponse }>(
    '/expedientes/:expedienteId/reopen',
    { preHandler, schema: { params: ExpedienteIdParamsSchema, body: ExpedienteReopenRequestSchema, response: { 200: ExpedienteResponseSchema, ...errors } } },
    async (request, reply) => {
      try { const reopened = await service.reopen({ id: request.params.expedienteId, institutionId: request.principal.institutionId, actorUserId: request.principal.userId, correlationId: request.id, request: request.body, authorization: request.principal.authorization }); return reply.code(200).send(toExpedienteResponse(reopened)); }
      catch (error) { throw mapExpedienteError(error); }
    },
  );
}

function rejectUnknownFields(body: unknown): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const allowedFields = new Set(['expedienteTypeVersionId', 'metadata']);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) throw new ExpedienteHttpError(400, 'INVALID_REQUEST', 'Request validation failed');
}

function mapExpedienteError(error: unknown): ExpedienteHttpError {
  if (error instanceof ExpedienteHttpError) return error;
  const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
  if (code === 'TYPE_VERSION_NOT_PUBLISHED' || code === 'INVALID_METADATA' || code === 'INVALID_SCHEMA' || code === 'CROSS_TENANT_REFERENCE') {
    return new ExpedienteHttpError(400, 'INVALID_REQUEST', 'Expediente request is invalid');
  }
  if (code === 'NOT_AUTHORIZED') return new ExpedienteHttpError(403, 'FORBIDDEN', 'Access denied');
  if (code === 'STALE_STATE' || code === 'INVALID_TRANSITION' || code === 'MATTERS_NOT_CLOSED' || code === 'DOCUMENTS_NOT_CLEAN' || code === 'TRANSFER_ALREADY_APPROVED') return new ExpedienteHttpError(409, 'INVALID_TRANSITION', code === 'DOCUMENTS_NOT_CLEAN' ? 'Expediente has documents pending malware analysis' : 'Expediente cannot change state in its current lifecycle');
  if (code === 'EXPEDIENTE_NOT_FOUND' || (error instanceof Error && error.message === 'Expediente not found')) return new ExpedienteHttpError(404, 'EXPEDIENTE_NOT_FOUND', 'Expediente not found');
  throw error;
}

function toExpedienteResponse(expediente: ExpedienteReadModel): ExpedienteResponse {
  return {
    id: expediente.id,
    folio: expediente.folio,
    status: expediente.status,
    expedienteTypeVersionId: expediente.expediente_type_version_id,
    metadata: expediente.metadata,
    openedAt: new Date(expediente.opened_at).toISOString(),
    closedAt: expediente.closed_at === null ? null : new Date(expediente.closed_at).toISOString(),
  };
}

function toPublishedType(version: { id: string; expediente_type_id: string; version_number: number; schema_json: Record<string, unknown>; code: string; name: string }): { id: string; expedienteTypeId: string; code: string; name: string; versionNumber: number; schema: Record<string, unknown> } {
  return { id: version.id, expedienteTypeId: version.expediente_type_id, code: version.code, name: version.name, versionNumber: version.version_number, schema: version.schema_json };
}
