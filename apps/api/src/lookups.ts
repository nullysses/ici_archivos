import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MatterErrorSchema, OrganizationalUnitsResponseSchema, AssignmentUsersResponseSchema, AccessClassificationsResponseSchema, type OrganizationalUnitsResponse, type AssignmentUsersResponse, type AccessClassificationsResponse } from '@ici/contracts';
import { findActiveOrganizationalUnits, findActiveUsersForUnit, findAccessClassifications, type Database } from '@ici/database';
import type { AuthenticateRequest } from './auth-plugin.js';
import { createAuthenticationGuard } from './auth-plugin.js';

const UuidParamsSchema = { type: 'object', properties: { unitId: { type: 'string', format: 'uuid' } }, required: ['unitId'], additionalProperties: false } as const;
const LookupQuerySchema = { type: 'object', properties: { purpose: { type: 'string', enum: ['assign', 'register', 'read'] } }, additionalProperties: false } as const;

export class LookupHttpError extends Error {
  public constructor(readonly statusCode: 400 | 403, readonly code: 'INVALID_REQUEST' | 'FORBIDDEN', message: string) { super(message); this.name = 'LookupHttpError'; }
}

export function installLookupRoutes(app: FastifyInstance, database: Database, authenticate: AuthenticateRequest): void {
  const guard = createAuthenticationGuard(authenticate);
  const preHandler = (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void => { void guard(request, reply).then(() => { if (!reply.sent) done(); }).catch(done); };
  const errors = { 400: MatterErrorSchema, 401: MatterErrorSchema, 403: MatterErrorSchema } as const;
  app.get<{ Querystring: { readonly purpose?: 'assign' | 'register' | 'read' }; Reply: OrganizationalUnitsResponse }>('/lookups/organizational-units', { preHandler, schema: { querystring: LookupQuerySchema, response: { 200: OrganizationalUnitsResponseSchema, ...errors } } }, async (request, reply) => {
    try { const rows = await findActiveOrganizationalUnits(database, { institutionId: request.principal.institutionId, authorizationContext: request.principal.authorization, ...(request.query.purpose === undefined ? {} : { purpose: request.query.purpose }) }); return reply.code(200).send({ items: rows.map((row) => ({ id: row.id, code: row.code, name: row.name })) }); }
    catch (error) { throw mapLookupError(error); }
  });
  app.get<{ Params: { unitId: string }; Reply: AssignmentUsersResponse }>('/lookups/organizational-units/:unitId/users', { preHandler, schema: { params: UuidParamsSchema, response: { 200: AssignmentUsersResponseSchema, ...errors } } }, async (request, reply) => {
    try { const rows = await findActiveUsersForUnit(database, { institutionId: request.principal.institutionId, unitId: request.params.unitId, authorizationContext: request.principal.authorization }); return reply.code(200).send({ items: rows.map((row) => ({ id: row.id, displayName: row.display_name })) }); }
    catch (error) { throw mapLookupError(error); }
  });
  app.get<{ Querystring: { readonly purpose?: 'matter' | 'document' }; Reply: AccessClassificationsResponse }>('/lookups/access-classifications', { preHandler, schema: { querystring: { type: 'object', properties: { purpose: { type: 'string', enum: ['matter', 'document'] } }, additionalProperties: false }, response: { 200: AccessClassificationsResponseSchema, ...errors } } }, async (request, reply) => {
    try { const rows = await findAccessClassifications(database, { institutionId: request.principal.institutionId, authorizationContext: request.principal.authorization, ...(request.query.purpose === undefined ? {} : { purpose: request.query.purpose }) }); return reply.code(200).send({ items: rows.map((row) => ({ id: row.id, legalClassification: row.legal_classification, operationalVisibility: row.operational_visibility })) }); }
    catch (error) { throw mapLookupError(error); }
  });
}

function mapLookupError(error: unknown): LookupHttpError {
  const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
  if (code === 'NOT_AUTHORIZED') return new LookupHttpError(403, 'FORBIDDEN', 'Access denied');
  return error instanceof LookupHttpError ? error : new LookupHttpError(400, 'INVALID_REQUEST', 'Lookup request is invalid');
}
