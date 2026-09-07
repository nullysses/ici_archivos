import cors from '@fastify/cors';
import { HealthResponseSchema, type HealthResponse } from '@ici/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

export interface AppDependencies {
  readonly checkDatabase: () => Promise<boolean>;
  readonly version: string;
  readonly webOrigin: string;
}

export async function createApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  await app.register(cors, { origin: dependencies.webOrigin });

  app.get<{ Reply: HealthResponse }>(
    '/health',
    {
      schema: {
        response: {
          200: HealthResponseSchema,
          503: HealthResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const databaseIsUp = await dependencies.checkDatabase();
      const response: HealthResponse = {
        dependencies: { database: databaseIsUp ? 'up' : 'down' },
        service: 'ici-api',
        status: databaseIsUp ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        version: dependencies.version,
      };

      return reply.code(databaseIsUp ? 200 : 503).send(response);
    },
  );

  return app;
}

