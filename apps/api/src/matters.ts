import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MatterErrorSchema,
  MatterFolioParamsSchema,
  MatterIdParamsSchema,
  MatterRegistrationRequestSchema,
  MatterResponseSchema,
  type MatterRegistrationRequest,
  type MatterResponse,
} from '@ici/contracts';
import {
  canPerform,
  findMatterByFolio,
  findMatterById,
  registerMatterAtomically,
  type Database,
  type MatterReadModel,
} from '@ici/database';
import type { AuthenticateRequest } from './auth-plugin.js';
import { createAuthenticationGuard } from './auth-plugin.js';

export class MatterHttpError extends Error {
  public constructor(readonly statusCode: 400 | 403 | 404, readonly code: 'INVALID_REQUEST' | 'FORBIDDEN' | 'MATTER_NOT_FOUND', message: string) {
    super(message);
    this.name = 'MatterHttpError';
  }
}

export interface MatterApplicationService {
  register(input: {
    readonly id: string;
    readonly institutionId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly request: MatterRegistrationRequest;
  }): Promise<MatterReadModel>;
  byId(institutionId: string, id: string): Promise<MatterReadModel | undefined>;
  byFolio(institutionId: string, folio: string): Promise<MatterReadModel | undefined>;
}

export function createMatterApplicationService(database: Database): MatterApplicationService {
  return {
    async register(input) {
      const receivedAt = new Date(input.request.receivedAt);
      if (!Number.isFinite(receivedAt.getTime())) throw new MatterHttpError(400, 'INVALID_REQUEST', 'Request validation failed');
      const intakeMetadata = {
        sender: input.request.sender,
        subject: input.request.subject,
        description: input.request.description,
        priority: input.request.priority,
        channel: input.request.channel,
        ...(input.request.dueAt === undefined ? {} : { dueAt: input.request.dueAt }),
        operationalVisibility: input.request.operationalVisibility,
      };
      try {
        await registerMatterAtomically(database, {
          id: input.id,
          institutionId: input.institutionId,
          receivedAt,
          createdBy: input.actorUserId,
          actorUserId: input.actorUserId,
          intakeMetadata,
          correlationId: input.correlationId,
          year: receivedAt.getUTCFullYear(),
          destinationUnitId: input.request.destinationUnitId,
          accessClassificationId: input.request.accessClassificationId,
        });
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        if (code === 'DESTINATION_UNIT_NOT_FOUND' || code === 'ACCESS_CLASSIFICATION_NOT_FOUND' || code === 'INVALID_INTAKE_REFERENCES') {
          throw new MatterHttpError(400, 'INVALID_REQUEST', 'Referenced intake record is invalid');
        }
        throw error;
      }
      const matter = await findMatterById(database, input.institutionId, input.id);
      if (matter === undefined) throw new Error('Matter registration did not produce a matter');
      return matter;
    },
    byId: (institutionId, id) => findMatterById(database, institutionId, id),
    byFolio: (institutionId, folio) => findMatterByFolio(database, institutionId, folio),
  };
}

function authenticatedPreHandler(authenticateRequest: ReturnType<typeof createAuthenticationGuard>) {
  return (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void => {
    void authenticateRequest(request, reply).then(() => { if (!reply.sent) done(); }).catch(done);
  };
}

export function installMatterRoutes(app: FastifyInstance, service: MatterApplicationService, authenticate: AuthenticateRequest): void {
  const authenticateRequest = createAuthenticationGuard(authenticate);
  const preHandler = authenticatedPreHandler(authenticateRequest);
  const responseSchemas = {
    201: MatterResponseSchema,
    200: MatterResponseSchema,
    400: MatterErrorSchema,
    401: MatterErrorSchema,
    403: MatterErrorSchema,
    404: MatterErrorSchema,
  } as const;

  app.post<{ Body: MatterRegistrationRequest; Reply: MatterResponse }>(
    '/matters',
    { preHandler, schema: { body: MatterRegistrationRequestSchema, response: responseSchemas } },
    async (request, reply) => {
      const principal = request.principal;
      if (!canPerform(principal.authorization, 'matter.register')) throw new MatterHttpError(403, 'FORBIDDEN', 'Access denied');
      if (request.body.operationalVisibility === 'RESTRICTED_GROUP') throw new MatterHttpError(400, 'INVALID_REQUEST', 'Restricted-group visibility is not available yet');
      const matter = await service.register({ id: randomUUID(), institutionId: principal.institutionId, actorUserId: principal.userId, correlationId: request.id, request: request.body });
      return reply.code(201).send(toMatterResponse(matter));
    },
  );

  const readMatter = async (request: FastifyRequest, reply: FastifyReply, lookup: Promise<MatterReadModel | undefined>): Promise<MatterResponse> => {
    const matter = await lookup;
    if (matter === undefined) throw new MatterHttpError(404, 'MATTER_NOT_FOUND', 'Matter not found');
    const principal = request.principal;
    const visibility = matter.intake_metadata.operationalVisibility;
    if (visibility !== 'INSTITUTION' && visibility !== 'UNIT') throw new MatterHttpError(403, 'FORBIDDEN', 'Access denied');
    if (!canPerform(principal.authorization, 'records.read', matter.destination_unit_id ?? undefined)) throw new MatterHttpError(403, 'FORBIDDEN', 'Access denied');
    const response = toMatterResponse(matter);
    reply.code(200);
    return response;
  };

  app.get<{ Params: { folio: string }; Reply: MatterResponse }>(
    '/matters/by-folio/:folio',
    { preHandler, schema: { params: MatterFolioParamsSchema, response: responseSchemas } },
    (request, reply) => readMatter(request, reply, service.byFolio(request.principal.institutionId, request.params.folio)),
  );
  app.get<{ Params: { id: string }; Reply: MatterResponse }>(
    '/matters/:id',
    { preHandler, schema: { params: MatterIdParamsSchema, response: responseSchemas } },
    (request, reply) => readMatter(request, reply, service.byId(request.principal.institutionId, request.params.id)),
  );
}

function toMatterResponse(matter: MatterReadModel): MatterResponse {
  const intake = matter.intake_metadata;
  const value = (key: string): string => typeof intake[key] === 'string' ? intake[key] : '';
  const visibility = value('operationalVisibility');
  const operationalVisibility: 'INSTITUTION' | 'UNIT' | 'RESTRICTED_GROUP' | null = visibility === 'INSTITUTION' || visibility === 'UNIT' || visibility === 'RESTRICTED_GROUP' ? visibility : null;
  const base = {
    id: matter.id,
    folio: matter.folio,
    status: matter.status,
    receivedAt: toIsoString(matter.received_at),
    sender: value('sender'),
    subject: value('subject'),
    description: value('description'),
    priority: value('priority'),
    channel: value('channel'),
    destinationUnitId: matter.destination_unit_id,
    accessClassificationId: matter.access_classification_id,
    operationalVisibility,
    resolutionMetadata: matter.resolution_metadata,
    closureMetadata: matter.closure_metadata,
    linkedExpedienteId: matter.linked_expediente_id,
    createdBy: matter.created_by,
    createdAt: toIsoString(matter.created_at),
    updatedAt: toIsoString(matter.updated_at),
  };
  const dueAt = intake.dueAt;
  return typeof dueAt === 'string' ? { ...base, dueAt } : base;
}

function toIsoString(value: Date | string): string {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error('Stored matter timestamp is invalid');
  return result.toISOString();
}
