import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MatterReadModel } from '@ici/database';
import { createApp } from './app.js';
import type { AuthenticatedPrincipal } from './auth.js';
import { MatterHttpError, type MatterApplicationService } from './matters.js';

const institutionId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const unitId = '10000000-0000-4000-8000-000000000003';
const classificationId = '10000000-0000-4000-8000-000000000004';
const matterId = '10000000-0000-4000-8000-000000000005';

const matter: MatterReadModel = {
  id: matterId,
  institution_id: institutionId,
  folio: 'OP-2026-000001',
  folio_year: 2026,
  sequence_number: '1',
  status: 'RECEIVED',
  received_at: new Date('2026-09-11T12:00:00.000Z'),
  intake_metadata: { sender: 'Sender', subject: 'Subject', description: 'Description', priority: 'NORMAL', channel: 'EMAIL', operationalVisibility: 'UNIT' },
  linked_expediente_id: null,
  resolution_metadata: null,
  closure_metadata: null,
  created_by: userId,
  destination_unit_id: unitId,
  access_classification_id: classificationId,
  created_at: new Date('2026-09-11T12:00:00.000Z'),
  updated_at: new Date('2026-09-11T12:00:00.000Z'),
};

function principal(authorization: AuthenticatedPrincipal['authorization']): AuthenticatedPrincipal {
  return { userId, institutionId, issuer: 'https://issuer.example.test', subject: 'subject', authorization };
}

function serviceFixture(): MatterApplicationService {
  return {
    register: () => Promise.resolve(matter),
    byId: (_institution, id) => Promise.resolve(id === matterId ? matter : undefined),
    byFolio: (_institution, folio) => Promise.resolve(folio === matter.folio ? matter : undefined),
  };
}

describe('matter registration and read routes', () => {
  let app: FastifyInstance | undefined;
  const defaultAuthorization: AuthenticatedPrincipal['authorization'] = { userId, institutionId, institutionCapabilities: new Set(['matter.register', 'records.read']), unitCapabilities: new Map() };
  let currentPrincipal = principal(defaultAuthorization);

  afterEach(async () => { await app?.close(); currentPrincipal = principal(defaultAuthorization); });

  function createTestApp(service: MatterApplicationService = serviceFixture()): Promise<FastifyInstance> {
    return createApp({
      authenticateAccessToken: () => Promise.resolve(currentPrincipal),
      matterService: service,
      checkDatabase: () => Promise.resolve(true),
      version: 'test',
      webOrigin: 'http://localhost',
    });
  }

  const payload = {
    sender: 'Sender', destinationUnitId: unitId, subject: 'Subject', description: 'Description', priority: 'NORMAL', channel: 'EMAIL',
    receivedAt: '2026-09-11T12:00:00.000Z', accessClassificationId: classificationId, operationalVisibility: 'UNIT',
  } as const;

  it('registers a matter using the authenticated principal and returns 201', async () => {
    app = await createTestApp();
    const response = await app.inject({ method: 'POST', url: '/matters', headers: { authorization: 'Bearer token' }, payload });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: matterId, folio: matter.folio, status: 'RECEIVED', destinationUnitId: unitId, accessClassificationId: classificationId });
  });

  it('rejects unauthenticated and unauthorized registration', async () => {
    app = await createTestApp();
    const unauthenticated = await app.inject({ method: 'POST', url: '/matters', payload });
    expect(unauthenticated.statusCode).toBe(401);
    currentPrincipal = principal({ userId, institutionId, institutionCapabilities: new Set(['records.read']), unitCapabilities: new Map() });
    const forbidden = await app.inject({ method: 'POST', url: '/matters', headers: { authorization: 'Bearer token' }, payload });
    expect(forbidden.statusCode).toBe(403);
  });

  it('rejects caller-controlled identity fields and malformed input', async () => {
    app = await createTestApp();
    const forged = await app.inject({ method: 'POST', url: '/matters', headers: { authorization: 'Bearer token' }, payload: { ...payload, institutionId, actorUserId: userId } });
    expect(forged.statusCode).toBe(201);
    expect(forged.json()).not.toHaveProperty('institutionId');
    expect(forged.json()).not.toHaveProperty('actorUserId');
    const malformed = await app.inject({ method: 'POST', url: '/matters', headers: { authorization: 'Bearer token' }, payload: { ...payload, receivedAt: 'not-a-date' } });
    expect(malformed.statusCode).toBe(400);
  });

  it('applies scoped records.read authorization to ID and folio reads', async () => {
    app = await createTestApp();
    expect((await app.inject({ method: 'GET', url: `/matters/${matterId}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/matters/by-folio/${matter.folio}` })).statusCode).toBe(401);
    currentPrincipal = principal({ userId, institutionId, institutionCapabilities: new Set(), unitCapabilities: new Map([[unitId, new Set(['records.read'])]]) });
    expect((await app.inject({ method: 'GET', url: `/matters/${matterId}`, headers: { authorization: 'Bearer token' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/matters/by-folio/${matter.folio}`, headers: { authorization: 'Bearer token' } })).statusCode).toBe(200);
    currentPrincipal = principal({ userId, institutionId, institutionCapabilities: new Set(), unitCapabilities: new Map([['10000000-0000-4000-8000-000000000099', new Set(['records.read'])]]) });
    expect((await app.inject({ method: 'GET', url: `/matters/${matterId}`, headers: { authorization: 'Bearer token' } })).json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    expect((await app.inject({ method: 'GET', url: '/matters/10000000-0000-4000-8000-000000000099', headers: { authorization: 'Bearer token' } })).json()).toEqual({ error: { code: 'MATTER_NOT_FOUND', message: 'Matter not found' } });
    expect((await app.inject({ method: 'GET', url: '/matters/by-folio/OP-2026-000099', headers: { authorization: 'Bearer token' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/matters/not-a-uuid', headers: { authorization: 'Bearer token' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/matters/by-folio/EXP-2026-000001', headers: { authorization: 'Bearer token' } })).statusCode).toBe(400);
  });

  it('maps invalid referenced records to a stable request error', async () => {
    const service: MatterApplicationService = { ...serviceFixture(), register: () => Promise.reject(new MatterHttpError(400, 'INVALID_REQUEST', 'Referenced intake record is invalid')) };
    app = await createTestApp(service);
    const response = await app.inject({ method: 'POST', url: '/matters', headers: { authorization: 'Bearer token' }, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'INVALID_REQUEST', message: 'Referenced intake record is invalid' } });
  });

  it('rejects restricted-group registration and fails closed for restricted reads', async () => {
    app = await createTestApp({
      ...serviceFixture(),
      byId: () => Promise.resolve({ ...matter, intake_metadata: { ...matter.intake_metadata, operationalVisibility: 'RESTRICTED_GROUP' } }),
    });
    const registration = await app.inject({ method: 'POST', url: '/matters', headers: { authorization: 'Bearer token' }, payload: { ...payload, operationalVisibility: 'RESTRICTED_GROUP' } });
    expect(registration.statusCode).toBe(400);
    const read = await app.inject({ method: 'GET', url: `/matters/${matterId}`, headers: { authorization: 'Bearer token' } });
    expect(read.statusCode).toBe(403);
    expect(read.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
  });

  it('fails closed when legacy matter metadata has no operational visibility', async () => {
    app = await createTestApp({
      ...serviceFixture(),
      byId: () => Promise.resolve({ ...matter, intake_metadata: { sender: 'legacy', subject: 'legacy', description: 'legacy', priority: 'NORMAL', channel: 'EMAIL' } }),
    });
    const read = await app.inject({ method: 'GET', url: `/matters/${matterId}`, headers: { authorization: 'Bearer token' } });
    expect(read.statusCode).toBe(403);
  });
});
