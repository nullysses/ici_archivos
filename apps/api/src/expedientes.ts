import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ExpedienteCreateRequestSchema,
  ExpedienteIdParamsSchema,
  ExpedienteResponseSchema,
  MatterErrorSchema,
  type ExpedienteCreateRequest,
  type ExpedienteIdParams,
  type ExpedienteResponse,
} from '@ici/contracts';
import {
  canPerform,
  createExpedienteAtomically,
  findExpedienteById,
  type Database,
  type ExpedienteReadModel,
  type JsonObject,
  createExpedienteSchemaValidator,
} from '@ici/database';
import type { AuthenticateRequest } from './auth-plugin.js';
import { createAuthenticationGuard } from './auth-plugin.js';

export class ExpedienteHttpError extends Error {
  public constructor(
    readonly statusCode: 400 | 403 | 404,
    readonly code: 'INVALID_REQUEST' | 'FORBIDDEN' | 'EXPEDIENTE_NOT_FOUND',
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
  const errors = { 400: MatterErrorSchema, 401: MatterErrorSchema, 403: MatterErrorSchema, 404: MatterErrorSchema } as const;
  app.post<{ Body: ExpedienteCreateRequest; Reply: ExpedienteResponse }>(
    '/expedientes',
    { preHandler, preValidation: (request) => rejectUnknownFields(request.body), schema: { body: ExpedienteCreateRequestSchema, response: { 201: ExpedienteResponseSchema, ...errors } } },
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
