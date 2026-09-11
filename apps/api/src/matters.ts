import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MatterErrorSchema,
  MatterAssignmentRequestSchema,
  MatterFolioParamsSchema,
  MatterIdParamsSchema,
  MatterInboxResponseSchema,
  MatterRegistrationRequestSchema,
  MatterResponseSchema,
  type MatterAssignmentRequest,
  type MatterInboxResponse,
  type MatterRegistrationRequest,
  type MatterResponse,
} from '@ici/contracts';
import {
  canPerform,
  assignMatterAtomically,
  findMatterByFolio,
  findMatterById,
  findMatterInbox,
  registerMatterAtomically,
  type Database,
  type MatterReadModel,
  type MatterInboxReadModel,
} from '@ici/database';
import type { AuthenticateRequest } from './auth-plugin.js';
import type { AuthenticatedPrincipal } from './auth.js';
import { createAuthenticationGuard } from './auth-plugin.js';

export class MatterHttpError extends Error {
  public constructor(readonly statusCode: 400 | 403 | 404, readonly code: 'INVALID_REQUEST' | 'INVALID_TRANSITION' | 'FORBIDDEN' | 'MATTER_NOT_FOUND', message: string) {
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
  assign(input: {
    readonly institutionId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly matterId: string;
    readonly command: 'assignMatter' | 'reassignMatter';
    readonly request: MatterAssignmentRequest;
  }): Promise<MatterReadModel>;
  inbox(input: {
    readonly institutionId: string;
    readonly userId: string;
    readonly authorization: AuthenticatedPrincipal['authorization'];
  }): Promise<readonly MatterInboxReadModel[]>;
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
    async assign(input) {
      const current = await findMatterById(database, input.institutionId, input.matterId);
      if (current === undefined) throw new MatterHttpError(404, 'MATTER_NOT_FOUND', 'Matter not found');
      const allowed = input.command === 'assignMatter' ? current.status === 'RECEIVED' : current.status === 'ASSIGNED' || current.status === 'IN_PROGRESS';
      if (!allowed) throw new MatterHttpError(400, 'INVALID_TRANSITION', 'Matter cannot be assigned from its current state');
      try {
        await assignMatterAtomically(database, {
          institutionId: input.institutionId,
          matterId: input.matterId,
          assignmentId: randomUUID(),
          unitId: input.request.unitId,
          ...(input.request.userId === undefined ? {} : { userId: input.request.userId }),
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          command: input.command,
          fromStatus: current.status as 'RECEIVED' | 'ASSIGNED' | 'IN_PROGRESS',
          ...(input.request.reason === undefined ? {} : { reason: input.request.reason }),
          assignedAt: new Date(),
        });
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        if (code === 'TARGET_UNIT_NOT_FOUND' || code === 'TARGET_USER_NOT_FOUND') throw new MatterHttpError(400, 'INVALID_REQUEST', 'Assignment target is invalid');
        if (code === 'REASON_REQUIRED') throw new MatterHttpError(400, 'INVALID_REQUEST', 'Reassignment reason is required');
        if (code === 'STALE_STATE' || code === 'INVALID_TRANSITION') throw new MatterHttpError(400, 'INVALID_TRANSITION', 'Matter state changed; retry the command');
        throw error;
      }
      const updated = await findMatterById(database, input.institutionId, input.matterId);
      if (updated === undefined) throw new Error('Matter assignment did not produce a matter');
      return updated;
    },
    async inbox(input) {
      const institutionWideRead = canPerform(input.authorization, 'records.read');
      const authorizedUnitIds = [...input.authorization.unitCapabilities.entries()]
        .filter(([, capabilities]) => capabilities.has('records.read'))
        .map(([unitId]) => unitId);
      const rows = await findMatterInbox(database, input.institutionId, input.userId, authorizedUnitIds, institutionWideRead);
      return rows.filter((row) => {
        const visibility = row.intake_metadata.operationalVisibility;
        if (visibility !== 'INSTITUTION' && visibility !== 'UNIT') return false;
        return canPerform(input.authorization, 'records.read', row.assignment_unit_id);
      });
    },
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
  const assignmentResponseSchemas = { 200: MatterResponseSchema, 400: MatterErrorSchema, 401: MatterErrorSchema, 403: MatterErrorSchema, 404: MatterErrorSchema } as const;

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

  const assignment = (command: 'assignMatter' | 'reassignMatter') => async (request: FastifyRequest<{ Params: { id: string }; Body: MatterAssignmentRequest }>, reply: FastifyReply): Promise<MatterResponse> => {
    const principal = request.principal;
    if (!canPerform(principal.authorization, 'matter.assign', request.body.unitId)) throw new MatterHttpError(403, 'FORBIDDEN', 'Access denied');
    if (command === 'reassignMatter' && (request.body.reason === undefined || request.body.reason.trim().length === 0)) throw new MatterHttpError(400, 'INVALID_REQUEST', 'Reassignment reason is required');
    const matter = await service.assign({ institutionId: principal.institutionId, actorUserId: principal.userId, correlationId: request.id, matterId: request.params.id, command, request: request.body });
    reply.code(200);
    return toMatterResponse(matter);
  };

  app.post<{ Params: { id: string }; Body: MatterAssignmentRequest; Reply: MatterResponse }>(
    '/matters/:id/assign',
    { preHandler, schema: { params: MatterIdParamsSchema, body: MatterAssignmentRequestSchema, response: assignmentResponseSchemas } },
    assignment('assignMatter'),
  );
  app.post<{ Params: { id: string }; Body: MatterAssignmentRequest; Reply: MatterResponse }>(
    '/matters/:id/reassign',
    { preHandler, schema: { params: MatterIdParamsSchema, body: MatterAssignmentRequestSchema, response: assignmentResponseSchemas } },
    assignment('reassignMatter'),
  );

  app.get<{ Reply: MatterInboxResponse }>(
    '/matters/inbox',
    { preHandler, schema: { response: { 200: MatterInboxResponseSchema, 401: MatterErrorSchema } } },
    async (request) => ({ items: (await service.inbox({ institutionId: request.principal.institutionId, userId: request.principal.userId, authorization: request.principal.authorization })).map(toMatterInboxItem) }),
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

function toMatterInboxItem(matter: MatterInboxReadModel): MatterInboxResponse['items'][number] {
  return {
    ...toMatterResponse(matter),
    assignmentUnitId: matter.assignment_unit_id,
    assignmentUserId: matter.assignment_user_id,
    assignedAt: toIsoString(matter.assignment_assigned_at),
  };
}

function toIsoString(value: Date | string): string {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error('Stored matter timestamp is invalid');
  return result.toISOString();
}
