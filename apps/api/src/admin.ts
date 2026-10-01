import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AdminAssignmentCreateSchema, AdminAssignmentParamsSchema, AdminCapabilitiesResponseSchema, AdminClassificationResponseSchema, AdminExpedienteTypeCreateSchema, AdminExpedienteTypeUpdateSchema, AdminExpedienteTypesResponseSchema, AdminInstitutionResponseSchema, AdminInstitutionUpdateSchema, AdminRolesResponseSchema, AdminUnitCreateSchema, AdminUnitParamsSchema, AdminUnitsResponseSchema, AdminUnitUpdateSchema, AdminUserParamsSchema, AdminUsersResponseSchema, MatterErrorSchema,
  AdminVersionParamsSchema, type AdminAssignmentCreate, type AdminExpedienteTypeCreate, type AdminExpedienteTypeUpdate, type AdminInstitutionUpdate, type AdminUnitCreate, type AdminUnitUpdate,
} from '@ici/contracts';
import {
  createAdminAssignment, createAdminExpedienteType, createAdminUnit, findAdminCapabilities, findAdminClassification, findAdminExpedienteTypes, findAdminInstitution, findAdminRoles, findAdminUnits, findAdminUsers, publishAdminExpedienteDraft, revokeAdminAssignment, updateAdminExpedienteDraft, updateAdminInstitution, updateAdminUnit,
  type AdminAssignmentRecord, type AdminInstitutionRecord, type AdminTypeRecord, type AdminUnitRecord, type AdminUserRecord,
  type Database, type JsonObject,
} from '@ici/database';
import type { AuthenticatedPrincipal } from './auth.js';
import type { AuthenticateRequest } from './auth-plugin.js';
import { createAuthenticationGuard } from './auth-plugin.js';

export class AdminHttpError extends Error {
  public constructor(readonly statusCode: 400 | 403 | 404 | 409, readonly code: 'INVALID_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT', message: string) { super(message); this.name = 'AdminHttpError'; }
}

export interface AdminApplicationService {
  institution(input: { readonly principal: AuthenticatedPrincipal }): Promise<AdminInstitutionRecord>;
  updateInstitution(input: { readonly principal: AuthenticatedPrincipal; readonly request: AdminInstitutionUpdate }): Promise<AdminInstitutionRecord>;
  units(input: { readonly principal: AuthenticatedPrincipal }): Promise<readonly AdminUnitRecord[]>;
  createUnit(input: { readonly principal: AuthenticatedPrincipal; readonly request: AdminUnitCreate }): Promise<AdminUnitRecord>;
  updateUnit(input: { readonly principal: AuthenticatedPrincipal; readonly unitId: string; readonly request: AdminUnitUpdate }): Promise<AdminUnitRecord>;
  users(input: { readonly principal: AuthenticatedPrincipal }): Promise<readonly AdminUserRecord[]>;
  capabilities(input: { readonly principal: AuthenticatedPrincipal }): Promise<readonly { readonly code: string; readonly name: string }[]>;
  roles(input: { readonly principal: AuthenticatedPrincipal }): Promise<readonly { readonly id: string; readonly code: string; readonly name: string }[]>;
  assign(input: { readonly principal: AuthenticatedPrincipal; readonly userId: string; readonly request: AdminAssignmentCreate }): Promise<void>;
  revoke(input: { readonly principal: AuthenticatedPrincipal; readonly assignmentId: string }): Promise<void>;
  expedienteTypes(input: { readonly principal: AuthenticatedPrincipal }): Promise<readonly AdminTypeRecord[]>;
  createExpedienteType(input: { readonly principal: AuthenticatedPrincipal; readonly request: AdminExpedienteTypeCreate }): Promise<void>;
  updateExpedienteDraft(input: { readonly principal: AuthenticatedPrincipal; readonly versionId: string; readonly request: AdminExpedienteTypeUpdate }): Promise<void>;
  publishExpedienteDraft(input: { readonly principal: AuthenticatedPrincipal; readonly versionId: string }): Promise<void>;
  classification(input: { readonly principal: AuthenticatedPrincipal }): Promise<readonly { readonly id: string; readonly parent_id: string | null; readonly node_type: 'FONDS' | 'SECTION' | 'SERIES' | 'SUBSERIES'; readonly code: string; readonly name: string; readonly metadata: Record<string, unknown> }[]>;
}

export function createAdminApplicationService(database: Database): AdminApplicationService {
  const context = (principal: AuthenticatedPrincipal) => principal.authorization;
  return {
    institution: ({ principal }) => findAdminInstitution(database, { institutionId: principal.institutionId, authorizationContext: context(principal) }),
    updateInstitution: ({ principal, request }) => updateAdminInstitution(database, { institutionId: principal.institutionId, actorUserId: principal.userId, name: request.name, correlationId: randomUUID(), authorizationContext: context(principal) }),
    units: ({ principal }) => findAdminUnits(database, { institutionId: principal.institutionId, authorizationContext: context(principal) }),
    createUnit: ({ principal, request }) => createAdminUnit(database, { institutionId: principal.institutionId, actorUserId: principal.userId, code: request.code, name: request.name, ...(request.parentId === undefined ? {} : { parentId: request.parentId }), correlationId: randomUUID(), authorizationContext: context(principal) }),
    updateUnit: ({ principal, unitId, request }) => updateAdminUnit(database, { institutionId: principal.institutionId, actorUserId: principal.userId, unitId, ...(request.name === undefined ? {} : { name: request.name }), ...(request.parentId === undefined ? {} : { parentId: request.parentId }), ...(request.status === undefined ? {} : { status: request.status }), correlationId: randomUUID(), authorizationContext: context(principal) }),
    users: ({ principal }) => findAdminUsers(database, { institutionId: principal.institutionId, authorizationContext: context(principal) }),
    capabilities: ({ principal }) => findAdminCapabilities(database, { institutionId: principal.institutionId, authorizationContext: context(principal) }),
    roles: ({ principal }) => findAdminRoles(database, { institutionId: principal.institutionId, authorizationContext: context(principal) }),
    assign: ({ principal, userId, request }) => createAdminAssignment(database, { institutionId: principal.institutionId, actorUserId: principal.userId, userId, roleId: request.roleId, ...(request.unitId === undefined ? {} : { unitId: request.unitId }), correlationId: randomUUID(), authorizationContext: context(principal) }),
    revoke: ({ principal, assignmentId }) => revokeAdminAssignment(database, { institutionId: principal.institutionId, actorUserId: principal.userId, assignmentId, correlationId: randomUUID(), authorizationContext: context(principal) }),
    expedienteTypes: ({ principal }) => findAdminExpedienteTypes(database, { institutionId: principal.institutionId, authorizationContext: context(principal) }),
    createExpedienteType: ({ principal, request }) => createAdminExpedienteType(database, { institutionId: principal.institutionId, actorUserId: principal.userId, code: request.code, name: request.name, schema: request.schema as JsonObject, correlationId: randomUUID(), authorizationContext: context(principal) }),
    updateExpedienteDraft: ({ principal, versionId, request }) => updateAdminExpedienteDraft(database, { institutionId: principal.institutionId, actorUserId: principal.userId, versionId, schema: request.schema as JsonObject, correlationId: randomUUID(), authorizationContext: context(principal) }),
    publishExpedienteDraft: ({ principal, versionId }) => publishAdminExpedienteDraft(database, { institutionId: principal.institutionId, actorUserId: principal.userId, versionId, correlationId: randomUUID(), authorizationContext: context(principal) }),
    classification: ({ principal }) => findAdminClassification(database, { institutionId: principal.institutionId, authorizationContext: context(principal) }),
  };
}

function guardFor(authenticate: AuthenticateRequest) {
  const guard = createAuthenticationGuard(authenticate);
  return (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void => { void guard(request, reply).then(() => { if (!reply.sent) done(); }).catch(done); };
}

function toInstitution(row: AdminInstitutionRecord) { return { institution: row }; }
function toUnit(row: AdminUnitRecord) { return { id: row.id, code: row.code, name: row.name, parentId: row.parent_id, status: row.status }; }
function toUser(row: AdminUserRecord) { return { id: row.id, displayName: row.display_name, status: row.status, assignments: row.assignments.map((assignment: AdminAssignmentRecord) => ({ id: assignment.id, userId: assignment.user_id, roleId: assignment.role_id, roleCode: assignment.role_code, roleName: assignment.role_name, unitId: assignment.unit_id, unitName: assignment.unit_name, capabilities: assignment.capabilities, effectiveFrom: assignment.effective_from.toISOString(), effectiveUntil: assignment.effective_until?.toISOString() ?? null })) }; }
function toType(row: AdminTypeRecord) { return { id: row.id, code: row.code, name: row.name, status: row.status, versions: row.versions.map((version) => ({ id: version.id, versionNumber: version.version_number, status: version.status, schema: version.schema_json, archivalMapping: version.archival_mapping_json, createdAt: version.created_at.toISOString(), publishedAt: version.published_at?.toISOString() ?? null })) }; }

export function installAdminRoutes(app: FastifyInstance, service: AdminApplicationService, authenticate: AuthenticateRequest): void {
  const preHandler = guardFor(authenticate);
  const errors = { 400: MatterErrorSchema, 401: MatterErrorSchema, 403: MatterErrorSchema, 404: MatterErrorSchema, 409: MatterErrorSchema } as const;
  app.get('/admin/institution', { preHandler, schema: { response: { 200: AdminInstitutionResponseSchema, ...errors } } }, async (request) => toInstitution(await service.institution({ principal: request.principal })));
  app.patch<{ Body: AdminInstitutionUpdate }>('/admin/institution', { preHandler, schema: { body: AdminInstitutionUpdateSchema, response: { 200: AdminInstitutionResponseSchema, ...errors } } }, async (request) => toInstitution(await service.updateInstitution({ principal: request.principal, request: request.body })));
  app.get('/admin/units', { preHandler, schema: { response: { 200: AdminUnitsResponseSchema, ...errors } } }, async (request) => ({ items: (await service.units({ principal: request.principal })).map(toUnit) }));
  app.post<{ Body: AdminUnitCreate }>('/admin/units', { preHandler, schema: { body: AdminUnitCreateSchema, response: { 201: AdminUnitsResponseSchema, ...errors } } }, async (request, reply) => reply.code(201).send({ items: [toUnit(await service.createUnit({ principal: request.principal, request: request.body }))] }));
  app.patch<{ Params: { unitId: string }; Body: AdminUnitUpdate }>('/admin/units/:unitId', { preHandler, schema: { params: AdminUnitParamsSchema, body: AdminUnitUpdateSchema, response: { 200: AdminUnitsResponseSchema, ...errors } } }, async (request) => ({ items: [toUnit(await service.updateUnit({ principal: request.principal, unitId: request.params.unitId, request: request.body }))] }));
  app.get('/admin/access/users', { preHandler, schema: { response: { 200: AdminUsersResponseSchema, ...errors } } }, async (request) => ({ items: (await service.users({ principal: request.principal })).map(toUser) }));
  app.get('/admin/access/capabilities', { preHandler, schema: { response: { 200: AdminCapabilitiesResponseSchema, ...errors } } }, async (request) => ({ items: await service.capabilities({ principal: request.principal }) }));
  app.get('/admin/access/roles', { preHandler, schema: { response: { 200: AdminRolesResponseSchema, ...errors } } }, async (request) => ({ items: await service.roles({ principal: request.principal }) }));
  app.post<{ Params: { userId: string }; Body: AdminAssignmentCreate }>('/admin/access/users/:userId/assignments', { preHandler, schema: { params: AdminUserParamsSchema, body: AdminAssignmentCreateSchema, response: { 204: { type: 'null' }, ...errors } } }, async (request, reply) => { await service.assign({ principal: request.principal, userId: request.params.userId, request: request.body }); return reply.code(204).send(); });
  app.delete<{ Params: { assignmentId: string } }>('/admin/access/assignments/:assignmentId', { preHandler, schema: { params: AdminAssignmentParamsSchema, response: { 204: { type: 'null' }, ...errors } } }, async (request, reply) => { await service.revoke({ principal: request.principal, assignmentId: request.params.assignmentId }); return reply.code(204).send(); });
  app.get('/admin/expediente-types', { preHandler, schema: { response: { 200: AdminExpedienteTypesResponseSchema, ...errors } } }, async (request) => ({ items: (await service.expedienteTypes({ principal: request.principal })).map(toType) }));
  app.post<{ Body: AdminExpedienteTypeCreate }>('/admin/expediente-types', { preHandler, schema: { body: AdminExpedienteTypeCreateSchema, response: { 201: { type: 'null' }, ...errors } } }, async (request, reply) => { await service.createExpedienteType({ principal: request.principal, request: request.body }); return reply.code(201).send(null); });
  app.patch<{ Params: { versionId: string }; Body: AdminExpedienteTypeUpdate }>('/admin/expediente-type-versions/:versionId', { preHandler, schema: { params: AdminVersionParamsSchema, body: AdminExpedienteTypeUpdateSchema, response: { 204: { type: 'null' }, ...errors } } }, async (request, reply) => { await service.updateExpedienteDraft({ principal: request.principal, versionId: request.params.versionId, request: request.body }); return reply.code(204).send(); });
  app.post<{ Params: { versionId: string } }>('/admin/expediente-type-versions/:versionId/publish', { preHandler, schema: { params: AdminVersionParamsSchema, response: { 204: { type: 'null' }, ...errors } } }, async (request, reply) => { await service.publishExpedienteDraft({ principal: request.principal, versionId: request.params.versionId }); return reply.code(204).send(); });
  app.get('/admin/classification', { preHandler, schema: { response: { 200: AdminClassificationResponseSchema, ...errors } } }, async (request) => ({ items: (await service.classification({ principal: request.principal })).map((node) => ({ id: node.id, parentId: node.parent_id, nodeType: node.node_type, code: node.code, name: node.name, metadata: node.metadata })), readOnly: true as const, reason: 'No existe una capability mutacional de clasificación archivística en el dominio congelado; esta vista es informativa.' }));
}

export function mapAdminError(error: unknown): AdminHttpError {
  if (error instanceof AdminHttpError) return error;
  const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
  if (code === 'NOT_AUTHORIZED') return new AdminHttpError(403, 'FORBIDDEN', 'No tienes permisos para esta operación administrativa');
  if (code?.endsWith('_NOT_FOUND') || code === 'INSTITUTION_NOT_FOUND' || code === 'VERSION_NOT_FOUND' || code === 'ROLE_NOT_FOUND' || code === 'ASSIGNMENT_NOT_FOUND') return new AdminHttpError(404, 'NOT_FOUND', error instanceof Error ? error.message : 'Recurso administrativo no encontrado');
  if (code === 'VERSION_IMMUTABLE' || code === 'UNIT_HIERARCHY_INVALID' || code === 'UNIT_PARENT_NOT_FOUND') return new AdminHttpError(409, 'CONFLICT', error instanceof Error ? error.message : 'La operación entra en conflicto con el estado actual');
  return new AdminHttpError(400, 'INVALID_REQUEST', error instanceof Error ? error.message : 'La solicitud administrativa no es válida');
}
