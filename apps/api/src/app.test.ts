import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';

describe('GET /health', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('reports an available database', async () => {
    app = await createApp({
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
});
