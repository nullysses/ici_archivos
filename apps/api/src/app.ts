import cors from '@fastify/cors';
import { HealthResponseSchema, type HealthResponse } from '@ici/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AuthenticatedPrincipal } from './auth.js';
import { installAuthentication, type AuthenticateRequest } from './auth-plugin.js';
import { installMatterRoutes, type MatterApplicationService, MatterHttpError } from './matters.js';
import { installDocumentRoutes, type DocumentApplicationDependencies, DocumentHttpError } from './documents.js';

export interface AppDependencies {
  readonly authenticateAccessToken: AuthenticateRequest;
  readonly matterService?: MatterApplicationService;
  readonly checkDatabase: () => Promise<boolean>;
  readonly version: string;
  readonly webOrigin: string;
  readonly documentDependencies?: Omit<DocumentApplicationDependencies, 'authenticate'>;
}

export async function createApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const authenticateRequest = installAuthentication(app, dependencies.authenticateAccessToken);

  await app.register(cors, { origin: dependencies.webOrigin });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MatterHttpError || error instanceof DocumentHttpError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if ((error as { readonly code?: unknown }).code === 'FST_ERR_VALIDATION') return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Request validation failed' } });
    request.log.error(error);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

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

  if (dependencies.matterService !== undefined) installMatterRoutes(app, dependencies.matterService, dependencies.authenticateAccessToken);
  if (dependencies.documentDependencies !== undefined) await installDocumentRoutes(app, { ...dependencies.documentDependencies, authenticate: dependencies.authenticateAccessToken });

  return app;
}
