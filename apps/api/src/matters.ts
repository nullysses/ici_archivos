import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MatterErrorSchema,
  MatterAssignmentRequestSchema,
  MatterFolioParamsSchema,
  MatterIdParamsSchema,
  MatterInboxResponseSchema,
  MatterNoteRequestSchema,
  MatterNoteSchema,
  MatterNotesResponseSchema,
  MatterResolveRequestSchema,
  MatterRegistrationRequestSchema,
  MatterResponseSchema,
  MatterStartRequestSchema,
  MatterVoidRequestSchema,
  type MatterAssignmentRequest,
  type MatterInboxResponse,
  type MatterNoteRequest,
  type MatterNotesResponse,
  type MatterResolveRequest,
  type MatterRegistrationRequest,
  type MatterResponse,
  type MatterStartRequest,
  type MatterVoidRequest,
} from '@ici/contracts';
import {
  addMatterNoteAtomically,
  canPerform,
  assignMatterAtomically,
  findMatterByFolio,
  findMatterById,
  findMatterInbox,
  findMatterNotesAuthorized,
  persistMatterTransition,
  type JsonObject,
  registerMatterAtomically,
  type Database,
  type MatterReadModel,
  type MatterInboxReadModel,
  type MatterNoteReadModel,
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
    readonly authorization: AuthenticatedPrincipal['authorization'];
  }): Promise<MatterReadModel>;
  inbox(input: {
    readonly institutionId: string;
    readonly userId: string;
    readonly authorization: AuthenticatedPrincipal['authorization'];
  }): Promise<readonly MatterInboxReadModel[]>;
  transition(input: {
    readonly institutionId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly matterId: string;
    readonly command: 'startMatter' | 'resolveMatter' | 'voidMatter';
    readonly authorization: AuthenticatedPrincipal['authorization'];
    readonly eventData?: JsonObject;
    readonly reason?: string;
  }): Promise<MatterReadModel>;
  listNotes(input: {
    readonly institutionId: string;
    readonly matterId: string;
    readonly authorization: AuthenticatedPrincipal['authorization'];
  }): Promise<readonly MatterNoteReadModel[]>;
  addNote(input: {
    readonly id: string;
    readonly institutionId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly matterId: string;
    readonly request: MatterNoteRequest;
    readonly authorization: AuthenticatedPrincipal['authorization'];
  }): Promise<MatterNoteReadModel>;
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
          authorizationContext: input.authorization,
        });
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        if (code === 'TARGET_UNIT_NOT_FOUND' || code === 'TARGET_USER_NOT_FOUND' || code === 'TARGET_USER_NOT_IN_UNIT') throw new MatterHttpError(400, 'INVALID_REQUEST', 'Assignment target is invalid');
        if (code === 'NOT_AUTHORIZED') throw new MatterHttpError(403, 'FORBIDDEN', 'Access denied');
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
    async transition(input) {
      const current = await findMatterById(database, input.institutionId, input.matterId);
      if (current === undefined) throw new MatterHttpError(404, 'MATTER_NOT_FOUND', 'Matter not found');
      const target = input.command === 'startMatter' ? 'IN_PROGRESS' : input.command === 'resolveMatter' ? 'RESOLVED' : 'VOIDED';
      try {
        await persistMatterTransition(database, {
          institutionId: input.institutionId,
          aggregateId: input.matterId,
          actorUserId: input.actorUserId,
          authorizationContext: input.authorization,
          correlationId: input.correlationId,
          command: input.command,
          fromStatus: current.status,
          toStatus: target,
          ...(input.eventData === undefined ? {} : { eventData: input.eventData }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        });
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        if (code === 'NOT_AUTHORIZED' || code === 'AUTHORIZATION_CONTEXT_REQUIRED') throw new MatterHttpError(403, 'FORBIDDEN', 'Access denied');
        if (code === 'STALE_STATE' || code === 'INVALID_TRANSITION') throw new MatterHttpError(400, 'INVALID_TRANSITION', 'Matter state changed; retry the command');
        if (code === 'INVALID_RESOLUTION' || code === 'REASON_REQUIRED') throw new MatterHttpError(400, 'INVALID_REQUEST', 'Transition metadata is invalid');
        throw error;
      }
      const updated = await findMatterById(database, input.institutionId, input.matterId);
      if (updated === undefined) throw new Error('Matter transition did not produce a matter');
      return updated;
    },
    listNotes: (input) => findMatterNotesAuthorized(database, {
      institutionId: input.institutionId,
      matterId: input.matterId,
      authorizationContext: input.authorization,
    }),
    async addNote(input) {
      return addMatterNoteAtomically(database, {
        id: input.id,
        institutionId: input.institutionId,
        matterId: input.matterId,
        authorUserId: input.actorUserId,
        correlationId: input.correlationId,
        content: input.request.content,
        ...(input.request.noteType === undefined ? {} : { noteType: input.request.noteType }),
        authorizationContext: input.authorization,
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
  const transitionResponseSchemas = { 200: MatterResponseSchema, 400: MatterErrorSchema, 401: MatterErrorSchema, 403: MatterErrorSchema, 404: MatterErrorSchema } as const;

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
    if (command === 'reassignMatter' && (request.body.reason === undefined || request.body.reason.trim().length === 0)) throw new MatterHttpError(400, 'INVALID_REQUEST', 'Reassignment reason is required');
    const matter = await service.assign({ institutionId: principal.institutionId, actorUserId: principal.userId, correlationId: request.id, matterId: request.params.id, command, request: request.body, authorization: principal.authorization });
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

  const transition = (command: 'startMatter' | 'resolveMatter' | 'voidMatter') => async (request: FastifyRequest<{ Params: { id: string }; Body: MatterStartRequest | MatterResolveRequest | MatterVoidRequest }>, reply: FastifyReply): Promise<MatterResponse> => {
    const body = request.body;
    const eventData = command === 'resolveMatter' ? { resolutionMetadata: (body as MatterResolveRequest).resolutionMetadata as unknown as JsonObject } : undefined;
    const matter = await service.transition({
      institutionId: request.principal.institutionId,
      actorUserId: request.principal.userId,
      correlationId: request.id,
      matterId: request.params.id,
      command,
      authorization: request.principal.authorization,
      ...(eventData === undefined ? {} : { eventData }),
      ...(command === 'voidMatter' ? { reason: (body as MatterVoidRequest).reason } : {}),
    });
    reply.code(200);
    return toMatterResponse(matter);
  };

  app.post<{ Params: { id: string }; Body: MatterStartRequest; Reply: MatterResponse }>(
    '/matters/:id/start',
    { preHandler, schema: { params: MatterIdParamsSchema, body: MatterStartRequestSchema, response: transitionResponseSchemas } },
    transition('startMatter'),
  );
  app.post<{ Params: { id: string }; Body: MatterResolveRequest; Reply: MatterResponse }>(
    '/matters/:id/resolve',
    { preHandler, schema: { params: MatterIdParamsSchema, body: MatterResolveRequestSchema, response: transitionResponseSchemas } },
    transition('resolveMatter'),
  );
  app.post<{ Params: { id: string }; Body: MatterVoidRequest; Reply: MatterResponse }>(
    '/matters/:id/void',
    { preHandler, schema: { params: MatterIdParamsSchema, body: MatterVoidRequestSchema, response: transitionResponseSchemas } },
    transition('voidMatter'),
  );

  const notesResponseSchemas = { 200: MatterNotesResponseSchema, 201: MatterNoteSchema, 400: MatterErrorSchema, 401: MatterErrorSchema, 403: MatterErrorSchema, 404: MatterErrorSchema } as const;
  app.get<{ Params: { id: string }; Reply: MatterNotesResponse }>(
    '/matters/:id/notes',
    { preHandler, schema: { params: MatterIdParamsSchema, response: notesResponseSchemas } },
    async (request) => {
      try {
        const notes = await service.listNotes({
          institutionId: request.principal.institutionId,
          matterId: request.params.id,
          authorization: request.principal.authorization,
        });
        return { items: notes.map(toMatterNote) };
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        if (code === 'NOT_AUTHORIZED' || code === 'AUTHORIZATION_CONTEXT_REQUIRED') throw new MatterHttpError(403, 'FORBIDDEN', 'Access denied');
        if (error instanceof Error && error.message === 'Matter not found') throw new MatterHttpError(404, 'MATTER_NOT_FOUND', 'Matter not found');
        throw error;
      }
    },
  );
  app.post<{ Params: { id: string }; Body: MatterNoteRequest; Reply: MatterNotesResponse['items'][number] }>(
    '/matters/:id/notes',
    { preHandler, schema: { params: MatterIdParamsSchema, body: MatterNoteRequestSchema, response: notesResponseSchemas } },
    async (request, reply) => {
      try {
        const created = await service.addNote({ id: randomUUID(), institutionId: request.principal.institutionId, actorUserId: request.principal.userId, correlationId: request.id, matterId: request.params.id, request: request.body, authorization: request.principal.authorization });
        reply.code(201);
        return toMatterNote(created);
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        if (code === 'NOT_AUTHORIZED' || code === 'AUTHORIZATION_CONTEXT_REQUIRED') throw new MatterHttpError(403, 'FORBIDDEN', 'Access denied');
        if (code === 'INVALID_NOTE') throw new MatterHttpError(400, 'INVALID_REQUEST', 'Note content is invalid');
        if (code === 'INVALID_TRANSITION') throw new MatterHttpError(400, 'INVALID_TRANSITION', 'Notes cannot be added in the current state');
        if (error instanceof Error && error.message === 'Matter not found') throw new MatterHttpError(404, 'MATTER_NOT_FOUND', 'Matter not found');
        throw error;
      }
    },
  );

  const readMatter = async (request: FastifyRequest, reply: FastifyReply, lookup: Promise<MatterReadModel | undefined>): Promise<MatterResponse> => {
    const matter = await lookup;
    if (matter === undefined) throw new MatterHttpError(404, 'MATTER_NOT_FOUND', 'Matter not found');
    const principal = request.principal;
    authorizeMatterRead(principal, matter);
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

function authorizeMatterRead(principal: AuthenticatedPrincipal, matter: MatterReadModel): void {
  const visibility = matter.intake_metadata.operationalVisibility;
  if (visibility !== 'INSTITUTION' && visibility !== 'UNIT') throw new MatterHttpError(403, 'FORBIDDEN', 'Access denied');
  if (!canPerform(principal.authorization, 'records.read', matter.effective_unit_id ?? matter.destination_unit_id ?? undefined)) throw new MatterHttpError(403, 'FORBIDDEN', 'Access denied');
}

function toMatterNote(note: MatterNoteReadModel): MatterNotesResponse['items'][number] {
  return {
    id: note.id,
    matterId: note.matter_id,
    authorUserId: note.author_user_id,
    noteType: note.note_type,
    content: note.content,
    createdAt: toIsoString(note.created_at),
  };
}

function toIsoString(value: Date | string): string {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error('Stored matter timestamp is invalid');
  return result.toISOString();
}
