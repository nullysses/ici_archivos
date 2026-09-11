import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { UnauthenticatedError, type AuthenticatedPrincipal } from './auth.js';

const principal: AuthenticatedPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001',
  institutionId: '00000000-0000-4000-8000-000000000002',
  issuer: 'https://issuer.example.test',
  subject: 'subject-1',
  authorization: { userId: '00000000-0000-4000-8000-000000000001', institutionId: '00000000-0000-4000-8000-000000000002', institutionCapabilities: new Set(), unitCapabilities: new Map() },
};

const authenticate = (token: string): Promise<AuthenticatedPrincipal> => token === 'valid-token' ? Promise.resolve(principal) : Promise.reject(new UnauthenticatedError());

describe('GET /health', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('reports an available database', async () => {
    app = await createApp({
      authenticateAccessToken: authenticate,
      checkDatabase: () => Promise.resolve(true),
      version: 'test',
      webOrigin: 'http://localhost',
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dependencies: { database: 'up' },
      service: 'ici-api',
      status: 'ok',
      version: 'test',
    });
  });

  it('reports a degraded service when PostgreSQL is unavailable', async () => {
    app = await createApp({
      authenticateAccessToken: authenticate,
      checkDatabase: () => Promise.resolve(false),
      version: 'test',
      webOrigin: 'http://localhost',
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      dependencies: { database: 'down' },
      status: 'degraded',
    });
  });

  it('keeps health public and protects auth/me with a stable 401', async () => {
    app = await createApp({ authenticateAccessToken: authenticate, checkDatabase: () => Promise.resolve(true), version: 'test', webOrigin: 'http://localhost' });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
    const basic = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: 'Basic valid-token' } });
    expect(basic.statusCode).toBe(401);
    const blank = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: 'Bearer   ' } });
    expect(blank.statusCode).toBe(401);
    const malformed = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: 'Bearer one two' } });
    expect(malformed.statusCode).toBe(401);
    const invalid = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: 'Bearer invalid-token' } });
    expect(invalid.statusCode).toBe(401);
  });

  it('injects the typed principal into the protected handler', async () => {
    app = await createApp({ authenticateAccessToken: authenticate, checkDatabase: () => Promise.resolve(true), version: 'test', webOrigin: 'http://localhost' });
    const response = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: 'Bearer valid-token' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: principal.userId, institutionId: principal.institutionId, issuer: principal.issuer, subject: principal.subject });
  });
});
