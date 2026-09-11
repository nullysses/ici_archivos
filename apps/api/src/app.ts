import cors from '@fastify/cors';
import { HealthResponseSchema, type HealthResponse } from '@ici/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AuthenticatedPrincipal } from './auth.js';
import { installAuthentication, type AuthenticateRequest } from './auth-plugin.js';

export interface AppDependencies {
  readonly authenticateAccessToken: AuthenticateRequest;
  readonly checkDatabase: () => Promise<boolean>;
  readonly version: string;
  readonly webOrigin: string;
}

export async function createApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const authenticateRequest = installAuthentication(app, dependencies.authenticateAccessToken);

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

  app.get<{ Reply: Pick<AuthenticatedPrincipal, 'userId' | 'institutionId' | 'issuer' | 'subject'> }>(
    '/auth/me',
    { preHandler: (request, reply, done) => {
      void authenticateRequest(request, reply).then(() => { if (!reply.sent) done(); }).catch(done);
    } },
    (request) => ({
      userId: request.principal.userId,
      institutionId: request.principal.institutionId,
      issuer: request.principal.issuer,
      subject: request.principal.subject,
    }),
  );

  return app;
}
